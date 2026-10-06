import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { parseICalendar } from '@/domain/ical';
import { applyScheduleImport, importStateSchema, importWindow, previewScheduleImport, readScheduleFeed, type ImportChoices, type ImportPreviewRow, type ImportState, type ImportSummary } from '@/domain/schedule-import';
import { emptyPersonalSchedule, personalScheduleSchema, scheduleSchema, type PersonalSchedule, type Schedule } from '@/domain/schedule';
import { decrypt, encrypt, encryptionKey, safeFeedReason } from './calendar';
import { isBusy, type Db } from './db';
import { readEntity, writeEntity } from './entities';
import { fetchFeed, normalizeFeedUrl } from './feed-fetch';

/**
 * A class-schedule feed that fills the student's class blocks (src/domain/schedule-import.ts). One per account. The
 * worker syncs it once a day; the student can also sync it by hand, at most once a minute.
 */
export const SCHEDULE_FEED_SOURCES = ['veracross'] as const;
export const previewScheduleFeedSchema = z.object({ source: z.enum(SCHEDULE_FEED_SOURCES), url: z.string().max(4000) });
/** `choices` is the review screen's answer per class key (ImportChoices): true to add the class, false to leave it out. */
export const connectScheduleFeedSchema = previewScheduleFeedSchema.extend({
  choices: z.record(z.string().max(200), z.boolean()).refine(value => Object.keys(value).length <= 300, 'Too many classes.').optional(),
});
export const SCHEDULE_FEED_INTERVAL_MS = 24 * 3600_000;
/** Checking and connecting each fetch the link at once, so together they are capped per account like adding calendar feeds. */
export const SCHEDULE_FEED_DAILY_FETCHES = 20;
/** A school year of one event per class meeting is a few thousand entries; only the dates around today are read. */
const MAX_SCHEDULE_ENTRIES = 8000;

export interface ScheduleFeedStatus {
  source: (typeof SCHEDULE_FEED_SOURCES)[number];
  createdAt: string;
  lastSuccessAt: string | null;
  nextRefreshAt: string;
  lastError: string | null;
  summary: ImportSummary | null;
}
/** What connecting this link would do, for the student to confirm. Nothing is saved by a preview. */
export interface ScheduleFeedPreview {
  rows: ImportPreviewRow[];
  /** Class blocks whose meetings split between classes; connecting leaves them as they are. */
  unsettledPeriodIds: string[];
  unmatched: number;
}
interface Row { owner_id: string; source: string; url_encrypted: string; state: string | null; summary: string | null; created_at: string; last_attempt_at: string | null;
  last_success_at: string | null; next_refresh_at: string; last_error: string | null; failure_count: number; lease_until: string | null }

const fail = (code: 'NOT_FOUND' | 'BAD_REQUEST' | 'TOO_MANY_REQUESTS' | 'PRECONDITION_FAILED', message: string): never => { throw new TRPCError({ code, message }); };
export const NO_SCHOOL_MESSAGE = 'Join your school in Quasar first. Your class schedule is matched against its blocks.';
export const NOTHING_MATCHED_MESSAGE = 'None of the class meetings in this link line up with your school’s blocks. Check that you copied the Class Schedules link, not Assignments or a school-wide calendar, and that your school’s bell times in Quasar are right.';
const KEY_CHANGED_MESSAGE = 'The server’s encryption key changed, so your saved link can no longer be read. Connect your class schedule again.';
const GENERIC_ERROR = 'Could not read this link. Check that it is the Class Schedules subscription link from your portal.';
/** Shown to the student; only fixed reasons, because a raw network error can quote the private link. */
function feedError(error: unknown): string {
  if (error instanceof TRPCError && error.code !== 'INTERNAL_SERVER_ERROR') return error.message;
  const reason = safeFeedReason(error);
  return reason ? `Could not read this link. ${reason}` : GENERIC_ERROR;
}

