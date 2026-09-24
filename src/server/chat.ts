import { randomUUID } from 'node:crypto';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { CHAT, REPORT_CATEGORIES, bodyError, normalizeBody, rawBodySchema, reportCategorySchema, type ReportCategory } from '@/domain/chat';
import { slurError } from '@/domain/chat-filter';
import { CommunityService } from './community';
import { countUnreadGlobal } from './global-chat';
import type { Db } from './db';
import type { Service, User } from './service';

/**
 * Phase-4 chat (docs/CHAT.md §2, §3, §5).
 *
 * - Chat is one to one between accepted friends with no block in either direction. Every read and write
 *   re-checks that inside its own transaction, so revocation is immediate.
 * - Support never reads chat_messages.body. Chat text reaches the owner only through a frozen report
 *   snapshot, and every view of a snapshot writes audit_log.
 * - Every error message is a fixed string: nothing here ever echoes message text.
 */

type FailCode = 'FORBIDDEN' | 'NOT_FOUND' | 'BAD_REQUEST' | 'CONFLICT' | 'TOO_MANY_REQUESTS';
const fail: (code: FailCode, message: string) => never = (code, message) => { throw new TRPCError({ code, message }); };
const pair = (a: string, b: string): [string, string] => (a < b ? [a, b] : [b, a]);
const DAY = 86_400_000;

export const CLOSED = 'This chat is closed.';
export const PAUSED = 'Support paused your messaging.';
const SELF = 'You cannot message yourself.';
const NOTHING_TO_REPORT = 'This chat has no messages to report.';

export type ChatPeer = { id: string; displayName: string; fullName: string | null; verified: boolean };
export type ChatMessage = { id: string; seq: number; fromMe: boolean; body: string | null; createdAt: string;
  deletedBy: 'sender' | 'support' | null };
export type ChatPause = { until: string | null };
export type InboxRow =
  | { state: 'open'; peer: ChatPeer;
      lastMessage: { fromMe: boolean; preview: string | null; createdAt: string; deletedBy: 'sender' | 'support' | null } | null;
      unread: number; muted: boolean }
  | { state: 'closed'; userId: string; displayName: string; lastAt: string;
      /** How the viewer can reopen it: lift their own block (then re-friend), send a friend request, or not at all (other school). */
      reopen: 'unblock' | 'friend' | null };
export type ReopenResult = { unblocked: boolean; friendState: 'friends' | 'requested' };
export type EvidenceItem = { seq: number; senderName: string; fromReported: boolean; body: string; createdAt: string;
  deletedBy: 'sender' | 'support' | null; anchor: boolean };
/** Stored snapshot item. It holds no names; showEvidence derives them when the owner views it. */
type StoredItem = { seq: number; fromReported: boolean; body: string; createdAt: string; deletedBy: 'sender' | 'support' | null; anchor: boolean };

type ThreadRow = { id: string; user_low: string; user_high: string; revision: number; last_message_at: string | null; created_at: string };
type MessageRow = { seq: number; id: string; thread_id: string; sender_id: string; body: string; created_at: string;
  deleted_at: string | null; deleted_by: 'sender' | 'support' | null; revision: number };
type PeerRow = { id: string; display_name: string; full_name: string; school_id: string | null };

export const chatUserSchema = z.object({ userId: z.uuid() });
export const chatThreadSchema = chatUserSchema.extend({
  after: z.number().int().min(0).optional(),
  before: z.number().int().positive().optional(),
}).refine(input => input.after === undefined || input.before === undefined, 'Use either after or before, not both.');
export const chatSendSchema = chatUserSchema.extend({ clientId: z.uuid(), body: rawBodySchema });
export const chatDeleteSchema = chatUserSchema.extend({ messageId: z.uuid() });
export const chatReadSchema = chatUserSchema.extend({ seq: z.number().int().min(0) });
export const chatMuteSchema = chatUserSchema.extend({ muted: z.boolean() });
export const chatReportSchema = chatUserSchema.extend({
  category: reportCategorySchema,
  note: z.string().trim().max(2000).default(''),
  seq: z.number().int().positive().optional(),
  block: z.boolean(),
});
export const pauseChatSchema = z.object({
  userId: z.uuid(),
  days: z.union([z.literal(1), z.literal(7), z.literal(30)]).nullable(),
  reason: z.string().trim().min(3).max(2000),
});

