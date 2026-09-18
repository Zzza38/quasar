import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { effectiveSchedule, personalScheduleSchema, emptyPersonalSchedule, type Schedule } from '@/domain/schedule';
import { DirectoryService, type DirectoryClass } from './directory';
import type { Service } from './service';

/**
 * Schedule scanning sends a photo of a printed timetable to an OpenAI-compatible
 * vision model (OpenAI, DeepSeek, OpenRouter, Ollama, ...) and returns rows the
 * student confirms before anything is saved. The provider is chosen by env only.
 */
export type ScanConfig = { url: string; key: string; model: string };
export function scanConfig(env: Record<string, string | undefined> = process.env): ScanConfig | null {
  const url = env.SCAN_API_URL?.trim().replace(/\/+$/, '');
  const model = env.SCAN_MODEL?.trim();
  if (!url || !model) return null;
  return { url, key: env.SCAN_API_KEY?.trim() ?? '', model };
}

export const SCAN_MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export const MAX_SCAN_BASE64 = 1_500_000;
export const SCAN_HOURLY_LIMIT = 10;
export const SCAN_DAILY_LIMIT = 30;
export const scanInputSchema = z.object({
  mediaType: z.enum(SCAN_MEDIA_TYPES),
  image: z.string().regex(/^[A-Za-z0-9+/]+=*$/, 'Send the photo as base64.').max(MAX_SCAN_BASE64, 'The photo is too large. Retake it or choose a smaller image.'),
});
export type ScanInput = z.infer<typeof scanInputSchema>;

const text = (max: number) => z.string().trim().max(max).nullish().transform(value => value?.replace(/\s+/g, ' ') || undefined);
const rowSchema = z.object({
  className: text(120),
  teacher: text(120),
  room: text(120),
  periodId: text(100),
  periodLabel: text(120),
  directoryId: text(100),
  days: z.array(z.string().trim().max(60)).max(20).nullish(),
});
/** The model is asked for exactly this shape; anything unparseable is dropped rather than failing the scan. */
const responseSchema = z.object({ rows: z.array(z.unknown()).max(100) });

