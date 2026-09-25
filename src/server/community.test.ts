import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { openDatabase, type Db } from './db';
import { Service } from './service';
import { CommunityService, FRIEND_REQUEST_LIMIT } from './community';
import { ProposalService, voteThreshold } from './proposals';
import { appRouter } from './router';
import { exampleSchedule } from '@/domain/example';

const databases: Db[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function fixture() {
  const db = openDatabase(':memory:'); databases.push(db);
  const service = new Service(db, 'owner@example.com');
  function user(email = `${randomUUID()}@example.com`, name = 'Student') {
    const id = randomUUID();
    db.prepare('INSERT INTO users(id,google_sub,email,display_name,full_name,created_at) VALUES(?,?,?,?,?,?)').run(id, id, email, name, `${name} Fullname`, new Date().toISOString());
    return id;
  }
  const owner = user('owner@example.com', 'Owner');
  const alice = user('alice@students.example.org', 'Alice'), bob = user('bob@gmail.com', 'Bob'), outsider = user(undefined, 'Outsider');
  const school = service.createSchool(alice, { name: 'Community High', location: 'Boston, MA', schedule: exampleSchedule });
  const other = service.createSchool(outsider, { name: 'Other High', location: 'Boston, MA', schedule: exampleSchedule });
  service.join(alice, { schoolId: school.id, choice: 'community', grade: '10' });
  service.join(bob, { schoolId: school.id, choice: 'community', grade: '11' });
  service.join(outsider, { schoolId: other.id, choice: 'community' });
  const community = new CommunityService(service);
  const caller = (id: string | null) => appRouter.createCaller({ service, userId: id });
  return { db, service, community, user, owner, alice, bob, outsider, school, other, caller };
}
function seedClasses(f: ReturnType<typeof fixture>, id: string) {
  f.db.prepare("UPDATE entities SET data=? WHERE owner_id=? AND id='personal'").run(
    JSON.stringify({ classes: [{ id: 'c1', name: 'Algebra', room: '101', teacher: 'Ms. K' }], assignments: { A: 'c1' }, cycleDayOverrides: [], dateOverrides: [], customSchedule: null, grade: '10' }), id);
}

describe('school verification', () => {
  it('verifies by email domain at join once support lists the domain, and otherwise through a support decision', () => {
    const f = fixture();
    expect(f.community.verification(f.alice)).toEqual({ status: 'none', method: null });
    f.service.updateSchool(f.owner, { schoolId: f.school.id, expectedVersion: 1, schedule: exampleSchedule, approved: true, supportLocked: false, emailDomains: ['students.example.org'] }, true);
    expect(f.service.school(f.school.id).emailDomains).toEqual(['students.example.org']);
    // Re-joining or asking for verification picks the domain up without a support request.
    expect(f.community.requestVerification(f.alice, { proof: 'my school email should match now' })).toEqual({ status: 'verified', method: 'domain' });
    expect(f.community.verificationRequests(f.owner)).toHaveLength(0);
    // Bob has a personal address and needs support.
    expect(f.community.requestVerification(f.bob, { proof: 'Photo of my student ID is at https://example.org/id' })).toEqual({ status: 'pending', method: null });
    expect(() => f.community.requestVerification(f.bob, { proof: 'another request while pending' })).toThrow('already reviewing');
    const requests = f.community.verificationRequests(f.owner);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ userId: f.bob, schoolName: 'Community High' });
    expect(() => f.community.verificationRequests(f.bob)).toThrow('Owner access');
    f.community.decideVerification(f.owner, requests[0]!.id, false);
    expect(f.community.verification(f.bob)).toEqual({ status: 'none', method: null });
    expect(f.community.requestVerification(f.bob, { proof: 'Here is better proof of enrollment' }).status).toBe('pending');
    f.community.decideVerification(f.owner, f.community.verificationRequests(f.owner)[0]!.id, true);
    expect(f.community.verification(f.bob)).toEqual({ status: 'verified', method: 'support' });
  });
  it('verifies current members whose address matches a domain support adds after they joined', () => {
    const f = fixture();
    expect(f.service.workspace(f.alice).community.verification).toEqual({ status: 'none', method: null });
    f.service.updateSchool(f.owner, { schoolId: f.school.id, expectedVersion: 1, schedule: exampleSchedule, approved: true, supportLocked: false, emailDomains: ['students.example.org'] }, true);
    // No re-join and no proof: the next workspace load picks the domain up.
    expect(f.service.workspace(f.alice).community.verification).toEqual({ status: 'verified', method: 'domain' });
    expect(f.community.isVerified(f.alice, f.school.id)).toBe(true);
    expect(f.community.verification(f.bob)).toEqual({ status: 'none', method: null });
    expect(f.community.verificationRequests(f.owner)).toHaveLength(0);
  });
  it('closes a pending proof once a domain added later verifies the student, and audits the domain change', () => {
    const f = fixture();
    expect(f.community.requestVerification(f.alice, { proof: 'Photo of my student ID is at https://example.org/id' }).status).toBe('pending');
    expect(f.community.verificationRequests(f.owner)).toHaveLength(1);
    f.service.updateSchool(f.owner, { schoolId: f.school.id, expectedVersion: 1, schedule: exampleSchedule, approved: true, supportLocked: false, emailDomains: ['students.example.org'] }, true);
    const audit = f.db.prepare("SELECT detail FROM audit_log WHERE action='school.adminUpdate' ORDER BY rowid DESC").get() as { detail: string };
    expect(JSON.parse(audit.detail)).toMatchObject({ fromDomains: [], toDomains: ['students.example.org'] });
    expect(f.service.workspace(f.alice).community.verification).toEqual({ status: 'verified', method: 'domain' });
    // The domain settled the proof, so it no longer waits for support.
    expect(f.community.verificationRequests(f.owner)).toHaveLength(0);
    expect(f.db.prepare('SELECT decision, actor_id FROM verification_requests WHERE user_id=?').get(f.alice)).toEqual({ decision: 'approved', actor_id: null });
    // Saving the same domains again records no domain change.
    f.service.updateSchool(f.owner, { schoolId: f.school.id, expectedVersion: 2, schedule: exampleSchedule, approved: true, supportLocked: false, emailDomains: ['students.example.org'] }, true);
    const again = f.db.prepare("SELECT detail FROM audit_log WHERE action='school.adminUpdate' ORDER BY rowid DESC").get() as { detail: string };
    expect(JSON.parse(again.detail)).not.toHaveProperty('toDomains');
  });
  it('closes a removed member\'s open verification request and never approves one for a banned member', () => {
    const f = fixture();
    expect(f.community.requestVerification(f.bob, { proof: 'Photo of my student ID is at https://example.org/id' }).status).toBe('pending');
    f.community.removeFromSchool(f.owner, f.bob, f.school.id, 'Impersonation');
    expect(f.community.verificationRequests(f.owner)).toHaveLength(0);
    expect(f.db.prepare('SELECT decision, actor_id FROM verification_requests WHERE user_id=?').get(f.bob)).toEqual({ decision: 'declined', actor_id: f.owner });
    // A request still open from before this rule (or any other path) is declined, not approved.
    f.db.prepare('INSERT INTO verification_requests(id,user_id,school_id,proof,created_at) VALUES(?,?,?,?,?)').run(randomUUID(), f.bob, f.school.id, 'Left open before the removal', new Date().toISOString());
    const stale = f.community.verificationRequests(f.owner)[0]!;
    expect(() => f.community.decideVerification(f.owner, stale.id, true)).toThrow('removed from this school');
    expect(f.community.verificationRequests(f.owner)).toHaveLength(0);
    expect(f.db.prepare('SELECT 1 FROM school_verifications WHERE user_id=?').get(f.bob)).toBeUndefined();
  });
  it('is dormant after switching schools and never granted by Google sign-in alone', () => {
    const f = fixture();
    f.community.decideVerification(f.owner, (f.community.requestVerification(f.bob, { proof: 'Proof of enrollment attached' }), f.community.verificationRequests(f.owner)[0]!.id), true);
    expect(f.community.verification(f.bob).status).toBe('verified');
    f.service.join(f.bob, { schoolId: f.other.id, choice: 'community' });
    expect(f.community.verification(f.bob).status).toBe('none');
    f.service.join(f.bob, { schoolId: f.school.id, choice: 'community' });
    expect(f.community.verification(f.bob).status).toBe('verified');
    expect(f.service.workspace(f.alice).community).toEqual({ verification: { status: 'none', method: null }, incomingRequests: 0, friendCount: 0, classmates: [], unreadChats: 0, chatPush: true, unreadAt: expect.any(String) });
  });
});

