import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Temporal } from '@js-temporal/polyfill';
import { exampleSchedule } from '@/domain/example';
import { personalScheduleSchema, resolveDay } from '@/domain/schedule';
import { openDatabase, type Db } from './db';
import { readEntity } from './entities';
import type { fetchFeed } from './feed-fetch';
import { NO_SCHOOL_MESSAGE, NOTHING_MATCHED_MESSAGE, SCHEDULE_FEED_INTERVAL_MS, ScheduleFeedService, scheduleFeedStatus } from './schedule-feed';
import { Service } from './service';

const databases: Db[] = [];
afterEach(() => { for (const db of databases.splice(0)) if (db.open) db.close(); });
const TITLES: Record<string, string> = { A: 'Algebra II', B: 'English 10', C: 'Biology', D: 'US History' };
const URL = 'https://api.veracross.com/example/subscribe/class-schedule.ics?t=private-token';

/** A Veracross-style class schedule: one VEVENT per meeting, zoned with TZID, room in LOCATION. */
function classSchedule(titles = TITLES, from = '2026-08-31', to = '2026-12-18') {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Veracross//Calendar//EN'];
  for (let date = Temporal.PlainDate.from(from); Temporal.PlainDate.compare(date, Temporal.PlainDate.from(to)) <= 0; date = date.add({ days: 1 })) {
    for (const period of resolveDay(exampleSchedule, date.toString()).periods) {
      if (!titles[period.periodId]) continue;
      const stamp = (time: string) => `${date.toString().replaceAll('-', '')}T${time.replace(':', '')}00`;
      lines.push('BEGIN:VEVENT', `UID:${date}-${period.periodId}@veracross`, `DTSTART;TZID=America/New_York:${stamp(period.start)}`, `DTEND;TZID=America/New_York:${stamp(period.end)}`,
        `SUMMARY:${titles[period.periodId]}`, `LOCATION:Room ${period.periodId}1`, 'END:VEVENT');
    }
  }
  return [...lines, 'END:VCALENDAR'].join('\r\n');
}

function fixture({ join = true } = {}) {
  const db = openDatabase(':memory:'); databases.push(db);
  const service = new Service(db, 'owner@example.com');
  const user = () => { const id = randomUUID(); db.prepare('INSERT INTO users(id,google_sub,email,display_name,full_name,created_at) VALUES(?,?,?,?,?,?)').run(id, id, `${id}@example.com`, 'Student', 'Student Name', new Date().toISOString()); return id; };
  const owner = user();
  const school = service.createSchool(owner, { name: 'Example High', location: 'Boston, MA', schedule: exampleSchedule });
  if (join) service.join(owner, { schoolId: school.id, choice: 'community' });
  let now = new Date('2026-09-21T12:00:00Z');
  const fetcher = vi.fn<typeof fetchFeed>().mockResolvedValue({ status: 200, text: classSchedule() });
  const feeds = new ScheduleFeedService(db, { secret: 'test-only-secret-that-is-at-least-32-characters', fetcher, now: () => now });
  const personal = () => personalScheduleSchema.parse(readEntity(db, owner, 'personal')!.data);
  const save = (data: ReturnType<typeof personal>) => {
    const base = readEntity(db, owner, 'personal')!;
    const result = service.sync(owner, { mutationId: randomUUID(), id: 'personal', kind: 'personal', base, data });
    if (result.status !== 'applied') throw new Error('save failed');
  };
  return { db, service, owner, feeds, fetcher, personal, save, advance: (ms: number) => { now = new Date(now.getTime() + ms); } };
}
const nameOf = (f: ReturnType<typeof fixture>, periodId: string) => { const p = f.personal(); return p.classes.find(cls => cls.id === p.assignments[periodId])?.name; };

