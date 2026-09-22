import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import { appRouter } from '@/server/router';
import { Service } from '@/server/service';
import { getDb } from '@/server/db';
import { getUserId } from '@/server/auth';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
async function handler(req: Request) {
  // Auth cookies must never authorize a cross-origin mutation.
  if (req.method !== 'GET') {
    const origin = req.headers.get('origin');
    const expected = process.env.NEXTAUTH_URL ? new URL(process.env.NEXTAUTH_URL).origin : new URL(req.url).origin;
    if (!origin || origin !== expected) return new Response('Invalid origin', {status: 403});
    if (!req.headers.get('content-type')?.startsWith('application/json')) return new Response('JSON required', {status: 415});
    if (Number(req.headers.get('content-length')) > 2000000) return new Response('Request too large', {status: 413});
    const body = await req.clone().text();
    if (body.length > 2000000) return new Response('Request too large', {status: 413});
  }
  return fetchRequestHandler({ endpoint: '/api/trpc', req, router: appRouter,
    createContext: async () => ({ userId: await getUserId(), service: new Service(getDb()) }),
    // Procedure name and error code only: inputs may hold private schedule data.
    onError: ({ path, error }) => { if (error.code !== 'UNAUTHORIZED') console.error(`tRPC ${path ?? 'unknown'} failed: ${error.code} ${error.message}`); },
    responseMeta: () => ({ headers: { 'Cache-Control': 'no-store' } })
  });
}
export { handler as GET, handler as POST };
