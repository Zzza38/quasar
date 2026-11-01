import { chatImageSchema } from '@/domain/chat';
import { notifyChat } from './chat-events';
import { messageExtras, validateReply, targetExists, changeReaction, reactionSchema, replySchema, visibilityResetRevision } from './chat-extras';
import type { MessageExtras, Reaction } from '@/domain/chat';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { CHAT, bodyError, censorBody, normalizeBody, rawBodySchema } from '@/domain/chat';
import { SCHOOL_CHAT_BETA } from '@/domain/betas';
// A cycle with ./chat, safe because neither module uses the other's exports while it loads.
import { activePause, countUnreadChats, listPreview, type ChatPause, type Receipt } from './chat';
import { currentBetaRegistry } from './beta-registry';
import type { Db } from './db';
import { avatarUrl } from './avatars';
import type { Service } from './service';

/**
 * The global chat (docs/CHAT.md §11) and the school chats (§16). Both are rooms: one is open to every member with
 * names entered, the other to the members of one school. Unlike one-to-one chat they are public by design, so the
 * owner moderates them directly: the owner can edit or delete any message, and slurs are censored to asterisks
 * before a message is stored. One engine (RoomChatService) runs both, over tables of the same shape.
 *
 * Every error message is a fixed string: nothing here ever echoes message text.
 */

type FailCode = 'FORBIDDEN' | 'NOT_FOUND' | 'BAD_REQUEST' | 'TOO_MANY_REQUESTS';
const fail: (code: FailCode, message: string) => never = (code, message) => { throw new TRPCError({ code, message }); };
const DAY = 86_400_000;

export const PAUSED = 'Support paused your messaging.';
const MISSING = 'That message is gone.';
export const NOT_IN_SCHOOL = 'You are not in this school chat.';

export type GlobalDeletedBy = 'sender' | 'owner' | null;
export type GlobalSender = { id: string; displayName: string; verified: boolean; avatar: string | null };
export type GlobalMessage = MessageExtras & { id: string; seq: number; revision: number; fromMe: boolean; body: string | null; createdAt: string;
  deletedBy: GlobalDeletedBy; editedAt: string | null;
  /** The owner's reason for editing or removing this message (may be empty); null when the owner didn't touch it. */
  reason: string | null; sender: GlobalSender };
export type GlobalRoom = { members: number; canModerate: boolean };
export type GlobalSummary = {
  lastMessage: { senderName: string; fromMe: boolean; preview: string | null; createdAt: string; deletedBy: GlobalDeletedBy } | null;
  unread: number; muted: boolean;
};
/** A school room's list row: the global row's fields plus which school it belongs to. */
export type SchoolSummary = GlobalSummary & { schoolId: string; schoolName: string };

type MessageRow = { image: string | null; reply_to_seq: number | null; seq: number; id: string; sender_id: string; body: string; created_at: string; edited_at: string | null;
  deleted_at: string | null; deleted_by: GlobalDeletedBy; reason: string | null; revision: number; display_name: string; verified: number;
  google_picture: string | null; avatar_version: number | null; avatar_hidden: number | null };
type MemberRow = { last_read_seq: number; muted: number };

export const globalThreadSchema = z.object({
  after: z.number().int().min(0).optional(),
  before: z.number().int().positive().optional(),
}).refine(input => input.after === undefined || input.before === undefined, 'Use either after or before, not both.');
export const globalSendSchema = z.object({ clientId: z.uuid(), body: rawBodySchema, image: chatImageSchema, replyTo: replySchema });
export const globalMessageSchema = z.object({ messageId: z.uuid() });
/** The owner's reason, shown to everyone. Ignored when a sender deletes their own message. */
export const reasonSchema = z.string().trim().max(200).default('');
export const globalReactSchema = reactionSchema;
export const globalDeleteSchema = globalMessageSchema.extend({ reason: reasonSchema });
export const globalEditSchema = globalMessageSchema.extend({ body: rawBodySchema, reason: reasonSchema });
export const globalReadSchema = z.object({ seq: z.number().int().min(0) });
export const globalMuteSchema = z.object({ muted: z.boolean() });

/** The school room procedures take the same inputs plus the school, so a client that switched schools is refused, not served another room. */
const schoolScope = z.object({ schoolId: z.string().min(1).max(100) });
export const schoolThreadSchema = z.object({ schoolId: z.string().min(1).max(100), after: z.number().int().min(0).optional(), before: z.number().int().positive().optional() })
  .refine(input => input.after === undefined || input.before === undefined, 'Use either after or before, not both.');