/** Server side: normalizeBody + bodyError + the slur filter (§11), throwing BAD_REQUEST with a fixed string. Never echoes input. */
export function parseBody(raw: string): string {
  const body = normalizeBody(typeof raw === 'string' ? raw : '');
  const problem = bodyError(body) ?? slurError(body);
  if (problem) fail('BAD_REQUEST', problem);
  return body;
}

/**
 * SQL that is true when the pair of thread `t` may chat: an accepted friendship and no block either way
 * (plus both verified at their current schools when CHAT.requiresVerification is on).
 */
function accessibleSql(t: string): string {
  const verified = (column: string) => `EXISTS (SELECT 1 FROM users vu JOIN school_verifications vv ON vv.user_id=vu.id AND vv.school_id=vu.school_id WHERE vu.id=${column})`;
  return `(EXISTS (SELECT 1 FROM friendships af WHERE af.user_low=${t}.user_low AND af.user_high=${t}.user_high AND af.status='accepted')
    AND NOT EXISTS (SELECT 1 FROM blocks ab WHERE (ab.blocker_id=${t}.user_low AND ab.blocked_id=${t}.user_high) OR (ab.blocker_id=${t}.user_high AND ab.blocked_id=${t}.user_low))
    ${CHAT.requiresVerification ? `AND ${verified(`${t}.user_low`)} AND ${verified(`${t}.user_high`)}` : ''})`;
}

/**
 * Number of accessible, unmuted threads with at least one unread, undeleted incoming message, plus one
 * for the global chat when it has unread messages and is not muted (§11). No ready() check.
 */
export function countUnreadChats(db: Db, userId: string): number {
  const me = db.prepare('SELECT display_name, full_name FROM users WHERE id=?').get(userId) as { display_name: string; full_name: string } | undefined;
  if (!me || !me.display_name || !me.full_name) return 0;
  const row = db.prepare(`SELECT count(*) n FROM chat_members m JOIN chat_threads t ON t.id=m.thread_id
    WHERE m.user_id=? AND m.muted=0 AND ${accessibleSql('t')}
    AND EXISTS (SELECT 1 FROM chat_messages c WHERE c.thread_id=t.id AND c.seq>m.last_read_seq AND c.sender_id<>? AND c.deleted_at IS NULL)`).get(userId, userId) as { n: number };
  return row.n + (countUnreadGlobal(db, userId) > 0 ? 1 : 0);
}

export class ChatService {
  constructor(private readonly service: Service, private readonly now: () => Date = () => new Date()) {}
  private get db() { return this.service.db; }
  private get community() { return new CommunityService(this.service); }
  private iso(offsetMs = 0): string { return new Date(this.now().getTime() + offsetMs).toISOString(); }

  /* ---------- Permission checks (§2) ---------- */

  /** The viewer may chat with `otherId`. Throws NOT_FOUND "This chat is closed." for every cause. */
  access(viewerId: string, otherId: string): User {
    const viewer = this.service.ready(viewerId);
    if (otherId === viewerId) fail('NOT_FOUND', CLOSED);
    const [low, high] = pair(viewerId, otherId);
    const friends = this.db.prepare("SELECT 1 FROM friendships WHERE user_low=? AND user_high=? AND status='accepted'").get(low, high);
    const other = this.db.prepare('SELECT id, school_id FROM users WHERE id=?').get(otherId) as { id: string; school_id: string | null } | undefined;
    const blocked = this.db.prepare('SELECT 1 FROM blocks WHERE (blocker_id=? AND blocked_id=?) OR (blocker_id=? AND blocked_id=?)').get(viewerId, otherId, otherId, viewerId);
    if (!other || !friends || blocked) fail('NOT_FOUND', CLOSED);
    if (CHAT.requiresVerification && !(this.community.isVerified(viewerId, viewer.schoolId) && this.community.isVerified(otherId, other!.school_id))) fail('NOT_FOUND', CLOSED);
    return viewer;
  }
  /** The pair's thread. The viewer is a member by construction, because a thread is keyed by the pair. */
  member(viewerId: string, otherId: string): ThreadRow {
    const thread = this.findThread(viewerId, otherId);
    if (!thread) return fail('NOT_FOUND', CLOSED);
    return thread;
  }
  notPaused(viewerId: string): void {
    if (this.pause(viewerId)) fail('FORBIDDEN', PAUSED);
  }
  pause(userId: string): ChatPause | null {
    const row = this.db.prepare('SELECT until FROM chat_pauses WHERE user_id=? AND (until IS NULL OR until>?)').get(userId, this.iso()) as { until: string | null } | undefined;
    return row ? { until: row.until } : null;
  }

