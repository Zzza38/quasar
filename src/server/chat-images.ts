import sharp from 'sharp';
import { TRPCError } from '@trpc/server';
import { CHAT, chatImageSchema } from '@/domain/chat';
import type { Service } from './service';
import { ChatService } from './chat';
import { targetExists } from './chat-extras';

/** Decode and re-encode every upload, stripping metadata and refusing oversized or invalid images. */
export async function prepareChatImage(raw: string | undefined): Promise<string | undefined> {
  if (raw === undefined) return undefined;
  try {
    const bytes = Buffer.from(chatImageSchema.parse(raw)!, 'base64');
    if (!bytes.length || bytes.length > CHAT.imageMaxBytes) throw new Error('size');
    const image = sharp(bytes, { limitInputPixels: 40_000_000, animated: false });
    const metadata = await image.metadata();
    if (!['jpeg', 'png', 'webp', 'gif'].includes(metadata.format ?? '')) throw new Error('format');
    const output = await image.rotate().resize(CHAT.imageMaxDimension, CHAT.imageMaxDimension, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 80 }).toBuffer();
    if (output.length > CHAT.imageMaxBytes) throw new Error('size');
    return output.toString('base64');
  } catch {
    throw new TRPCError({ code: 'BAD_REQUEST', message: 'Choose a JPEG, PNG, WebP or GIF image up to 1 MB.' });
  }
}

/** Recheck access on each fetch, including blocks, group membership, join time and deletion. */
export function readChatImage(service: Service, viewer: string, kind: 'peer' | 'group' | 'global', seq: number): Buffer | null {
  service.ready(viewer);
  const db = service.db;
  const table = { peer: 'chat_messages', group: 'chat_group_messages', global: 'global_messages' }[kind];
  const row = db.prepare(`SELECT * FROM ${table} WHERE seq=? AND deleted_at IS NULL`).get(seq) as {
    seq: number; sender_id: string; thread_id?: string; group_id?: string; image: string | null;
  } | undefined;
  if (!row?.image) return null;
  if (kind === 'peer') {
    const thread = db.prepare('SELECT user_low, user_high FROM chat_threads WHERE id=?').get(row.thread_id) as { user_low: string; user_high: string };
    if (viewer !== thread.user_low && viewer !== thread.user_high) return null;
    new ChatService(service).access(viewer, viewer === thread.user_low ? thread.user_high : thread.user_low);
  } else if (!targetExists(db, kind, viewer, row.seq, row.group_id)) return null;
  return Buffer.from(row.image, 'base64');
}
