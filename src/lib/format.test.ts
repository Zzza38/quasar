import { afterEach, describe, expect, it, vi } from 'vitest';
import { browserTimeZone, chatTime, classColor, formatRoom, formatSeconds, formatTimeZone, instantParts, todayIn } from './format';

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

describe('instant parts', () => {
  it('splits an instant into the local date and 24-hour time of a zone', () => {
    expect(instantParts('2026-09-24T20:12:00Z', 'America/New_York')).toEqual({ date: '2026-09-24', time: '16:12' });
    expect(instantParts('2026-09-25T02:30:00Z', 'America/Los_Angeles')).toEqual({ date: '2026-09-24', time: '19:30' });
    expect(instantParts('2026-09-24T20:12:00Z', 'Asia/Kolkata')).toEqual({ date: '2026-09-25', time: '01:42' });
  });
  it('uses 00 for midnight, never 24', () => {
    expect(instantParts('2026-09-24T04:00:30Z', 'America/New_York')).toEqual({ date: '2026-09-24', time: '00:00' });
  });
});

describe('chat list times', () => {
  const zone = 'America/New_York';
  const now = new Date('2026-09-24T20:12:00Z'); // Thursday 4:12 PM in New York
  const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();
  it('shows "now" under a minute, also for a timestamp slightly in the future', () => {
    expect(chatTime(ago(10_000), zone, now)).toBe('now');
    expect(chatTime(ago(-5_000), zone, now)).toBe('now');
  });
  it('shows minutes under an hour', () => {
    expect(chatTime(ago(60_000), zone, now)).toBe('1m');
    expect(chatTime(ago(59 * 60_000), zone, now)).toBe('59m');
  });
  it('shows the clock time earlier today', () => {
    expect(chatTime('2026-09-24T13:05:00Z', zone, now)).toBe('9:05 AM');
  });
  it('counts days in the student\'s zone, not UTC', () => {
    // 11:30 PM Wednesday in New York is already Thursday in UTC.
    expect(chatTime('2026-09-24T03:30:00Z', zone, now)).toBe('Yesterday');
    // 00:30 AM Thursday in New York is still Wednesday in Los Angeles.
    expect(chatTime('2026-09-24T04:30:00Z', 'America/Los_Angeles', now)).toBe('Yesterday');
  });
  it('shows the weekday within 6 days and the date after that', () => {
    expect(chatTime('2026-09-22T15:00:00Z', zone, now)).toBe('Tue');
    expect(chatTime('2026-09-18T15:00:00Z', zone, now)).toBe('Fri');
    expect(chatTime('2026-09-17T15:00:00Z', zone, now)).toBe('Sep 17');
    expect(chatTime('2026-09-03T15:00:00Z', zone, now)).toBe('Sep 3');
  });
});
