/**
 * What to tell a student NextAuth sent back to the landing page with `?error=<code>` (authOptions.pages in
 * src/server/auth.ts). AccessDenied is the signIn callback refusing a Google account whose email is not verified;
 * Suspended is it refusing an account support suspended;
 * Configuration is a server setup fault; every other code is an OAuth round trip that failed or was cancelled on
 * Google's screen. Shared by the server-rendered page (src/app/page.tsx) and the landing component.
 */
export function signInErrorMessage(code: string | null): string | null {
  if (!code) return null;
  if (code === 'AccessDenied') return 'Google hasn’t verified the email address on that account, so Quasar can’t sign you in with it. Verify it with Google, or continue with a different Google account.';
  if (code === 'Suspended') return 'Support suspended this account. Contact support if you think this is a mistake.';
  if (code === 'Configuration') return 'Sign-in isn’t working right now. Please try again later.';
  return 'Sign-in didn’t finish. Try again, or continue with a different Google account.';
}

/**
 * Where a retry from the landing page should land. NextAuth redirects there with the `callbackUrl` of the sign-in
 * that failed (for example `https://<origin>/admin` from the owner console), so keep it when it points at this
 * origin and fall back to `/` for anything missing, malformed or off-site.
 */
export function signInReturnPath(callbackUrl: string | null, origin: string): string {
  if (!callbackUrl) return '/';
  try {
    const url = new URL(callbackUrl, origin);
    return url.origin === origin ? `${url.pathname}${url.search}${url.hash}` : '/';
  } catch {
    return '/';
  }
}

/** The sign-in outcome the landing page explains, read once from the address (on the server or in the browser). */
export interface SignInReturn { error: string | null; callbackPath: string }
