import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { assessmentCandidates, keywordKind } from '@/components/focus-lists';
import { isOverdue, sortByDue, type TaskItem } from '@/components/app-state';
import { emptyPersonalSchedule, personalScheduleSchema, type PersonalSchedule } from '@/domain/schedule';
import { repairTaskDates, taskSchema } from '@/domain/task';
import { addDays, instantParts, weekdayOf } from '@/lib/format';
import { AiService } from './ai';
import type { Service } from './service';

/**
 * The weekly parent summary (README "Weekly parent summary"), a Quasar AI Plus feature in the ai-tasks beta.
 *
 * The student turns it on in Account → AI and gets a private link, /summary/<token>, that a parent opens without an
 * account. Only the student's own signed-in session can turn it on, choose what it shows, make a new link or turn it
 * off; there is no owner or support path to it. The page shows only the sections the student ticked, the student's
 * first name, and never task notes.
 *
 * The token is 32 random bytes. Only its SHA-256 is stored, so the database alone can't rebuild a working link, and
 * the stored hash is compared with timingSafeEqual. A new link replaces the hash (the old link dies at once); turning
 * it off deletes the row and its view log. While the student's Plus has lapsed (billing on and not Plus) the page
 * says the summary is paused and shows nothing else. Outside the beta, or for a suspended account, the link reads
 * like any unknown link.
 *
 * Every page view is logged (time only, no address) so the student sees "Last viewed …". Views are rate-limited per
 * visitor address in memory and per link in the database.
 */

export const SUMMARY_SECTIONS = ['dueThisWeek', 'overdue', 'assessments', 'completed'] as const;
export type SummarySection = (typeof SUMMARY_SECTIONS)[number];
export type SummarySections = Record<SummarySection, boolean>;
/** Only the first section is on until the student picks more. */
export const DEFAULT_SECTIONS: SummarySections = { dueThisWeek: true, overdue: false, assessments: false, completed: false };
export const summarySectionsSchema = z.object({ dueThisWeek: z.boolean(), overdue: z.boolean(), assessments: z.boolean(), completed: z.boolean() }).strict();
export const setSummarySectionsSchema = z.object({ sections: summarySectionsSchema });

/** 32 bytes in base64url. Anything else in the path is turned away before the database is asked. */
export const SUMMARY_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const TOKEN_BYTES = 32;
/** Per visitor address (CF-Connecting-IP): page loads in VISITOR_WINDOW_MS, valid link or not. */
export const VISITOR_LIMIT = 30;
const VISITOR_WINDOW_MS = 10 * 60_000;
/** Per link: logged views in the last hour. */
export const LINK_HOURLY_LIMIT = 60;
const VIEW_KEEP_DAYS = 90;
/** Long lists are cut here; the parent sees how many more there are. */
export const LIST_MAX = 40;

export type SummaryTask = { title: string; className: string | null; dueDate: string; dueTime: string | null };
export type ParentSummary = {
  firstName: string;
  timeZone: string;
  today: string;
  weekStart: string;
  weekEnd: string;
  generatedAt: string;
  dueThisWeek?: { tasks: Array<SummaryTask & { done: boolean; overdue: boolean }>; more: number };
  overdue?: { count: number };
  assessments?: { tasks: Array<SummaryTask & { kind: 'test' | 'quiz' }>; more: number };
  completed?: { tasks: Array<Omit<SummaryTask, 'dueDate' | 'dueTime'> & { completedOn: string }>; more: number };
};
export type SummaryView =
  | { state: 'missing' }
  | { state: 'limited' }
  | { state: 'paused'; firstName: string }
  | { state: 'ok'; summary: ParentSummary };

type ShareRow = { user_id: string; token_hash: string; sections: string; created_at: string };
const fail = (code: TRPCError['code'], message: string): never => { throw new TRPCError({ code, message }); };
export const hashSummaryToken = (token: string) => createHash('sha256').update(token).digest();
const newToken = () => randomBytes(TOKEN_BYTES).toString('base64url');

