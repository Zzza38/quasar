import { describe, expect, it } from 'vitest';
import { liveQuote, outsideRestoresFocus, quoteName, quoteOf, reactionLabel, reactionToggleLabel, swipeOffset, swipeProgress, swipeReplies, SWIPE_MAX, SWIPE_THRESHOLD } from './chat-ui';

describe('reaction names', () => {
  it('names the strip toggles by the emoji', () => {
    expect(reactionToggleLabel('❤️')).toBe('React with heart');
    expect(reactionToggleLabel('‼️')).toBe('React with exclamation');
  });
  it('reads a pill as the emoji, its count, and whether the viewer is in it', () => {
    expect(reactionLabel({ emoji: '❤️', count: 2, mine: true })).toBe('❤️ 2, you reacted');
    expect(reactionLabel({ emoji: '👍', count: 1, mine: false })).toBe('👍 1');
  });
});

describe('quotes', () => {
  it('previews the plain, censored text on one line, cut to 140 characters', () => {
    const quote = quoteOf({ seq: 4, fromMe: false, body: '**bring**  goggles\n\ntomorrow ' + 'x'.repeat(200), sender: { displayName: 'Alice' } }, 'Peer');
    expect(quote.senderName).toBe('Alice');
    expect(quote.preview?.startsWith('bring goggles tomorrow x')).toBe(true);
    expect(quote.preview).toHaveLength(140);
    expect(quote.preview).not.toContain('\n');
  });
  it('uses the chat partner name in a one-to-one chat, and no preview for a deleted target', () => {
    expect(quoteOf({ seq: 1, fromMe: false, body: null }, 'Bob')).toEqual({ seq: 1, fromMe: false, senderName: 'Bob', preview: null });
  });
  it('says You for the viewer, and Someone for a sender who no longer exists', () => {
    expect(quoteName({ seq: 1, fromMe: true, senderName: 'Me', preview: 'x' })).toBe('You');
    expect(quoteName({ seq: 1, fromMe: false, senderName: '', preview: null })).toBe('Someone');
    expect(quoteName({ seq: 1, fromMe: false, senderName: 'Cara', preview: 'x' })).toBe('Cara');
  });
});

describe('liveQuote (the composer strip and a pending bubble follow the target row)', () => {
  const snapshot = { seq: 4, fromMe: false, senderName: 'Bob', preview: 'old words' };
  const row = (seq: number, extra: Partial<{ body: string | null; deletedBy: string | null; fromMe: boolean }> = {}) => ({ seq, fromMe: false, body: `text ${seq}`, deletedBy: null, ...extra });

  it('rebuilds the quote from the live row while it is loaded', () => {
    expect(liveQuote(snapshot, [row(3), row(4, { body: 'edited words' }), row(5)], 'Bob')).toEqual({ seq: 4, fromMe: false, senderName: 'Bob', preview: 'edited words' });
  });
  it('turns a deleted or redacted target into "Message unavailable" but keeps the seq for the send', () => {
    expect(liveQuote(snapshot, [row(4, { body: null, deletedBy: 'sender' })], 'Bob')).toEqual({ seq: 4, fromMe: false, senderName: 'Bob', preview: null });
    expect(liveQuote(snapshot, [row(4, { body: null, deletedBy: 'support' })], 'Bob')).toMatchObject({ seq: 4, preview: null });
  });
  it('is unavailable when the row has gone from the loaded window, and keeps the snapshot below it', () => {
    expect(liveQuote(snapshot, [row(2), row(3), row(5)], 'Bob')).toEqual({ ...snapshot, preview: null });
    expect(liveQuote(snapshot, [row(10), row(11)], 'Bob')).toBe(snapshot);
    expect(liveQuote(snapshot, [], 'Bob')).toBe(snapshot);
  });
});

describe('outsideRestoresFocus (closing the action sheet by a press outside it)', () => {
  const inside = { closest: (selector: string) => (selector.includes('textarea') ? {} : null) };
  const plain = { closest: () => null };
  it('leaves focus where a press on something focusable put it', () => {
    expect(outsideRestoresFocus(inside)).toBe(false);
    expect(outsideRestoresFocus({ parentElement: inside })).toBe(false); // a text node inside the field
  });
  it('hands focus back to the trigger after a press on a plain surface', () => {
    expect(outsideRestoresFocus(plain)).toBe(true);
    expect(outsideRestoresFocus({ parentElement: plain })).toBe(true);
    expect(outsideRestoresFocus(null)).toBe(true);
  });
});

describe('swipe to reply', () => {
  it('waits inside the dead zone, then follows a rightward drag', () => {
    expect(swipeOffset(3, 2)).toBe('pending');
    expect(swipeOffset(20, 2)).toBe(12);
  });
  it('gives up when the finger moves mostly up or down, or to the left', () => {
    expect(swipeOffset(10, 30)).toBe('cancel');
    expect(swipeOffset(-40, 2)).toBe('cancel');
  });
  it('eases past the threshold and never passes the maximum', () => {
    expect(swipeOffset(SWIPE_THRESHOLD + 8, 0)).toBe(SWIPE_THRESHOLD);
    expect(swipeOffset(500, 0)).toBe(SWIPE_MAX);
    expect(swipeOffset(SWIPE_THRESHOLD + 8 + 30, 0)).toBe(SWIPE_THRESHOLD + 10);
  });
  it('fades the arrow in up to the threshold and replies from there', () => {
    expect(swipeProgress(0)).toBe(0);
    expect(swipeProgress(SWIPE_THRESHOLD / 2)).toBe(0.5);
    expect(swipeProgress(SWIPE_MAX)).toBe(1);
    expect(swipeReplies(SWIPE_THRESHOLD - 1)).toBe(false);
    expect(swipeReplies(SWIPE_THRESHOLD)).toBe(true);
  });
});
