import { describe, expect, it } from 'vitest';
import { announcementTime } from './announcement-time';

describe('scheduled announcement times', () => {
  const zone = 'America/New_York';
  const now = Date.parse('2026-11-01T00:00:00Z');

  it('resolves a repeated minute to the exact offset shown to the publisher', () => {
    expect(announcementTime('2026-11-01T01:30', zone, now)).toEqual({
      error: '', instant: '2026-11-01T05:30:00.000Z', offset: '-04:00',
    });
  });

  it('rejects a skipped local minute', () => {
    expect(announcementTime('2027-03-14T02:30', zone, now)).toMatchObject({ instant: null, error: expect.stringContaining('skip') });
  });

  it('requires a future minute and honors fractional-hour offsets', () => {
    expect(announcementTime('2026-11-01T05:45', 'Asia/Kathmandu', now).instant).toBeNull();
    expect(announcementTime('2026-11-01T05:46', 'Asia/Kathmandu', now).instant).toBe('2026-11-01T00:01:00.000Z');
  });
});
