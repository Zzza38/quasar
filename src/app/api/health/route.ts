import { getDb } from '@/server/db';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export function GET() {
  try { getDb().prepare('SELECT 1').get(); return Response.json({ status: 'ok' }); }
  catch { return Response.json({ status: 'unavailable' }, { status: 503 }); }
}
