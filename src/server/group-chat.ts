import { randomUUID } from 'node:crypto';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { CHAT, REPORT_CATEGORIES, bodyError, censorBody, normalizeBody, rawBodySchema, reportCategorySchema, type ReportCategory } from '@/domain/chat';
import { censorSlurs } from '@/domain/chat-filter';
// Cycles with ./chat and ./community, safe because no module uses another's exports while it loads.
import { activePause, countUnreadChats, listPreview, type ChatPause, type Receipt, type StoredItem } from './chat';
import { CommunityService } from './community';
import { countSentSince, NOT_BLOCKED_SENDER_SQL } from './global-chat';
import type { Db } from './db';
import { AVATAR_COLUMNS, avatarUrl, type AvatarRow } from './avatars';
import type { Service } from './service';

/**
 * Friend groups (docs/CHAT.md §12): a named group of up to CHAT.groupMaxMembers friends. The creator is its admin:
 * only they add people (their own accepted friends, with no block between the two of them), remove people and
 * rename it; anyone can leave. Members see the messages sent since they joined. A block made anywhere applies one
 * way, as in the global room: the blocker no longer sees the blocked member's group messages. Everything else
 * (limits, pauses, pushes, retention, reports with a frozen snapshot) follows the one-to-one rules.
 *
 * Every error message is a fixed string: nothing here ever echoes message text.
 */

type FailCode = 'FORBIDDEN' | 'NOT_FOUND' | 'BAD_REQUEST' | 'CONFLICT' | 'TOO_MANY_REQUESTS';
const fail: (code: FailCode, message: string) => never = (code, message) => { throw new TRPCError({ code, message }); };
const DAY = 86_400_000;

export const NOT_IN_GROUP = 'You are not in this group.';
export const PAUSED = 'Support paused your messaging.';
const ADMIN_ONLY = 'Only the group admin can do that.';
const NOT_A_FRIEND = 'You can only add your friends to a group.';
const MISSING = 'That message is gone.';
const NOTHING_TO_REPORT = 'This group has no messages to report.';
export const GROUP_FULL_MESSAGE: `A group can have up to ${number} people.` = `A group can have up to ${CHAT.groupMaxMembers} people.`;
export const TOO_MANY_GROUPS_MESSAGE: `You created ${number} groups today. Try again tomorrow.` = `You created ${CHAT.groupsPerDay} groups today. Try again tomorrow.`;

export type GroupRole = 'admin' | 'member';
export type GroupDeletedBy = 'sender' | 'admin' | 'support' | null;
export type GroupSender = { id: string; displayName: string; avatar: string | null; verified: boolean };
export type GroupMember = GroupSender & { role: GroupRole; joinedAt: string };
export type GroupInfo = { id: string; name: string; createdAt: string; role: GroupRole; members: GroupMember[] };
export type GroupMessage = { id: string; seq: number; fromMe: boolean; body: string | null; createdAt: string; deletedBy: GroupDeletedBy;
  /** Never edited: kept for the same shape as a global message, so one bubble component renders both. */
  editedAt: null; reason: null; sender: GroupSender };
export type GroupSummary = {
  id: string; name: string; memberCount: number; role: GroupRole;
  /** A few members for the stacked avatars in the list (the viewer excluded). */
  members: { id: string; displayName: string; avatar: string | null }[];
  lastMessage: { senderName: string; fromMe: boolean; preview: string | null; createdAt: string; deletedBy: GroupDeletedBy } | null;
  /** When the row was last active, for ordering: the newest message, else creation. */
  lastAt: string; unread: number; muted: boolean;
};

type GroupRow = { id: string; name: string; creator_id: string; revision: number; last_message_at: string | null; created_at: string };
type MemberRow = { group_id: string; user_id: string; role: GroupRole; joined_at: string; left_at: string | null; last_read_seq: number; delivered_seq: number; muted: number; typing_until: string | null };
type MessageRow = { seq: number; id: string; group_id: string; sender_id: string; body: string; created_at: string; deleted_at: string | null; deleted_by: GroupDeletedBy; revision: number;
  display_name: string; verified: number; google_picture: string | null; avatar_version: number | null; avatar_hidden: number | null };
type PersonRow = AvatarRow & { display_name: string; school_id: string | null; verified: number };

