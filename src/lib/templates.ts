import type { Schedule } from '@/domain/schedule';
import { addDays, weekdayOf } from './format';

export type TemplateKind = 'same' | 'weekly' | 'ab' | 'rotation';

export const TEMPLATES: Array<{ kind: TemplateKind; title: string; description: string }> = [
  { kind: 'same', title: 'Same every day', description: 'One bell schedule that repeats each school day.' },
  { kind: 'weekly', title: 'Different by weekday', description: 'Monday through Friday each have their own schedule.' },
  { kind: 'ab', title: 'A / B days', description: 'Two alternating days that continue across weeks.' },
  { kind: 'rotation', title: 'Rotating cycle', description: 'A numbered cycle, such as Day 1 to Day 10, that keeps rotating.' },
];

function nextWeekday(from: string, weekday: number): string {
  let date = from;
  while (weekdayOf(date) !== weekday) date = addDays(date, 1);
  return date;
}

/* ---------- Guided school setup ---------- */

/** Rotation days for a template kind, before any times are entered. */
export function starterDays(kind: TemplateKind, cycleLength = 10): Array<{ id: string; label: string }> {
  switch (kind) {
    case 'same': return [{ id: 'day', label: 'Every day' }];
    case 'weekly': return ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'].map((label) => ({ id: label.toLowerCase(), label }));
    case 'ab': return [{ id: 'a', label: 'A day' }, { id: 'b', label: 'B day' }];
    case 'rotation': {
      const length = Math.min(60, Math.max(2, cycleLength));
      return Array.from({ length }, (_, index) => ({ id: `day-${index + 1}`, label: `Day ${index + 1}` }));
    }
  }
}

/** The default period list for a new school: seven classes with lunch after the fourth. */
export function starterPeriods(): Schedule['periods'] {
  const periods: Schedule['periods'] = [];
  for (let index = 0; index < 7; index += 1) periods.push({ id: `p${index + 1}`, label: `Period ${index + 1}`, kind: 'class' });
  periods.splice(4, 0, { id: 'lunch', label: 'Lunch', kind: 'lunch' });
  return periods;
}

/**
 * One slot per period with no times. Times are deliberately left blank so a new school
 * cannot be created with example bell times that every schoolmate would then inherit.
 * Existing times are kept for periods that are still present.
 */
export function typicalDaySlots(periods: Schedule['periods'], previous: Schedule['cycleDays'][number]['slots'] = []): Schedule['cycleDays'][number]['slots'] {
  return periods.map((period, index) => {
    const kept = previous.find((slot) => slot.periodId === period.id);
    return { id: `s${index + 1}`, periodId: period.id, start: kept?.start ?? '', end: kept?.end ?? '' };
  });
}

/** Every rotation day gets a copy of the typical day, in the same order with the same times. */
export function applyTypicalDay(schedule: Schedule, typical: Schedule['cycleDays'][number]['slots']): Schedule {
  return { ...schedule, cycleDays: schedule.cycleDays.map((day) => ({ ...day, slots: typical.map((slot) => ({ ...slot })) })) };
}

/** The first school weekday on or after `today`, so the "what day is it?" question defaults to a real school day. */
export function nextSchoolDay(today: string, schoolWeekdays: number[]): string {
  let date = today;
  for (let step = 0; step < 14 && !schoolWeekdays.includes(weekdayOf(date)); step += 1) date = addDays(date, 1);
  return date;
}

/** The next `count` school days from `today` (inclusive), skipping days the school does not meet. */
export function upcomingSchoolDays(today: string, schoolWeekdays: number[], count: number): string[] {
  const days: string[] = [];
  let date = nextSchoolDay(today, schoolWeekdays);
  while (days.length < count && schoolWeekdays.includes(weekdayOf(date))) {
    days.push(date);
    date = nextSchoolDay(addDays(date, 1), schoolWeekdays);
  }
  return days;
}

/** Guided setup allows 2 to 60 days in a rotation. */
export const CYCLE_LENGTH_MIN = 2;
export const CYCLE_LENGTH_MAX = 60;

/** Reads the typed "days in the cycle" text, or null while it is empty, partial or out of range. */
export function parseCycleLength(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d{1,3}$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return value >= CYCLE_LENGTH_MIN && value <= CYCLE_LENGTH_MAX ? value : null;
}

/** A schedule skeleton for the guided setup. Days start empty; `applyTypicalDay` fills them. */
export function buildStarter(kind: TemplateKind, options: { timeZone: string; today: string; cycleLength?: number; periods?: Schedule['periods'] }): Schedule {
  const { timeZone, today } = options;
  const periods = options.periods ?? starterPeriods();
  const cycleDays = starterDays(kind, options.cycleLength).map((day) => ({ ...day, slots: [] as Schedule['cycleDays'][number]['slots'] }));
  const schoolWeekdays = [1, 2, 3, 4, 5];
  return {
    version: 1, timeZone, periods, cycleDays,
    anchorDate: kind === 'weekly' ? nextWeekday(today, 1) : nextSchoolDay(today, schoolWeekdays),
    anchorCycleDayId: cycleDays[0].id,
    schoolWeekdays, advanceWeekdays: kind === 'same' ? [] : schoolWeekdays, exceptions: [],
  };
}
