import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { effectiveSchedule, personalScheduleSchema, emptyPersonalSchedule, type Schedule } from '@/domain/schedule';
import { classKey, couldBeClass } from '@/domain/class-match';
import { DirectoryService, type DirectoryClass } from './directory';
import type { Service } from './service';

/**
 * Schedule scanning sends one to three photos of a printed timetable (for example
 * both halves of a wide timetable, or the front and back) to an OpenAI-compatible
 * vision model (OpenAI, DeepSeek, OpenRouter, Ollama, ...) in a single request, and
 * returns one merged list of rows the student confirms before anything is saved.
 * The provider is chosen by env only. The quota counts scans, not photos.
 */
export const SCAN_REASONING = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const;
export type ScanReasoning = typeof SCAN_REASONING[number];
/**
 * temperature is only sent when SCAN_MODEL_TEMPERATURE is set: reasoning models (OpenAI's o-series and GPT-5
 * family) reject any non-default temperature with HTTP 400 while they reason, which would fail every scan after
 * its quota unit is spent. Models that accept it (DeepSeek, Ollama) can pin 0 for steadier answers.
 */
export type ScanConfig = { url: string; key: string; model: string; reasoning?: ScanReasoning; temperature?: number };
export function scanConfig(env: Record<string, string | undefined> = process.env): ScanConfig | null {
  // Accept either the API base (…/v1) or the full completions URL people paste from provider docs.
  const url = env.SCAN_API_URL?.trim().replace(/\/+$/, '').replace(/\/chat\/completions$/, '');
  const model = env.SCAN_MODEL?.trim();
  if (!url || !model) return null;
  const reasoning = env.SCAN_MODEL_REASONING?.trim().toLowerCase();
  if (reasoning && !SCAN_REASONING.includes(reasoning as ScanReasoning)) throw new Error(`SCAN_MODEL_REASONING must be one of ${SCAN_REASONING.join(', ')}.`);
  const rawTemperature = env.SCAN_MODEL_TEMPERATURE?.trim();
  const temperature = rawTemperature ? Number(rawTemperature) : undefined;
  if (temperature !== undefined && !(Number.isFinite(temperature) && temperature >= 0 && temperature <= 2)) throw new Error('SCAN_MODEL_TEMPERATURE must be a number from 0 to 2.');
  return { url, key: env.SCAN_API_KEY?.trim() ?? '', model, ...(reasoning ? { reasoning: reasoning as ScanReasoning } : {}), ...(temperature !== undefined ? { temperature } : {}) };
}

export const SCAN_MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
/** Per photo. Three photos stay under the tRPC route's 5,000,000 byte body limit. */
export const MAX_SCAN_BASE64 = 1_500_000;
export const MAX_SCAN_IMAGES = 3;
export const SCAN_HOURLY_LIMIT = 10;
export const SCAN_DAILY_LIMIT = 30;
export const scanImageSchema = z.object({
  mediaType: z.enum(SCAN_MEDIA_TYPES),
  image: z.string().regex(/^[A-Za-z0-9+/]+=*$/, 'Send the photo as base64.').max(MAX_SCAN_BASE64, 'The photo is too large. Retake it or choose a smaller image.'),
});
export type ScanImage = z.infer<typeof scanImageSchema>;
const scanImagesSchema = z.object({
  images: z.array(scanImageSchema).min(1, 'Add a photo of your timetable.').max(MAX_SCAN_IMAGES, 'You can add up to three photos.'),
});
/**
 * Accepts { images: [...] } and the legacy single-photo shape { mediaType, image },
 * so a browser still running an older bundle can scan. A preprocess (not a union)
 * keeps the specific photo messages as the first issue the client sees.
 */
export const scanInputSchema = z.preprocess(
  (value: z.input<typeof scanImagesSchema> | z.input<typeof scanImageSchema>) => {
    if (!value || typeof value !== 'object' || 'images' in value || !('image' in value)) return value;
    return { images: [{ mediaType: value.mediaType, image: value.image }] };
  },
  scanImagesSchema,
);
export type ScanInput = z.input<typeof scanInputSchema>;
export type ScanRequest = z.output<typeof scanInputSchema>;

