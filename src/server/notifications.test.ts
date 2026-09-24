import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { appRouter } from './router';
import { Service } from './service';
import { generateVAPIDKeys } from 'web-push';
import { openDatabase, type Db } from './db';
import { CHAT_DELIVERY_ENTITY, CHAT_PUSH_PAYLOAD, NotificationService, chatQuietHours, pushSubscriptionSchema, reminderInstant } from './notifications';
import { CommunityService } from './community';
import { ChatService } from './chat';
import { exampleSchedule } from '@/domain/example';
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
  it('accepts the endpoints of every mainstream browser push provider', () => {
    for (const endpoint of ['https://fcm.googleapis.com/fcm/send/abc', 'https://updates.push.services.mozilla.com/wpush/v2/abc', 'https://web.push.apple.com/abc', 'https://wns2-par02p.notify.windows.com/w/?token=abc']) {
      expect(pushSubscriptionSchema.safeParse({ ...subscription(), endpoint }).success).toBe(true);
    }
  });
  it('blocks arbitrary endpoints and malformed encryption keys', () => {
    for (const endpoint of ['http://fcm.googleapis.com/test', 'https://localhost/test', 'https://127.0.0.1/test', 'https://fcm.googleapis.com.evil.example/test', 'https://notify.windows.com.evil.example/test', 'https://evilnotify.windows.com/test', 'https://user@fcm.googleapis.com/test', 'https://fcm.googleapis.com:8080/test']) {
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

/* ---------- Chat pushes (docs/CHAT.md §6, §9 notifications a–f) ---------- */

const MINUTE = 60_000;
const SECRET = 'ZX-SECRET-42 meet me after practice';
/** 12:00 in America/New_York (EDT), well outside quiet hours. */
const noon = new Date('2026-09-15T16:00:00Z');

function chatFixture(sendPush = vi.fn().mockResolvedValue({})) {
  const db = openDatabase(':memory:'); databases.push(db);
  const service = new Service(db, 'owner@example.com');
  const user = (name: string) => {
    const id = randomUUID();
    db.prepare('INSERT INTO users(id,google_sub,email,display_name,full_name,created_at) VALUES(?,?,?,?,?,?)').run(id, id, `${id}@example.com`, name, `${name} Privatename`, new Date().toISOString());
    return id;
  };
  const alice = user('Alice'), bob = user('Bob'), cara = user('Cara');
  const school = service.createSchool(alice, { name: 'Community High', location: 'Boston, MA', schedule: exampleSchedule });
  for (const id of [alice, bob, cara]) service.join(id, { schoolId: school.id, choice: 'community' });
  const community = new CommunityService(service);
  community.request(alice, bob); community.respond(bob, alice, true);
  const clock = { now: noon };
  const chat = new ChatService(service, () => clock.now);
  const at = (ms: number) => new Date(noon.getTime() + ms);
  /** Sends a message at `ms` after noon. */
  const send = (ms: number, from = alice, to = bob, body = SECRET) => { clock.now = at(ms); return chat.send(from, to, randomUUID(), body).message; };
  const notifications = new NotificationService(db, { vapid, sendPush });
  const subscribe = (owner = bob, token: string = owner) => notifications.subscribe(owner, subscription(token));
  const deliveries = () => db.prepare('SELECT * FROM notification_deliveries ORDER BY updated_at').all() as { owner_id: string; entity_id: string; reminder_at: string; status: string; attempts: number }[];
  const notifiedSeq = (owner = bob) => (db.prepare('SELECT notified_seq FROM chat_members WHERE user_id=?').get(owner) as { notified_seq: number }).notified_seq;
  subscribe();
  return { db, service, community, chat, clock, at, send, notifications, subscribe, sendPush, deliveries, notifiedSeq, alice, bob, cara, school };
}

describe('chat pushes', () => {
  it('a. waits 60 s, then sends one generic push with no names and no text', async () => {
    const f = chatFixture();
    f.send(0);
    expect(await f.notifications.deliverChat(f.at(59_000))).toEqual({ sent: 0, failed: 0 });
    expect(f.deliveries()).toHaveLength(0);
    expect(await f.notifications.deliverChat(f.at(61_000))).toEqual({ sent: 1, failed: 0 });
    expect(f.sendPush).toHaveBeenCalledTimes(1);
    const [target, payload, options] = f.sendPush.mock.calls[0];
    expect(target.endpoint).toBe(subscription('' + f.bob).endpoint);
    expect(payload).toBe('{"kind":"chat","tag":"quasar-chat"}');
    expect(payload).toBe(CHAT_PUSH_PAYLOAD);
    for (const secret of ['ZX-SECRET-42', 'Alice', 'Bob', 'Privatename']) expect(payload).not.toContain(secret);
    expect(options).toMatchObject({ TTL: 3600, urgency: 'normal', timeout: 15_000, vapidDetails: vapid });
    expect(f.deliveries()).toMatchObject([{ owner_id: f.bob, entity_id: CHAT_DELIVERY_ENTITY, reminder_at: '2026-09-15T16:00:00.000Z', status: 'sent' }]);
    // The sender never gets a push for their own message.
    f.subscribe(f.alice);
    expect(await f.notifications.deliverChat(f.at(12 * MINUTE))).toEqual({ sent: 0, failed: 0 });
  });

  it('b. never pushes the same messages twice, even after a restart, and allows one push per 10 minutes', async () => {
    const f = chatFixture();
    const first = f.send(0);
    expect(await f.notifications.deliverChat(f.at(61_000))).toEqual({ sent: 1, failed: 0 });
    expect(f.notifiedSeq()).toBe(first.seq);
    const restarted = new NotificationService(f.db, { vapid, sendPush: f.sendPush });
    expect(await restarted.deliverChat(f.at(15 * MINUTE))).toEqual({ sent: 0, failed: 0 });
    // A new message within 10 minutes of the last push waits; after 10 minutes it is pushed.
    const second = f.send(3 * MINUTE);
    expect(await restarted.deliverChat(f.at(5 * MINUTE))).toEqual({ sent: 0, failed: 0 });
    expect(await restarted.deliverChat(f.at(61_000 + 10 * MINUTE - 1))).toEqual({ sent: 0, failed: 0 });
    expect(await restarted.deliverChat(f.at(61_000 + 10 * MINUTE))).toEqual({ sent: 1, failed: 0 });
    expect(f.notifiedSeq()).toBe(second.seq);
    expect(f.sendPush).toHaveBeenCalledTimes(2);
  });

  it('c. withholds the 21st push in 24 hours', async () => {
    const f = chatFixture();
    const sentAt: number[] = [];
    for (let minute = 0; minute < 24 * 60; minute += 11) {
      f.send(minute * MINUTE, f.alice, f.bob, `message ${minute}`);
      const { sent } = await f.notifications.deliverChat(f.at(minute * MINUTE + 61_000));
      if (sent) sentAt.push(minute);
    }
    expect(sentAt).toHaveLength(20);
    expect(sentAt).toEqual(Array.from({ length: 20 }, (_, index) => index * 11));
    // Once the first push is more than 24 h old, pushes resume.
    f.send(24 * 60 * MINUTE + 5 * MINUTE);
    expect(await f.notifications.deliverChat(f.at(24 * 60 * MINUTE + 6 * MINUTE + 1))).toEqual({ sent: 1, failed: 0 });
  });

  describe('d. no push, checked before claiming and again right before sending, when', () => {
    // Each change runs once before the cycle, and once while the push to Bob's first browser is in flight:
    // his second browser must then not be pushed, and its claimed row must not count toward the caps.
    const cases: [string, (f: ReturnType<typeof chatFixture>) => void][] = [
      ['the message was read', f => { f.chat.read(f.bob, f.alice, 1_000_000); }],
      ['the chat is muted', f => { f.chat.mute(f.bob, f.alice, true); }],
      ['Message notifications are off', f => { f.chat.setPush(f.bob, false); }],
      ['the pair unfriended', f => { f.community.remove(f.alice, f.bob); }],
      ['the recipient blocked the sender', f => { f.community.block(f.bob, f.alice, true); }],
      ['the sender blocked the recipient', f => { f.community.block(f.alice, f.bob, true); }],
      ['a block row exists while the friendship still does', f => { f.db.prepare('INSERT INTO blocks(blocker_id,blocked_id,created_at) VALUES(?,?,?)').run(f.alice, f.bob, new Date().toISOString()); }],
      ['the message was deleted', f => { f.clock.now = f.at(2 * MINUTE); for (const row of f.db.prepare('SELECT id FROM chat_messages').all() as { id: string }[]) f.chat.delete(f.alice, f.bob, row.id); }],
    ];
    for (const [name, change] of cases) {
      it(name, async () => {
        const before = chatFixture();
        before.send(0); change(before);
        expect(await before.notifications.deliverChat(before.at(2 * MINUTE))).toEqual({ sent: 0, failed: 0 });
        expect(before.sendPush).not.toHaveBeenCalled();
        expect(before.deliveries()).toHaveLength(0);

        const during = chatFixture();
        during.subscribe(during.bob, 'second-browser');
        during.send(0);
        during.sendPush.mockImplementationOnce(async () => { change(during); });
        expect(await during.notifications.deliverChat(during.at(2 * MINUTE))).toEqual({ sent: 1, failed: 0 });
        expect(during.sendPush).toHaveBeenCalledTimes(1);
        expect(during.deliveries()).toMatchObject([{ status: 'sent' }]);
      });
    }
  });

  it('d. waits for 07:00 in the recipient\'s school time zone, with America/New_York for a student with no school', async () => {
    const f = chatFixture();
    f.db.prepare('UPDATE users SET school_id=NULL WHERE id=?').run(f.bob);
    const eleven = new Date('2026-09-16T03:00:00Z'); // 23:00 EDT
    f.send(eleven.getTime() - noon.getTime() - 2 * MINUTE);
    expect(chatQuietHours(eleven, 'America/New_York')).toBe(true);
    expect(await f.notifications.deliverChat(eleven)).toEqual({ sent: 0, failed: 0 });
    expect(await f.notifications.deliverChat(new Date('2026-09-16T10:55:00Z'))).toEqual({ sent: 0, failed: 0 }); // 06:55
    expect(await f.notifications.deliverChat(new Date('2026-09-16T11:05:00Z'))).toEqual({ sent: 1, failed: 0 }); // 07:05

    // A school on Pacific time is at 20:00 when New York is at 23:00, so its students still get pushes.
    const west = chatFixture();
    const schedule = JSON.parse((west.db.prepare('SELECT schedule FROM schools WHERE id=?').get(west.school.id) as { schedule: string }).schedule);
    west.db.prepare('UPDATE schools SET schedule=? WHERE id=?').run(JSON.stringify({ ...schedule, timeZone: 'America/Los_Angeles' }), west.school.id);
    west.send(eleven.getTime() - noon.getTime() - 2 * MINUTE);
    expect(await west.notifications.deliverChat(eleven)).toEqual({ sent: 1, failed: 0 });
    // An unusable stored zone falls back to America/New_York.
    const broken = chatFixture();
    broken.db.prepare('UPDATE schools SET schedule=? WHERE id=?').run(JSON.stringify({ ...schedule, timeZone: 'Not/AZone' }), broken.school.id);
    broken.send(eleven.getTime() - noon.getTime() - 2 * MINUTE);
    expect(await broken.notifications.deliverChat(eleven)).toEqual({ sent: 0, failed: 0 });
  });

  it('d. never pushes a message more than 24 hours old', async () => {
    const f = chatFixture();
    f.send(0);
    expect(await f.notifications.deliverChat(f.at(24 * 60 * MINUTE + 1))).toEqual({ sent: 0, failed: 0 });
    expect(await f.notifications.deliverChat(f.at(24 * 60 * MINUTE))).toEqual({ sent: 1, failed: 0 });
  });

  it('d. pushes nothing without server keys, or to a recipient with no chat yet', async () => {
    const f = chatFixture();
    f.send(0);
    expect(await new NotificationService(f.db, { vapid: null, sendPush: f.sendPush }).deliverChat(f.at(2 * MINUTE))).toEqual({ sent: 0, failed: 0 });
    f.subscribe(f.cara);
    expect(await f.notifications.deliverChat(f.at(2 * MINUTE))).toEqual({ sent: 1, failed: 0 });
    expect(f.sendPush.mock.calls.map(call => call[0].endpoint)).toEqual([subscription(f.bob).endpoint]);
  });

  it('e. sends once when two workers overlap, and a 410 deletes the subscription', async () => {
    const f = chatFixture();
    f.send(0);
    const other = new NotificationService(f.db, { vapid, sendPush: f.sendPush });
    const results = await Promise.all([f.notifications.deliverChat(f.at(2 * MINUTE)), other.deliverChat(f.at(2 * MINUTE))]);
    expect(f.sendPush).toHaveBeenCalledTimes(1);
    expect(results.reduce((total, result) => total + result.sent, 0)).toBe(1);

    const gone = chatFixture(vi.fn().mockRejectedValue({ statusCode: 410 }));
    gone.send(0);
    expect(await gone.notifications.deliverChat(gone.at(2 * MINUTE))).toEqual({ sent: 0, failed: 1 });
    expect(gone.db.prepare('SELECT * FROM push_subscriptions').all()).toHaveLength(0);
    expect(gone.deliveries()).toHaveLength(0);
    expect(gone.notifiedSeq()).toBe(0);
  });

  it('e. records a failed push with a code only and retries it after the lease', async () => {
    const send = vi.fn().mockRejectedValueOnce(Object.assign(new Error(`provider said ${SECRET}`), { statusCode: 500 })).mockResolvedValue({});
    const f = chatFixture(send);
    f.send(0);
    expect(await f.notifications.deliverChat(f.at(2 * MINUTE))).toEqual({ sent: 0, failed: 1 });
    expect(f.deliveries()).toMatchObject([{ status: 'failed', last_error: 'Push provider HTTP 500' }]);
    expect(JSON.stringify(f.deliveries())).not.toContain('ZX-SECRET-42');
    expect(f.notifiedSeq()).toBe(0);
    expect(await f.notifications.deliverChat(f.at(3 * MINUTE))).toEqual({ sent: 0, failed: 0 });
    expect(await f.notifications.deliverChat(f.at(7 * MINUTE + 1))).toEqual({ sent: 1, failed: 0 });
  });

  it('f. deliverDue ignores chat:messages rows', async () => {
    const f = chatFixture();
    f.send(0);
    await f.notifications.deliverChat(f.at(2 * MINUTE));
    f.db.prepare(`INSERT INTO notification_deliveries(owner_id,entity_id,reminder_at,subscription_id,status,attempts,last_error,updated_at)
      SELECT owner_id,entity_id,'2026-09-15T15:00:00.000Z',subscription_id,'processing',1,NULL,'2026-09-15T15:00:00.000Z' FROM notification_deliveries`).run();
    const rows = f.deliveries();
    const reminder: Task = { ...task, dueDate: '2026-09-15', dueTime: '12:30', reminder: { minutesBefore: 15, timeZone: 'America/New_York' } };
    f.db.prepare(`INSERT INTO entities(owner_id,id,kind,version,data,deleted) VALUES(?,'homework','task',1,?,0)`).run(f.bob, JSON.stringify(reminder));
    expect(await f.notifications.deliverDue(f.at(20 * MINUTE))).toEqual({ sent: 1, failed: 0 });
    expect(JSON.parse(f.sendPush.mock.calls[1][1])).toMatchObject({ title: 'Quasar reminder', url: '/#tasks' });
    expect(f.deliveries().filter(row => row.entity_id === CHAT_DELIVERY_ENTITY)).toEqual(rows);
  });
});
