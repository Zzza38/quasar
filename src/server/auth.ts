import { getServerSession, type NextAuthOptions } from 'next-auth';
import GoogleProvider from 'next-auth/providers/google';
import { getDb } from './db';
import { usableGooglePicture } from './avatars';
import { randomUUID } from 'node:crypto';

export const authOptions: NextAuthOptions = {
  secret: process.env.NEXTAUTH_SECRET,
  providers: [GoogleProvider({
    clientId: process.env.GOOGLE_CLIENT_ID || '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
    authorization: { params: { scope: 'openid email profile', prompt: 'select_account' } }
  })],
  session: { strategy: 'jwt', maxAge: 30 * 24 * 60 * 60 },
  // A failed or refused sign-in returns to the landing page, which explains the `?error=` code
  // (signInErrorMessage in src/components/landing.tsx), instead of NextAuth's unthemed pages.
  // NextAuth sends callback failures to the sign-in page and refusals to the error page, so both point there.
  // The sign-in redirect carries the failed attempt's `callbackUrl` (e.g. /admin); the landing page keeps a
  // same-origin one for its retry button (signInReturnPath), so the owner console gets the owner back.
  pages: { signIn: '/', error: '/' },
  callbacks: {
    async signIn({ account, profile }) {
      return account?.provider === 'google' && !!profile && 'email_verified' in profile && profile.email_verified === true;
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
        const user = db.prepare('SELECT id FROM users WHERE google_sub = ?').get(profile.sub) as { id: string };
        token.userId = user.id;
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) session.user.id = typeof token.userId === 'string' ? token.userId : '';
      return session;
    }
  }
};
export async function getUserId(): Promise<string | null> {
  const session = await getServerSession(authOptions);
  return session?.user?.id || null;
}
