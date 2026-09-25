import { Admin, type AdminBoot } from '@/components/admin';
import { getUserId } from '@/server/auth';
import { getDb } from '@/server/db';
import { Service } from '@/server/service';

// Rendered per request: the session cookie decides between the sign-in notice, the refusal and the support tools.
export const dynamic = 'force-dynamic';

export default async function AdminPage() {
  let initial: AdminBoot | undefined;
  try {
    const userId = await getUserId();
    initial = { accountId: userId, isAdmin: !!userId && new Service(getDb()).isAdmin(userId) };
  } catch {
    initial = undefined; // The client checks the session itself.
  }
  return <Admin initial={initial} />;
}
