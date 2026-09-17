import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { appRouter } from './router';
import { Service } from './service';
import { generateVAPIDKeys } from 'web-push';
import { openDatabase, type Db } from './db';
import { NotificationService, pushSubscriptionSchema, reminderInstant } from './notifications';
import type { Task } from '@/domain/task';
const databases: Db[] = [];
afterEach(() => { databases.splice(0).forEach(db => db.close()); });
const vapid = { ...generateVAPIDKeys(), subject: 'mailto:owner@example.com' };
const subscription = (token = 'one') => ({ endpoint: `https://fcm.googleapis.com/fcm/send/${token}`, keys: { p256dh: vapid.publicKey, auth: Buffer.alloc(16, 1).toString('base64url') } });
const task: Task = { title: 'Private homework', dueDate: '2026-09-11', dueTime: '10:00', notes: '', classId: null, completed: false, reminder: { minutesBefore: 15, timeZone: 'America/New_York' } };
function fixture(sendPush = vi.fn().mockResolvedValue({})) {
  const db = openDatabase(':memory:'); databases.push(db);
  for (const id of ['one', 'two']) db.prepare('INSERT INTO users(id,google_sub,email,created_at) VALUES(?,?,?,?)').run(id, id, `${id}@example.com`, new Date().toISOString());
  const service = new NotificationService(db, { vapid, sendPush });
  const put = (value: Task = task, deleted = false) => db.prepare(`INSERT INTO entities(owner_id,id,kind,version,data,deleted) VALUES('one','task','task',1,?,?) ON CONFLICT(owner_id,id) DO UPDATE SET data=excluded.data,deleted=excluded.deleted`).run(JSON.stringify(value), Number(deleted));
  put(); service.subscribe('one', subscription());
  return { db, service, sendPush, put };
}
const due = new Date('2026-09-11T13:45:00Z');
describe('browser reminders', () => {
  it('uses local due dates, 09:00 for all-day tasks and compatible DST disambiguation', () => {
    expect(reminderInstant(task)).toBe('2026-09-11T13:45:00Z');
    expect(reminderInstant({ ...task, dueTime: null })).toBe('2026-09-11T12:45:00Z');
    expect(reminderInstant({ ...task, dueDate: '2026-03-08', dueTime: '02:30' })).toBe('2026-03-08T07:15:00Z');
    expect(reminderInstant({ ...task, dueDate: '2026-11-01', dueTime: '01:30' })).toBe('2026-11-01T05:15:00Z');
  });
  it('sends each due reminder once per browser across worker restarts', async () => {
    const f = fixture(); f.service.subscribe('one', subscription('two'));
    expect(await f.service.deliverDue(new Date(due.getTime() - 1))).toEqual({ sent: 0, failed: 0 });
    expect(await f.service.deliverDue(due)).toEqual({ sent: 2, failed: 0 });
    const restarted = new NotificationService(f.db, { vapid, sendPush: f.sendPush });
    expect(await restarted.deliverDue(due)).toEqual({ sent: 0, failed: 0 });
    expect(f.sendPush.mock.calls[0][1]).not.toContain(task.title);
  });
  it('claims deliveries atomically when two workers overlap', async () => {
    const f = fixture();
    await Promise.all([f.service.deliverDue(due), new NotificationService(f.db, { vapid, sendPush: f.sendPush }).deliverDue(due)]);
    expect(f.sendPush).toHaveBeenCalledTimes(1);
  });
  it('retries transient errors after a durable lease without storing provider secrets', async () => {
    const send = vi.fn().mockRejectedValueOnce(new Error('SECRET endpoint credential')).mockResolvedValue({});
    const f = fixture(send);
    expect(await f.service.deliverDue(due)).toEqual({ sent: 0, failed: 1 });
    expect(JSON.stringify(f.db.prepare('SELECT * FROM notification_deliveries').all())).not.toContain('SECRET');
    await f.service.deliverDue(new Date(due.getTime() + 60_000)); expect(send).toHaveBeenCalledTimes(1);
    expect(await f.service.deliverDue(new Date(due.getTime() + 301_000))).toEqual({ sent: 1, failed: 0 });
  });
  it('recovers an abandoned processing lease and bounds retries', async () => {
    const f = fixture(vi.fn().mockRejectedValue(new Error('unavailable')));
    await f.service.deliverDue(due);
    f.db.prepare("UPDATE notification_deliveries SET status='processing'").run();
    for (let attempt = 1; attempt <= 8; attempt++) await f.service.deliverDue(new Date(due.getTime() + attempt * 301_000));
    expect(f.sendPush).toHaveBeenCalledTimes(5);
    expect(f.db.prepare('SELECT attempts FROM notification_deliveries').get()).toEqual({ attempts: 5 });
  });
  it('removes expired subscriptions', async () => {
    const f = fixture(vi.fn().mockRejectedValue({ statusCode: 410 }));
    await f.service.deliverDue(due);
    expect(f.db.prepare('SELECT * FROM push_subscriptions').all()).toHaveLength(0);
  });
  it('skips completed, deleted, undated and stale tasks', async () => {
    const f = fixture();
    f.put({ ...task, completed: true }); await f.service.deliverDue(due);
    f.put(task, true); await f.service.deliverDue(due);
    f.put({ ...task, imported: { subscriptionId: 'feed', uid: 'event', recurrenceId: null, startDate: task.dueDate!, startTime: task.dueTime, endDate: null, endTime: null, timeZone: 'America/New_York', allDay: false, sourceRemoved: true, sourceUpdatedAt: due.toISOString() } }); await f.service.deliverDue(due);
    f.put({ ...task, dueDate: null, dueTime: null, reminder: null }); await f.service.deliverDue(due);
    f.put(); await f.service.deliverDue(new Date('2026-09-13T13:45:00Z'));
    expect(f.sendPush).not.toHaveBeenCalled();
  });
  it('rechecks later tasks after asynchronous delivery', async () => {
    const f = fixture();
    f.db.prepare(`INSERT INTO entities(owner_id,id,kind,version,data,deleted) VALUES('one','later','task',1,?,0)`).run(JSON.stringify(task));
    f.sendPush.mockImplementation(async () => { f.db.prepare("UPDATE entities SET deleted=1").run(); });
    await f.service.deliverDue(due); expect(f.sendPush).toHaveBeenCalledTimes(1);
  });
  it('scopes unsubscribe and reassigns browser subscriptions only on explicit enable', () => {
    const f = fixture(); f.service.unsubscribe('two', subscription());
    expect(f.db.prepare('SELECT * FROM push_subscriptions').all()).toHaveLength(1);
    expect(f.service.status('one', subscription().endpoint)).toEqual({ subscribed: true });
    expect(f.service.status('two', subscription().endpoint)).toEqual({ subscribed: false });
    f.service.subscribe('two', subscription());
    expect(f.service.status('one', subscription().endpoint)).toEqual({ subscribed: false });
    expect(f.db.prepare('SELECT owner_id FROM push_subscriptions').get()).toEqual({ owner_id: 'two' });
  });
  it('blocks arbitrary endpoints and malformed encryption keys', () => {
    for (const endpoint of ['http://fcm.googleapis.com/test', 'https://localhost/test', 'https://127.0.0.1/test', 'https://fcm.googleapis.com.evil.example/test', 'https://user@fcm.googleapis.com/test', 'https://fcm.googleapis.com:8080/test']) {
      expect(pushSubscriptionSchema.safeParse({ ...subscription(), endpoint }).success).toBe(false);
    }
    expect(pushSubscriptionSchema.safeParse({ ...subscription(), keys: { auth: 'short', p256dh: 'short' } }).success).toBe(false);
  });
  it('does not claim push is configured without server keys', async () => {
    const f = fixture(); const service = new NotificationService(f.db, { vapid: null });
    expect(service.config()).toEqual({ enabled: false, publicKey: null });
    expect(() => service.subscribe('one', subscription())).toThrow('not configured');
    expect(await service.deliverDue(due)).toEqual({ sent: 0, failed: 0 });
  });
});


describe('notification API account binding', () => {
  it('rejects anonymous and stale-account configuration writes', async () => {
    const db = openDatabase(':memory:'); databases.push(db);
    const first = randomUUID(), second = randomUUID();
    for (const id of [first, second]) db.prepare('INSERT INTO users(id,google_sub,email,created_at) VALUES(?,?,?,?)').run(id, id, `${id}@example.com`, new Date().toISOString());
    const service = new Service(db);
    const caller = appRouter.createCaller({ service, userId: first });
    await expect(appRouter.createCaller({ service, userId: null }).notifications.config()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(caller.notifications.subscribe({ ...subscription(), accountId: second })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(caller.notifications.unsubscribe({ endpoint: subscription().endpoint, accountId: second })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(caller.notifications.unsubscribe({ endpoint: subscription().endpoint, accountId: first })).resolves.toEqual({ subscribed: false });
  });
});