export const schoolSendSchema = globalSendSchema.extend(schoolScope.shape);
export const schoolReactSchema = globalReactSchema.extend(schoolScope.shape);
export const schoolDeleteSchema = globalDeleteSchema.extend(schoolScope.shape);
export const schoolEditSchema = globalEditSchema.extend(schoolScope.shape);
export const schoolReadSchema = globalReadSchema.extend(schoolScope.shape);
export const schoolMuteSchema = globalMuteSchema.extend(schoolScope.shape);

/** normalizeBody, slurs censored to asterisks outside https links (censorBody), then bodyError, throwing BAD_REQUEST with a fixed string. Never echoes input. */
export function parseGlobalBody(raw: string, hasImage = false): string {
  const body = censorBody(normalizeBody(typeof raw === 'string' ? raw : ''));
  const problem = bodyError(body, hasImage);
  if (problem) fail('BAD_REQUEST', problem);
  return body;
}

/* ---------- Rooms ---------- */

export type RoomKind = 'global' | 'school';
/** One room: the global room (scope 'global') or one school's room (scope is the school id). */
export type Room = { kind: RoomKind; scope: string };
export const GLOBAL_ROOM: Room = { kind: 'global', scope: 'global' };

/**
 * Each kind's tables and the SQL that narrows them to one room. Queries bind `@scope` (the room) and `@user`
 * (the member); the global room ignores `@scope`.
 */
const ROOMS = {
  global: {
    messages: 'global_messages', members: 'global_members',
    inRoom: (alias: string) => `${alias}.seq=${alias}.seq`,
    member: (alias: string, user: string) => `${alias}.user_id=${user}`,
    revision: 'SELECT revision FROM global_chat WHERE id=1',
    bump: 'UPDATE global_chat SET revision=revision+1 WHERE id=1 RETURNING revision',
    touch: 'UPDATE global_chat SET last_message_at=@at WHERE id=1',
    population: "SELECT count(*) n FROM users WHERE display_name<>'' AND full_name<>''",
  },
  school: {
    messages: 'school_messages', members: 'school_members',
    inRoom: (alias: string) => `${alias}.school_id=@scope`,
    member: (alias: string, user: string) => `${alias}.school_id=@scope AND ${alias}.user_id=${user}`,
    revision: 'SELECT coalesce((SELECT revision FROM school_chats WHERE id=@scope), 0) revision',
    bump: 'UPDATE school_chats SET revision=revision+1 WHERE id=@scope RETURNING revision',
    touch: 'UPDATE school_chats SET last_message_at=@at WHERE id=@scope',
    population: "SELECT count(*) n FROM users WHERE school_id=@scope AND display_name<>'' AND full_name<>''",
  },
} as const;

const messageSql = (kind: RoomKind) => `SELECT c.*, u.display_name, u.google_picture, u.avatar_version, u.avatar_hidden,
  EXISTS (SELECT 1 FROM school_verifications v WHERE v.user_id=u.id AND v.school_id=u.school_id) AS verified
  FROM ${ROOMS[kind].messages} c JOIN users u ON u.id=c.sender_id`;

/**
 * SQL that keeps a message only when the viewer has not blocked its sender (docs/CHAT.md §11). One way on purpose:
 * the blocker stops seeing the blocked member's room messages, in the thread, the list preview, the unread count
 * and pushes, while the blocked member's view of the room does not change, so it cannot be compared to find a block.
 */
export const NOT_BLOCKED_SENDER_SQL = (viewer: string) => `NOT EXISTS (SELECT 1 FROM blocks b WHERE b.blocker_id=${viewer} AND b.blocked_id=c.sender_id)`;

/**
 * SQL for a member's read marker in a room. Someone without a members row starts at the room's newest message that
 * existed when their account was created, so a newcomer never sees the whole backlog as unread. (Joining a school
 * also seeds its room's row, see seedSchoolMember, which covers members who switch schools later.)
 */
export const roomReadSeqSql = (kind: RoomKind, user: string) => {
  const { messages, members, inRoom, member } = ROOMS[kind];
  return `coalesce((SELECT m.last_read_seq FROM ${members} m WHERE ${member('m', user)}),
  (SELECT coalesce(max(g.seq), 0) FROM ${messages} g WHERE ${inRoom('g')} AND g.created_at < (SELECT u.created_at FROM users u WHERE u.id=${user})))`;
};
export const GLOBAL_READ_SEQ_SQL = (user: string) => roomReadSeqSql('global', user);
const mutedSql = (kind: RoomKind, user: string) => `coalesce((SELECT m.muted FROM ${ROOMS[kind].members} m WHERE ${ROOMS[kind].member('m', user)}), 0)`;

