import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { CHAT, EDIT_WINDOW_MESSAGE, REACTIONS, mentionsName, searchSnippet, withinEditWindow, type Reaction, type MessageExtras, type MessageMention, type MessageReaction, type MessageReactor, type SearchHit } from '@/domain/chat';
import { censorSlurs } from '@/domain/chat-filter';
import { plainText } from '@/domain/markdown';
import { AVATAR_COLUMNS, avatarUrl, type AvatarRow } from './avatars';
import type { Db } from './db';

export const reactionSchema = z.object({ seq: z.number().int().positive(), emoji: z.enum(REACTIONS).nullable() });
export const replySchema = z.number().int().positive().optional();
type Kind = 'peer' | 'group' | 'global' | 'school';
const tables = {
  peer: ['chat_messages', 'chat_reactions', 'thread_id'],
  group: ['chat_group_messages', 'chat_group_reactions', 'group_id'],
  global: ['global_messages', 'global_reactions', null],
  school: ['school_messages', 'school_reactions', 'school_id'],
} as const;

/** The same visibility rules apply to a target as to a row in its thread. Deleted rows remain valid quotes. */
export function targetExists(db: Db, kind: Kind, viewer: string, seq: number, scope?: string): boolean {
  const [messages, , key] = tables[kind];
  const scopeSql = key ? `AND c.${key}=@scope` : '';
  const visibility = kind === 'group' ? `AND EXISTS(SELECT 1 FROM chat_group_members m WHERE m.group_id=c.group_id
    AND m.user_id=@viewer AND m.left_at IS NULL AND c.created_at>=m.joined_at)`
    // A school room is readable by the school's current members only (docs/CHAT.md §16).
    : kind === 'school' ? 'AND EXISTS(SELECT 1 FROM users vu WHERE vu.id=@viewer AND vu.school_id=c.school_id)' : '';
  const blocked = kind === 'peer' ? '' : `AND NOT EXISTS(SELECT 1 FROM blocks b WHERE b.blocker_id=@viewer AND b.blocked_id=c.sender_id)`;
  return !!db.prepare(`SELECT 1 FROM ${messages} c WHERE c.seq=@seq ${scopeSql} ${visibility} ${blocked}`).get({ seq, scope: scope ?? null, viewer });
}
export function validateReply(db: Db, kind: Kind, viewer: string, seq: number | undefined, scope?: string): void {
  if (seq !== undefined && (!Number.isInteger(seq) || seq <= 0 || !targetExists(db, kind, viewer, seq, scope))) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'That message is no longer available.' });
  }
}

export function reactionsFor(db: Db, kind: Kind, viewer: string, seq: number): MessageReaction[] {
  const rows = db.prepare(`SELECT emoji, count(*) count, max(user_id=?) mine FROM ${tables[kind][1]} WHERE message_seq=? GROUP BY emoji`).all(viewer, seq) as { emoji: Reaction; count: number; mine: number }[];
  return REACTIONS.flatMap(emoji => {
    const row = rows.find(row => row.emoji === emoji);
    return row ? [{ emoji, count: row.count, mine: !!row.mine }] : [];
  });
}

/**
 * Who reacted, in the order they did, for the "Reactions" list under a pill. The viewer is flagged instead of named.
 * Outside a one-to-one chat, people the viewer blocked are left out (their messages are hidden from the viewer too),
 * so the list can be shorter than the counts. Capped at CHAT.reactorsShown names per message.
 */
export function reactorsFor(db: Db, kind: Kind, viewer: string, seq: number): MessageReactor[] {
  const blocked = kind === 'peer' ? '' : 'AND NOT EXISTS(SELECT 1 FROM blocks b WHERE b.blocker_id=@viewer AND b.blocked_id=r.user_id)';
  const rows = db.prepare(`SELECT r.emoji, u.id, u.display_name, ${AVATAR_COLUMNS.split(', ').map(column => `u.${column}`).join(', ')}
    FROM ${tables[kind][1]} r JOIN users u ON u.id=r.user_id WHERE r.message_seq=@seq ${blocked} ORDER BY r.rowid LIMIT @limit`)
    .all({ seq, viewer, limit: CHAT.reactorsShown }) as (AvatarRow & { emoji: Reaction; display_name: string })[];
  return rows.map(row => ({ emoji: row.emoji, name: row.display_name, avatar: avatarUrl(row), me: row.id === viewer }));
}

