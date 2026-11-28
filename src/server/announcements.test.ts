import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ADMIN_SIGN_IN_MAX_AGE_MS, ADMIN_REAUTH_MESSAGE } from '@/lib/admin-session';
import { exampleSchedule } from '@/domain/example';
import { openDatabase, type Db } from './db';
import { Service } from './service';
import { BetaService } from './betas';
import { createBeta, currentBetaRegistry, removeBeta, writeBetaRegistry } from './beta-registry';
import { useStaffBetaFixture, joinStaffBeta } from './staff-beta-fixture';
import { grantStaffRole, revokeStaffRole } from './staff';
import { appRouter } from './router';

useStaffBetaFixture();
const dbs: Db[] = [];
afterEach(() => { for (const db of dbs.splice(0)) if (db.open) db.close(); });

function fixture(path = ':memory:') {
  const db = openDatabase(path);
  dbs.push(db);
  const service = new Service(db, 'owner@example.org');
  writeBetaRegistry(createBeta(currentBetaRegistry(), { key: 'announcements', name: 'Announcements', code: 'BOARDFIXTURE' }));
  const enroll = (id: string) => new BetaService(service).join(id, { code: 'BOARDFIXTURE' });
  function user(name: string) {
    const id = randomUUID();
    db.prepare('INSERT INTO users(id,google_sub,email,display_name,full_name,created_at) VALUES(?,?,?,?,?,?)')
      .run(id, id, name.toLowerCase() + '@example.org', name, name, new Date().toISOString());
    enroll(id);
    return id;
  }
  const owner = user('Owner'), manager = user('Manager'), student = user('Student'), other = user('Other');
  const east = service.createSchool(student, { name: 'East High', location: 'Reno', schedule: exampleSchedule }).id;
  const west = service.createSchool(other, { name: 'West High', location: 'Reno', schedule: exampleSchedule }).id;
  for (const id of [manager, student]) service.join(id, { schoolId: east, choice: 'community' });
  service.join(other, { schoolId: west, choice: 'community' });
  grantStaffRole(service, manager, 'school-manager');
  joinStaffBeta(service, manager);
  const api = (id: string | null, age = 0) => appRouter.createCaller({ userId: id, authAt: Date.now() - age, service }).announcements;
  const post = (id: string, schoolId: string | null, title: string) =>
    api(id).publish({ accountId: id, requestId: randomUUID(), schoolId, title, body: 'Further details.' });
  const list = (id: string, before?: number) => api(id).list({ accountId: id, before });
  const unread = (id: string) => api(id).unread({ accountId: id });
  return { db, service, owner, manager, student, other, east, west, api, post, list, unread };
}

