import { describe, expect, it } from 'vitest';
import { upcomingDaysOff } from './days-off';
import type { Schedule } from './schedule';

const slots = [{ id: 's1', periodId: 'A', start: '08:00', end: '09:00' }];
const schedule = (exceptions: Schedule['exceptions']) => ({ exceptions, schoolWeekdays: [1, 2, 3, 4, 5] });
const closure = (date: string) => ({ date, kind: 'closure' as const, advanceCycle: false });

describe('upcomingDaysOff', () => {
  it('joins closures on back-to-back school days, across a weekend', () => {
    // Thursday and Friday, then the following Monday.
    const days = upcomingDaysOff(schedule([closure('2026-11-30'), closure('2026-11-26'), closure('2026-11-27')]), '2026-11-09');
    expect(days).toEqual([{ start: '2026-11-26', end: '2026-11-30', kind: 'closed' }]);
  });
  it('keeps closures apart when school meets between them', () => {
    const days = upcomingDaysOff(schedule([closure('2026-11-11'), closure('2026-11-13')]), '2026-11-09');
    expect(days).toEqual([{ start: '2026-11-11', end: '2026-11-11', kind: 'closed' }, { start: '2026-11-13', end: '2026-11-13', kind: 'closed' }]);
  });
  it('lists replacement days as special schedules and never joins them into a closure', () => {
    const days = upcomingDaysOff(schedule([closure('2026-11-26'), { date: '2026-11-25', kind: 'replacement', slots, advanceCycle: true }]), '2026-11-09');
    expect(days).toEqual([{ start: '2026-11-25', end: '2026-11-25', kind: 'special' }, { start: '2026-11-26', end: '2026-11-26', kind: 'closed' }]);
  });
  it('leaves out past dates, weekend closures and resets that only move the rotation', () => {
    const days = upcomingDaysOff(schedule([closure('2026-11-06'), closure('2026-11-14'), { date: '2026-11-16', kind: 'reset', cycleDayId: 'day-1', advanceCycle: true }, { date: '2026-11-17', kind: 'reset', cycleDayId: 'day-1', advanceCycle: true, closed: true }]), '2026-11-09');
    expect(days).toEqual([{ start: '2026-11-17', end: '2026-11-17', kind: 'closed' }]);
  });
  it('includes today and stops at the limit', () => {
    const days = upcomingDaysOff(schedule([closure('2026-11-09'), closure('2026-11-11'), closure('2026-11-13')]), '2026-11-09', 2);
    expect(days.map((day) => day.start)).toEqual(['2026-11-09', '2026-11-11']);
  });
});
