import type { InitialBoot } from '@/components/use-workspace';
import { signInErrorMessage, signInReturnPath } from '@/lib/sign-in';
import { getUserId } from '@/server/auth';
import { getDb } from '@/server/db';
import { Service } from '@/server/service';
import { siteOrigin } from '@/server/site';

export type SearchParams = Record<string, string | string[] | undefined>;
const first = (value: string | string[] | undefined): string | null => (Array.isArray(value) ? value[0] ?? null : value ?? null);

/** The query string a page was requested with, for the client's route state. */
export function queryOf(searchParams: SearchParams): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(searchParams)) for (const entry of Array.isArray(value) ? value : value === undefined ? [] : [value]) params.append(key, entry);
  return params.toString();
}

/**
 * The first paint is the real screen. The server reads the session cookie and renders either the landing page (with
 * NextAuth's `?error` and `?callbackUrl` already read) or the account's workspace, so no API round trip stands
 * between the HTML and the app. The client then opens its device store, which adds this device's waiting changes,
 * and keeps syncing as before (useWorkspace in src/components/use-workspace.ts). The service worker caches only its
 * own credentials-omitted fetch of the page, so the offline shell stays the public, signed-out one.
 */
export async function initialBoot(searchParams: SearchParams): Promise<InitialBoot> {
  const renderedAt = Date.now();
  try {
    const userId = await getUserId();
    if (!userId) {
      return { kind: 'signed-out', signInError: signInErrorMessage(first(searchParams.error)), callbackPath: signInReturnPath(first(searchParams.callbackUrl), siteOrigin()), renderedAt };
    }
    return { kind: 'workspace', workspace: new Service(getDb()).workspace(userId, { legacyTasks: false }), renderedAt };
  } catch {
    // The client boots the way it always did: device cache first, then the session check and the workspace.
    return { kind: 'none', renderedAt };
  }
}