/** Upcoming tests and quizzes reuse the AI's answer only while the task reads as it did then (AiService.assessments hashes the same way). */
const kindHash = (task: { title: string; notes: string }) => createHash('sha256').update(`${task.title}\0${task.notes}`).digest('base64url').slice(0, 22);

/** In-memory hits per visitor address. One server process serves the site, so this is the whole picture. */
const visitors: Map<string, number[]> = ((globalThis as unknown as { quasarSummaryVisitors?: Map<string, number[]> }).quasarSummaryVisitors ??= new Map<string, number[]>());
function visitorAllowed(ip: string | null, now: number): boolean {
  const key = ip ?? 'unknown';
  const recent = (visitors.get(key) ?? []).filter(at => now - at < VISITOR_WINDOW_MS);
  if (recent.length >= VISITOR_LIMIT) { visitors.set(key, recent); return false; }
  recent.push(now);
  visitors.set(key, recent);
  if (visitors.size > 10_000) for (const [entry, hits] of visitors) if (!hits.some(at => now - at < VISITOR_WINDOW_MS)) visitors.delete(entry);
  return true;
}

/** "Ada" from "Ada Tester"; the display name when there is no full name. */
export function firstName(user: { fullName: string; displayName: string }): string {
  const name = (user.fullName.trim() || user.displayName.trim()).split(/\s+/)[0] ?? '';
  return name.slice(0, 40) || 'Your student';
}

export class ParentSummaryService {
  constructor(private readonly service: Service, private readonly options: { ai?: AiService; now?: () => Date } = {}) {}
  private get db() { return this.service.db; }
  private get ai(): AiService { return this.options.ai ?? new AiService(this.service); }
  private now(): Date { return this.options.now?.() ?? new Date(); }

  private share(userId: string): ShareRow | undefined {
    return this.db.prepare('SELECT user_id, token_hash, sections, created_at FROM parent_summary_shares WHERE user_id=?').get(userId) as ShareRow | undefined;
  }
  private sections(row: ShareRow): SummarySections {
    const parsed = summarySectionsSchema.safeParse(JSON.parse(row.sections));
    return parsed.success ? parsed.data : DEFAULT_SECTIONS;
  }
  /** The beta, and Plus when billing is on (AiService.requirePlus). */
  private unlocked(userId: string): boolean {
    try { this.ai.requirePlus(userId); return true; } catch { return false; }
  }
  private inBeta(userId: string): boolean {
    try { this.ai.requireBeta(userId); return true; } catch { return false; }
  }

  /** Account → AI: whether it's on, what it shares, when the link was last opened, and the page as the parent sees it. */
  status(userId: string) {
    this.service.user(userId);
    const row = this.share(userId);
    const unlocked = this.unlocked(userId);
    if (!row) return { unlocked, enabled: false as const };
    const sections = this.sections(row);
    const views = this.db.prepare('SELECT count(*) n, max(viewed_at) last FROM parent_summary_views WHERE user_id=?').get(userId) as { n: number; last: string | null };
    return { unlocked, enabled: true as const, paused: !unlocked, sections, createdAt: row.created_at, views: views.n, lastViewedAt: views.last, preview: this.build(userId, sections) };
  }

  /** Turns the summary on with only "Due this week" shared. The token is returned this once; it is never stored. */
  enable(userId: string): { token: string; status: ReturnType<ParentSummaryService['status']> } {
    this.ai.requirePlus(userId);
    if (this.share(userId)) fail('CONFLICT', 'The weekly summary is already on. Make a new link if you need to copy it again.');
    const token = newToken();
    this.db.prepare('INSERT INTO parent_summary_shares(user_id,token_hash,sections,created_at) VALUES(?,?,?,?)')
      .run(userId, hashSummaryToken(token).toString('base64url'), JSON.stringify(DEFAULT_SECTIONS), this.now().toISOString());
    this.service.audit(userId, 'parentSummary.on', null, { sections: DEFAULT_SECTIONS });
    return { token, status: this.status(userId) };
  }