/** Unread, undeleted messages from others (not ones the member blocked) past the member's read marker; 0 when muted. */
function countUnreadRoom(db: Db, room: Room, userId: string): number {
  const row = db.prepare(`SELECT count(*) n FROM ${ROOMS[room.kind].messages} c
    WHERE ${ROOMS[room.kind].inRoom('c')} AND c.sender_id<>@user AND c.deleted_at IS NULL AND ${NOT_BLOCKED_SENDER_SQL('@user')}
    AND c.seq > ${roomReadSeqSql(room.kind, '@user')}
    AND NOT ${mutedSql(room.kind, '@user')}`).get({ user: userId, scope: room.scope }) as { n: number };
  return row.n;
}
export function countUnreadGlobal(db: Db, userId: string): number {
  return countUnreadRoom(db, GLOBAL_ROOM, userId);
}

/**
 * The school chat beta (docs/CHAT.md §16). Until it ends, a member's school room, its row in the list, its unread
 * count, its pushes and its live events exist only for members of the beta, the same test useBeta makes on the client.
 */
export function schoolChatOn(db: Db, userId: string): boolean {
  if (!db.prepare('SELECT 1 FROM beta_members WHERE beta_key=? AND user_id=?').get(SCHOOL_CHAT_BETA, userId)) return false;
  return currentBetaRegistry().betas.some(beta => beta.key === SCHOOL_CHAT_BETA);
}

/** The member's school room, or null when they have no school (or are outside the beta). */
export function schoolRoomOf(db: Db, userId: string): Room | null {
  const row = db.prepare('SELECT school_id FROM users WHERE id=?').get(userId) as { school_id: string | null } | undefined;
  if (!row?.school_id || !schoolChatOn(db, userId)) return null;
  return { kind: 'school', scope: row.school_id };
}

/** Unread messages in the member's own school room; 0 without a school, outside the beta, or when muted. */
export function countUnreadSchool(db: Db, userId: string): number {
  const room = schoolRoomOf(db, userId);
  return room ? countUnreadRoom(db, room, userId) : 0;
}

/**
 * Messages a member sent after `since` (ISO), one-to-one, in groups and in the rooms together: the per-minute and
 * per-day limits (docs/CHAT.md §3.3, §11, §12) are one budget per sender across every chat, not one per surface.
 */
export function countSentSince(db: Db, userId: string, since: string): number {
  const row = db.prepare(`SELECT (SELECT count(*) FROM chat_messages WHERE sender_id=@user AND created_at>@since)
    + (SELECT count(*) FROM global_messages WHERE sender_id=@user AND created_at>@since)
    + (SELECT count(*) FROM school_messages WHERE sender_id=@user AND created_at>@since)
    + (SELECT count(*) FROM chat_group_messages WHERE sender_id=@user AND created_at>@since) n`).get({ user: userId, since }) as { n: number };
  return row.n;
}

/** Creates a member's row seeded with their current read marker, so it never resets to 0 (the whole backlog). */
export function ensureRoomMember(db: Db, room: Room, userId: string): void {
  if (room.kind === 'school') db.prepare('INSERT OR IGNORE INTO school_chats(id) VALUES(?)').run(room.scope);
  const columns = room.kind === 'school' ? 'school_id, user_id, last_read_seq' : 'user_id, last_read_seq';
  const values = room.kind === 'school' ? '@scope, @user' : '@user';
  db.prepare(`INSERT OR IGNORE INTO ${ROOMS[room.kind].members}(${columns}) VALUES(${values}, ${roomReadSeqSql(room.kind, '@user')})`).run({ user: userId, scope: room.scope });
}
export function ensureGlobalMember(db: Db, userId: string): void {
  ensureRoomMember(db, GLOBAL_ROOM, userId);
}

/**
 * Joining a school marks its room read up to now, so a member who switches schools doesn't arrive to the new room's
 * whole backlog as unread. Rejoining keeps the row's mute and only moves the marker forward. Called inside the join transaction.
 */
export function seedSchoolMember(db: Db, userId: string, schoolId: string): void {
  const room: Room = { kind: 'school', scope: schoolId };
  ensureRoomMember(db, room, userId);
  db.prepare('UPDATE school_members SET last_read_seq=max(last_read_seq, (SELECT coalesce(max(seq), 0) FROM school_messages WHERE school_id=@scope)) WHERE school_id=@scope AND user_id=@user')
    .run({ scope: schoolId, user: userId });
}

