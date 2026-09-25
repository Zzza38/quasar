import { describe, expect, it } from 'vitest';
import { scheduleSchema } from '@/domain/schedule';
import { applyTypicalDay, buildStarter, nextSchoolDay, parseCycleLength, starterDays, starterPeriods, typicalDaySlots, upcomingSchoolDays } from './templates';

describe('guided school setup', () => {
  const options = { timeZone: 'America/New_York', today: '2026-09-22' }; // a Tuesday

  it('starts every rotation day empty so example times can never be saved by accident', () => {
    const starter = buildStarter('rotation', { ...options, cycleLength: 8 });
    expect(starter.cycleDays).toHaveLength(8);
    expect(starter.cycleDays.every((day) => day.slots.length === 0)).toBe(true);
    expect(starter.anchorCycleDayId).toBe('day-1');
    expect(starter.anchorDate).toBe('2026-09-22');
  });

  it('anchors a weekday schedule on a Monday and leaves a same-every-day schedule without advancement', () => {
    expect(buildStarter('weekly', options).anchorDate).toBe('2026-09-28');
    expect(buildStarter('weekly', options).anchorCycleDayId).toBe('monday');
    expect(buildStarter('same', options).advanceWeekdays).toEqual([]);
    expect(starterDays('ab', 3).map((day) => day.label)).toEqual(['A day', 'B day']);
  });

  it('builds blank typical-day slots and keeps times already typed when periods change', () => {
    const periods = starterPeriods();
    const blank = typicalDaySlots(periods);
    expect(blank).toHaveLength(periods.length);
    expect(blank.every((slot) => slot.start === '' && slot.end === '')).toBe(true);
    const typed = blank.map((slot, index) => ({ ...slot, start: `0${8 + index}:00`.slice(-5), end: `0${8 + index}:50`.slice(-5) }));
    const fewer = typicalDaySlots(periods.filter((period) => period.id !== 'p2'), typed);
    expect(fewer.find((slot) => slot.periodId === 'p1')?.start).toBe('08:00');
    expect(fewer.some((slot) => slot.periodId === 'p2')).toBe(false);
  });

  it('copies the typical day onto every rotation day and produces a valid schedule', () => {
    const starter = buildStarter('ab', options);
    const typical = typicalDaySlots(starter.periods).map((slot, index) => ({ ...slot, start: `${String(8 + index).padStart(2, '0')}:00`, end: `${String(8 + index).padStart(2, '0')}:50` }));
    const schedule = applyTypicalDay(starter, typical);
    expect(scheduleSchema.safeParse(schedule).success).toBe(true);
    expect(schedule.cycleDays.map((day) => day.slots.length)).toEqual([typical.length, typical.length]);
    expect(schedule.cycleDays[1].slots[0]).not.toBe(typical[0]);
  });

  it('moves the anchor question to the next school day when today is a weekend', () => {
    expect(nextSchoolDay('2026-09-26', [1, 2, 3, 4, 5])).toBe('2026-09-28');
    expect(nextSchoolDay('2026-09-22', [1, 2, 3, 4, 5])).toBe('2026-09-22');
  });

  it('lists upcoming school days without the weekend in between', () => {
    // 2026-09-24 is a Thursday.
    expect(upcomingSchoolDays('2026-09-24', [1, 2, 3, 4, 5], 5)).toEqual(['2026-09-24', '2026-09-25', '2026-09-28', '2026-09-29', '2026-09-30']);
    expect(upcomingSchoolDays('2026-09-26', [1, 3], 3)).toEqual(['2026-09-28', '2026-09-30', '2026-10-05']);
    expect(upcomingSchoolDays('2026-09-24', [], 5)).toEqual([]);
  });

  it('accepts only whole cycle lengths from 2 to 60, so partial typing is never clamped', () => {
    expect(parseCycleLength('8')).toBe(8);
    expect(parseCycleLength(' 12 ')).toBe(12);
    expect(parseCycleLength('60')).toBe(60);
    expect(parseCycleLength('')).toBeNull();
    expect(parseCycleLength('1')).toBeNull();
    expect(parseCycleLength('61')).toBeNull();
    expect(parseCycleLength('2.5')).toBeNull();
    expect(parseCycleLength('-4')).toBeNull();
  });
});
