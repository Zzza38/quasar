import sharp from 'sharp';
import { TRPCError } from '@trpc/server';
import { CHAT, chatImageSchema } from '@/domain/chat';
import type { Service } from './service';
import { ChatService } from './chat';
import { targetExists } from './chat-extras';
import { Reveal } from './moderation';

const IMAGE_ERROR = 'Choose a JPEG, PNG, WebP or GIF image up to 1 MB.';
export const GIF_ERROR = 'This GIF is too big to send. Try a shorter or smaller one.';

/**
 * Decode and re-encode every upload, stripping metadata and refusing oversized or invalid images. A still image
 * becomes a WebP of at most CHAT.imageMaxBytes. An animated GIF (up to CHAT.gifMaxBytes as sent) keeps its frames:
 * it becomes an animated WebP no larger than CHAT.gifMaxDimension a side, at the best quality that fits imageMaxBytes.
 */
export async function prepareChatImage(raw: string | undefined): Promise<string | undefined> {
  if (raw === undefined) return undefined;
  let animated = false;
  try {
    const bytes = Buffer.from(chatImageSchema.parse(raw)!, 'base64');
    if (!bytes.length) throw new Error('size');
    const metadata = await sharp(bytes, { limitInputPixels: 40_000_000, animated: true }).metadata();
    if (!['jpeg', 'png', 'webp', 'gif'].includes(metadata.format ?? '')) throw new Error('format');
    animated = metadata.format === 'gif' && (metadata.pages ?? 1) > 1;
    if (bytes.length > (animated ? CHAT.gifMaxBytes : CHAT.imageMaxBytes)) throw new Error('size');
    if (animated) {
      for (const [side, quality] of [[CHAT.gifMaxDimension, 70], [CHAT.gifMaxDimension, 45], [Math.round(CHAT.gifMaxDimension * 2 / 3), 40], [Math.round(CHAT.gifMaxDimension / 2), 30]] as const) {
        const output = await sharp(bytes, { limitInputPixels: 40_000_000, animated: true }).resize(side, side, { fit: 'inside', withoutEnlargement: true }).webp({ quality, effort: 2 }).toBuffer();
        if (output.length <= CHAT.imageMaxBytes) return output.toString('base64');
      }
      throw new Error('size');
    }
    const output = await sharp(bytes, { limitInputPixels: 40_000_000, animated: false }).rotate().resize(CHAT.imageMaxDimension, CHAT.imageMaxDimension, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 80 }).toBuffer();
    if (output.length > CHAT.imageMaxBytes) throw new Error('size');
    return output.toString('base64');
  } catch {
    throw new TRPCError({ code: 'BAD_REQUEST', message: animated ? GIF_ERROR : IMAGE_ERROR });
  }
}

/**
 * Recheck access on each fetch, including blocks, group membership and join time. A removed message's photo is only
 * served to a viewer whose tier may read the removal (src/server/moderation.ts), until retention clears it.
 */
export function readChatImage(service: Service, viewer: string, kind: 'peer' | 'group' | 'global' | 'school', seq: number): Buffer | null {
  service.ready(viewer);
  const db = service.db;
  const table = { peer: 'chat_messages', group: 'chat_group_messages', global: 'global_messages', school: 'school_messages' }[kind];
  const row = db.prepare(`SELECT * FROM ${table} WHERE seq=?`).get(seq) as {
    seq: number; sender_id: string; thread_id?: string; group_id?: string; school_id?: string; image: string | null; body: string;
    deleted_at: string | null; deleted_by: string | null; deleted_rank: string | null;
  } | undefined;
  if (!row?.image) return null;
  if (row.deleted_at && !new Reveal(service, viewer).removed(row, kind)?.image) return null;
  if (kind === 'peer') {
    const thread = db.prepare('SELECT user_low, user_high FROM chat_threads WHERE id=?').get(row.thread_id) as { user_low: string; user_high: string };
    if (viewer !== thread.user_low && viewer !== thread.user_high) return null;
    new ChatService(service).access(viewer, viewer === thread.user_low ? thread.user_high : thread.user_low);
  } else if (!targetExists(db, kind, viewer, row.seq, row.group_id ?? row.school_id)) return null;
  return Buffer.from(row.image, 'base64');
}
