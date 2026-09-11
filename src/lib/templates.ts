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
