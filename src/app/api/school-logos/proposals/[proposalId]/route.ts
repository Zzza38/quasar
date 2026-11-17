import { getDb } from '@/server/db';
import { getUserId } from '@/server/auth';
import { SchoolLogoService } from '@/server/school-logos';
import { Service } from '@/server/service';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A proposed school logo (src/server/school-logos.ts): shown to members of that school, who vote on it, and to the
 * staff who decide on it. Nobody else can load it. A proposal's picture never changes, so a browser may keep it.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ proposalId: string }> }) {
  const { proposalId } = await params;
  if (!ID.test(proposalId)) return new Response('Not found', { status: 404 });
  const userId = await getUserId();
  if (!userId) return new Response('Sign in first', { status: 401, headers: { 'Cache-Control': 'private, no-store' } });
  const image = new SchoolLogoService(new Service(getDb())).proposalImage(userId, proposalId);
  if (!image) return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'private, no-store' } });
  return new Response(new Uint8Array(image.bytes), { headers: {
    'Content-Type': image.mime,
    'Content-Length': String(image.bytes.length),
    'Cache-Control': 'private, max-age=31536000, immutable',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
  } });
}
