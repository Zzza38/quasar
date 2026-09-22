import { describe, expect, it } from 'vitest';
import { scheduleSchema } from '@/domain/schedule';
import { applyTypicalDay, buildStarter, nextSchoolDay, starterDays, starterPeriods, typicalDaySlots } from './templates';

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
});