describe('community limits and edge cases', () => {
  it('matches a listed domain and its subdomains in any case, but never a look-alike', () => {
    const f = fixture();
    // Stored straight in the column, so the mixed case and spacing are not cleaned up by the admin schema first.
    f.db.prepare('UPDATE schools SET email_domains=? WHERE id=?').run(' Students.Example.org ,other.edu', f.school.id);
    const joined = (email: string) => { const id = f.user(email); f.service.join(id, { schoolId: f.school.id, choice: 'community' }); return f.community.verification(id).status; };
    expect(joined('sub@mail.students.example.org')).toBe('verified');
    expect(joined('LOUD@STUDENTS.EXAMPLE.ORG')).toBe('verified');
    expect(joined('x@Deep.Mail.Other.EDU')).toBe('verified');
    expect(joined('evil@evilstudents.example.org')).toBe('none');
    expect(joined('trick@students.example.org.evil.com')).toBe('none');
    expect(joined('near@example.org')).toBe('none');
  });
  it('stops proof requests after three declines in a week, and allows them again once one is older than seven days', async () => {
    const f = fixture();
    for (let round = 0; round < 3; round += 1) {
      f.community.requestVerification(f.bob, { proof: `Proof of enrollment, attempt ${round + 1}` });
      f.community.decideVerification(f.owner, f.community.verificationRequests(f.owner)[0]!.id, false);
    }
    expect(() => f.community.requestVerification(f.bob, { proof: 'A fourth try this week' })).toThrow('declined three requests');
    await expect(f.caller(f.bob).community.requestVerification({ accountId: f.bob, proof: 'A fourth try this week' })).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
    const oldest = f.db.prepare("SELECT id FROM verification_requests WHERE user_id=? ORDER BY resolved_at LIMIT 1").get(f.bob) as { id: string };
    f.db.prepare('UPDATE verification_requests SET resolved_at=? WHERE id=?').run(new Date(Date.now() - 8 * 86400000).toISOString(), oldest.id);
    expect(f.community.requestVerification(f.bob, { proof: 'A fresh try after a week' }).status).toBe('pending');
  });
  it('caps pending friend requests at FRIEND_REQUEST_LIMIT, and an answer frees a slot', () => {
    const f = fixture();
    const others = Array.from({ length: FRIEND_REQUEST_LIMIT + 1 }, (_, index) => f.user(undefined, `Friend ${index}`));
    for (const id of others) f.service.join(id, { schoolId: f.school.id, choice: 'community' });
    for (const id of others.slice(0, FRIEND_REQUEST_LIMIT)) expect(f.community.request(f.alice, id)).toBe('requested');
    expect(() => f.community.request(f.alice, others[FRIEND_REQUEST_LIMIT]!)).toThrow(`${FRIEND_REQUEST_LIMIT} requests waiting`);
    // Accepting an incoming request is never blocked by the limit.
    f.community.request(f.bob, f.alice);
    expect(f.community.request(f.alice, f.bob)).toBe('friends');
    f.community.respond(others[0]!, f.alice, false);
    expect(f.community.request(f.alice, others[FRIEND_REQUEST_LIMIT]!)).toBe('requested');
  });
  it('caps open member reports at ten until support resolves one', () => {
    const f = fixture();
    for (let index = 0; index < 10; index += 1) f.community.report(f.alice, { userId: f.bob, reason: `Report number ${index + 1} about this member.` });
    expect(() => f.community.report(f.alice, { userId: f.bob, reason: 'One report more than the limit.' })).toThrow('ten open reports');
    f.community.resolveReport(f.owner, f.community.reports(f.owner)[0]!.id, 'dismissed');
    f.community.report(f.alice, { userId: f.bob, reason: 'A report after one was resolved.' });
  });
  it('deletes the school verification when support removes a member', () => {
    const f = fixture();
    f.community.requestVerification(f.bob, { proof: 'Proof of enrollment attached' });
    f.community.decideVerification(f.owner, f.community.verificationRequests(f.owner)[0]!.id, true);
    expect(f.community.isVerified(f.bob, f.school.id)).toBe(true);
    f.community.removeFromSchool(f.owner, f.bob, f.school.id, 'Impersonation');
    expect(f.db.prepare('SELECT 1 FROM school_verifications WHERE user_id=? AND school_id=?').get(f.bob, f.school.id)).toBeUndefined();
    expect(f.community.isVerified(f.bob, f.school.id)).toBe(false);
  });
});

