import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { CHAT, bodyError, censorBody, normalizeBody, rawBodySchema } from '@/domain/chat';
// A cycle with ./chat, safe because neither module uses the other's exports while it loads.
import { countUnreadChats, listPreview } from './chat';
import type { Db } from './db';
import type { Service } from './service';

/**
 * The global chat (docs/CHAT.md §11): one room that every member with names entered can read and post
 * in. Unlike one-to-one chat it is public by design, so the owner moderates it directly: the owner can
 * edit or delete any message, and slurs are censored to asterisks before a message is stored.
 *
 * Every error message is a fixed string: nothing here ever echoes message text.
 */

type FailCode = 'FORBIDDEN' | 'NOT_FOUND' | 'BAD_REQUEST' | 'TOO_MANY_REQUESTS';
const fail: (code: FailCode, message: string) => never = (code, message) => { throw new TRPCError({ code, message }); };
const DAY = 86_400_000;

export const PAUSED = 'Support paused your messaging.';
const MISSING = 'That message is gone.';

export type GlobalDeletedBy = 'sender' | 'owner' | null;
export type GlobalSender = { id: string; displayName: string; verified: boolean };
export type GlobalMessage = { id: string; seq: number; fromMe: boolean; body: string | null; createdAt: string;
  deletedBy: GlobalDeletedBy; editedAt: string | null;
  /** The owner's reason for editing or removing this message (may be empty); null when the owner didn't touch it. */
  reason: string | null; sender: GlobalSender };
export type GlobalRoom = { members: number; canModerate: boolean };
export type GlobalSummary = {
  lastMessage: { senderName: string; fromMe: boolean; preview: string | null; createdAt: string; deletedBy: GlobalDeletedBy } | null;
  unread: number; muted: boolean;
};

type MessageRow = { seq: number; id: string; sender_id: string; body: string; created_at: string; edited_at: string | null;
  deleted_at: string | null; deleted_by: GlobalDeletedBy; reason: string | null; revision: number; display_name: string; verified: number };
type MemberRow = { last_read_seq: number; muted: number };

export const globalThreadSchema = z.object({
  after: z.number().int().min(0).optional(),
  before: z.number().int().positive().optional(),
}).refine(input => input.after === undefined || input.before === undefined, 'Use either after or before, not both.');
export const globalSendSchema = z.object({ clientId: z.uuid(), body: rawBodySchema });
export const globalMessageSchema = z.object({ messageId: z.uuid() });
/** The owner's reason, shown to everyone. Ignored when a sender deletes their own message. */
export const reasonSchema = z.string().trim().max(200).default('');
export const globalDeleteSchema = globalMessageSchema.extend({ reason: reasonSchema });
export const globalEditSchema = globalMessageSchema.extend({ body: rawBodySchema, reason: reasonSchema });
export const globalReadSchema = z.object({ seq: z.number().int().min(0) });
export const globalMuteSchema = z.object({ muted: z.boolean() });

/** normalizeBody, slurs censored to asterisks outside https links (censorBody), then bodyError, throwing BAD_REQUEST with a fixed string. Never echoes input. */
export function parseGlobalBody(raw: string): string {
  const body = censorBody(normalizeBody(typeof raw === 'string' ? raw : ''));
  const problem = bodyError(body);
  if (problem) fail('BAD_REQUEST', problem);
  return body;
}

const MESSAGE_SQL = `SELECT c.*, u.display_name,
  EXISTS (SELECT 1 FROM school_verifications v WHERE v.user_id=u.id AND v.school_id=u.school_id) AS verified
  FROM global_messages c JOIN users u ON u.id=c.sender_id`;

/**
 * SQL that keeps a message only when the viewer has not blocked its sender (docs/CHAT.md §11). One way on purpose:
 * the blocker stops seeing the blocked member's room messages, in the thread, the list preview, the unread count
 * and pushes, while the blocked member's view of the room does not change, so it cannot be compared to find a block.
 */
export const NOT_BLOCKED_SENDER_SQL = (viewer: string) => `NOT EXISTS (SELECT 1 FROM blocks b WHERE b.blocker_id=${viewer} AND b.blocked_id=c.sender_id)`;

/**
 * SQL for a member's read marker. Someone without a `global_members` row starts at the newest message that
 * existed when their account was created, so a newcomer never sees the whole backlog as unread.
 */
export const GLOBAL_READ_SEQ_SQL = (user: string) => `coalesce((SELECT m.last_read_seq FROM global_members m WHERE m.user_id=${user}),
  (SELECT coalesce(max(g.seq), 0) FROM global_messages g WHERE g.created_at < (SELECT u.created_at FROM users u WHERE u.id=${user})))`;

