import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { openDatabase, type Db } from './db';
import { Service } from './service';
import { CommunityService } from './community';
import { appRouter, SUSPENDED_MESSAGE } from './router';
import { authFromSession } from './auth';
import { ADMIN_REAUTH_MESSAGE, ADMIN_SIGN_IN_MAX_AGE_MS } from '@/lib/admin-session';
import { exampleSchedule } from '@/domain/example';
import type { Entity } from '@/domain/sync';

const databases: Db[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); vi.restoreAllMocks(); });
const task = { title: 'Essay', dueDate: '2026-10-01', dueTime: '09:00', classId: null, notes: '', completed: false, reminder: { minutesBefore: 30, timeZone: 'UTC' } };
function fixture({ ownerSub = '' } = {}) {
  const db = openDatabase(':memory:'); databases.push(db);
  const service = new Service(db, 'owner@example.com', ownerSub);
  function user(email = `${randomUUID()}@example.com`, name = 'Student') {
    const id = randomUUID();
    db.prepare('INSERT INTO users(id,google_sub,email,display_name,full_name,created_at) VALUES(?,?,?,?,?,?)').run(id, `sub-${id}`, email, name, `${name} Fullname`, new Date().toISOString());
    return id;
  }
  const owner = user('owner@example.com', 'Owner');
  const alice = user('alice@students.example.org', 'Alice'), bob = user('bob@gmail.com', 'Bob');
  const school = service.createSchool(alice, { name: 'Community High', location: 'Boston, MA', schedule: exampleSchedule });
  const other = service.createSchool(bob, { name: 'Other High', location: 'Boston, MA', schedule: exampleSchedule });
  service.join(alice, { schoolId: school.id, choice: 'community', grade: '10' });
  service.join(bob, { schoolId: school.id, choice: 'community', grade: '11' });
  const community = new CommunityService(service);
  /** A caller whose Google sign-in happened `signedInAgo` ms ago (null: a session from before sign-in times were kept). */
  const caller = (id: string | null, signedInAgo: number | null = 0) => appRouter.createCaller({ service, userId: id, authAt: signedInAgo === null ? null : Date.now() - signedInAgo });
  const audit = (action: string) => db.prepare('SELECT * FROM audit_log WHERE action=? ORDER BY id').all(action) as { actor_id: string; detail: string; ip: string | null; user_agent: string | null }[];
  const view = (userId: string) => caller(owner).admin.users.view({ accountId: owner, userId, reason: 'Answering their support request' });
  return { db, service, community, user, owner, alice, bob, school, other, caller, audit, view };
}

