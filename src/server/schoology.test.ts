import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import { randomUUID } from 'node:crypto';
import { openDatabase, type Db } from './db';
import { Service } from './service';
import { readEntity, writeEntity } from './entities';
import { emptyPersonalSchedule } from '@/domain/schedule';
import { SchoologyService, SCHOOLOGY_MEMBER_DEADLINE_MS, schoologyAuthorization, schoologyConfig, summarizeGrades, type SchoologyConfig, type SchoologyFetch } from './schoology';

const databases: Db[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); vi.useRealTimers(); });
const SECRET = 'test-only-secret-that-is-at-least-32-characters';
const config: SchoologyConfig = { key: 'app-key', secret: 'app&secret', host: 'school.schoology.com' };
const form = (body: string) => new Response(body, { status: 200 });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

const grades = { section: [
  { section_id: '11', final_grade: [{ period_id: 'p1', grade: 88 }, { period_id: 'p2', grade: '93.456' }], period: [{ assignment: [{ grade: 9 }, { grade: null }, { grade: 'A' }] }] },
  { section_id: '22', final_grade: [], period: [] },
] };
const sections = { section: [{ id: '11', course_title: 'Biology', section_title: 'Section 2' }, { id: '22', course_title: 'Art', section_title: '' }] };

function schoologyServer(overrides: Partial<Record<string, (url: string) => Response>> = {}): Mock<SchoologyFetch> {
  return vi.fn<SchoologyFetch>(async (url) => {
    const path = new URL(url).pathname.replace('/v1/', '');
    const route = overrides[path];
    if (route) return route(url);
    if (path === 'oauth/request_token') return form('oauth_token=req-token&oauth_token_secret=req-secret&xoauth_token_ttl=3600');
    if (path === 'oauth/access_token') return form('oauth_token=acc-token&oauth_token_secret=acc-secret');
    if (path === 'users/me') return new Response(null, { status: 303, headers: { location: 'https://api.schoology.com/v1/users/4242' } });
    if (path === 'users/4242') return json({ uid: 4242, name_display: 'Sam Student' });
    if (path === 'users/4242/grades') return json(grades);
    if (path === 'users/4242/sections') return json(sections);
    return json({}, 404);
  });
}

function fixture(options: { inBeta?: boolean; fetcher?: Mock<SchoologyFetch>; config?: SchoologyConfig | null; now?: () => Date } = {}) {
  const db = openDatabase(':memory:'); databases.push(db);
  const service = new Service(db, 'owner@example.com');
  const id = randomUUID();
  db.prepare('INSERT INTO users(id,google_sub,email,display_name,full_name,created_at) VALUES(?,?,?,?,?,?)').run(id, id, `${id}@example.com`, 'Student', 'Student Name', new Date().toISOString());
  const fetcher = options.fetcher ?? schoologyServer();
  const schoology = new SchoologyService(service, { config: options.config === undefined ? config : options.config, fetcher, secret: SECRET, inBeta: () => options.inBeta ?? true, origin: 'https://quasar.example', now: options.now });
  return { db, student: id, schoology, fetcher };
}
const header = (fetcher: Mock<SchoologyFetch>, path: string) => {
  const call = fetcher.mock.calls.find(([url]) => url.endsWith(path))!;
  return String((call[1].headers as Record<string, string>).Authorization);
};