  /* ---------- Helpers ---------- */

  private findThread(a: string, b: string): ThreadRow | undefined {
    const [low, high] = pair(a, b);
    return this.db.prepare('SELECT * FROM chat_threads WHERE user_low=? AND user_high=?').get(low, high) as ThreadRow | undefined;
  }
  private ensureThread(a: string, b: string): ThreadRow {
    const [low, high] = pair(a, b);
    this.db.prepare('INSERT OR IGNORE INTO chat_threads(id,user_low,user_high,revision,last_message_at,created_at) VALUES(?,?,?,0,NULL,?)').run(randomUUID(), low, high, this.iso());
    const thread = this.findThread(a, b)!;
    const member = this.db.prepare('INSERT OR IGNORE INTO chat_members(thread_id,user_id) VALUES(?,?)');
    member.run(thread.id, low); member.run(thread.id, high);
    return thread;
  }
  private bumpRevision(threadId: string): number {
    return (this.db.prepare('UPDATE chat_threads SET revision=revision+1 WHERE id=? RETURNING revision').get(threadId) as { revision: number }).revision;
  }
  private peer(viewer: User, otherId: string): ChatPeer {
    const row = this.db.prepare('SELECT id, display_name, full_name, school_id FROM users WHERE id=?').get(otherId) as PeerRow;
    return this.peerFromRow(viewer, row);
  }
  private peerFromRow(viewer: User, row: PeerRow): ChatPeer {
    const verified = this.community.isVerified(row.id, row.school_id);
    const viewerVerified = this.community.isVerified(viewer.id, viewer.schoolId);
    return { id: row.id, displayName: row.display_name, fullName: verified && viewerVerified ? row.full_name : null, verified };
  }
  private message(viewerId: string, row: MessageRow): ChatMessage {
    return { id: row.id, seq: row.seq, fromMe: row.sender_id === viewerId, body: row.deleted_at ? null : row.body, createdAt: row.created_at, deletedBy: row.deleted_at ? row.deleted_by : null };
  }
  private latestPage(threadId: string, before?: number): { rows: MessageRow[]; hasEarlier: boolean } {
    const rows = (before === undefined
      ? this.db.prepare('SELECT * FROM chat_messages WHERE thread_id=? ORDER BY seq DESC LIMIT ?').all(threadId, CHAT.page + 1)
      : this.db.prepare('SELECT * FROM chat_messages WHERE thread_id=? AND seq<? ORDER BY seq DESC LIMIT ?').all(threadId, before, CHAT.page + 1)) as MessageRow[];
    return { rows: rows.slice(0, CHAT.page).reverse(), hasEarlier: rows.length > CHAT.page };
  }
  private audit(actorId: string, action: string, schoolId: string | null, detail: unknown): void {
    this.db.prepare('INSERT INTO audit_log(actor_id,action,school_id,detail,created_at) VALUES(?,?,?,?,?)').run(actorId, action, schoolId, JSON.stringify(detail), this.iso());
  }

  /* ---------- Student procedures ---------- */

  unreadChats(userId: string): { unreadChats: number; unreadAt: string } {
    return { unreadChats: countUnreadChats(this.db, userId), unreadAt: new Date().toISOString() };
  }

