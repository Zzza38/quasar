import { describe, expect, it } from 'vitest';
import { examplePersonalSchedule, exampleSchedule } from './example';
import { markFreePeriod, suggestedFreePeriodIds } from './period-status';
import { emptyPersonalSchedule, personalScheduleSchema, type PersonalSchedule } from './schedule';

const without = (...periodIds: string[]): PersonalSchedule => ({
  ...examplePersonalSchedule,
  assignments: Object.fromEntries(Object.entries(examplePersonalSchedule.assignments).filter(([id]) => !periodIds.includes(id))),
});

describe('suggestedFreePeriodIds', () => {
  it('suggests one or two empty class blocks as free periods', () => {
    expect([...suggestedFreePeriodIds(exampleSchedule, without('D'))]).toEqual(['D']);
    expect([...suggestedFreePeriodIds(exampleSchedule, without('B', 'D'))].sort()).toEqual(['B', 'D']);
  });

  it('suggests nothing with every block filled, three or more empty, or no classes at all', () => {
    expect(suggestedFreePeriodIds(exampleSchedule, examplePersonalSchedule).size).toBe(0);
    expect(suggestedFreePeriodIds(exampleSchedule, without('B', 'C', 'D')).size).toBe(0);
    expect(suggestedFreePeriodIds(exampleSchedule, emptyPersonalSchedule()).size).toBe(0);
    expect(suggestedFreePeriodIds(exampleSchedule, without('A', 'B', 'C', 'D')).size).toBe(0);
  });

  it('counts an assignment to a deleted class as empty', () => {
    expect([...suggestedFreePeriodIds(exampleSchedule, { ...examplePersonalSchedule, assignments: { ...examplePersonalSchedule.assignments, C: 'gone' } })]).toEqual(['C']);
  });
});

describe('markFreePeriod', () => {
  it('marks the block free and stops suggesting it', () => {
    const next = markFreePeriod(without('D'), 'D');
    expect(next.freePeriods).toEqual(['D']);
    expect(next.classes).toEqual(examplePersonalSchedule.classes);
    expect(personalScheduleSchema.safeParse(next).success).toBe(true);
    expect(suggestedFreePeriodIds(exampleSchedule, next).size).toBe(0);
  });

  it('keeps other free marks, never repeats one, and drops a dangling assignment', () => {
    const base = { ...without('C', 'D'), freePeriods: ['C'], assignments: { ...without('C', 'D').assignments, D: 'gone' } };
    expect([...suggestedFreePeriodIds(exampleSchedule, base)]).toEqual(['D']);
    const next = markFreePeriod(markFreePeriod(base, 'D'), 'D');
    expect(next.freePeriods).toEqual(['C', 'D']);
    expect(next.assignments.D).toBeUndefined();
    expect(personalScheduleSchema.safeParse(next).success).toBe(true);
  });

  it('does not count free marks as classes placed', () => {
    const none = { ...emptyPersonalSchedule(), freePeriods: ['A', 'B'] };
    expect(suggestedFreePeriodIds(exampleSchedule, none).size).toBe(0);
  });
});
