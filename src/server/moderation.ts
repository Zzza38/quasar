import { censorBody } from '@/domain/chat';
import { canSeeCensored, canSeeEdited, canSeeRemoved, isModerationRank, moderationRank, type StaffRank } from '@/domain/staff';
import type { Service } from './service';

/**
 * Who reads text taken out of a chat (src/domain/staff.ts). The server keeps a message's text as sent, its text from
 * before an edit and its text after removal (until retention clears it), and hands each viewer only what their tier
 * may read: the owner every slur the filter hid, moderators and up what someone at their tier or below removed or
 * edited, everyone what a member edited. Nobody else is sent any of it.
 */

/** The rank stored with a removal or an edit. 'member' says a member (or support) did it, so it never falls back. */
export type ActorRank = 'owner' | 'administrator' | 'moderator' | 'member';
export function actorRank(service: Service, actorId: string): ActorRank {
  return moderationRank(service.staffRank(actorId)) ?? 'member';
}

/** Text a viewer may read: `body` censored like any message, `original` the uncensored text for the owner. */
export type RevealedText = { body: string; original: string | null };
/** A removed message's text and photo, for a viewer whose tier may read it. */
export type RemovedText = RevealedText & { image: string | null };

type RemovableRow = { seq: number; sender_id: string; body: string; original?: string | null; image: string | null;
  deleted_at: string | null; deleted_by: string | null; deleted_rank?: string | null };
type EditableRow = { edited_at: string | null; edited_from?: string | null; edited_rank?: string | null };

/**
 * Who removed a message, as a moderation rank (null for a member). For a row removed before ranks were stored,
 * support's and staff removals were the owner's and a sender's own ranks as the sender does now.
 */
export function removerRank(service: Service, row: RemovableRow): StaffRank | null {
  if (row.deleted_rank === 'member') return null;
  if (isModerationRank(row.deleted_rank)) return row.deleted_rank;
  if (row.deleted_by === 'support' || row.deleted_by === 'owner') return 'owner';
  if (row.deleted_by === 'sender') return moderationRank(service.staffRank(row.sender_id));
  return null;
}
/** Who edited a message, as a moderation rank. A Global edit made before ranks were stored was the owner's. */
export function editorRank(row: EditableRow): StaffRank | null {
  if (row.edited_rank === 'member') return null;
  return isModerationRank(row.edited_rank) ? row.edited_rank : 'owner';
}

/** One viewer's reveal rules, with their rank looked up once. */
export class Reveal {
  readonly rank: StaffRank | null;
  constructor(private readonly service: Service, viewerId: string) {
    this.rank = service.staffRank(viewerId);
  }
  /** The uncensored text of a message still showing: the owner only, when the filter changed something. */
  original(row: { original?: string | null; deleted_at: string | null }): string | null {
    return !row.deleted_at && canSeeCensored(this.rank) ? row.original ?? null : null;
  }
  /** A removed message's text and photo, when the viewer's tier may read it and retention has not cleared them. */
  removed(row: RemovableRow, kind: 'peer' | 'group' | 'global' | 'school'): RemovedText | null {
    if (!row.deleted_at || (!row.body && !row.image)) return null;
    if (!canSeeRemoved(this.rank, removerRank(this.service, row))) return null;
    return { body: row.body, original: canSeeCensored(this.rank) ? row.original ?? null : null, image: row.image ? `/api/chat/images/${kind}/${row.seq}` : null };
  }
  /** A room message's (Global or school) text from before its first edit, when the viewer's tier may read it. */
  editedFrom(row: EditableRow & { deleted_at: string | null; body: string; image: string | null }): RevealedText | null {
    if (!row.edited_at || !row.edited_from || (row.deleted_at && !row.body && !row.image)) return null;
    if (!canSeeEdited(this.rank, editorRank(row))) return null;
    const body = censorBody(row.edited_from);
    return { body, original: canSeeCensored(this.rank) && body !== row.edited_from ? row.edited_from : null };
  }
}
