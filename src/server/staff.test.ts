import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { openDatabase, type Db } from './db';
import { Service } from './service';
import { CommunityService } from './community';
import { GlobalChatService } from './global-chat';
import { DirectoryService } from './directory';
import { GroupChatService } from './group-chat';
import { appRouter } from './router';
import { StaffError, grantStaffRole, listStaff, revokeStaffRole } from './staff';
import { ADMIN_REAUTH_MESSAGE, ADMIN_SIGN_IN_MAX_AGE_MS } from '@/lib/admin-session';
import { ROLE_PERMISSIONS, STAFF_PERMISSIONS } from '@/domain/staff';
import { exampleSchedule } from '@/domain/example';

const databases: Db[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); vi.restoreAllMocks(); });
const ROLE_REFUSED = 'Your staff role doesn’t include this.';
const STAFF_TARGET = 'Only the owner can use support tools on a staff account.';

function fixture() {
  const db = openDatabase(':memory:'); databases.push(db);
  const service = new Service(db, 'owner@example.com', '');
  function user(email: string, name: string) {
    const id = randomUUID();
    db.prepare('INSERT INTO users(id,google_sub,email,display_name,full_name,created_at) VALUES(?,?,?,?,?,?)').run(id, `sub-${id}`, email, name, `${name} Fullname`, new Date().toISOString());
    return id;
  }
  const owner = user('owner@example.com', 'Owner');
  const admin = user('friend@example.com', 'Friend');
  const moderator = user('mod@example.com', 'Mod');
  const helper = user('helper@example.com', 'Helper');
  const editor = user('editor@example.com', 'Editor');
  const alice = user('alice@example.com', 'Alice'), bob = user('bob@example.com', 'Bob');
  grantStaffRole(service, 'friend@example.com', 'administrator');
  grantStaffRole(service, 'mod@example.com', 'moderator');
  grantStaffRole(service, 'helper@example.com', 'support');
  grantStaffRole(service, 'editor@example.com', 'schedule-editor');
  const school = service.createSchool(alice, { name: 'Community High', location: 'Boston, MA', schedule: exampleSchedule });
  for (const id of [alice, bob, admin, moderator, helper, editor]) service.join(id, { schoolId: school.id, choice: 'community', grade: '10' });
  const community = new CommunityService(service);
  const caller = (id: string, signedInAgo = 0) => appRouter.createCaller({ service, userId: id, authAt: Date.now() - signedInAgo });
  const audit = (action: string) => db.prepare('SELECT * FROM audit_log WHERE action=? ORDER BY id').all(action) as { actor_id: string; detail: string; ip: string | null; user_agent: string | null }[];
  return { db, service, community, owner, admin, moderator, helper, editor, alice, bob, school, caller, audit };
}