const text = (max: number) => z.string().trim().max(max).nullish().transform(value => value?.replace(/\s+/g, ' ') || undefined);
const rowSchema = z.object({
  className: text(120),
  teacher: text(120),
  room: text(120),
  periodId: text(100),
  periodIds: z.array(z.string().trim().max(100)).max(50).nullish(),
  periodLabel: text(120),
  directoryId: text(100),
  days: z.array(z.string().trim().max(60)).max(20).nullish(),
});
/** The model is asked for exactly this shape; anything unparseable is dropped rather than failing the scan. */
const responseSchema = z.object({ rows: z.array(z.unknown()).max(100) });

export type ScanRow = {
  name: string; teacher?: string; room?: string;
  /** Every school period the model matched, verified to exist. */
  periodIds: string[];
  /** What the photo said about the period when no verified match exists. */
  periodLabel?: string;
  /** A directory class the model matched, verified to exist for this school. */
  directoryId?: string;
  days: string[];
};
export type ScanResult = { rows: ScanRow[]; model: string; notes: string[] };

export type ScanFetch = (input: string, init: RequestInit) => Promise<Response>;

export class ScanService {
  constructor(private readonly service: Service, private readonly config: ScanConfig | null = scanConfig(), private readonly fetcher: ScanFetch = fetch) {}
  enabled(): boolean { return this.config !== null; }

  async scan(accountId: string, raw: ScanInput): Promise<ScanResult> {
    if (!this.config) throw new TRPCError({ code: 'PRECONDITION_FAILED', message: 'Schedule scanning is not set up on this server.' });
    const input = scanInputSchema.parse(raw);
    const user = this.service.ready(accountId);
    if (!user.schoolId) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Join a school first so scanned classes have periods to land on.' });
    const school = this.service.school(user.schoolId);
    const existing = this.service.entity(accountId, 'personal');
    const personal = personalScheduleSchema.parse(existing && !existing.deleted ? existing.data : emptyPersonalSchedule());
    const schedule = effectiveSchedule(school.schedule, personal);
    const directory = new DirectoryService(this.service).list(accountId, school.id).classes.filter(entry => !personal.grade || entry.grades.includes(personal.grade));

    this.reserve(accountId, school.id, input.images.length);
    const body = await this.request(input, schedule, directory);
    return this.interpret(body, schedule, directory, input.images.length);
  }

  /** Per-account quota, one unit per scan whatever its photo count, recorded before the paid request so a slow model cannot be spammed. */
  private reserve(accountId: string, schoolId: string, images: number) {
    this.service.db.transaction(() => {
      const count = (since: number) => (this.service.db.prepare("SELECT count(*) n FROM audit_log WHERE actor_id=? AND action='schedule.scan' AND created_at > ?").get(accountId, new Date(Date.now() - since).toISOString()) as { n: number }).n;
      if (count(3_600_000) >= SCAN_HOURLY_LIMIT) throw new TRPCError({ code: 'TOO_MANY_REQUESTS', message: `You can scan up to ${SCAN_HOURLY_LIMIT} timetables per hour. Try again later.` });
      if (count(86_400_000) >= SCAN_DAILY_LIMIT) throw new TRPCError({ code: 'TOO_MANY_REQUESTS', message: `You can scan up to ${SCAN_DAILY_LIMIT} timetables per day. Try again tomorrow.` });
      this.service.db.prepare('INSERT INTO audit_log(actor_id,action,school_id,detail,created_at) VALUES(?,?,?,?,?)').run(accountId, 'schedule.scan', schoolId, JSON.stringify({ model: this.config!.model, images }), new Date().toISOString());
    }).immediate();
  }

