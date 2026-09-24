import { randomUUID } from 'node:crypto';
import { Temporal } from '@js-temporal/polyfill';
import webpush from 'web-push';
import { z } from 'zod';
import { CHAT } from '@/domain/chat';
import { taskSchema, type Task } from '@/domain/task';
import type { Db } from './db';

// Provider-owned HTTPS hosts only: browser subscriptions must never turn the
// worker into a general URL fetcher. web-push does not follow redirects.
const pushHosts = new Set(['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'web.push.apple.com']);
// Microsoft Edge subscribes through regional Windows Notification Service hosts (wns2-xx.notify.windows.com).
const pushHostSuffixes = ['.notify.windows.com'];
const pushHost = (hostname: string) => pushHosts.has(hostname) || pushHostSuffixes.some(suffix => hostname.endsWith(suffix));
export const pushEndpointSchema = z.string().max(4096).refine(value => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.hash && pushHost(url.hostname);
  } catch { return false; }
}, 'This browser push provider is not supported');
const key = (length: number) => z.string().max(128).regex(/^[A-Za-z0-9_-]+={0,2}$/).refine(value => Buffer.from(value, 'base64url').length === length, 'Invalid push key');
export const pushSubscriptionSchema = z.object({ endpoint: pushEndpointSchema, keys: z.object({ p256dh: key(65), auth: key(16) }).strict() }).strict();
type Subscription = z.infer<typeof pushSubscriptionSchema>;
type Vapid = { publicKey: string; privateKey: string; subject: string };
type SendPush = (subscription: Subscription, payload: string, options: webpush.RequestOptions) => Promise<unknown>;
type Options = { vapid?: Vapid | null; sendPush?: SendPush };
type Identity = [ownerId: string, entityId: string, reminderAt: string, subscriptionId: string];
type SubscriptionRow = { subscription_id: string; endpoint: string; p256dh: string; auth: string };

const MINUTE = 60_000;
const DAY = 86_400_000;
const LEASE_MS = 5 * MINUTE;
const PUSH_OPTIONS = { TTL: 3600, urgency: 'normal', timeout: 15_000 } as const;

/**
 * Claims one delivery (owner, entity, instant, browser). A row is granted only when it is new, or when an
 * earlier attempt failed or was abandoned past the lease and has fewer than five attempts. Reminders and
 * chat pushes both use this exact statement.
 */
const CLAIM_SQL = `INSERT INTO notification_deliveries(owner_id,entity_id,reminder_at,subscription_id,status,attempts,last_error,updated_at)
        VALUES(?,?,?,?,'processing',1,NULL,?) ON CONFLICT(owner_id,entity_id,reminder_at,subscription_id)
        DO UPDATE SET status='processing',attempts=attempts+1,updated_at=excluded.updated_at
        WHERE notification_deliveries.status!='sent' AND notification_deliveries.attempts<5 AND notification_deliveries.updated_at<?`;
const DELIVERY_WHERE = 'owner_id=? AND entity_id=? AND reminder_at=? AND subscription_id=?';

/**
 * Chat pushes (docs/CHAT.md §6). The entity id holds a colon, which a task id cannot, so these rows never
 * collide with reminder rows, and deliverDue (which reads entities) never touches them.
 */
export const CHAT_DELIVERY_ENTITY = 'chat:messages';
/** Generic on purpose: no names and no text, so nothing leaks onto a lock screen. The service worker shows fixed text. */
export const CHAT_PUSH_PAYLOAD = JSON.stringify({ kind: 'chat', tag: 'quasar-chat' });

const verifiedSql = (column: string) => `EXISTS (SELECT 1 FROM users vu JOIN school_verifications vv ON vv.user_id=vu.id AND vv.school_id=vu.school_id WHERE vu.id=${column})`;
/**
 * The threads with messages to push to one recipient, with the highest such seq in each. Access is derived
 * again here, never trusted from an earlier step: an accepted friendship, no block either way (and both
 * verified when CHAT.requiresVerification is on), the recipient's names entered, chat_push on and the chat
 * not muted. Only the other person's undeleted messages that are unread, not yet pushed, at least 60 s old
 * and at most 24 h old count.
 */
