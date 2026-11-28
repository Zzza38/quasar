import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { ADMIN_SIGN_IN_MAX_AGE_MS, ADMIN_REAUTH_MESSAGE } from '@/lib/admin-session';
import { exampleSchedule } from '@/domain/example';
import { openDatabase, type Db } from './db';
import { Service } from './service';
import { grantStaffRole, revokeStaffRole } from './staff';
import { appRouter } from './router';

const dbs: Db[] = [];
afterEach(() => { vi.useRealTimers(); for (const db of dbs.splice(0)) if (db.open) db.close(); });

function fixture(path = ':memory:') {
  const db = openDatabase(path);
  dbs.push(db);
  const service = new Service(db, 'owner@example.org');
  function user(name: string) {
    const id = randomUUID();
    db.prepare('INSERT INTO users(id,google_sub,email,display_name,full_name,created_at) VALUES(?,?,?,?,?,?)')
      .run(id, id, name.toLowerCase() + '@example.org', name, name, new Date().toISOString());
    return id;
  }
  const owner = user('Owner'), manager = user('Manager'), student = user('Student'), other = user('Other');
  const east = service.createSchool(student, { name: 'East High', location: 'Reno', schedule: exampleSchedule }).id;
  const west = service.createSchool(other, { name: 'West High', location: 'Reno', schedule: exampleSchedule }).id;
  for (const id of [manager, student]) service.join(id, { schoolId: east, choice: 'community' });
  service.join(other, { schoolId: west, choice: 'community' });
  grantStaffRole(service, manager, 'school-manager');
  const api = (id: string | null, age = 0) => appRouter.createCaller({ userId: id, authAt: Date.now() - age, service }).announcements;
  const post = (id: string, schoolId: string | null, title: string, publishAt?: string) =>
    api(id).publish({ accountId: id, requestId: randomUUID(), schoolId, title, publishAt, body: 'Further details.' });
  const list = (id: string, before?: number) => api(id).list({ accountId: id, before });
  const unread = (id: string) => api(id).unread({ accountId: id });
  return { db, service, owner, manager, student, other, east, west, user, api, post, list, unread };
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

  it('shows platform announcements to a newly signed-in member before they join a school', async () => {
    const f = fixture();
    const member = f.user('New member');
    const global = await f.post(f.owner, null, 'Registration dates');
    const local = await f.post(f.manager, f.east, 'East High registration');
    expect((await f.list(member)).items.map(row => row.id)).toEqual([global.id]);
    expect(await f.unread(member)).toMatchObject({ id: global.id, canDelete: false });
    await expect(f.api(member).dismiss({ accountId: member, id: local.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await f.api(member).dismiss({ accountId: member, id: global.id });
    expect(await f.unread(member)).toBeNull();
  });

  it('keeps the posted text and each account’s dismissal when the app reopens its database', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'quasar-announcements-'));
    onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
    const path = join(directory, 'announcement-restart.sqlite');
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

  it('requires current audience authority and recent Google sign-in to publish', async () => {
    const f = fixture();
    const input = { accountId: f.manager, requestId: randomUUID(), schoolId: f.east, title: 'Update', body: 'Details.' };
    await expect(f.api(f.student).publish({ ...input, accountId: f.student })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    for (const scope of [null, f.west]) await expect(f.api(f.manager).publish({ ...input, schoolId: scope })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(f.api(f.manager, ADMIN_SIGN_IN_MAX_AGE_MS + 1_000).publish(input)).rejects.toMatchObject({ message: ADMIN_REAUTH_MESSAGE });
    const local = await f.api(f.manager).publish(input);
    expect((await f.list(f.manager)).items[0].id).toBe(local.id);
    f.service.join(f.manager, { schoolId: f.west, choice: 'community' });
    await expect(f.post(f.manager, f.west, 'New school')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    f.service.join(f.manager, { schoolId: f.east, choice: 'community' });
    revokeStaffRole(f.service, f.manager);
    await expect(f.api(f.manager).publish(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(f.api(null).list({ accountId: f.owner })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(f.list(f.student)).resolves.toMatchObject({ items: [{ id: local.id }] });
    f.db.prepare("UPDATE users SET suspended_at=datetime('now') WHERE id=?").run(f.owner);
    await expect(f.list(f.owner)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(f.unread(f.owner)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(f.post(f.owner, null, 'Platform news')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(f.api(f.owner).dismiss({ accountId: f.owner, id: local.id })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('activates a scheduled post at its UTC instant and keeps retries idempotent after release', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime('2030-01-01T10:00:00Z');
    const f = fixture();
    const input = { accountId: f.manager, requestId: randomUUID(), schoolId: f.east, title: 'Assembly', body: 'Meet in the gym.', publishAt: '2030-01-01T12:00:00Z' };
    for (const publishAt of ['2030-01-01T10:00:00Z', '2029-01-01T00:00:00Z', '2030-01-01T11:00:00', '2030-13-01T11:00:00Z']) {
      await expect(f.api(f.manager).publish({ ...input, publishAt })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    }
    const queued = await f.api(f.manager).publish(input);
    await expect(f.api(f.manager).publish({ ...input, publishAt: '2030-01-01T11:00:00Z' })).rejects.toMatchObject({ code: 'CONFLICT' });
    const now = await f.post(f.owner, f.east, 'Immediate post');
    await f.api(f.student).dismiss({ accountId: f.student, id: now.id });
    vi.setSystemTime('2030-01-01T11:59:59.999Z');
    expect((await f.list(f.student)).items.map(row => row.id)).toEqual([now.id]);
    expect(await f.unread(f.student)).toBeNull();
    await expect(f.api(f.student).dismiss({ accountId: f.student, id: queued.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await f.api(f.manager).upcoming({ accountId: f.manager })).toMatchObject([{ id: queued.id, publishAt: '2030-01-01T12:00:00.000Z' }]);
    vi.setSystemTime('2030-01-01T12:00:00.000Z');
    expect(await f.api(f.manager).publish(input)).toEqual(queued);
    expect(await f.api(f.manager).upcoming({ accountId: f.manager })).toEqual([]);
    expect((await f.list(f.student)).items.map(row => row.id)).toEqual([queued.id, now.id]);
    expect(await f.unread(f.student)).toMatchObject({ id: queued.id, createdAt: '2030-01-01T10:00:00.000Z', publishAt: '2030-01-01T12:00:00.000Z' });
    await expect(f.api(f.manager).cancel({ accountId: f.manager, id: queued.id })).rejects.toMatchObject({ code: 'CONFLICT' });
    await f.api(f.student).dismiss({ accountId: f.student, id: queued.id });
    expect(await f.unread(f.student)).toBeNull();
    expect(await f.unread(f.other)).toBeNull();
  });

  it('shows or cancels upcoming posts only within the current publisher’s audience', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime('2030-01-01T10:00:00Z');
    const f = fixture();
    const when = '2030-01-02T12:00:00.000Z';
    const global = await f.post(f.owner, null, 'Platform', when);
    const local = await f.post(f.manager, f.east, 'East', when);
    const away = await f.post(f.owner, f.west, 'West', '2030-01-02T11:00:00.000Z');
    const queue = (userId: string) => f.api(userId).upcoming({ accountId: userId });
    expect((await queue(f.owner)).map(row => row.id)).toEqual([away.id, global.id, local.id]);
    expect((await queue(f.manager)).map(row => row.id)).toEqual([local.id]);
    for (const id of [global.id, away.id]) await expect(f.api(f.manager).cancel({ accountId: f.manager, id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(queue(f.student)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(f.api(f.student).cancel({ accountId: f.student, id: local.id })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(f.api(f.manager).upcoming({ accountId: f.owner })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    const stale = f.api(f.manager, ADMIN_SIGN_IN_MAX_AGE_MS + 1000);
    await expect(stale.upcoming({ accountId: f.manager })).rejects.toMatchObject({ message: ADMIN_REAUTH_MESSAGE });
    await expect(stale.cancel({ accountId: f.manager, id: local.id })).rejects.toMatchObject({ message: ADMIN_REAUTH_MESSAGE });
    for (let retry = 0; retry < 2; retry++) await f.api(f.manager).cancel({ accountId: f.manager, id: local.id });
    expect(await queue(f.manager)).toEqual([]);
    expect(f.db.prepare("SELECT count(*) AS n FROM audit_log WHERE action='announcement.cancel' AND actor_id=? AND school_id=?").get(f.manager, f.east)).toEqual({ n: 1 });
    vi.setSystemTime(when);
    expect((await f.list(f.student)).items.map(row => row.id)).toEqual([global.id]);
    expect((await f.unread(f.student))?.id).toBe(global.id);
    await expect(f.api(f.student).dismiss({ accountId: f.student, id: local.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('lets the owner manage all published posts and managers only their own at their assigned school', async () => {
    const f = fixture();
    grantStaffRole(f.service, f.student, 'school-manager');
    const input = { accountId: f.manager, requestId: randomUUID(), schoolId: f.east, title: 'Assembly', body: 'Meet in the gym.' };
    const mine = await f.api(f.manager).publish(input);
    const theirs = await f.post(f.student, f.east, 'After school pickup');
    const global = await f.post(f.owner, null, 'Welcome');
    const away = await f.post(f.owner, f.west, 'Field trip');
    const pending = await f.post(f.student, f.east, 'Tomorrow', new Date(Date.now() + 60_000).toISOString());
    const manage = (id: string) => f.api(id).management({ accountId: id });
    const remove = (id: string, post: number) => f.api(id).remove({ accountId: id, id: post });
    expect((await manage(f.owner)).items.map(row => row.id)).toEqual([away.id, global.id, theirs.id, mine.id]);
    expect((await f.list(f.owner)).items.map(row => row.id)).toEqual([global.id]);
    expect((await manage(f.manager)).items.map(row => row.id)).toEqual([mine.id]);
    expect((await f.list(f.manager)).items.map(row => [row.id, row.canDelete])).toEqual([[global.id, false], [theirs.id, false], [mine.id, true]]);
    expect((await f.list(f.other)).items.every(row => !row.canDelete)).toBe(true);
    expect((await f.api(f.manager).upcoming({ accountId: f.manager })).map(row => [row.id, row.canDelete])).toEqual([[pending.id, false]]);
    await expect(f.api(f.manager).cancel({ accountId: f.manager, id: pending.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(remove(f.student, pending.id)).rejects.toMatchObject({ code: 'CONFLICT' });
    for (const target of [theirs.id, away.id, global.id]) await expect(remove(f.manager, target)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const stale = f.api(f.manager, ADMIN_SIGN_IN_MAX_AGE_MS + 1000);
    await expect(stale.management({ accountId: f.manager })).rejects.toMatchObject({ message: ADMIN_REAUTH_MESSAGE });
    await expect(stale.remove({ accountId: f.manager, id: mine.id })).rejects.toMatchObject({ message: ADMIN_REAUTH_MESSAGE });
    await expect(f.api(f.manager).remove({ accountId: f.student, id: theirs.id })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    for (const role of ['support', 'chat-moderation', 'administrator']) {
      grantStaffRole(f.service, f.other, role);
      await expect(manage(f.other)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(remove(f.other, away.id)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
    await remove(f.manager, mine.id);
    await remove(f.manager, mine.id);
    await expect(f.api(f.manager).publish(input)).rejects.toMatchObject({ code: 'CONFLICT' });
    await remove(f.owner, theirs.id);
    await remove(f.owner, away.id);
    await f.api(f.owner).cancel({ accountId: f.owner, id: pending.id });
    expect((await f.list(f.student)).items.map(row => row.id)).toEqual([global.id]);
    expect((await f.unread(f.other))?.id).toBe(global.id);
    expect((await manage(f.owner)).items.map(row => row.id)).toEqual([global.id]);
    await expect(f.api(f.manager).dismiss({ accountId: f.manager, id: mine.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(f.db.prepare("SELECT count(*) AS n FROM audit_log WHERE action='announcement.remove' AND actor_id=? AND school_id=?").get(f.manager, f.east)).toEqual({ n: 1 });
  });

  it('retains published pagination after the last item on a page is deleted', async () => {
    const f = fixture();
    for (let i = 0; i < 32; i++) await f.post(f.manager, f.east, 'Notice ' + i);
    const first = await f.api(f.owner).management({ accountId: f.owner });
    expect(first.items).toHaveLength(30);
    await f.api(f.owner).remove({ accountId: f.owner, id: first.nextBefore! });
    const older = await f.api(f.owner).management({ accountId: f.owner, before: first.nextBefore! });
    expect(older.items.map(row => row.title)).toEqual(['Notice 1', 'Notice 0']);
    expect((await f.list(f.student, first.nextBefore!)).items.map(row => row.title)).toEqual(['Notice 1', 'Notice 0']);
  });

  it('uses publication time and the ID tie breaker across page boundaries', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime('2030-01-01T10:00:00Z');
    const f = fixture();
    const latest = await f.post(f.owner, null, 'Scheduled first, released last', '2030-01-01T13:00:00Z');
    const tie = [];
    for (let i = 0; i < 31; i++) tie.push((await f.post(f.owner, null, 'Noon ' + i, '2030-01-01T12:00:00Z')).id);
    const immediate = await f.post(f.owner, null, 'Immediate and oldest');
    vi.setSystemTime('2030-01-01T14:00:00Z');
    const first = await f.list(f.student);
    const second = await f.list(f.student, first.nextBefore!);
    expect(first.items).toHaveLength(30);
    expect(second.nextBefore).toBeNull();
    expect([...first.items, ...second.items].map(row => row.id)).toEqual([latest.id, ...tie.reverse(), immediate.id]);
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
