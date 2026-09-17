import { describe, expect, it } from 'vitest';
import { exampleSchedule } from '@/domain/example';
import { classSchema, personalScheduleSchema, emptyPersonalSchedule } from '@/domain/schedule';

describe('class colors', () => {
  it('preserves optional colors through personal schedule validation', () => {
    const classes = [{ id: 'biology', name: 'Biology', color: '#12abEF' }, { id: 'math', name: 'Math' }];
    expect(personalScheduleSchema.parse({ ...emptyPersonalSchedule(), classes }).classes).toEqual(classes);
    expect(classSchema.safeParse({ ...classes[0], color: 'red' }).success).toBe(false);
  });
});

import { placeTimedPeriod } from './schedule-placement';
describe('freely timed blocks', () => {
  it('resizes without shifting other periods, rejects overlap, and moves between days', () => {
    const day = exampleSchedule.cycleDays[0];
    const slot = day.slots[0];
    const source = { periodId: slot.periodId, dayId: day.id, slotId: slot.id };
    const resized = placeTimedPeriod(exampleSchedule, source, day.id, { start: '08:05', end: '09:05' }, 'new');
    if (typeof resized === 'string') throw Error(resized);
    expect(resized.cycleDays[0].slots[0]).toEqual({ ...slot, start: '08:05', end: '09:05' });
    expect(resized.cycleDays[0].slots[1]).toEqual(day.slots[1]);
    expect(placeTimedPeriod(exampleSchedule, source, day.id, { start: '08:00', end: '09:15' }, 'new')).toMatch(/overlap/);
    const moved = placeTimedPeriod(exampleSchedule, source, exampleSchedule.cycleDays[1].id, { start: '13:00', end: '13:40' }, 'new');
    if (typeof moved === 'string') throw Error(moved);
    expect(moved.cycleDays[0].slots).not.toContainEqual(slot);
    expect(moved.cycleDays[1].slots.at(-1)).toMatchObject({ id: 'new', start: '13:00', end: '13:40' });
  });
});
