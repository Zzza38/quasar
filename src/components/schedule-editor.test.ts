import { describe, expect, it } from 'vitest';
import type { Schedule } from '@/domain/schedule';
import { copyTimesToAllDays } from './schedule-editor';

type CycleDay = Schedule['cycleDays'][number];
const slot = (id: string, periodId: string, start: string, end: string) => ({ id, periodId, start, end });

describe('copyTimesToAllDays', () => {
  const source: CycleDay = { id: 'b', label: 'Day B', slots: [slot('b1', 'p1', '08:00', '08:50'), slot('b2', 'p2', '09:00', '09:50')] };

  it('copies the source times onto each day while keeping that day’s own periods', () => {
    const other: CycleDay = { id: 'a', label: 'Day A', slots: [slot('a1', 'p2', '08:10', '09:00'), slot('a2', 'p1', '09:10', '10:00')] };
    const result = copyTimesToAllDays([other, source], 'b');
    expect(result.dropped).toEqual([]);
    expect(result.cycleDays[0].slots).toEqual([slot('a1', 'p2', '08:00', '08:50'), slot('a2', 'p1', '09:00', '09:50')]);
    expect(result.cycleDays[1]).toBe(source);
  });

  it('keeps extra periods that still fit after the copied times instead of dropping them silently', () => {
    const longer: CycleDay = { id: 'a', label: 'Day A', slots: [slot('a1', 'p1', '08:00', '08:40'), slot('a2', 'p2', '08:45', '09:25'), slot('a3', 'p3', '10:00', '10:50')] };
    const result = copyTimesToAllDays([longer, source], 'b');
    expect(result.cycleDays[0].slots.map((entry) => entry.id)).toEqual(['a1', 'a2', 'a3']);
    expect(result.cycleDays[0].slots[2]).toEqual(slot('a3', 'p3', '10:00', '10:50'));
    expect(result.dropped).toEqual([]);
  });

  it('reports the periods it has to drop because they would overlap the copied times', () => {
    const longer: CycleDay = { id: 'c', label: 'Day C', slots: [slot('c1', 'p1', '07:30', '08:00'), slot('c2', 'p2', '08:00', '08:30'), slot('c3', 'p3', '08:30', '09:00'), slot('c4', 'p4', '10:00', '10:30')] };
    const result = copyTimesToAllDays([source, longer], 'b');
    expect(result.cycleDays[1].slots.map((entry) => entry.id)).toEqual(['c1', 'c2', 'c4']);
    expect(result.dropped).toEqual([{ label: 'Day C', count: 1 }]);
  });

  it('adds slots for the source’s periods on a day that had fewer', () => {
    const shorter: CycleDay = { id: 'a', label: 'Day A', slots: [slot('a1', 'p3', '08:00', '08:40')] };
    const result = copyTimesToAllDays([shorter, source], 'b');
    expect(result.cycleDays[0].slots).toEqual([slot('a1', 'p3', '08:00', '08:50'), expect.objectContaining({ periodId: 'p2', start: '09:00', end: '09:50' })]);
  });
});