  inbox(viewerId: string): { rows: InboxRow[]; unreadChats: number; unreadAt: string; pause: ChatPause | null } {
    const viewer = this.service.ready(viewerId);
    return this.db.transaction(() => {
      const friends = this.db.prepare(`SELECT u.id, u.display_name, u.full_name, u.school_id, t.id thread_id, t.last_message_at, m.last_read_seq, m.muted
        FROM friendships f JOIN users u ON u.id = CASE WHEN f.user_low=? THEN f.user_high ELSE f.user_low END
        LEFT JOIN chat_threads t ON t.user_low=f.user_low AND t.user_high=f.user_high
        LEFT JOIN chat_members m ON m.thread_id=t.id AND m.user_id=?
        WHERE f.status='accepted' AND (f.user_low=? OR f.user_high=?)
        AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id=f.user_low AND b.blocked_id=f.user_high) OR (b.blocker_id=f.user_high AND b.blocked_id=f.user_low))
        ORDER BY u.display_name COLLATE NOCASE, u.id`).all(viewerId, viewerId, viewerId, viewerId) as
        (PeerRow & { thread_id: string | null; last_message_at: string | null; last_read_seq: number | null; muted: number | null })[];
      const latest = this.db.prepare('SELECT * FROM chat_messages WHERE thread_id=? ORDER BY seq DESC LIMIT 1');
      const unread = this.db.prepare('SELECT count(*) n FROM chat_messages WHERE thread_id=? AND seq>? AND sender_id<>? AND deleted_at IS NULL');
      const open: { at: string; row: InboxRow }[] = [];
      const idle: InboxRow[] = [];
      for (const friend of friends) {
        if (CHAT.requiresVerification && !(this.community.isVerified(viewerId, viewer.schoolId) && this.community.isVerified(friend.id, friend.school_id))) continue;
        const peer = this.peerFromRow(viewer, friend);
        const muted = !!friend.muted;
        const last = friend.thread_id && friend.last_message_at ? latest.get(friend.thread_id) as MessageRow | undefined : undefined;
        if (!friend.thread_id || !friend.last_message_at || !last) {
          idle.push({ state: 'open', peer, lastMessage: null, unread: 0, muted });
          continue;
        }
        const deleted = !!last.deleted_at;
        open.push({ at: friend.last_message_at, row: {
          state: 'open', peer, muted,
          lastMessage: { fromMe: last.sender_id === viewerId, preview: deleted ? null : last.body.replace(/\s+/g, ' ').trim().slice(0, 120), createdAt: last.created_at, deletedBy: deleted ? last.deleted_by : null },
          unread: (unread.get(friend.thread_id, friend.last_read_seq ?? 0, viewerId) as { n: number }).n,
        } });
      }
      open.sort((left, right) => right.at.localeCompare(left.at));
      // Only the viewer's own block and the schools are consulted, so the row never reveals whether the other person blocked them.
      const closed = this.db.prepare(`SELECT u.id, u.display_name, u.school_id, t.last_message_at,
        EXISTS (SELECT 1 FROM blocks b WHERE b.blocker_id=? AND b.blocked_id=u.id) AS blocked_by_me
        FROM chat_members m JOIN chat_threads t ON t.id=m.thread_id
        JOIN users u ON u.id = CASE WHEN t.user_low=? THEN t.user_high ELSE t.user_low END
        WHERE m.user_id=? AND t.last_message_at IS NOT NULL AND t.last_message_at>=? AND NOT ${accessibleSql('t')}
        ORDER BY t.last_message_at DESC`).all(viewerId, viewerId, viewerId, this.iso(-CHAT.closedRowDays * DAY)) as
        { id: string; display_name: string; school_id: string | null; last_message_at: string; blocked_by_me: number }[];
      const reopenOf = (row: { school_id: string | null; blocked_by_me: number }): 'unblock' | 'friend' | null =>
        row.blocked_by_me ? 'unblock' : viewer.schoolId !== null && row.school_id === viewer.schoolId ? 'friend' : null;
      const rows: InboxRow[] = [
        ...open.map(entry => entry.row),
        ...closed.map(row => ({ state: 'closed' as const, userId: row.id, displayName: row.display_name, lastAt: row.last_message_at, reopen: reopenOf(row) })),
        ...idle,
      ];
      return { rows, ...this.unreadChats(viewerId), pause: this.pause(viewerId) };
    })();
  }

