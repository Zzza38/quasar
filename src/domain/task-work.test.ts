import { describe, expect, it } from 'vitest';
import { examplePersonalSchedule, exampleSchedule } from './example';
import type { Task } from './task';
import { taskClassPeriods, workLocationOf } from './task-work';

const task: Task = { title: 'In class writing', classId: 'algebra', dueDate: '2026-09-08', dueTime: '23:59', notes: '', completed: false, workLocation: 'in-class' };

describe('in-class task times', () => {
  it('recognizes an unlabelled class test without confusing homework or preparation with the test', () => {
    const unlabeled = { ...task, workLocation: undefined };
    expect(workLocationOf({ ...unlabeled, title: 'Unit 3 Test' })).toBe('in-class');
    expect(taskClassPeriods({ ...unlabeled, title: 'Unit 3 Test' }, exampleSchedule, examplePersonalSchedule)[0].start).toBe('08:00');
    for (const title of ['Study for Unit 3 Test', 'Practice test', 'Take-home exam', 'Final essay draft']) expect(workLocationOf({ ...unlabeled, title })).toBeUndefined();
    expect(workLocationOf({ ...unlabeled, title: 'Unit 3 Test', workLocation: 'out-of-class' })).toBe('out-of-class');
  });
  it('uses the assigned class period while preserving the submission deadline', () => {
    expect(taskClassPeriods(task, exampleSchedule, examplePersonalSchedule)).toMatchObject([{ periodId: 'A', start: '08:00', end: '09:00' }]);
    expect(task.dueTime).toBe('23:59');
  });
  it('follows day-specific timetable changes', () => {
    const schedule = structuredClone(exampleSchedule);
    schedule.cycleDays[0].slots[0].start = '08:15';
    expect(taskClassPeriods(task, schedule, examplePersonalSchedule)[0].start).toBe('08:15');
  });
  it('does not invent a time without a matching class, a date, or an open school day', () => {
    expect(taskClassPeriods({ ...task, classId: null }, exampleSchedule, examplePersonalSchedule)).toEqual([]);
    expect(taskClassPeriods({ ...task, dueDate: null }, exampleSchedule, examplePersonalSchedule)).toEqual([]);
    expect(taskClassPeriods({ ...task, dueDate: '2026-09-12' }, exampleSchedule, examplePersonalSchedule)).toEqual([]);
    expect(taskClassPeriods({ ...task, workLocation: 'out-of-class' }, exampleSchedule, examplePersonalSchedule)).toEqual([]);
  });
});