// Group names lose control and format characters and extra spaces, like display names, and a slur in one is censored.
const NAME_INVISIBLE = /[\p{Cc}\p{Cf}]/gu;
export const groupNameSchema = z.string().max(CHAT.groupNameMax * 4).transform(name => censorSlurs(name.replace(NAME_INVISIBLE, '').replace(/\s+/gu, ' ').trim())).pipe(z.string().min(1, 'Give the group a name.').max(CHAT.groupNameMax, `Group names can be up to ${CHAT.groupNameMax} characters.`));
export const groupIdSchema = z.object({ groupId: z.uuid() });
export const groupMembersSchema = groupIdSchema.extend({ memberIds: z.array(z.uuid()).min(1).max(CHAT.groupMaxMembers) });
export const groupCreateSchema = z.object({ name: groupNameSchema, memberIds: z.array(z.uuid()).min(1, 'Add at least one friend.').max(CHAT.groupMaxMembers) });
export const groupRenameSchema = groupIdSchema.extend({ name: groupNameSchema });
export const groupMemberSchema = groupIdSchema.extend({ userId: z.uuid() });
export const groupThreadSchema = groupIdSchema.extend({
  after: z.number().int().min(0).optional(),
  before: z.number().int().positive().optional(),
}).refine(input => input.after === undefined || input.before === undefined, 'Use either after or before, not both.');
export const groupSendSchema = groupIdSchema.extend({ clientId: z.uuid(), body: rawBodySchema });
export const groupDeleteSchema = groupIdSchema.extend({ messageId: z.uuid() });
export const groupReadSchema = groupIdSchema.extend({ seq: z.number().int().min(0) });
export const groupMuteSchema = groupIdSchema.extend({ muted: z.boolean() });
export const groupTypingSchema = groupIdSchema.extend({ typing: z.boolean() });
export const groupReportSchema = groupIdSchema.extend({
  category: reportCategorySchema,
  note: z.string().trim().max(2000).default(''),
  seq: z.number().int().positive(),
  block: z.boolean(),
});

const MESSAGE_SQL = `SELECT c.*, u.display_name, u.google_picture, u.avatar_version, u.avatar_hidden,
  EXISTS (SELECT 1 FROM school_verifications v WHERE v.user_id=u.id AND v.school_id=u.school_id) AS verified
  FROM chat_group_messages c JOIN users u ON u.id=c.sender_id`;

/** SQL for the messages a member `m` may see: sent since they joined, from senders they have not blocked. */
const VISIBLE_SQL = (member: string) => `c.created_at>=${member}.joined_at AND ${NOT_BLOCKED_SENDER_SQL(`${member}.user_id`)}`;

/**
 * The number of groups with an unread message for the badge (docs/CHAT.md §12): each unmuted group the member is in
 * with an undeleted message from someone else (not blocked, sent since they joined) past their read marker.
 */
export function countUnreadGroups(db: Db, userId: string): number {
  const row = db.prepare(`SELECT count(*) n FROM chat_group_members m WHERE m.user_id=? AND m.left_at IS NULL AND m.muted=0
    AND EXISTS (SELECT 1 FROM chat_group_messages c WHERE c.group_id=m.group_id AND c.seq>m.last_read_seq AND c.sender_id<>m.user_id AND c.deleted_at IS NULL AND ${VISIBLE_SQL('m')})`).get(userId) as { n: number };
  return row.n;
}

/** Ends every group membership of a student (support removal, docs/CHAT.md D4), handing over admin where needed. */
export function leaveAllGroups(db: Db, userId: string, nowIso: string): void {
  const rows = db.prepare('SELECT group_id FROM chat_group_members WHERE user_id=? AND left_at IS NULL').all(userId) as { group_id: string }[];
  for (const row of rows) leaveGroup(db, row.group_id, userId, nowIso);
}

