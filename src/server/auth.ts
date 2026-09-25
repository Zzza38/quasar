import { getServerSession, type NextAuthOptions, type Session } from 'next-auth';
import GoogleProvider from 'next-auth/providers/google';
import { getDb, type Db } from './db';
import { usableGooglePicture } from './avatars';
import { randomUUID } from 'node:crypto';

/** How long a session lasts from its Google sign-in (authOptions.session.maxAge); authFromSession enforces it too. */
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const authOptions: NextAuthOptions = {
  secret: process.env.NEXTAUTH_SECRET,
  providers: [GoogleProvider({
    clientId: process.env.GOOGLE_CLIENT_ID || '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
    authorization: { params: { scope: 'openid email profile', prompt: 'select_account' } }
  })],
  session: { strategy: 'jwt', maxAge: SESSION_MAX_AGE_MS / 1000 },
  // A failed or refused sign-in returns to the landing page, which explains the `?error=` code
  // (signInErrorMessage in src/components/landing.tsx), instead of NextAuth's unthemed pages.
  // NextAuth sends callback failures to the sign-in page and refusals to the error page, so both point there.
  // The sign-in redirect carries the failed attempt's `callbackUrl` (e.g. /admin); the landing page keeps a
  // same-origin one for its retry button (signInReturnPath), so the owner console gets the owner back.
  pages: { signIn: '/', error: '/' },
  callbacks: {
    async signIn({ account, profile }) {
      if (!(account?.provider === 'google' && !!profile && 'email_verified' in profile && profile.email_verified === true)) return false;
      // A suspended account is sent back to the landing page, which explains `?error=Suspended` (src/lib/sign-in.ts).
      const suspended = profile.sub ? getDb().prepare('SELECT 1 FROM users WHERE google_sub=? AND suspended_at IS NOT NULL').get(profile.sub) : undefined;
      return suspended ? '/?error=Suspended' : true;
    },
    async jwt({ token, account, profile }) {
      if (account?.provider === 'google' && profile?.sub && profile.email) {
        const db = getDb();
        const googleName = typeof profile.name === 'string' ? profile.name.trim().slice(0, 160) : '';
        // The Google profile picture (docs/CHAT.md §13): kept only when it is an https URL on Google's CDN.
        const claimed = (profile as { picture?: unknown }).picture;
        const picture = typeof claimed === 'string' && claimed.length <= 1024 && usableGooglePicture(claimed) ? claimed : '';
        db.prepare(`INSERT INTO users(id,google_sub,email,google_name,google_picture,created_at) VALUES(?,?,?,?,?,?)
          ON CONFLICT(google_sub) DO UPDATE SET email=excluded.email, google_name=excluded.google_name, google_picture=excluded.google_picture`)
          .run(randomUUID(), profile.sub, profile.email.toLowerCase(), googleName, picture, new Date().toISOString());
        const user = db.prepare('SELECT id, session_epoch FROM users WHERE google_sub = ?').get(profile.sub) as { id: string; session_epoch: number };
        token.userId = user.id;
        // Compared with users.session_epoch on every request (getAuth), so support can end every session at once.
        token.epoch = user.session_epoch;
        // When this Google sign-in happened. Owner tools require a recent one (ADMIN_SIGN_IN_MAX_AGE_MS in src/server/router.ts).
        token.authAt = Date.now();
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) session.user.id = typeof token.userId === 'string' ? token.userId : '';
      session.epoch = typeof token.epoch === 'number' ? token.epoch : 0;
      session.authAt = typeof token.authAt === 'number' ? token.authAt : null;
      return session;
    }
  }
};
/** Who is asking, and when they last completed a Google sign-in (null for sessions from before that was recorded). */
export type Auth = { userId: string | null; authAt: number | null };
/**
 * The session cookie's account, if it is still valid: the account exists, is not suspended, and has not been signed
 * out everywhere since this session began (users.session_epoch; sessions from before the epoch existed count as 0).
 */
export async function getAuth(): Promise<Auth> {
  return authFromSession(getDb(), await getServerSession(authOptions));
}
export function authFromSession(db: Db, session: Pick<Session, 'user' | 'epoch' | 'authAt'> | null, now = Date.now()): Auth {
  const userId = session?.user?.id || null;
  if (!userId) return { userId: null, authAt: null };
  const row = db.prepare('SELECT session_epoch, suspended_at FROM users WHERE id=?').get(userId) as { session_epoch: number; suspended_at: string | null } | undefined;
  if (!row || row.suspended_at || row.session_epoch !== (session?.epoch ?? 0)) return { userId: null, authAt: null };
  const authAt = session?.authAt ?? null;
  if (authAt !== null && now - authAt > SESSION_MAX_AGE_MS) return { userId: null, authAt: null };
  return { userId, authAt };
}
export async function getUserId(): Promise<string | null> {
  return (await getAuth()).userId;
}
