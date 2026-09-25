import { afterEach, describe, expect, it, vi } from 'vitest';
import { browserTimeZone, chatTime, classColor, formatMinutes, formatRange, formatRoom, formatSeconds, formatTime, formatTimeZone, instantParts, minutesLeft, pluralize, relativeDate, reminderLabel, slugId, todayIn } from './format';

afterEach(() => vi.restoreAllMocks());

describe('precise countdown', () => {
  it('shows minutes and padded seconds, adding hours only when needed', () => {
    expect(formatSeconds(503)).toBe('8:23');
    expect(formatSeconds(59)).toBe('0:59');
    expect(formatSeconds(3600 + 5 * 60 + 7)).toBe('1:05:07');
    expect(formatSeconds(-4)).toBe('0:00');
  });

  it('rounds the minutes left up, so a running period never reads 0 min and agrees with the seconds view', () => {
    const now = new Date('2026-09-17T12:51:37Z');
    expect(minutesLeft('2026-09-17T13:00:00Z', now)).toBe(9); // 8:23 left
    expect(minutesLeft('2026-09-17T12:52:06Z', now)).toBe(1); // 0:29 left
    expect(minutesLeft('2026-09-17T12:51:38Z', now)).toBe(1); // 0:01 left
    expect(minutesLeft('2026-09-17T12:56:37Z', now)).toBe(5); // exactly 5:00
    expect(minutesLeft('2026-09-17T12:51:37Z', now)).toBe(0);
    expect(minutesLeft('2026-09-17T12:50:00Z', now.getTime())).toBe(0);
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

describe('12-hour clock times', () => {
  it('shows midnight and noon as 12, not 0', () => {
    expect(formatTime('00:00')).toBe('12:00 AM');
    expect(formatTime('00:05')).toBe('12:05 AM');
    expect(formatTime('12:00')).toBe('12:00 PM');
    expect(formatTime('08:05')).toBe('8:05 AM');
    expect(formatTime('23:59')).toBe('11:59 PM');
  });

  it('shows the AM/PM suffix once when both ends share it, and on both ends across noon', () => {
    expect(formatRange('08:05', '09:00')).toBe('8:05–9:00 AM');
    expect(formatRange('13:10', '14:00')).toBe('1:10–2:00 PM');
    expect(formatRange('11:30', '12:10')).toBe('11:30 AM–12:10 PM');
    expect(formatRange('23:30', '00:15')).toBe('11:30 PM–12:15 AM');
  });
});

describe('relative dates and durations', () => {
  it('names the neighbouring days and formats the rest', () => {
    expect(relativeDate('2026-09-24', '2026-09-24')).toBe('Today');
    expect(relativeDate('2026-09-25', '2026-09-24')).toBe('Tomorrow');
    expect(relativeDate('2026-09-23', '2026-09-24')).toBe('Yesterday');
    expect(relativeDate('2026-09-28', '2026-09-24')).toBe('Mon, Sep 28');
    expect(relativeDate('2026-09-28', '2026-09-24', { weekday: 'long' })).toBe('Monday, Sep 28');
  });

  it('formats minutes as hours and minutes, ignoring the sign', () => {
    expect(formatMinutes(0)).toBe('0 min');
    expect(formatMinutes(59)).toBe('59 min');
    expect(formatMinutes(60)).toBe('1 h');
    expect(formatMinutes(125)).toBe('2 h 5 min');
    expect(formatMinutes(-90)).toBe('1 h 30 min');
  });

  it('pluralizes by count', () => {
    expect(pluralize(1, 'task')).toBe('1 task');
    expect(pluralize(0, 'task')).toBe('0 tasks');
    expect(pluralize(2, 'class', 'classes')).toBe('2 classes');
  });
});

describe('slug IDs', () => {
  it('never reuses a taken ID, including labels that only differ in punctuation', () => {
    expect(slugId('Math', [])).toBe('Math');
    expect(slugId('Math', ['Math'])).toBe('Math-2');
    expect(slugId('Math', ['Math', 'Math-2'])).toBe('Math-3');
    expect(slugId('Math?', ['Math'])).toBe('Math-2');
    expect(slugId('AP Bio', ['AP-Bio'])).toBe('AP-Bio-2');
  });

  it('keeps IDs to safe ASCII and falls back when a label has none', () => {
    expect(slugId('  Français 2 ', [])).toBe('Fran-ais-2');
    expect(slugId('日本語', [])).toBe('item');
    expect(slugId('日本語', ['item'])).toBe('item-2');
    expect(slugId('', [], 'period')).toBe('period');
    expect(slugId('_study', [])).toBe('item-_study');
    expect(slugId('x'.repeat(60), [])).toHaveLength(40);
  });
});

describe('reminder labels', () => {
  it('names whole days and hours the way the task editor offers them, and falls back to minutes', () => {
    expect(reminderLabel(0)).toBe('At due time');
    expect(reminderLabel(10)).toBe('10 minutes before');
    expect(reminderLabel(1)).toBe('1 minute before');
    expect(reminderLabel(60)).toBe('1 hour before');
    expect(reminderLabel(120)).toBe('2 hours before');
    expect(reminderLabel(90)).toBe('90 minutes before');
    expect(reminderLabel(1440)).toBe('1 day before');
    expect(reminderLabel(10080)).toBe('7 days before');
  });
});