export type ScanRow = {
  name: string; teacher?: string; room?: string;
  /** A school period the model matched, verified to exist. */
  periodId?: string;
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

    this.reserve(accountId, school.id);
    const body = await this.request(input, schedule, directory);
    return this.interpret(body, schedule, directory);
  }

  /** Per-account quota, recorded before the paid request so a slow model cannot be spammed. */
  private reserve(accountId: string, schoolId: string) {
    this.service.db.transaction(() => {
      const count = (since: number) => (this.service.db.prepare("SELECT count(*) n FROM audit_log WHERE actor_id=? AND action='schedule.scan' AND created_at > ?").get(accountId, new Date(Date.now() - since).toISOString()) as { n: number }).n;
      if (count(3_600_000) >= SCAN_HOURLY_LIMIT) throw new TRPCError({ code: 'TOO_MANY_REQUESTS', message: `You can scan up to ${SCAN_HOURLY_LIMIT} photos per hour. Try again later.` });
      if (count(86_400_000) >= SCAN_DAILY_LIMIT) throw new TRPCError({ code: 'TOO_MANY_REQUESTS', message: `You can scan up to ${SCAN_DAILY_LIMIT} photos per day. Try again tomorrow.` });
      this.service.db.prepare('INSERT INTO audit_log(actor_id,action,school_id,detail,created_at) VALUES(?,?,?,?,?)').run(accountId, 'schedule.scan', schoolId, JSON.stringify({ model: this.config!.model }), new Date().toISOString());
    })();
  }

  private async request(input: ScanInput, schedule: Schedule, directory: DirectoryClass[]): Promise<string> {
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
          temperature: 0,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: [
              { type: 'text', text: userPrompt(schedule, directory) },
              { type: 'image_url', image_url: { url: `data:${input.mediaType};base64,${input.image}`, detail: 'high' } },
            ] },
          ],
        }),
      });
      if (!response.ok) {
        const detail = (await response.text().catch(() => '')).slice(0, 300);
        if (response.status === 429) throw new TRPCError({ code: 'TOO_MANY_REQUESTS', message: 'The scanning service is busy. Try again in a minute.' });
        throw new TRPCError({ code: 'BAD_GATEWAY', message: `The scanning service returned HTTP ${response.status}.${detail ? ` ${detail}` : ''}` });
      }
      const payload = await response.json().catch(() => null) as { choices?: Array<{ message?: { content?: string | Array<{ type?: string; text?: string }> } }> } | null;
      const content = payload?.choices?.[0]?.message?.content;
      const body = typeof content === 'string' ? content : Array.isArray(content) ? content.map(part => part.text ?? '').join('') : '';
      if (!body.trim()) throw new TRPCError({ code: 'BAD_GATEWAY', message: 'The scanning service returned an empty answer. Try a clearer photo.' });
      return body;
    } catch (error) {
      if (error instanceof TRPCError) throw error;
      if (controller.signal.aborted) throw new TRPCError({ code: 'TIMEOUT', message: 'The scan took too long. Try again with a smaller or clearer photo.' });
      throw new TRPCError({ code: 'BAD_GATEWAY', message: 'Could not reach the scanning service.' });
    } finally { clearTimeout(timeout); }
  }

  /** Validates the model's answer against the real schedule so nothing unverified reaches the client. */
  interpret(body: string, schedule: Schedule, directory: DirectoryClass[]): ScanResult {
    const parsed = responseSchema.safeParse(parseJson(body));
    if (!parsed.success) throw new TRPCError({ code: 'BAD_GATEWAY', message: 'The scanning service answered in an unexpected format. Try again.' });
    const periods = new Map(schedule.periods.map(period => [period.id, period]));
    const byLabel = new Map(schedule.periods.map(period => [normalize(period.label), period.id]));
    const entries = new Map(directory.map(entry => [entry.id, entry]));
    const notes: string[] = [];
    const rows: ScanRow[] = [];
    const seen = new Set<string>();
    for (const candidate of parsed.data.rows) {
      const row = rowSchema.safeParse(candidate);
      if (!row.success) { notes.push('Skipped a line the scanner could not read.'); continue; }
      const match = row.data.directoryId ? entries.get(row.data.directoryId) : undefined;
      const name = row.data.className ?? match?.name;
      if (!name) continue;
      let periodId = row.data.periodId && periods.has(row.data.periodId) ? row.data.periodId : undefined;
      if (!periodId && row.data.periodLabel) periodId = byLabel.get(normalize(row.data.periodLabel));
      if (!periodId && row.data.periodId) periodId = byLabel.get(normalize(row.data.periodId));
      const key = `${normalize(name)}|${periodId ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({
        name: match && normalize(match.name) === normalize(name) ? match.name : name,
        teacher: row.data.teacher ?? match?.teacher,
        room: row.data.room ?? match?.room,
        periodId,
        periodLabel: periodId ? undefined : row.data.periodLabel ?? row.data.periodId,
        directoryId: match?.id,
        days: (row.data.days ?? []).filter(Boolean),
      });
    }
    if (rows.length === 0) notes.push('No classes were found in the photo. Try a straight-on, well-lit shot of the whole timetable.');
    return { rows, model: this.config?.model ?? '', notes };
  }
}

const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
function parseJson(body: string): unknown {
  const trimmed = body.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try { return JSON.parse(trimmed); } catch { /* fall through to the widest object */ }
  const start = trimmed.indexOf('{'), end = trimmed.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(trimmed.slice(start, end + 1)); } catch { return null; }
}

const SYSTEM_PROMPT = `You read photos of a student's printed or on-screen class timetable and return JSON only.
Return an object {"rows": [...]}. Each row is one class the student takes:
{"className": string, "teacher": string|null, "room": string|null, "periodId": string|null, "periodLabel": string|null, "directoryId": string|null, "days": string[]}
Rules:
- One row per distinct class. If the same class appears on several days, return it once and list the days in "days".
- "periodId" must be one of the school period IDs you are given, matched by the period name or by its start time. Use null if unsure and put the printed period text in "periodLabel".
- "directoryId" must be the ID of a listed directory class only when the name (and teacher or room, if printed) clearly match. Otherwise null.
- Copy names exactly as printed. Do not invent teachers or rooms that are not visible.
- Skip lunch, homeroom, advisory, free periods and headings unless they are clearly a class the student attends.
- If the image is not a timetable, return {"rows": []}.`;

function userPrompt(schedule: Schedule, directory: DirectoryClass[]): string {
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
  return `School periods (use these IDs for "periodId"):\n${periods}\n\nRotation days: ${days || 'single schedule'}\n\nSchool class directory (use these IDs for "directoryId"):\n${classes}\n\nRead the attached timetable photo and return the JSON.`;
}
