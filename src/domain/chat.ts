import { z } from 'zod';
import { censorSlurs } from './chat-filter';

/**
 * Phase-4 chat rules shared by the client and the server (docs/CHAT.md §3.3, §3.6, §5).
 * Every number here is an owner-changeable default: user-facing copy and input caps derive from these
 * values (see the message helpers below), so editing CHAT is enough to change a limit.
 */
export const CHAT = {
  maxLength: 1000, perMinute: 20, perDay: 500, newChatsPerDay: 20,
  page: 50, maxChanges: 200, evidence: 30, evidenceBefore: 15, evidenceAfter: 14,
  retentionDays: 180, deletedTextDays: 30, evidenceDays: 180, closedRowDays: 30,
  pushDelayMs: 60_000, pushWindowMs: 600_000, pushPerDay: 20, quietStart: 22, quietEnd: 7,
  fallbackTimeZone: 'America/New_York', requiresVerification: false, linkify: true,
  /** Friend groups (docs/CHAT.md §12): members per group, creator included; groups one account may create per rolling day; the name's length. */
  groupMaxMembers: 20, groupsPerDay: 5, groupNameMax: 60,
  /** How long a typing signal lasts (§13); the composer renews it every typingRenewMs while the student keeps typing. */
  typingMs: 6_000, typingRenewMs: 2_500,
  /** The longest appeal a student can write against a pause or a removal (§14). */
  appealMaxLength: 2000,
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

/** "Messages can be up to 1,000 characters." for the default CHAT.maxLength. */
export const TOO_LONG_MESSAGE: `Messages can be up to ${string} characters.` = `Messages can be up to ${CHAT.maxLength.toLocaleString('en-US')} characters.`;
/** "You started 20 new chats today. Try again tomorrow." for the default CHAT.newChatsPerDay. */
export const TOO_MANY_NEW_CHATS_MESSAGE: `You started ${number} new chats today. Try again tomorrow.` = `You started ${CHAT.newChatsPerDay} new chats today. Try again tomorrow.`;
/**
 * Native `maxLength` for chat body textareas: headroom past CHAT.maxLength so a paste that normalizes
 * (trimmed, collapsed newlines) under the limit still fits, while zod's max(4000) stays unreachable.
 */
export const COMPOSER_MAX_LENGTH = CHAT.maxLength + 100;

/** Kept a fixed-shape union (the constant's annotation stops it widening to string) so no caller can return echoed input. */
export type BodyError = 'Write a message first.' | typeof TOO_LONG_MESSAGE;
/** Fixed-string problem for a normalized body, or null. Used by the composer (disable Send) and by ChatService. */
export function bodyError(normalized: string): BodyError | null {
  if (!normalized.replace(ZERO_WIDTH, '').trim()) return 'Write a message first.';
  if (normalized.length > CHAT.maxLength) return TOO_LONG_MESSAGE;
  return null;
}

const URL_PATTERN = /https:\/\/[^\s<>"]+/g;
// Punctuation glued to the end of a URL is not part of it, nor are markdown closers (`**link**`, `_link_`, `~~link~~`).
const TRAILING = /[.,;:!?)\]}'"*_~`]+$/;
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

/**
 * The stored form of a message (§11): slurs censored to asterisks everywhere except inside the https links that
 * linkParts finds, which are kept whole so their address still works. A slur-shaped path segment or host label
 * ("…/wiki/Coon_Rapids") is only hidden where the link is shown, by censoredLinkParts.
 */
export function censorBody(text: string): string {
  return linkParts(text).map(part => (part.href ? part.text : censorSlurs(part.text))).join('');
}

/**
 * linkParts for display: every run's visible text is censored, a link's too, but a link's href keeps the real
 * address, so a censored segment never turns the link into a different, broken URL. Also covers messages stored
 * before the filter existed.
 */
export function censoredLinkParts(text: string): Array<{ text: string; href?: string }> {
  return linkParts(text).map(part => (part.href ? { text: censorSlurs(part.text), href: part.href } : { text: censorSlurs(part.text) }));
}
function isSafeLink(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch { return false; }
}

/** The only zod-level check on a message body. Everything else is a fixed-string service check. */
export const rawBodySchema = z.string().max(Math.max(4000, CHAT.maxLength + 100));
export const reportCategorySchema = z.enum(['danger', 'bullying', 'sexual', 'spam', 'other']);
export type ReportCategory = z.infer<typeof reportCategorySchema>;
export const REPORT_CATEGORIES: Record<ReportCategory, { label: string; short: string }> = {
  danger: { label: 'Someone may be in danger', short: 'Danger' },
  bullying: { label: 'Bullying or harassment', short: 'Bullying' },
  sexual: { label: 'Sexual content', short: 'Sexual content' },
  spam: { label: 'Spam or scam', short: 'Spam' },
  other: { label: 'Something else', short: 'Other' },
};
