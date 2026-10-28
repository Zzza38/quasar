import { TRPCError } from '@trpc/server';
import { getUserId } from '@/server/auth';
import { getDb } from '@/server/db';
import { Service } from '@/server/service';
import { readChatImage } from '@/server/chat-images';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' };

export async function GET(request: Request, { params }: { params: Promise<{ kind: string; messageId: string }> }) {
  if (request.headers.get('sec-fetch-site') === 'cross-site') return new Response('Forbidden', { status: 403, headers });
  const viewer = await getUserId();
  if (!viewer) return new Response('Sign in first', { status: 401, headers });
  const { kind, messageId } = await params;
  if (!['peer', 'group', 'global'].includes(kind) || !/^[1-9][0-9]{0,15}$/.test(messageId) || !Number.isSafeInteger(Number(messageId))) return new Response('Not found', { status: 404, headers });
  try {
    const bytes = readChatImage(new Service(getDb()), viewer, kind as 'peer' | 'group' | 'global', Number(messageId));
    if (bytes) return new Response(new Uint8Array(bytes), { headers: { ...headers, 'Content-Type': 'image/webp', 'Content-Length': String(bytes.length), 'Content-Security-Policy': "default-src 'none'; sandbox" } });
  } catch (error) {
    if (!(error instanceof TRPCError)) throw error;
  }
  return new Response('Not found', { status: 404, headers });
}
