import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { CHAT, bodyError, normalizeBody, rawBodySchema } from '@/domain/chat';
import { slurError } from '@/domain/chat-filter';
import type { Db } from './db';
import type { Service } from './service';

/**
 * The global chat (docs/CHAT.md §11): one room that every member with names entered can read and post
 * in. Unlike one-to-one chat it is public by design, so the owner moderates it directly: the owner can
 * edit or delete any message, and the slur filter refuses a message before it is stored.
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

/** normalizeBody + bodyError + the slur filter, throwing BAD_REQUEST with a fixed string. Never echoes input. */
export function parseGlobalBody(raw: string): string {
  const body = normalizeBody(typeof raw === 'string' ? raw : '');
  const problem = bodyError(body) ?? slurError(body);
  if (problem) fail('BAD_REQUEST', problem);
  return body;
}

const MESSAGE_SQL = `SELECT c.*, u.display_name,
  EXISTS (SELECT 1 FROM school_verifications v WHERE v.user_id=u.id AND v.school_id=u.school_id) AS verified
  FROM global_messages c JOIN users u ON u.id=c.sender_id`;

/**
 * SQL for a member's read marker. Someone without a `global_members` row starts at the newest message that
 * existed when their account was created, so a newcomer never sees the whole backlog as unread.
 */
export const GLOBAL_READ_SEQ_SQL = (user: string) => `coalesce((SELECT m.last_read_seq FROM global_members m WHERE m.user_id=${user}),
  (SELECT coalesce(max(g.seq), 0) FROM global_messages g WHERE g.created_at < (SELECT u.created_at FROM users u WHERE u.id=${user})))`;

/** Unread, undeleted messages from others past the member's read marker; 0 when muted or not yet ready. */
export function countUnreadGlobal(db: Db, userId: string): number {
  const row = db.prepare(`SELECT count(*) n FROM global_messages c
    WHERE c.sender_id<>@user AND c.deleted_at IS NULL
    AND c.seq > ${GLOBAL_READ_SEQ_SQL('@user')}
    AND NOT coalesce((SELECT m.muted FROM global_members m WHERE m.user_id=@user), 0)`).get({ user: userId }) as { n: number };
  return row.n;
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
    this.db.prepare(`INSERT OR IGNORE INTO global_members(user_id, last_read_seq) VALUES(@user, ${GLOBAL_READ_SEQ_SQL('@user')})`).run({ user: userId });
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
  private latestPage(before?: number): { rows: MessageRow[]; hasEarlier: boolean } {
    const rows = (before === undefined
      ? this.db.prepare(`${MESSAGE_SQL} ORDER BY c.seq DESC LIMIT ?`).all(CHAT.page + 1)
      : this.db.prepare(`${MESSAGE_SQL} WHERE c.seq<? ORDER BY c.seq DESC LIMIT ?`).all(before, CHAT.page + 1)) as MessageRow[];
    return { rows: rows.slice(0, CHAT.page).reverse(), hasEarlier: rows.length > CHAT.page };
  }
  private find(messageId: string): MessageRow | undefined {
    return this.db.prepare(`${MESSAGE_SQL} WHERE c.id=?`).get(messageId) as MessageRow | undefined;
  }
  private audit(actorId: string, action: string, detail: unknown): void {
    this.db.prepare('INSERT INTO audit_log(actor_id,action,school_id,detail,created_at) VALUES(?,?,NULL,?,?)').run(actorId, action, JSON.stringify(detail), this.iso());
  }

  /* ---------- Member procedures ---------- */

  /** The chat-list row: the newest message, the viewer's unread count and mute. */
  summary(viewerId: string): GlobalSummary {
    this.service.ready(viewerId);
    const member = this.member(viewerId);
    const last = this.db.prepare(`${MESSAGE_SQL} ORDER BY c.seq DESC LIMIT 1`).get() as MessageRow | undefined;
    const deleted = !!last?.deleted_at;
    return {
      lastMessage: last ? { senderName: last.display_name, fromMe: last.sender_id === viewerId, preview: deleted ? null : last.body.replace(/\s+/g, ' ').trim().slice(0, 120), createdAt: last.created_at, deletedBy: deleted ? last.deleted_by : null } : null,
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
          : this.db.prepare(`${MESSAGE_SQL} WHERE c.revision>? ORDER BY c.seq LIMIT ?`).all(cursor.after, CHAT.maxChanges + 1) as MessageRow[];
        if (changes && changes.length <= CHAT.maxChanges) return { ...base, messages: toMessages(changes), hasEarlier: false, reset: false };
        const page = this.latestPage();
        return { ...base, messages: toMessages(page.rows), hasEarlier: page.hasEarlier, reset: true };
      }
      const page = this.latestPage(cursor.before);
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
      this.notPaused(viewerId);
      const sent = (since: number) => (this.db.prepare('SELECT count(*) n FROM global_messages WHERE sender_id=? AND created_at>?').get(viewerId, this.iso(-since)) as { n: number }).n;
      if (sent(60_000) >= CHAT.perMinute) fail('TOO_MANY_REQUESTS', 'You’re sending messages too fast. Wait a minute and try again.');
      if (sent(DAY) >= CHAT.perDay) fail('TOO_MANY_REQUESTS', 'You reached today’s message limit. Try again tomorrow.');
      const revision = this.bumpRevision();
      const createdAt = this.iso();
      const { seq } = this.db.prepare('INSERT INTO global_messages(id,sender_id,body,created_at,revision) VALUES(?,?,?,?,?) RETURNING seq').get(clientId, viewerId, body, createdAt, revision) as { seq: number };
      this.db.prepare('UPDATE global_chat SET last_message_at=? WHERE id=1').run(createdAt);
      this.ensureMember(viewerId);
      this.db.prepare('UPDATE global_members SET last_read_seq=max(last_read_seq, ?) WHERE user_id=?').run(seq, viewerId);
      return { message: this.message(viewerId, this.find(clientId)!) };
    })();
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
    })();
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
    })();
  }

  read(viewerId: string, seq: number): { unreadGlobal: number } {
    return this.db.transaction(() => {
      this.service.ready(viewerId);
      this.ensureMember(viewerId);
      this.db.prepare('UPDATE global_members SET last_read_seq=max(last_read_seq, min(?, (SELECT coalesce(max(seq), 0) FROM global_messages))) WHERE user_id=?').run(seq, viewerId);
      return { unreadGlobal: countUnreadGlobal(this.db, viewerId) };
    })();
  }

  mute(viewerId: string, muted: boolean): { muted: boolean } {
    return this.db.transaction(() => {
      this.service.ready(viewerId);
      this.ensureMember(viewerId);
      this.db.prepare('UPDATE global_members SET muted=? WHERE user_id=?').run(Number(muted), viewerId);
      return { muted };
    })();
  }
}

/** Retention, same numbers as one-to-one chat (§3.5): messages go after 180 days, deleted text after 30. */
export function pruneGlobalChat(db: Db, now: Date = new Date()): void {
  const ago = (days: number) => new Date(now.getTime() - days * DAY).toISOString();
  db.transaction(() => {
    db.prepare('DELETE FROM global_messages WHERE created_at < ?').run(ago(CHAT.retentionDays));
    db.prepare("UPDATE global_messages SET body='' WHERE deleted_at IS NOT NULL AND deleted_at < ? AND body <> ''").run(ago(CHAT.deletedTextDays));
  })();
}
