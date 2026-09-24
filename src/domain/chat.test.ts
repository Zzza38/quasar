import { describe, expect, it } from 'vitest';
import { CHAT, bodyError, linkParts, normalizeBody, rawBodySchema, REPORT_CATEGORIES, reportCategorySchema } from './chat';

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
