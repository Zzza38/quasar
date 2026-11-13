import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SCHOOLOGY_BETA } from '@/domain/schoology';
import { emptyPersonalSchedule } from '@/domain/schedule';
import { EMPTY_BETA_REGISTRY, createBeta, makeBetaPublic, writeBetaRegistry } from './beta-registry';
import { encrypt } from './calendar';
import { openDatabase, type Db } from './db';
import { writeEntity } from './entities';
import { appRouter } from './router';
import { GRADEBOOK_FORCE_MS, GRADEBOOK_FRESH_MS, SchoologyService, schoologyConfig, type GradebookCache, type SchoologyConfig, type SchoologyFetch } from './schoology';
import { Service } from './service';

/**
 * Classes → Grades on the server: one read of every class's gradebook, the memory-only cache in front of it, and the
 * member's saved goals (letter or custom percent), which only they can read or change and only for their own classes.
 */

const databases: Db[] = [];
afterEach(() => { for (const db of databases.splice(0)) if (db.open) db.close(); });
const SECRET = 'test-only-secret-that-is-at-least-32-characters';
const config: SchoologyConfig = { key: 'app-key', secret: 'app&secret', host: 'school.schoology.com' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

const section = (id: number, grade: number | null, assignments: unknown[]) => ({ section_id: id, period: [{ period_id: 'p1', assignment: assignments }],
  final_grade: grade === null ? [] : [{ period_id: 'p1', grade, weight: 100, grading_category: [{ category_id: 5, grade }] }, { period_id: 'final', grade }],
  grading_category: [{ id: 5, title: 'Tests', weight: 100 }] });
/** Two students on one Schoology: uid 4242 has Biology (11) and Art (22); uid 7 has Chemistry (33). */
const SCHOOL: Record<string, unknown> = {
  'users/4242/grades': { section: [
    section(11, 85, [{ assignment_id: 1, grade: 85, max_points: 100, exception: 0, category_id: 5 }, { assignment_id: 2, grade: null, max_points: 100, exception: 0, category_id: 5 }]),
    section(22, null, [{ assignment_id: 9, grade: null, max_points: 50, exception: 0, category_id: 5 }]),
  ] },
  'users/4242/sections': { section: [{ id: '11', course_title: 'Biology', section_title: 'Section 2' }, { id: '22', course_title: 'Studio Art', section_title: '' }] },
  'sections/11/assignments': { assignment: [{ id: 1, title: 'Unit 1 Test', due: '2026-10-20 23:59:00' }, { id: 2, title: 'Unit 2 Test', due: '2026-11-14 23:59:00' }] },
  'sections/22/assignments': { assignment: [{ id: 9, title: 'Portfolio check', due: '2026-11-16 23:59:00' }] },
  'users/7/grades': { section: [section(33, 91.5, [{ assignment_id: 5, grade: 183, max_points: 200, exception: 0, category_id: 5 }, { assignment_id: 6, grade: null, max_points: 100, exception: 0, category_id: 5 }])] },
  'users/7/sections': { section: [{ id: '33', course_title: 'Chemistry', section_title: '' }] },
  'sections/33/assignments': { assignment: [{ id: 5, title: 'Midterm', due: '2026-10-01 23:59:00' }, { id: 6, title: 'Final', due: '2026-12-15 23:59:00' }] },
};
const schoologyServer = (overrides: Record<string, () => Response> = {}): Mock<SchoologyFetch> => vi.fn<SchoologyFetch>(async (url) => {
  const path = new URL(url).pathname.replace('/v1/', '');
  return overrides[path]?.() ?? (path in SCHOOL ? json(SCHOOL[path]) : json({}, 404));
});
const calls = (fetcher: Mock<SchoologyFetch>, path: string) => fetcher.mock.calls.filter(([url]) => new URL(url).pathname === `/v1/${path}`).length;

function world(options: { fetcher?: Mock<SchoologyFetch>; outside?: string[] } = {}) {
  const db = openDatabase(':memory:'); databases.push(db);
  const service = new Service(db, 'owner@example.com');
  const clock = { at: new Date('2026-11-10T14:00:00Z') };
  const fetcher = options.fetcher ?? schoologyServer();
  const gradebooks: GradebookCache = { done: new Map(), reading: new Map() };
  const outside = new Set<string>();
  const schoology = new SchoologyService(service, { config, fetcher, secret: SECRET, inBeta: (id) => !outside.has(id), origin: 'https://quasar.example', now: () => clock.at, gradebooks });
  const member = (uid: string | null, name = 'Student') => {
    const id = randomUUID();
    db.prepare('INSERT INTO users(id,google_sub,email,display_name,full_name,created_at) VALUES(?,?,?,?,?,?)').run(id, id, `${id}@example.com`, name, `${name} Name`, new Date().toISOString());
    if (uid) db.prepare('INSERT INTO schoology_connections(user_id,token_encrypted,schoology_uid,name,connected_at) VALUES(?,?,?,?,?)')
      .run(id, encrypt(JSON.stringify({ token: `t-${uid}`, secret: `s-${uid}` }), SECRET), uid, name, clock.at.toISOString());
    return id;
  };
  const rows = () => db.prepare('SELECT user_id, section_id, goal, plan FROM schoology_grade_goals ORDER BY section_id').all() as { user_id: string; section_id: string; goal: string | null; plan: string | null }[];
  return { db, service, schoology, fetcher, clock, gradebooks, outside, member, rows };
}

describe('the gradebook read', () => {
  it('reads every class in one pass, with titles, due dates and the grade Schoology reports', async () => {
    const { schoology, member, fetcher } = world();
    const sam = member('4242', 'Sam');
    const book = await schoology.gradebook(sam);
    expect(book.name).toBe('Sam');
    expect(book.checkedAt).toBe('2026-11-10T14:00:00.000Z');
    expect(book.goals).toEqual({});
    expect(book.classes.map(entry => [entry.detail.sectionId, entry.detail.title, entry.grade, entry.detail.reported])).toEqual([['11', 'Biology: Section 2', '85%', 85], ['22', 'Studio Art', null, null]]);
    expect(book.classes[0].detail.items.map(item => [item.title, item.due, item.earned])).toEqual([['Unit 1 Test', '2026-10-20', 85], ['Unit 2 Test', '2026-11-14', null]]);
    // The whole gradebook comes from one grades read, not one per class.
    expect(calls(fetcher, 'users/4242/grades')).toBe(1);
    expect(calls(fetcher, 'sections/11/assignments')).toBe(1);
    expect(calls(fetcher, 'sections/22/assignments')).toBe(1);
  });

  it('matches each Schoology class to the member\'s own class, honouring a choice they made', async () => {
    const { db, schoology, member } = world();
    const sam = member('4242');
    writeEntity(db, sam, { id: 'personal', kind: 'personal', version: 1, deleted: false, data: { ...emptyPersonalSchedule(), classes: [{ id: 'bio', name: 'Biology' }, { id: 'art', name: 'Painting' }] } });
    expect((await schoology.gradebook(sam)).classes.map(entry => entry.classId)).toEqual(['bio', null]);
    db.prepare("INSERT INTO schoology_sections(user_id,section_id,course_title,section_title,class_id,chosen) VALUES(?,?,?,?,?,1)").run(sam, '22', 'Studio Art', '', 'art');
    expect((await schoology.gradebook(sam)).classes.map(entry => entry.classId)).toEqual(['bio', 'art']);
  });

  it('answers from memory for five minutes, lets Refresh reread after ten seconds, and never writes grades to the database', async () => {
    const { db, schoology, member, fetcher, clock } = world();
    const sam = member('4242');
    const tablesBefore = (db.prepare("SELECT count(*) n FROM sqlite_master WHERE type='table'").get() as { n: number }).n;
    await schoology.gradebook(sam);
    await schoology.gradebook(sam);
    expect(calls(fetcher, 'users/4242/grades')).toBe(1);
    // Refresh tapped again right away is answered from the same read.
    clock.at = new Date(clock.at.getTime() + GRADEBOOK_FORCE_MS - 1);
    await schoology.gradebook(sam, { force: true });
    expect(calls(fetcher, 'users/4242/grades')).toBe(1);
    clock.at = new Date(clock.at.getTime() + 1);
    expect((await schoology.gradebook(sam, { force: true })).checkedAt).toBe(clock.at.toISOString());
    expect(calls(fetcher, 'users/4242/grades')).toBe(2);
    clock.at = new Date(clock.at.getTime() + GRADEBOOK_FRESH_MS - 1);
    await schoology.gradebook(sam);
    expect(calls(fetcher, 'users/4242/grades')).toBe(2);
    clock.at = new Date(clock.at.getTime() + 1);
    await schoology.gradebook(sam);
    expect(calls(fetcher, 'users/4242/grades')).toBe(3);
    // Nothing about a grade reaches the database: no new table, and no stored text carries a score or title.
    expect((db.prepare("SELECT count(*) n FROM sqlite_master WHERE type='table'").get() as { n: number }).n).toBe(tablesBefore);
    expect(db.prepare('SELECT count(*) n FROM schoology_grade_goals').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT count(*) n FROM schoology_items').get()).toEqual({ n: 0 });
  });

  it('shares one read between two requests that arrive together', async () => {
    const { schoology, member, fetcher } = world();
    const sam = member('4242');
    const [a, b] = await Promise.all([schoology.gradebook(sam), schoology.gradebook(sam)]);
    expect(a.classes).toEqual(b.classes);
    expect(calls(fetcher, 'users/4242/grades')).toBe(1);
  });

  it('keeps each member\'s gradebook to themselves and forgets it on disconnect', async () => {
    const { schoology, member, gradebooks } = world();
    const sam = member('4242'), kim = member('7');
    expect((await schoology.gradebook(sam)).classes.map(entry => entry.detail.sectionId)).toEqual(['11', '22']);
    expect((await schoology.gradebook(kim)).classes.map(entry => entry.detail.sectionId)).toEqual(['33']);
    expect([...gradebooks.done.keys()].sort()).toEqual([sam, kim].sort());
    schoology.disconnect(sam);
    expect([...gradebooks.done.keys()]).toEqual([kim]);
    await expect(schoology.gradebook(sam)).rejects.toThrow('Connect Schoology first');
  });

  it('drops the connection and the cached gradebook when Schoology stops letting Quasar in', async () => {
    const fetcher = schoologyServer();
    const { schoology, member, clock, gradebooks, db } = world({ fetcher });
    const sam = member('4242');
    await schoology.gradebook(sam);
    fetcher.mockImplementation(async () => json({}, 401));
    clock.at = new Date(clock.at.getTime() + GRADEBOOK_FRESH_MS);
    await expect(schoology.gradebook(sam)).rejects.toThrow('Connect it again');
    expect(gradebooks.done.has(sam)).toBe(false);
    expect(db.prepare('SELECT count(*) n FROM schoology_connections').get()).toEqual({ n: 0 });
  });

  it('is closed to accounts outside the beta and to members who never connected', async () => {
    const { schoology, member, outside, fetcher } = world();
    const stranger = member('4242'), unconnected = member(null);
    outside.add(stranger);
    await expect(schoology.gradebook(stranger)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(schoology.setGoal(stranger, { sectionId: '11', goal: { kind: 'letter', letter: 'A' } })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(schoology.gradebook(unconnected)).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'Connect Schoology first.' });
    await expect(schoology.setGoal(unconnected, { sectionId: '11', goal: { kind: 'letter', letter: 'A' } })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('saved grade goals', () => {
  it('gives a member from before goals existed an empty set, not an error', async () => {
    const { schoology, member, rows } = world();
    const sam = member('4242');
    expect((await schoology.gradebook(sam)).goals).toEqual({});
    expect(rows()).toEqual([]);
  });

  it('saves a letter or a custom percent with decimals, per member and class, and reads it back', async () => {
    const { schoology, member, rows } = world();
    const sam = member('4242');
    expect(await schoology.setGoal(sam, { sectionId: '11', goal: { kind: 'percent', percent: 94.5 } })).toEqual({ sectionId: '11', goal: { kind: 'percent', percent: 94.5 }, plan: null });
    expect((await schoology.gradebook(sam)).goals).toEqual({ '11': { goal: { kind: 'percent', percent: 94.5 }, plan: null } });
    await schoology.setGoal(sam, { sectionId: '22', goal: { kind: 'letter', letter: 'B+' } });
    await schoology.setGoal(sam, { sectionId: '11', goal: { kind: 'percent', percent: 89.999 } });
    expect((await schoology.gradebook(sam)).goals).toEqual({ '11': { goal: { kind: 'percent', percent: 90 }, plan: null }, '22': { goal: { kind: 'letter', letter: 'B+' }, plan: null } });
    for (const percent of [0, 100, 0.01, 99.99]) expect((await schoology.setGoal(sam, { sectionId: '11', goal: { kind: 'percent', percent } })).goal).toEqual({ kind: 'percent', percent });
    expect(rows().map(row => [row.user_id, row.section_id])).toEqual([[sam, '11'], [sam, '22']]);
  });

  it('refuses a goal outside 0 to 100, an unknown letter, and anything that isn\'t a goal', async () => {
    const { schoology, member, rows } = world();
    const sam = member('4242');
    for (const goal of [{ kind: 'percent', percent: 100.01 }, { kind: 'percent', percent: -1 }, { kind: 'percent', percent: Number.NaN }, { kind: 'percent', percent: '94.5' }, { kind: 'letter', letter: 'A+' }, { kind: 'letter' }, 'A', 94.5]) {
      await expect(schoology.setGoal(sam, { sectionId: '11', goal: goal as never }), JSON.stringify(goal)).rejects.toThrow();
    }
    await expect(schoology.setGoal(sam, { sectionId: '11; DROP TABLE users', goal: { kind: 'letter', letter: 'A' } })).rejects.toThrow();
    expect(rows()).toEqual([]);
  });

  it('only takes goals for classes in the member\'s own Schoology grades', async () => {
    const { schoology, member, rows } = world();
    const sam = member('4242'), kim = member('7');
    // Chemistry (33) is Kim's class, not Sam's; 99 is nobody's.
    await expect(schoology.setGoal(sam, { sectionId: '33', goal: { kind: 'letter', letter: 'A' } })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(schoology.setGoal(sam, { sectionId: '99', goal: { kind: 'letter', letter: 'A' } })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await schoology.setGoal(kim, { sectionId: '33', goal: { kind: 'percent', percent: 92.25 } });
    await schoology.setGoal(sam, { sectionId: '11', goal: { kind: 'letter', letter: 'A-' } });
    // Each member sees only their own goals.
    expect((await schoology.gradebook(sam)).goals).toEqual({ '11': { goal: { kind: 'letter', letter: 'A-' }, plan: null } });
    expect((await schoology.gradebook(kim)).goals).toEqual({ '33': { goal: { kind: 'percent', percent: 92.25 }, plan: null } });
    expect(rows().map(row => [row.user_id, row.section_id])).toEqual([[sam, '11'], [kim, '33']]);
  });

  it('saves what the plan leans on, checked against the class, and keeps it when only the goal changes', async () => {
    const { schoology, member } = world();
    const sam = member('4242');
    await schoology.setGoal(sam, { sectionId: '11', goal: { kind: 'letter', letter: 'A' }, plan: { kind: 'item', id: '2' } });
    expect(await schoology.setGoal(sam, { sectionId: '11', goal: { kind: 'percent', percent: 94.5 } })).toEqual({ sectionId: '11', goal: { kind: 'percent', percent: 94.5 }, plan: { kind: 'item', id: '2' } });
    // An assignment from another class, or a category this class doesn't have, is refused.
    await expect(schoology.setGoal(sam, { sectionId: '11', goal: { kind: 'letter', letter: 'A' }, plan: { kind: 'item', id: '9' } })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(schoology.setGoal(sam, { sectionId: '11', goal: { kind: 'letter', letter: 'A' }, plan: { kind: 'extra', categoryId: '77', max: 100 } })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect((await schoology.setGoal(sam, { sectionId: '11', goal: { kind: 'letter', letter: 'A' }, plan: { kind: 'extra', categoryId: '5', max: 50 } })).plan).toEqual({ kind: 'extra', categoryId: '5', max: 50 });
    expect((await schoology.setGoal(sam, { sectionId: '11', goal: { kind: 'letter', letter: 'A' }, plan: { kind: 'newExam', weight: 20 } })).plan).toEqual({ kind: 'newExam', weight: 20 });
    // A plan can be saved before any goal is, and clearing both removes the row.
    expect(await schoology.setGoal(sam, { sectionId: '22', goal: null, plan: { kind: 'item', id: '9' } })).toEqual({ sectionId: '22', goal: null, plan: { kind: 'item', id: '9' } });
    await schoology.setGoal(sam, { sectionId: '22', goal: null, plan: null });
    expect(Object.keys((await schoology.gradebook(sam)).goals)).toEqual(['11']);
  });

  it('clears a goal, keeps goals through a disconnect, and ties them to the account', async () => {
    const { db, schoology, member, rows } = world();
    const sam = member('4242');
    await schoology.setGoal(sam, { sectionId: '11', goal: { kind: 'percent', percent: 94.5 } });
    await schoology.setGoal(sam, { sectionId: '22', goal: { kind: 'letter', letter: 'B' } });
    expect(await schoology.setGoal(sam, { sectionId: '22', goal: null })).toEqual({ sectionId: '22', goal: null, plan: null });
    expect(rows().map(row => row.section_id)).toEqual(['11']);
    schoology.disconnect(sam);
    expect(rows().map(row => row.section_id)).toEqual(['11']);
    // Reconnecting brings the goal back, and the rows go with the account when it is deleted.
    expect(db.pragma('foreign_key_list(schoology_grade_goals)')).toMatchObject([{ table: 'users', from: 'user_id', to: 'id', on_delete: 'CASCADE' }]);
  });

  it('ignores a stored row that no longer reads as a goal instead of failing the page', async () => {
    const { db, schoology, member } = world();
    const sam = member('4242');
    const insert = db.prepare('INSERT INTO schoology_grade_goals(user_id,section_id,goal,plan,updated_at) VALUES(?,?,?,?,?)');
    insert.run(sam, '11', '{"kind":"percent","percent":140}', null, 'x');
    insert.run(sam, '22', 'not json', '{"kind":"item","id":"9"}', 'x');
    expect((await schoology.gradebook(sam)).goals).toEqual({ '22': { goal: null, plan: { kind: 'item', id: '9' } } });
  });
});

describe('through the API, behind the schoology-connect beta', () => {
  let directory = '', previous: string | undefined;
  beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'quasar-grades-')); previous = process.env.BETAS_PATH; process.env.BETAS_PATH = join(directory, 'betas.json'); });
  afterEach(() => { rmSync(directory, { recursive: true, force: true }); if (previous === undefined) delete process.env.BETAS_PATH; else process.env.BETAS_PATH = previous; });

  it('lets members in, keeps everyone else out, and binds every call to the signed-in account', async () => {
    const { service, member } = world();
    const early = member(null), late = member(null), stranger = member(null);
    const caller = (userId: string | null) => appRouter.createCaller({ service, userId, authAt: Date.now() });
    // A private beta with one member, then made public the way `npm run beta -- public` does it.
    const registry = createBeta(EMPTY_BETA_REGISTRY, { key: SCHOOLOGY_BETA, name: 'Schoology', code: 'SGY-TEST' });
    writeBetaRegistry(registry);
    await caller(early).beta.join({ accountId: early, code: 'SGY-TEST' });
    expect((await caller(late).beta.available()).map(beta => beta.key)).toEqual([]);
    writeBetaRegistry(makeBetaPublic(registry, SCHOOLOGY_BETA));
    // The earlier member is still in; a new one joins from the public list with no code.
    expect(service.workspace(early).betas.map(beta => beta.key)).toEqual([SCHOOLOGY_BETA]);
    expect((await caller(late).beta.available()).map(beta => beta.key)).toEqual([SCHOOLOGY_BETA]);
    await caller(late).beta.enroll({ accountId: late, key: SCHOOLOGY_BETA });

    const goal = { sectionId: '11', goal: { kind: 'percent' as const, percent: 94.5 } };
    // Members get past the gate and are told to connect; nobody else gets that far.
    for (const id of [early, late]) {
      await expect(caller(id).schoology.gradebook({ accountId: id })).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'Connect Schoology first.' });
      await expect(caller(id).schoology.setGoal({ accountId: id, ...goal })).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'Connect Schoology first.' });
      expect(await caller(id).schoology.status()).toMatchObject({ beta: true, connected: null });
    }
    await expect(caller(stranger).schoology.gradebook({ accountId: stranger })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(caller(stranger).schoology.setGoal({ accountId: stranger, ...goal })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await caller(stranger).schoology.status()).toEqual({ beta: false });
    // Another account's id, or no session at all.
    await expect(caller(early).schoology.gradebook({ accountId: late })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(caller(early).schoology.setGoal({ accountId: late, ...goal })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(caller(null).schoology.gradebook({ accountId: early })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(caller(null).schoology.setGoal({ accountId: early, ...goal })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    // Bad input is refused at the door.
    await expect(caller(early).schoology.setGoal({ accountId: early, sectionId: '11', goal: { kind: 'percent', percent: 101 } })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(caller(early).schoology.setGoal({ accountId: early, sectionId: 'eleven', goal: { kind: 'letter', letter: 'A' } })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
});

describe('SCHOOLOGY_API_URL', () => {
  it('is honoured only for HTTPS or this machine\'s loopback', () => {
    const base = { SCHOOLOGY_CONSUMER_KEY: 'k', SCHOOLOGY_CONSUMER_SECRET: 's' };
    expect(schoologyConfig(base)).toEqual({ key: 'k', secret: 's', host: 'app.schoology.com' });
    expect(schoologyConfig({ ...base, SCHOOLOGY_API_URL: 'http://127.0.0.1:3197/v1/' })?.api).toBe('http://127.0.0.1:3197/v1');
    expect(schoologyConfig({ ...base, SCHOOLOGY_API_URL: 'https://api.example.com/v1' })?.api).toBe('https://api.example.com/v1');
    for (const unsafe of ['http://api.example.com/v1', 'http://127.0.0.1.evil.example/v1', 'ftp://127.0.0.1/v1', 'javascript:alert(1)', '']) {
      expect(schoologyConfig({ ...base, SCHOOLOGY_API_URL: unsafe })?.api, unsafe).toBeUndefined();
    }
  });
});