const CHAT_CANDIDATES_SQL = `SELECT c.thread_id AS threadId, max(c.seq) AS seq
  FROM chat_members m
  JOIN users r ON r.id=m.user_id
  JOIN chat_threads t ON t.id=m.thread_id
  JOIN chat_messages c ON c.thread_id=t.id
  WHERE m.user_id=@owner AND m.muted=0 AND r.chat_push=1 AND r.display_name<>'' AND r.full_name<>''
    AND EXISTS (SELECT 1 FROM friendships f WHERE f.user_low=t.user_low AND f.user_high=t.user_high AND f.status='accepted')
    AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id=t.user_low AND b.blocked_id=t.user_high) OR (b.blocker_id=t.user_high AND b.blocked_id=t.user_low))
    ${CHAT.requiresVerification ? `AND ${verifiedSql('t.user_low')} AND ${verifiedSql('t.user_high')}` : ''}
    AND c.sender_id<>m.user_id AND c.seq>max(m.last_read_seq,m.notified_seq) AND c.deleted_at IS NULL
    AND c.created_at<=@newest AND c.created_at>=@oldest
  GROUP BY c.thread_id`;

/** The recipient's school time zone, or the fallback when there is no school or the stored zone is unusable. */
function chatTimeZone(schedule: string | null): string {
  if (!schedule) return CHAT.fallbackTimeZone;
  try {
    const zone: unknown = JSON.parse(schedule)?.timeZone;
    if (typeof zone === 'string' && zone) { Temporal.Now.instant().toZonedDateTimeISO(zone); return zone; }
  } catch { /* fall back */ }
  return CHAT.fallbackTimeZone;
}
/** True between 22:00 and 07:00 local time: chat pushes wait until morning. */
export function chatQuietHours(now: Date, timeZone: string): boolean {
  const hour = Temporal.Instant.fromEpochMilliseconds(now.getTime()).toZonedDateTimeISO(timeZone).hour;
  return CHAT.quietStart > CHAT.quietEnd ? hour >= CHAT.quietStart || hour < CHAT.quietEnd : hour >= CHAT.quietStart && hour < CHAT.quietEnd;
}

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
    const leaseCutoff = new Date(now.getTime() - LEASE_MS).toISOString();
    const rows = this.db.prepare(`SELECT e.owner_id,e.id,e.data,s.id AS subscription_id,s.endpoint,s.p256dh,s.auth
      FROM entities e JOIN push_subscriptions s ON s.owner_id=e.owner_id WHERE e.kind='task' AND e.deleted=0`).all() as Array<{ owner_id: string; id: string; data: string } & SubscriptionRow>;
    for (const row of rows) {
      let task: Task;
      try { task = taskSchema.parse(JSON.parse(row.data)); } catch { continue; }
      const due = reminderInstant(task);
      if (!due || Date.parse(due) > now.getTime() || Date.parse(due) < now.getTime() - DAY) continue;
      const identity: Identity = [row.owner_id, row.id, due, row.subscription_id];
      const claimed = this.db.prepare(CLAIM_SQL).run(...identity, nowIso, leaseCutoff).changes;
      if (!claimed) continue;
      try {
        // Recheck after earlier asynchronous sends: deletion/completion/edits win.
        const current = this.db.prepare('SELECT data FROM entities WHERE owner_id=? AND id=? AND deleted=0').get(row.owner_id, row.id) as { data: string } | undefined;
        if (!current || reminderInstant(taskSchema.parse(JSON.parse(current.data))) !== due || !this.db.prepare('SELECT id FROM push_subscriptions WHERE id=? AND owner_id=?').get(row.subscription_id, row.owner_id)) continue;
        await this.push(row, JSON.stringify({ title: 'Quasar reminder', body: 'You have a task reminder. Open Quasar to view it.', tag: `task-${row.id}-${due}`, url: '/#tasks' }));
        this.markSent(identity, nowIso);
        result.sent++;
      } catch (error) {
        this.markFailed(identity, error, nowIso);
        result.failed++;
      }
    }
    return result;
  }

  /**
   * Generic chat pushes (docs/CHAT.md §6): delayed 60 s, at most one per recipient per 10 minutes and 20 per
   * 24 h, none between 22:00 and 07:00 in the recipient's school time zone, and none for muted chats or with
   * Message notifications off. Nothing older than 24 h is pushed, and the same messages are never pushed twice.
   */
  async deliverChat(now = new Date()): Promise<{ sent: number; failed: number }> {
    const result = { sent: 0, failed: 0 };
    if (!this.vapid) return result;
    const nowIso = now.toISOString();
    const at = (offsetMs: number) => new Date(now.getTime() - offsetMs).toISOString();
    const leaseCutoff = at(LEASE_MS);
    const windowStart = new Date(Math.floor(now.getTime() / CHAT.pushWindowMs) * CHAT.pushWindowMs).toISOString();
    const candidates = (owner: string) => this.db.prepare(CHAT_CANDIDATES_SQL)
      .all({ owner, newest: at(CHAT.pushDelayMs), oldest: at(DAY) }) as { threadId: string; seq: number }[];
    const recipients = this.db.prepare(`SELECT u.id, s.schedule FROM users u LEFT JOIN schools s ON s.id=u.school_id
      WHERE u.chat_push=1 AND EXISTS (SELECT 1 FROM push_subscriptions p WHERE p.owner_id=u.id) ORDER BY u.id`).all() as { id: string; schedule: string | null }[];
    for (const recipient of recipients) {
      // 1. Quiet hours: the messages wait until 07:00.
      if (chatQuietHours(now, chatTimeZone(recipient.schedule))) continue;
      // 2. Rate: one push per 10 minutes and 20 per 24 h, counted from pushes that were actually sent.
      const history = this.db.prepare(`SELECT max(updated_at) AS last, count(DISTINCT CASE WHEN updated_at>? THEN reminder_at END) AS windows
        FROM notification_deliveries WHERE owner_id=? AND entity_id=? AND status='sent'`).get(at(DAY), recipient.id, CHAT_DELIVERY_ENTITY) as { last: string | null; windows: number };
      if ((history.last && history.last > at(CHAT.pushWindowMs)) || history.windows >= CHAT.pushPerDay) continue;
      // 3. Candidates.
      if (!candidates(recipient.id).length) continue;
      const subscriptions = this.db.prepare('SELECT id AS subscription_id,endpoint,p256dh,auth FROM push_subscriptions WHERE owner_id=? ORDER BY created_at,id').all(recipient.id) as SubscriptionRow[];
      const notified = new Map<string, number>();
      try {
        for (const row of subscriptions) {
          // 4. Claim this browser for the current 10-minute window.
          const identity: Identity = [recipient.id, CHAT_DELIVERY_ENTITY, windowStart, row.subscription_id];
          let claimed: number;
          try { claimed = this.db.prepare(CLAIM_SQL).run(...identity, nowIso, leaseCutoff).changes; } catch { continue; }
          if (!claimed) continue;
          try {
            // 5. Recheck after earlier asynchronous sends: a read, mute, switch-off, unfriend or block wins.
            const current = candidates(recipient.id);
            if (!current.length || !this.db.prepare('SELECT id FROM push_subscriptions WHERE id=? AND owner_id=?').get(row.subscription_id, recipient.id)) {
              // An empty window must never count toward the 10-minute or daily caps.
              this.db.prepare(`DELETE FROM notification_deliveries WHERE ${DELIVERY_WHERE}`).run(...identity);
              continue;
            }
            await this.push(row, CHAT_PUSH_PAYLOAD);
            this.markSent(identity, nowIso);
            result.sent++;
            for (const candidate of current) notified.set(candidate.threadId, Math.max(notified.get(candidate.threadId) ?? 0, candidate.seq));
          } catch (error) {
            this.markFailed(identity, error, nowIso);
            result.failed++;
          }
        }
      } finally {
        // 6. Record what was pushed, so the same messages are never pushed again, even after a restart.
        if (notified.size) {
          const update = this.db.prepare('UPDATE chat_members SET notified_seq=max(notified_seq,?) WHERE thread_id=? AND user_id=?');
          this.db.transaction(() => { for (const [threadId, seq] of notified) update.run(seq, threadId, recipient.id); })();
        }
      }
    }
    return result;
  }

  private async push(row: SubscriptionRow, payload: string): Promise<void> {
    const subscription = pushSubscriptionSchema.parse({ endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } });
    await this.sendPush(subscription, payload, { vapidDetails: this.vapid!, ...PUSH_OPTIONS });
  }
  private markSent(identity: Identity, nowIso: string): void {
    this.db.prepare(`UPDATE notification_deliveries SET status='sent',last_error=NULL,updated_at=? WHERE ${DELIVERY_WHERE}`).run(nowIso, ...identity);
  }
  /** Stores an error code only, never provider text. A gone subscription (404/410) is deleted with its rows. */
  private markFailed(identity: Identity, error: unknown, nowIso: string): void {
    const status = error && typeof error === 'object' && 'statusCode' in error ? Number(error.statusCode) : 0;
    if (status === 404 || status === 410) this.db.prepare('DELETE FROM push_subscriptions WHERE id=?').run(identity[3]);
    else this.db.prepare(`UPDATE notification_deliveries SET status='failed',last_error=?,updated_at=? WHERE ${DELIVERY_WHERE}`).run(status ? `Push provider HTTP ${status}` : 'Push delivery failed', nowIso, ...identity);
  }
}
