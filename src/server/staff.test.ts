import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { openDatabase, type Db } from './db';
import { Service } from './service';
import { CommunityService } from './community';
import { GlobalChatService } from './global-chat';
import { DirectoryService } from './directory';
import { SchoolLogoService } from './school-logos';
import { useStaffBetaFixture, joinStaffBeta } from './staff-beta-fixture';
import { GroupChatService } from './group-chat';
import { appRouter } from './router';
import { StaffError, grantStaffRole, listStaff, revokeStaffRole } from './staff';
import { ADMIN_REAUTH_MESSAGE, ADMIN_SIGN_IN_MAX_AGE_MS } from '@/lib/admin-session';
import { ROLE_PERMISSIONS, STAFF_PERMISSIONS } from '@/domain/staff';
import { BetaService } from './betas';
import { exampleSchedule } from '@/domain/example';

useStaffBetaFixture();

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

  it('requires the owner, beta membership and recent sign-in to manage assignments in the console', async () => {
    const f = fixture();
    const input = { accountId: f.owner, userId: f.alice, role: 'school-manager' as const, expectedGrant: null, expectedSchoolId: f.school.id };
    const revoke = { ...input, expectedGrant: { role: 'school-manager' as const, schoolId: f.school.id } };
    const owner = f.caller(f.owner).admin.roles;
    await expect(owner.list()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(owner.grant(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(owner.revoke(revoke)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    joinStaffBeta(f.service, f.admin);
    const administrator = f.caller(f.admin).admin.roles;
    await expect(administrator.list()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(administrator.candidate({ userId: f.alice })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(administrator.grant({ ...input, accountId: f.admin })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(administrator.revoke({ ...revoke, accountId: f.admin })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    joinStaffBeta(f.service, f.owner);
    const stale = f.caller(f.owner, ADMIN_SIGN_IN_MAX_AGE_MS + 1000).admin.roles;
    await expect(stale.grant(input)).rejects.toMatchObject({ message: ADMIN_REAUTH_MESSAGE });
    await expect(owner.grant({ ...input, accountId: f.admin })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(owner.candidate({ userId: f.alice })).resolves.toMatchObject({ schoolId: f.school.id, joinedBeta: false, grant: null });
    await expect(owner.grant({ ...input, userId: f.owner, expectedSchoolId: null })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(owner.grant(input)).resolves.toMatchObject({ member: { role: 'school-manager', schoolId: f.school.id } });
    expect(f.service.staffRank(f.alice)).toBeNull();
    joinStaffBeta(f.service, f.alice);
    expect(f.service.staffRank(f.alice)).toBe('school-manager');
    expect(await owner.list()).toContainEqual(expect.objectContaining({ userId: f.alice, currentSchoolId: f.school.id, schoolId: f.school.id }));
    expect(f.audit('staff.grant').at(-1)).toMatchObject({ actor_id: f.owner, detail: expect.stringContaining('"via":"console"') });
    await owner.revoke(revoke);
    expect(f.service.staffRank(f.alice)).toBeNull();
    expect(f.audit('staff.revoke').at(-1)).toMatchObject({ actor_id: f.owner, detail: expect.stringContaining('"via":"console"') });
  });

  it('rejects assignment changes if the target changed schools or another grant replaced the one on screen', async () => {
    const f = fixture();
    joinStaffBeta(f.service, f.owner);
    const roles = f.caller(f.owner).admin.roles;
    const stale = { accountId: f.owner, userId: f.helper, expectedSchoolId: f.school.id, expectedGrant: { role: 'support' as const, schoolId: null } };
    grantStaffRole(f.service, f.helper, 'school-manager');
    await expect(roles.revoke(stale)).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(roles.grant({ ...stale, role: 'administrator' })).rejects.toMatchObject({ code: 'CONFLICT' });
    const manager = { ...stale, expectedGrant: { role: 'school-manager' as const, schoolId: f.school.id } };
    await expect(roles.revoke({ ...manager, expectedGrant: { ...manager.expectedGrant, schoolId: null } })).rejects.toMatchObject({ code: 'CONFLICT' });
    f.db.prepare('UPDATE users SET school_id=NULL WHERE id=?').run(f.helper);
    await expect(roles.revoke(manager)).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(roles.grant({ ...manager, role: 'support' })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(listStaff(f.service).find(member => member.userId === f.helper)).toMatchObject({ role: 'school-manager', currentSchoolId: null, schoolId: f.school.id });
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

  it('limits the manager’s roster, verification and support queue to their school', async () => {
    const f = fixture();
    const accountId = f.editor;
    grantStaffRole(f.service, accountId, 'school-manager');
    joinStaffBeta(f.service, accountId);
    const other = f.service.createSchool(f.bob, { name: 'Other High', location: 'Boston, MA', schedule: exampleSchedule });
    f.service.join(f.bob, { schoolId: other.id, choice: 'community' });
    const as = f.caller(accountId).admin;
    expect((await as.users.search({ query: '' })).map(row => row.id)).toEqual([f.alice]);
    await expect(as.users.search({ query: '', schoolId: other.id })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(as.users.view({ accountId, userId: f.alice, reason: 'Account history' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    for (const id of [f.alice, f.bob]) {
      f.community.requestVerification(id, { proof: 'Proof of enrollment attached' });
      f.service.requestCorrection(id, 'Please change the Friday bell times.');
    }
    f.service.feedback(f.alice, 'App feedback for the site owner.');
    const requests = await as.requests();
    expect(requests.map(row => row.userId)).toEqual([f.alice]);
    const hidden = (await f.caller(f.owner).admin.requests()).filter(row => row.id !== requests[0].id);
    for (const row of hidden) await expect(as.resolveRequest({ accountId, id: row.id })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await as.resolveRequest({ accountId, id: requests[0].id });
    const verifications = await as.verificationRequests();
    expect(verifications.map(row => row.userId)).toEqual([f.alice]);
    const foreignProof = f.community.verificationRequests(f.owner).find(row => row.userId === f.bob)!;
    await expect(as.decideVerification({ id: foreignProof.id, approve: true })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await as.decideVerification({ id: verifications[0].id, approve: true });
    expect(f.community.isVerified(f.alice, f.school.id)).toBe(true);
    await expect(as.users.setVerified({ accountId, userId: f.bob, verified: true })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await as.users.setVerified({ accountId, userId: f.alice, verified: false });
    expect(f.community.isVerified(f.alice, f.school.id)).toBe(false);
  });

  it('removes a member locally and answers the school appeal without closing their other relationships or reports', async () => {
    const f = fixture();
    const accountId = f.editor;
    grantStaffRole(f.service, accountId, 'school-manager');
    joinStaffBeta(f.service, accountId);
    f.community.request(f.alice, f.bob);
    f.community.respond(f.bob, f.alice, true);
    const other = f.service.createSchool(f.bob, { name: 'Other High', location: 'Boston, MA', schedule: exampleSchedule });
    f.service.join(f.bob, { schoolId: other.id, choice: 'community' });
    f.community.report(f.bob, { userId: f.alice, reason: 'Cross-school dispute with Alice' });
    const as = f.caller(accountId).admin;
    const remove = (userId: string, schoolId: string) => as.removeMember({ userId, schoolId, reason: 'False enrollment' });
    await expect(remove(f.bob, f.school.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(remove(f.bob, other.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await remove(f.alice, f.school.id);
    expect(f.service.user(f.alice).schoolId).toBeNull();
    expect(f.community.friends(f.alice).friends.map(user => user.id)).toContain(f.bob);
    expect(f.community.reports(f.owner)).toHaveLength(1);
    f.community.removeFromSchool(f.owner, f.bob, other.id, 'False enrollment');
    expect((await as.bans()).map(row => row.userId)).toEqual([f.alice]);
    await expect(as.liftBan({ accountId, userId: f.bob, schoolId: other.id })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(as.users.unban({ accountId, userId: f.bob, schoolId: other.id, reason: 'Reviewing appeal' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    f.service.appeal(f.alice, { kind: 'ban', schoolId: f.school.id, message: 'I have current proof of enrollment.' });
    expect((await as.requests()).map(row => row.kind)).toEqual(['appeal:ban']);
    await as.liftBan({ accountId, userId: f.alice, schoolId: f.school.id });
    expect(await as.requests()).toEqual([]);
    expect(f.community.isBanned(f.alice, f.school.id)).toBe(false);
  });

  it('routes each request kind to the roles that handle it', async () => {
    const f = fixture();
    f.service.requestCorrection(f.alice, 'Period 3 starts at 10:05 on Wednesdays.');
    f.service.feedback(f.bob, 'The new month view is great, thanks!');
    f.service.db.prepare("UPDATE support_requests SET kind='beta:month-days' WHERE user_id=?").run(f.bob);
    await f.caller(f.owner).admin.pauseChat({ accountId: f.owner, userId: f.alice, days: 1, reason: 'Spamming the room' });
    f.service.appeal(f.alice, { kind: 'pause', message: 'I was not spamming, it was a group joke.' });
    const kinds = async (id: string) => (await f.caller(id).admin.requests()).map(request => request.kind).sort();
    expect(await kinds(f.owner)).toEqual(['appeal:pause', 'beta:month-days', 'school:correction']);
    expect(await kinds(f.admin)).toEqual(['appeal:pause', 'beta:month-days', 'school:correction']);
    expect(await kinds(f.helper)).toEqual(['beta:month-days', 'school:correction']);
    expect(await kinds(f.editor)).toEqual(['school:correction']);
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

  it('limits school reviews, guide editing and workspace tools to the manager’s assigned school', async () => {
    const f = fixture();
    const manager = f.editor;
    grantStaffRole(f.service, manager, 'school-manager');
    joinStaffBeta(f.service, manager);
    const other = f.service.createSchool(f.bob, { name: 'Other High', location: 'Reno, NV', schedule: exampleSchedule });
    f.db.prepare('UPDATE schools SET support_locked=1').run();
    f.service.request = { authAt: Date.now(), ip: null, userAgent: null };
    const as = f.caller(manager);
    const accountId = manager;
    const schoolId = f.school.id;
    const update = { schoolId, expectedVersion: 1, schedule: exampleSchedule, approved: true, supportLocked: true };
    await expect(as.admin.update(update)).resolves.toMatchObject({ id: schoolId, approved: true });
    await expect(as.admin.update({ ...update, schoolId: other.id })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(as.admin.renameSchool({ accountId, schoolId: other.id, name: 'New school name', location: 'Reno, NV' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const saveGuide = (scope: string | null) => as.admin.saveGuide({ accountId, schoolId: scope, kind: 'calendar', platform: 'canvas', guide: null });
    await expect(saveGuide(schoolId)).resolves.toBeUndefined();
    for (const scope of [null, other.id]) {
      await expect(as.admin.guides({ schoolId: scope })).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(saveGuide(scope)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(as.admin.uploadGuideImage({ accountId, schoolId: scope, data: '' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
    await expect(as.admin.setGuidePlatforms({ accountId, schoolId: other.id, kind: 'calendar', platforms: ['canvas'] })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await as.directory.list({ schoolId })).toMatchObject({ canEdit: true });
    await expect(as.directory.list({ schoolId: other.id })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(as.school.setMenu({ accountId, schoolId, source: null })).resolves.toBeNull();
    await expect(as.school.setMenu({ accountId, schoolId: other.id, source: null })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('shows school content and membership events without exposing audit details or other schools', async () => {
    const f = fixture();
    grantStaffRole(f.service, f.editor, 'school-manager');
    joinStaffBeta(f.service, f.editor);
    const other = f.service.createSchool(f.bob, { name: 'Other High', location: 'Reno, NV', schedule: exampleSchedule });
    const as = f.caller(f.editor);
    const before = await as.admin.schoolActivity();
    const at = '2026-09-08T12:00:00.000Z';
    f.service.audit(f.owner, 'support.renameSchool', other.id, {}, at);
    f.service.audit(f.owner, 'support.signOut', f.school.id, { userId: f.bob }, at);
    f.service.audit(f.owner, 'support.editTask', f.school.id, { userId: f.bob }, at);
    f.service.audit(f.owner, 'setupGuide.save', null, { platform: 'canvas' }, at);
    f.service.audit(f.owner, 'member.remove', f.school.id, { userId: f.alice, reason: 'Private reason' }, at);
    const rows = await as.admin.schoolActivity();
    expect(rows.slice(1)).toEqual(before);
    expect(rows[0]).toEqual({ id: expect.any(Number), action: 'Member removed from school', schoolName: f.school.name, createdAt: at });
    await expect(f.caller(f.helper).admin.schoolActivity()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(f.caller(f.editor, ADMIN_SIGN_IN_MAX_AGE_MS + 1000).admin.schoolActivity()).rejects.toMatchObject({ message: ADMIN_REAUTH_MESSAGE });
    await expect(as.admin.auditLog({})).rejects.toMatchObject({ code: 'FORBIDDEN' });
    revokeStaffRole(f.service, f.editor);
    await expect(as.admin.schoolActivity()).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('scopes proposal and logo queues before listing, loading an image or deciding a proposal by ID', async () => {
    const f = fixture();
    const manager = f.editor;
    grantStaffRole(f.service, manager, 'school-manager');
    joinStaffBeta(f.service, manager);
    const other = f.service.createSchool(f.bob, { name: 'Other High', location: 'Reno, NV', schedule: exampleSchedule });
    const as = f.caller(manager);
    const schedule = f.db.prepare(`INSERT INTO schedule_proposals(id,school_id,proposer_id,base_version,schedule,summary,status,created_at)
      VALUES(?,?,?,1,?,'New lunch time','awaiting-support',datetime('now'))`);
    const logo = f.db.prepare(`INSERT INTO school_logo_proposals(id,school_id,proposer_id,image,mime,status,request,created_at)
      VALUES(?,?,?,X'01','image/png','requested',1,datetime('now'))`);
    const mine = randomUUID(), theirs = randomUUID();
    for (const [id, schoolId] of [[mine, f.school.id], [theirs, other.id]]) {
      schedule.run(id, schoolId, f.alice, JSON.stringify(exampleSchedule));
      logo.run(id, schoolId, f.alice);
    }
    expect((await as.admin.proposals()).map(row => row.id)).toEqual([mine]);
    expect((await as.admin.logoVotes()).map(row => row.id)).toEqual([mine]);
    const logos = new SchoolLogoService(f.service);
    expect(logos.proposalImage(manager, theirs)).toBeNull();
    expect(logos.proposalImage(manager, mine)?.mime).toBe('image/png');
    await expect(as.admin.schoolLogos({ schoolId: other.id })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(as.admin.decideProposal({ id: theirs, publish: false })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(as.admin.forceLogo({ id: theirs, win: false })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(as.admin.decideProposal({ id: mine, publish: false })).resolves.toBeUndefined();
    await expect(as.admin.forceLogo({ id: mine, win: false })).resolves.toBeUndefined();
    expect((await f.caller(f.owner).admin.proposals()).map(row => row.id)).toEqual([theirs]);
    expect((await f.caller(f.owner).admin.logoVotes()).map(row => row.id)).toEqual([theirs]);
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

describe('scoped staff sessions', () => {

  it('requires a grant, beta membership and the assigned school on every request', async () => {
    const f = fixture();
    const manager = f.caller(f.alice);
    const other = f.service.createSchool(f.bob, { name: 'North High', location: 'Boston, MA', schedule: exampleSchedule });
    grantStaffRole(f.service, f.alice, 'school-manager');
    expect((await manager.session())?.staff).toBeNull();
    expect(f.service.canTarget(f.admin, f.alice)).toBe(false);
    joinStaffBeta(f.service, f.bob);
    expect((await f.caller(f.bob).session())?.staff).toBeNull();
    joinStaffBeta(f.service, f.alice);
    expect((await manager.session())?.staff).toMatchObject({ role: 'school-manager', schoolId: f.school.id, schoolName: f.school.name });
    expect((await manager.admin.schools()).map(school => school.id)).toEqual([f.school.id]);
    await expect(manager.admin.users.suspend({ accountId: f.alice, userId: f.bob, suspended: true, reason: 'School issue' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    f.service.join(f.alice, { schoolId: other.id, choice: 'community' });
    await expect(manager.admin.schools()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    grantStaffRole(f.service, f.alice, 'school-manager');
    expect((await manager.admin.schools()).map(school => school.id)).toEqual([other.id]);
    new BetaService(f.service).leave(f.alice, 'staff-roles');
    expect((await manager.session())?.staff).toBeNull();
    await expect(manager.admin.schools()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    joinStaffBeta(f.service, f.alice);
    revokeStaffRole(f.service, f.alice);
    await expect(manager.admin.schools()).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('npm run staff', () => {
  it('pins a manager grant to one school until the operator grants a new scope', () => {
    const f = fixture();
    const separate = f.service.createSchool(f.alice, { name: 'West High', location: 'Boston, MA', schedule: exampleSchedule });
    const member = grantStaffRole(f.service, f.helper, 'school-manager').member;
    expect(member).toMatchObject({ schoolId: f.school.id, schoolName: f.school.name });
    expect(() => grantStaffRole(f.service, f.helper, 'school-manager')).toThrow('already school manager');

    f.service.join(f.helper, { schoolId: separate.id, choice: 'community' });
    expect(listStaff(f.service).find(row => row.userId === f.helper)).toMatchObject({ schoolId: f.school.id });
    expect(grantStaffRole(f.service, f.helper, 'school-manager').member).toMatchObject({ schoolId: separate.id, schoolName: separate.name });
    expect(JSON.parse(f.audit('staff.grant').at(-1)!.detail)).toMatchObject({ previousSchoolId: f.school.id });
    expect(grantStaffRole(f.service, f.helper, 'chat-moderation').member).toMatchObject({ role: 'chat-moderation', schoolId: null });

    f.db.prepare('UPDATE users SET school_id=NULL WHERE id=?').run(f.helper);
    expect(() => grantStaffRole(f.service, f.helper, 'school-manager')).toThrow('must join a school');
    expect(listStaff(f.service).find(row => row.userId === f.helper)?.role).toBe('chat-moderation');
  });

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