/** Resolve quotes from a self-join at read time, never from a frozen copy of the target's text. */
export function messageExtras(db: Db, kind: Kind, viewer: string, seq: number): MessageExtras {
  const [messages, , key] = tables[kind];
  const row = db.prepare(`SELECT c.reply_to_seq, r.seq target_seq, r.sender_id, r.body, r.image, r.deleted_at, u.display_name,
      ${key ? `c.${key}` : 'NULL'} scope
    FROM ${messages} c LEFT JOIN ${messages} r ON r.seq=c.reply_to_seq ${key ? `AND r.${key}=c.${key}` : ''}
    LEFT JOIN users u ON u.id=r.sender_id WHERE c.seq=?`).get(seq) as {
      reply_to_seq: number | null; target_seq: number | null; sender_id: string | null; body: string | null; image: string | null;
      deleted_at: string | null; display_name: string | null; scope: string | null;
    };
  const visible = row.reply_to_seq !== null && row.target_seq !== null && !row.deleted_at && (!!row.body || !!row.image)
    && targetExists(db, kind, viewer, row.reply_to_seq, row.scope ?? undefined);
  const attachment = db.prepare(`SELECT id, image, deleted_at, ${kind === 'peer' ? 'NULL' : 'mentions'} mentions FROM ${messages} WHERE seq=?`).get(seq) as { id: string; image: string | null; deleted_at: string | null; mentions: string | null };
  const reactions = reactionsFor(db, kind, viewer, seq);
  return {
    image: attachment.image && !attachment.deleted_at ? `/api/chat/images/${kind}/${seq}` : null,
    replyTo: row.reply_to_seq === null ? null : {
      seq: row.reply_to_seq, fromMe: visible && row.sender_id === viewer, senderName: visible ? row.display_name ?? '' : '',
      preview: visible ? censorSlurs(plainText(row.body!)).replace(/\s+/g, ' ').trim().slice(0, 140) || (row.image ? 'Photo' : '') : null,
    },
    reactions,
    reactors: reactions.length ? reactorsFor(db, kind, viewer, seq) : [],
    mentions: attachment.deleted_at ? [] : readMentions(attachment.mentions, viewer),
  };
}

/* ---------- Mentions (groups and rooms) ---------- */

type StoredMention = { id: string; name: string };
function storedMentions(raw: string | null): StoredMention[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((entry): entry is StoredMention => !!entry && typeof entry.id === 'string' && typeof entry.name === 'string') : [];
  } catch { return []; }
}
function readMentions(raw: string | null, viewer: string): MessageMention[] {
  return storedMentions(raw).map(mention => ({ id: mention.id, name: mention.name, me: mention.id === viewer }));
}

/**
 * What a new message stores as its mentions: the picked people who can read the conversation (a live member of the
 * group, a member of the school, anyone with names in the Global chat) and whose "@Name" the text really carries.
 * Anything else is dropped without an error, so a stale pick never fails a send. Null when nobody is left.
 */
export function resolveMentions(db: Db, kind: 'group' | 'global' | 'school', viewer: string, scope: string | undefined, body: string, ids: string[] | undefined): string | null {
  const unique = [...new Set(ids ?? [])].filter(id => id !== viewer).slice(0, CHAT.mentionsPerMessage);
  if (!unique.length) return null;
  const find = db.prepare(kind === 'group'
    ? 'SELECT u.id, u.display_name name FROM chat_group_members m JOIN users u ON u.id=m.user_id WHERE m.group_id=@scope AND m.user_id=@id AND m.left_at IS NULL'
    : kind === 'school' ? "SELECT id, display_name name FROM users WHERE id=@id AND school_id=@scope AND display_name<>'' AND full_name<>''"
      : "SELECT id, display_name name FROM users WHERE id=@id AND display_name<>'' AND full_name<>'' AND @scope IS NULL");
  const found = unique.flatMap((id) => {
    const row = find.get({ id, scope: kind === 'global' ? null : scope ?? '' }) as StoredMention | undefined;
    return row && mentionsName(body, row.name) ? [{ id: row.id, name: row.name }] : [];
  });
  return found.length ? JSON.stringify(found) : null;
}

/** An edit keeps the mentions whose "@Name" the new text still carries; it never adds one. */
export function keptMentions(raw: string | null, body: string): string | null {
  const kept = storedMentions(raw).filter(mention => mentionsName(body, mention.name));
  return kept.length ? JSON.stringify(kept) : null;
}