/** Marks a member as left, promotes the longest-standing remaining member if the admin left, and deletes an empty group. */
function leaveGroup(db: Db, groupId: string, userId: string, nowIso: string): void {
  const member = db.prepare('SELECT role FROM chat_group_members WHERE group_id=? AND user_id=? AND left_at IS NULL').get(groupId, userId) as { role: GroupRole } | undefined;
  if (!member) return;
  db.prepare("UPDATE chat_group_members SET left_at=?, role='member', typing_until=NULL WHERE group_id=? AND user_id=?").run(nowIso, groupId, userId);
  const remaining = db.prepare('SELECT user_id FROM chat_group_members WHERE group_id=? AND left_at IS NULL ORDER BY joined_at, user_id').all(groupId) as { user_id: string }[];
  if (!remaining.length) { db.prepare('DELETE FROM chat_groups WHERE id=?').run(groupId); return; }
  if (member.role === 'admin' && !db.prepare("SELECT 1 FROM chat_group_members WHERE group_id=? AND left_at IS NULL AND role='admin'").get(groupId)) {
    db.prepare("UPDATE chat_group_members SET role='admin' WHERE group_id=? AND user_id=?").run(groupId, remaining[0]!.user_id);
  }
}

export class GroupChatService {
  constructor(private readonly service: Service, private readonly now: () => Date = () => new Date()) {}
  private get db() { return this.service.db; }
  private get community() { return new CommunityService(this.service); }
  private iso(offsetMs = 0): string { return new Date(this.now().getTime() + offsetMs).toISOString(); }

  /* ---------- Permission checks ---------- */

  /** The viewer's live membership. Throws NOT_FOUND "You are not in this group." for a stranger, someone who left or a missing group. */
  private member(viewerId: string, groupId: string): { group: GroupRow; member: MemberRow } {
    this.service.ready(viewerId);
    const group = this.db.prepare('SELECT * FROM chat_groups WHERE id=?').get(groupId) as GroupRow | undefined;
    const member = group && this.db.prepare('SELECT * FROM chat_group_members WHERE group_id=? AND user_id=? AND left_at IS NULL').get(groupId, viewerId) as MemberRow | undefined;
    if (!group || !member) return fail('NOT_FOUND', NOT_IN_GROUP);
    return { group, member };
  }
  private admin(viewerId: string, groupId: string): { group: GroupRow; member: MemberRow } {
    const found = this.member(viewerId, groupId);
    if (found.member.role !== 'admin') fail('FORBIDDEN', ADMIN_ONLY);
    return found;
  }
  private notPaused(viewerId: string): void {
    if (activePause(this.db, viewerId, this.iso())) fail('FORBIDDEN', PAUSED);
  }
  private pause(userId: string): ChatPause | null { return activePause(this.db, userId, this.iso()); }
  /** Each id must be an accepted friend of the adder with no block either way; otherwise BAD_REQUEST with one fixed wording. */
  private checkFriends(adderId: string, memberIds: string[]): void {
    const blocked = this.db.prepare('SELECT 1 FROM blocks WHERE (blocker_id=? AND blocked_id=?) OR (blocker_id=? AND blocked_id=?)');
    for (const id of memberIds) {
      if (id === adderId || !this.community.areFriends(adderId, id) || blocked.get(adderId, id, id, adderId)) fail('BAD_REQUEST', NOT_A_FRIEND);
      if (!this.db.prepare("SELECT 1 FROM users WHERE id=? AND display_name<>'' AND full_name<>''").get(id)) fail('BAD_REQUEST', NOT_A_FRIEND);
    }
  }

  /* ---------- Helpers ---------- */