  private async request(input: ScanRequest, schedule: Schedule, directory: DirectoryClass[]): Promise<string> {
    const config = this.config!;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 90_000);
    try {
      const response = await this.fetcher(`${config.url}/chat/completions`, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'content-type': 'application/json', ...(config.key ? { authorization: `Bearer ${config.key}` } : {}) },
        body: JSON.stringify({
          model: config.model,
          ...(config.temperature !== undefined ? { temperature: config.temperature } : {}),
          response_format: { type: 'json_object' },
          ...(config.reasoning ? { reasoning_effort: config.reasoning } : {}),
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: [
              { type: 'text', text: userPrompt(schedule, directory, input.images.length) },
              // One part per photo, in the order the student added them.
              ...input.images.map(photo => ({ type: 'image_url', image_url: { url: `data:${photo.mediaType};base64,${photo.image}`, detail: 'high' } })),
            ] },
          ],
        }),
      });
      if (!response.ok) {
        const detail = (await response.text().catch(() => '')).slice(0, 300);
        if (response.status === 429) throw new TRPCError({ code: 'TOO_MANY_REQUESTS', message: 'The scanning service is busy. Try again in a minute.' });
        console.error(`[scan] upstream returned HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
        throw new TRPCError({ code: 'BAD_GATEWAY', message: 'The scanning service is having trouble right now. Try again in a few minutes, or add your classes by hand.' });
      }
      const payload = await response.json().catch(() => null) as { choices?: Array<{ message?: { content?: string | Array<{ type?: string; text?: string }> } }> } | null;
      // A 200 that is not a chat completion (a proxy's HTML page, an error object) is the service's fault, not the photo's.
      if (!Array.isArray(payload?.choices) || payload.choices.length === 0) {
        // A body cut off by the timer reads as null too; the catch below reports that as a timeout, not an upstream fault.
        if (!controller.signal.aborted) console.error('[scan] upstream returned an unreadable body');
        throw new TRPCError({ code: 'BAD_GATEWAY', message: 'The scanning service is having trouble right now. Try again in a few minutes, or add your classes by hand.' });
      }
      const content = payload.choices[0]?.message?.content;
      const body = typeof content === 'string' ? content : Array.isArray(content) ? content.map(part => part.text ?? '').join('') : '';
      if (!body.trim()) throw new TRPCError({ code: 'BAD_GATEWAY', message: 'The scanning service returned an empty answer. Try a clearer photo.' });
      return body;
    } catch (error) {
      // Checked first: the timer also covers reading the body, and a body cut off by it would otherwise surface as an unreadable answer.
      if (controller.signal.aborted) throw new TRPCError({ code: 'TIMEOUT', message: 'The scan took too long. Try again with a smaller or clearer photo.' });
      if (error instanceof TRPCError) throw error;
      throw new TRPCError({ code: 'BAD_GATEWAY', message: 'Could not reach the scanning service.' });
    } finally { clearTimeout(timeout); }
  }

  /** Validates the model's answer against the real schedule so nothing unverified reaches the client. */
  interpret(body: string, schedule: Schedule, directory: DirectoryClass[], images = 1): ScanResult {
    const parsed = responseSchema.safeParse(parseJson(body));
    if (!parsed.success) throw new TRPCError({ code: 'BAD_GATEWAY', message: 'The scanning service answered in an unexpected format. Try again.' });
    const periods = new Map(schedule.periods.map(period => [period.id, period]));
    // A label with no letters or digits ("★") gets no entry, so a punctuation-only answer ("—") never resolves to it.
    const byLabel = new Map(schedule.periods.filter(period => normalize(period.label)).map(period => [normalize(period.label), period.id]));
    const entries = new Map(directory.map(entry => [entry.id, entry]));
    const notes: string[] = [];
    const rows: ScanRow[] = [];
    for (const candidate of parsed.data.rows) {
      const row = rowSchema.safeParse(candidate);
      if (!row.success) { notes.push('Skipped a line the scanner could not read.'); continue; }
      const listed = row.data.directoryId ? entries.get(row.data.directoryId) : undefined;
      // The directory link (and the teacher and room it fills in) only stands when the printed name could be that class:
      // the same words in any order, or an abbreviation of every word at the same level ("AP Chem" for "AP Chemistry", never "Art" for "Art History").
      const match = listed && (!row.data.className || couldBeClass(row.data.className, listed.name)) ? listed : undefined;
      const name = row.data.className ?? match?.name;
      if (!name) continue;
      // A class may meet in several periods across the rotation; rows are keyed by directory class, else by class name (see classKey).
      const resolve = (value: string | undefined) => value ? (periods.has(value) ? value : byLabel.get(normalize(value))) : undefined;
      const matched = [...new Set([...(row.data.periodIds ?? []), row.data.periodId, row.data.periodLabel].map(resolve).filter((id): id is string => !!id))];
      const next: ScanRow = {
        // A shortened printed name stays as printed, like the timetable the student is checking it against.
        name: match && classKey(match.name) === classKey(name) ? match.name : name,
        teacher: row.data.teacher ?? match?.teacher,
        room: row.data.room ?? match?.room,
        periodIds: matched,
        periodLabel: matched.length ? undefined : row.data.periodLabel ?? row.data.periodId ?? row.data.periodIds?.find(Boolean),
        directoryId: match?.id,
        days: (row.data.days ?? []).filter(Boolean),
      };
      const key = classKey(name);
      const existing = rows.find(entry => (next.directoryId && entry.directoryId === next.directoryId) || classKey(entry.name) === key);
      if (!existing) { rows.push(next); continue; }
      // The same class seen again (another photo): the first sighting wins, and the later one fills in what it lacked.
      existing.periodIds = [...new Set([...existing.periodIds, ...next.periodIds])];
      existing.periodLabel = existing.periodIds.length ? undefined : existing.periodLabel ?? next.periodLabel;
      if (!existing.directoryId && next.directoryId) { existing.directoryId = next.directoryId; existing.name = next.name; }
      existing.teacher ??= next.teacher;
      existing.room ??= next.room;
      existing.days = [...new Set([...existing.days, ...next.days])];
    }
    if (rows.length === 0) notes.push(images > 1
      ? 'No classes were found in the photos. Try straight-on, well-lit shots that together show the whole timetable.'
      : 'No classes were found in the photo. Try a straight-on, well-lit shot of the whole timetable.');
    return { rows, model: this.config?.model ?? '', notes };
  }
}

/**
 * A period label's lookup key, case- and punctuation-blind in any script: "Period 1" and "period-1" match, and so do
 * "数学" and "数学". Combining marks are kept, so Devanagari or Thai labels that differ only in a vowel sign stay apart.
 */
const normalize = (value: string) => value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}\p{M}]+/gu, ' ').trim();
function parseJson(body: string): unknown {
  const trimmed = body.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(trimmed); } catch { /* fall through to the widest object */ }
  const start = trimmed.indexOf('{'), end = trimmed.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(trimmed.slice(start, end + 1)); } catch { return null; }
}

const SYSTEM_PROMPT = `You read photos of a student's printed or on-screen class timetable and return JSON only.
Return an object {"rows": [...]}. Each row is one class the student takes:
{"className": string, "teacher": string|null, "room": string|null, "periodIds": string[], "periodLabel": string|null, "directoryId": string|null, "days": string[]}
Rules:
- One row per distinct class. If the same class appears on several days, return it once and list the days in "days".
- "periodIds" lists every school period ID the class meets in, matched by the period name or by its start time. A class that sits in different periods on different days lists all of them. Use an empty list only when no period can be matched, and then put the printed period text in "periodLabel".
- "directoryId" must be the ID of a listed directory class only when the name (and teacher or room, if printed) clearly match. A shortened or reordered name of the same class and level counts when every word is still there ("AP Chem" for "AP Chemistry"); a missing or extra word ("Art" for "Art History") or a different level, number or honors marker does not. Otherwise null.
- Copy names exactly as printed. Do not invent teachers or rooms that are not visible.
- Skip lunch, homeroom, advisory, free periods and headings unless they are clearly a class the student attends.
- Several photos may be parts of one timetable (both halves, or front and back). Merge them into one list; a class seen in more than one photo is still one row.
- If no photo is a timetable, return {"rows": []}.`;

function userPrompt(schedule: Schedule, directory: DirectoryClass[], images: number): string {
  const times = new Map<string, Set<string>>();
  for (const day of schedule.cycleDays) for (const slot of day.slots) {
    if (!times.has(slot.periodId)) times.set(slot.periodId, new Set());
    times.get(slot.periodId)!.add(`${slot.start}-${slot.end}`);
  }
  const periods = schedule.periods.map(period => `- id "${period.id}": ${period.label} (${period.kind})${times.has(period.id) ? ` at ${[...times.get(period.id)!].join(', ')}` : ''}`).join('\n');
  const classes = directory.length > 0
    ? directory.map(entry => `- id "${entry.id}": ${entry.name}${entry.teacher ? `, teacher ${entry.teacher}` : ''}${entry.room ? `, room ${entry.room}` : ''}`).join('\n')
    : '(none listed)';
  const days = schedule.cycleDays.map(day => day.label).join(', ');
  return `School periods (use these IDs for "periodIds"):\n${periods}\n\nRotation days: ${days || 'single schedule'}\n\nSchool class directory (use these IDs for "directoryId"):\n${classes}\n\n${images > 1
    ? `Read the ${images} attached photos. They may be parts of one timetable, for example both halves of a wide timetable or its front and back, so merge them into one list of classes: list each class once with every period and day it has across all photos. Return the JSON.`
    : 'Read the attached timetable photo and return the JSON.'}`;
}
