import { Temporal } from '@js-temporal/polyfill';

/** YYYY-MM-DD for the given instant in a specific IANA time zone. */
export function todayIn(timeZone: string, now: Date = new Date()): string {
  return Temporal.Instant.from(now.toISOString()).toZonedDateTimeISO(timeZone).toPlainDate().toString();
}

export function addDays(date: string, days: number): string {
  return Temporal.PlainDate.from(date).add({ days }).toString();
}

/** ISO weekday (Monday=1 … Sunday=7). */
export function weekdayOf(date: string): number {
  return Temporal.PlainDate.from(date).dayOfWeek;
}

/** Monday through Sunday containing the date. */
export function weekOf(date: string): string[] {
  const start = Temporal.PlainDate.from(date).subtract({ days: weekdayOf(date) - 1 });
  return Array.from({ length: 7 }, (_, index) => start.add({ days: index }).toString());
}

export function daysBetween(from: string, to: string): number {
  return Temporal.PlainDate.from(from).until(Temporal.PlainDate.from(to)).days;
}

/** "8:05 AM" from "08:05". */
export function formatTime(time: string): string {
  const [hours, minutes] = time.split(':').map(Number);
  const suffix = hours >= 12 ? 'PM' : 'AM';
  const hour = hours % 12 === 0 ? 12 : hours % 12;
  return `${hour}:${String(minutes).padStart(2, '0')} ${suffix}`;
}

/** "8:05–9:00 AM" style range; the suffix is shown once when both sides share it. */
export function formatRange(start: string, end: string): string {
  const left = formatTime(start);
  const right = formatTime(end);
  const leftSuffix = left.slice(-2);
  return leftSuffix === right.slice(-2) ? `${left.slice(0, -3)}–${right}` : `${left}–${right}`;
}

export function formatDate(date: string, options: { weekday?: 'short' | 'long'; year?: boolean } = {}): string {
  return Temporal.PlainDate.from(date).toLocaleString('en-US', {
    ...(options.weekday ? { weekday: options.weekday } : {}),
    month: 'short',
    day: 'numeric',
    ...(options.year ? { year: 'numeric' } : {}),
  });
}

export function formatDateTime(date: string, time: string | null): string {
  return time ? `${formatDate(date, { weekday: 'short' })} · ${formatTime(time)}` : formatDate(date, { weekday: 'short' });
}

/** Today / Tomorrow / Yesterday, else a formatted date. */
export function relativeDate(date: string, today: string, options: { weekday?: 'short' | 'long' } = { weekday: 'short' }): string {
  const delta = daysBetween(today, date);
  if (delta === 0) return 'Today';
  if (delta === 1) return 'Tomorrow';
  if (delta === -1) return 'Yesterday';
  return formatDate(date, options);
}

/**
 * The local date ("YYYY-MM-DD") and 24-hour time ("HH:MM") of an instant in a time zone. Pass the
 * pieces to formatDate / formatTime / relativeDate; never round-trip them through `new Date(date)`.
 */
export function instantParts(iso: string, timeZone: string): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    .formatToParts(new Date(iso));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((entry) => entry.type === type)?.value ?? '00';
  return { date: `${part('year')}-${part('month')}-${part('day')}`, time: `${part('hour')}:${part('minute')}` };
}

/**
 * Chat list time: "now", "5m", "4:12 PM" earlier today, "Yesterday", "Mon" within the last 6 days,
 * otherwise "Sep 3". Days are counted in the student's time zone.
 */
export function chatTime(iso: string, timeZone: string, now: Date): string {
  const elapsed = now.getTime() - new Date(iso).getTime();
  if (elapsed < 60_000) return 'now'; // Includes small clock differences that put the message in the future.
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m`;
  const { date, time } = instantParts(iso, timeZone);
  const days = daysBetween(date, todayIn(timeZone, now));
  if (days <= 0) return formatTime(time);
  if (days === 1) return 'Yesterday';
  if (days <= 6) return WEEKDAYS[weekdayOf(date) - 1].short;
  return formatDate(date);
}

export function minutesUntil(instant: string, now: Date): number {
  return Math.round((new Date(instant).getTime() - now.getTime()) / 60_000);
}

/**
 * Whole minutes left on a countdown, rounded up so the time left is never understated: 8:23 left is
 * "9 min", and any time left under a minute is 1, never 0. Already reached or past is 0.
 */
export function minutesLeft(instant: string, now: Date | number): number {
  const ms = new Date(instant).getTime() - (typeof now === 'number' ? now : now.getTime());
  return ms > 0 ? Math.ceil(ms / 60_000) : 0;
}

export function formatMinutes(minutes: number): string {
  const total = Math.max(0, Math.abs(minutes));
  if (total < 60) return `${total} min`;
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

/** "8:05" or "1:08:05" from a number of seconds; the precise companion to formatMinutes. */
export function formatSeconds(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = String(total % 60).padStart(2, '0');
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}` : `${minutes}:${rest}`;
}