  private bumpRevision(groupId: string): number {
    return (this.db.prepare('UPDATE chat_groups SET revision=revision+1 WHERE id=? RETURNING revision').get(groupId) as { revision: number }).revision;
  }
  private person(row: PersonRow): GroupSender {
    return { id: row.id, displayName: row.display_name, avatar: avatarUrl(row), verified: !!row.verified };
  }
  private members(groupId: string): (GroupMember & { row: MemberRow })[] {
    const rows = this.db.prepare(`SELECT m.*, u.display_name, u.school_id, ${AVATAR_COLUMNS.split(', ').map(column => `u.${column}`).join(', ')}, u.id,
        EXISTS (SELECT 1 FROM school_verifications v WHERE v.user_id=u.id AND v.school_id=u.school_id) AS verified
      FROM chat_group_members m JOIN users u ON u.id=m.user_id WHERE m.group_id=? AND m.left_at IS NULL ORDER BY m.role, m.joined_at, u.display_name COLLATE NOCASE`).all(groupId) as (MemberRow & PersonRow)[];
    return rows.map(row => ({ ...this.person(row), role: row.role, joinedAt: row.joined_at, row }));
  }
  private info(group: GroupRow, viewerId: string): GroupInfo {
    const members = this.members(group.id);
    return { id: group.id, name: group.name, createdAt: group.created_at, role: members.find(member => member.id === viewerId)?.role ?? 'member', members: members.map(({ row: _row, ...member }) => member) };
  }
  private message(viewerId: string, row: MessageRow): GroupMessage {
    return {
      id: row.id, seq: row.seq, fromMe: row.sender_id === viewerId, body: row.deleted_at ? null : row.body, createdAt: row.created_at,
      deletedBy: row.deleted_at ? row.deleted_by : null, editedAt: null, reason: null,
      sender: { id: row.sender_id, displayName: row.display_name, verified: !!row.verified, avatar: avatarUrl({ id: row.sender_id, google_picture: row.google_picture, avatar_version: row.avatar_version, avatar_hidden: row.avatar_hidden }) },
    };
  }
  private latestPage(member: MemberRow, before?: number): { rows: MessageRow[]; hasEarlier: boolean } {
    const rows = (before === undefined
      ? this.db.prepare(`${MESSAGE_SQL} JOIN chat_group_members m ON m.group_id=c.group_id AND m.user_id=? WHERE c.group_id=? AND ${VISIBLE_SQL('m')} ORDER BY c.seq DESC LIMIT ?`).all(member.user_id, member.group_id, CHAT.page + 1)
      : this.db.prepare(`${MESSAGE_SQL} JOIN chat_group_members m ON m.group_id=c.group_id AND m.user_id=? WHERE c.group_id=? AND ${VISIBLE_SQL('m')} AND c.seq<? ORDER BY c.seq DESC LIMIT ?`).all(member.user_id, member.group_id, before, CHAT.page + 1)) as MessageRow[];
    return { rows: rows.slice(0, CHAT.page).reverse(), hasEarlier: rows.length > CHAT.page };
  }
  private find(groupId: string, messageId: string): MessageRow | undefined {
    return this.db.prepare(`${MESSAGE_SQL} WHERE c.group_id=? AND c.id=?`).get(groupId, messageId) as MessageRow | undefined;
  }
  /** The badge count (the chat module's counter already adds groups through countUnreadGroups). */
  private unreadChats(viewerId: string): { unreadChats: number; unreadAt: string } {
    return { unreadChats: countUnreadChats(this.db, viewerId), unreadAt: new Date().toISOString() };
  }
  private markDelivered(groupId: string, viewerId: string, seq: number): void {
    this.db.prepare('UPDATE chat_group_members SET delivered_seq=max(delivered_seq, ?) WHERE group_id=? AND user_id=? AND delivered_seq<?').run(seq, groupId, viewerId, seq);
  }
  private audit(actorId: string, action: string, detail: unknown): void {
    this.db.prepare('INSERT INTO audit_log(actor_id,action,school_id,detail,created_at) VALUES(?,?,NULL,?,?)').run(actorId, action, JSON.stringify(detail), this.iso());
  }

  /* ---------- Membership ---------- */

  create(viewerId: string, raw: { name: string; memberIds: string[] }): GroupInfo {
    this.service.ready(viewerId);
    const input = groupCreateSchema.parse(raw);
    const memberIds = [...new Set(input.memberIds)].filter(id => id !== viewerId);
    if (!memberIds.length) fail('BAD_REQUEST', 'Add at least one friend.');
    if (memberIds.length + 1 > CHAT.groupMaxMembers) fail('BAD_REQUEST', GROUP_FULL_MESSAGE);
    return this.db.transaction(() => {
      this.notPaused(viewerId);
      const recent = this.db.prepare('SELECT count(*) n FROM chat_groups WHERE creator_id=? AND created_at>?').get(viewerId, this.iso(-DAY)) as { n: number };
      if (recent.n >= CHAT.groupsPerDay) fail('TOO_MANY_REQUESTS', TOO_MANY_GROUPS_MESSAGE);
      this.checkFriends(viewerId, memberIds);
      const id = randomUUID();
      const createdAt = this.iso();
      this.db.prepare('INSERT INTO chat_groups(id,name,creator_id,revision,last_message_at,created_at) VALUES(?,?,?,0,NULL,?)').run(id, input.name, viewerId, createdAt);
      const insert = this.db.prepare('INSERT INTO chat_group_members(group_id,user_id,role,joined_at) VALUES(?,?,?,?)');
      insert.run(id, viewerId, 'admin', createdAt);
      for (const memberId of memberIds) insert.run(id, memberId, 'member', createdAt);
      return this.info(this.db.prepare('SELECT * FROM chat_groups WHERE id=?').get(id) as GroupRow, viewerId);
    }).immediate();
  }