describe('class schedule feed', () => {
  it('fills every class block on connect and stores the link encrypted', async () => {
    const f = fixture();
    const status = await f.feeds.connect(f.owner, { source: 'veracross', url: URL });
    expect(['A', 'B', 'C', 'D'].map(periodId => nameOf(f, periodId))).toEqual(['Algebra II', 'English 10', 'Biology', 'US History']);
    expect(f.personal().classes.find(cls => cls.name === 'Biology')?.room).toBe('Room C1');
    expect(status.summary).toMatchObject({ classes: 4, blocks: 4, kept: 0 });
    expect(status.nextRefreshAt).toBe('2026-09-22T12:00:00.000Z');
    const stored = f.db.prepare('SELECT url_encrypted FROM schedule_feeds WHERE owner_id=?').get(f.owner) as { url_encrypted: string };
    expect(stored.url_encrypted).not.toContain('private-token');
    expect(f.service.workspace(f.owner).scheduleFeed?.source).toBe('veracross');
  });

  it('saves nothing when the link matches no block, cannot be read, or the student has no school', async () => {
    const f = fixture();
    f.fetcher.mockResolvedValueOnce({ status: 200, text: classSchedule({}) });
    await expect(f.feeds.connect(f.owner, { source: 'veracross', url: URL })).rejects.toThrow(NOTHING_MATCHED_MESSAGE);
    f.fetcher.mockRejectedValueOnce(new Error('connect ECONNREFUSED https://api.veracross.com/example?t=private-token'));
    await expect(f.feeds.connect(f.owner, { source: 'veracross', url: URL })).rejects.toThrow(/^Could not read this link\. Check that it is the Class Schedules/);
    expect(scheduleFeedStatus(f.db, f.owner)).toBeNull();
    const lone = fixture({ join: false });
    await expect(lone.feeds.connect(lone.owner, { source: 'veracross', url: URL })).rejects.toThrow(NO_SCHOOL_MESSAGE);
  });

  it('syncs once a day, follows schedule changes and keeps the student’s own edits', async () => {
    const f = fixture();
    await f.feeds.connect(f.owner, { source: 'veracross', url: URL });
    // The student puts Biology in block A themselves.
    const before = f.personal();
    const biology = before.classes.find(cls => cls.name === 'Biology')!.id;
    f.save({ ...before, assignments: { ...before.assignments, A: biology } });
    f.fetcher.mockResolvedValue({ status: 200, text: classSchedule({ ...TITLES, D: 'World History' }) });
    f.advance(SCHEDULE_FEED_INTERVAL_MS - 60_000);
    expect(await f.feeds.refreshDue()).toBe(0);
    f.advance(60_000);
    expect(await f.feeds.refreshDue()).toBe(1);
    expect(nameOf(f, 'A')).toBe('Biology');
    expect(nameOf(f, 'D')).toBe('World History');
    expect(scheduleFeedStatus(f.db, f.owner)?.summary).toMatchObject({ kept: 1, added: ['World History'] });
  });

  it('records a failed sync, retries within the day, and keeps the timetable', async () => {
    const f = fixture();
    await f.feeds.connect(f.owner, { source: 'veracross', url: URL });
    const filled = f.personal();
    f.fetcher.mockRejectedValue(new Error('Calendar server returned HTTP 404.'));
    f.advance(SCHEDULE_FEED_INTERVAL_MS);
    await f.feeds.refreshDue();
    const status = scheduleFeedStatus(f.db, f.owner)!;
    expect(status.lastError).toBe('Could not read this link. Calendar server returned HTTP 404.');
    expect(Date.parse(status.nextRefreshAt) - Date.parse('2026-09-22T12:00:00Z')).toBe(3600_000);
    expect(f.personal()).toEqual(filled);
    await expect(f.feeds.syncNow(f.owner)).rejects.toThrow('less than a minute ago');
    f.advance(61_000);
    f.fetcher.mockResolvedValue({ status: 200, text: classSchedule() });
    expect((await f.feeds.syncNow(f.owner)).lastError).toBeNull();
  });

  it('previews without saving, then connects only the classes the student kept ticked', async () => {
    const f = fixture();
    const before = f.personal();
    const preview = await f.feeds.preview(f.owner, { source: 'veracross', url: URL });
    expect(preview.rows.map(row => [row.name, row.periodIds, row.included])).toEqual(expect.arrayContaining([['Biology', ['C'], true], ['US History', ['D'], true]]));
    expect(f.personal()).toEqual(before);
    expect(scheduleFeedStatus(f.db, f.owner)).toBeNull();
    const history = preview.rows.find(row => row.name === 'US History')!.key;
    await f.feeds.connect(f.owner, { source: 'veracross', url: URL, choices: { [history]: false } });
    expect(nameOf(f, 'D')).toBeUndefined();
    expect(nameOf(f, 'C')).toBe('Biology');
    f.advance(SCHEDULE_FEED_INTERVAL_MS);
    await f.feeds.refreshDue();
    expect(f.personal().classes.map(cls => cls.name)).not.toContain('US History');
  });

  it('keeps the classes after disconnecting', async () => {
    const f = fixture();
    await f.feeds.connect(f.owner, { source: 'veracross', url: URL });
    f.feeds.disconnect(f.owner);
    expect(scheduleFeedStatus(f.db, f.owner)).toBeNull();
    expect(nameOf(f, 'B')).toBe('English 10');
    expect(await f.feeds.refreshDue()).toBe(0);
  });
});