describe('staff roles', () => {
  it('gives each role its bundle and the owner everything', () => {
    const f = fixture();
    expect(f.service.staffRank(f.owner)).toBe('owner');
    expect(f.service.staffRank(f.admin)).toBe('administrator');
    expect(f.service.staffRank(f.alice)).toBeNull();
    for (const permission of STAFF_PERMISSIONS) {
      expect(f.service.can(f.owner, permission)).toBe(true);
      expect(f.service.can(f.admin, permission)).toBe(true);
      expect(f.service.can(f.moderator, permission)).toBe(ROLE_PERMISSIONS.moderator.includes(permission));
      expect(f.service.can(f.helper, permission)).toBe(ROLE_PERMISSIONS.support.includes(permission));
      expect(f.service.can(f.editor, permission)).toBe(ROLE_PERMISSIONS['schedule-editor'].includes(permission));
      expect(f.service.can(f.alice, permission)).toBe(false);
    }
    // isAdmin stays the owner alone, so owner-only perks never leak to a role.
    expect(f.service.isAdmin(f.admin)).toBe(false);
  });

  it('has no procedure that grants or changes a role', () => {
    const paths = Object.keys((appRouter as unknown as { _def: { procedures: Record<string, unknown> } })._def.procedures);
    expect(paths.length).toBeGreaterThan(50);
    expect(paths.filter(path => /staff|role|grant/i.test(path))).toEqual([]);
  });

  it('keeps the owner-only tools from every role, administrator included', async () => {
    const f = fixture();
    for (const id of [f.admin, f.moderator, f.helper, f.editor]) {
      const as = f.caller(id);
      await expect(as.admin.auditLog({})).rejects.toMatchObject({ code: 'FORBIDDEN', message: 'Owner access is required.' });
      await expect(as.admin.betas.list()).rejects.toMatchObject({ message: 'Owner access is required.' });
      await expect(as.admin.setModOverride({ accountId: id, userId: f.alice, mod: 'rgb', state: 'on' })).rejects.toMatchObject({ message: 'Owner access is required.' });
      await expect(as.admin.users.updateAccount({ accountId: id, userId: f.alice, displayName: 'Hacked', fullName: 'Hacked', chatPush: true })).rejects.toMatchObject({ message: 'Owner access is required.' });
      await expect(as.admin.users.moveSchool({ accountId: id, userId: f.alice, schoolId: null, reason: 'Testing it' })).rejects.toMatchObject({ message: 'Owner access is required.' });
      await expect(as.admin.users.removeFriendship({ accountId: id, userId: f.alice, otherId: f.bob, reason: 'Testing it' })).rejects.toMatchObject({ message: 'Owner access is required.' });
    }
    // Each refusal is recorded, so a role probing past its bundle shows up in the audit log.
    expect(f.audit('admin.denied').map(row => row.actor_id)).toEqual(expect.arrayContaining([f.admin, f.moderator, f.helper, f.editor]));
  });

  it('lets each role into its own tools only', async () => {
    const f = fixture();
    await expect(f.caller(f.helper).admin.users.search({ query: 'alice' })).resolves.toHaveLength(1);
    await expect(f.caller(f.moderator).admin.users.search({ query: 'alice' })).rejects.toMatchObject({ message: ROLE_REFUSED });
    await expect(f.caller(f.moderator).admin.reports()).resolves.toEqual([]);
    await expect(f.caller(f.helper).admin.reports()).rejects.toMatchObject({ message: ROLE_REFUSED });
    await expect(f.caller(f.editor).admin.proposals()).resolves.toEqual([]);
    await expect(f.caller(f.editor).admin.chatPauses()).rejects.toMatchObject({ message: ROLE_REFUSED });
    await expect(f.caller(f.editor).admin.renameSchool({ accountId: f.editor, schoolId: f.school.id, name: 'Community High School', location: 'Boston, MA' })).resolves.toBeUndefined();
    await expect(f.caller(f.helper).admin.renameSchool({ accountId: f.helper, schoolId: f.school.id, name: 'Nope High', location: 'Boston, MA' })).rejects.toMatchObject({ message: ROLE_REFUSED });
    await expect(f.caller(f.moderator).admin.pauseChat({ accountId: f.moderator, userId: f.alice, days: 1, reason: 'Spamming the room' })).resolves.toBeUndefined();
    await expect(f.caller(f.helper).admin.pauseChat({ accountId: f.helper, userId: f.bob, days: 1, reason: 'Spamming the room' })).rejects.toMatchObject({ message: ROLE_REFUSED });
    await expect(f.caller(f.admin).admin.users.suspend({ accountId: f.admin, userId: f.bob, suspended: true, reason: 'Account was stolen' })).resolves.toBeUndefined();
    await expect(f.caller(f.moderator).admin.users.suspend({ accountId: f.moderator, userId: f.alice, suspended: true, reason: 'Nope' })).rejects.toMatchObject({ message: ROLE_REFUSED });
    // Every staff role reads the school list the console needs; a member does not.
    await expect(f.caller(f.editor).admin.schools()).resolves.toHaveLength(1);
    await expect(f.caller(f.alice).admin.schools()).rejects.toMatchObject({ message: 'Staff access is required.' });
  });

  it('needs a recent Google sign-in for staff, like the owner', async () => {
    const f = fixture();
    await expect(f.caller(f.moderator, ADMIN_SIGN_IN_MAX_AGE_MS + 1000).admin.reports()).rejects.toMatchObject({ message: ADMIN_REAUTH_MESSAGE });
    expect(await f.caller(f.moderator, ADMIN_SIGN_IN_MAX_AGE_MS + 1000).session()).toMatchObject({ isAdmin: false, adminReady: false, staff: { role: 'moderator' } });
    expect(await f.caller(f.moderator).session()).toMatchObject({ isAdmin: false, adminReady: true, staff: { role: 'moderator', permissions: [...ROLE_PERMISSIONS.moderator] } });
    expect(await f.caller(f.alice).session()).toMatchObject({ isAdmin: false, adminReady: false, staff: null });
  });

  it('never lets staff act on the owner, other staff or themselves, while the owner can', async () => {
    const f = fixture();
    const admin = f.caller(f.admin);
    await expect(admin.admin.users.view({ accountId: f.admin, userId: f.owner, reason: 'Curious' })).rejects.toMatchObject({ message: STAFF_TARGET });
    await expect(admin.admin.users.view({ accountId: f.admin, userId: f.moderator, reason: 'Curious' })).rejects.toMatchObject({ message: STAFF_TARGET });
    await expect(admin.admin.users.view({ accountId: f.admin, userId: f.admin, reason: 'Curious' })).rejects.toMatchObject({ message: 'Staff can’t use support tools on their own account.' });
    await expect(admin.admin.users.suspend({ accountId: f.admin, userId: f.owner, suspended: true, reason: 'Takeover' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(admin.admin.users.signOut({ accountId: f.admin, userId: f.owner, reason: 'Takeover' })).rejects.toMatchObject({ message: STAFF_TARGET });
    await expect(admin.admin.users.suspend({ accountId: f.admin, userId: f.moderator, suspended: true, reason: 'Takeover' })).rejects.toMatchObject({ message: STAFF_TARGET });
    await expect(admin.admin.removeMember({ userId: f.editor, schoolId: f.school.id, reason: 'Takeover' })).rejects.toMatchObject({ message: STAFF_TARGET });
    await expect(f.caller(f.moderator).admin.pauseChat({ accountId: f.moderator, userId: f.admin, days: null, reason: 'Takeover' })).rejects.toMatchObject({ message: STAFF_TARGET });
    expect(f.service.isStaff(f.moderator)).toBe(true);
    // The owner still can.
    await expect(f.caller(f.owner).admin.users.suspend({ accountId: f.owner, userId: f.moderator, suspended: true, reason: 'Abused the role' })).resolves.toBeUndefined();
    await expect(f.caller(f.owner).admin.users.view({ accountId: f.owner, userId: f.admin, reason: 'Reviewing staff' })).resolves.toMatchObject({ account: { staff: 'administrator' } });
  });

  it('leaves reports that involve staff, and their messages, to the owner', async () => {
    const f = fixture();
    f.community.report(f.alice, { userId: f.bob, reason: 'Posting my address in chat' });
    f.community.report(f.bob, { userId: f.helper, reason: 'Support was rude to me' });
    f.community.report(f.helper, { userId: f.alice, reason: 'Harassing the support account' });
    expect((await f.caller(f.moderator).admin.reports()).map(report => [report.reporterName, report.reportedName])).toEqual([['Alice', 'Bob']]);
    expect(await f.caller(f.owner).admin.reports()).toHaveLength(3);
    const aboutStaff = (await f.caller(f.owner).admin.reports()).find(report => report.reportedId === f.helper)!;
    await expect(f.caller(f.moderator).admin.resolveReport({ id: aboutStaff.id, outcome: 'dismissed' })).rejects.toMatchObject({ message: STAFF_TARGET });
  });

  it('routes each request kind to the roles that handle it', async () => {
    const f = fixture();
    f.service.requestCorrection(f.alice, 'Period 3 starts at 10:05 on Wednesdays.');
    f.service.feedback(f.bob, 'The new month view is great, thanks!');
    f.service.db.prepare("UPDATE support_requests SET kind='beta:month-days' WHERE user_id=?").run(f.bob);
    await f.caller(f.owner).admin.pauseChat({ accountId: f.owner, userId: f.alice, days: 1, reason: 'Spamming the room' });
    f.service.appeal(f.alice, { kind: 'pause', message: 'I was not spamming, it was a group joke.' });
    const kinds = async (id: string) => (await f.caller(id).admin.requests()).map(request => request.kind).sort();
    expect(await kinds(f.owner)).toEqual(['', 'appeal:pause', 'beta:month-days']);
    expect(await kinds(f.admin)).toEqual(['', 'appeal:pause', 'beta:month-days']);
    expect(await kinds(f.helper)).toEqual(['', 'beta:month-days']);
    expect(await kinds(f.editor)).toEqual(['']);
    expect(await kinds(f.moderator)).toEqual(['appeal:pause']);
    const appeal = (await f.caller(f.owner).admin.requests()).find(request => request.kind === 'appeal:pause')!;
    await expect(f.caller(f.helper).admin.resolveRequest({ accountId: f.helper, id: appeal.id })).rejects.toMatchObject({ message: 'Your staff role doesn’t handle this request.' });
    await expect(f.caller(f.moderator).admin.resolveRequest({ accountId: f.moderator, id: appeal.id })).resolves.toBeUndefined();
  });

  it('gives staff a record without tasks, feeds or the address on audit rows', async () => {
    const f = fixture();
    f.service.request = { ip: '203.0.113.9', userAgent: 'Owner Browser' };
    await f.caller(f.owner).admin.users.view({ accountId: f.owner, userId: f.alice, reason: 'Answering their support request' });
    f.service.request = { ip: '198.51.100.7', userAgent: 'Helper Browser' };
    const record = await f.caller(f.helper).admin.users.view({ accountId: f.helper, userId: f.alice, reason: 'Answering their support request' });
    expect(record).toMatchObject({ full: false, tasks: [], feeds: [] });
    expect(record.activity.length).toBeGreaterThan(0);
    expect(record.activity.every(row => row.ip === null && row.userAgent === null)).toBe(true);
    expect((await f.caller(f.owner).admin.users.view({ accountId: f.owner, userId: f.alice, reason: 'Checking the support view' })).full).toBe(true);
    // Staff rows keep the address and browser, as the owner's do.
    expect(f.audit('support.viewUser').map(row => [row.actor_id, row.ip, row.user_agent])).toEqual(expect.arrayContaining([[f.helper, '198.51.100.7', 'Helper Browser']]));
  });

  it('lets moderators run Global chat, names their role, and badges staff senders', () => {
    const f = fixture();
    const room = new GlobalChatService(f.service);
    const spam = room.send(f.alice, randomUUID(), 'buy my thing').message;
    const fromOwner = room.send(f.owner, randomUUID(), 'Welcome everyone').message;
    expect(room.thread(f.bob).room).toMatchObject({ canModerate: false, moderator: null });
    expect(room.thread(f.moderator).room).toMatchObject({ canModerate: true, moderator: 'moderator' });
    expect(room.thread(f.helper).room.canModerate).toBe(false);
    expect(() => room.delete(f.helper, spam.id, 'Spam')).toThrow('Only moderators');
    expect(() => room.delete(f.moderator, fromOwner.id, 'Nope')).toThrow(STAFF_TARGET);
    room.delete(f.moderator, spam.id, 'Spam');
    const seen = room.thread(f.bob).messages;
    expect(seen.find(message => message.id === spam.id)).toMatchObject({ deletedBy: 'owner', moderatedBy: 'moderator', reason: 'Spam' });
    expect(seen.find(message => message.id === fromOwner.id)!.sender.staff).toBe('owner');
    expect(room.summary(f.bob).lastMessage).toMatchObject({ senderName: 'Owner' });
  });

  it('lets schedule editors edit any school directory, with a recent sign-in like the console', () => {
    const f = fixture();
    f.service.db.prepare('UPDATE schools SET support_locked=1 WHERE id=?').run(f.school.id);
    const directory = new DirectoryService(f.service);
    f.service.request = { ip: null, userAgent: null, authAt: Date.now() };
    expect(directory.list(f.editor, f.school.id).canEdit).toBe(true);
    expect(directory.list(f.helper, f.school.id).canEdit).toBe(false);
    expect(directory.list(f.alice, f.school.id).canEdit).toBe(false);
    f.service.request = { ip: null, userAgent: null, authAt: Date.now() - ADMIN_SIGN_IN_MAX_AGE_MS - 1000 };
    expect(directory.list(f.editor, f.school.id).canEdit).toBe(false);
    // The owner keeps the access it always had.
    expect(directory.list(f.owner, f.school.id).canEdit).toBe(true);
  });

  it('keeps email domains, which verify students, from roles without verification', async () => {
    const f = fixture();
    const update = (id: string, emailDomains: string[]) => f.caller(id).admin.update({ schoolId: f.school.id, expectedVersion: f.service.school(f.school.id).version, schedule: exampleSchedule, exceptionGradesExplicit: true, approved: false, supportLocked: false, emailDomains });
    await expect(update(f.editor, ['example.com'])).rejects.toMatchObject({ code: 'FORBIDDEN', message: 'Changing a school’s email domains verifies its students, so it needs the verification permission.' });
    expect(f.service.school(f.school.id).emailDomains).toEqual([]);
    await expect(update(f.editor, [])).resolves.toMatchObject({ emailDomains: [] });
    await expect(update(f.admin, ['example.com'])).resolves.toMatchObject({ emailDomains: ['example.com'] });
  });

  it('leaves a group report to the owner when its snapshot holds a staff member’s messages', async () => {
    const f = fixture();
    f.service.join(f.owner, { schoolId: f.school.id, choice: 'community', grade: '12' });
    const befriend = (a: string, b: string) => { f.community.request(a, b); f.community.respond(b, a, true); };
    befriend(f.alice, f.bob); befriend(f.alice, f.owner);
    const groups = new GroupChatService(f.service);
    const group = groups.create(f.alice, { name: 'Study crew', memberIds: [f.bob, f.owner] });
    groups.send(f.owner, group.id, randomUUID(), 'private note from the owner');
    const rude = groups.send(f.bob, group.id, randomUUID(), 'something rude').message;
    groups.report(f.alice, group.id, { category: 'bullying', seq: rude.seq, block: false });
    const report = (await f.caller(f.owner).admin.reports()).find(entry => entry.reportedId === f.bob)!;
    expect(await f.caller(f.moderator).admin.reports()).toEqual([]);
    await expect(f.caller(f.moderator).admin.showEvidence({ accountId: f.moderator, reportId: report.id })).rejects.toMatchObject({ message: STAFF_TARGET });
    await expect(f.caller(f.moderator).admin.redactMessage({ accountId: f.moderator, reportId: report.id, seq: rude.seq })).rejects.toMatchObject({ message: STAFF_TARGET });
    expect((await f.caller(f.owner).admin.showEvidence({ accountId: f.owner, reportId: report.id })).items.map(item => item.body)).toContain('private note from the owner');
  });

  it('leaves staff out of the reports and social lists on a staff copy of a record', async () => {
    const f = fixture();
    f.community.report(f.alice, { userId: f.helper, reason: 'Support was rude to me' });
    f.community.report(f.alice, { userId: f.bob, reason: 'Posting my address in chat' });
    f.service.join(f.owner, { schoolId: f.school.id, choice: 'community', grade: '12' });
    f.community.request(f.alice, f.owner); f.community.respond(f.owner, f.alice, true);
    const asAdmin = await f.caller(f.admin).admin.users.view({ accountId: f.admin, userId: f.alice, reason: 'Reviewing a report' });
    expect(asAdmin.reportsBy.map(report => report.otherId)).toEqual([f.bob]);
    expect(asAdmin.friendships).toEqual([]);
    const asOwner = await f.caller(f.owner).admin.users.view({ accountId: f.owner, userId: f.alice, reason: 'Reviewing a report' });
    expect(asOwner.reportsBy).toHaveLength(2);
    expect(asOwner.friendships.map(row => row.userId)).toEqual([f.owner]);
  });

  it('puts the role in the workspace', () => {
    const f = fixture();
    expect(f.service.workspace(f.editor).staff).toEqual({ role: 'schedule-editor', permissions: ['proposals', 'schools.edit'] });
    expect(f.service.workspace(f.alice).staff).toBeNull();
  });
});

describe('npm run staff', () => {
  it('grants, changes, lists and revokes roles, logged under the owner', () => {
    const f = fixture();
    expect(listStaff(f.service).map(member => [member.email, member.role])).toEqual([
      ['friend@example.com', 'administrator'], ['mod@example.com', 'moderator'], ['helper@example.com', 'support'], ['editor@example.com', 'schedule-editor'],
    ]);
    expect(grantStaffRole(f.service, f.helper, 'moderator')).toMatchObject({ previous: 'support', member: { role: 'moderator' } });
    expect(revokeStaffRole(f.service, 'MOD@example.com')).toEqual({ email: 'mod@example.com', role: 'moderator' });
    // A revoked role stops working at once, without a sign-out.
    expect(f.service.can(f.moderator, 'reports')).toBe(false);
    const grants = f.audit('staff.grant');
    expect(grants).toHaveLength(5);
    expect(grants.every(row => row.actor_id === f.owner)).toBe(true);
    expect(JSON.parse(grants.at(-1)!.detail)).toEqual({ userId: f.helper, role: 'moderator', from: 'support', via: 'cli' });
    expect(f.audit('staff.revoke').map(row => JSON.parse(row.detail))).toEqual([{ userId: f.moderator, role: 'moderator', via: 'cli' }]);
  });

  it('refuses the owner, unknown roles and accounts, repeats and suspended accounts', () => {
    const f = fixture();
    expect(() => grantStaffRole(f.service, 'owner@example.com', 'administrator')).toThrow('This is the owner account');
    expect(() => grantStaffRole(f.service, 'alice@example.com', 'owner')).toThrow('Unknown role "owner"');
    expect(() => grantStaffRole(f.service, 'nobody@example.com', 'support')).toThrow('No account matches');
    expect(() => grantStaffRole(f.service, 'friend@example.com', 'administrator')).toThrow('already administrator');
    expect(() => revokeStaffRole(f.service, 'alice@example.com')).toThrow('has no staff role');
    f.service.db.prepare("UPDATE users SET suspended_at='2026-10-01T00:00:00.000Z' WHERE id=?").run(f.bob);
    expect(() => grantStaffRole(f.service, f.bob, 'support')).toThrow(StaffError);
  });

  it('asks for an account ID when an email names two accounts', () => {
    const f = fixture();
    const twin = randomUUID();
    f.service.db.prepare('INSERT INTO users(id,google_sub,email,display_name,full_name,created_at) VALUES(?,?,?,?,?,?)').run(twin, `sub-${twin}`, 'alice@example.com', 'Alice Two', 'Alice Two', new Date().toISOString());
    expect(() => grantStaffRole(f.service, 'alice@example.com', 'support')).toThrow('Pass the account ID instead');
    expect(grantStaffRole(f.service, twin, 'support').member.userId).toBe(twin);
  });
});