  rename(viewerId: string, groupId: string, rawName: string): GroupInfo {
    const name = groupNameSchema.parse(rawName);
    return this.db.transaction(() => {
      const { group } = this.admin(viewerId, groupId);
      this.db.prepare('UPDATE chat_groups SET name=? WHERE id=?').run(name, group.id);
      return this.info({ ...group, name }, viewerId);
    }).immediate();
  }

  /** Adds the admin's friends. Someone who left (or was removed) comes back with a fresh join time, so they see only what follows. */
  addMembers(viewerId: string, groupId: string, rawIds: string[]): GroupInfo {
    const memberIds = [...new Set(groupMembersSchema.shape.memberIds.parse(rawIds))].filter(id => id !== viewerId);
    return this.db.transaction(() => {
      const { group } = this.admin(viewerId, groupId);
      this.notPaused(viewerId);
      const current = this.members(group.id);
      const fresh = memberIds.filter(id => !current.some(member => member.id === id));
      if (current.length + fresh.length > CHAT.groupMaxMembers) fail('BAD_REQUEST', GROUP_FULL_MESSAGE);
      this.checkFriends(viewerId, fresh);
      const joinedAt = this.iso();
      const maxSeq = (this.db.prepare('SELECT coalesce(max(seq), 0) seq FROM chat_group_messages WHERE group_id=?').get(group.id) as { seq: number }).seq;
      const upsert = this.db.prepare(`INSERT INTO chat_group_members(group_id,user_id,role,joined_at,last_read_seq,delivered_seq,notified_seq) VALUES(?,?,'member',?,?,?,?)
        ON CONFLICT(group_id,user_id) DO UPDATE SET role='member', joined_at=excluded.joined_at, left_at=NULL, last_read_seq=excluded.last_read_seq, delivered_seq=excluded.delivered_seq, notified_seq=excluded.notified_seq, muted=0, typing_until=NULL`);
      for (const id of fresh) upsert.run(group.id, id, joinedAt, maxSeq, maxSeq, maxSeq);
      return this.info(group, viewerId);
    }).immediate();
  }

  removeMember(viewerId: string, groupId: string, userId: string): GroupInfo {
    if (userId === viewerId) fail('BAD_REQUEST', 'Leave the group instead.');
    return this.db.transaction(() => {
      const { group } = this.admin(viewerId, groupId);
      if (!this.db.prepare('SELECT 1 FROM chat_group_members WHERE group_id=? AND user_id=? AND left_at IS NULL').get(group.id, userId)) fail('NOT_FOUND', 'That person is not in this group.');
      leaveGroup(this.db, group.id, userId, this.iso());
      return this.info(group, viewerId);
    }).immediate();
  }

  leave(viewerId: string, groupId: string): { left: true } {
    return this.db.transaction(() => {
      const { group } = this.member(viewerId, groupId);
      leaveGroup(this.db, group.id, viewerId, this.iso());
      return { left: true as const };
    }).immediate();
  }

  /* ---------- Reading ---------- */

