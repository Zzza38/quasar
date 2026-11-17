import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, type Db } from './db';
import { Service } from './service';
import { SchoolLogoService } from './school-logos';
import { appRouter } from './router';
import { exampleSchedule } from '@/domain/example';

const databases: Db[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

/** The smallest thing imageBytesMatch accepts as a PNG; `tag` makes two pictures differ. */
const png = (tag = 0) => ({ mime: 'image/png' as const, data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, tag]).toString('base64') });

/** A school of `members` students, the first `verified` of them verified, plus the owner (who is not a member) and an outsider. */
function fixture(members: number, verified = members, path = ':memory:') {
  const db = openDatabase(path); if (path === ':memory:') databases.push(db);
  const service = new Service(db, 'owner@example.com');
  const user = (email = `${randomUUID()}@example.com`, name = 'Student') => {
    const id = randomUUID();
    db.prepare('INSERT INTO users(id,google_sub,email,display_name,full_name,created_at) VALUES(?,?,?,?,?,?)').run(id, id, email, name, `${name} Fullname`, new Date().toISOString());
    return id;
  };
  const owner = user('owner@example.com', 'Owner');
  const students = Array.from({ length: members }, (_, index) => user(undefined, `Student ${index}`));
  const school = service.createSchool(students[0], { name: 'Logo High', location: 'Boston, MA', schedule: exampleSchedule });
  for (const id of students) service.join(id, { schoolId: school.id, choice: 'community', grade: '10' });
  for (const id of students.slice(0, verified)) db.prepare('INSERT INTO school_verifications(user_id,school_id,method,verified_at) VALUES(?,?,?,?)').run(id, school.id, 'support', new Date().toISOString());
  const outsider = user(undefined, 'Outsider');
  const other = service.createSchool(outsider, { name: 'Other High', location: 'Boston, MA', schedule: exampleSchedule });
  service.join(outsider, { schoolId: other.id, choice: 'community' });
  return { db, service, logos: new SchoolLogoService(service), owner, students, school, outsider, other };
}