/** SQL that is true when message `c` mentions the member bound as `user`. Ids are UUIDs, so the pattern cannot match by accident. */
export const mentionsUserSql = (user: string) => `(c.mentions IS NOT NULL AND instr(c.mentions, '"id":"' || ${user} || '"') > 0)`;

/* ---------- A sender's own edit ---------- */

/**
 * The checks every chat kind shares before a sender rewrites their own message: it is theirs, still showing, and
 * inside CHAT.editWindowMs. `missing` is the kind's own wording for a message that is gone.
 */
export function assertOwnEdit(row: { sender_id: string; deleted_at: string | null; created_at: string } | undefined, viewer: string, now: Date, missing: string): void {
  if (!row || row.deleted_at) throw new TRPCError({ code: 'NOT_FOUND', message: missing });
  if (row.sender_id !== viewer) throw new TRPCError({ code: 'FORBIDDEN', message: 'You can only edit your own messages.' });
  if (!withinEditWindow(row.created_at, now)) throw new TRPCError({ code: 'BAD_REQUEST', message: EDIT_WINDOW_MESSAGE });
}

/* ---------- Search inside one conversation ---------- */

/** The query as searched (trimmed, spaces collapsed) and its LIKE pattern, or null when it is too short to search. */
export function searchTerms(raw: string): { query: string; pattern: string } | null {
  const query = raw.normalize('NFC').replace(/\s+/g, ' ').trim().slice(0, CHAT.searchMaxLength);
  if (Array.from(query).length < CHAT.searchMinLength) return null;
  return { query, pattern: `%${query.replace(/[\\%_]/g, character => `\\${character}`)}%` };
}
/** The LIKE clause for searchTerms' pattern, bound as `param`. Bodies are stored censored, so a search never reads what the filter hid. */
export const searchSql = (param: string) => `c.deleted_at IS NULL AND c.body LIKE ${param} ESCAPE '\\'`;
export function searchHit(row: { seq: number; sender_id: string; body: string; created_at: string; display_name?: string | null }, viewer: string, query: string): SearchHit {
  return { seq: row.seq, fromMe: row.sender_id === viewer, senderName: row.display_name ?? '', createdAt: row.created_at, preview: searchSnippet(censorSlurs(plainText(row.body)), query) };
}

/** A cursor older than this viewer's last block change must replace its entire loaded window. */
export function visibilityResetRevision(db: Db, kind: 'group' | 'global' | 'school', viewer: string, scope: string): number {
  return (db.prepare('SELECT revision FROM chat_visibility_resets WHERE user_id=? AND kind=? AND scope=?')
    .get(viewer, kind, scope) as { revision: number } | undefined)?.revision ?? 0;
}

/** Called inside the service's permission-checked immediate transaction. The budget spans all chat kinds. */
export function changeReaction(db: Db, kind: Kind, viewer: string, seq: number, emoji: Reaction | null, now: string): void {
  if (emoji !== null && !(REACTIONS as readonly string[]).includes(emoji)) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Choose an available reaction.' });
  }
  const since = new Date(new Date(now).getTime() - 60_000).toISOString();
  db.prepare('DELETE FROM chat_reaction_changes WHERE created_at<=?').run(since);
  const { n } = db.prepare('SELECT count(*) n FROM chat_reaction_changes WHERE user_id=? AND created_at>?').get(viewer, since) as { n: number };
  if (n >= CHAT.reactionsPerMinute) throw new TRPCError({ code: 'TOO_MANY_REQUESTS', message: 'You’re reacting too fast. Wait a minute and try again.' });
  const reactions = tables[kind][1];
  const current = db.prepare(`SELECT emoji FROM ${reactions} WHERE message_seq=? AND user_id=?`).get(seq, viewer) as { emoji: Reaction } | undefined;
  if (emoji === null || current?.emoji === emoji) db.prepare(`DELETE FROM ${reactions} WHERE message_seq=? AND user_id=?`).run(seq, viewer);
  else db.prepare(`INSERT INTO ${reactions}(message_seq,user_id,emoji) VALUES(?,?,?) ON CONFLICT(message_seq,user_id) DO UPDATE SET emoji=excluded.emoji`).run(seq, viewer, emoji);
  db.prepare('INSERT INTO chat_reaction_changes(user_id,created_at) VALUES(?,?)').run(viewer, now);
}
