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

import { classFill, placeTimedPeriod } from './schedule-placement';
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

describe('classes fill blocks', () => {
  // Day 1: A 8:00–9:00, B 9:10–10:10, lunch 10:15–10:45, C 10:50–11:50. Times below are minutes since midnight.
  const day = exampleSchedule.cycleDays[0];
  const schedule = { ...exampleSchedule, periods: [...exampleSchedule.periods, { id: 'class-art', label: 'Art', kind: 'class' as const }] };
  const assignments = { A: 'algebra', 'class-art': 'art' };
  const palette = { periodId: 'class-art' };
  const algebra = { periodId: 'A', dayId: day.id, slotId: 'first' };

  it('puts a class from the palette into the block it is dropped on, replacing what was there', () => {
    expect(classFill(schedule, assignments, palette, day.id, 9 * 60 + 30, 9 * 60 + 30, 10 * 60 + 15)).toEqual({ slot: day.slots[1], changes: { B: 'art' } });
    expect(classFill(schedule, assignments, palette, day.id, 8 * 60 + 59, 8 * 60 + 55, 9 * 60 + 40)).toEqual({ slot: day.slots[0], changes: { A: 'art' } });
  });
  it('moves a class dragged out of a block, and swaps it with a class already there', () => {
    expect(classFill(schedule, assignments, algebra, day.id, 9 * 60 + 30, 9 * 60, 10 * 60)).toEqual({ slot: day.slots[1], changes: { B: 'algebra', A: null } });
    expect(classFill(schedule, { ...assignments, B: 'english' }, algebra, day.id, 9 * 60 + 30, 9 * 60, 10 * 60)).toEqual({ slot: day.slots[1], changes: { B: 'algebra', A: 'english' } });
    // Slot ids repeat on every day: the same id on another day is another block.
    expect(classFill(schedule, assignments, algebra, 'day-2', 8 * 60 + 30, 8 * 60, 9 * 60)).toEqual({ slot: exampleSchedule.cycleDays[1].slots[0], changes: { B: 'algebra', A: null } });
    // The same period on another day is the same class already.
    expect(classFill(schedule, assignments, algebra, 'day-4', 9 * 60 + 30, 9 * 60, 10 * 60)).toEqual({ slot: exampleSchedule.cycleDays[3].slots[1], changes: null });
  });
  it('leaves a block nudged within itself, and anything without a class, to free-time placement', () => {
    expect(classFill(schedule, assignments, algebra, day.id, 8 * 60 + 30, 8 * 60 + 5, 9 * 60 + 5)).toBeUndefined();
    expect(classFill(schedule, assignments, { periodId: 'lunch' }, day.id, 9 * 60 + 30, 9 * 60 + 30, 10 * 60 + 15)).toBeUndefined();
    expect(classFill(schedule, assignments, palette, day.id, 13 * 60, 13 * 60, 13 * 60 + 45)).toBeUndefined();
  });
  it('counts a near miss from the palette as the empty block it would overlap, but not from on top of another block', () => {
    // In the gap before C: the placement would run into C, so the class goes into C.
    expect(classFill(schedule, assignments, palette, day.id, 10 * 60 + 47, 10 * 60 + 45, 11 * 60 + 30)).toEqual({ slot: day.slots[3], changes: { C: 'art' } });
    // In the gap before B, which is empty; A just above has a class and is left alone.
    expect(classFill(schedule, assignments, palette, day.id, 9 * 60 + 5, 9 * 60 + 5, 9 * 60 + 50)?.slot).toEqual(day.slots[1]);
    // Pointing at lunch is not pointing at C, even though the placement would reach it.
    expect(classFill(schedule, assignments, palette, day.id, 10 * 60 + 20, 10 * 60 + 20, 11 * 60 + 5)).toBeUndefined();
    // A block being moved is not pulled into a neighbour it merely overlaps.
    expect(classFill(schedule, assignments, algebra, day.id, 9 * 60 + 5, 8 * 60 + 30, 9 * 60 + 30)).toBeUndefined();
    // A block that already has a class is only replaced when pointed at.
    expect(classFill(schedule, { ...assignments, C: 'biology' }, palette, day.id, 10 * 60 + 47, 10 * 60 + 45, 11 * 60 + 30)).toBeUndefined();
  });
});

import { displayPeriodLabel, resolveDay, UNASSIGNED_BLOCK_LABEL } from '@/domain/schedule';
describe('private block names', () => {
  it('names a private block after the class in it, not the class that made it', () => {
    const made = { id: 'class-art', label: 'Art', kind: 'class' as const };
    expect(displayPeriodLabel(made, 'Biology')).toBe('Biology');
    expect(displayPeriodLabel(made, true)).toBe('Art');
    expect(displayPeriodLabel(made, false)).toBe(UNASSIGNED_BLOCK_LABEL);
    expect(displayPeriodLabel({ id: 'A', label: 'A', kind: 'class' }, 'Biology')).toBe('A');
    const custom = { ...exampleSchedule, periods: [...exampleSchedule.periods, made], cycleDays: exampleSchedule.cycleDays.map((day, index) => index ? day : { ...day, slots: [...day.slots, { id: 'own', periodId: 'class-art', start: '13:00', end: '13:45' }] }) };
    const personal = { ...emptyPersonalSchedule(), classes: [{ id: 'biology', name: 'Biology' }], assignments: { 'class-art': 'biology' }, customSchedule: custom };
    expect(resolveDay(exampleSchedule, '2026-09-08', personal).periods.find(period => period.periodId === 'class-art')?.label).toBe('Biology');
  });
});
