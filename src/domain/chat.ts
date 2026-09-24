import { z } from 'zod';

/**
 * Phase-4 chat rules shared by the client and the server (docs/CHAT.md §3.3, §3.6, §5).
 * Every number here is an owner-changeable default.
 */
export const CHAT = {
  maxLength: 1000, perMinute: 20, perDay: 500, newChatsPerDay: 20,
  page: 50, maxChanges: 200, evidence: 30, evidenceBefore: 15, evidenceAfter: 14,
  retentionDays: 180, deletedTextDays: 30, evidenceDays: 180, closedRowDays: 30,
  pushDelayMs: 60_000, pushWindowMs: 600_000, pushPerDay: 20, quietStart: 22, quietEnd: 7,
  fallbackTimeZone: 'America/New_York', requiresVerification: false, linkify: true,
} as const;

// C0 and C1 control characters except \n (U+000A) and \t (U+0009).
const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;
// Bidi embeddings, overrides and isolates, plus the LRM and RLM marks.
const BIDI = /[‪-‮⁦-⁩‎‏]/g;
const ZERO_WIDTH = /[​-‍⁠﻿]/g;

/** Server and composer normalization for a message body (§3.3). */
export function normalizeBody(raw: string): string {
  return raw
    .normalize('NFC')
    .replace(/\r\n?/g, '\n')
    .replace(CONTROL, '')
    .replace(BIDI, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export type BodyError = 'Write a message first.' | 'Messages can be up to 1,000 characters.';
/** Fixed-string problem for a normalized body, or null. Used by the composer (disable Send) and by ChatService. */
export function bodyError(normalized: string): BodyError | null {
  if (!normalized.replace(ZERO_WIDTH, '').trim()) return 'Write a message first.';
  if (normalized.length > CHAT.maxLength) return 'Messages can be up to 1,000 characters.';
  return null;
}

const URL_PATTERN = /https:\/\/[^\s<>"]+/g;
const TRAILING = /[.,;:!?)\]}'"]+$/;
/** Splits text into plain runs and `https://` links. Only https URLs without credentials become links (§3.6). */
export function linkParts(text: string): Array<{ text: string; href?: string }> {
  if (!CHAT.linkify) return text ? [{ text }] : [];
  const parts: Array<{ text: string; href?: string }> = [];
  const pushText = (value: string) => {
    if (!value) return;
    const last = parts[parts.length - 1];
    if (last && !last.href) last.text += value;
    else parts.push({ text: value });
  };
  let cursor = 0;
  for (const match of text.matchAll(URL_PATTERN)) {
    const start = match.index ?? 0;
    const candidate = match[0].replace(TRAILING, '');
    pushText(text.slice(cursor, start));
    if (isSafeLink(candidate)) parts.push({ text: candidate, href: candidate });
    else pushText(candidate);
    cursor = start + candidate.length;
  }
  pushText(text.slice(cursor));
  return parts;
}
function isSafeLink(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch { return false; }
}

/** The only zod-level check on a message body. Everything else is a fixed-string service check. */
export const rawBodySchema = z.string().max(4000);
export const reportCategorySchema = z.enum(['danger', 'bullying', 'sexual', 'spam', 'other']);
export type ReportCategory = z.infer<typeof reportCategorySchema>;
export const REPORT_CATEGORIES: Record<ReportCategory, { label: string; short: string }> = {
  danger: { label: 'Someone may be in danger', short: 'Danger' },
  bullying: { label: 'Bullying or harassment', short: 'Bullying' },
  sexual: { label: 'Sexual content', short: 'Sexual content' },
  spam: { label: 'Spam or scam', short: 'Spam' },
  other: { label: 'Something else', short: 'Other' },
};