export function scheduleFeedStatus(db: Db, owner: string): ScheduleFeedStatus | null {
  const row = db.prepare('SELECT * FROM schedule_feeds WHERE owner_id=?').get(owner) as Row | undefined;
  if (!row) return null;
  return { source: row.source as ScheduleFeedStatus['source'], createdAt: row.created_at, lastSuccessAt: row.last_success_at, nextRefreshAt: row.next_refresh_at, lastError: row.last_error,
    summary: row.summary ? JSON.parse(row.summary) as ImportSummary : null };
}

export class ScheduleFeedService {
  constructor(readonly db: Db, readonly options: { secret?: string; fetcher?: typeof fetchFeed; now?: () => Date } = {}) {}
  private now() { return this.options.now?.() ?? new Date(); }
  private secret() { return this.options.secret ?? process.env.NEXTAUTH_SECRET ?? ''; }
  private row(owner: string) { return this.db.prepare('SELECT * FROM schedule_feeds WHERE owner_id=?').get(owner) as Row | undefined; }

  /** The school schedule and personal schedule a sync reads, or null when the student has not joined a school. */
  private timetable(owner: string): { school: Schedule; personal: PersonalSchedule; version: number } | null {
    const user = this.db.prepare('SELECT s.schedule FROM users u JOIN schools s ON s.id=u.school_id WHERE u.id=?').get(owner) as { schedule: string } | undefined;
    if (!user) return null;
    const entity = readEntity(this.db, owner, 'personal');
    const personal = personalScheduleSchema.safeParse(entity && !entity.deleted ? entity.data : emptyPersonalSchedule());
    if (!personal.success) fail('PRECONDITION_FAILED', 'Your saved timetable could not be read. Open Quasar and retry sync, then try again.');
    return { school: scheduleSchema.parse(JSON.parse(user.schedule)), personal: personal.data!, version: entity?.version ?? 0 };
  }

  private async fetchItems(url: string, timeZone: string) {
    const { windowStart, windowEnd } = importWindow(timeZone, this.now());
    const response = await (this.options.fetcher ?? fetchFeed)(url, {});
    // No validators are sent, so a 304 cannot happen; a feed that sends one anyway is not read.
    if (response.status !== 200) throw new Error('The response is not a complete iCalendar feed.');
    return { items: parseICalendar(response.text, { timeZone, windowStart, windowEnd, maxItems: MAX_SCHEDULE_ENTRIES, location: true }), windowStart, windowEnd };
  }

  /**
   * Reads the feed and writes it into the student's timetable in one transaction, reading the timetable again inside
   * it, so an edit saved while the feed was downloading is kept. Throws NOTHING_MATCHED_MESSAGE when no meeting lines up.
   */
  private async apply(owner: string, url: string, previous: ImportState | null, choices: ImportChoices = {}): Promise<{ state: ImportState; summary: ImportSummary }> {
    const before = this.timetable(owner) ?? fail('PRECONDITION_FAILED', NO_SCHOOL_MESSAGE);
    const { items, windowStart, windowEnd } = await this.fetchItems(url, before.school.timeZone);
    return this.db.transaction(() => {
      const current = this.timetable(owner) ?? fail('PRECONDITION_FAILED', NO_SCHOOL_MESSAGE);
      const reading = readScheduleFeed(items, current.school, current.personal, windowStart, windowEnd);
      if (reading.classes.length === 0) fail('BAD_REQUEST', NOTHING_MATCHED_MESSAGE);
      const result = applyScheduleImport(current.personal, reading, previous, choices);
      const next = personalScheduleSchema.parse(result.personal);
      if (JSON.stringify(next) !== JSON.stringify(current.personal)) writeEntity(this.db, owner, { id: 'personal', kind: 'personal', version: current.version + 1, data: next, deleted: false });
      return { state: result.state, summary: result.summary };
    }).immediate();
  }