  thread(viewerId: string, otherId: string, cursor: { after?: number; before?: number } = {}) {
    if (otherId === viewerId) fail('BAD_REQUEST', SELF);
    if (cursor.after !== undefined && cursor.before !== undefined) fail('BAD_REQUEST', 'Use either after or before, not both.');
    return this.db.transaction(() => {
      const viewer = this.access(viewerId, otherId);
      const peer = this.peer(viewer, otherId);
      const pause = this.pause(viewerId);
      const thread = this.findThread(viewerId, otherId);
      if (!thread) {
        return { peer, messages: [] as ChatMessage[], revision: 0, lastReadSeq: 0, hasEarlier: false, reset: cursor.after !== undefined && cursor.after > 0, muted: false, pause };
      }
      const member = this.db.prepare('SELECT last_read_seq, muted FROM chat_members WHERE thread_id=? AND user_id=?').get(thread.id, viewerId) as { last_read_seq: number; muted: number } | undefined;
      const base = { peer, revision: thread.revision, lastReadSeq: member?.last_read_seq ?? 0, muted: !!member?.muted, pause };
      const toMessages = (rows: MessageRow[]) => rows.map(row => this.message(viewerId, row));
      if (cursor.after !== undefined) {
        const changes = cursor.after > thread.revision ? null
          : this.db.prepare('SELECT * FROM chat_messages WHERE thread_id=? AND revision>? ORDER BY seq LIMIT ?').all(thread.id, cursor.after, CHAT.maxChanges + 1) as MessageRow[];
        if (changes && changes.length <= CHAT.maxChanges) {
          // hasEarlier describes a page; an `after` poll is not a page, so the client keeps its own value.
          return { ...base, messages: toMessages(changes), hasEarlier: false, reset: false };
        }
        const page = this.latestPage(thread.id);
        return { ...base, messages: toMessages(page.rows), hasEarlier: page.hasEarlier, reset: true };
      }
      const page = this.latestPage(thread.id, cursor.before);
      return { ...base, messages: toMessages(page.rows), hasEarlier: page.hasEarlier, reset: false };
    })();
  }

  send(viewerId: string, otherId: string, clientId: string, raw: string): { message: ChatMessage } {
    if (otherId === viewerId) fail('BAD_REQUEST', SELF);
    const body = parseBody(raw);
    return this.db.transaction(() => {
      this.access(viewerId, otherId);
      const existing = this.db.prepare('SELECT * FROM chat_messages WHERE sender_id=? AND id=?').get(viewerId, clientId) as MessageRow | undefined;
      if (existing) {
        const thread = this.findThread(viewerId, otherId);
        if (!thread || existing.thread_id !== thread.id || existing.body !== body) fail('BAD_REQUEST', 'A retry ID cannot be reused for a different message.');
        return { message: this.message(viewerId, existing) };
      }
      this.notPaused(viewerId);
      const sent = (since: number) => (this.db.prepare('SELECT count(*) n FROM chat_messages WHERE sender_id=? AND created_at>?').get(viewerId, this.iso(-since)) as { n: number }).n;
      if (sent(60_000) >= CHAT.perMinute) fail('TOO_MANY_REQUESTS', 'You’re sending messages too fast. Wait a minute and try again.');
      if (sent(DAY) >= CHAT.perDay) fail('TOO_MANY_REQUESTS', 'You reached today’s message limit. Try again tomorrow.');
      const current = this.findThread(viewerId, otherId);
      const mine = current ? this.db.prepare('SELECT first_sent_at FROM chat_members WHERE thread_id=? AND user_id=?').get(current.id, viewerId) as { first_sent_at: string | null } | undefined : undefined;
      if (!mine?.first_sent_at) {
        const started = this.db.prepare('SELECT count(*) n FROM chat_members WHERE user_id=? AND first_sent_at IS NOT NULL AND first_sent_at>?').get(viewerId, this.iso(-DAY)) as { n: number };
        if (started.n >= CHAT.newChatsPerDay) fail('TOO_MANY_REQUESTS', 'You started 20 new chats today. Try again tomorrow.');
      }
      const thread = this.ensureThread(viewerId, otherId);
      const revision = this.bumpRevision(thread.id);
      const createdAt = this.iso();
      const row = this.db.prepare('INSERT INTO chat_messages(id,thread_id,sender_id,body,created_at,revision) VALUES(?,?,?,?,?,?) RETURNING *').get(clientId, thread.id, viewerId, body, createdAt, revision) as MessageRow;
      this.db.prepare('UPDATE chat_threads SET last_message_at=? WHERE id=?').run(createdAt, thread.id);
      this.db.prepare('UPDATE chat_members SET last_read_seq=max(last_read_seq, ?), first_sent_at=coalesce(first_sent_at, ?) WHERE thread_id=? AND user_id=?').run(row.seq, createdAt, thread.id, viewerId);
      return { message: this.message(viewerId, row) };
    })();
  }

