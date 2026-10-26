import type { Metadata } from 'next';
import { Admin, type AdminBoot } from '@/components/admin';
import { adminSignInAllowed } from '@/lib/admin-session';
import { getAuth } from '@/server/auth';
import { getDb } from '@/server/db';
import { BetaService } from '@/server/betas';
import { Service } from '@/server/service';

// Rendered per request: the session cookie decides between the sign-in notice, the refusal and the support tools.
// Per request is also what lets the proxy's per-request CSP nonce (src/proxy.ts) reach Next's scripts here.
export const dynamic = 'force-dynamic';

/** Support tools for the owner: nothing a search engine should list. */
export const metadata: Metadata = { robots: { index: false, follow: false }, alternates: { canonical: '/admin' } };

export default async function AdminPage() {
  let initial: AdminBoot | undefined;
  try {
    const { userId, authAt } = await getAuth();
    const service = new Service(getDb());
    const isAdmin = !!userId && service.isAdmin(userId);
    initial = { accountId: userId, isAdmin, adminReady: isAdmin && adminSignInAllowed(authAt), betas: isAdmin ? new BetaService(service).joined(userId) : [] };
  } catch {
    initial = undefined; // The client checks the session itself.
  }
  return <Admin initial={initial} />;
}
