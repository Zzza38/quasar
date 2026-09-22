import type { Schedule } from '@/domain/schedule';
import { addDays, weekdayOf } from './format';

export type TemplateKind = 'same' | 'weekly' | 'ab' | 'rotation';

export const TEMPLATES: Array<{ kind: TemplateKind; title: string; description: string }> = [
  { kind: 'same', title: 'Same every day', description: 'One bell schedule that repeats each school day.' },
  { kind: 'weekly', title: 'Different by weekday', description: 'Monday through Friday each have their own schedule.' },
  { kind: 'ab', title: 'A / B days', description: 'Two alternating days that continue across weeks.' },
  { kind: 'rotation', title: 'Rotating cycle', description: 'A numbered cycle, such as Day 1 to Day 10, that keeps rotating.' },
];

const BELL = [
  ['08:00', '08:50'], ['08:55', '09:45'], ['09:50', '10:40'], ['10:45', '11:35'],
  ['11:40', '12:10'], ['12:15', '13:05'], ['13:10', '14:00'], ['14:05', '14:55'],
];

function nextWeekday(from: string, weekday: number): string {
  let date = from;
  while (weekdayOf(date) !== weekday) date = addDays(date, 1);
  return date;
}

/** Starter schedules. Every ID is generated here once; editors keep them stable afterwards. */
export function buildTemplate(kind: TemplateKind, options: { timeZone: string; today: string; cycleLength?: number }): Schedule {
  const { timeZone, today } = options;
  const classCount = 7;
  const periods: Schedule['periods'] = [];
  for (let index = 0; index < classCount; index += 1) periods.push({ id: `p${index + 1}`, label: `Period ${index + 1}`, kind: 'class' });
  periods.splice(4, 0, { id: 'lunch', label: 'Lunch', kind: 'lunch' });
  const order = periods.map((period) => period.id);
  const slotsFor = (ids: string[]) => ids.map((periodId, index) => ({ id: `s${index + 1}`, periodId, start: BELL[index][0], end: BELL[index][1] }));
  const rotate = (offset: number) => {
    const classes = order.filter((id) => id !== 'lunch');
    const shifted = [...classes.slice(offset % classes.length), ...classes.slice(0, offset % classes.length)];
    shifted.splice(4, 0, 'lunch');
    return shifted;
  };
  const anchorDate = nextWeekday(today, 1);
  const base = { version: 1 as const, timeZone, periods, anchorDate, schoolWeekdays: [1, 2, 3, 4, 5], advanceWeekdays: [1, 2, 3, 4, 5], exceptions: [] as Schedule['exceptions'] };
  switch (kind) {
    case 'same':
      return { ...base, cycleDays: [{ id: 'day', label: 'Every day', slots: slotsFor(order) }], anchorCycleDayId: 'day', advanceWeekdays: [] };
    case 'weekly':
      return {
        ...base,
        cycleDays: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'].map((label, index) => ({ id: label.toLowerCase(), label, slots: slotsFor(index === 2 ? order.slice(0, 6) : order) })),
        anchorCycleDayId: 'monday',
      };
    case 'ab':
      return {
        ...base,
        cycleDays: [{ id: 'a', label: 'A day', slots: slotsFor(rotate(0)) }, { id: 'b', label: 'B day', slots: slotsFor(rotate(4)) }],
        anchorCycleDayId: 'a',
      };
    case 'rotation': {
      const length = Math.min(60, Math.max(2, options.cycleLength ?? 10));
      return {
        ...base,
        cycleDays: Array.from({ length }, (_, index) => ({ id: `day-${index + 1}`, label: `Day ${index + 1}`, slots: slotsFor(rotate(index)) })),
        anchorCycleDayId: 'day-1',
      };
    }
  }
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