  /** A new link. The old one stops working at once, and its view log goes with it. */
  regenerate(userId: string): { token: string; status: ReturnType<ParentSummaryService['status']> } {
    this.ai.requirePlus(userId);
    const token = newToken();
    this.db.transaction(() => {
      const changed = this.db.prepare('UPDATE parent_summary_shares SET token_hash=?, created_at=? WHERE user_id=?').run(hashSummaryToken(token).toString('base64url'), this.now().toISOString(), userId).changes;
      if (!changed) fail('NOT_FOUND', 'Turn on the weekly summary first.');
      this.db.prepare('DELETE FROM parent_summary_views WHERE user_id=?').run(userId);
    })();
    this.service.audit(userId, 'parentSummary.newLink', null, {});
    return { token, status: this.status(userId) };
  }

  /** What the page shows. Allowed while paused, so a student can share less before Plus comes back. */
  setSections(userId: string, raw: z.input<typeof setSummarySectionsSchema>) {
    this.ai.requireBeta(userId);
    const { sections } = setSummarySectionsSchema.parse(raw);
    if (!this.db.prepare('UPDATE parent_summary_shares SET sections=? WHERE user_id=?').run(JSON.stringify(sections), userId).changes) fail('NOT_FOUND', 'Turn on the weekly summary first.');
    this.service.audit(userId, 'parentSummary.sections', null, { sections });
    return this.status(userId);
  }

  /** Turns it off: the link dies and the view log is deleted. Always allowed, in or out of the beta or Plus. */
  disable(userId: string) {
    this.service.user(userId);
    const removed = this.db.transaction(() => {
      this.db.prepare('DELETE FROM parent_summary_views WHERE user_id=?').run(userId);
      return this.db.prepare('DELETE FROM parent_summary_shares WHERE user_id=?').run(userId).changes;
    })();
    if (removed) this.service.audit(userId, 'parentSummary.off', null, {});
    return this.status(userId);
  }

  /**
   * The public page (/summary/[token]). An unknown, revoked or malformed token, a suspended account and an account
   * outside the beta all read the same ("missing"), so the page says nothing about why.
   */
  view(token: string, request: { ip: string | null }): SummaryView {
    const now = this.now();
    if (!visitorAllowed(request.ip, now.getTime())) return { state: 'limited' };
    if (!SUMMARY_TOKEN.test(token)) return { state: 'missing' };
    const given = hashSummaryToken(token);
    const row = this.db.prepare('SELECT user_id, token_hash, sections, created_at FROM parent_summary_shares WHERE token_hash=?').get(given.toString('base64url')) as ShareRow | undefined;
    const stored = row ? Buffer.from(row.token_hash, 'base64url') : Buffer.alloc(given.length);
    if (!row || stored.length !== given.length || !timingSafeEqual(stored, given)) return { state: 'missing' };
    const userId = row.user_id;
    if (this.db.prepare('SELECT 1 FROM users WHERE id=? AND suspended_at IS NOT NULL').get(userId) || !this.inBeta(userId)) return { state: 'missing' };
    const hour = new Date(now.getTime() - 3_600_000).toISOString();
    if ((this.db.prepare('SELECT count(*) n FROM parent_summary_views WHERE user_id=? AND viewed_at>?').get(userId, hour) as { n: number }).n >= LINK_HOURLY_LIMIT) return { state: 'limited' };
    this.db.transaction(() => {
      this.db.prepare('INSERT INTO parent_summary_views(user_id,viewed_at) VALUES(?,?)').run(userId, now.toISOString());
      this.db.prepare('DELETE FROM parent_summary_views WHERE user_id=? AND viewed_at<?').run(userId, new Date(now.getTime() - VIEW_KEEP_DAYS * 86_400_000).toISOString());
    })();
    if (!this.unlocked(userId)) return { state: 'paused', firstName: firstName(this.service.user(userId)) };
    return { state: 'ok', summary: this.build(userId, this.sections(row)) };
  }

