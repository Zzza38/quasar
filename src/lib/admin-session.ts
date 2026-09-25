/**
 * How recent the owner's Google sign-in must be to use the owner tools (every admin.* procedure; src/server/router.ts).
 * A session lasts 30 days, so without this a session cookie copied off a device would open the console for all of them.
 * Shared with the console, which offers to sign in again when the server answers with ADMIN_REAUTH_MESSAGE.
 */
export const ADMIN_SIGN_IN_MAX_AGE_MS = 2 * 60 * 60 * 1000;
export const ADMIN_REAUTH_MESSAGE = 'For your security, sign in with Google again to use the support tools.';
/** True when `authAt` (ms) is a sign-in within ADMIN_SIGN_IN_MAX_AGE_MS, allowing a minute of clock skew. */
export function recentSignIn(authAt: number | null | undefined, now = Date.now()): boolean {
  return typeof authAt === 'number' && authAt <= now + 60_000 && now - authAt < ADMIN_SIGN_IN_MAX_AGE_MS;
}