describe('school logos', () => {
  it('a logo that wins the vote is published at once, with nobody approving it', () => {
    const { service, logos, owner, students, school, outsider } = fixture(11, 10);
    const [alice, bob, cara, dan] = students;
    // Ten verified members: the threshold is three.
    expect(() => logos.propose(students[10], { schoolId: school.id, ...png() })).toThrow(/Verify your school membership/);
    const proposal = logos.propose(alice, { schoolId: school.id, ...png(1) });
    expect(proposal).toMatchObject({ status: 'open', votesFor: 1, votesAgainst: 0, threshold: 3, myVote: 'for', byStaff: false, image: `/api/school-logos/proposals/${proposal.id}` });
    const rival = logos.propose(bob, { schoolId: school.id, ...png(2) });
    expect(logos.vote(cara, { proposalId: proposal.id, vote: 'for' }).status).toBe('open');
    expect(service.school(school.id).logo).toBeNull();
    expect(() => logos.vote(students[10], { proposalId: proposal.id, vote: 'for' })).toThrow(/Only verified members/);
    expect(() => logos.vote(outsider, { proposalId: proposal.id, vote: 'for' })).toThrow(/not found/);
    // Members of the school and staff can load the picture; other schools cannot.
    expect(logos.proposalImage(bob, proposal.id)?.mime).toBe('image/png');
    expect(logos.proposalImage(owner, proposal.id)).not.toBeNull();
    expect(logos.proposalImage(outsider, proposal.id)).toBeNull();
    expect(logos.openVotes(owner).map((entry) => [entry.id, entry.schoolName])).toEqual([[proposal.id, 'Logo High'], [rival.id, 'Logo High']]);

    // The third vote passes it, and that is all it takes.
    expect(logos.vote(dan, { proposalId: proposal.id, vote: 'for' })).toMatchObject({ status: 'published', votesFor: 3, byStaff: false });
    expect(service.school(school.id).logo).toBe(`/api/school-logos/${school.id}?v=1`);
    expect(logos.logoImage(school.id)?.bytes.at(-1)).toBe(1);
    expect(() => logos.vote(bob, { proposalId: proposal.id, vote: 'against' })).toThrow(/closed/);
    const after = logos.list(alice);
    expect(after).toMatchObject({ logo: `/api/school-logos/${school.id}?v=1`, canForce: false, canSet: false, canRevert: false });
    // The rival that was still being voted on is superseded.
    expect(after.proposals.map((entry) => [entry.id, entry.status]).sort()).toEqual([[proposal.id, 'published'], [rival.id, 'superseded']].sort());
    expect(logos.openVotes(owner)).toEqual([]);
  });

  it('enough votes against reject a logo, and its proposer can withdraw one that is still open', () => {
    const { logos, students, school } = fixture(10);
    const proposal = logos.propose(students[0], { schoolId: school.id, ...png() });
    expect(() => logos.propose(students[0], { schoolId: school.id, ...png(3) })).toThrow(/already have a logo waiting/);
    for (const id of students.slice(1, 3)) logos.vote(id, { proposalId: proposal.id, vote: 'against' });
    expect(logos.vote(students[3], { proposalId: proposal.id, vote: 'against' })).toMatchObject({ status: 'rejected', votesFor: 1, votesAgainst: 3 });
    const second = logos.propose(students[0], { schoolId: school.id, ...png(4) });
    expect(() => logos.withdraw(students[1], second.id)).toThrow(/no open logo vote or request of yours/);
    logos.withdraw(students[0], second.id);
    expect(logos.list(students[0]).proposals.find((entry) => entry.id === second.id)?.status).toBe('withdrawn');
  });

  it('a school too small to vote publishes a member’s logo as soon as they add it', () => {
    const { service, logos, students, school } = fixture(3, 0);
    expect(logos.list(students[1])).toMatchObject({ voting: false, canPropose: true, canVote: false, canForce: false, canSet: false, logo: null });
    expect(logos.propose(students[1], { schoolId: school.id, ...png(1) })).toMatchObject({ status: 'published', votesFor: 0, byStaff: false });
    expect(service.school(school.id).logo).toBe(`/api/school-logos/${school.id}?v=1`);
    // Another member changes it the same way; nothing is left waiting.
    logos.propose(students[2], { schoolId: school.id, ...png(2) });
    expect(logos.logoImage(school.id)?.bytes.at(-1)).toBe(2);
    expect(logos.list(students[1]).proposals.map((entry) => entry.status)).toEqual(['published', 'published']);
  });

  it('staff force an open vote to win or to lose, and force a vote that already lost to win', () => {
    const { service, logos, owner, students, school } = fixture(10);
    const [alice, bob, cara] = students;
    const first = logos.propose(alice, { schoolId: school.id, ...png(1) });
    const second = logos.propose(bob, { schoolId: school.id, ...png(2) });
    expect(() => logos.force(alice, first.id, true)).toThrow(/Staff access is required/);
    // Forced to lose with one vote for and none against.
    logos.force(owner, first.id, false);
    expect(logos.list(alice).proposals.find((entry) => entry.id === first.id)).toMatchObject({ status: 'declined', byStaff: true, votesFor: 1 });
    expect(() => logos.vote(cara, { proposalId: first.id, vote: 'for' })).toThrow(/closed/);
    expect(() => logos.force(owner, first.id, false)).toThrow(/closed/);
    // Forced to win with one vote of the three it needs.
    logos.force(owner, second.id, true);
    expect(logos.list(alice).proposals.find((entry) => entry.id === second.id)).toMatchObject({ status: 'published', byStaff: true, votesFor: 1, threshold: 3 });
    expect(logos.logoImage(school.id)?.bytes.at(-1)).toBe(2);
    expect(() => logos.force(owner, second.id, true)).toThrow(/already published/);
    // The one that was forced to lose can still be forced to win, and so can one the school voted down.
    logos.force(owner, first.id, true);
    expect(logos.logoImage(school.id)?.bytes.at(-1)).toBe(1);
    expect(service.school(school.id).logo).toBe(`/api/school-logos/${school.id}?v=2`);
    const third = logos.propose(cara, { schoolId: school.id, ...png(3) });
    for (const id of students.slice(3, 6)) logos.vote(id, { proposalId: third.id, vote: 'against' });
    expect(logos.list(cara).proposals.find((entry) => entry.id === third.id)?.status).toBe('rejected');
    logos.force(owner, third.id, true);
    expect(logos.logoImage(school.id)?.bytes.at(-1)).toBe(3);
    // A withdrawn logo is its proposer's to bring back.
    const fourth = logos.propose(alice, { schoolId: school.id, ...png(4) });
    logos.withdraw(alice, fourth.id);
    expect(() => logos.force(owner, fourth.id, true)).toThrow(/withdrew/);
  });

  it('staff revert the last logo change, and reverting again steps back further', () => {
    const { service, logos, owner, students, school } = fixture(10);
    const [alice, bob, cara] = students;
    const address = (version: number) => `/api/school-logos/${school.id}?v=${version}`;
    expect(() => logos.revert(owner, school.id)).toThrow(/no logo change to revert/);
    // Version 1: the school votes one in.
    const voted = logos.propose(alice, { schoolId: school.id, ...png(1) });
    logos.vote(bob, { proposalId: voted.id, vote: 'for' });
    logos.vote(cara, { proposalId: voted.id, vote: 'for' });
    // Version 2: staff set another. Version 3: staff remove it.
    logos.set(owner, { schoolId: school.id, ...png(2) });
    logos.remove(owner, school.id);
    expect(service.school(school.id).logo).toBeNull();
    expect(() => logos.revert(alice, school.id)).toThrow(/Staff access is required/);
    expect(logos.forSchool(owner, school.id)).toMatchObject({ logo: null, canRevert: true });

    // Each revert undoes one change, and the address always moves forward so no cached picture comes back.
    expect(logos.revert(owner, school.id).logo).toBe(address(4));
    expect(logos.logoImage(school.id)?.bytes.at(-1)).toBe(2);
    expect(logos.revert(owner, school.id).logo).toBe(address(5));
    expect(logos.logoImage(school.id)?.bytes.at(-1)).toBe(1);
    expect(logos.list(alice).proposals.find((entry) => entry.id === voted.id)?.status).toBe('published');
    // Reverting the voted-in logo leaves the initials, and marks the vote as reverted by staff.
    expect(logos.revert(owner, school.id).logo).toBeNull();
    expect(logos.logoImage(school.id)).toBeNull();
    expect(logos.forSchool(owner, school.id)).toMatchObject({ logo: null, canRevert: false });
    expect(logos.forSchool(owner, school.id).proposals[0]).toMatchObject({ id: voted.id, status: 'reverted', byStaff: true, votesFor: 3 });
    expect(() => logos.revert(owner, school.id)).toThrow(/no logo change to revert/);
    // A reverted vote can be forced to win again.
    logos.force(owner, voted.id, true);
    expect(service.school(school.id).logo).toBe(address(7));
    expect(logos.logoImage(school.id)?.bytes.at(-1)).toBe(1);
  });

  it('staff set and remove a logo directly, and the version keeps counting so an old address never comes back', () => {
    const { service, logos, owner, students, school } = fixture(10);
    expect(() => logos.set(students[0], { schoolId: school.id, ...png() })).toThrow(/Staff access is required/);
    const waiting = logos.propose(students[0], { schoolId: school.id, ...png(5) });
    expect(logos.set(owner, { schoolId: school.id, ...png(6) }).logo).toBe(`/api/school-logos/${school.id}?v=1`);
    // Setting a logo deletes the vote that was open.
    expect(logos.list(students[0]).proposals.find((entry) => entry.id === waiting.id)).toBeUndefined();
    logos.remove(owner, school.id);
    expect(service.school(school.id).logo).toBeNull();
    expect(logos.logoImage(school.id)).toBeNull();
    expect(() => logos.remove(owner, school.id)).toThrow(/has no logo/);
    expect(logos.set(owner, { schoolId: school.id, ...png(7) }).logo).toBe(`/api/school-logos/${school.id}?v=3`);
  });

  it('a logo support set is locked: its votes are deleted, and a new logo is a request only support answers', () => {
    const { db, service, logos, owner, students, school, outsider } = fixture(11, 10);
    const [alice, bob, cara, dan] = students;
    const count = (table: string) => (db.prepare(`SELECT count(*) n FROM ${table}`).get() as { n: number }).n;
    // The school votes a logo in, votes one down, and has one vote still open.
    const voted = logos.propose(alice, { schoolId: school.id, ...png(1) });
    for (const id of [bob, cara]) logos.vote(id, { proposalId: voted.id, vote: 'for' });
    const lost = logos.propose(bob, { schoolId: school.id, ...png(2) });
    for (const id of [alice, cara, dan]) logos.vote(id, { proposalId: lost.id, vote: 'against' });
    const open = logos.propose(cara, { schoolId: school.id, ...png(3) });
    logos.vote(dan, { proposalId: open.id, vote: 'for' });
    expect(logos.list(alice)).toMatchObject({ locked: false, canPropose: true, canVote: true });

    // Support sets a logo. Every vote goes except the one that was the school's logo, which reverting can bring back.
    logos.set(owner, { schoolId: school.id, ...png(4) });
    expect(logos.list(alice)).toMatchObject({ locked: true, canPropose: true, canVote: false });
    expect(logos.list(alice).proposals.map((entry) => entry.id)).toEqual([voted.id]);
    expect(count('school_logo_proposals')).toBe(1);
    expect(count('school_logo_votes')).toBe(3);
    expect(logos.forSchool(owner, school.id)).toMatchObject({ locked: true });

    // A member's new logo is now a request: no vote, nothing published, and only they and support see it.
    const request = logos.propose(alice, { schoolId: school.id, ...png(5) });
    expect(request).toMatchObject({ status: 'requested', request: true, votesFor: 0, votesAgainst: 0, myVote: null });
    expect(count('school_logo_votes')).toBe(3);
    expect(logos.logoImage(school.id)?.bytes.at(-1)).toBe(4);
    expect(() => logos.propose(students[10], { schoolId: school.id, ...png() })).toThrow(/Verify your school membership/);
    expect(() => logos.propose(alice, { schoolId: school.id, ...png(6) })).toThrow(/already have a logo waiting/);
    expect(() => logos.vote(bob, { proposalId: request.id, vote: 'for' })).toThrow(/Support decides this logo/);
    expect(logos.list(bob).proposals.map((entry) => entry.id)).toEqual([voted.id]);
    expect(logos.proposalImage(bob, request.id)).toBeNull();
    expect(logos.proposalImage(alice, request.id)).not.toBeNull();
    expect(logos.proposalImage(owner, request.id)).not.toBeNull();
    expect(logos.proposalImage(outsider, request.id)).toBeNull();
    expect(logos.openVotes(owner).map((entry) => [entry.id, entry.status])).toEqual([[request.id, 'requested']]);
    expect(() => logos.force(alice, request.id, true)).toThrow(/Staff access is required/);

    // Support declines it. Its proposer can withdraw one that is still waiting.
    logos.force(owner, request.id, false);
    expect(logos.list(alice).proposals.find((entry) => entry.id === request.id)).toMatchObject({ status: 'declined', request: true, byStaff: true });
    const second = logos.propose(alice, { schoolId: school.id, ...png(6) });
    logos.withdraw(alice, second.id);
    expect(logos.openVotes(owner)).toEqual([]);

    // Support approves one, which closes the other request waiting. The logo stays locked, because support chose it.
    const third = logos.propose(alice, { schoolId: school.id, ...png(7) });
    const other = logos.propose(bob, { schoolId: school.id, ...png(8) });
    logos.force(owner, third.id, true);
    expect(logos.logoImage(school.id)?.bytes.at(-1)).toBe(7);
    expect(logos.list(alice)).toMatchObject({ locked: true, canVote: false });
    expect(logos.list(alice).proposals.find((entry) => entry.id === third.id)).toMatchObject({ status: 'published', request: true, byStaff: true });
    expect(logos.list(bob).proposals.find((entry) => entry.id === other.id)?.status).toBe('superseded');
    // A request support declined can still be approved later.
    logos.force(owner, request.id, true);
    expect(logos.logoImage(school.id)?.bytes.at(-1)).toBe(5);

    // Removing the logo lifts the lock, and the school votes again. Reverting the removal locks it again and deletes
    // the vote started in between, but not the requests.
    logos.remove(owner, school.id);
    expect(logos.list(alice)).toMatchObject({ locked: false, canVote: true });
    const again = logos.propose(dan, { schoolId: school.id, ...png(9) });
    expect(again).toMatchObject({ status: 'open', request: false, votesFor: 1 });
    logos.revert(owner, school.id);
    expect(logos.list(alice)).toMatchObject({ locked: true });
    expect(logos.forSchool(owner, school.id).proposals.map((entry) => entry.id).sort()).toEqual([voted.id, request.id, second.id, third.id, other.id].sort());
    // Reverting back to the logo the school voted in lifts the lock too.
    for (let step = 0; step < 3; step++) logos.revert(owner, school.id);
    expect(logos.logoImage(school.id)?.bytes.at(-1)).toBe(1);
    expect(logos.list(alice)).toMatchObject({ locked: false, canVote: true });
    expect(service.school(school.id).logo).not.toBeNull();
  });

  it('a vote support forced to win does not lock the logo, and a small school asks support the same way once it is locked', () => {
    const big = fixture(10);
    const proposal = big.logos.propose(big.students[0], { schoolId: big.school.id, ...png(1) });
    big.logos.force(big.owner, proposal.id, true);
    expect(big.logos.list(big.students[1])).toMatchObject({ locked: false, canVote: true });
    expect(big.logos.propose(big.students[1], { schoolId: big.school.id, ...png(2) }).status).toBe('open');

    const small = fixture(3, 0);
    small.logos.set(small.owner, { schoolId: small.school.id, ...png(3) });
    expect(small.logos.list(small.students[0])).toMatchObject({ voting: false, locked: true, canPropose: true });
    expect(small.logos.propose(small.students[0], { schoolId: small.school.id, ...png(4) })).toMatchObject({ status: 'requested', request: true });
    expect(small.logos.logoImage(small.school.id)?.bytes.at(-1)).toBe(3);
  });

  it('opening a database deletes the logo votes of a school whose logo support already set', () => {
    const directory = mkdtempSync(join(tmpdir(), 'quasar-logos-'));
    const path = join(directory, 'test.sqlite');
    const { db, logos, owner, students, school, other, outsider } = fixture(10, 10, path);
    logos.set(owner, { schoolId: school.id, ...png(1) });
    const request = logos.propose(students[2], { schoolId: school.id, ...png(4) });
    // Votes from before the rule: written straight into the tables, as an older build left them.
    const stale = randomUUID();
    db.prepare("INSERT INTO school_logo_proposals(id,school_id,proposer_id,image,mime,status,created_at) VALUES(?,?,?,?,?,'declined',?)").run(stale, school.id, students[0], Buffer.from([1]), 'image/png', new Date().toISOString());
    db.prepare('INSERT INTO school_logo_votes(proposal_id,user_id,vote,created_at) VALUES(?,?,?,?)').run(stale, students[1], 'for', new Date().toISOString());
    // Another school, whose logo support did not set, keeps its own.
    const kept = logos.propose(outsider, { schoolId: other.id, ...png(2) });
    db.close();
    const reopened = openDatabase(path); databases.push(reopened);
    try {
      const ids = (reopened.prepare('SELECT id FROM school_logo_proposals').all() as { id: string }[]).map((row) => row.id).sort();
      expect(ids).toEqual([request.id, kept.id].sort());
      expect((reopened.prepare('SELECT count(*) n FROM school_logo_votes WHERE proposal_id=?').get(stale) as { n: number }).n).toBe(0);
    } finally { reopened.close(); databases.splice(databases.indexOf(reopened), 1); rmSync(directory, { recursive: true, force: true }); }
  });

  it('refuses anything that is not a PNG, WebP or JPEG, and members of another school', async () => {
    const { service, logos, students, school, outsider } = fixture(3);
    expect(() => logos.propose(students[0], { schoolId: school.id, mime: 'image/png', data: Buffer.from('<svg onload=alert(1)>').toString('base64') })).toThrow(/PNG, WebP or JPEG/);
    expect(() => logos.propose(outsider, { schoolId: school.id, ...png() })).toThrow(/Only school members/);
    const caller = appRouter.createCaller({ service, userId: students[0] });
    await expect(caller.schoolLogo.propose({ accountId: students[0], schoolId: school.id, mime: 'image/svg+xml' as never, data: 'AAAA' })).rejects.toThrow();
    expect((await caller.schoolLogo.list()).proposals).toEqual([]);
    await expect(caller.admin.setSchoolLogo({ schoolId: school.id, ...png() })).rejects.toThrow();
    await expect(caller.admin.revertSchoolLogo({ schoolId: school.id })).rejects.toThrow();
    await expect(caller.admin.forceLogo({ id: school.id, win: true })).rejects.toThrow();
    await expect(caller.admin.schoolLogos({ schoolId: school.id })).rejects.toThrow();
  });
});