/**
 * One room's procedures. The caller settles who may use the room (the global room is open to everyone with names;
 * a school room only to that school's members) and hands over the Room; everything else is shared.
 */
class RoomChatService {
  constructor(protected readonly service: Service, protected readonly now: () => Date = () => new Date()) {}
  protected get db() { return this.service.db; }
  protected iso(offsetMs = 0): string { return new Date(this.now().getTime() + offsetMs).toISOString(); }

  /* ---------- Helpers ---------- */

  private params(room: Room, extra: Record<string, unknown> = {}) { return { scope: room.scope, ...extra }; }
  private notPaused(viewerId: string): void {
    if (this.db.prepare('SELECT 1 FROM chat_pauses WHERE user_id=? AND (until IS NULL OR until>?)').get(viewerId, this.iso())) fail('FORBIDDEN', PAUSED);
  }
  private pause(userId: string): ChatPause | null {
    return activePause(this.db, userId, this.iso());
  }
  private member(room: Room, userId: string): MemberRow {
    return this.db.prepare(`SELECT ${roomReadSeqSql(room.kind, '@user')} AS last_read_seq, ${mutedSql(room.kind, '@user')} AS muted`).get(this.params(room, { user: userId })) as MemberRow;
  }
  private revision(room: Room): number {
    return (this.db.prepare(ROOMS[room.kind].revision).get(this.params(room)) as { revision: number }).revision;
  }
  private bumpRevision(room: Room): number {
    if (room.kind === 'school') this.db.prepare('INSERT OR IGNORE INTO school_chats(id) VALUES(?)').run(room.scope);
    return (this.db.prepare(ROOMS[room.kind].bump).get(this.params(room)) as { revision: number }).revision;
  }
  private roomInfo(room: Room, viewerId: string): GlobalRoom {
    const members = this.db.prepare(ROOMS[room.kind].population).get(this.params(room)) as { n: number };
    return { members: members.n, canModerate: this.service.isAdmin(viewerId) };
  }
  private message(room: Room, viewerId: string, row: MessageRow): GlobalMessage {
    return {
      ...messageExtras(this.db, room.kind, viewerId, row.seq),
      id: row.id, seq: row.seq, revision: row.revision, fromMe: row.sender_id === viewerId, body: row.deleted_at ? null : row.body, createdAt: row.created_at,
      deletedBy: row.deleted_at ? row.deleted_by : null, editedAt: row.deleted_at ? null : row.edited_at,
      reason: (row.deleted_at ? row.deleted_by === 'owner' : !!row.edited_at) ? row.reason ?? '' : null,
      sender: { id: row.sender_id, displayName: row.display_name, verified: !!row.verified, avatar: avatarUrl({ id: row.sender_id, google_picture: row.google_picture, avatar_version: row.avatar_version, avatar_hidden: row.avatar_hidden }) },
    };
  }
  /** Room messages the viewer can see (messages from members they blocked are left out), plus `extra` SQL. */
  private visible(room: Room, extra: string): string {
    return `${messageSql(room.kind)} WHERE ${ROOMS[room.kind].inRoom('c')} AND ${NOT_BLOCKED_SENDER_SQL('@viewer')} ${extra}`;
  }
  /** The newest page the viewer can see. */
  private latestPage(room: Room, viewerId: string, before?: number): { rows: MessageRow[]; hasEarlier: boolean } {
    const rows = this.db.prepare(this.visible(room, `${before === undefined ? '' : 'AND c.seq<@before'} ORDER BY c.seq DESC LIMIT @limit`))
      .all(this.params(room, { viewer: viewerId, before: before ?? null, limit: CHAT.page + 1 })) as MessageRow[];
    return { rows: rows.slice(0, CHAT.page).reverse(), hasEarlier: rows.length > CHAT.page };
  }
  private find(room: Room, messageId: string): MessageRow | undefined {
    return this.db.prepare(`${messageSql(room.kind)} WHERE ${ROOMS[room.kind].inRoom('c')} AND c.id=@id`).get(this.params(room, { id: messageId })) as MessageRow | undefined;
  }
  private bySeq(room: Room, seq: number): MessageRow {
    return this.db.prepare(`${messageSql(room.kind)} WHERE c.seq=?`).get(seq) as MessageRow;
  }
  private unreadChats(viewerId: string): { unreadChats: number; unreadAt: string } {
    return { unreadChats: countUnreadChats(this.db, viewerId), unreadAt: new Date().toISOString() };
  }
  private audit(room: Room, actorId: string, action: string, detail: Record<string, unknown>): void {
    this.service.audit(actorId, `${room.kind === 'school' ? 'schoolChat' : 'global'}.${action}`, null, room.kind === 'school' ? { ...detail, schoolId: room.scope } : detail, this.iso());
  }
  /** Live events: the global room reaches everyone connected; a school room only its members. */
  private notify(room: Room): void {
    if (room.kind === 'global') { notifyChat([], { kind: 'global', key: 'global' }); return; }
    const members = this.db.prepare('SELECT id FROM users WHERE school_id=?').pluck().all(room.scope) as string[];
    notifyChat(members.filter(id => schoolChatOn(this.db, id)), { kind: 'school', key: room.scope });
  }

