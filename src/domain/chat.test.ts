import { describe, expect, it } from 'vitest';
import { type BodyError, CHAT, COMPOSER_MAX_LENGTH, bodyError, censorBody, censoredLinkParts, linkParts, normalizeBody, rawBodySchema, REPORT_CATEGORIES, reportCategorySchema, TOO_LONG_MESSAGE, TOO_MANY_NEW_CHATS_MESSAGE } from './chat';

describe('normalizeBody', () => {
  it('converts to NFC and normalizes line endings', () => {
    expect(normalizeBody('Café')).toBe('Café');
    expect(normalizeBody('a\r\nb\rc')).toBe('a\nb\nc');
  });
  it('strips control and bidi characters but keeps newlines and tabs', () => {
    expect(normalizeBody('a\u0000b\u0007c\u009Fd\te\nf')).toBe('abcd\te\nf');
    expect(normalizeBody('‮evil‬ ⁦x⁩ ‎y‏')).toBe('evil x y');
  });
  it('collapses three or more newlines to two and trims', () => {
    expect(normalizeBody('  a\n\n\n\nb \n')).toBe('a\n\nb');
    expect(normalizeBody('a\r\n\r\n\r\nb')).toBe('a\n\nb');
  });
});

describe('bodyError', () => {
  it('rejects empty, whitespace-only and zero-width-only bodies', () => {
    expect(bodyError(normalizeBody(''))).toBe('Write a message first.');
    expect(bodyError(normalizeBody(' \n\t '))).toBe('Write a message first.');
    expect(bodyError(normalizeBody('​‌‍⁠﻿'))).toBe('Write a message first.');
    expect(bodyError(normalizeBody('‮'))).toBe('Write a message first.');
  });
  it('allows up to 1,000 characters', () => {
    expect(bodyError('x'.repeat(CHAT.maxLength))).toBeNull();
    expect(bodyError('x'.repeat(CHAT.maxLength + 1))).toBe('Messages can be up to 1,000 characters.');
    expect(bodyError('hi')).toBeNull();
  });
});

describe('limit copy derived from CHAT', () => {
  it('states the default limits in the fixed wording', () => {
    expect(TOO_LONG_MESSAGE).toBe('Messages can be up to 1,000 characters.');
    expect(TOO_MANY_NEW_CHATS_MESSAGE).toBe('You started 20 new chats today. Try again tomorrow.');
  });
  it('keeps BodyError a fixed-shape union, not any string (checked by tsc)', () => {
    // @ts-expect-error arbitrary text, such as echoed input, is not a BodyError
    const echoed: BodyError = 'anything goes';
    const tooLong: BodyError = 'Messages can be up to 2,000 characters.';
    expect([echoed, tooLong]).toHaveLength(2);
  });
  it('caps the composer above CHAT.maxLength but within the zod body limit', () => {
    expect(COMPOSER_MAX_LENGTH).toBeGreaterThan(CHAT.maxLength);
    expect(rawBodySchema.safeParse('x'.repeat(COMPOSER_MAX_LENGTH)).success).toBe(true);
  });
});

describe('linkParts', () => {
  it('links https URLs and strips trailing punctuation', () => {
    expect(linkParts('See https://docs.google.com/d/1, then (https://example.org/a).')).toEqual([
      { text: 'See ' }, { text: 'https://docs.google.com/d/1', href: 'https://docs.google.com/d/1' },
      { text: ', then (' }, { text: 'https://example.org/a', href: 'https://example.org/a' }, { text: ').' },
    ]);
  });
  it('keeps other schemes and credentialed URLs as plain text', () => {
    expect(linkParts('http://example.org javascript:alert(1) data:text/html,x')).toEqual([{ text: 'http://example.org javascript:alert(1) data:text/html,x' }]);
    expect(linkParts('go https://user:pass@example.org now')).toEqual([{ text: 'go https://user:pass@example.org now' }]);
    expect(linkParts('https://')).toEqual([{ text: 'https://' }]);
  });
  it('stops at whitespace, angle brackets and quotes', () => {
    expect(linkParts('<https://a.example/x>"')).toEqual([{ text: '<' }, { text: 'https://a.example/x', href: 'https://a.example/x' }, { text: '>"' }]);
    expect(linkParts('')).toEqual([]);
  });
});

describe('schemas', () => {
  it('limits the raw body to 4000 characters and lists five report categories', () => {
    expect(rawBodySchema.safeParse('x'.repeat(4000)).success).toBe(true);
    expect(rawBodySchema.safeParse('x'.repeat(4001)).success).toBe(false);
    expect(reportCategorySchema.options).toEqual(['danger', 'bullying', 'sexual', 'spam', 'other']);
    expect(REPORT_CATEGORIES.danger.label).toBe('Someone may be in danger');
    expect(REPORT_CATEGORIES.bullying.label).toBe('Bullying or harassment');
  });
});

describe('censorBody and censoredLinkParts', () => {
  const wiki = 'https://en.wikipedia.org/wiki/Coon_Rapids,_Minnesota';
  it('stores links whole and censors the text around them', () => {
    expect(censorBody(`you f4ggot, read ${wiki}.`)).toBe(`you ******, read ${wiki}.`);
    expect(censorBody('https://example.com/w0p/ and http://example.com/w0p/')).toBe('https://example.com/w0p/ and http://example.com/***/');
    expect(censorBody('')).toBe('');
  });
  it('is stable when the censored text is censored again (a retry sends the censored body)', () => {
    const once = censorBody(`you f4ggot ${wiki}`);
    expect(censorBody(once)).toBe(once);
  });
  it('shows a link with its slur-shaped segment censored while the href keeps the real address', () => {
    expect(censoredLinkParts(`see ${wiki} retard`)).toEqual([
      { text: 'see ' }, { text: 'https://en.wikipedia.org/wiki/****_Rapids,_Minnesota', href: wiki }, { text: ' ******' },
    ]);
  });
});