describe('Connect Schoology', () => {
  it('reports the current connection only for its workspace account', async () => {
    const f = fixture();
    const other = fixture();
    const service = new Service(f.db, 'owner@example.com');
    expect(service.workspace(f.student).schoologyConnected).toBe(false);
    await f.schoology.start(f.student);
    await f.schoology.finish(f.student, { oauthToken: 'req-token' });
    expect(service.workspace(f.student).schoologyConnected).toBe(true);
    expect(new Service(other.db, 'owner@example.com').workspace(other.student).schoologyConnected).toBe(false);
    f.schoology.disconnect(f.student);
    expect(service.workspace(f.student).schoologyConnected).toBe(false);
  });

  it('follows a relative redirect on the configured API origin with a fresh signature', async () => {
    const fetcher = schoologyServer({ 'users/me': () => new Response(null, { status: 303, headers: { location: '/v1/users/4242' } }) });
    const f = fixture({ fetcher, config: { ...config, api: 'https://schoology-proxy.example/v1' } });
    await f.schoology.start(f.student);
    await f.schoology.finish(f.student, { oauthToken: 'req-token' });
    expect(fetcher.mock.calls.every(([url]) => new URL(url).origin === 'https://schoology-proxy.example')).toBe(true);
    expect(header(fetcher, '/users/me')).not.toBe(header(fetcher, '/users/4242'));
    expect(header(fetcher, '/users/4242')).toContain('oauth_token="acc-token"');
  });

  it.each(['https://evil.example/v1/users/4242', 'http://api.schoology.com/v1/users/4242', '//evil.example/users/4242'])(
    'rejects credential-bearing redirects to %s', async location => {
      const fetcher = schoologyServer({ 'users/me': () => new Response(null, { status: 303, headers: { location } }) });
      const f = fixture({ fetcher });
      await f.schoology.start(f.student);
      await expect(f.schoology.finish(f.student, { oauthToken: 'req-token' })).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
      expect(fetcher.mock.calls.every(([url]) => new URL(url).origin === 'https://api.schoology.com')).toBe(true);
    });

  it('reads its settings and signs requests with PLAINTEXT', () => {
    expect(schoologyConfig({})).toBeNull();
    expect(schoologyConfig({ SCHOOLOGY_CONSUMER_KEY: 'k', SCHOOLOGY_CONSUMER_SECRET: 's' })).toEqual({ key: 'k', secret: 's', host: 'app.schoology.com' });
    expect(schoologyConfig({ SCHOOLOGY_CONSUMER_KEY: 'k', SCHOOLOGY_CONSUMER_SECRET: 's', SCHOOLOGY_HOST: 'https://fa.schoology.com/' })?.host).toBe('fa.schoology.com');
    const value = schoologyAuthorization(config, { token: 't', secret: 'x y' });
    expect(value).toMatch(/^OAuth realm="Schoology API", oauth_consumer_key="app-key", /);
    expect(value).toContain('oauth_token="t"');
    // The signature is consumer secret & token secret, each escaped, then escaped again as a header value.
    expect(value).toContain(`oauth_signature="${encodeURIComponent('app%26secret&x%20y')}"`);
    expect(schoologyAuthorization(config, null)).toContain('oauth_token=""');
  });

  it('connects through the approval page and returns a grade summary', async () => {
    const { db, student, schoology, fetcher } = fixture();
    const { url } = await schoology.start(student);
    const approval = new URL(url);
    expect(approval.origin).toBe('https://school.schoology.com');
    expect(approval.pathname).toBe('/oauth/authorize');
    expect(approval.searchParams.get('oauth_token')).toBe('req-token');
    expect(approval.searchParams.has('oauth_callback')).toBe(false);
    expect(approval.searchParams.get('return_url')).toBe('quasar.example/classes?schoology=return');
    expect(JSON.stringify(db.prepare('SELECT * FROM schoology_oauth_states').all())).not.toContain('req-secret');

    const result = await schoology.finish(student, { oauthToken: 'req-token' });
    expect(header(fetcher, 'oauth/access_token')).toContain('oauth_token="req-token"');
    expect(header(fetcher, 'oauth/access_token')).toContain(encodeURIComponent('app%26secret&req-secret'));
    expect(header(fetcher, 'users/4242/grades')).toContain('oauth_token="acc-token"');
    expect(result).toEqual({ name: 'Sam Student', classes: [
      { sectionId: '22', title: 'Art', grade: null, graded: 0 },
      { sectionId: '11', title: 'Biology: Section 2', grade: '93.5%', graded: 2 },
    ] });
    expect(schoology.status(student)).toMatchObject({ beta: true, available: true, connected: { name: 'Sam Student' } });
    const stored = JSON.stringify(db.prepare('SELECT * FROM schoology_connections').all());
    expect(stored).not.toContain('acc-secret');
    expect(stored).not.toContain('acc-token');
    expect(db.prepare('SELECT count(*) n FROM schoology_oauth_states').get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT count(*) n FROM audit_log WHERE action='schoology.connect'").get()).toEqual({ n: 1 });
  });

  it('refuses a token it did not start, or one that sat too long', async () => {
    const { student, schoology } = fixture();
    await schoology.start(student);
    await expect(schoology.finish(student, { oauthToken: 'someone-else' })).rejects.toThrow('expired');
    // Nothing started at all.
    await expect(schoology.finish(student, {})).rejects.toThrow('expired');
    // The failed try used up the handshake, so the right token no longer works either.
    await expect(schoology.finish(student, { oauthToken: 'req-token' })).rejects.toThrow('expired');
    vi.useFakeTimers({ toFake: ['Date'] });
    await schoology.start(student);
    vi.setSystemTime(Date.now() + 16 * 60_000);
    await expect(schoology.finish(student, { oauthToken: 'req-token' })).rejects.toThrow('expired');
  });

  it('finishes from the started handshake when Schoology sends no token back', async () => {
    const { student, schoology, fetcher } = fixture();
    await schoology.start(student);
    await expect(schoology.finish(student, {})).resolves.toMatchObject({ name: 'Sam Student' });
    expect(header(fetcher, 'oauth/access_token')).toContain('oauth_token="req-token"');
  });

  it('offers recovery only for the account with an unexpired pending connection', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { db, student, schoology } = fixture();
    const other = randomUUID();
    db.prepare('INSERT INTO users(id,google_sub,email,display_name,full_name,created_at) VALUES(?,?,?,?,?,?)')
      .run(other, other, `${other}@example.com`, 'Other', 'Other Student', new Date().toISOString());
    expect(schoology.status(student)).toMatchObject({ pendingConnection: false });
    await schoology.start(student);
    expect(schoology.status(student)).toMatchObject({ pendingConnection: true });
    expect(schoology.status(other)).toMatchObject({ pendingConnection: false });
    expect(JSON.stringify(schoology.status(student))).not.toContain('req-token');
    vi.setSystemTime(Date.now() + 16 * 60_000);
    expect(schoology.status(student)).toMatchObject({ pendingConnection: false });
    await expect(schoology.finish(student, {})).rejects.toThrow('expired');
  });

  it.each([401, 503])('can finish the same connection after Schoology initially returns %i', async (status) => {
    let approved = false;
    const fetcher = schoologyServer({
      'oauth/access_token': () => approved
        ? form('oauth_token=acc-token&oauth_token_secret=acc-secret')
        : new Response('', { status }),
    });
    const { student, schoology } = fixture({ fetcher });
    await schoology.start(student);
    await expect(schoology.finish(student, {})).rejects.toThrow('try Finish connecting again');
    expect(schoology.status(student)).toMatchObject({ pendingConnection: true, connected: null });
    approved = true;
    await expect(schoology.finish(student, {})).resolves.toMatchObject({ name: 'Sam Student' });
    expect(schoology.status(student)).toMatchObject({ pendingConnection: false, connected: { name: 'Sam Student' } });
  });

  it('names graded sections missing from the section list, without disconnecting on a refused lookup', async () => {
    const withSiblings = { section: [...grades.section,
      { section_id: '33', final_grade: [{ grade: 100 }], period: [] },
      { section_id: '44', final_grade: [{ grade: 90 }], period: [] }] };
    const fetcher = schoologyServer({
      'users/4242/grades': () => json(withSiblings),
      'sections/33': () => json({ id: '33', course_title: 'Foundations of Wellness', section_title: 'Foundations of Wellness' }),
      'sections/44': () => json({}, 403),
    });
    const { student, schoology } = fixture({ fetcher });
    await schoology.start(student);
    const result = await schoology.finish(student, { oauthToken: 'req-token' });
    expect(result.classes.map(entry => entry.title)).toEqual(['Art', 'Biology: Section 2', 'Foundations of Wellness', 'Untitled class']);
    expect(schoology.status(student)).toMatchObject({ connected: { name: 'Sam Student' } });
  });

  it('keeps a valid connection and syncs assignments when the grades endpoint denies permission', async () => {
    const fetcher = schoologyServer({
      'users/4242/grades': () => json({}, 403),
      'sections/11/assignments': () => json({ assignment: [{ id: 876, title: 'Permission-safe assignment', due: '2026-11-11 08:00:00' }] }),
    });
    const { student, schoology, db } = fixture({ fetcher, now: () => new Date('2026-11-10T12:00:00Z') });
    await schoology.start(student);
    await expect(schoology.finish(student, { oauthToken: 'req-token' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(schoology.grades(student)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(schoology.status(student)).toMatchObject({ connected: { name: 'Sam Student' } });
    await schoology.sync(student);
    expect(readEntity(db, student, 'sgy_876')?.data.title).toBe('Permission-safe assignment');
    expect(schoology.status(student)).toMatchObject({ connected: { name: 'Sam Student' } });
  });

  it.each(['stop', 'deadline'] as const)('aborts active sync network work on %s', async reason => {
    const f = fixture();
    await f.schoology.start(f.student);
    await f.schoology.finish(f.student, { oauthToken: 'req-token' });
    const second = randomUUID();
    f.db.prepare('INSERT INTO users(id,google_sub,email,display_name,created_at) VALUES(?,?,?,?,?)').run(second, second, `${second}@example.com`, 'Second', new Date().toISOString());
    f.db.prepare(`INSERT INTO schoology_connections(user_id,token_encrypted,schoology_uid,name,connected_at,synced_at,import_assignments,auto_complete) SELECT ?, token_encrypted, schoology_uid, name, connected_at, synced_at, import_assignments, auto_complete FROM schoology_connections WHERE user_id=?`).run(second, f.student);
    const stop = new AbortController(), deadline = new AbortController();
    const originalTimeout = AbortSignal.timeout;
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => ms === SCHOOLOGY_MEMBER_DEADLINE_MS ? deadline.signal : originalTimeout(ms));
    let active = 0, aborted = 0;
    const requested: string[] = [];
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    f.fetcher.mockImplementation(async (url, init) => {
      requested.push(url);
      active++;
      started();
      return new Promise<Response>((_, reject) => init.signal!.addEventListener('abort', () => {
        active--; aborted++; reject(init.signal!.reason);
      }, { once: true }));
    });
    try {
      const pass = reason === 'stop' ? f.schoology.tagAll(stop.signal) : f.schoology.sync(f.student);
      const settled = reason === 'stop' ? pass : expect(pass).rejects.toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
      await ready;
      if (reason === 'stop') stop.abort();
      else deadline.abort();
      await settled;
      expect(active).toBe(0);
      expect(aborted).toBe(2);
      expect(requested).toHaveLength(2);
      expect(f.db.prepare('SELECT COUNT(*) AS count FROM schoology_connections WHERE synced_at IS NOT NULL').get()).toEqual({ count: 1 });
    } finally { timeout.mockRestore(); }
  });

  it('drops the connection when Schoology revokes it', async () => {
    let revoked = false;
    const fetcher = schoologyServer({ 'users/4242/grades': () => revoked ? json({}, 401) : json(grades) });
    const { student, schoology } = fixture({ fetcher });
    await schoology.start(student);
    await schoology.finish(student, { oauthToken: 'req-token' });
    revoked = true;
    await expect(schoology.grades(student)).rejects.toThrow('Connect it again');
    expect(schoology.status(student)).toMatchObject({ connected: null });
  });

  it('stays closed outside the beta and without a key', async () => {
    const outside = fixture({ inBeta: false });
    expect(outside.schoology.status(outside.student)).toEqual({ beta: false });
    await expect(outside.schoology.start(outside.student)).rejects.toThrow('beta');
    const unset = fixture({ config: null });
    expect(unset.schoology.status(unset.student)).toMatchObject({ available: false });
    await expect(unset.schoology.start(unset.student)).rejects.toThrow('not set up');
  });

  it('summarizes letter grades and odd responses without crashing', () => {
    expect(summarizeGrades({ section: [{ section_id: 1, final_grade: [{ grade: 'B+' }] }] }, {})).toEqual([{ sectionId: '1', title: 'Untitled class', grade: 'B+', graded: 0 }]);
    expect(summarizeGrades(null, null)).toEqual([]);
  });
});

describe('class tags for imported Schoology tasks', () => {
  const API = 'https://api.schoology.com/v1';
  const bio = '11111111-1111-4111-8111-111111111111', spanish = '22222222-2222-4222-8222-222222222222';
  // Biology (section 11) has an event for assignment 501 and a second page of assignments; Art (22) matches no class;
  // section 33 is a graded sibling that refuses every request.
  const routes = {
    'users/4242/grades': () => json({ section: [...grades.section, { section_id: '33', final_grade: [], period: [] }] }),
    'sections/33': () => json({}, 403),
    'sections/33/events': () => json({}, 403),
    'sections/33/assignments': () => json({}, 403),
    'sections/11/events': () => json({ event: [{ id: 901, assignment_id: 501 }] }),
    'sections/11/assignments': (url: string) => url.includes('start=200')
      ? json({ assignment: [{ id: 503 }] })
      : json({ assignment: [{ id: 502 }], links: { next: `${API}/sections/11/assignments?start=200&limit=200` } }),
    'sections/22/events': () => json({ event: [{ id: 902 }] }),
    'sections/22/assignments': () => json({ assignment: [] }),
  };
  const imported = (url: string | null) => ({ subscriptionId: 'feed', uid: 'calendar-event-1@schoology.com', recurrenceId: null, startDate: '2026-11-02', startTime: null, endDate: null, endTime: null, timeZone: 'America/New_York', allDay: true, sourceRemoved: false, sourceUpdatedAt: '2026-10-30T12:00:00.000Z', url });
  const task = (title: string, notes: string, url: string | null, classId: string | null = null) =>
    ({ title, dueDate: '2026-11-02', dueTime: null, classId, notes, completed: false, imported: imported(url) });

  async function connected(now = { at: new Date('2026-10-30T12:00:00Z') }) {
    const fetcher = schoologyServer(routes);
    const setup = fixture({ fetcher, now: () => now.at });
    const { db, student, schoology } = setup;
    const personal = { ...emptyPersonalSchedule(), classes: [{ id: bio, name: 'Biology' }, { id: spanish, name: 'Spanish 3' }] };
    writeEntity(db, student, { id: 'personal', kind: 'personal', version: 1, data: personal, deleted: false });
    const tasks = {
      viaNotes: task('Lab report', 'Bring goggles\n - Link: http://fa.schoology.com/assignment/501', null),
      viaUrl: task('Quiz', '', 'https://fa.schoology.com/event/901'),
      secondPage: task('Worksheet', '', 'https://fa.schoology.com/assignment/503'),
      art: task('Sketch', '', 'https://fa.schoology.com/event/902'),
      hasClass: task('Vocab', '', 'https://fa.schoology.com/assignment/501', spanish),
      notSchoology: task('Dentist', '', 'https://calendar.example/e/1'),
      unknown: task('Mystery', '', 'https://fa.schoology.com/assignment/999'),
    };
    for (const [id, data] of Object.entries(tasks)) writeEntity(db, student, { id, kind: 'task', version: 1, data, deleted: false });
    await schoology.start(student);
    await schoology.finish(student, { oauthToken: 'req-token' });
    fetcher.mockClear();
    return { ...setup, fetcher, now };
  }
  const classOf = (db: Db, student: string, id: string) => readEntity(db, student, id)!.data.classId;

  it('puts the class on untagged imports from their Schoology section, and nothing else', async () => {
    const { db, student, schoology } = await connected();
    expect(await schoology.tagClasses(student)).toEqual({ tagged: 3 });
    expect([classOf(db, student, 'viaNotes'), classOf(db, student, 'viaUrl'), classOf(db, student, 'secondPage')]).toEqual([bio, bio, bio]);
    expect(readEntity(db, student, 'viaNotes')!.version).toBe(2);
    expect(classOf(db, student, 'art')).toBeNull();
    expect(classOf(db, student, 'hasClass')).toBe(spanish);
    expect(readEntity(db, student, 'hasClass')!.version).toBe(1);
    expect(classOf(db, student, 'notSchoology')).toBeNull();
    expect(classOf(db, student, 'unknown')).toBeNull();
    // The section that refused didn't cost the member their connection.
    expect(schoology.status(student)).toMatchObject({ connected: { name: 'Sam Student' } });
  });

  it('rebuilds the index only every half hour while an assignment is still unknown', async () => {
    const { student, schoology, fetcher, now } = await connected();
    await schoology.tagClasses(student);
    const first = fetcher.mock.calls.length;
    expect(first).toBeGreaterThan(0);
    await schoology.tagClasses(student);
    expect(fetcher.mock.calls.length).toBe(first);
    now.at = new Date(now.at.getTime() + 31 * 60_000);
    await schoology.tagClasses(student);
    expect(fetcher.mock.calls.length).toBeGreaterThan(first);
  });

  it('moves the tasks it tagged when the student fixes a section, and leaves their own edits alone', async () => {
    const { db, student, schoology } = await connected();
    await schoology.tagClasses(student);
    const listed = schoology.sections(student).sections;
    expect(listed.find(section => section.sectionId === '11')).toMatchObject({ classId: bio, auto: bio, chosen: false });
    expect(listed.find(section => section.sectionId === '22')).toMatchObject({ classId: null, auto: null });

    // Art's tasks go to Spanish 3 when the student says so.
    schoology.setSectionClass(student, { sectionId: '22', classId: spanish });
    expect(classOf(db, student, 'art')).toBe(spanish);

    // The student moved the quiz by hand; turning Biology's tagging off clears the others but not that one.
    const quiz = readEntity(db, student, 'viaUrl')!;
    writeEntity(db, student, { ...quiz, version: quiz.version + 1, data: { ...quiz.data, classId: spanish } });
    schoology.setSectionClass(student, { sectionId: '11', classId: null });
    expect([classOf(db, student, 'viaNotes'), classOf(db, student, 'viaUrl'), classOf(db, student, 'secondPage')]).toEqual([null, spanish, null]);
    expect(await schoology.tagClasses(student)).toEqual({ tagged: 0 });

    // Back to matching by name tags them again.
    schoology.setSectionClass(student, { sectionId: '11', classId: 'auto' });
    expect([classOf(db, student, 'viaNotes'), classOf(db, student, 'secondPage')]).toEqual([bio, bio]);
    expect(() => schoology.setSectionClass(student, { sectionId: '11', classId: 'gone' })).toThrow('removed');
  });

  it('does nothing outside the beta or without a connection', async () => {
    const outside = fixture({ inBeta: false });
    expect(await outside.schoology.tagClasses(outside.student)).toEqual({ tagged: 0 });
    expect(outside.fetcher).not.toHaveBeenCalled();
    const { student, schoology, fetcher } = await connected();
    schoology.disconnect(student);
    expect(await schoology.tagClasses(student)).toEqual({ tagged: 0 });
    expect(fetcher).not.toHaveBeenCalled();
    expect(await schoology.tagAll()).toEqual({ failed: 0 });
  });
});

describe('assignments straight from Schoology', () => {
  const bio = '11111111-1111-4111-8111-111111111111';
  const assignment = (id: number, title: string, due: string, extra: Record<string, unknown> = {}) =>
    ({ id, title, due, description: '', web_url: `https://fa.schoology.com/assignment/${id}`, published: '1', allow_dropbox: '1', grade_item_id: 7000 + id, last_updated: String(Date.parse('2026-10-28T12:00:00Z') / 1000), ...extra });
  let biologyAssignments: Record<string, unknown>[] = [];
  const routes = {
    'users/4242/grades': () => json({ section: [{ section_id: '11', final_grade: [], period: [{ assignment: [{ assignment_id: 604, grade: 9 }] }] }] }),
    'users/4242/sections': () => json({ section: [{ id: '11', course_title: 'Biology', section_title: '' }] }),
    'sections/11/assignments': () => json({ assignment: biologyAssignments }),
    'sections/11/events': () => json({ event: [] }),
    'sections/11/submissions/7605/4242': () => json({ revision: [{ draft: 0 }] }),
    'sections/11/submissions/7601/4242': () => json({ revision: [{ draft: 1 }] }),
  };
  const feedTask = (title: string, url: string, dueDate = '2026-11-02') => ({ title, dueDate, dueTime: null, classId: null, notes: '', completed: false,
    imported: { subscriptionId: 'feed', uid: `${title}@schoology.com`, recurrenceId: null, startDate: dueDate, startTime: null, endDate: null, endTime: null, timeZone: 'America/New_York', allDay: true, sourceRemoved: false, sourceUpdatedAt: '2026-10-30T12:00:00.000Z', url } });

  async function setup() {
    biologyAssignments = [
      assignment(601, 'Lab report', '2026-10-31 23:59:00'),
      assignment(602, 'Reading log', ''),
      assignment(607, 'September undated', '', { last_updated: String(Date.parse('2026-09-20T12:00:00Z') / 1000) }),
      assignment(603, 'Old essay', '2026-09-01 08:00:00'),
      assignment(604, 'Graded quiz', '2026-10-25 08:00:00'),
      assignment(605, 'Worksheet', '2026-10-28 00:00:00'),
      assignment(501, 'From the feed', '2026-11-02 08:00:00'),
      assignment(606, 'quiz ', '2026-11-02 08:00:00'),
    ];
    const now = { at: new Date('2026-10-30T12:00:00Z') };
    const fetcher = schoologyServer(routes);
    const { db, student, schoology } = fixture({ fetcher, now: () => now.at });
    writeEntity(db, student, { id: 'personal', kind: 'personal', version: 1, data: { ...emptyPersonalSchedule(), classes: [{ id: bio, name: 'Biology' }] }, deleted: false });
    writeEntity(db, student, { id: 'feed501', kind: 'task', version: 1, data: feedTask('Anything', 'https://fa.schoology.com/assignment/501'), deleted: false });
    writeEntity(db, student, { id: 'feedQuiz', kind: 'task', version: 1, data: feedTask('Quiz', 'https://fa.schoology.com/event/77'), deleted: false });
    await schoology.start(student);
    await schoology.finish(student, { oauthToken: 'req-token' });
    fetcher.mockClear();
    return { db, student, schoology, fetcher, now };
  }
  const task = (db: Db, student: string, id: string) => readEntity(db, student, id);

  it('adds assignments the feed lacks, with their class, and checks off ones turned in', async () => {
    const { db, student, schoology } = await setup();
    const { changed } = await schoology.sync(student);
    expect(changed).toBeGreaterThan(0);
    expect(task(db, student, 'sgy_601')!.data).toMatchObject({ title: 'Lab report', dueDate: '2026-10-31', dueTime: '23:59', classId: bio, completed: false });
    expect(task(db, student, 'sgy_602')!.data).toMatchObject({ title: 'Reading log', dueDate: null, classId: bio });
    expect(task(db, student, 'sgy_605')!.data).toMatchObject({ completed: true, dueTime: null });
    expect(typeof task(db, student, 'sgy_605')!.data.completedAt).toBe('string');
    // Too old, past due and graded, already in the feed by link or by title and date, and undated but stale.
    for (const id of ['sgy_603', 'sgy_604', 'sgy_501', 'sgy_606', 'sgy_607']) expect(task(db, student, id)).toBeNull();
    // The feed's own copy gets the class too, and stays open: its dropbox answered 404.
    expect(task(db, student, 'feed501')!.data).toMatchObject({ classId: bio, completed: false });
  });

  it('reads Schoology at most every 15 minutes, or a minute apart when asked', async () => {
    const { student, schoology, fetcher, now } = await setup();
    await schoology.sync(student);
    const calls = fetcher.mock.calls.length;
    await schoology.sync(student);
    await schoology.sync(student, { force: true });
    expect(fetcher.mock.calls.length).toBe(calls);
    now.at = new Date(now.at.getTime() + 61_000);
    await schoology.sync(student, { force: true });
    expect(fetcher.mock.calls.length).toBeGreaterThan(calls);
  });

  it('keeps the student\'s edits, leaves reopened tasks open, and hands over to the feed', async () => {
    const { db, student, schoology, now } = await setup();
    await schoology.sync(student);
    const lab = task(db, student, 'sgy_601')!;
    writeEntity(db, student, { ...lab, version: lab.version + 1, data: { ...lab.data, title: 'Bio lab (mine)' } });
    const sheet = task(db, student, 'sgy_605')!;
    writeEntity(db, student, { ...sheet, version: sheet.version + 1, data: { ...sheet.data, completed: false } });
    biologyAssignments = biologyAssignments.map(entry => entry.id === 601 ? { ...entry, title: 'Lab report v2', due: '2026-11-01 23:59:00' } : entry);
    // The calendar feed now brings assignment 602 itself.
    writeEntity(db, student, { id: 'feed602', kind: 'task', version: 1, data: feedTask('Reading log', 'https://fa.schoology.com/assignment/602'), deleted: false });
    now.at = new Date(now.at.getTime() + 16 * 60_000);
    await schoology.sync(student);
    expect(task(db, student, 'sgy_601')!.data).toMatchObject({ title: 'Bio lab (mine)', dueDate: '2026-11-01' });
    expect(task(db, student, 'sgy_605')!.data.completed).toBe(false);
    expect(task(db, student, 'sgy_602')!.deleted).toBe(true);
    // Deleted stays deleted.
    now.at = new Date(now.at.getTime() + 16 * 60_000);
    await schoology.sync(student);
    expect(task(db, student, 'sgy_602')!.deleted).toBe(true);
  });

  it('does neither with both switches off', async () => {
    const { db, student, schoology } = await setup();
    expect(schoology.setSettings(student, { importAssignments: false, autoComplete: false }).connected).toMatchObject({ importAssignments: false, autoComplete: false });
    await schoology.sync(student);
    expect(task(db, student, 'sgy_601')).toBeNull();
    expect(task(db, student, 'feed501')!.data.completed).toBe(false);
  });
});

describe('grade what-ifs', () => {
  it('reads one class with titles from Schoology, or from imported tasks when Schoology won\'t list them', async () => {
    const filters: (string | null)[] = [];
    const fetcher = schoologyServer({
      'users/4242/grades': (url) => {
        filters.push(new URL(url).searchParams.get('section_id'));
        return json({ section: [{ section_id: 11, period: [{ period_id: 'p1', assignment: [
          { assignment_id: 1, grade: 8, max_points: 10, exception: 0, category_id: 5 },
          { assignment_id: 2, grade: null, max_points: 10, exception: 0, category_id: 5 },
        ] }], final_grade: [{ period_id: 'p1', grade: 80, weight: 100, grading_category: [{ category_id: 5, grade: 80 }] }, { period_id: 'final', grade: 80 }],
        grading_category: [{ id: 5, title: 'Labs', weight: 100 }] }] });
      },
      'sections/11/assignments': () => json({ assignment: [{ id: 1, title: 'Lab 1', due: '2026-10-20 23:59:00' }] }),
      'sections/11': () => json({ id: 11, course_title: 'Biology', section_title: 'Section 2' }),
    });
    const { db, student, schoology } = fixture({ fetcher });
    await schoology.start(student);
    await schoology.finish(student, { oauthToken: 'req-token' });
    writeEntity(db, student, { id: 't2', kind: 'task', version: 1, deleted: false,
      data: { title: 'Lab 2', dueDate: '2026-11-03', dueTime: null, classId: null, notes: ' - Link: https://fa.schoology.com/assignment/2', completed: false } });
    const detail = await schoology.gradeDetail(student, { sectionId: '11' });
    expect(detail).toMatchObject({ sectionId: '11', title: 'Biology: Section 2', reported: 80, categories: [{ title: 'Labs', weight: 100, reported: 80 }] });
    expect(detail.items.map(item => [item.title, item.due])).toEqual([['Lab 1', '2026-10-20'], ['Lab 2', '2026-11-03']]);
    // Unfiltered: Schoology leaves ungraded work out of ?section_id= answers.
    expect(filters.at(-1)).toBeNull();
    await expect(schoology.gradeDetail(student, { sectionId: 'x' })).rejects.toThrow();
  });

  it('flags Plus only while billing is on and the member isn\'t Plus', () => {
    const db = openDatabase(':memory:'); databases.push(db);
    const service = new Service(db, 'owner@example.com');
    const id = randomUUID();
    db.prepare('INSERT INTO users(id,google_sub,email,display_name,full_name,created_at) VALUES(?,?,?,?,?,?)').run(id, id, `${id}@example.com`, 'S', 'S', new Date().toISOString());
    const status = (plus?: { billing: boolean; member: boolean }) => new SchoologyService(service, { config, secret: SECRET, inBeta: () => true, plus: plus && (() => plus) }).status(id);
    expect(status()).toMatchObject({ plusLocked: false });
    expect(status({ billing: true, member: false })).toMatchObject({ plusLocked: true });
    expect(status({ billing: true, member: true })).toMatchObject({ plusLocked: false });
    expect(status({ billing: false, member: false })).toMatchObject({ plusLocked: false });
  });
});
