import { getDb } from '@/server/db';
import { getUserId } from '@/server/auth';
import { SchoolLogoService } from '@/server/school-logos';
import { Service } from '@/server/service';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A school's published logo (src/server/school-logos.ts). Signed-in members only, like profile pictures. The URL
 * carries the logo's version, so a browser may keep it for a year; a new logo gets a new URL.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ schoolId: string }> }) {
  const { schoolId } = await params;
  if (!ID.test(schoolId)) return new Response('Not found', { status: 404 });
  if (!await getUserId()) return new Response('Sign in first', { status: 401, headers: { 'Cache-Control': 'private, no-store' } });
  const image = new SchoolLogoService(new Service(getDb())).logoImage(schoolId);
  if (!image) return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'private, no-store' } });
  return new Response(new Uint8Array(image.bytes), { headers: {
    'Content-Type': image.mime,
    'Content-Length': String(image.bytes.length),
    'Cache-Control': 'private, max-age=31536000, immutable',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox",
  } });
}
