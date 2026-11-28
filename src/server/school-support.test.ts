import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { exampleSchedule } from '@/domain/example';
import { CommunityService } from './community';
import { openDatabase, type Db } from './db';
import { appRouter } from './router';
import { Service } from './service';
import { grantStaffRole } from './staff';

const databases: Db[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

function fixture() {
  const db = openDatabase(':memory:');
  databases.push(db);
  const service = new Service(db, 'owner@example.com', '');
  function user(name: string) {
    const id = randomUUID();
    db.prepare('INSERT INTO users(id,google_sub,email,display_name,full_name,created_at) VALUES(?,?,?,?,?,?)')
      .run(id, id, `${name.toLowerCase()}@example.com`, name, name, new Date().toISOString());
    return id;
  }
  const owner = user('Owner'), helper = user('Helper'), local = user('Local'), foreign = user('Foreign');
  const school = service.createSchool(local, { name: 'Lakeside High', location: 'Boston, MA', schedule: exampleSchedule });
  const other = service.createSchool(foreign, { name: 'Mountain High', location: 'Denver, CO', schedule: exampleSchedule });
  service.join(local, { schoolId: school.id, choice: 'community' });
  service.join(helper, { schoolId: school.id, choice: 'community' });
  service.join(foreign, { schoolId: other.id, choice: 'community' });
  grantStaffRole(service, helper, 'support', undefined, 'school');
  const admin = (actor: string) => appRouter.createCaller({ service, userId: actor, authAt: Date.now() }).admin;
  return { db, service, owner, helper, local, foreign, school, other, community: new CommunityService(service), as: admin(helper), asOwner: admin(owner) };
}

describe('school-scoped Support', () => {
  it('handles local corrections without receiving site feedback, appeals, or another school’s requests', async () => {
    const f = fixture();
    f.service.requestCorrection(f.local, 'Our bell time should be 9:00.');
    f.service.requestCorrection(f.foreign, 'Our lunch period has moved.');
    f.service.feedback(f.local, 'A private sitewide support question.');
    const seeded = f.db.prepare('INSERT INTO support_requests(id,school_id,user_id,message,created_at,kind) VALUES(?,?,?,?,?,?)');
    for (const kind of ['appeal:ban', 'appeal:pause', 'beta:month-days']) seeded.run(randomUUID(), f.school.id, f.local, 'Private support case', new Date().toISOString(), kind);
    const visible = await f.as.requests();
    expect(visible).toMatchObject([{ userId: f.local, kind: 'school:correction' }]);
    const hidden = (await f.asOwner.requests()).filter(row => row.id !== visible[0].id);
    expect(hidden).toHaveLength(5);
    for (const row of hidden) {
      await expect(f.as.resolveRequest({ accountId: f.helper, id: row.id })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
    await f.as.resolveRequest({ accountId: f.helper, id: visible[0].id });
    expect(await f.as.requests()).toEqual([]);
    expect(await f.asOwner.requests()).toHaveLength(5);
  });

  it('limits enrollment proof, verification and member search to current students at the assigned school', async () => {
    const f = fixture();
    for (const userId of [f.local, f.foreign]) f.community.requestVerification(userId, { proof: 'Proof of my school enrollment' });
    const proofs = await f.as.verificationRequests();
    expect(proofs).toMatchObject([{ userId: f.local }]);
    const foreignProof = (await f.asOwner.verificationRequests()).find(row => row.userId === f.foreign)!;
    await expect(f.as.decideVerification({ id: foreignProof.id, approve: true })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect((await f.as.users.search({ query: '' })).map(row => row.id)).toEqual([f.local]);
    await expect(f.as.users.search({ schoolId: f.other.id, query: '' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(f.as.users.setVerified({ accountId: f.helper, userId: f.foreign, verified: true })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await f.as.decideVerification({ id: proofs[0].id, approve: true });
    expect(f.community.isVerified(f.local, f.school.id)).toBe(true);
    await f.as.users.setVerified({ accountId: f.helper, userId: f.local, verified: false });
    f.community.requestVerification(f.local, { proof: 'Updated proof of enrollment' });
    const [oldProof] = await f.as.verificationRequests();
    f.service.join(f.local, { schoolId: f.other.id, choice: 'community' });
    expect(await f.as.verificationRequests()).toEqual([]);
    await expect(f.as.decideVerification({ id: oldProof.id, approve: true })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(f.community.isVerified(f.local, f.school.id)).toBe(false);
  });

  it('keeps private records, global session controls, and manager operations unavailable even for local students', async () => {
    const f = fixture();
    const input = { accountId: f.helper, userId: f.local, reason: 'Following up on an enrollment question' };
    for (const request of [
      () => f.as.users.view(input),
      () => f.as.users.signOut(input),
      () => f.as.users.removeBrowsers(input),
      () => f.as.schoolActivity(),
      () => f.as.removeMember({ ...input, schoolId: f.school.id }),
      () => f.as.reports(),
    ]) await expect(request()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(await f.as.schools()).toMatchObject([{ id: f.school.id }]);
    expect(f.service.user(f.local).schoolId).toBe(f.school.id);
  });
});