describe('owner access', () => {
  it('needs a Google sign-in within the last two hours for every owner tool', async () => {
    const f = fixture();
    for (const ago of [null, ADMIN_SIGN_IN_MAX_AGE_MS + 1000]) {
      await expect(f.caller(f.owner, ago).admin.schools()).rejects.toMatchObject({ code: 'FORBIDDEN', message: ADMIN_REAUTH_MESSAGE });
      await expect(f.caller(f.owner, ago).admin.users.view({ accountId: f.owner, userId: f.alice, reason: 'Checking' })).rejects.toMatchObject({ code: 'FORBIDDEN', message: ADMIN_REAUTH_MESSAGE });
      expect(await f.caller(f.owner, ago).session()).toMatchObject({ isAdmin: true, adminReady: false });
    }
    expect(await f.caller(f.owner, 60_000).session()).toMatchObject({ isAdmin: true, adminReady: true });
    expect(await f.caller(f.owner, 60_000).admin.schools()).toHaveLength(2);
    // A sign-in time in the future is not trusted either.
    await expect(f.caller(f.owner, -10 * 60_000).admin.schools()).rejects.toMatchObject({ message: ADMIN_REAUTH_MESSAGE });
    expect(await f.caller(f.alice).session()).toMatchObject({ isAdmin: false, adminReady: false });
  });
  it('records a member who tries an owner tool, at most once a minute', async () => {
    const f = fixture();
    await expect(f.caller(f.alice).admin.users.search({ query: '' })).rejects.toMatchObject({ code: 'FORBIDDEN', message: 'Owner access is required.' });
    await expect(f.caller(f.alice).admin.users.view({ accountId: f.alice, userId: f.bob, reason: 'curious' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(f.audit('admin.denied')).toEqual([expect.objectContaining({ actor_id: f.alice })]);
    expect(JSON.parse(f.audit('admin.denied')[0]!.detail)).toMatchObject({ path: 'admin.users.search' });
    await expect(f.caller(null).admin.users.search({ query: '' })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });
  it('pins the owner by Google account ID when OWNER_GOOGLE_SUB is set', () => {
    const f = fixture({ ownerSub: 'owner-google-sub' });
    expect(f.service.isAdmin(f.owner)).toBe(false);
    f.db.prepare('UPDATE users SET google_sub=? WHERE id=?').run('owner-google-sub', f.owner);
    expect(f.service.isAdmin(f.owner)).toBe(true);
    // Another Google account that is given the owner's address later gets its own row, and no owner access.
    const impostor = f.user('Owner@Example.com', 'Owner');
    expect(f.service.isAdmin(impostor)).toBe(false);
    expect(new Service(f.db, 'owner@example.com').isAdmin(impostor)).toBe(true);
  });
  it('shows the owner whether they are pinned and when the support session ends', async () => {
    const f = fixture();
    const status = await f.caller(f.owner, 60_000).admin.security();
    expect(status).toMatchObject({ pinned: false, googleSub: `sub-${f.owner}` });
    expect(status.until).toBeGreaterThan(Date.now() + ADMIN_SIGN_IN_MAX_AGE_MS - 120_000);
  });
});

describe('sessions', () => {
  const session = (userId: string, epoch = 0, authAt: number | null = Date.now()) => ({ user: { id: userId }, epoch, authAt });
  it('ends every session when the epoch moves, and refuses suspended accounts', async () => {
    const f = fixture();
    expect(authFromSession(f.db, session(f.alice))).toEqual({ userId: f.alice, authAt: expect.any(Number) });
    expect(authFromSession(f.db, { user: { id: f.alice } })).toEqual({ userId: f.alice, authAt: null });
    await f.caller(f.owner).admin.users.signOut({ accountId: f.owner, userId: f.alice, reason: 'Lost phone' });
    expect(authFromSession(f.db, session(f.alice))).toEqual({ userId: null, authAt: null });
    expect(authFromSession(f.db, session(f.alice, 1))).toMatchObject({ userId: f.alice });

    await f.caller(f.owner).admin.users.suspend({ accountId: f.owner, userId: f.alice, suspended: true, reason: 'Spam' });
    expect(authFromSession(f.db, session(f.alice, 2))).toEqual({ userId: null, authAt: null });
    await expect(f.caller(f.alice).workspace()).rejects.toMatchObject({ code: 'FORBIDDEN', message: SUSPENDED_MESSAGE });
    await f.caller(f.owner).admin.users.suspend({ accountId: f.owner, userId: f.alice, suspended: false, reason: 'Appeal' });
    expect(authFromSession(f.db, session(f.alice, 2))).toMatchObject({ userId: f.alice });
    expect(f.audit('support.suspend').map(row => JSON.parse(row.detail))).toEqual([{ userId: f.alice, reason: 'Spam' }]);
  });
  it('refuses a session whose sign-in is older than 30 days', () => {
    const f = fixture();
    expect(authFromSession(f.db, session(f.alice, 0, Date.now() - 31 * 86_400_000))).toEqual({ userId: null, authAt: null });
    expect(authFromSession(f.db, session(randomUUID()))).toEqual({ userId: null, authAt: null });
  });
  it('never suspends the owner, but lets the owner end every one of their own sessions', async () => {
    const f = fixture();
    await expect(f.caller(f.owner).admin.users.suspend({ accountId: f.owner, userId: f.owner, suspended: true, reason: 'Oops' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await f.caller(f.owner).admin.users.signOut({ accountId: f.owner, userId: f.owner, reason: 'Session I do not recognize' });
    expect(authFromSession(f.db, session(f.owner))).toEqual({ userId: null, authAt: null });
  });
});

describe('audit log', () => {
  it('is append-only', () => {
    const f = fixture();
    expect(() => f.db.prepare("UPDATE audit_log SET detail='{}'").run()).toThrow('append-only');
    expect(() => f.db.prepare('DELETE FROM audit_log').run()).toThrow('append-only');
  });
  it('keeps the address and browser of owner actions only, and copies them to the server log', async () => {
    const f = fixture();
    const log = vi.spyOn(console, 'info').mockImplementation(() => {});
    f.service.request = { ip: '203.0.113.9', userAgent: 'Owner Browser' };
    await f.caller(f.owner).admin.users.setVerified({ accountId: f.owner, userId: f.alice, verified: true });
    await f.caller(f.alice).school.requestCorrection({ accountId: f.alice, message: 'The bell times are wrong on Fridays.' });
    await f.caller(f.bob).community.request({ accountId: f.bob, userId: f.alice });
    expect(f.audit('support.verify')).toEqual([expect.objectContaining({ ip: '203.0.113.9', user_agent: 'Owner Browser' })]);
    expect(f.db.prepare("SELECT count(*) n FROM audit_log WHERE ip IS NOT NULL AND action<>'support.verify'").get()).toEqual({ n: 0 });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('"action":"support.verify"'));
  });
  it('lists everything about one member, and pages the whole log', async () => {
    const f = fixture();
    await f.caller(f.owner).admin.users.setVerified({ accountId: f.owner, userId: f.alice, verified: true });
    await f.caller(f.owner).admin.users.setVerified({ accountId: f.owner, userId: f.bob, verified: true });
    const record = await f.view(f.alice);
    expect(record.activity.map(entry => entry.action)).toEqual(['support.viewUser', 'support.verify', 'school.join', 'school.create']);
    const all = await f.caller(f.owner).admin.auditLog({});
    expect(all[0]!.action).toBe('support.viewUser');
    expect(await f.caller(f.owner).admin.auditLog({ before: all[1]!.id })).toEqual(all.slice(2));
  });
  it('names the member each owner row is about, but not the actor of their own rows', async () => {
    const f = fixture();
    await f.caller(f.owner).admin.users.setVerified({ accountId: f.owner, userId: f.alice, verified: true });
    const all = await f.caller(f.owner).admin.auditLog({});
    expect(all.find(entry => entry.action === 'support.verify')!.target).toEqual({ userId: f.alice, displayName: 'Alice', email: 'alice@students.example.org' });
    expect(all.find(entry => entry.action === 'school.join')!.target).toBeNull();
  });
});

describe('member records', () => {
  it('needs a reason to open, and logs one view per member and reason every ten minutes', async () => {
    const f = fixture();
    await expect(f.caller(f.owner).admin.users.view({ accountId: f.owner, userId: f.alice, reason: '' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await f.view(f.alice); await f.view(f.alice);
    await f.caller(f.owner).admin.users.view({ accountId: f.owner, userId: f.alice, reason: 'Reviewing a report' });
    // The same open from another address is always logged, so a second device using the session shows up.
    f.service.request = { ip: '198.51.100.7', userAgent: 'Other Browser' };
    await f.view(f.alice);
    expect(f.audit('support.viewUser').map(row => JSON.parse(row.detail))).toEqual([
      { userId: f.alice, reason: 'Answering their support request' }, { userId: f.alice, reason: 'Reviewing a report' }, { userId: f.alice, reason: 'Answering their support request' }]);
    await expect(f.view(randomUUID())).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
  it('finds members by email, name or ID, optionally at one school', async () => {
    const f = fixture();
    const search = (query: string, schoolId?: string) => f.caller(f.owner).admin.users.search({ query, ...(schoolId ? { schoolId } : {}) });
    expect((await search('STUDENTS.example')).map(row => row.id)).toEqual([f.alice]);
    expect((await search('bob fullname')).map(row => row.id)).toEqual([f.bob]);
    expect((await search(f.owner)).map(row => row.id)).toEqual([f.owner]);
    expect((await search('', f.school.id)).map(row => row.id).sort()).toEqual([f.alice, f.bob].sort());
  });
  it('never returns calendar feed addresses or push endpoints', async () => {
    const f = fixture();
    f.db.prepare(`INSERT INTO calendar_subscriptions(id,owner_id,name,url_encrypted,url_hash,time_zone,next_refresh_at) VALUES(?,?,?,?,?,?,?)`).run(randomUUID(), f.alice, 'School', 'ZX-SECRET-URL', 'ZX-SECRET-HASH', 'UTC', new Date().toISOString());
    f.db.prepare('INSERT INTO push_subscriptions(id,owner_id,endpoint,p256dh,auth,created_at) VALUES(?,?,?,?,?,?)').run(randomUUID(), f.alice, 'https://fcm.googleapis.com/ZX-SECRET-ENDPOINT', 'ZX-KEY', 'ZX-AUTH', new Date().toISOString());
    const record = await f.view(f.alice);
    expect(record.feeds).toHaveLength(1);
    expect(record.account.browsers).toBe(1);
    expect(JSON.stringify(record)).not.toMatch(/ZX-SECRET|ZX-KEY|ZX-AUTH/);
  });
});

describe('member changes', () => {
  it('edits the profile, keeping the reserved-name rule', async () => {
    const f = fixture();
    const owner = f.caller(f.owner);
    await owner.admin.users.updateAccount({ accountId: f.owner, userId: f.alice, displayName: 'Ali', fullName: 'Alice Liddell', chatPush: false });
    expect(f.service.user(f.alice)).toMatchObject({ displayName: 'Ali', fullName: 'Alice Liddell' });
    expect((await f.view(f.alice)).account.chatPush).toBe(false);
    await expect(owner.admin.users.updateAccount({ accountId: f.owner, userId: f.alice, displayName: 'Quasar Support', fullName: 'Alice', chatPush: true })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(JSON.parse(f.audit('support.editAccount')[0]!.detail)).toMatchObject({ from: { displayName: 'Alice' }, to: { displayName: 'Ali' } });
  });
  it('replaces classes as a new version that the member’s next sync merges with offline edits', async () => {
    const f = fixture();
    const owner = f.caller(f.owner);
    const before = f.service.entity(f.alice, 'personal')!;
    const data = { ...before.data, classes: [{ id: 'bio', name: 'Biology', room: '204' }], assignments: { [exampleSchedule.periods[0]!.id]: 'bio' } };
    await expect(owner.admin.users.savePersonal({ accountId: f.owner, userId: f.alice, expectedVersion: before.version + 1, data: data as never })).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(owner.admin.users.savePersonal({ accountId: f.owner, userId: f.alice, expectedVersion: before.version, data: { ...data, assignments: { p: 'missing' } } as never })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(await owner.admin.users.savePersonal({ accountId: f.owner, userId: f.alice, expectedVersion: before.version, data: data as never })).toEqual({ version: before.version + 1 });
    // A device still on the old version changes the grade offline; its sync merges with support's classes.
    const result = f.service.sync(f.alice, { mutationId: randomUUID(), id: 'personal', kind: 'personal', base: before, data: { ...before.data, grade: '11' } });
    expect(result.status).toBe('applied');
    expect((result as { entity: Entity }).entity.data).toMatchObject({ grade: '11', classes: [{ id: 'bio', name: 'Biology', room: '204' }] });
  });
  it('edits and deletes tasks with version checks', async () => {
    const f = fixture();
    const owner = f.caller(f.owner);
    const synced = f.service.sync(f.alice, { mutationId: randomUUID(), id: 'essay', kind: 'task', base: null, data: task });
    const version = (synced as { entity: Entity }).entity.version;
    const edit = { title: 'Essay draft', notes: 'Two pages', completed: true, dueDate: null, dueTime: null, priority: 'high' as const };
    await expect(owner.admin.users.saveTask({ accountId: f.owner, userId: f.alice, taskId: 'essay', expectedVersion: version + 1, data: edit })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(await owner.admin.users.saveTask({ accountId: f.owner, userId: f.alice, taskId: 'essay', expectedVersion: version, data: edit })).toEqual({ version: version + 1 });
    // Clearing the due date takes the reminder with it; completing stamps the time.
    expect(f.service.entity(f.alice, 'essay')!.data).toMatchObject({ title: 'Essay draft', dueDate: null, reminder: null, completed: true, completedAt: expect.any(String), priority: 'high' });
    await owner.admin.users.deleteTask({ accountId: f.owner, userId: f.alice, taskId: 'essay', expectedVersion: version + 1 });
    expect(f.service.entity(f.alice, 'essay')!.deleted).toBe(true);
    await expect(owner.admin.users.deleteTask({ accountId: f.owner, userId: f.alice, taskId: 'essay', expectedVersion: version + 2 })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await f.view(f.alice)).deletedTasks).toBe(1);
  });
  it('moves members between schools without a ban, and respects one', async () => {
    const f = fixture();
    const owner = f.caller(f.owner);
    f.community.verifyByDomain(f.alice, f.school.id);
    // An open proposal of hers at the old school (inserted directly: a school this small edits without voting).
    const proposal = { id: randomUUID() };
    f.db.prepare("INSERT INTO schedule_proposals(id,school_id,proposer_id,base_version,schedule,summary,status,created_at) VALUES(?,?,?,?,?,?,'open',?)")
      .run(proposal.id, f.school.id, f.alice, f.service.school(f.school.id).version, JSON.stringify(exampleSchedule), 'Move lunch earlier', new Date().toISOString());
    await owner.admin.users.moveSchool({ accountId: f.owner, userId: f.alice, schoolId: f.other.id, reason: 'Transferred' });
    expect(f.service.user(f.alice).schoolId).toBe(f.other.id);
    expect(f.db.prepare('SELECT status FROM schedule_proposals WHERE id=?').get(proposal.id)).toEqual({ status: 'withdrawn' });
    await owner.admin.users.moveSchool({ accountId: f.owner, userId: f.alice, schoolId: null, reason: 'Graduated' });
    expect(f.service.user(f.alice).schoolId).toBeNull();
    await owner.admin.removeMember({ userId: f.bob, schoolId: f.school.id, reason: 'Harassment' });
    await expect(owner.admin.users.moveSchool({ accountId: f.owner, userId: f.bob, schoolId: f.school.id, reason: 'Back' })).rejects.toMatchObject({ code: 'CONFLICT' });
    await owner.admin.users.unban({ accountId: f.owner, userId: f.bob, schoolId: f.school.id, reason: 'Appeal granted' });
    await owner.admin.users.moveSchool({ accountId: f.owner, userId: f.bob, schoolId: f.school.id, reason: 'Back' });
    expect(f.service.user(f.bob).schoolId).toBe(f.school.id);
  });
  it('drops a private timetable on a move into a school unless support keeps it, and keeps it on a move out', async () => {
    const f = fixture();
    const owner = f.caller(f.owner);
    const personal = f.service.entity(f.alice, 'personal')!;
    const data = { ...personal.data as object, classes: [{ id: 'art', name: 'Art' }], customSchedule: exampleSchedule };
    f.service.sync(f.alice, { mutationId: randomUUID(), id: 'personal', kind: 'personal', base: personal, data });
    const version = f.service.entity(f.alice, 'personal')!.version;
    await owner.admin.users.moveSchool({ accountId: f.owner, userId: f.alice, schoolId: f.other.id, keepPrivateTimetable: true, reason: 'Transferred' });
    expect(f.service.entity(f.alice, 'personal')).toMatchObject({ version, data: { customSchedule: exampleSchedule } });
    await owner.admin.users.moveSchool({ accountId: f.owner, userId: f.alice, schoolId: null, reason: 'Left' });
    expect(f.service.entity(f.alice, 'personal')).toMatchObject({ version, data: { customSchedule: exampleSchedule } });
    await owner.admin.users.moveSchool({ accountId: f.owner, userId: f.alice, schoolId: f.school.id, reason: 'Back' });
    const moved = f.service.entity(f.alice, 'personal')!;
    expect(moved.version).toBe(version + 1);
    expect(moved.data).toMatchObject({ customSchedule: null, classes: [{ id: 'art', name: 'Art' }] });
    expect(f.audit('support.moveSchool').map(row => JSON.parse(row.detail).timetable)).toEqual(['private', undefined, 'school']);
  });
  it('verifies and unverifies at the member’s school, unless their email domain would verify them again', async () => {
    const f = fixture();
    const owner = f.caller(f.owner);
    await owner.admin.users.setVerified({ accountId: f.owner, userId: f.bob, verified: true });
    expect(f.community.isVerified(f.bob, f.school.id)).toBe(true);
    await owner.admin.users.setVerified({ accountId: f.owner, userId: f.bob, verified: false });
    expect(f.community.isVerified(f.bob, f.school.id)).toBe(false);
    f.db.prepare('UPDATE schools SET email_domains=? WHERE id=?').run('students.example.org', f.school.id);
    expect(f.community.verification(f.alice).status).toBe('verified');
    await expect(owner.admin.users.setVerified({ accountId: f.owner, userId: f.alice, verified: false })).rejects.toMatchObject({ code: 'BAD_REQUEST', message: expect.stringContaining('Remove the domain') });
    expect(f.community.isVerified(f.alice, f.school.id)).toBe(true);
  });
  it('brings up the next task when support checks off a repeating one', async () => {
    const f = fixture();
    const weekly = { ...task, reminder: null, recurrence: { frequency: 'weekly', interval: 1, until: null } };
    const synced = f.service.sync(f.alice, { mutationId: randomUUID(), id: 'weekly', kind: 'task', base: null, data: weekly });
    const done = { title: 'Essay', notes: '', completed: true, dueDate: '2026-10-01', dueTime: '09:00', priority: 'normal' as const };
    await f.caller(f.owner).admin.users.saveTask({ accountId: f.owner, userId: f.alice, taskId: 'weekly', expectedVersion: (synced as { entity: Entity }).entity.version, data: done });
    const successor = f.db.prepare('SELECT successor_id FROM recurring_successors WHERE owner_id=? AND parent_id=?').get(f.alice, 'weekly') as { successor_id: string };
    expect(f.service.entity(f.alice, successor.successor_id)!.data).toMatchObject({ title: 'Essay', dueDate: '2026-10-08', completed: false });
  });
  it('ends friendships with a reason, and never creates one', async () => {
    const f = fixture();
    f.community.request(f.alice, f.bob); f.community.respond(f.bob, f.alice, true);
    const owner = f.caller(f.owner);
    await expect(owner.admin.users.removeFriendship({ accountId: f.owner, userId: f.alice, otherId: f.bob, reason: '' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect((await f.view(f.alice)).friendships).toEqual([expect.objectContaining({ userId: f.bob, status: 'accepted' })]);
    await owner.admin.users.removeFriendship({ accountId: f.owner, userId: f.alice, otherId: f.bob, reason: 'Requested by parent' });
    expect(f.community.areFriends(f.alice, f.bob)).toBe(false);
    await expect(owner.admin.users.removeFriendship({ accountId: f.owner, userId: f.alice, otherId: f.bob, reason: 'Again' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
  it('audits the owner decisions that used to leave no trail', async () => {
    const f = fixture();
    const owner = f.caller(f.owner);
    await f.caller(f.alice).school.requestCorrection({ accountId: f.alice, message: 'The bell times are wrong on Fridays.' });
    const [request] = await owner.admin.requests();
    await owner.admin.resolveRequest({ accountId: f.owner, id: request!.id });
    await expect(owner.admin.resolveRequest({ accountId: f.owner, id: request!.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await f.caller(f.alice).community.report({ accountId: f.alice, userId: f.bob, reason: 'Posting spam everywhere' });
    const [report] = await owner.admin.reports();
    await owner.admin.resolveReport({ id: report!.id, outcome: 'dismissed' });
    await owner.admin.renameSchool({ accountId: f.owner, schoolId: f.school.id, name: 'Community High School', location: 'Boston, MA' });
    expect(f.service.school(f.school.id).name).toBe('Community High School');
    for (const action of ['support.resolveRequest', 'report.resolve', 'support.renameSchool']) expect(f.audit(action)).toHaveLength(1);
  });
});
