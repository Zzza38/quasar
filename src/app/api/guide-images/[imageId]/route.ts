import { getDb } from '@/server/db';
import { getUserId } from '@/server/auth';
import { Service } from '@/server/service';
import { SetupGuideService } from '@/server/setup-guides';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A screenshot support added to a setup guide (src/server/setup-guides.ts). Signed-in members only, like
 * avatars. An image never changes under its id (a new screenshot is a new upload), so a browser may keep it for a year.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ imageId: string }> }) {
  const { imageId } = await params;
  if (!ID.test(imageId)) return new Response('Not found', { status: 404 });
  if (!await getUserId()) return new Response('Sign in first', { status: 401, headers: { 'Cache-Control': 'private, no-store' } });
  const image = new SetupGuideService(new Service(getDb())).image(imageId);
  if (!image) return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'private, no-store' } });
  return new Response(new Uint8Array(image), { headers: {
    'Content-Type': 'image/webp',
    'Content-Length': String(image.length),
    'Cache-Control': 'private, max-age=31536000, immutable',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
  } });
}
