import { afterEach, describe, expect, it, vi } from 'vitest';
import { browserTimeZone, classColor, formatRoom, formatSeconds, formatTimeZone, todayIn } from './format';

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

describe('room labels', () => {
  it.each([['204', 'Room 204'], ['B12', 'Room B12'], ['204A', 'Room 204A'], ['S-110', 'Room S-110'], ['E 12', 'Room E 12'], ['  305 ', 'Room 305']])('adds "Room" to the bare code %s', (room, label) => {
    expect(formatRoom(room)).toBe(label);
  });
  it.each(['Lab 3', 'Art Room', 'Gym', 'Library', 'Room 12', 'room 4B', 'Rm 12', 'My room', 'Portable 2'])('leaves %s as typed', (room) => {
    expect(formatRoom(room)).toBe(room);
  });
  it('returns an empty string for a blank room', () => {
    expect(formatRoom('   ')).toBe('');
  });
});

describe('time zone names', () => {
  it('names zones the way people say them', () => {
    expect(formatTimeZone('America/New_York')).toBe('Eastern Time');
    expect(formatTimeZone('America/Los_Angeles')).toBe('Pacific Time');
  });
  it('falls back to the ID when the zone is unknown', () => {
    expect(formatTimeZone('Not/AZone')).toBe('Not/AZone');
  });
});

describe('lunch colour', () => {
  it('is a neutral stone that no class can hash to', () => {
    const lunch = classColor('lunch', 'lunch');
    expect(lunch.dot).toBe('#78716c');
    const classes = new Set(Array.from({ length: 200 }, (_, index) => classColor(`class-${index}`).dot));
    expect(classes.has(lunch.dot)).toBe(false);
  });
});