  /**
   * Checks the link, the school and the daily fetch limit, and returns the normalized link with the state of an earlier
   * connection: reconnecting (a new link after the old one was reset) keeps it, so the student's edits still count.
   */
  private begin(owner: string, input: z.infer<typeof previewScheduleFeedSchema>): { url: string; previous: ImportState | null } {
    let url: string;
    try { url = normalizeFeedUrl(input.url); } catch { return fail('BAD_REQUEST', 'Paste the whole subscription link. It starts with https:// or webcal://.'); }
    encryptionKey(this.secret());
    if (!this.timetable(owner)) fail('PRECONDITION_FAILED', NO_SCHOOL_MESSAGE);
    this.db.transaction(() => {
      const since = new Date(this.now().getTime() - 86_400_000).toISOString();
      const recent = this.db.prepare("SELECT count(*) n FROM audit_log WHERE actor_id=? AND action='schedule-feed.fetch' AND created_at > ?").get(owner, since) as { n: number };
      if (recent.n >= SCHEDULE_FEED_DAILY_FETCHES) fail('TOO_MANY_REQUESTS', 'You have checked a lot of class schedule links today. Try again tomorrow.');
      this.db.prepare("INSERT INTO audit_log(actor_id,action,school_id,detail,created_at) VALUES(?,'schedule-feed.fetch',NULL,?,?)").run(owner, JSON.stringify({ source: input.source }), this.now().toISOString());
    }).immediate();
    const existing = this.row(owner);
    return { url, previous: existing?.state ? importStateSchema.parse(JSON.parse(existing.state)) : null };
  }

  /** Reads the link and says where each class would go, without saving anything. */
  async preview(owner: string, raw: z.infer<typeof previewScheduleFeedSchema>): Promise<ScheduleFeedPreview> {
    const { url, previous } = this.begin(owner, previewScheduleFeedSchema.parse(raw));
    try {
      const before = this.timetable(owner) ?? fail('PRECONDITION_FAILED', NO_SCHOOL_MESSAGE);
      const { items, windowStart, windowEnd } = await this.fetchItems(url, before.school.timeZone);
      const current = this.timetable(owner) ?? fail('PRECONDITION_FAILED', NO_SCHOOL_MESSAGE);
      const reading = readScheduleFeed(items, current.school, current.personal, windowStart, windowEnd);
      if (reading.classes.length === 0) fail('BAD_REQUEST', NOTHING_MATCHED_MESSAGE);
      return { rows: previewScheduleImport(current.personal, reading, previous), unsettledPeriodIds: reading.unsettledPeriodIds, unmatched: reading.unmatched };
    } catch (error) { return fail('BAD_REQUEST', feedError(error)); }
  }

  /**
   * Saves the link and fills the timetable from it with the classes the student confirmed. The link is read again,
   * so a class that appeared since the preview is added unless the student left it out. Nothing is saved when the
   * link cannot be read or matches nothing.
   */
  async connect(owner: string, raw: z.infer<typeof connectScheduleFeedSchema>): Promise<ScheduleFeedStatus> {
    const input = connectScheduleFeedSchema.parse(raw);
    const { url, previous } = this.begin(owner, input);
    let result: { state: ImportState; summary: ImportSummary };
    try { result = await this.apply(owner, url, previous, input.choices ?? {}); } catch (error) { return fail('BAD_REQUEST', feedError(error)); }
    const stamp = this.now().toISOString();
    this.db.prepare(`INSERT INTO schedule_feeds(owner_id,source,url_encrypted,state,summary,created_at,last_attempt_at,last_success_at,next_refresh_at)
      VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(owner_id) DO UPDATE SET source=excluded.source,url_encrypted=excluded.url_encrypted,state=excluded.state,summary=excluded.summary,
      last_attempt_at=excluded.last_attempt_at,last_success_at=excluded.last_success_at,next_refresh_at=excluded.next_refresh_at,last_error=NULL,failure_count=0,lease_until=NULL`)
      .run(owner, input.source, encrypt(url, this.secret()), JSON.stringify(result.state), JSON.stringify(result.summary), stamp, stamp, stamp, this.nextRefresh());
    return scheduleFeedStatus(this.db, owner)!;
  }

