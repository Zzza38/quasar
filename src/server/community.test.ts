import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { openDatabase, type Db } from './db';
import { Service } from './service';
import { CommunityService } from './community';
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
  it('is dormant after switching schools and never granted by Google sign-in alone', () => {
    const f = fixture();
    f.community.decideVerification(f.owner, (f.community.requestVerification(f.bob, { proof: 'Proof of enrollment attached' }), f.community.verificationRequests(f.owner)[0]!.id), true);
    expect(f.community.verification(f.bob).status).toBe('verified');
    f.service.join(f.bob, { schoolId: f.other.id, choice: 'community' });
    expect(f.community.verification(f.bob).status).toBe('none');
    f.service.join(f.bob, { schoolId: f.school.id, choice: 'community' });
    expect(f.community.verification(f.bob).status).toBe('verified');
    expect(f.service.workspace(f.alice).community).toEqual({ verification: { status: 'none', method: null }, incomingRequests: 0, friendCount: 0, classmates: [] });
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
  it('is unavailable to small schools that can edit directly', () => {
    const f = fixture();
    f.db.prepare('INSERT INTO school_verifications(user_id,school_id,method,verified_at) VALUES(?,?,?,?)').run(f.alice, f.school.id, 'support', 'now');
    const proposals = new ProposalService(f.service);
    expect(proposals.list(f.alice)).toMatchObject({ canPropose: false, canVote: false });
    expect(() => proposals.create(f.alice, { schoolId: f.school.id, baseVersion: 1, schedule: exampleSchedule, summary: 'No need for a vote here' })).toThrow('edit directly');
  });
});
