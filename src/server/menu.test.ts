import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { openDatabase, type Db } from './db';
import { Service } from './service';
import { MENU_ACTION_LIMIT, MENU_CACHE_MS, MenuService } from './menu';
import { appRouter } from './router';
import { exampleSchedule } from '@/domain/example';

const databases: Db[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

const SITE = { org: 'friendsacademy', domain: 'flikisdining.com' as const };
const SCHOOLS_URL = 'https://friendsacademy.api.flikisdining.com/menu/api/schools/?format=json';
const WEEK_URL = 'https://friendsacademy.api.flikisdining.com/menu/api/weeks/school/friends-academy/menu-type/lunch/2026/09/20/?format=json';
const listing = [
  { name: 'LS Lunch  Menu', slug: 'ls-lunch', active_menu_types: [{ name: 'Lunch', slug: 'lunch' }] },
  { name: 'MS/US Employee Lunch', slug: 'friends-academy', active_menu_types: [{ name: 'Lunch', slug: 'lunch' }] },
];
const week = (entree: string) => ({ days: [
  { date: '2026-09-21', menu_items: [{ is_section_title: false, is_holiday: true, text: 'Yom Kippur', food: null }] },
  { date: '2026-09-25', menu_items: [{ is_section_title: true, text: 'Entree', food: null }, { is_section_title: false, text: '', food: { name: entree } }] },
] });

function fixture() {
  const db = openDatabase(':memory:'); databases.push(db);
  const service = new Service(db, 'owner@example.com');
  function user(email = `${randomUUID()}@example.com`, name = 'Student') {
    const id = randomUUID();
    db.prepare('INSERT INTO users(id,google_sub,email,display_name,full_name,created_at) VALUES(?,?,?,?,?,?)').run(id, id, email, name, `${name} Fullname`, new Date().toISOString());
    return id;
  }
  const owner = user('owner@example.com', 'Owner');
  const alice = user(undefined, 'Alice'), bob = user(undefined, 'Bob'), outsider = user(undefined, 'Outsider');
  const school = service.createSchool(alice, { name: 'Community High', location: 'Boston, MA', schedule: exampleSchedule });
  const other = service.createSchool(outsider, { name: 'Other High', location: 'Boston, MA', schedule: exampleSchedule });
  service.join(alice, { schoolId: school.id, choice: 'community' });
  service.join(bob, { schoolId: school.id, choice: 'community' });
  service.join(outsider, { schoolId: other.id, choice: 'community' });
  const calls: string[] = [];
  const answers: Record<string, () => unknown> = { [SCHOOLS_URL]: () => listing, [WEEK_URL]: () => week('Lemon Herb Cod') };
  let now = new Date('2026-09-25T15:00:00Z');
  const menus = new MenuService(service, async (url) => { calls.push(url); const answer = answers[url]; if (!answer) throw new Error(`The menu site returned HTTP 404.`); return answer(); }, () => now);
  const caller = (id: string | null) => appRouter.createCaller({ service, userId: id });
  return { db, service, menus, user, owner, alice, bob, outsider, school, other, calls, answers, caller, advance: (ms: number) => { now = new Date(now.getTime() + ms); } };
}

describe('lunch menu source', () => {
  it('lets members of an open school look up and pick a menu, and shows the site’s own label', async () => {
    const f = fixture();
    const lookup = await f.menus.lookup(f.alice, f.school.id, { url: 'https://friendsacademy.flikisdining.com/menu/friends-academy/lunch' });
    expect(lookup.site).toEqual(SITE);
    expect(lookup.choices.map((choice) => `${choice.school}/${choice.menu}`)).toEqual(['ls-lunch/lunch', 'friends-academy/lunch']);
    expect(lookup.suggested).toBe('friends-academy/lunch');
    // A bare homepage suggests nothing.
    expect((await f.menus.lookup(f.alice, f.school.id, { url: 'friendsacademy.flikisdining.com' })).suggested).toBeNull();
    const source = await f.menus.set(f.alice, { schoolId: f.school.id, source: { ...SITE, school: 'friends-academy', menu: 'lunch' } });
    expect(source).toEqual({ ...SITE, school: 'friends-academy', menu: 'lunch', name: 'MS/US Employee Lunch' });
    expect(f.menus.source(f.school.id)).toEqual(source);
    const audit = f.db.prepare("SELECT detail FROM audit_log WHERE action='school.menu'").all() as { detail: string }[];
    expect(audit.map((row) => JSON.parse(row.detail))).toEqual([{ from: null, to: 'https://friendsacademy.flikisdining.com/menu/friends-academy/lunch' }]);
    // Clearing it.
    expect(await f.menus.set(f.alice, { schoolId: f.school.id, source: null })).toBeNull();
    expect(f.menus.source(f.school.id)).toBeNull();
  });
  it('refuses menus the site does not list, addresses off a menu site, and unknown sites', async () => {
    const f = fixture();
    await expect(f.menus.set(f.alice, { schoolId: f.school.id, source: { ...SITE, school: 'ms-snack', menu: 'lunch' } })).rejects.toThrow(/not on the site/);
    await expect(f.menus.lookup(f.alice, f.school.id, { url: 'https://example.com/menu/friends-academy/lunch' })).rejects.toThrow(/Nutrislice/);
    await expect(f.menus.lookup(f.alice, f.school.id, { url: 'https://nowhere.flikisdining.com/' })).rejects.toThrow(/HTTP 404/);
    expect(f.menus.source(f.school.id)).toBeNull();
  });
  it('follows the shared-schedule rule: non-members never, members only while unlocked, the owner always', async () => {
    const f = fixture();
    const source = { ...SITE, school: 'friends-academy', menu: 'lunch' };
    await expect(f.menus.set(f.outsider, { schoolId: f.school.id, source })).rejects.toThrow(/Only school members/);
    await expect(f.menus.lookup(f.outsider, f.school.id, { url: 'friendsacademy.flikisdining.com' })).rejects.toThrow(/Only school members/);
    f.db.prepare('UPDATE schools SET support_locked=1 WHERE id=?').run(f.school.id);
    await expect(f.menus.set(f.alice, { schoolId: f.school.id, source })).rejects.toThrow(/locked/);
    expect(f.menus.canEdit(f.alice, f.service.school(f.school.id))).toBe(false);
    // The owner is not a member of this school and it is locked; support still manages it.
    expect(f.menus.canEdit(f.owner, f.service.school(f.school.id))).toBe(true);
    await expect(f.menus.set(f.owner, { schoolId: f.school.id, source })).resolves.toMatchObject({ name: 'MS/US Employee Lunch' });
  });
  it('limits lookups and changes per account and hour, counting both', async () => {
    const f = fixture();
    for (let index = 0; index < MENU_ACTION_LIMIT; index += 1) await f.menus.lookup(f.alice, f.school.id, { url: 'friendsacademy.flikisdining.com' });
    await expect(f.menus.lookup(f.alice, f.school.id, { url: 'friendsacademy.flikisdining.com' })).rejects.toThrow(/Too many/);
    await expect(f.menus.set(f.alice, { schoolId: f.school.id, source: { ...SITE, school: 'friends-academy', menu: 'lunch' } })).rejects.toThrow(/Too many/);
    // Removing a menu fetches nothing and is not limited; Bob has his own allowance.
    await expect(f.menus.set(f.alice, { schoolId: f.school.id, source: null })).resolves.toBeNull();
    await expect(f.menus.lookup(f.bob, f.school.id, { url: 'friendsacademy.flikisdining.com' })).resolves.toBeTruthy();
    f.advance(3600_000 + 1);
    await expect(f.menus.lookup(f.alice, f.school.id, { url: 'friendsacademy.flikisdining.com' })).resolves.toBeTruthy();
  });
});

describe('lunch menu weeks', () => {
  it('answers without a source until one is set, then fetches the provider week once and serves it from the cache', async () => {
    const f = fixture();
    expect(await f.menus.week(f.bob, { date: '2026-09-25' })).toEqual({ source: null });
    expect(f.calls).toEqual([]);
    await f.menus.set(f.alice, { schoolId: f.school.id, source: { ...SITE, school: 'friends-academy', menu: 'lunch' } });
    const first = await f.menus.week(f.bob, { date: '2026-09-25' });
    expect(first).toMatchObject({ weekStart: '2026-09-20', stale: false, fetchedAt: '2026-09-25T15:00:00.000Z', source: { name: 'MS/US Employee Lunch', url: 'https://friendsacademy.flikisdining.com/menu/friends-academy/lunch' } });
    expect(first.source && first.days).toEqual([
      { date: '2026-09-21', notes: ['Yom Kippur'], sections: [] },
      { date: '2026-09-25', notes: [], sections: [{ title: 'Entree', items: ['Lemon Herb Cod'] }] },
    ]);
    // Any day of the same week, from any member, reuses the copy.
    f.answers[WEEK_URL] = () => week('Changed');
    expect(await f.menus.week(f.alice, { date: '2026-09-22' })).toEqual(first);
    expect(f.calls.filter((url) => url === WEEK_URL)).toHaveLength(1);
    // After MENU_CACHE_MS it is fetched again.
    f.advance(MENU_CACHE_MS);
    const refreshed = await f.menus.week(f.alice, { date: '2026-09-22' });
    expect(refreshed.source && refreshed.days[1].sections[0].items).toEqual(['Changed']);
    expect(f.calls.filter((url) => url === WEEK_URL)).toHaveLength(2);
  });
  it('keeps serving the cached week, marked stale, while the provider is down, and fails plainly without one', async () => {
    const f = fixture();
    await f.menus.set(f.alice, { schoolId: f.school.id, source: { ...SITE, school: 'friends-academy', menu: 'lunch' } });
    const first = await f.menus.week(f.bob, { date: '2026-09-25' });
    f.answers[WEEK_URL] = () => { throw new Error('The menu site returned HTTP 503.'); };
    f.advance(MENU_CACHE_MS);
    expect(await f.menus.week(f.bob, { date: '2026-09-25' })).toEqual({ ...first, stale: true });
    // A week that was never fetched has nothing to fall back on.
    await expect(f.menus.week(f.bob, { date: '2026-10-02' })).rejects.toThrow(/HTTP 404/);
  });
  it('drops the cache when the source changes, and rejects students without a school', async () => {
    const f = fixture();
    await f.menus.set(f.alice, { schoolId: f.school.id, source: { ...SITE, school: 'friends-academy', menu: 'lunch' } });
    await f.menus.week(f.bob, { date: '2026-09-25' });
    expect(f.db.prepare('SELECT count(*) n FROM menu_weeks').get()).toEqual({ n: 1 });
    await f.menus.set(f.alice, { schoolId: f.school.id, source: null });
    expect(f.db.prepare('SELECT count(*) n FROM menu_weeks').get()).toEqual({ n: 0 });
    const loner = f.user(undefined, 'Loner');
    await expect(f.menus.week(loner, { date: '2026-09-25' })).rejects.toThrow(/Join a school/);
  });
  it('is reachable through the router with the account guards', async () => {
    const f = fixture();
    // The router builds its own MenuService with the real fetch, so only the paths that fetch nothing are exercised here.
    expect(await f.caller(f.bob).school.menu({ date: '2026-09-25' })).toEqual({ source: null });
    await expect(f.caller(null).school.menu({ date: '2026-09-25' })).rejects.toThrow(/Sign in/);
    await expect(f.caller(f.bob).school.setMenu({ accountId: f.alice, schoolId: f.school.id, source: null })).rejects.toThrow(/signed-in account changed/);
    await expect(f.caller(f.outsider).school.setMenu({ accountId: f.outsider, schoolId: f.school.id, source: null })).rejects.toThrow(/Only school members/);
    await expect(f.caller(f.bob).school.setMenu({ accountId: f.bob, schoolId: f.school.id, source: null })).resolves.toBeNull();
  });
});