  /** The summary itself, from the student's synced tasks, in the school's time zone. Only the chosen sections are filled in. */
  build(userId: string, sections: SummarySections): ParentSummary {
    const user = this.service.user(userId);
    const personal = this.personal(userId);
    const school = user.schoolId ? this.service.school(user.schoolId).schedule : null;
    const timeZone = personal.customSchedule?.timeZone ?? school?.timeZone ?? 'UTC';
    const generatedAt = this.now().toISOString();
    const { date: today, time: nowTime } = instantParts(generatedAt, timeZone);
    const weekStart = addDays(today, 1 - weekdayOf(today));
    const weekEnd = addDays(weekStart, 6);
    const classes = new Map(personal.classes.map(entry => [entry.id, entry.name]));
    const items = this.tasks(userId);
    const base = (item: TaskItem): SummaryTask => ({ title: item.task.title, className: item.task.classId ? classes.get(item.task.classId) ?? null : null, dueDate: item.task.dueDate!, dueTime: item.task.dueTime });
    const cut = <T>(list: T[]) => ({ tasks: list.slice(0, LIST_MAX), more: Math.max(0, list.length - LIST_MAX) });
    const summary: ParentSummary = { firstName: firstName(user), timeZone, today, weekStart, weekEnd, generatedAt };
    if (sections.dueThisWeek) {
      summary.dueThisWeek = cut(sortByDue(items.filter(item => item.task.dueDate && item.task.dueDate >= weekStart && item.task.dueDate <= weekEnd))
        .map(item => ({ ...base(item), done: item.task.completed, overdue: isOverdue(item.task, today, nowTime) })));
    }
    if (sections.overdue) summary.overdue = { count: items.filter(item => isOverdue(item.task, today, nowTime)).length };
    if (sections.assessments) {
      const stored = new Map((this.db.prepare('SELECT task_id, content_hash, kind FROM ai_task_kinds WHERE owner_id=?').all(userId) as Array<{ task_id: string; content_hash: string; kind: 'test' | 'quiz' | 'none' }>)
        .map(row => [row.task_id, row]));
      // The AI's answer when it has seen this version of the task; otherwise the same title words the app falls back to.
      const kindOf = (item: TaskItem): 'test' | 'quiz' | 'none' => {
        const row = stored.get(item.id);
        if (row && row.content_hash === kindHash(item.task)) return row.kind;
        return keywordKind(item);
      };
      summary.assessments = cut(assessmentCandidates(items, today).flatMap(item => {
        const kind = kindOf(item);
        return kind === 'none' ? [] : [{ ...base(item), kind }];
      }));
    }
    if (sections.completed) {
      const done = items.flatMap(item => {
        if (!item.task.completed || !item.task.completedAt) return [];
        const completedOn = instantParts(item.task.completedAt, timeZone).date;
        return completedOn >= weekStart && completedOn <= today ? [{ item, at: item.task.completedAt, completedOn }] : [];
      }).sort((left, right) => right.at.localeCompare(left.at));
      summary.completed = cut(done.map(({ item, completedOn }) => ({ title: item.task.title, className: item.task.classId ? classes.get(item.task.classId) ?? null : null, completedOn })));
    }
    return summary;
  }

  private personal(userId: string): PersonalSchedule {
    const existing = this.service.entity(userId, 'personal');
    const parsed = personalScheduleSchema.safeParse(existing && !existing.deleted ? existing.data : emptyPersonalSchedule());
    return parsed.success ? parsed.data : emptyPersonalSchedule();
  }

  /** Live tasks, read like the app reads them (taskItems), minus ones their calendar dropped. */
  private tasks(userId: string): TaskItem[] {
    const rows = this.db.prepare("SELECT id, version, data FROM entities WHERE owner_id=? AND kind='task' AND deleted=0").all(userId) as Array<{ id: string; version: number; data: string }>;
    return rows.flatMap(row => {
      const data = JSON.parse(row.data) as unknown;
      const parsed = taskSchema.safeParse(data);
      const task = parsed.success ? parsed.data : repairTaskDates(data);
      if (!task || task.imported?.sourceRemoved) return [];
      return [{ id: row.id, task, entity: { id: row.id, kind: 'task' as const, version: row.version, data: task, deleted: false } }];
    });
  }
}