  /* ---------- Member procedures ---------- */

  /** The chat-list row: the newest message, the viewer's unread count and mute. */
  protected roomSummary(room: Room, viewerId: string): GlobalSummary {
    const member = this.member(room, viewerId);
    const last = this.db.prepare(this.visible(room, 'ORDER BY c.seq DESC LIMIT 1')).get(this.params(room, { viewer: viewerId })) as MessageRow | undefined;
    const deleted = !!last?.deleted_at;
    return {
      lastMessage: last ? { senderName: last.display_name, fromMe: last.sender_id === viewerId, preview: deleted ? null : listPreview(last.body) || (last.image ? 'Photo' : ''), createdAt: last.created_at, deletedBy: deleted ? last.deleted_by : null } : null,
      unread: countUnreadRoom(this.db, room, viewerId),
      muted: !!member.muted,
    };
  }

  protected roomThread(room: Room, viewerId: string, cursor: { after?: number; before?: number } = {}) {
    if (cursor.after !== undefined && cursor.before !== undefined) fail('BAD_REQUEST', 'Use either after or before, not both.');
    const member = this.member(room, viewerId);
    const revision = this.revision(room);
    // Rooms have no read receipts or typing signals (§13): with hundreds of members they would mean nothing.
    const base = { peer: null, room: this.roomInfo(room, viewerId), revision, lastReadSeq: member.last_read_seq, muted: !!member.muted, pause: this.pause(viewerId), receipts: [] as Receipt[] };
    const toMessages = (rows: MessageRow[]) => rows.map(row => this.message(room, viewerId, row));
    if (cursor.after !== undefined) {
      const changes = cursor.after > revision || cursor.after < visibilityResetRevision(this.db, room.kind, viewerId, room.scope) ? null
        : this.db.prepare(this.visible(room, 'AND c.revision>@after ORDER BY c.seq LIMIT @limit')).all(this.params(room, { viewer: viewerId, after: cursor.after, limit: CHAT.maxChanges + 1 })) as MessageRow[];
      if (changes && changes.length <= CHAT.maxChanges) return { ...base, messages: toMessages(changes), hasEarlier: false, reset: false };
      const page = this.latestPage(room, viewerId);
      return { ...base, messages: toMessages(page.rows), hasEarlier: page.hasEarlier, reset: true };
    }
    const page = this.latestPage(room, viewerId, cursor.before);
    return { ...base, messages: toMessages(page.rows), hasEarlier: page.hasEarlier, reset: false };
  }

