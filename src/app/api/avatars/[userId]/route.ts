import { getDb } from '@/server/db';
import { getUserId } from '@/server/auth';
import { Service } from '@/server/service';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A member's uploaded profile picture (docs/CHAT.md §13). Signed-in members only: pictures are shown to schoolmates
 * and friends inside the app, never to the public. The URL carries the picture's version, so a browser may keep it
 * for a year; a new upload gets a new URL.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ userId: string }> }) {
  const { userId } = await params;
  if (!ID.test(userId)) return new Response('Not found', { status: 404 });
  if (!await getUserId()) return new Response('Sign in first', { status: 401, headers: { 'Cache-Control': 'private, no-store' } });
  const image = new Service(getDb()).avatarImage(userId);
  if (!image) return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'private, no-store' } });
  return new Response(new Uint8Array(image.bytes), { headers: {
    'Content-Type': image.mime,
    'Content-Length': String(image.bytes.length),
    'Cache-Control': 'private, max-age=31536000, immutable',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
  } });
}
