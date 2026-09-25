import type { DefaultSession } from 'next-auth';
declare module 'next-auth' {
  /** `epoch` and `authAt` come from the token (src/server/auth.ts): session revocation and the last Google sign-in. */
  interface Session { user: { id: string } & DefaultSession['user']; epoch?: number; authAt?: number | null }
}
