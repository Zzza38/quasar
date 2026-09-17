import { afterEach, describe, expect, it, vi } from 'vitest';
import { browserTimeZone, todayIn } from './format';

afterEach(() => vi.restoreAllMocks());

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