/** Unread, undeleted messages from others (not ones the member blocked) past the member's read marker; 0 when muted or not yet ready. */
export function countUnreadGlobal(db: Db, userId: string): number {
  const row = db.prepare(`SELECT count(*) n FROM global_messages c
    WHERE c.sender_id<>@user AND c.deleted_at IS NULL AND ${NOT_BLOCKED_SENDER_SQL('@user')}
    AND c.seq > ${GLOBAL_READ_SEQ_SQL('@user')}
    AND NOT coalesce((SELECT m.muted FROM global_members m WHERE m.user_id=@user), 0)`).get({ user: userId }) as { n: number };
  return row.n;
}

/**
 * Messages a member sent after `since` (ISO), one-to-one and in the room together: the per-minute and per-day
 * limits (docs/CHAT.md §3.3, §11) are one budget per sender across every chat, not one per surface.
 */
export function countSentSince(db: Db, userId: string, since: string): number {
  const row = db.prepare(`SELECT (SELECT count(*) FROM chat_messages WHERE sender_id=@user AND created_at>@since)
    + (SELECT count(*) FROM global_messages WHERE sender_id=@user AND created_at>@since) n`).get({ user: userId, since }) as { n: number };
  return row.n;
}

/** Creates a member's row seeded with their current read marker, so it never resets to 0 (the whole backlog). */
export function ensureGlobalMember(db: Db, userId: string): void {
  db.prepare(`INSERT OR IGNORE INTO global_members(user_id, last_read_seq) VALUES(@user, ${GLOBAL_READ_SEQ_SQL('@user')})`).run({ user: userId });
}

export class GlobalChatService {
  constructor(private readonly service: Service, private readonly now: () => Date = () => new Date()) {}
  private get db() { return this.service.db; }
  private iso(offsetMs = 0): string { return new Date(this.now().getTime() + offsetMs).toISOString(); }

  /* ---------- Helpers ---------- */

  private notPaused(viewerId: string): void {
    if (this.db.prepare('SELECT 1 FROM chat_pauses WHERE user_id=? AND (until IS NULL OR until>?)').get(viewerId, this.iso())) fail('FORBIDDEN', PAUSED);
  }
  private pause(userId: string): { until: string | null } | null {
    const row = this.db.prepare('SELECT until FROM chat_pauses WHERE user_id=? AND (until IS NULL OR until>?)').get(userId, this.iso()) as { until: string | null } | undefined;
    return row ? { until: row.until } : null;
  }
  private member(userId: string): MemberRow {
    return this.db.prepare(`SELECT ${GLOBAL_READ_SEQ_SQL('@user')} AS last_read_seq, coalesce((SELECT m.muted FROM global_members m WHERE m.user_id=@user), 0) AS muted`).get({ user: userId }) as MemberRow;
  }
  private ensureMember(userId: string): void {
    ensureGlobalMember(this.db, userId);
  }
  private revision(): number {
    return (this.db.prepare('SELECT revision FROM global_chat WHERE id=1').get() as { revision: number }).revision;
  }
  private bumpRevision(): number {
    return (this.db.prepare('UPDATE global_chat SET revision=revision+1 WHERE id=1 RETURNING revision').get() as { revision: number }).revision;
  }
  private room(viewerId: string): GlobalRoom {
    const members = this.db.prepare("SELECT count(*) n FROM users WHERE display_name<>'' AND full_name<>''").get() as { n: number };
    return { members: members.n, canModerate: this.service.isAdmin(viewerId) };
  }
  private message(viewerId: string, row: MessageRow): GlobalMessage {
    return {
      id: row.id, seq: row.seq, fromMe: row.sender_id === viewerId, body: row.deleted_at ? null : row.body, createdAt: row.created_at,
      deletedBy: row.deleted_at ? row.deleted_by : null, editedAt: row.deleted_at ? null : row.edited_at,
      reason: (row.deleted_at ? row.deleted_by === 'owner' : !!row.edited_at) ? row.reason ?? '' : null,
      sender: { id: row.sender_id, displayName: row.display_name, verified: !!row.verified },
    };
  }
  /** The newest page the viewer can see (messages from members they blocked are left out). */
  private latestPage(viewerId: string, before?: number): { rows: MessageRow[]; hasEarlier: boolean } {
    const rows = (before === undefined
      ? this.db.prepare(`${MESSAGE_SQL} WHERE ${NOT_BLOCKED_SENDER_SQL('?')} ORDER BY c.seq DESC LIMIT ?`).all(viewerId, CHAT.page + 1)
      : this.db.prepare(`${MESSAGE_SQL} WHERE ${NOT_BLOCKED_SENDER_SQL('?')} AND c.seq<? ORDER BY c.seq DESC LIMIT ?`).all(viewerId, before, CHAT.page + 1)) as MessageRow[];
    return { rows: rows.slice(0, CHAT.page).reverse(), hasEarlier: rows.length > CHAT.page };
  }
  private find(messageId: string): MessageRow | undefined {
    return this.db.prepare(`${MESSAGE_SQL} WHERE c.id=?`).get(messageId) as MessageRow | undefined;
  }
  private unreadChats(viewerId: string): { unreadChats: number; unreadAt: string } {
    return { unreadChats: countUnreadChats(this.db, viewerId), unreadAt: new Date().toISOString() };
  }
  private audit(actorId: string, action: string, detail: unknown): void {
    this.db.prepare('INSERT INTO audit_log(actor_id,action,school_id,detail,created_at) VALUES(?,?,NULL,?,?)').run(actorId, action, JSON.stringify(detail), this.iso());
  }