  delete(viewerId: string, otherId: string, messageId: string): { deleted: true } {
    if (otherId === viewerId) fail('BAD_REQUEST', SELF);
    return this.db.transaction(() => {
      this.access(viewerId, otherId);
      const thread = this.member(viewerId, otherId);
      const row = this.db.prepare('SELECT * FROM chat_messages WHERE thread_id=? AND sender_id=? AND id=?').get(thread.id, viewerId, messageId) as MessageRow | undefined;
      if (!row) return fail('NOT_FOUND', CLOSED);
      if (row.deleted_at) return { deleted: true as const };
      const revision = this.bumpRevision(thread.id);
      this.db.prepare("UPDATE chat_messages SET deleted_at=?, deleted_by='sender', revision=? WHERE seq=?").run(this.iso(), revision, row.seq);
      return { deleted: true as const };
    })();
  }

  read(viewerId: string, otherId: string, seq: number): { unreadChats: number; unreadAt: string } {
    if (otherId === viewerId) fail('BAD_REQUEST', SELF);
    return this.db.transaction(() => {
      this.access(viewerId, otherId);
      const thread = this.findThread(viewerId, otherId);
      if (thread) {
        this.db.prepare(`UPDATE chat_members SET last_read_seq=max(last_read_seq, min(?, (SELECT coalesce(max(seq), 0) FROM chat_messages WHERE thread_id=?)))
          WHERE thread_id=? AND user_id=?`).run(seq, thread.id, thread.id, viewerId);
      }
      return this.unreadChats(viewerId);
    })();
  }

  /** Mute is the viewer's own setting, so a paused student can still use it. */
  mute(viewerId: string, otherId: string, muted: boolean): { muted: boolean } {
    if (otherId === viewerId) fail('BAD_REQUEST', SELF);
    return this.db.transaction(() => {
      this.access(viewerId, otherId);
      const thread = this.ensureThread(viewerId, otherId);
      this.db.prepare('UPDATE chat_members SET muted=? WHERE thread_id=? AND user_id=?').run(Number(muted), thread.id, viewerId);
      return { muted };
    })();
  }

