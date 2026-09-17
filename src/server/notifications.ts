import { randomUUID } from 'node:crypto';
import { Temporal } from '@js-temporal/polyfill';
import webpush from 'web-push';
import { z } from 'zod';
import { taskSchema, type Task } from '@/domain/task';
import type { Db } from './db';

// Provider-owned HTTPS hosts only: browser subscriptions must never turn the
// worker into a general URL fetcher. web-push does not follow redirects.
const pushHosts = new Set(['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'web.push.apple.com']);
export const pushEndpointSchema = z.string().max(4096).refine(value => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.hash && pushHosts.has(url.hostname);
  } catch { return false; }
}, 'This browser push provider is not supported');
const key = (length: number) => z.string().max(128).regex(/^[A-Za-z0-9_-]+={0,2}$/).refine(value => Buffer.from(value, 'base64url').length === length, 'Invalid push key');
export const pushSubscriptionSchema = z.object({ endpoint: pushEndpointSchema, keys: z.object({ p256dh: key(65), auth: key(16) }).strict() }).strict();
type Subscription = z.infer<typeof pushSubscriptionSchema>;
type Vapid = { publicKey: string; privateKey: string; subject: string };
type SendPush = (subscription: Subscription, payload: string, options: webpush.RequestOptions) => Promise<unknown>;
type Options = { vapid?: Vapid | null; sendPush?: SendPush };

export function reminderInstant(task: Task): string | null {
  if (!task.reminder || !task.dueDate || task.completed || task.imported?.sourceRemoved) return null;
  // Temporal's compatible disambiguation moves nonexistent spring times forward
  // and uses the first occurrence of an ambiguous autumn time.
  return Temporal.PlainDate.from(task.dueDate).toPlainDateTime(task.dueTime ?? '09:00')
    .toZonedDateTime(task.reminder.timeZone).subtract({ minutes: task.reminder.minutesBefore }).toInstant().toString();
}

export class NotificationService {
  private readonly vapid: Vapid | null;
  private readonly sendPush: SendPush;
  constructor(private readonly db: Db, options: Options = {}) {
    const { VAPID_PUBLIC_KEY: publicKey, VAPID_PRIVATE_KEY: privateKey, VAPID_SUBJECT: subject } = process.env;
    this.vapid = options.vapid === undefined ? (publicKey && privateKey && subject ? { publicKey, privateKey, subject } : null) : options.vapid;
    this.sendPush = options.sendPush ?? webpush.sendNotification;
  }
  config() { return { enabled: !!this.vapid, publicKey: this.vapid?.publicKey ?? null }; }
  status(ownerId: string, endpoint: string) {
    return { subscribed: !!this.db.prepare('SELECT id FROM push_subscriptions WHERE owner_id=? AND endpoint=?').get(ownerId, endpoint) };
  }
  subscribe(ownerId: string, input: Subscription) {
    if (!this.vapid) throw new Error('Browser reminders are not configured on this server');
    const subscription = pushSubscriptionSchema.parse(input);
    // Reassign a shared browser when another account explicitly enables push.
    this.db.transaction(() => {
      const existing = this.db.prepare('SELECT id,owner_id FROM push_subscriptions WHERE endpoint=?').get(subscription.endpoint) as { id: string; owner_id: string } | undefined;
      if (existing && existing.owner_id !== ownerId) this.db.prepare('DELETE FROM push_subscriptions WHERE id=?').run(existing.id);
      this.db.prepare(`INSERT INTO push_subscriptions(id,owner_id,endpoint,p256dh,auth,created_at) VALUES(?,?,?,?,?,?)
        ON CONFLICT(endpoint) DO UPDATE SET p256dh=excluded.p256dh,auth=excluded.auth`).run(randomUUID(), ownerId, subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth, new Date().toISOString());
    })();
    return { subscribed: true };
  }
  unsubscribe(ownerId: string, input: { endpoint: string }) {
    this.db.prepare('DELETE FROM push_subscriptions WHERE owner_id=? AND endpoint=?').run(ownerId, input.endpoint);
    return { subscribed: false };
  }
  async deliverDue(now = new Date()): Promise<{ sent: number; failed: number }> {
    const result = { sent: 0, failed: 0 };
    if (!this.vapid) return result;
    const nowIso = now.toISOString();
    const leaseCutoff = new Date(now.getTime() - 5 * 60_000).toISOString();
    const rows = this.db.prepare(`SELECT e.owner_id,e.id,e.data,s.id AS subscription_id,s.endpoint,s.p256dh,s.auth
      FROM entities e JOIN push_subscriptions s ON s.owner_id=e.owner_id WHERE e.kind='task' AND e.deleted=0`).all() as Array<{ owner_id: string; id: string; data: string; subscription_id: string; endpoint: string; p256dh: string; auth: string }>;
    for (const row of rows) {
      let task: Task;
      try { task = taskSchema.parse(JSON.parse(row.data)); } catch { continue; }
      const due = reminderInstant(task);
      if (!due || Date.parse(due) > now.getTime() || Date.parse(due) < now.getTime() - 86_400_000) continue;
      const identity = [row.owner_id, row.id, due, row.subscription_id];
      const claimed = this.db.prepare(`INSERT INTO notification_deliveries(owner_id,entity_id,reminder_at,subscription_id,status,attempts,last_error,updated_at)
        VALUES(?,?,?,?,'processing',1,NULL,?) ON CONFLICT(owner_id,entity_id,reminder_at,subscription_id)
        DO UPDATE SET status='processing',attempts=attempts+1,updated_at=excluded.updated_at
        WHERE notification_deliveries.status!='sent' AND notification_deliveries.attempts<5 AND notification_deliveries.updated_at<?`).run(...identity, nowIso, leaseCutoff).changes;
      if (!claimed) continue;
      try {
        // Recheck after earlier asynchronous sends: deletion/completion/edits win.
        const current = this.db.prepare('SELECT data FROM entities WHERE owner_id=? AND id=? AND deleted=0').get(row.owner_id, row.id) as { data: string } | undefined;
        if (!current || reminderInstant(taskSchema.parse(JSON.parse(current.data))) !== due || !this.db.prepare('SELECT id FROM push_subscriptions WHERE id=? AND owner_id=?').get(row.subscription_id, row.owner_id)) continue;
        const subscription = pushSubscriptionSchema.parse({ endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } });
        await this.sendPush(subscription, JSON.stringify({ title: 'Quasar reminder', body: 'You have a task reminder. Open Quasar to view it.', tag: `task-${row.id}-${due}`, url: '/#tasks' }), { vapidDetails: this.vapid, TTL: 3600, urgency: 'normal', timeout: 15_000 });
        this.db.prepare(`UPDATE notification_deliveries SET status='sent',last_error=NULL,updated_at=? WHERE owner_id=? AND entity_id=? AND reminder_at=? AND subscription_id=?`).run(nowIso, ...identity);
        result.sent++;
      } catch (error) {
        const status = error && typeof error === 'object' && 'statusCode' in error ? Number(error.statusCode) : 0;
        if (status === 404 || status === 410) this.db.prepare('DELETE FROM push_subscriptions WHERE id=?').run(row.subscription_id);
        else this.db.prepare(`UPDATE notification_deliveries SET status='failed',last_error=?,updated_at=? WHERE owner_id=? AND entity_id=? AND reminder_at=? AND subscription_id=?`).run(status ? `Push provider HTTP ${status}` : 'Push delivery failed', nowIso, ...identity);
        result.failed++;
      }
    }
    return result;
  }
}
