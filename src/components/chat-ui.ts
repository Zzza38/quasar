/**
 * Pure helpers for the Messages view's replies and reactions (docs/CHAT.md §15): accessible names for tapbacks,
 * the quote shown for a reply, and the maths behind swipe-to-reply. Kept free of React so they can be unit tested.
 */

import { type MessageReaction, type MessageReply, type Reaction } from '@/domain/chat';
import { censorSlurs } from '@/domain/chat-filter';
import { plainText } from '@/domain/markdown';

/** Spoken names for the tapbacks, in the order of REACTIONS. */
export const REACTION_NAMES: Record<Reaction, string> = { '❤️': 'heart', '👍': 'thumbs up', '👎': 'thumbs down', '😂': 'laugh', '‼️': 'exclamation', '❓': 'question' };

/** The reaction strip's toggle: "React with heart". */
export function reactionToggleLabel(emoji: Reaction): string {
  return `React with ${REACTION_NAMES[emoji]}`;
}

/** A pill under a bubble: "❤️ 2, you reacted" or "👍 1". */
export function reactionLabel(reaction: MessageReaction): string {
  return `${reaction.emoji} ${reaction.count}${reaction.mine ? ', you reacted' : ''}`;
}

/** The quote the composer and bubbles show for a reply target: its sender's name and a one-line preview. */
export function quoteOf(message: { seq: number; fromMe: boolean; body: string | null; image?: string | null; sender?: { displayName: string } }, peerName: string): MessageReply {
  const preview = message.body === null ? null : censorSlurs(plainText(message.body)).replace(/\s+/g, ' ').trim().slice(0, 140) || (message.image ? 'Photo' : '');
  return { seq: message.seq, fromMe: message.fromMe, senderName: message.sender?.displayName ?? peerName, preview };
}

/** "You" for the viewer's own message; the sender's name otherwise (a hard-deleted sender has none). */
export function quoteName(reply: MessageReply): string {
  return reply.fromMe ? 'You' : reply.senderName || 'Someone';
}

type QuotableRow = { seq: number; fromMe: boolean; body: string | null; deletedBy: string | null; image?: string | null; sender?: { displayName: string } };

/**
 * The quote the composer's strip and a pending bubble show for a reply target right now. `reply` is the snapshot
 * taken when Reply was pressed; it only decides the seq. While the target sits inside the loaded window the quote
 * is rebuilt from its live row, so a deletion or a support redaction that the poll has since shown turns the text
 * into "Message unavailable" (a null preview) instead of leaving the old words on screen; a row that has gone from
 * the window altogether (its sender was blocked, so a full page left it out) is unavailable too. Older than the
 * loaded window, the snapshot stands in: nothing newer is known.
 */
export function liveQuote(reply: MessageReply, messages: QuotableRow[], peerName: string): MessageReply {
  const first = messages[0];
  if (!first || reply.seq < first.seq) return reply;
  const row = messages.find((message) => message.seq === reply.seq);
  if (!row) return { ...reply, preview: null };
  const quote = quoteOf(row, peerName);
  return row.deletedBy !== null ? { ...quote, preview: null } : quote;
}

/** Anything a pointer can land on that takes focus by itself: links, enabled form controls, tabbable or editable nodes. */
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable]:not([contenteditable="false"])';

/**
 * Whether closing a message's action sheet because of a pointer-down outside it should hand focus back to the
 * sheet's "Message actions" button. A press on something focusable (the composer's field, another bubble's button,
 * a link) is the user putting focus there, and pulling it back would close the phone keyboard they just opened; a
 * press on a plain surface (a bubble, the log's background) leaves focus to the sheet, so it returns to the trigger.
 * Text nodes are judged by their parent element.
 */
export function outsideRestoresFocus(target: { closest?: (selector: string) => unknown; parentElement?: { closest: (selector: string) => unknown } | null } | null | undefined): boolean {
  if (!target) return true;
  const element = typeof target.closest === 'function' ? target : target.parentElement;
  return !element?.closest?.(FOCUSABLE);
}

/** How far a touch has to drag a bubble to the right to reply, how far it can travel, and the dead zone before a drag counts. */
export const SWIPE_THRESHOLD = 56;
export const SWIPE_MAX = 72;
export const SWIPE_SLOP = 8;

/**
 * What a touch drag of (dx, dy) from its start means for swipe-to-reply: 'pending' inside the dead zone, 'cancel'
 * once vertical movement dominates or the drag goes left (the scroller or the long press owns it), otherwise the
 * bubble's offset, which eases past the threshold up to SWIPE_MAX.
 */
export function swipeOffset(dx: number, dy: number): 'pending' | 'cancel' | number {
  if (Math.abs(dx) < SWIPE_SLOP && Math.abs(dy) < SWIPE_SLOP) return 'pending';
  if (Math.abs(dy) > Math.abs(dx) || dx < 0) return 'cancel';
  const travel = dx - SWIPE_SLOP;
  return travel <= SWIPE_THRESHOLD ? travel : Math.min(SWIPE_MAX, SWIPE_THRESHOLD + (travel - SWIPE_THRESHOLD) / 3);
}

/** The reply arrow's opacity while dragging, 0 to 1 at the threshold. */
export function swipeProgress(offset: number): number {
  return Math.min(1, Math.max(0, offset / SWIPE_THRESHOLD));
}

/** A released drag at or past the threshold replies. */
export function swipeReplies(offset: number): boolean {
  return offset >= SWIPE_THRESHOLD;
}

/** localStorage counter for the formatting hint, and how many openings show it. Only a number is stored (D5). */
export const FORMAT_HINT_KEY = 'quasar-format-hint';
export const FORMAT_HINT_TIMES = 3;

const MIRROR_STYLES = ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'letterSpacing', 'lineHeight', 'textTransform', 'paddingTop', 'paddingLeft', 'paddingRight', 'paddingBottom', 'borderLeftWidth', 'borderTopWidth', 'borderRightWidth', 'boxSizing', 'wordBreak', 'overflowWrap', 'tabSize'] as const;

/**
 * Where a textarea's selected text sits, in pixels from the field's top-left, by laying the same text out in a hidden
 * mirror and measuring a span around the selection (textareas expose no range geometry). Null without a selection.
 */
export function selectionRect(field: HTMLTextAreaElement, doc: Document = document): { left: number; top: number; width: number } | null {
  const start = field.selectionStart, end = field.selectionEnd;
  if (start === end) return null;
  const mirror = doc.createElement('div');
  const style = getComputedStyle(field);
  for (const property of MIRROR_STYLES) mirror.style[property] = style[property];
  Object.assign(mirror.style, { position: 'absolute', left: '-9999px', top: '0', visibility: 'hidden', whiteSpace: 'pre-wrap', width: `${field.offsetWidth}px`, height: 'auto', overflow: 'hidden', pointerEvents: 'none' });
  mirror.textContent = field.value.slice(0, start);
  const span = doc.createElement('span');
  span.textContent = field.value.slice(start, end) || '.';
  mirror.appendChild(span);
  doc.body.appendChild(mirror);
  const rect = { left: span.offsetLeft, top: span.offsetTop - field.scrollTop, width: span.offsetWidth };
  mirror.remove();
  return rect;
}