  /** Needs only membership, so a student who blocked, was blocked or was unfriended can still report (D7). */
  report(viewerId: string, otherId: string, raw: { category: ReportCategory; note?: string; seq?: number; block: boolean }): { blocked: boolean } {
    if (otherId === viewerId) fail('BAD_REQUEST', SELF);
    const input = chatReportSchema.omit({ userId: true }).parse(raw);
    const viewer = this.service.ready(viewerId);
    return this.db.transaction(() => {
      const thread = this.member(viewerId, otherId);
      let items: StoredItem[];
      const item = (row: MessageRow, anchor = false): StoredItem => ({ seq: row.seq, fromReported: row.sender_id === otherId, body: row.body, createdAt: row.created_at, deletedBy: row.deleted_at ? row.deleted_by : null, anchor });
      if (input.seq !== undefined) {
        const anchor = this.db.prepare('SELECT * FROM chat_messages WHERE thread_id=? AND seq=?').get(thread.id, input.seq) as MessageRow | undefined;
        if (!anchor) return fail('NOT_FOUND', CLOSED);
        if (anchor.sender_id === viewerId) fail('BAD_REQUEST', 'You cannot report your own message.');
        if (!anchor.body) fail('BAD_REQUEST', NOTHING_TO_REPORT);
        const before = this.db.prepare("SELECT * FROM chat_messages WHERE thread_id=? AND seq<? AND body<>'' ORDER BY seq DESC LIMIT ?").all(thread.id, anchor.seq, CHAT.evidenceBefore) as MessageRow[];
        const after = this.db.prepare("SELECT * FROM chat_messages WHERE thread_id=? AND seq>? AND body<>'' ORDER BY seq LIMIT ?").all(thread.id, anchor.seq, CHAT.evidenceAfter) as MessageRow[];
        items = [...before.reverse().map(row => item(row)), item(anchor, true), ...after.map(row => item(row))];
      } else {
        const latest = this.db.prepare("SELECT * FROM chat_messages WHERE thread_id=? AND body<>'' ORDER BY seq DESC LIMIT ?").all(thread.id, CHAT.evidence) as MessageRow[];
        items = latest.reverse().map(row => item(row));
      }
      if (!items.length) fail('BAD_REQUEST', NOTHING_TO_REPORT);
      if (this.db.prepare('SELECT 1 FROM reports WHERE reporter_id=? AND thread_id=? AND resolved_at IS NULL').get(viewerId, thread.id)) fail('CONFLICT', 'You already reported this chat. Support will review it.');
      const open = this.db.prepare('SELECT count(*) n FROM reports WHERE reporter_id=? AND resolved_at IS NULL').get(viewerId) as { n: number };
      if (open.n >= 10) fail('TOO_MANY_REQUESTS', 'You already have ten open reports. Wait for support to review them.');
      const other = this.db.prepare('SELECT school_id FROM users WHERE id=?').get(otherId) as { school_id: string | null };
      const label = REPORT_CATEGORIES[input.category].label;
      this.db.prepare('INSERT INTO reports(id,reporter_id,reported_id,school_id,reason,created_at,thread_id,evidence,category) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(randomUUID(), viewerId, otherId, other.school_id ?? viewer.schoolId, input.note ? `${label}: ${input.note}` : label, this.iso(), thread.id, JSON.stringify(items), input.category);
      if (input.block) this.community.block(viewerId, otherId, true);
      return { blocked: input.block };
    })();
  }

  /**
   * Reopens a closed chat from the viewer's side: lifts the viewer's own block, if any, then sends a friend
   * request (or accepts the other person's waiting one, which reopens the chat at once). The old history
   * comes back once they are friends again. Failures from `request` keep their phase-3 wording.
   */
  reopen(viewerId: string, otherId: string): ReopenResult {
    if (otherId === viewerId) fail('BAD_REQUEST', SELF);
    return this.db.transaction(() => {
      this.service.ready(viewerId);
      const unblocked = !!this.db.prepare('SELECT 1 FROM blocks WHERE blocker_id=? AND blocked_id=?').get(viewerId, otherId);
      if (unblocked) this.community.block(viewerId, otherId, false);
      const friendState = this.community.request(viewerId, otherId);
      if (friendState !== 'friends' && friendState !== 'requested') fail('CONFLICT', 'This chat cannot be reopened right now.');
      return { unblocked, friendState };
    })();
  }

  setPush(viewerId: string, enabled: boolean): { enabled: boolean } {
    this.service.user(viewerId);
    this.db.prepare('UPDATE users SET chat_push=? WHERE id=?').run(Number(enabled), viewerId);
    return { enabled };
  }

  /* ---------- Support (owner only) ---------- */

  private evidenceReport(reportId: string) {
    const report = this.db.prepare('SELECT id, reporter_id, reported_id, school_id, thread_id, evidence FROM reports WHERE id=?').get(reportId) as
      { id: string; reporter_id: string; reported_id: string; school_id: string | null; thread_id: string | null; evidence: string | null } | undefined;
    if (!report || !report.thread_id || !report.evidence) return fail('NOT_FOUND', 'This report has no messages.');
    return { ...report, items: JSON.parse(report.evidence) as StoredItem[] };
  }
  /** The only path from chat text to the owner: a report's frozen snapshot, and every view is audited. */
  showEvidence(adminId: string, reportId: string): { items: EvidenceItem[] } {
    this.service.admin(adminId);
    return this.db.transaction(() => {
      const report = this.evidenceReport(reportId);
      const name = (id: string) => (this.db.prepare('SELECT display_name FROM users WHERE id=?').get(id) as { display_name: string } | undefined)?.display_name ?? '';
      const reportedName = name(report.reported_id), reporterName = name(report.reporter_id);
      this.audit(adminId, 'reports.view', report.school_id, { reportId });
      return { items: report.items.map(entry => ({ ...entry, senderName: entry.fromReported ? reportedName : reporterName })) };
    })();
  }
  redactMessage(adminId: string, reportId: string, seq: number): void {
    this.service.admin(adminId);
    this.db.transaction(() => {
      const report = this.evidenceReport(reportId);
      const target = report.items.find(entry => entry.seq === seq);
      if (!target) fail('NOT_FOUND', 'This message is not in this report.');
      const row = this.db.prepare('SELECT seq FROM chat_messages WHERE seq=? AND thread_id=?').get(seq, report.thread_id) as { seq: number } | undefined;
      if (row) {
        const revision = this.bumpRevision(report.thread_id!);
        this.db.prepare("UPDATE chat_messages SET deleted_at=coalesce(deleted_at, ?), deleted_by='support', revision=? WHERE seq=?").run(this.iso(), revision, seq);
      }
      const items = report.items.map(entry => entry.seq === seq ? { ...entry, deletedBy: 'support' as const } : entry);
      this.db.prepare('UPDATE reports SET evidence=? WHERE id=?').run(JSON.stringify(items), reportId);
      this.audit(adminId, 'chat.redact', report.school_id, { reportId, seq });
    })();
  }
  pauseChat(adminId: string, raw: z.infer<typeof pauseChatSchema>): void {
    this.service.admin(adminId);
    const input = pauseChatSchema.parse(raw);
    this.db.transaction(() => {
      const user = this.db.prepare('SELECT school_id FROM users WHERE id=?').get(input.userId) as { school_id: string | null } | undefined;
      if (!user) return fail('NOT_FOUND', 'Member not found.');
      const until = input.days === null ? null : this.iso(input.days * DAY);
      this.db.prepare('INSERT OR REPLACE INTO chat_pauses(user_id,until,actor_id,reason,created_at) VALUES(?,?,?,?,?)').run(input.userId, until, adminId, input.reason, this.iso());
      this.db.prepare("UPDATE reports SET resolved_at=?, actor_id=?, outcome='paused' WHERE reported_id=? AND resolved_at IS NULL").run(this.iso(), adminId, input.userId);
      this.audit(adminId, 'chat.pause', user.school_id, { userId: input.userId, days: input.days, reason: input.reason });
    })();
  }
  liftChatPause(adminId: string, userId: string): void {
    this.service.admin(adminId);
    this.db.transaction(() => {
      const user = this.db.prepare('SELECT school_id FROM users WHERE id=?').get(userId) as { school_id: string | null } | undefined;
      if (!user) return fail('NOT_FOUND', 'Member not found.');
      this.db.prepare('DELETE FROM chat_pauses WHERE user_id=?').run(userId);
      this.audit(adminId, 'chat.resume', user.school_id, { userId });
    })();
  }
  chatPauses(adminId: string): { userId: string; displayName: string; email: string; until: string | null; reason: string; createdAt: string }[] {
    this.service.admin(adminId);
    return this.db.prepare(`SELECT p.user_id userId, u.display_name displayName, u.email, p.until, p.reason, p.created_at createdAt
      FROM chat_pauses p JOIN users u ON u.id=p.user_id WHERE p.until IS NULL OR p.until>? ORDER BY p.created_at`).all(this.iso()) as
      { userId: string; displayName: string; email: string; until: string | null; reason: string; createdAt: string }[];
  }
}

/** Retention (§3.5). The worker runs this every cycle, in one transaction. */
export function pruneChat(db: Db, now: Date = new Date()): void {
  const ago = (days: number) => new Date(now.getTime() - days * DAY).toISOString();
  db.transaction(() => {
    db.prepare('DELETE FROM chat_messages WHERE created_at < ?').run(ago(CHAT.retentionDays));
    db.prepare("UPDATE chat_messages SET body='' WHERE deleted_at IS NOT NULL AND deleted_at < ? AND body <> ''").run(ago(CHAT.deletedTextDays));
    db.prepare('UPDATE reports SET evidence=NULL WHERE evidence IS NOT NULL AND resolved_at IS NOT NULL AND resolved_at < ?').run(ago(CHAT.evidenceDays));
    db.prepare('DELETE FROM chat_threads WHERE last_message_at < ? OR (last_message_at IS NULL AND created_at < ?)').run(ago(CHAT.retentionDays), ago(CHAT.retentionDays));
    db.prepare("DELETE FROM notification_deliveries WHERE entity_id='chat:messages' AND updated_at < ?").run(ago(2));
  })();
}