  /** `admit` runs first inside the transaction and settles who may post. */
  protected roomSend(room: Room, admit: () => void, viewerId: string, clientId: string, raw: string, replyTo?: number, image?: string): { message: GlobalMessage } {
    const body = parseGlobalBody(raw, !!image);
    const { messages } = ROOMS[room.kind];
    const result = this.db.transaction(() => {
      admit();
      const existing = this.db.prepare(`${messageSql(room.kind)} WHERE c.sender_id=? AND c.id=?`).get(viewerId, clientId) as (MessageRow & { school_id?: string }) | undefined;
      if (existing) {
        if ((existing.body !== body && !existing.edited_at) || (existing.image ?? undefined) !== image || (existing.reply_to_seq ?? null) !== (replyTo ?? null)
          || (room.kind === 'school' && existing.school_id !== room.scope)) fail('BAD_REQUEST', 'A retry ID cannot be reused for a different message.');
        return { message: this.message(room, viewerId, existing) };
      }
      // IDs are unique across the room's table (owner Remove and Edit address messages by ID), so another member's ID is refused.
      if (this.db.prepare(`SELECT 1 FROM ${messages} WHERE id=?`).get(clientId)) fail('BAD_REQUEST', 'A retry ID cannot be reused for a different message.');
      this.notPaused(viewerId);
      const sent = (since: number) => countSentSince(this.db, viewerId, this.iso(-since));
      if (sent(60_000) >= CHAT.perMinute) fail('TOO_MANY_REQUESTS', 'You’re sending messages too fast. Wait a minute and try again.');
      if (sent(DAY) >= CHAT.perDay) fail('TOO_MANY_REQUESTS', 'You reached today’s message limit. Try again tomorrow.');
      validateReply(this.db, room.kind, viewerId, replyTo, room.kind === 'school' ? room.scope : undefined);
      const revision = this.bumpRevision(room);
      const createdAt = this.iso();
      const { seq } = (room.kind === 'school'
        ? this.db.prepare('INSERT INTO school_messages(id,school_id,sender_id,body,created_at,revision,reply_to_seq,image) VALUES(?,?,?,?,?,?,?,?) RETURNING seq').get(clientId, room.scope, viewerId, body, createdAt, revision, replyTo ?? null, image ?? null)
        : this.db.prepare('INSERT INTO global_messages(id,sender_id,body,created_at,revision,reply_to_seq,image) VALUES(?,?,?,?,?,?,?) RETURNING seq').get(clientId, viewerId, body, createdAt, revision, replyTo ?? null, image ?? null)) as { seq: number };
      this.db.prepare(ROOMS[room.kind].touch).run(this.params(room, { at: createdAt }));
      ensureRoomMember(this.db, room, viewerId);
      this.db.prepare(`UPDATE ${ROOMS[room.kind].members} AS m SET last_read_seq=max(last_read_seq, @seq) WHERE ${ROOMS[room.kind].member('m', '@user')}`).run(this.params(room, { seq, user: viewerId }));
      return { message: this.message(room, viewerId, this.bySeq(room, seq)) };
    }).immediate();
    this.notify(room);
    return result;
  }

  protected roomReact(room: Room, admit: () => void, viewerId: string, seq: number, emoji: Reaction | null): { message: GlobalMessage } {
    const result = this.db.transaction(() => {
      admit();
      this.notPaused(viewerId);
      const row = this.db.prepare(`SELECT c.deleted_at FROM ${ROOMS[room.kind].messages} c WHERE c.seq=@seq AND ${ROOMS[room.kind].inRoom('c')}`).get(this.params(room, { seq })) as { deleted_at: string | null } | undefined;
      if (!row || row.deleted_at || !targetExists(this.db, room.kind, viewerId, seq, room.kind === 'school' ? room.scope : undefined)) return fail('NOT_FOUND', MISSING);
      changeReaction(this.db, room.kind, viewerId, seq, emoji, this.iso());
      this.db.prepare(`UPDATE ${ROOMS[room.kind].messages} SET revision=? WHERE seq=?`).run(this.bumpRevision(room), seq);
      return { message: this.message(room, viewerId, this.bySeq(room, seq)) };
    }).immediate();
    this.notify(room);
    return result;
  }

  /** The sender deletes their own message; the owner deletes anyone's, with a reason everyone can see (audited). */
  protected roomDelete(room: Room, admit: () => void, viewerId: string, messageId: string, rawReason = ''): { deleted: true; message: GlobalMessage } {
    const reason = reasonSchema.parse(rawReason);
    const result = this.db.transaction(() => {
      admit();
      const row = this.find(room, messageId);
      if (!row) return fail('NOT_FOUND', MISSING);
      const owner = this.service.isAdmin(viewerId);
      if (row.sender_id !== viewerId && !owner) fail('FORBIDDEN', 'Only the owner can delete other people’s messages.');
      if (row.deleted_at) return { deleted: true as const, message: this.message(room, viewerId, row) };
      const by = row.sender_id === viewerId ? 'sender' : 'owner';
      this.db.prepare(`UPDATE ${ROOMS[room.kind].messages} SET deleted_at=?, deleted_by=?, reason=?, revision=? WHERE seq=?`).run(this.iso(), by, by === 'owner' ? reason : null, this.bumpRevision(room), row.seq);
      if (by === 'owner') this.audit(room, viewerId, 'delete', { seq: row.seq, senderId: row.sender_id, reason });
      return { deleted: true as const, message: this.message(room, viewerId, this.find(room, messageId)!) };
    }).immediate();
    this.notify(room);
    return result;
  }

