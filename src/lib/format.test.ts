import { afterEach, describe, expect, it, vi } from 'vitest';
import { browserTimeZone, formatSeconds, todayIn } from './format';

afterEach(() => vi.restoreAllMocks());

describe('precise countdown', () => {
  it('shows minutes and padded seconds, adding hours only when needed', () => {
    expect(formatSeconds(503)).toBe('8:23');
    expect(formatSeconds(59)).toBe('0:59');
    expect(formatSeconds(3600 + 5 * 60 + 7)).toBe('1:05:07');
    expect(formatSeconds(-4)).toBe('0:00');
  });
});

describe('computer time zone', () => {
  it.each(['Asia/Kolkata', 'America/Los_Angeles', 'Pacific/Auckland'])('detects %s from the device', (timeZone) => {
    const options = new Intl.DateTimeFormat().resolvedOptions();
    vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockReturnValue({ ...options, timeZone });
    expect(browserTimeZone()).toBe(timeZone);
  });

  it('uses UTC if detection is unavailable', () => {
    vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockImplementation(() => { throw new Error('Unavailable'); });
    expect(browserTimeZone()).toBe('UTC');
  });

  it('uses the detected zone at a date boundary', () => {
    const options = new Intl.DateTimeFormat().resolvedOptions();
    vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockReturnValue({ ...options, timeZone: 'America/Los_Angeles' });
    expect(todayIn(browserTimeZone(), new Date('2026-09-17T01:00:00Z'))).toBe('2026-09-16');
  });
});