describe('directory, profiles and friendship', () => {
  it('lists only schoolmates, shows full names only between verified members, and never lets anyone hide', () => {
    const f = fixture();
    const list = f.community.members(f.alice);
    expect(list.members.map(member => member.displayName)).toEqual(['Bob']);
    expect(list.members[0]).toMatchObject({ fullName: null, grade: '11', verified: false, friendState: 'none' });
    expect(() => f.community.members(f.user())).toThrow('Join a school');
    f.db.prepare('INSERT INTO school_verifications(user_id,school_id,method,verified_at) VALUES(?,?,?,?),(?,?,?,?)').run(f.alice, f.school.id, 'support', 'now', f.bob, f.school.id, 'support', 'now');
    expect(f.community.members(f.alice).members[0]!.fullName).toBe('Bob Fullname');
    f.db.prepare('DELETE FROM school_verifications WHERE user_id=?').run(f.alice);
    expect(f.community.members(f.alice).members[0]!.fullName).toBeNull();
    expect(f.community.members(f.bob).members[0]!.fullName).toBeNull();
    expect(() => f.community.profile(f.outsider, f.alice)).toThrow('not available');
  });
  it('shares classes and the personal schedule only through an accepted friendship, and revokes on removal', () => {
    const f = fixture();
    seedClasses(f, f.bob);
    expect(f.community.profile(f.alice, f.bob).shared).toBeNull();
    expect(f.community.request(f.alice, f.bob)).toBe('requested');
    expect(f.community.request(f.alice, f.bob)).toBe('requested');
    expect(f.community.profile(f.alice, f.bob).shared).toBeNull();
    expect(f.community.friends(f.bob).incoming.map(member => member.id)).toEqual([f.alice]);
    expect(f.service.workspace(f.bob).community.incomingRequests).toBe(1);
    expect(() => f.community.respond(f.alice, f.bob, true)).toThrow('no request');
    expect(f.community.respond(f.bob, f.alice, true)).toBe('friends');
    const profile = f.community.profile(f.alice, f.bob);
    expect(profile.shared?.classes.map(cls => cls.name)).toEqual(['Algebra']);
    expect(profile.shared?.personal.assignments).toEqual({ A: 'c1' });
    expect(f.community.friends(f.alice).friends[0]).toMatchObject({ id: f.bob, friendState: 'friends' });
    expect(f.community.remove(f.bob, f.alice)).toBe('none');
    expect(f.community.profile(f.alice, f.bob).shared).toBeNull();
    expect(f.service.workspace(f.alice).community.friendCount).toBe(0);
  });
  it('turns a crossing request into a friendship and rejects requests across schools', () => {
    const f = fixture();
    f.community.request(f.alice, f.bob);
    expect(f.community.request(f.bob, f.alice)).toBe('friends');
    expect(() => f.community.request(f.alice, f.outsider)).toThrow('not available');
    expect(() => f.community.request(f.alice, f.alice)).toThrow('yourself');
  });
  it('drops a pending request instead of accepting it once the two are at different schools', () => {
    const f = fixture();
    f.community.request(f.alice, f.bob);
    f.service.join(f.bob, { schoolId: f.other.id, choice: 'community' });
    expect(f.community.friends(f.bob).incoming.map(member => member.id)).toEqual([f.alice]);
    expect(() => f.community.respond(f.bob, f.alice, true)).toThrow('no longer available');
    expect(f.community.areFriends(f.alice, f.bob)).toBe(false);
    expect(f.community.friends(f.bob).incoming).toHaveLength(0);
    expect(f.community.friends(f.alice).outgoing).toHaveLength(0);
    // Declining a request across schools still works.
    f.community.request(f.outsider, f.bob);
    f.service.join(f.bob, { schoolId: f.school.id, choice: 'community' });
    expect(f.community.respond(f.bob, f.outsider, false)).toBe('none');
    expect(f.community.friends(f.outsider).outgoing).toHaveLength(0);
  });
  it('blocks hide both people, end friendships, and reports reach support, who can remove a member', async () => {
    const f = fixture();
    f.community.request(f.alice, f.bob); f.community.respond(f.bob, f.alice, true);
    f.community.block(f.alice, f.bob, true);
    expect(f.community.members(f.alice).members).toHaveLength(0);
    expect(f.community.members(f.bob).members).toHaveLength(0);
    expect(() => f.community.profile(f.bob, f.alice)).toThrow('not available');
    expect(f.community.profile(f.alice, f.bob)).toMatchObject({ blocked: true, friendState: 'none', shared: null });
    expect(() => f.community.request(f.bob, f.alice)).toThrow('not available');
    expect(f.community.friends(f.alice).blocked.map(member => member.id)).toEqual([f.bob]);
    f.community.block(f.alice, f.bob, false);
    expect(f.community.members(f.alice).members[0]?.friendState).toBe('none');
    f.community.report(f.alice, { userId: f.bob, reason: 'Fake account impersonating a teacher.' });
    const reports = f.community.reports(f.owner);
    expect(reports[0]).toMatchObject({ reportedId: f.bob, reporterName: 'Alice', schoolName: 'Community High' });
    await expect(f.caller(f.alice).admin.reports()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    f.community.removeFromSchool(f.owner, f.bob, f.school.id, 'Impersonation');
    expect(f.service.user(f.bob).schoolId).toBeNull();
    expect(f.community.reports(f.owner)).toHaveLength(0);
    expect(() => f.service.join(f.bob, { schoolId: f.school.id, choice: 'community' })).toThrow('removed you');
    f.service.join(f.bob, { schoolId: f.other.id, choice: 'community' });
  });
  it('binds community mutations to the signed-in account', async () => {
    const f = fixture();
    await expect(f.caller(f.alice).community.request({ accountId: f.bob, userId: f.bob })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(f.caller(null).community.members({ query: '' })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(await f.caller(f.alice).community.request({ accountId: f.alice, userId: f.bob })).toBe('requested');
  });
});

describe('schedule-change voting', () => {
  function lockedFixture() {
    const f = fixture();
    const members = [f.alice, f.bob, ...Array.from({ length: 8 }, (_, index) => f.user(undefined, `Member ${index}`))];
    for (const id of members.slice(2)) f.service.join(id, { schoolId: f.school.id, choice: 'community' });
    expect(f.service.school(f.school.id).memberLocked).toBe(true);
    for (const id of members.slice(0, 5)) f.db.prepare('INSERT INTO school_verifications(user_id,school_id,method,verified_at) VALUES(?,?,?,?)').run(id, f.school.id, 'support', 'now');
    const proposals = new ProposalService(f.service);
    const changed = { ...exampleSchedule, periods: exampleSchedule.periods.map(period => period.id === 'A' ? { ...period, label: 'Block A' } : period) };
    return { ...f, members, proposals, changed };
  }
  it('computes a threshold that stays reachable', () => {
    expect(voteThreshold(0)).toBe(3); expect(voteThreshold(10)).toBe(3); expect(voteThreshold(50)).toBe(10); expect(voteThreshold(1000)).toBe(25);
  });
  it('requires a locked school and a verified proposer, then applies a passing proposal as a new unapproved revision', () => {
    const f = lockedFixture();
    const unverified = f.members[6]!;
    expect(() => f.proposals.create(unverified, { schoolId: f.school.id, baseVersion: 1, schedule: f.changed, summary: 'Rename period A to Block A' })).toThrow('Verify your school');
    expect(() => f.proposals.create(f.outsider, { schoolId: f.school.id, baseVersion: 1, schedule: f.changed, summary: 'Rename period A to Block A' })).toThrow('Only school members');
    const proposal = f.proposals.create(f.alice, { schoolId: f.school.id, baseVersion: 1, schedule: f.changed, summary: 'Rename period A to Block A' });
    expect(proposal).toMatchObject({ status: 'open', votesFor: 1, votesAgainst: 0, threshold: 3, myVote: 'for' });
    expect(() => f.proposals.create(f.alice, { schoolId: f.school.id, baseVersion: 1, schedule: f.changed, summary: 'A second one while open' })).toThrow('already have an open');
    expect(() => f.proposals.vote(unverified, { proposalId: proposal.id, vote: 'for' })).toThrow('Only verified');
    expect(() => f.proposals.vote(f.outsider, { proposalId: proposal.id, vote: 'for' })).toThrow('not found');
    expect(f.proposals.vote(f.bob, { proposalId: proposal.id, vote: 'against' }).status).toBe('open');
    expect(f.proposals.vote(f.members[2]!, { proposalId: proposal.id, vote: 'for' }).status).toBe('open');
    // 2 for, 1 against: threshold not reached. Bob changes his mind.
    const passed = f.proposals.vote(f.bob, { proposalId: proposal.id, vote: 'for' });
    expect(passed).toMatchObject({ status: 'passed', votesFor: 3, votesAgainst: 0 });
    const school = f.service.school(f.school.id);
    expect(school.version).toBe(2);
    expect(school.approved).toBe(false);
    expect(school.schedule.periods.find(period => period.id === 'A')?.label).toBe('Block A');
    expect(() => f.proposals.vote(f.members[3]!, { proposalId: proposal.id, vote: 'for' })).toThrow('closed');
    expect(f.service.workspace(f.members[7]!).review?.version).toBe(2);
  });
  it('rejects, withdraws and supersedes proposals, and leaves support-locked schools to the owner', () => {
    const f = lockedFixture();
    const rejected = f.proposals.create(f.alice, { schoolId: f.school.id, baseVersion: 1, schedule: f.changed, summary: 'Rename period A to Block A' });
    for (const id of [f.bob, f.members[2]!, f.members[3]!]) f.proposals.vote(id, { proposalId: rejected.id, vote: 'against' });
    expect(f.proposals.list(f.alice).proposals[0]!.status).toBe('rejected');
    const withdrawn = f.proposals.create(f.alice, { schoolId: f.school.id, baseVersion: 1, schedule: f.changed, summary: 'Try again with a summary' });
    expect(() => f.proposals.withdraw(f.bob, withdrawn.id)).toThrow('no open proposal');
    f.proposals.withdraw(f.alice, withdrawn.id);
    const superseded = f.proposals.create(f.alice, { schoolId: f.school.id, baseVersion: 1, schedule: f.changed, summary: 'Third attempt with a summary' });
    f.service.updateSchool(f.owner, { schoolId: f.school.id, expectedVersion: 1, schedule: exampleSchedule, approved: true, supportLocked: true }, true);
    expect(f.proposals.list(f.alice).proposals.find(entry => entry.id === superseded.id)?.status).toBe('superseded');
    expect(() => f.proposals.create(f.alice, { schoolId: f.school.id, baseVersion: 1, schedule: f.changed, summary: 'Stale base version here' })).toThrow('changed');
    const awaiting = f.proposals.create(f.alice, { schoolId: f.school.id, baseVersion: 2, schedule: { ...f.changed, version: exampleSchedule.version }, summary: 'Rename A on a locked school' });
    f.proposals.vote(f.bob, { proposalId: awaiting.id, vote: 'for' });
    expect(f.proposals.vote(f.members[2]!, { proposalId: awaiting.id, vote: 'for' }).status).toBe('awaiting-support');
    expect(f.service.school(f.school.id).version).toBe(2);
    expect(f.proposals.awaitingSupport(f.owner).map(entry => entry.id)).toEqual([awaiting.id]);
    expect(() => f.proposals.awaitingSupport(f.alice)).toThrow('Owner access');
    f.proposals.decide(f.owner, awaiting.id, true);
    const school = f.service.school(f.school.id);
    expect(school).toMatchObject({ version: 3, approved: true, supportLocked: true });
    expect(school.schedule.periods.find(period => period.id === 'A')?.label).toBe('Block A');
    expect(f.proposals.list(f.alice).proposals.find(entry => entry.id === awaiting.id)?.status).toBe('passed');
  });
  it('keeps open proposals on the board however many newer ones were withdrawn', () => {
    const f = lockedFixture();
    const open = f.proposals.create(f.alice, { schoolId: f.school.id, baseVersion: 1, schedule: f.changed, summary: 'Rename period A to Block A' });
    f.db.prepare('UPDATE schedule_proposals SET created_at=? WHERE id=?').run('2000-01-01T00:00:00.000Z', open.id);
    for (let index = 0; index < 50; index += 1) {
      const churn = f.proposals.create(f.bob, { schoolId: f.school.id, baseVersion: 1, schedule: f.changed, summary: `Churn proposal ${index}` });
      f.proposals.withdraw(f.bob, churn.id);
    }
    const listed = f.proposals.list(f.members[2]!).proposals;
    expect(listed).toHaveLength(50);
    expect(listed[0]).toMatchObject({ id: open.id, status: 'open' });
  });
  it('rejects a tie at or above the threshold, which only a falling threshold can produce', () => {
    const f = lockedFixture();
    const extra = Array.from({ length: 6 }, (_, index) => f.user(undefined, `Extra ${index}`));
    for (const id of extra) f.service.join(id, { schoolId: f.school.id, choice: 'community' });
    for (const id of [...f.members.slice(5), ...extra]) f.db.prepare('INSERT INTO school_verifications(user_id,school_id,method,verified_at) VALUES(?,?,?,?)').run(id, f.school.id, 'support', 'now');
    // 16 verified members: the threshold is 4, so 2 for and 3 against stays open.
    const proposal = f.proposals.create(f.alice, { schoolId: f.school.id, baseVersion: 1, schedule: f.changed, summary: 'Rename period A to Block A' });
    f.proposals.vote(f.members[4]!, { proposalId: proposal.id, vote: 'for' });
    for (const id of [f.bob, f.members[2]!, f.members[3]!]) f.proposals.vote(id, { proposalId: proposal.id, vote: 'against' });
    expect(f.proposals.list(f.alice)).toMatchObject({ threshold: 4, proposals: [{ status: 'open', votesFor: 2, votesAgainst: 3 }] });
    // Two non-voters lose verification: 14 verified members, threshold 3. The next "for" vote makes it 3–3, which rejects.
    for (const id of extra.slice(0, 2)) f.community.revokeVerification(f.owner, id, f.school.id);
    expect(f.proposals.vote(f.members[5]!, { proposalId: proposal.id, vote: 'for' })).toMatchObject({ status: 'rejected', votesFor: 3, votesAgainst: 3 });
    expect(f.service.school(f.school.id).version).toBe(1);
  });
  it('keeps a closed proposal\'s counts after its voters leave, and raw counts for one closed before tallies were stored', () => {
    const f = lockedFixture();
    const passed = f.proposals.create(f.alice, { schoolId: f.school.id, baseVersion: 1, schedule: f.changed, summary: 'Rename period A to Block A' });
    f.proposals.vote(f.bob, { proposalId: passed.id, vote: 'for' });
    expect(f.proposals.vote(f.members[2]!, { proposalId: passed.id, vote: 'for' })).toMatchObject({ status: 'passed', votesFor: 3 });
    f.service.join(f.members[2]!, { schoolId: f.other.id, choice: 'community' });
    f.community.revokeVerification(f.owner, f.bob, f.school.id);
    // The school then grows to 25 verified members, so the live threshold is 5.
    const extra = Array.from({ length: 17 }, (_, index) => f.user(undefined, `Extra ${index}`));
    for (const id of extra) f.service.join(id, { schoolId: f.school.id, choice: 'community' });
    for (const id of [...f.members.slice(5), ...extra]) f.db.prepare('INSERT OR IGNORE INTO school_verifications(user_id,school_id,method,verified_at) VALUES(?,?,?,?)').run(id, f.school.id, 'support', 'now');
    expect(f.proposals.list(f.alice).threshold).toBe(5);
    const shown = (id: string) => f.proposals.list(f.alice).proposals.find(entry => entry.id === id);
    // It still shows the 3-0 tally against the threshold of 3 that passed it, not "2 more votes needed".
    expect(shown(passed.id)).toMatchObject({ status: 'passed', votesFor: 3, votesAgainst: 0, threshold: 3 });
    // A proposal closed by an older build has no stored tally and shows every stored vote and the live threshold, as it did then.
    f.db.prepare('UPDATE schedule_proposals SET tally_for=NULL, tally_against=NULL, tally_threshold=NULL WHERE id=?').run(passed.id);
    expect(shown(passed.id)).toMatchObject({ votesFor: 3, votesAgainst: 0, threshold: 5 });
  });
  it('counts only votes from current verified members and withdraws the open proposals of members who leave', () => {
    const f = lockedFixture();
    const proposal = f.proposals.create(f.alice, { schoolId: f.school.id, baseVersion: 1, schedule: f.changed, summary: 'Rename period A to Block A' });
    f.proposals.vote(f.bob, { proposalId: proposal.id, vote: 'for' });
    // Support removes Bob: his vote stops counting, so one more vote does not reach the threshold of 3.
    f.community.removeFromSchool(f.owner, f.bob, f.school.id, 'Harassment in chat');
    expect(f.proposals.vote(f.members[2]!, { proposalId: proposal.id, vote: 'for' })).toMatchObject({ status: 'open', votesFor: 2 });
    expect(f.service.school(f.school.id).version).toBe(1);
    // A member who loses verification or switches schools stops counting too, including "against" votes.
    f.proposals.vote(f.members[3]!, { proposalId: proposal.id, vote: 'against' });
    f.community.revokeVerification(f.owner, f.members[3]!, f.school.id);
    expect(f.proposals.list(f.alice).proposals.find(entry => entry.id === proposal.id)).toMatchObject({ votesFor: 2, votesAgainst: 0 });
    f.service.join(f.members[2]!, { schoolId: f.other.id, choice: 'community' });
    expect(f.proposals.list(f.alice).proposals.find(entry => entry.id === proposal.id)).toMatchObject({ status: 'open', votesFor: 1 });
    // The departing proposer's own open proposal closes instead of staying live on its automatic vote.
    const status = (id: string) => (f.db.prepare('SELECT status FROM schedule_proposals WHERE id=?').get(id) as { status: string }).status;
    f.community.removeFromSchool(f.owner, f.alice, f.school.id, 'Spam proposals');
    expect(status(proposal.id)).toBe('withdrawn');
    const revoked = f.proposals.create(f.members[4]!, { schoolId: f.school.id, baseVersion: 1, schedule: f.changed, summary: 'Rename period A again' });
    f.community.revokeVerification(f.owner, f.members[4]!, f.school.id);
    expect(status(revoked.id)).toBe('withdrawn');
    f.db.prepare('INSERT INTO school_verifications(user_id,school_id,method,verified_at) VALUES(?,?,?,?)').run(f.members[5]!, f.school.id, 'support', 'now');
    const switched = f.proposals.create(f.members[5]!, { schoolId: f.school.id, baseVersion: 1, schedule: f.changed, summary: 'Rename period A once more' });
    f.service.join(f.members[5]!, { schoolId: f.other.id, choice: 'community' });
    expect(status(switched.id)).toBe('withdrawn');
  });
  it('tells support-locked small schools to send a correction instead of proposing', () => {
    const f = fixture();
    f.service.updateSchool(f.owner, { schoolId: f.school.id, expectedVersion: 1, schedule: exampleSchedule, approved: true, supportLocked: true }, true);
    f.db.prepare('INSERT INTO school_verifications(user_id,school_id,method,verified_at) VALUES(?,?,?,?)').run(f.alice, f.school.id, 'support', 'now');
    const proposals = new ProposalService(f.service);
    expect(proposals.list(f.alice)).toMatchObject({ canPropose: false, canVote: false });
    expect(() => proposals.create(f.alice, { schoolId: f.school.id, baseVersion: 2, schedule: exampleSchedule, summary: 'Rename period A to Block A' })).toThrow('correction request');
  });
  it('supersedes a proposal awaiting support once an admin save moves the revision, instead of offering an unpublishable one', () => {
    const f = lockedFixture();
    f.service.updateSchool(f.owner, { schoolId: f.school.id, expectedVersion: 1, schedule: exampleSchedule, approved: true, supportLocked: true }, true);
    const awaiting = f.proposals.create(f.alice, { schoolId: f.school.id, baseVersion: 2, schedule: { ...f.changed, version: exampleSchedule.version }, summary: 'Rename A on a locked school' });
    f.proposals.vote(f.bob, { proposalId: awaiting.id, vote: 'for' });
    expect(f.proposals.vote(f.members[2]!, { proposalId: awaiting.id, vote: 'for' }).status).toBe('awaiting-support');
    // A settings-only save (an email domain) still publishes a revision.
    f.service.updateSchool(f.owner, { schoolId: f.school.id, expectedVersion: 2, schedule: exampleSchedule, approved: true, supportLocked: true, emailDomains: ['students.example.org'] }, true);
    const status = () => (f.db.prepare('SELECT status FROM schedule_proposals WHERE id=?').get(awaiting.id) as { status: string }).status;
    expect(status()).toBe('superseded');
    expect(f.proposals.awaitingSupport(f.owner)).toEqual([]);
    expect(() => f.proposals.decide(f.owner, awaiting.id, true)).toThrow('no longer awaiting support');
    // A revision that moved some other way is caught when the owner opens the list or decides.
    f.db.prepare("UPDATE schedule_proposals SET status='awaiting-support', closed_at=NULL WHERE id=?").run(awaiting.id);
    expect(f.proposals.awaitingSupport(f.owner)).toEqual([]);
    expect(status()).toBe('superseded');
    f.db.prepare("UPDATE schedule_proposals SET status='awaiting-support', closed_at=NULL WHERE id=?").run(awaiting.id);
    expect(() => f.proposals.decide(f.owner, awaiting.id, true)).toThrow('no longer awaiting support');
    expect(status()).toBe('superseded');
    expect(f.service.school(f.school.id).version).toBe(3);
  });
  it('is unavailable to small schools that can edit directly', () => {
    const f = fixture();
    f.db.prepare('INSERT INTO school_verifications(user_id,school_id,method,verified_at) VALUES(?,?,?,?)').run(f.alice, f.school.id, 'support', 'now');
    const proposals = new ProposalService(f.service);
    expect(proposals.list(f.alice)).toMatchObject({ canPropose: false, canVote: false });
    expect(() => proposals.create(f.alice, { schoolId: f.school.id, baseVersion: 1, schedule: exampleSchedule, summary: 'No need for a vote here' })).toThrow('edit directly');
  });
});