  /** The viewer's groups for the chat list, most recently active first. Marks the newest message of each as delivered. */
  list(viewerId: string): GroupSummary[] {
    this.service.ready(viewerId);
    const { rows, delivered } = this.db.transaction(() => {
      const groups = this.db.prepare(`SELECT g.*, m.role, m.last_read_seq, m.delivered_seq, m.muted, m.joined_at FROM chat_group_members m JOIN chat_groups g ON g.id=m.group_id
        WHERE m.user_id=? AND m.left_at IS NULL`).all(viewerId) as (GroupRow & { role: GroupRole; last_read_seq: number; delivered_seq: number; muted: number; joined_at: string })[];
      const latest = this.db.prepare(`${MESSAGE_SQL} JOIN chat_group_members m ON m.group_id=c.group_id AND m.user_id=? WHERE c.group_id=? AND ${VISIBLE_SQL('m')} ORDER BY c.seq DESC LIMIT 1`);
      const unread = this.db.prepare(`SELECT count(*) n FROM chat_group_messages c JOIN chat_group_members m ON m.group_id=c.group_id AND m.user_id=? WHERE c.group_id=? AND c.seq>? AND c.sender_id<>? AND c.deleted_at IS NULL AND ${VISIBLE_SQL('m')}`);
      const delivered: { groupId: string; seq: number }[] = [];
      const rows = groups.map((group): GroupSummary => {
        const last = latest.get(viewerId, group.id) as MessageRow | undefined;
        if (last && last.sender_id !== viewerId && last.seq > group.delivered_seq) delivered.push({ groupId: group.id, seq: last.seq });
        const members = this.members(group.id);
        const deleted = !!last?.deleted_at;
        return {
          id: group.id, name: group.name, memberCount: members.length, role: group.role,
          members: members.filter(member => member.id !== viewerId).slice(0, 4).map(member => ({ id: member.id, displayName: member.displayName, avatar: member.avatar })),
          lastMessage: last ? { senderName: last.display_name, fromMe: last.sender_id === viewerId, preview: deleted ? null : listPreview(last.body), createdAt: last.created_at, deletedBy: deleted ? last.deleted_by : null } : null,
          lastAt: last?.created_at ?? group.created_at,
          unread: (unread.get(viewerId, group.id, group.last_read_seq, viewerId) as { n: number }).n,
          muted: !!group.muted,
        };
      }).sort((left, right) => right.lastAt.localeCompare(left.lastAt));
      return { rows, delivered };
    })();
    for (const entry of delivered) this.markDelivered(entry.groupId, viewerId, entry.seq);
    return rows;
  }

  thread(viewerId: string, groupId: string, cursor: { after?: number; before?: number } = {}) {
    if (cursor.after !== undefined && cursor.before !== undefined) fail('BAD_REQUEST', 'Use either after or before, not both.');
    const { deliver, ...result } = this.db.transaction(() => {
      const { group, member } = this.member(viewerId, groupId);
      const members = this.members(group.id);
      const nowIso = this.iso();
      const receipts: Receipt[] = members.filter(entry => entry.id !== viewerId).map(entry => ({
        id: entry.id, displayName: entry.displayName, avatar: entry.avatar, deliveredSeq: entry.row.delivered_seq, readSeq: entry.row.last_read_seq, typing: !!entry.row.typing_until && entry.row.typing_until > nowIso,
      }));
      const info: GroupInfo = { id: group.id, name: group.name, createdAt: group.created_at, role: member.role, members: members.map(({ row: _row, ...entry }) => entry) };
      const base = { peer: null, group: info, revision: group.revision, lastReadSeq: member.last_read_seq, muted: !!member.muted, pause: this.pause(viewerId), receipts };
      const toMessages = (rows: MessageRow[]) => rows.map(row => this.message(viewerId, row));
      const newest = (rows: MessageRow[]) => {
        const seq = rows.reduce((max, row) => (row.sender_id !== viewerId && row.seq > max ? row.seq : max), 0);
        return seq > member.delivered_seq ? { seq } : null;
      };
      if (cursor.after !== undefined) {
        const changes = cursor.after > group.revision ? null
          : this.db.prepare(`${MESSAGE_SQL} JOIN chat_group_members m ON m.group_id=c.group_id AND m.user_id=? WHERE c.group_id=? AND ${VISIBLE_SQL('m')} AND c.revision>? ORDER BY c.seq LIMIT ?`).all(viewerId, group.id, cursor.after, CHAT.maxChanges + 1) as MessageRow[];
        if (changes && changes.length <= CHAT.maxChanges) return { ...base, deliver: newest(changes), messages: toMessages(changes), hasEarlier: false, reset: false };
        const page = this.latestPage(member);
        return { ...base, deliver: newest(page.rows), messages: toMessages(page.rows), hasEarlier: page.hasEarlier, reset: true };
      }
      const page = this.latestPage(member, cursor.before);
      return { ...base, deliver: newest(page.rows), messages: toMessages(page.rows), hasEarlier: page.hasEarlier, reset: false };
    })();
    if (deliver) this.markDelivered(groupId, viewerId, deliver.seq);
    return result;
  }

