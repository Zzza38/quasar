import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
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
function fixture(members: number, verified = members) {
  const db = openDatabase(':memory:'); databases.push(db);
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
  it('a voted-in logo still waits for support, and publishing makes it the school’s logo', () => {
    const { service, logos, owner, students, school, outsider } = fixture(11, 10);
    const [alice, bob, cara, dan] = students;
    // Ten verified members: the threshold is three.
    expect(() => logos.propose(students[10], { schoolId: school.id, ...png() })).toThrow(/Verify your school membership/);
    const proposal = logos.propose(alice, { schoolId: school.id, ...png(1) });
    expect(proposal).toMatchObject({ status: 'open', votesFor: 1, votesAgainst: 0, threshold: 3, myVote: 'for', image: `/api/school-logos/proposals/${proposal.id}` });
    const rival = logos.propose(bob, { schoolId: school.id, ...png(2) });
    expect(logos.vote(cara, { proposalId: proposal.id, vote: 'for' }).status).toBe('open');
    expect(() => logos.vote(students[10], { proposalId: proposal.id, vote: 'for' })).toThrow(/Only verified members/);
    expect(() => logos.vote(outsider, { proposalId: proposal.id, vote: 'for' })).toThrow(/not found/);
    // The third vote passes it, which sends it to support and publishes nothing.
    expect(logos.vote(dan, { proposalId: proposal.id, vote: 'for' })).toMatchObject({ status: 'awaiting-support', votesFor: 3 });
    expect(service.school(school.id).logo).toBeNull();
    expect(() => logos.vote(bob, { proposalId: proposal.id, vote: 'against' })).toThrow(/closed/);
    // Members of the school and deciding staff can load the picture; other schools cannot.
    expect(logos.proposalImage(bob, proposal.id)?.mime).toBe('image/png');
    expect(logos.proposalImage(owner, proposal.id)).not.toBeNull();
    expect(logos.proposalImage(outsider, proposal.id)).toBeNull();

    expect(() => logos.decide(alice, proposal.id, true)).toThrow(/Staff access is required/);
    expect(logos.awaitingSupport(owner).map((entry) => [entry.id, entry.schoolName])).toEqual([[proposal.id, 'Logo High']]);
    logos.decide(owner, proposal.id, true);
    expect(service.school(school.id).logo).toBe(`/api/school-logos/${school.id}?v=1`);
    expect(logos.logoImage(school.id)?.bytes.at(-1)).toBe(1);
    const after = logos.list(alice);
    expect(after.logo).toBe(`/api/school-logos/${school.id}?v=1`);
    // The rival that was still being voted on is superseded.
    expect(after.proposals.map((entry) => [entry.id, entry.status]).sort()).toEqual([[proposal.id, 'published'], [rival.id, 'superseded']].sort());
    expect(() => logos.decide(owner, proposal.id, true)).toThrow(/no longer waiting/);
  });

  it('enough votes against reject a logo, and its proposer can withdraw one that is still open', () => {
    const { logos, students, school } = fixture(10);
    const proposal = logos.propose(students[0], { schoolId: school.id, ...png() });
    expect(() => logos.propose(students[0], { schoolId: school.id, ...png(3) })).toThrow(/already have a logo waiting/);
    for (const id of students.slice(1, 3)) logos.vote(id, { proposalId: proposal.id, vote: 'against' });
    expect(logos.vote(students[3], { proposalId: proposal.id, vote: 'against' })).toMatchObject({ status: 'rejected', votesFor: 1, votesAgainst: 3 });
    const second = logos.propose(students[0], { schoolId: school.id, ...png(4) });
    expect(() => logos.withdraw(students[1], second.id)).toThrow(/no waiting logo of yours/);
    logos.withdraw(students[0], second.id);
    expect(logos.list(students[0]).proposals.find((entry) => entry.id === second.id)?.status).toBe('withdrawn');
  });

  it('a school too small to vote sends a member’s logo straight to support, who can decline it', () => {
    const { service, logos, owner, students, school } = fixture(3, 0);
    const state = logos.list(students[1]);
    expect(state).toMatchObject({ voting: false, canPropose: true, canVote: false, canDecide: false, canSet: false, logo: null });
    const proposal = logos.propose(students[1], { schoolId: school.id, ...png() });
    expect(proposal).toMatchObject({ status: 'awaiting-support', votesFor: 0 });
    expect(() => logos.vote(students[2], { proposalId: proposal.id, vote: 'for' })).toThrow(/closed/);
    logos.decide(owner, proposal.id, false);
    expect(logos.list(students[1]).proposals[0].status).toBe('declined');
    expect(service.school(school.id).logo).toBeNull();
  });

  it('staff set and remove a logo directly, and the version keeps counting so an old address never comes back', () => {
    const { service, logos, owner, students, school } = fixture(3);
    expect(() => logos.set(students[0], { schoolId: school.id, ...png() })).toThrow(/Staff access is required/);
    const waiting = logos.propose(students[0], { schoolId: school.id, ...png(5) });
    expect(logos.set(owner, { schoolId: school.id, ...png(6) }).logo).toBe(`/api/school-logos/${school.id}?v=1`);
    expect(logos.list(students[0]).proposals.find((entry) => entry.id === waiting.id)?.status).toBe('superseded');
    logos.remove(owner, school.id);
    expect(service.school(school.id).logo).toBeNull();
    expect(logos.logoImage(school.id)).toBeNull();
    expect(() => logos.remove(owner, school.id)).toThrow(/has no logo/);
    expect(logos.set(owner, { schoolId: school.id, ...png(7) }).logo).toBe(`/api/school-logos/${school.id}?v=3`);
  });

  it('refuses anything that is not a PNG, WebP or JPEG, and members of another school', async () => {
    const { service, logos, students, school, outsider } = fixture(3);
    expect(() => logos.propose(students[0], { schoolId: school.id, mime: 'image/png', data: Buffer.from('<svg onload=alert(1)>').toString('base64') })).toThrow(/PNG, WebP or JPEG/);
    expect(() => logos.propose(outsider, { schoolId: school.id, ...png() })).toThrow(/Only school members/);
    const caller = appRouter.createCaller({ service, userId: students[0] });
    await expect(caller.schoolLogo.propose({ accountId: students[0], schoolId: school.id, mime: 'image/svg+xml' as never, data: 'AAAA' })).rejects.toThrow();
    expect((await caller.schoolLogo.list()).proposals).toEqual([]);
    await expect(caller.admin.setSchoolLogo({ schoolId: school.id, ...png() })).rejects.toThrow();
  });
});
