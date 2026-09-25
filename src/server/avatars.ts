/**
 * Profile pictures (docs/CHAT.md §13), kept in a module with no imports so every service can read a member's picture
 * without pulling in service.ts (whose top level needs community.ts, which needs the chat services, which need this).
 */

/** The columns avatarUrl reads; every query that shows a member selects them (`AVATAR_COLUMNS`). */
export type AvatarRow = { id: string; google_picture: string | null; avatar_version: number | null; avatar_hidden: number | null };
export const AVATAR_COLUMNS = 'google_picture, avatar_version, avatar_hidden';

/**
 * The picture URL for a member row: the uploaded picture served by /api/avatars/<id> (the version cache-busts it),
 * else the Google profile picture, unless the student chose initials. Only https pictures from Google's CDN are used.
 */
export function avatarUrl(row: AvatarRow): string | null {
  if (row.avatar_hidden) return null;
  if (row.avatar_version) return `/api/avatars/${row.id}?v=${row.avatar_version}`;
  return usableGooglePicture(row.google_picture) ? row.google_picture! : null;
}

export function usableGooglePicture(url: string | null | undefined): boolean {
  if (!url) return false;
  try { const parsed = new URL(url); return parsed.protocol === 'https:' && (parsed.hostname === 'googleusercontent.com' || parsed.hostname.endsWith('.googleusercontent.com')); } catch { return false; }
}