  /** Owner only: replaces the text of any message, with a reason everyone can see. The filter applies to the new text; the edit is audited. */
  protected roomEdit(room: Room, admit: () => void, adminId: string, messageId: string, raw: string, rawReason = ''): { message: GlobalMessage } {
    this.service.admin(adminId);
    const reason = reasonSchema.parse(rawReason);
    const result = this.db.transaction(() => {
      admit();
      const row = this.find(room, messageId);
      if (!row || row.deleted_at) return fail('NOT_FOUND', MISSING);
      const body = parseGlobalBody(raw, !!row.image);
      if (row.body !== body || (row.reason ?? '') !== reason) {
        this.db.prepare(`UPDATE ${ROOMS[room.kind].messages} SET body=?, edited_at=?, reason=?, revision=? WHERE seq=?`).run(body, this.iso(), reason, this.bumpRevision(room), row.seq);
        this.audit(room, adminId, 'edit', { seq: row.seq, senderId: row.sender_id, reason });
      }
      return { message: this.message(room, adminId, this.find(room, messageId)!) };
    }).immediate();
    this.notify(room);
    return result;
  }

  /** Also returns the Messages badge count (each room counts as one chat), stamped like chat.read's, so the badge updates at once. */
  protected roomRead(room: Room, admit: () => void, viewerId: string, seq: number): { unread: number; unreadChats: number; unreadAt: string } {
    return this.db.transaction(() => {
      admit();
      ensureRoomMember(this.db, room, viewerId);
      const { messages, members, inRoom, member } = ROOMS[room.kind];
      this.db.prepare(`UPDATE ${members} AS m SET last_read_seq=max(last_read_seq, min(@seq, (SELECT coalesce(max(c.seq), 0) FROM ${messages} c WHERE ${inRoom('c')}))) WHERE ${member('m', '@user')}`)
        .run(this.params(room, { seq, user: viewerId }));
      return { unread: countUnreadRoom(this.db, room, viewerId), ...this.unreadChats(viewerId) };
    }).immediate();
  }

  /** Returns the new badge count too: a muted room is left out of it. */
  protected roomMute(room: Room, admit: () => void, viewerId: string, muted: boolean): { muted: boolean; unreadChats: number; unreadAt: string } {
    return this.db.transaction(() => {
      admit();
      ensureRoomMember(this.db, room, viewerId);
      this.db.prepare(`UPDATE ${ROOMS[room.kind].members} AS m SET muted=@muted WHERE ${ROOMS[room.kind].member('m', '@user')}`).run(this.params(room, { muted: Number(muted), user: viewerId }));
      return { muted, ...this.unreadChats(viewerId) };
    }).immediate();
  }
}

/** The global room (§11): every member with names entered. */
export class GlobalChatService extends RoomChatService {
  private admit(viewerId: string) { return () => { this.service.ready(viewerId); }; }

  summary(viewerId: string): GlobalSummary {
    this.service.ready(viewerId);
    return this.roomSummary(GLOBAL_ROOM, viewerId);
  }
  thread(viewerId: string, cursor: { after?: number; before?: number } = {}) {
    if (cursor.after !== undefined && cursor.before !== undefined) fail('BAD_REQUEST', 'Use either after or before, not both.');
    return this.db.transaction(() => {
      this.service.ready(viewerId);
      return this.roomThread(GLOBAL_ROOM, viewerId, cursor);
    })();
  }
  send(viewerId: string, clientId: string, raw: string, replyTo?: number, image?: string): { message: GlobalMessage } {
    return this.roomSend(GLOBAL_ROOM, this.admit(viewerId), viewerId, clientId, raw, replyTo, image);
  }
  react(viewerId: string, seq: number, emoji: Reaction | null): { message: GlobalMessage } {
    return this.roomReact(GLOBAL_ROOM, this.admit(viewerId), viewerId, seq, emoji);
  }
  delete(viewerId: string, messageId: string, rawReason = ''): { deleted: true; message: GlobalMessage } {
    return this.roomDelete(GLOBAL_ROOM, this.admit(viewerId), viewerId, messageId, rawReason);
  }
  edit(adminId: string, messageId: string, raw: string, rawReason = ''): { message: GlobalMessage } {
    return this.roomEdit(GLOBAL_ROOM, () => {}, adminId, messageId, raw, rawReason);
  }
  read(viewerId: string, seq: number): { unreadGlobal: number; unreadChats: number; unreadAt: string } {
    const { unread, ...rest } = this.roomRead(GLOBAL_ROOM, this.admit(viewerId), viewerId, seq);
    return { unreadGlobal: unread, ...rest };
  }
  mute(viewerId: string, muted: boolean): { muted: boolean; unreadChats: number; unreadAt: string } {
    return this.roomMute(GLOBAL_ROOM, this.admit(viewerId), viewerId, muted);
  }
}

