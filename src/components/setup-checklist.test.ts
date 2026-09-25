import { describe, expect, it } from 'vitest';
import { examplePersonalSchedule, exampleSchedule } from '@/domain/example';
import { emptyPersonalSchedule, type PersonalSchedule, type Schedule } from '@/domain/schedule';
import { coreSetupDone, tickedStep } from './setup-checklist';

const noSlots: Schedule = { ...exampleSchedule, cycleDays: exampleSchedule.cycleDays.map((day) => ({ ...day, slots: [] })) };
const algebra = { id: 'algebra', name: 'Algebra' };

describe('coreSetupDone', () => {
  it('needs a class on a scheduled period', () => {
    expect(coreSetupDone(emptyPersonalSchedule(), exampleSchedule)).toBe(false);
    expect(coreSetupDone({ ...emptyPersonalSchedule(), classes: [algebra] }, exampleSchedule)).toBe(false);
    expect(coreSetupDone(examplePersonalSchedule, exampleSchedule)).toBe(true);
    expect(coreSetupDone(examplePersonalSchedule, noSlots)).toBe(false);
  });

  it('counts a class placed on a private schedule period the school does not have', () => {
    const custom: Schedule = { ...noSlots, periods: [...noSlots.periods, { id: 'class-algebra', label: 'Algebra', kind: 'class' }], cycleDays: noSlots.cycleDays.map((day, index) => index === 0 ? { ...day, slots: [{ id: 'a', periodId: 'class-algebra', start: '09:00', end: '10:00' }] } : day) };
    const personal: PersonalSchedule = { ...emptyPersonalSchedule(), classes: [algebra], assignments: { 'class-algebra': 'algebra' }, customSchedule: custom };
    expect(coreSetupDone(personal, noSlots)).toBe(true);
  });

  it('counts periods added by rotation-day and date adjustments', () => {
    const slot = { id: 'a', periodId: 'A', start: '09:00', end: '10:00' };
    const base: PersonalSchedule = { ...emptyPersonalSchedule(), classes: [algebra], assignments: { A: 'algebra' } };
    expect(coreSetupDone(base, noSlots)).toBe(false);
    expect(coreSetupDone({ ...base, cycleDayOverrides: [{ cycleDayId: 'day-1', slots: [slot] }] }, noSlots)).toBe(true);
    expect(coreSetupDone({ ...base, dateOverrides: [{ date: '2026-09-15', slots: [slot] }] }, noSlots)).toBe(true);
  });

  it('follows the grade schedule for the student grade', () => {
    const graded: Schedule = { ...noSlots, gradeSchedules: { '9': exampleSchedule } };
    expect(coreSetupDone({ ...examplePersonalSchedule, grade: '9' }, graded)).toBe(true);
    expect(coreSetupDone({ ...examplePersonalSchedule, grade: '10' }, graded)).toBe(false);
  });
});

describe('tickedStep', () => {
  it('marks a "Not now" tick as skipped with Undo, not done', () => {
    expect(tickedStep(false, true, true)).toEqual({ done: true, manual: true, skipped: true });
    expect(tickedStep(false, false, true)).toEqual({ done: false, manual: false, skipped: false });
  });

  it('treats a real completion as done without Undo, whatever the tick', () => {
    expect(tickedStep(true, true, true)).toEqual({ done: true, manual: false, skipped: false });
    expect(tickedStep(true, false, false)).toEqual({ done: true, manual: false, skipped: false });
  });

  it('keeps a claimed step ("Already added", "It matches") done but undoable', () => {
    expect(tickedStep(false, true, false)).toEqual({ done: true, manual: true, skipped: false });
  });
});