  /* ---------- Writing ---------- */

  send(viewerId: string, groupId: string, clientId: string, raw: string): { message: GroupMessage } {
    const body = censorBody(normalizeBody(typeof raw === 'string' ? raw : ''));
    const problem = bodyError(body);
    if (problem) fail('BAD_REQUEST', problem);
    return this.db.transaction(() => {
      const { group } = this.member(viewerId, groupId);
      const existing = this.db.prepare(`${MESSAGE_SQL} WHERE c.id=?`).get(clientId) as MessageRow | undefined;
      if (existing) {
        if (existing.sender_id !== viewerId || existing.group_id !== group.id || existing.body !== body) fail('BAD_REQUEST', 'A retry ID cannot be reused for a different message.');
        return { message: this.message(viewerId, existing) };
      }
      this.notPaused(viewerId);
      const sent = (since: number) => countSentSince(this.db, viewerId, this.iso(-since));
      if (sent(60_000) >= CHAT.perMinute) fail('TOO_MANY_REQUESTS', 'You’re sending messages too fast. Wait a minute and try again.');
      if (sent(DAY) >= CHAT.perDay) fail('TOO_MANY_REQUESTS', 'You reached today’s message limit. Try again tomorrow.');
      const revision = this.bumpRevision(group.id);
      const createdAt = this.iso();
      const { seq } = this.db.prepare('INSERT INTO chat_group_messages(id,group_id,sender_id,body,created_at,revision) VALUES(?,?,?,?,?,?) RETURNING seq').get(clientId, group.id, viewerId, body, createdAt, revision) as { seq: number };
      this.db.prepare('UPDATE chat_groups SET last_message_at=? WHERE id=?').run(createdAt, group.id);
      this.db.prepare('UPDATE chat_group_members SET last_read_seq=max(last_read_seq, ?), delivered_seq=max(delivered_seq, ?), typing_until=NULL WHERE group_id=? AND user_id=?').run(seq, seq, group.id, viewerId);
      return { message: this.message(viewerId, this.find(group.id, clientId)!) };
    }).immediate();
  }

  /** The sender deletes their own message; the group admin removes anyone's ("Removed by the group admin"). */
  delete(viewerId: string, groupId: string, messageId: string): { deleted: true } {
    return this.db.transaction(() => {
      const { group, member } = this.member(viewerId, groupId);
      const row = this.find(group.id, messageId);
      if (!row) return fail('NOT_FOUND', MISSING);
      if (row.sender_id !== viewerId && member.role !== 'admin') fail('FORBIDDEN', 'Only the group admin can remove other people’s messages.');
      if (row.deleted_at) return { deleted: true as const };
      const by = row.sender_id === viewerId ? 'sender' : 'admin';
      this.db.prepare('UPDATE chat_group_messages SET deleted_at=?, deleted_by=?, revision=? WHERE seq=?').run(this.iso(), by, this.bumpRevision(group.id), row.seq);
      if (by === 'admin') this.audit(viewerId, 'group.remove', { groupId: group.id, seq: row.seq, senderId: row.sender_id });
      return { deleted: true as const };
    }).immediate();
  }

  read(viewerId: string, groupId: string, seq: number): { unreadChats: number; unreadAt: string } {
    return this.db.transaction(() => {
      const { group } = this.member(viewerId, groupId);
      this.db.prepare('UPDATE chat_group_members SET last_read_seq=max(last_read_seq, min(?, (SELECT coalesce(max(seq), 0) FROM chat_group_messages WHERE group_id=?))) WHERE group_id=? AND user_id=?').run(seq, group.id, group.id, viewerId);
      return this.unreadChats(viewerId);
    }).immediate();
  }

  mute(viewerId: string, groupId: string, muted: boolean): { muted: boolean; unreadChats: number; unreadAt: string } {
    return this.db.transaction(() => {
      const { group } = this.member(viewerId, groupId);
      this.db.prepare('UPDATE chat_group_members SET muted=? WHERE group_id=? AND user_id=?').run(Number(muted), group.id, viewerId);
      return { muted, ...this.unreadChats(viewerId) };
    }).immediate();
  }