  /* ---------- Member procedures ---------- */

  /** The chat-list row: the newest message, the viewer's unread count and mute. */
  summary(viewerId: string): GlobalSummary {
    this.service.ready(viewerId);
    const member = this.member(viewerId);
    const last = this.db.prepare(`${MESSAGE_SQL} WHERE ${NOT_BLOCKED_SENDER_SQL('?')} ORDER BY c.seq DESC LIMIT 1`).get(viewerId) as MessageRow | undefined;
    const deleted = !!last?.deleted_at;
    return {
      lastMessage: last ? { senderName: last.display_name, fromMe: last.sender_id === viewerId, preview: deleted ? null : listPreview(last.body), createdAt: last.created_at, deletedBy: deleted ? last.deleted_by : null } : null,
      unread: countUnreadGlobal(this.db, viewerId),
      muted: !!member.muted,
    };
  }

  thread(viewerId: string, cursor: { after?: number; before?: number } = {}) {
    if (cursor.after !== undefined && cursor.before !== undefined) fail('BAD_REQUEST', 'Use either after or before, not both.');
    return this.db.transaction(() => {
      this.service.ready(viewerId);
      const member = this.member(viewerId);
      const revision = this.revision();
      const base = { peer: null, room: this.room(viewerId), revision, lastReadSeq: member.last_read_seq, muted: !!member.muted, pause: this.pause(viewerId) };
      const toMessages = (rows: MessageRow[]) => rows.map(row => this.message(viewerId, row));
      if (cursor.after !== undefined) {
        const changes = cursor.after > revision ? null
          : this.db.prepare(`${MESSAGE_SQL} WHERE ${NOT_BLOCKED_SENDER_SQL('?')} AND c.revision>? ORDER BY c.seq LIMIT ?`).all(viewerId, cursor.after, CHAT.maxChanges + 1) as MessageRow[];
        if (changes && changes.length <= CHAT.maxChanges) return { ...base, messages: toMessages(changes), hasEarlier: false, reset: false };
        const page = this.latestPage(viewerId);
        return { ...base, messages: toMessages(page.rows), hasEarlier: page.hasEarlier, reset: true };
      }
      const page = this.latestPage(viewerId, cursor.before);
      return { ...base, messages: toMessages(page.rows), hasEarlier: page.hasEarlier, reset: false };
    })();
  }

  send(viewerId: string, clientId: string, raw: string): { message: GlobalMessage } {
    const body = parseGlobalBody(raw);
    return this.db.transaction(() => {
      this.service.ready(viewerId);
      const existing = this.db.prepare(`${MESSAGE_SQL} WHERE c.sender_id=? AND c.id=?`).get(viewerId, clientId) as MessageRow | undefined;
      if (existing) {
        if (existing.body !== body && !existing.edited_at) fail('BAD_REQUEST', 'A retry ID cannot be reused for a different message.');
        return { message: this.message(viewerId, existing) };
      }
      // IDs are unique across the room (owner Remove and Edit address messages by ID), so another member's ID is refused.
      if (this.db.prepare('SELECT 1 FROM global_messages WHERE id=?').get(clientId)) fail('BAD_REQUEST', 'A retry ID cannot be reused for a different message.');
      this.notPaused(viewerId);
      const sent = (since: number) => countSentSince(this.db, viewerId, this.iso(-since));
      if (sent(60_000) >= CHAT.perMinute) fail('TOO_MANY_REQUESTS', 'You’re sending messages too fast. Wait a minute and try again.');
      if (sent(DAY) >= CHAT.perDay) fail('TOO_MANY_REQUESTS', 'You reached today’s message limit. Try again tomorrow.');
      const revision = this.bumpRevision();
      const createdAt = this.iso();
      const { seq } = this.db.prepare('INSERT INTO global_messages(id,sender_id,body,created_at,revision) VALUES(?,?,?,?,?) RETURNING seq').get(clientId, viewerId, body, createdAt, revision) as { seq: number };
      this.db.prepare('UPDATE global_chat SET last_message_at=? WHERE id=1').run(createdAt);
      this.ensureMember(viewerId);
      this.db.prepare('UPDATE global_members SET last_read_seq=max(last_read_seq, ?) WHERE user_id=?').run(seq, viewerId);
      return { message: this.message(viewerId, this.db.prepare(`${MESSAGE_SQL} WHERE c.seq=?`).get(seq) as MessageRow) };
    }).immediate();
  }