  /** Stops syncing. The classes and blocks it filled stay as they are. */
  disconnect(owner: string): void {
    this.db.prepare('DELETE FROM schedule_feeds WHERE owner_id=?').run(owner);
  }

  /** The Sync now button: like a scheduled sync, but says why it did not run and throws its error. */
  async syncNow(owner: string): Promise<ScheduleFeedStatus> {
    const row = this.row(owner) ?? fail('NOT_FOUND', 'No class schedule is connected.');
    if (row.last_attempt_at && this.now().getTime() - Date.parse(row.last_attempt_at) < 60_000) fail('TOO_MANY_REQUESTS', 'Quasar checked your class schedule less than a minute ago. Wait a minute, then try again.');
    await this.sync(row);
    const status = scheduleFeedStatus(this.db, owner)!;
    if (status.lastError) fail('BAD_REQUEST', status.lastError);
    return status;
  }

  private nextRefresh() { return new Date(this.now().getTime() + SCHEDULE_FEED_INTERVAL_MS).toISOString(); }

  /** One sync. Holds a five-minute lease so the worker and a Sync now press never run the same feed at once. */
  private async sync(row: Row): Promise<void> {
    const now = this.now();
    const leaseUntil = new Date(now.getTime() + 5 * 60_000).toISOString();
    const leased = this.db.prepare('UPDATE schedule_feeds SET lease_until=?,last_attempt_at=? WHERE owner_id=? AND (lease_until IS NULL OR lease_until<=?)').run(leaseUntil, now.toISOString(), row.owner_id, now.toISOString());
    if (leased.changes === 0) fail('TOO_MANY_REQUESTS', 'Your class schedule is syncing right now. Check back in a minute.');
    try {
      let url: string;
      try { url = decrypt(row.url_encrypted, this.secret()); } catch { throw new TRPCError({ code: 'PRECONDITION_FAILED', message: KEY_CHANGED_MESSAGE }); }
      const previous = row.state ? importStateSchema.parse(JSON.parse(row.state)) : null;
      const { state, summary } = await this.apply(row.owner_id, url, previous);
      this.db.prepare('UPDATE schedule_feeds SET state=?,summary=?,last_success_at=?,next_refresh_at=?,last_error=NULL,failure_count=0,lease_until=NULL WHERE owner_id=?')
        .run(JSON.stringify(state), JSON.stringify(summary), now.toISOString(), this.nextRefresh(), row.owner_id);
    } catch (error) {
      if (isBusy(error)) {
        try { this.db.prepare('UPDATE schedule_feeds SET next_refresh_at=?,lease_until=NULL WHERE owner_id=?').run(new Date(now.getTime() + 60_000).toISOString(), row.owner_id); } catch { /* the lease expires on its own */ }
        return;
      }
      // Retry after an hour, doubling up to a day, so a portal outage does not leave the timetable stale for long.
      const retry = Math.min(SCHEDULE_FEED_INTERVAL_MS, 3600_000 * 2 ** Math.min(row.failure_count, 5));
      const message = feedError(error);
      this.db.prepare('UPDATE schedule_feeds SET last_error=?,failure_count=failure_count+1,next_refresh_at=?,lease_until=NULL WHERE owner_id=?')
        .run(message, new Date(now.getTime() + retry).toISOString(), row.owner_id);
    }
  }

  /** The worker's step: every feed that is due, one at a time. Returns how many it tried. */
  async refreshDue(limit = 200): Promise<number> {
    const now = this.now().toISOString();
    const rows = this.db.prepare('SELECT * FROM schedule_feeds WHERE next_refresh_at<=? AND (lease_until IS NULL OR lease_until<=?) ORDER BY next_refresh_at LIMIT ?').all(now, now, limit) as Row[];
    if (rows.length) encryptionKey(this.secret());
    for (const row of rows) {
      try { await this.sync(row); } catch (error) { if (!(error instanceof TRPCError && error.code === 'TOO_MANY_REQUESTS')) throw error; }
    }
    return rows.length;
  }
}