/** Deterministic pastel palette entry for a class. */
const PALETTE = [
  { dot: '#4f46e5', soft: 'rgb(79 70 229 / .13)' },
  { dot: '#0891b2', soft: 'rgb(8 145 178 / .14)' },
  { dot: '#059669', soft: 'rgb(5 150 105 / .14)' },
  { dot: '#d97706', soft: 'rgb(217 119 6 / .15)' },
  { dot: '#db2777', soft: 'rgb(219 39 119 / .13)' },
  { dot: '#7c3aed', soft: 'rgb(124 58 237 / .13)' },
  { dot: '#dc2626', soft: 'rgb(220 38 38 / .12)' },
  { dot: '#65a30d', soft: 'rgb(101 163 13 / .15)' },
  { dot: '#0284c7', soft: 'rgb(2 132 199 / .13)' },
  { dot: '#c2410c', soft: 'rgb(194 65 12 / .13)' },
];
export function classColor(id: string | undefined, kind: 'class' | 'lunch' | 'other' = 'class', color?: string): { dot: string; soft: string } {
  if (color && /^#[0-9a-fA-F]{6}$/.test(color)) return { dot: color, soft: `color-mix(in srgb, ${color} 14%, transparent)` };
  // Neutral stone, outside PALETTE, so lunch never matches the amber and orange classes beside it.
  if (kind === 'lunch') return { dot: '#78716c', soft: 'rgb(120 113 108 / .14)' };
  if (!id) return { dot: 'var(--muted-foreground)', soft: 'var(--secondary)' };
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return PALETTE[hash % PALETTE.length];
}

const ROOM_WORD = /^(room|rm\.?)\s/i;
const ROOM_CODE = /^[A-Z]{0,2}[-\s]?\d+(?:[-.]\d+)?[A-Z]?$/i;
/**
 * "Room 204" for bare numbers and codes (204, B12, 204A, S-110); anything that already names the
 * room ("Lab 3", "Art Room", "Gym", "Room 12") is shown as typed.
 */
export function formatRoom(room: string): string {
  const value = room.trim();
  if (!value || ROOM_WORD.test(value)) return value;
  return ROOM_CODE.test(value) ? `Room ${value}` : value;
}

/** "Eastern Time" for "America/New_York"; the ID itself if the runtime cannot name the zone. */
export function formatTimeZone(id: string): string {
  try {
    const name = new Intl.DateTimeFormat('en-US', { timeZone: id, timeZoneName: 'longGeneric' })
      .formatToParts(new Date())
      .find((part) => part.type === 'timeZoneName')?.value;
    return name || id;
  } catch {
    return id;
  }
}

const ID_PATTERN = /[^A-Za-z0-9_-]+/g;
/** Stable ID from a label; guaranteed unique among `taken`. Generated once and kept afterwards. */
export function slugId(label: string, taken: Iterable<string>, fallback = 'item'): string {
  const used = new Set(taken);
  let base = label.trim().replace(ID_PATTERN, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  if (!base || !/^[A-Za-z0-9]/.test(base)) base = `${fallback}${base ? `-${base}` : ''}`;
  let candidate = base;
  let counter = 2;
  while (used.has(candidate)) candidate = `${base}-${counter++}`;
  return candidate;
}

export function randomId(): string {
  return crypto.randomUUID().replaceAll('-', '').slice(0, 12);
}

export const WEEKDAYS = [
  { value: 1, short: 'Mon', long: 'Monday' },
  { value: 2, short: 'Tue', long: 'Tuesday' },
  { value: 3, short: 'Wed', long: 'Wednesday' },
  { value: 4, short: 'Thu', long: 'Thursday' },
  { value: 5, short: 'Fri', long: 'Friday' },
  { value: 6, short: 'Sat', long: 'Saturday' },
  { value: 7, short: 'Sun', long: 'Sunday' },
] as const;

export function timeZones(): string[] {
  try {
    const supported = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.('timeZone');
    if (supported?.length) return supported;
  } catch { /* Older browsers */ }
  return ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Phoenix', 'America/Los_Angeles', 'America/Anchorage', 'Pacific/Honolulu', 'UTC'];
}

export function browserTimeZone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
}

export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

/**
 * How a task reminder's lead time reads everywhere it is shown: the task editor's choices ("1 hour before",
 * "1 day before") and the conflict tables, so both describe the same saved value the same way.
 */
export function reminderLabel(minutesBefore: number): string {
  if (minutesBefore === 0) return 'At due time';
  if (minutesBefore % 1440 === 0) return `${pluralize(minutesBefore / 1440, 'day')} before`;
  if (minutesBefore % 60 === 0) return `${pluralize(minutesBefore / 60, 'hour')} before`;
  return `${pluralize(minutesBefore, 'minute')} before`;
}