describe('announcements', () => {
  it('keeps dismissed posts on the board and follows the reader’s school membership', async () => {
    const f = fixture();
    const global = await f.post(f.owner, null, 'Weekend update');
    const local = await f.post(f.manager, f.east, 'Assembly today');
    const away = await f.post(f.owner, f.west, 'West bus routes');
    const board = await f.list(f.student);
    expect(board.items.map(row => row.id)).toEqual([local.id, global.id]);
    expect(await f.unread(f.student)).toMatchObject({ id: local.id, authorName: 'Manager', schoolName: 'East High', dismissed: false });
    for (let retry = 0; retry < 2; retry++) await f.api(f.student).dismiss({ accountId: f.student, id: local.id });
    const after = await f.list(f.student);
    expect(after.items[0]).toMatchObject({ id: local.id, dismissed: true });
    expect((await f.unread(f.student))?.id).toBe(global.id);
    expect((await f.list(f.manager)).items[0].dismissed).toBe(true);
    expect((await f.list(f.owner)).items.map(row => row.id)).toEqual([global.id]);
    expect((await f.unread(f.other))?.id).toBe(away.id);
    await expect(f.api(f.student).dismiss({ accountId: f.student, id: away.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(f.api(f.student).dismiss({ accountId: f.manager, id: local.id })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    f.service.join(f.student, { schoolId: f.west, choice: 'community' });
    expect((await f.list(f.student)).items.map(row => row.id)).toEqual([away.id, global.id]);
    await expect(f.api(f.student).dismiss({ accountId: f.student, id: local.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('keeps the posted text and each account’s dismissal when the app reopens its database', async () => {
    const path = join(dirname(process.env.BETAS_PATH!), 'announcement-restart.sqlite');
    const f = fixture(path);
    const post = await f.post(f.manager, f.east, 'School doors open at nine');
    await f.api(f.student).dismiss({ accountId: f.student, id: post.id });
    f.db.close();
    const reopened = openDatabase(path);
    dbs.push(reopened);
    const api = appRouter.createCaller({ service: new Service(reopened, 'owner@example.org'), userId: f.student, authAt: Date.now() });
    const board = await api.announcements.list({ accountId: f.student });
    expect(board.items).toHaveLength(1);
    expect(board.items[0]).toMatchObject({ id: post.id, title: 'School doors open at nine', authorName: 'Manager', dismissed: true });
    expect(await api.announcements.unread({ accountId: f.student })).toBeNull();
  });

  it('requires current audience authority, recent Google sign-in and both applicable betas', async () => {
    const f = fixture();
    const input = { accountId: f.manager, requestId: randomUUID(), schoolId: f.east, title: 'Update', body: 'Details.' };
    await expect(f.api(f.student).publish({ ...input, accountId: f.student })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    for (const scope of [null, f.west]) await expect(f.api(f.manager).publish({ ...input, schoolId: scope })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(f.api(f.manager, ADMIN_SIGN_IN_MAX_AGE_MS + 1_000).publish(input)).rejects.toMatchObject({ message: ADMIN_REAUTH_MESSAGE });
    const local = await f.api(f.manager).publish(input);
    new BetaService(f.service).leave(f.manager, 'staff-roles');
    await expect(f.api(f.manager).publish(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect((await f.list(f.manager)).items[0].id).toBe(local.id);
    joinStaffBeta(f.service, f.manager);
    f.service.join(f.manager, { schoolId: f.west, choice: 'community' });
    await expect(f.post(f.manager, f.west, 'New school')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    f.service.join(f.manager, { schoolId: f.east, choice: 'community' });
    revokeStaffRole(f.service, f.manager);
    await expect(f.api(f.manager).publish(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    new BetaService(f.service).leave(f.owner, 'announcements');
    await expect(f.list(f.owner)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(f.unread(f.owner)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(f.post(f.owner, null, 'Platform news')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(f.api(f.owner).dismiss({ accountId: f.owner, id: local.id })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(f.api(null).list({ accountId: f.owner })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    writeBetaRegistry(removeBeta(currentBetaRegistry(), 'announcements'));
    await expect(f.list(f.student)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('validates text, keeps publishing idempotent and pages history without dropping older unread posts', async () => {
    const f = fixture();
    const input = { accountId: f.owner, requestId: randomUUID(), schoolId: null, title: ' First ', body: ' <b>plain text</b> ' };
    const oldest = await f.api(f.owner).publish(input);
    expect(await f.api(f.owner).publish(input)).toEqual(oldest);
    await expect(f.api(f.owner).publish({ ...input, body: 'New body' })).rejects.toMatchObject({ code: 'CONFLICT' });
    for (const bad of [{ title: ' ' }, { title: 'A'.repeat(121) }, { body: 'A'.repeat(4001) }, { body: 'a\u0000b' }]) {
      await expect(f.api(f.owner).publish({ ...input, ...bad })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    }
    for (let i = 0; i < 30; i++) {
      const next = await f.post(f.owner, null, 'Post ' + i);
      await f.api(f.student).dismiss({ accountId: f.student, id: next.id });
    }
    const first = await f.list(f.student);
    expect(first.items).toHaveLength(30);
    expect(first.items.every(row => row.dismissed)).toBe(true);
    expect(await f.unread(f.student)).toMatchObject({ id: oldest.id, title: 'First', body: '<b>plain text</b>' });
    const older = await f.list(f.student, first.nextBefore!);
    expect(older.items.map(row => row.id)).toEqual([oldest.id]);
    expect(older.nextBefore).toBeNull();
    await f.api(f.student).dismiss({ accountId: f.student, id: oldest.id });
    expect(await f.unread(f.student)).toBeNull();
    expect(f.db.prepare("SELECT count(*) AS n FROM audit_log WHERE action='announcement.publish'").get()).toEqual({ n: 31 });
  });
});