/**
 * A school's room (§16): the members whose current school it is. Every procedure names the school, and a member
 * of another school (or of none) gets NOT_FOUND, the same answer whether the school exists or not.
 */
export class SchoolChatService extends RoomChatService {
  /** The viewer's school room, after checking they have names, belong to `schoolId` and are in the beta. */
  private access(viewerId: string, schoolId: string): Room {
    const user = this.service.ready(viewerId);
    if (!user.schoolId || user.schoolId !== schoolId || !schoolChatOn(this.db, viewerId)) fail('NOT_FOUND', NOT_IN_SCHOOL);
    return { kind: 'school', scope: schoolId };
  }
  private room(schoolId: string): Room { return { kind: 'school', scope: schoolId }; }

  /** The list row for the viewer's own school, or null without a school (or outside the beta). */
  summary(viewerId: string): SchoolSummary | null {
    this.service.ready(viewerId);
    const room = schoolRoomOf(this.db, viewerId);
    if (!room) return null;
    const school = this.db.prepare('SELECT name FROM schools WHERE id=?').get(room.scope) as { name: string } | undefined;
    if (!school) return null;
    return { ...this.roomSummary(room, viewerId), schoolId: room.scope, schoolName: school.name };
  }
  thread(viewerId: string, schoolId: string, cursor: { after?: number; before?: number } = {}) {
    if (cursor.after !== undefined && cursor.before !== undefined) fail('BAD_REQUEST', 'Use either after or before, not both.');
    return this.db.transaction(() => {
      const room = this.access(viewerId, schoolId);
      const school = this.db.prepare('SELECT name FROM schools WHERE id=?').get(schoolId) as { name: string };
      return { ...this.roomThread(room, viewerId, cursor), school: { id: schoolId, name: school.name } };
    })();
  }
  send(viewerId: string, schoolId: string, clientId: string, raw: string, replyTo?: number, image?: string): { message: GlobalMessage } {
    return this.roomSend(this.room(schoolId), () => { this.access(viewerId, schoolId); }, viewerId, clientId, raw, replyTo, image);
  }
  react(viewerId: string, schoolId: string, seq: number, emoji: Reaction | null): { message: GlobalMessage } {
    return this.roomReact(this.room(schoolId), () => { this.access(viewerId, schoolId); }, viewerId, seq, emoji);
  }
  delete(viewerId: string, schoolId: string, messageId: string, rawReason = ''): { deleted: true; message: GlobalMessage } {
    return this.roomDelete(this.room(schoolId), () => { this.access(viewerId, schoolId); }, viewerId, messageId, rawReason);
  }
  /** The owner edits from inside the room, so it is the owner's own school; the admin check runs first. */
  edit(adminId: string, schoolId: string, messageId: string, raw: string, rawReason = ''): { message: GlobalMessage } {
    return this.roomEdit(this.room(schoolId), () => { this.access(adminId, schoolId); }, adminId, messageId, raw, rawReason);
  }
  read(viewerId: string, schoolId: string, seq: number): { unreadSchool: number; unreadChats: number; unreadAt: string } {
    const { unread, ...rest } = this.roomRead(this.room(schoolId), () => { this.access(viewerId, schoolId); }, viewerId, seq);
    return { unreadSchool: unread, ...rest };
  }
  mute(viewerId: string, schoolId: string, muted: boolean): { muted: boolean; unreadChats: number; unreadAt: string } {
    return this.roomMute(this.room(schoolId), () => { this.access(viewerId, schoolId); }, viewerId, muted);
  }
}

/** Retention, same numbers as one-to-one chat (§3.5): messages go after 180 days, deleted text after 30. Both rooms. */
export function pruneGlobalChat(db: Db, now: Date = new Date()): void {
  const ago = (days: number) => new Date(now.getTime() - days * DAY).toISOString();
  db.transaction(() => {
    for (const table of ['global_messages', 'school_messages']) {
      db.prepare(`DELETE FROM ${table} WHERE created_at < ?`).run(ago(CHAT.retentionDays));
      db.prepare(`UPDATE ${table} SET body='', image=NULL WHERE deleted_at IS NOT NULL AND deleted_at < ? AND (body <> '' OR image IS NOT NULL)`).run(ago(CHAT.deletedTextDays));
    }
  }).immediate();
}
