import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { CHAT, REACTIONS, type Reaction, type MessageExtras, type MessageReaction } from '@/domain/chat';
import { censorSlurs } from '@/domain/chat-filter';
import { plainText } from '@/domain/markdown';
import type { Db } from './db';

export const reactionSchema = z.object({ seq: z.number().int().positive(), emoji: z.enum(REACTIONS).nullable() });
export const replySchema = z.number().int().positive().optional();
type Kind = 'peer' | 'group' | 'global';
const tables = {
  peer: ['chat_messages', 'chat_reactions', 'thread_id'],
  group: ['chat_group_messages', 'chat_group_reactions', 'group_id'],
  global: ['global_messages', 'global_reactions', null],
} as const;

/** The same visibility rules apply to a target as to a row in its thread. Deleted rows remain valid quotes. */
export function targetExists(db: Db, kind: Kind, viewer: string, seq: number, scope?: string): boolean {
  const [messages, , key] = tables[kind];
  const scopeSql = key ? `AND c.${key}=@scope` : '';
  const visibility = kind === 'group' ? `AND EXISTS(SELECT 1 FROM chat_group_members m WHERE m.group_id=c.group_id
    AND m.user_id=@viewer AND m.left_at IS NULL AND c.created_at>=m.joined_at)` : '';
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
  const attachment = db.prepare(`SELECT id, image, deleted_at FROM ${messages} WHERE seq=?`).get(seq) as { id: string; image: string | null; deleted_at: string | null };
  return {
    image: attachment.image && !attachment.deleted_at ? `/api/chat/images/${kind}/${seq}` : null,
    replyTo: row.reply_to_seq === null ? null : {
      seq: row.reply_to_seq, fromMe: visible && row.sender_id === viewer, senderName: visible ? row.display_name ?? '' : '',
      preview: visible ? censorSlurs(plainText(row.body!)).replace(/\s+/g, ' ').trim().slice(0, 140) || (row.image ? 'Photo' : '') : null,
    },
    reactions: reactionsFor(db, kind, viewer, seq),
  };
}

/** A cursor older than this viewer's last block change must replace its entire loaded window. */
export function visibilityResetRevision(db: Db, kind: 'group' | 'global', viewer: string, scope: string): number {
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