  typing(viewerId: string, groupId: string, typing: boolean): { typing: boolean } {
    return this.db.transaction(() => {
      const { group } = this.member(viewerId, groupId);
      this.db.prepare('UPDATE chat_group_members SET typing_until=? WHERE group_id=? AND user_id=?').run(typing ? this.iso(CHAT.typingMs) : null, group.id, viewerId);
      return { typing };
    }).immediate();
  }

  /**
   * Reports one message (§3.1's anchored window: 15 before, the message, 14 after) against its sender. The snapshot
   * holds every member's messages in that window, each tagged with its sender, and is frozen like a one-to-one report.
   */
  report(viewerId: string, groupId: string, raw: { category: ReportCategory; note?: string; seq: number; block: boolean }): { blocked: boolean } {
    const input = groupReportSchema.omit({ groupId: true }).parse(raw);
    const viewer = this.service.ready(viewerId);
    return this.db.transaction(() => {
      const { group } = this.member(viewerId, groupId);
      const anchor = this.db.prepare('SELECT * FROM chat_group_messages WHERE group_id=? AND seq=?').get(group.id, input.seq) as MessageRow | undefined;
      if (!anchor) return fail('NOT_FOUND', MISSING);
      if (anchor.sender_id === viewerId) fail('BAD_REQUEST', 'You cannot report your own message.');
      if (!anchor.body) fail('BAD_REQUEST', NOTHING_TO_REPORT);
      const item = (row: MessageRow, isAnchor = false): StoredItem => ({ seq: row.seq, fromReported: row.sender_id === anchor.sender_id, senderId: row.sender_id, body: row.body, createdAt: row.created_at, deletedBy: row.deleted_at ? (row.deleted_by === 'support' ? 'support' : 'sender') : null, anchor: isAnchor });
      const before = this.db.prepare("SELECT * FROM chat_group_messages WHERE group_id=? AND seq<? AND body<>'' ORDER BY seq DESC LIMIT ?").all(group.id, anchor.seq, CHAT.evidenceBefore) as MessageRow[];
      const after = this.db.prepare("SELECT * FROM chat_group_messages WHERE group_id=? AND seq>? AND body<>'' ORDER BY seq LIMIT ?").all(group.id, anchor.seq, CHAT.evidenceAfter) as MessageRow[];
      const items = [...before.reverse().map(row => item(row)), item(anchor, true), ...after.map(row => item(row))];
      if (this.db.prepare('SELECT 1 FROM reports WHERE reporter_id=? AND group_id=? AND resolved_at IS NULL').get(viewerId, group.id)) fail('CONFLICT', 'You already reported this chat. Support will review it.');
      const open = this.db.prepare('SELECT count(*) n FROM reports WHERE reporter_id=? AND resolved_at IS NULL').get(viewerId) as { n: number };
      if (open.n >= 10) fail('TOO_MANY_REQUESTS', 'You already have ten open reports. Wait for support to review them.');
      const other = this.db.prepare('SELECT school_id FROM users WHERE id=?').get(anchor.sender_id) as { school_id: string | null };
      const label = REPORT_CATEGORIES[input.category].label;
      this.db.prepare('INSERT INTO reports(id,reporter_id,reported_id,school_id,reason,created_at,group_id,evidence,category) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(randomUUID(), viewerId, anchor.sender_id, other.school_id ?? viewer.schoolId, input.note ? `${label}: ${input.note}` : label, this.iso(), group.id, JSON.stringify(items), input.category);
      if (input.block) this.community.block(viewerId, anchor.sender_id, true);
      return { blocked: input.block };
    }).immediate();
  }
}

/** Retention, the same numbers as one-to-one chat (§3.5): messages go after 180 days, deleted text after 30, idle groups after 180. */
export function pruneGroupChat(db: Db, now: Date = new Date()): void {
  const ago = (days: number) => new Date(now.getTime() - days * DAY).toISOString();
  db.transaction(() => {
    db.prepare('DELETE FROM chat_group_messages WHERE created_at < ?').run(ago(CHAT.retentionDays));
    db.prepare("UPDATE chat_group_messages SET body='' WHERE deleted_at IS NOT NULL AND deleted_at < ? AND body <> ''").run(ago(CHAT.deletedTextDays));
    db.prepare('DELETE FROM chat_groups WHERE last_message_at < ? OR (last_message_at IS NULL AND created_at < ?)').run(ago(CHAT.retentionDays), ago(CHAT.retentionDays));
  }).immediate();
}
