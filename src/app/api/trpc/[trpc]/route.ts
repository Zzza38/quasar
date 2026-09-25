import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import { appRouter } from '@/server/router';
import { Service } from '@/server/service';
import { getDb } from '@/server/db';
import { getUserId } from '@/server/auth';
import { logTrpcError } from '@/server/trpc-log';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const MAX_BODY_BYTES = 5_000_000;
const tooLarge = () => new Response('Request too large', {status: 413});
/** Reads at most MAX_BODY_BYTES and cancels the stream past that, so a chunked body without Content-Length cannot grow unbounded. Null means too large. */
async function readCappedBody(req: Request): Promise<Uint8Array<ArrayBuffer> | null> {
  if (!req.body) return new Uint8Array();
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const {done, value} = await reader.read();
    if (done) return Buffer.concat(chunks, size);
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) { await reader.cancel().catch(() => {}); return null; }
    chunks.push(value);
  }
}
async function handler(req: Request) {
  // Auth cookies must never authorize a cross-origin mutation.
  if (req.method !== 'GET') {
    const origin = req.headers.get('origin');
    const expected = process.env.NEXTAUTH_URL ? new URL(process.env.NEXTAUTH_URL).origin : new URL(req.url).origin;
    if (!origin || origin !== expected) return new Response('Invalid origin', {status: 403});
    if (!req.headers.get('content-type')?.startsWith('application/json')) return new Response('JSON required', {status: 415});
    if (Number(req.headers.get('content-length')) > MAX_BODY_BYTES) return tooLarge();
    // Content-Length is absent on chunked requests, so count the bytes actually read and hand tRPC that one bounded copy.
    const body = await readCappedBody(req);
    if (!body) return tooLarge();
    req = new Request(req.url, {method: req.method, headers: req.headers, body, signal: req.signal});
  }
  return fetchRequestHandler({ endpoint: '/api/trpc', req, router: appRouter,
    createContext: async () => ({ userId: await getUserId(), service: new Service(getDb()) }),
    // Procedure name and error code only: inputs may hold private schedule data.
    onError: logTrpcError,
    responseMeta: () => ({ headers: { 'Cache-Control': 'no-store' } })
  });
}
export { handler as GET, handler as POST };
