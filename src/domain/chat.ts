import { z } from 'zod';
import { censorSlurs, joinsIntoSlur, slurRanges } from './chat-filter';

/**
 * Phase-4 chat rules shared by the client and the server (docs/CHAT.md §3.3, §3.6, §5).
 * Every number here is an owner-changeable default: user-facing copy and input caps derive from these
 * values (see the message helpers below), so editing CHAT is enough to change a limit.
 */
export const CHAT = {
  imageMaxBytes: 1_000_000, imageMaxDimension: 1600,
  /** An animated GIF may arrive this large; the server stores it as an animated WebP of at most imageMaxBytes, no side longer than gifMaxDimension. */
  gifMaxBytes: 3_000_000, gifMaxDimension: 480,
  /** Images one press of Send may carry (each goes out as its own message), people one message may mention, and how long a sender may edit their message. */
  imagesPerSend: 6, mentionsPerMessage: 10, editWindowMs: 15 * 60_000,
  /** Search inside one conversation: the shortest query, the longest, and how many matches come back (newest first). */
  searchMinLength: 2, searchMaxLength: 80, searchResults: 30,
  maxLength: 1000, reactionsPerMinute: 60, reactorsShown: 50, perMinute: 20, perDay: 500, newChatsPerDay: 20,
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
export function bodyError(normalized: string, hasImage = false): BodyError | null {
  if (!hasImage && !normalized.replace(ZERO_WIDTH, '').trim()) return 'Write a message first.';
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
 * ("…/wiki/Coon_Rapids") is only hidden where the link is shown, by censoredLinkParts. A second pass reads the text
 * without its markdown markers, the way the bubble shows it, so a slur split by styling ("n**igg**er",
 * "ni~~gg~~er", "nig`g`er") is censored too. A run of lines holding one word each is read as one word down the
 * bubble, so "nig\nger" is caught while "got wet\nback home" is not, and so is a word broken across a line inside
 * a sentence ("hey ni\ngga dude"; see joinsIntoSlur).
 */
export function censorBody(text: string): string {
  return censorBodyMasks(text).body;
}

/**
 * What the server stores for a message (§11): `body`, normalized and censored, which is all any member is sent, and
 * `original`, the text as sent when the filter changed it, kept for the owner (src/server/moderation.ts).
 */
export function messageText(raw: unknown): { body: string; original: string | null } {
  const sent = normalizeBody(typeof raw === 'string' ? raw : '');
  const body = censorBody(sent);
  return { body, original: body === sent ? null : sent };
}

/** One run of asterisks in a censored body: where it starts (a code point index), how long it is, and what it hid. */
export type CensorMask = { at: number; stars: number; original: string };
/** A code point of a body as it is censored: from and to are the original code points it stands for. */
type Unit = { ch: string; from: number; to: number; masked: boolean };

/**
 * censorBody, also saying what each run of asterisks hid. Every pass works on code points that remember where in the
 * original they came from, so a slur a later pass widens (one split by markdown or across lines) is still one mask.
 */
export function censorBodyMasks(text: string): { body: string; masks: CensorMask[] } {
  const points = Array.from(text);
  let offset = 0;
  const units = linkParts(text).flatMap((part) => {
    const own = Array.from(part.text).map((ch, index): Unit => ({ ch, from: offset + index, to: offset + index, masked: false }));
    offset += own.length;
    if (part.href) return own;
    const censored = censorUnits(censorUnits(own), MARKDOWN_MARKER);
    const stacked = replaceUnits(censored, STACKED_WORDS, lines => censorUnits(lines, STACKED_GAP));
    return replaceUnits(stacked, BROKEN_WORD, (pair, match) => (joinsIntoSlur(match[1]!.replace(MARKDOWN_MARKERS, ''), match[2]!.replace(MARKDOWN_MARKERS, '')) ? censorUnits(pair, STACKED_GAP) : pair));
  });
  const masks: CensorMask[] = [];
  let open: { at: number; stars: number; from: number; to: number } | null = null;
  const close = () => { if (open) masks.push({ at: open.at, stars: open.stars, original: points.slice(open.from, open.to + 1).join('') }); open = null; };
  units.forEach((unit, index) => {
    if (!unit.masked) { close(); return; }
    // Asterisks next to each other belong to one mask when what they hid overlaps.
    if (open && unit.from <= open.to) { open.stars += 1; open.to = Math.max(open.to, unit.to); return; }
    close();
    open = { at: index, stars: 1, from: unit.from, to: unit.to };
  });
  close();
  return { body: units.map(unit => unit.ch).join(''), masks };
}

/** Stands in for mask `index` in revealableText's output: private-use characters, so markdown parsing leaves them be. */
export const MASK_PATTERN = /\uE000(\d+)\uE001/g;

/**
 * The owner's view of a message that was censored (src/server/moderation.ts): the censored body with each mask swapped
 * for a MASK_PATTERN marker, ready for parseMarkdown, and the masks, so the bubble can show asterisks that reveal the
 * original on hover.
 */
export function revealableText(original: string): { text: string; masks: CensorMask[] } {
  const { body, masks } = censorBodyMasks(original);
  const points = Array.from(body);
  const out: string[] = [];
  let cursor = 0;
  masks.forEach((mask, index) => {
    out.push(...points.slice(cursor, mask.at), `\uE000${index}\uE001`);
    cursor = mask.at + mask.stars;
  });
  out.push(...points.slice(cursor));
  return { text: out.join(''), masks };
}

/** censorSlurs on code points that remember their origin; each asterisk stands for the whole original slur. */
function censorUnits(units: Unit[], ignore?: RegExp): Unit[] {
  const ranges = slurRanges(units.map(unit => unit.ch).join(''), ignore ? { ignore } : {});
  if (!ranges.length) return units;
  const out: Unit[] = [];
  let cursor = 0;
  for (const range of ranges) {
    out.push(...units.slice(cursor, range.from));
    const from = units[range.from]!.from;
    const to = Math.max(...units.slice(range.from, range.to + 1).map(unit => unit.to));
    for (let star = 0; star < range.stars; star += 1) out.push({ ch: '*', from, to, masked: true });
    cursor = range.to + 1;
  }
  out.push(...units.slice(cursor));
  return out;
}

/** String.replace with a global pattern and a callback, on code points that remember their origin. */
function replaceUnits(units: Unit[], pattern: RegExp, replace: (slice: Unit[], match: RegExpMatchArray) => Unit[]): Unit[] {
  const text = units.map(unit => unit.ch).join('');
  const at = new Map<number, number>();
  let offset = 0;
  units.forEach((unit, index) => { at.set(offset, index); offset += unit.ch.length; });
  at.set(offset, units.length);
  const out: Unit[] = [];
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    const start = at.get(match.index!);
    const end = at.get(match.index! + match[0].length);
    if (start === undefined || end === undefined) continue;
    out.push(...units.slice(cursor, start), ...replace(units.slice(start, end), match));
    cursor = end;
  }
  out.push(...units.slice(cursor));
  return out;
}
const MARKDOWN_MARKER = /[*_~`]/;
/** Two or more lines in a row that hold one word each. */
const STACKED_WORDS = /(?<![^\n])[^\S\n]*\S+[^\S\n]*(?:\n[^\S\n]*\S+[^\S\n]*)+(?![^\n])/g;
const STACKED_GAP = /[\s*_~`]/;
const MARKDOWN_MARKERS = /[*_~`]/g;
/** The last word of a line and the first word of the next. */
const BROKEN_WORD = /(?<!\S)(\S+)[^\S\n]*\n[^\S\n]*(\S+)(?!\S)/g;

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

/**
 * The reactions available in every chat, in display order. The first QUICK_REACTIONS are the strip on a message's
 * action sheet; the rest sit behind its "More reactions" button. Only append: stored reactions hold the emoji itself.
 */
export const REACTIONS = ['❤️', '👍', '👎', '😂', '‼️', '❓',
  '😮', '😢', '😭', '😡', '🔥', '🎉', '💀',
  '🙏', '👀', '💯', '🥺', '😍', '🤔', '😎',
  '👏', '🤝', '✅', '🤣', '😅', '🙄', '😬',
  '🤯', '🥳', '😴', '🤡', '💔', '🫶', '🫡'] as const;
export type Reaction = typeof REACTIONS[number];
export const QUICK_REACTIONS: readonly Reaction[] = REACTIONS.slice(0, 6);
export type MessageReaction = { emoji: Reaction; count: number; mine: boolean };
/** One person's tapback, for the list of who reacted. `me` marks the viewer, whose row reads "You". */
export type MessageReactor = { emoji: Reaction; name: string; avatar: string | null; me: boolean };
/** Someone a group or room message mentions: `name` is the display name as it was written after the "@". */
export type MessageMention = { id: string; name: string; me: boolean };
export type MessageReply = { seq: number; fromMe: boolean; senderName: string; preview: string | null };
export const chatImageSchema = z.string().max(Math.ceil(Math.max(CHAT.imageMaxBytes, CHAT.gifMaxBytes) * 4 / 3) + 4).regex(/^[A-Za-z0-9+/]+={0,2}$/).optional();
export type MessageExtras = { image?: string | null; replyTo: MessageReply | null; reactions: MessageReaction[]; reactors: MessageReactor[]; mentions: MessageMention[] };
export const mentionIdsSchema = z.array(z.uuid()).max(CHAT.mentionsPerMessage).optional();
export const searchQuerySchema = z.string().max(CHAT.searchMaxLength * 4);
/** One search match inside a conversation: enough to list it and to jump to it. */
export type SearchHit = { seq: number; fromMe: boolean; senderName: string; createdAt: string; preview: string };

/** "Messages can be edited for 15 minutes after they are sent." for the default CHAT.editWindowMs. */
export const EDIT_WINDOW_MESSAGE: `Messages can be edited for ${number} minutes after they are sent.` = `Messages can be edited for ${Math.round(CHAT.editWindowMs / 60_000)} minutes after they are sent.`;
/** Whether a message sent at `createdAt` is still inside the sender's edit window at `now` (both the app and the server ask). */
export function withinEditWindow(createdAt: string, now: Date | number): boolean {
  return new Date(now).getTime() - new Date(createdAt).getTime() <= CHAT.editWindowMs;
}

/** The "@Name" a mention is written as. */
export const mentionText = (name: string) => `@${name}`;
/**
 * Whether `body` still says "@Name" for a mention: the name must end at the end of the text or before something that
 * is not a letter or a digit, so "@Sam" is not found inside "@Samantha".
 */
export function mentionsName(body: string, name: string): boolean {
  if (!name) return false;
  const needle = mentionText(name).toLowerCase();
  const text = body.toLowerCase();
  for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + 1)) {
    const next = text.slice(at + needle.length)[Symbol.iterator]().next().value as string | undefined;
    if (next === undefined || !/[\p{L}\p{N}]/u.test(next)) return true;
  }
  return false;
}

/**
 * Splits a run of message text around the "@Name"s it mentions, longest names first so "@Sam Lee" wins over "@Sam".
 * Matching is the same as mentionsName; the text of every part is unchanged, so the parts join back into `text`.
 */
export function mentionParts<T extends { name: string }>(text: string, mentions: T[]): Array<{ text: string; mention?: T }> {
  const ordered = [...mentions].filter((mention) => mention.name).sort((left, right) => right.name.length - left.name.length);
  if (!ordered.length || !text.includes('@')) return text ? [{ text }] : [];
  const lower = text.toLowerCase();
  const parts: Array<{ text: string; mention?: T }> = [];
  let cursor = 0, at = lower.indexOf('@');
  while (at >= 0) {
    const hit = ordered.find((mention) => {
      const needle = mentionText(mention.name).toLowerCase();
      if (!lower.startsWith(needle, at)) return false;
      const next = lower.slice(at + needle.length)[Symbol.iterator]().next().value as string | undefined;
      return next === undefined || !/[\p{L}\p{N}]/u.test(next);
    });
    if (hit) {
      const end = at + mentionText(hit.name).length;
      if (at > cursor) parts.push({ text: text.slice(cursor, at) });
      parts.push({ text: text.slice(at, end), mention: hit });
      cursor = end;
      at = lower.indexOf('@', end);
    } else at = lower.indexOf('@', at + 1);
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor) });
  return parts;
}

/**
 * The "@word" being typed right before the caret, for the mention picker: its start in the text and what follows the
 * "@" so far. The "@" must open the text or follow a space, so an email address never opens the picker.
 */
export function mentionQuery(text: string, caret: number): { start: number; query: string } | null {
  const match = /(?:^|\s)@([^\s@]{0,30})$/u.exec(text.slice(0, caret));
  if (!match) return null;
  return { start: caret - match[1]!.length - 1, query: match[1]! };
}

/** A one-line excerpt of `text` around the first place `query` appears (case-insensitive), with "…" where it was cut. */
export function searchSnippet(text: string, query: string, width = 90): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const at = flat.toLowerCase().indexOf(query.toLowerCase());
  if (flat.length <= width) return flat;
  const start = Math.max(0, Math.min(flat.length - width, (at < 0 ? 0 : at) - Math.floor(width / 3)));
  return `${start > 0 ? '…' : ''}${flat.slice(start, start + width).trim()}${start + width < flat.length ? '…' : ''}`;
}
