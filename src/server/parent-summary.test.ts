import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { openDatabase, type Db } from './db';
import { Service } from './service';
import { AiService, type AiConfig, type AiFetch } from './ai';
import { LINK_HOURLY_LIMIT, ParentSummaryService, SUMMARY_TOKEN, VISITOR_LIMIT, firstName, type SummarySections } from './parent-summary';
import { exampleSchedule } from '@/domain/example';
import { emptyPersonalSchedule } from '@/domain/schedule';

const databases: Db[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

const bio = '11111111-1111-4111-8111-111111111111';
const spanish = '22222222-2222-4222-8222-222222222222';
/** Wednesday 4 November 2026, 10:00 in New York: the week runs Mon 2 to Sun 8 November. */
const NOW = new Date('2026-11-04T15:00:00Z');
const ALL: SummarySections = { dueThisWeek: true, overdue: true, assessments: true, completed: true };
const kindHash = (title: string, notes: string) => createHash('sha256').update(`${title}\0${notes}`).digest('base64url').slice(0, 22);
let ipCounter = 0;
/** A fresh visitor address per call, so the in-memory per-address limit only bites where a test wants it to. */
const visitor = () => ({ ip: `198.51.100.${++ipCounter % 250}-${randomUUID()}` });

function fixture(options: { plus?: boolean; billing?: boolean; inBeta?: boolean } = {}) {
  const db = openDatabase(':memory:'); databases.push(db);
  const service = new Service(db, 'owner@example.com');
  const id = randomUUID();
  db.prepare('INSERT INTO users(id,google_sub,email,display_name,full_name,created_at) VALUES(?,?,?,?,?,?)').run(id, id, `${id}@example.com`, 'adaL', 'Ada Lovelace', NOW.toISOString());
  const school = service.createSchool(id, { name: 'Summary High', location: 'Boston, MA', schedule: exampleSchedule });
  service.join(id, { schoolId: school.id, choice: 'community', grade: '9' });
  db.prepare("INSERT OR REPLACE INTO entities(owner_id,id,kind,version,data,deleted) VALUES(?,'personal','personal',1,?,0)")
    .run(id, JSON.stringify({ ...emptyPersonalSchedule(), classes: [{ id: bio, name: 'Biology' }, { id: spanish, name: 'Spanish 3' }] }));
  const flags = { plus: options.plus ?? false, billing: options.billing ?? false, inBeta: options.inBeta ?? true };
  const ai = new AiService(service, { config: null, inBeta: () => flags.inBeta, plus: () => flags.plus, billing: flags.billing });
  const summaries = new ParentSummaryService(service, { ai, now: () => NOW });
  const put = (taskId: string, data: Record<string, unknown>, deleted = false) => db.prepare('INSERT INTO entities(owner_id,id,kind,version,data,deleted) VALUES(?,?,?,?,?,?)')
    .run(id, taskId, 'task', 1, JSON.stringify({ dueDate: null, dueTime: null, classId: null, notes: '', completed: false, ...data }), Number(deleted));
  put('lab', { title: 'Lab report', dueDate: '2026-11-03', dueTime: '08:00', classId: bio, notes: 'secret note about my lab partner' });
  put('essay', { title: 'Essay draft', dueDate: '2026-11-06', classId: spanish, completed: true, completedAt: '2026-11-04T14:00:00.000Z' });
  put('later', { title: 'Reading log', dueDate: '2026-11-06', dueTime: '15:00' });
  put('test', { title: 'Chapter 5 test', dueDate: '2026-11-10', classId: bio });
  put('vocab', { title: 'Vocab practice', dueDate: '2026-11-12', classId: spanish });
  put('pop', { title: 'Pop check', dueDate: '2026-11-09' });
  put('old', { title: 'Old worksheet', dueDate: '2026-10-20' });
  put('lastweek', { title: 'Last week thing', dueDate: '2026-10-29', completed: true, completedAt: '2026-10-30T14:00:00.000Z' });
  put('gone', { title: 'Deleted homework', dueDate: '2026-11-05' }, true);
  put('dropped', { title: 'Calendar dropped this', dueDate: '2026-11-05', imported: { subscriptionId: 's', uid: 'u', recurrenceId: null, startDate: '2026-11-05', startTime: null, endDate: null, endTime: null, timeZone: 'America/New_York', allDay: true, sourceRemoved: true, sourceUpdatedAt: NOW.toISOString() } });
  // The AI called "Vocab practice" a quiz for its current text, and "Pop check" a quiz before it was edited.
  db.prepare('INSERT INTO ai_task_kinds(owner_id,task_id,content_hash,kind,classified_at) VALUES(?,?,?,?,?)').run(id, 'vocab', kindHash('Vocab practice', ''), 'quiz', NOW.toISOString());
  db.prepare('INSERT INTO ai_task_kinds(owner_id,task_id,content_hash,kind,classified_at) VALUES(?,?,?,?,?)').run(id, 'pop', kindHash('Pop check (old)', ''), 'quiz', NOW.toISOString());
  return { db, service, student: id, summaries, flags, put };
}
const ok = (view: ReturnType<ParentSummaryService['view']>) => { if (view.state !== 'ok') throw new Error(`expected ok, got ${view.state}`); return view.summary; };

describe('weekly parent summary', () => {
  it('stores only a hash of the token and never logs it', () => {
    const f = fixture();
    const { token, status } = f.summaries.enable(f.student);
    expect(token).toMatch(SUMMARY_TOKEN);
    expect(status).toMatchObject({ enabled: true, sections: { dueThisWeek: true, overdue: false, assessments: false, completed: false }, views: 0, lastViewedAt: null });
    const row = f.db.prepare('SELECT * FROM parent_summary_shares WHERE user_id=?').get(f.student) as Record<string, string>;
    expect(row.token_hash).toBe(createHash('sha256').update(token).digest('base64url'));
    const everything = JSON.stringify([row, f.db.prepare('SELECT * FROM audit_log').all()]);
    expect(everything).not.toContain(token);
  });

  it('shows only the chosen sections, the first name, and never notes', () => {
    const f = fixture();
    const { token } = f.summaries.enable(f.student);
    const summary = ok(f.summaries.view(token, visitor()));
    expect(Object.keys(summary).sort()).toEqual(['dueThisWeek', 'firstName', 'generatedAt', 'timeZone', 'today', 'weekEnd', 'weekStart']);
    expect(summary).toMatchObject({ firstName: 'Ada', timeZone: 'America/New_York', today: '2026-11-04', weekStart: '2026-11-02', weekEnd: '2026-11-08' });
    expect(summary.dueThisWeek!.tasks).toEqual([
      { title: 'Lab report', className: 'Biology', dueDate: '2026-11-03', dueTime: '08:00', done: false, overdue: true },
      { title: 'Reading log', className: null, dueDate: '2026-11-06', dueTime: '15:00', done: false, overdue: false },
      { title: 'Essay draft', className: 'Spanish 3', dueDate: '2026-11-06', dueTime: null, done: true, overdue: false },
    ]);
    const text = JSON.stringify(summary);
    for (const hidden of ['secret note', 'Lovelace', 'adaL', 'Deleted homework', 'Calendar dropped', f.student]) expect(text).not.toContain(hidden);
  });

  it('fills in every section the student ticks, in the school’s time zone', () => {
    const f = fixture();
    const { token } = f.summaries.enable(f.student);
    expect(f.summaries.setSections(f.student, { sections: ALL }).enabled).toBe(true);
    const summary = ok(f.summaries.view(token, visitor()));
    expect(summary.overdue).toEqual({ count: 2 });
    // The AI's answer counts while the task is unchanged; otherwise the title words decide ("Pop check" has none).
    expect(summary.assessments).toEqual({ more: 0, tasks: [
      { title: 'Chapter 5 test', className: 'Biology', dueDate: '2026-11-10', dueTime: null, kind: 'test' },
      { title: 'Vocab practice', className: 'Spanish 3', dueDate: '2026-11-12', dueTime: null, kind: 'quiz' },
    ] });
    expect(summary.completed).toEqual({ more: 0, tasks: [{ title: 'Essay draft', className: 'Spanish 3', completedOn: '2026-11-04' }] });
    f.summaries.setSections(f.student, { sections: { dueThisWeek: false, overdue: true, assessments: false, completed: false } });
    expect(Object.keys(ok(f.summaries.view(token, visitor())))).not.toContain('dueThisWeek');
    expect(() => f.summaries.setSections(f.student, { sections: { ...ALL, grades: true } as unknown as SummarySections })).toThrow();
  });

  it('reads the AI’s test-or-quiz answers the way AiService.assessments stores them', async () => {
    const f = fixture();
    const config: AiConfig = { url: 'https://ai.example/v1', key: 'k', model: 'm', json: true, openRouter: false };
    const fetcher = vi.fn<AiFetch>().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ tasks: [{ id: 'review', kind: 'test' }] }) } }] })));
    f.put('review', { title: 'Unit review', dueDate: '2026-11-11', notes: 'Bring a calculator' });
    await new AiService(f.service, { config, fetcher, inBeta: () => true }).assessments(f.student, { tasks: [{ id: 'review', title: 'Unit review', notes: 'Bring a calculator', classId: null }] });
    f.summaries.enable(f.student);
    expect(f.summaries.build(f.student, ALL).assessments!.tasks.map(task => task.title)).toContain('Unit review');
  });

  it('a new link kills the old one and clears its views', () => {
    const f = fixture();
    const first = f.summaries.enable(f.student).token;
    ok(f.summaries.view(first, visitor()));
    expect(f.summaries.status(f.student)).toMatchObject({ views: 1, lastViewedAt: NOW.toISOString() });
    expect(() => f.summaries.enable(f.student)).toThrow('already on');
    const second = f.summaries.regenerate(f.student);
    expect(second.token).not.toBe(first);
    expect(f.summaries.view(first, visitor())).toEqual({ state: 'missing' });
    expect(second.status).toMatchObject({ views: 0, lastViewedAt: null });
    ok(f.summaries.view(second.token, visitor()));
  });

  it('turning it off kills the link and deletes the view log', () => {
    const f = fixture();
    const { token } = f.summaries.enable(f.student);
    ok(f.summaries.view(token, visitor()));
    expect(f.summaries.disable(f.student)).toEqual({ unlocked: true, enabled: false });
    expect(f.summaries.view(token, visitor())).toEqual({ state: 'missing' });
    expect(f.db.prepare('SELECT count(*) n FROM parent_summary_views').get()).toEqual({ n: 0 });
    expect(() => f.summaries.regenerate(f.student)).toThrow('Turn on');
    expect(() => f.summaries.setSections(f.student, { sections: ALL })).toThrow('Turn on');
  });

  it('is paused, showing nothing but the first name, while Plus has lapsed', () => {
    const f = fixture({ billing: true, plus: true });
    const { token } = f.summaries.enable(f.student);
    ok(f.summaries.view(token, visitor()));
    f.flags.plus = false;
    expect(f.summaries.view(token, visitor())).toEqual({ state: 'paused', firstName: 'Ada' });
    expect(f.summaries.status(f.student)).toMatchObject({ unlocked: false, enabled: true, paused: true, views: 2 });
    expect(() => f.summaries.regenerate(f.student)).toThrow('Plus');
    // Sharing less and turning it off still work.
    expect(f.summaries.setSections(f.student, { sections: { ...ALL, dueThisWeek: false } }).enabled).toBe(true);
    expect(f.summaries.disable(f.student).enabled).toBe(false);
    expect(() => f.summaries.enable(f.student)).toThrow('Plus');
    // With billing off, everyone in the beta has it.
    const free = fixture({ billing: false, plus: false });
    expect(free.summaries.enable(free.student).token).toMatch(SUMMARY_TOKEN);
  });

  it('treats a wrong, malformed or revoked token, an account outside the beta, and a suspended account alike', () => {
    const f = fixture();
    const { token } = f.summaries.enable(f.student);
    const wrong = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`;
    for (const bad of [wrong, '', 'short', `${token}x`, token.replace(/./, '.'), '../../etc/passwd']) expect(f.summaries.view(bad, visitor())).toEqual({ state: 'missing' });
    f.flags.inBeta = false;
    expect(f.summaries.view(token, visitor())).toEqual({ state: 'missing' });
    f.flags.inBeta = true;
    f.db.prepare('UPDATE users SET suspended_at=? WHERE id=?').run(NOW.toISOString(), f.student);
    expect(f.summaries.view(token, visitor())).toEqual({ state: 'missing' });
    // Only valid views are logged.
    expect(f.db.prepare('SELECT count(*) n FROM parent_summary_views').get()).toEqual({ n: 0 });
    expect(() => fixture({ inBeta: false }).summaries.enable(f.student)).toThrow();
  });

  it('rate-limits each visitor and each link', () => {
    const f = fixture();
    const { token } = f.summaries.enable(f.student);
    const one = visitor();
    for (let index = 0; index < VISITOR_LIMIT; index++) expect(f.summaries.view(index % 2 ? token : 'nope', one).state).not.toBe('limited');
    expect(f.summaries.view(token, one)).toEqual({ state: 'limited' });
    const logged = (f.db.prepare('SELECT count(*) n FROM parent_summary_views').get() as { n: number }).n;
    expect(logged).toBe(VISITOR_LIMIT / 2);
    for (let index = logged; index < LINK_HOURLY_LIMIT; index++) ok(f.summaries.view(token, visitor()));
    expect(f.summaries.view(token, visitor())).toEqual({ state: 'limited' });
    expect(f.summaries.status(f.student)).toMatchObject({ views: LINK_HOURLY_LIMIT });
  });

  it('takes the first word of the full name, then of the display name', () => {
    expect(firstName({ fullName: '  Ada Lovelace ', displayName: 'x' })).toBe('Ada');
    expect(firstName({ fullName: '', displayName: 'Grace H' })).toBe('Grace');
    expect(firstName({ fullName: '', displayName: '' })).toBe('Your student');
  });
});