  /** The sender deletes their own message; the owner deletes anyone's, with a reason everyone can see (audited). */
  delete(viewerId: string, messageId: string, rawReason = ''): { deleted: true } {
    const reason = reasonSchema.parse(rawReason);
    return this.db.transaction(() => {
      this.service.ready(viewerId);
      const row = this.find(messageId);
      if (!row) return fail('NOT_FOUND', MISSING);
      const owner = this.service.isAdmin(viewerId);
      if (row.sender_id !== viewerId && !owner) fail('FORBIDDEN', 'Only the owner can delete other people’s messages.');
      if (row.deleted_at) return { deleted: true as const };
      const by = row.sender_id === viewerId ? 'sender' : 'owner';
      this.db.prepare('UPDATE global_messages SET deleted_at=?, deleted_by=?, reason=?, revision=? WHERE seq=?').run(this.iso(), by, by === 'owner' ? reason : null, this.bumpRevision(), row.seq);
      if (by === 'owner') this.audit(viewerId, 'global.delete', { seq: row.seq, senderId: row.sender_id, reason });
      return { deleted: true as const };
    }).immediate();
  }

  /** Owner only: replaces the text of any message, with a reason everyone can see. The filter applies to the new text; the edit is audited. */
  edit(adminId: string, messageId: string, raw: string, rawReason = ''): { message: GlobalMessage } {
    this.service.admin(adminId);
    const body = parseGlobalBody(raw);
    const reason = reasonSchema.parse(rawReason);
    return this.db.transaction(() => {
      const row = this.find(messageId);
      if (!row || row.deleted_at) return fail('NOT_FOUND', MISSING);
      if (row.body !== body || (row.reason ?? '') !== reason) {
        this.db.prepare('UPDATE global_messages SET body=?, edited_at=?, reason=?, revision=? WHERE seq=?').run(body, this.iso(), reason, this.bumpRevision(), row.seq);
        this.audit(adminId, 'global.edit', { seq: row.seq, senderId: row.sender_id, reason });
      }
      return { message: this.message(adminId, this.find(messageId)!) };
    }).immediate();
  }

  /** Also returns the Messages badge count (the room counts as one chat), stamped like chat.read's, so the badge updates at once. */
  read(viewerId: string, seq: number): { unreadGlobal: number; unreadChats: number; unreadAt: string } {
    return this.db.transaction(() => {
      this.service.ready(viewerId);
      this.ensureMember(viewerId);
      this.db.prepare('UPDATE global_members SET last_read_seq=max(last_read_seq, min(?, (SELECT coalesce(max(seq), 0) FROM global_messages))) WHERE user_id=?').run(seq, viewerId);
      return { unreadGlobal: countUnreadGlobal(this.db, viewerId), ...this.unreadChats(viewerId) };
    }).immediate();
  }

  /** Returns the new badge count too: a muted room is left out of it. */
  mute(viewerId: string, muted: boolean): { muted: boolean; unreadChats: number; unreadAt: string } {
    return this.db.transaction(() => {
      this.service.ready(viewerId);
      this.ensureMember(viewerId);
      this.db.prepare('UPDATE global_members SET muted=? WHERE user_id=?').run(Number(muted), viewerId);
      return { muted, ...this.unreadChats(viewerId) };
    }).immediate();
  }
}

/** Retention, same numbers as one-to-one chat (§3.5): messages go after 180 days, deleted text after 30. */
export function pruneGlobalChat(db: Db, now: Date = new Date()): void {
  const ago = (days: number) => new Date(now.getTime() - days * DAY).toISOString();
  db.transaction(() => {
    db.prepare('DELETE FROM global_messages WHERE created_at < ?').run(ago(CHAT.retentionDays));
    db.prepare("UPDATE global_messages SET body='' WHERE deleted_at IS NOT NULL AND deleted_at < ? AND body <> ''").run(ago(CHAT.deletedTextDays));
  }).immediate();
}
