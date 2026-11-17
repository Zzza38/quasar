import { describe, expect, it } from 'vitest';
import { nextCycleDates, skippedCycleDates } from './cycle-dates';
import { exampleSchedule } from './example';
import { emptyPersonalSchedule, resolveDay, type Schedule } from './schedule';

const personal = emptyPersonalSchedule();
const label = (schedule: Schedule, id: string) => schedule.cycleDays.find((day) => day.id === id)!.label;
/** The example rotation with only the given exceptions. */
const withExceptions = (exceptions: Schedule['exceptions']): Schedule => ({ ...exampleSchedule, exceptions });

describe('nextCycleDates and skippedCycleDates', () => {
  // Tuesday 2026-11-10; the Wednesday after it is the day off.
  const today = '2026-11-10';
  const off = '2026-11-11';
  const plain = withExceptions([]);
  const wednesdays = resolveDay(plain, off, personal).cycleDayId;

  it('finds each cycle day once, and nothing is skipped in a plain run of school days', () => {
    const next = nextCycleDates(plain, personal, today, plain.cycleDays.length);
    expect(next.size).toBe(plain.cycleDays.length);
    expect(next.get(resolveDay(plain, today, personal).cycleDayId)).toBe(today);
    expect(next.get(wednesdays)).toBe(off);
    expect(skippedCycleDates(plain, personal, today, next).size).toBe(0);
  });

  it('a closure that advances the rotation uses up its cycle day, which then meets a full cycle later', () => {
    const schedule = withExceptions([{ date: off, kind: 'closure', advanceCycle: true }]);
    const next = nextCycleDates(schedule, personal, today, schedule.cycleDays.length);
    // Ten school days after the day off, not the next morning.
    expect(next.get(wednesdays)).toBe('2026-11-25');
    expect(next.get(resolveDay(schedule, '2026-11-12', personal).cycleDayId)).toBe('2026-11-12');
    const skipped = skippedCycleDates(schedule, personal, today, next);
    expect([...skipped].map(([id, date]) => [label(schedule, id), date])).toEqual([[label(schedule, wednesdays), off]]);
  });

  it('a closure that holds the rotation only delays its cycle day by one school day, which is not a skip', () => {
    const schedule = withExceptions([{ date: off, kind: 'closure', advanceCycle: false }]);
    const next = nextCycleDates(schedule, personal, today, schedule.cycleDays.length);
    expect(next.get(wednesdays)).toBe('2026-11-12');
    expect(skippedCycleDates(schedule, personal, today, next).size).toBe(0);
  });

  it('counts a day off today, and never a weekend', () => {
    const schedule = withExceptions([{ date: today, kind: 'closure', advanceCycle: true }]);
    const next = nextCycleDates(schedule, personal, today, schedule.cycleDays.length);
    const skipped = skippedCycleDates(schedule, personal, today, next);
    expect([...skipped.values()]).toEqual([today]);
    // From Friday, the weekend passes with nothing skipped.
    const friday = nextCycleDates(plain, personal, '2026-11-13', plain.cycleDays.length);
    expect(skippedCycleDates(plain, personal, '2026-11-13', friday).size).toBe(0);
  });
});
