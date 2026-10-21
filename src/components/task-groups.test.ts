import { describe, expect, it } from 'vitest';
import { examplePersonalSchedule, exampleSchedule } from '@/domain/example';
import { scheduleSchema, type Schedule } from '@/domain/schedule';
import type { Task } from '@/domain/task';
import { addDays } from '@/lib/format';
import type { TaskItem } from './app-state';
import { groupTasks, nextSchoolDate, splitByDay } from './task-groups';

function item(title: string, dueDate: string | null, dueTime: string | null = null): TaskItem {
  const task: Task = { title, dueDate, dueTime, classId: null, notes: '', completed: false };
  return { id: title, task, entity: { id: title, kind: 'task', version: 1, deleted: false, data: task } };
}

function schedule(changes: Partial<Schedule> = {}): Schedule {
  return scheduleSchema.parse({ ...structuredClone(exampleSchedule), ...changes });
}

const personal = examplePersonalSchedule;
const titles = (groups: ReturnType<typeof groupTasks>) => groups.map((group) => [group.title, group.items.map((entry) => entry.task.title)]);

describe('nextSchoolDate', () => {
  it('skips weekends, school closures and personal days off', () => {
    // 2026-09-25 is a Friday.
    expect(nextSchoolDate(exampleSchedule, personal, '2026-09-25')).toBe('2026-09-28');
    expect(nextSchoolDate(exampleSchedule, personal, '2026-09-22')).toBe('2026-09-23');
    const closed = schedule({ exceptions: [{ date: '2026-09-28', kind: 'closure', advanceCycle: false }] });
    expect(nextSchoolDate(closed, personal, '2026-09-25')).toBe('2026-09-29');
    expect(nextSchoolDate(exampleSchedule, { ...personal, dateOverrides: [{ date: '2026-09-28', closed: true }] }, '2026-09-25')).toBe('2026-09-29');
  });

  it('counts a replacement day on a weekend as school', () => {
    const saturday = schedule({ exceptions: [{ date: '2026-09-26', kind: 'replacement', slots: exampleSchedule.cycleDays[0].slots, advanceCycle: false }] });
    expect(nextSchoolDate(saturday, personal, '2026-09-25')).toBe('2026-09-26');
  });

  it('gives up past the lookahead or at the end of the supported range', () => {
    expect(nextSchoolDate(exampleSchedule, personal, '2199-12-31')).toBeNull();
  });
});

describe('groupTasks', () => {
  const context = { nowTime: '12:00', schedule: exampleSchedule, personal };

  it('on a Friday keeps Monday apart from the rest of the week and leaves the weekend on the calendar', () => {
    const groups = groupTasks([
      item('Late', '2026-09-24'),
      item('Quiz', '2026-09-25', '14:00'),
      item('Saturday game', '2026-09-26'),
      item('Sunday reading', '2026-09-27'),
      item('Unit 1 HW 4', '2026-09-28', '08:00'),
      item('Catcher chapters', '2026-09-28'),
      item('Vocab quiz', '2026-09-29', '23:59'),
      item('Next Friday', '2026-10-02'),
      item('Project', '2026-10-05'),
      item('Someday', null),
    ], { ...context, today: '2026-09-25' });
    expect(titles(groups)).toEqual([
      ['Overdue', ['Late']],
      ['Today', ['Quiz']],
      ['Tomorrow', ['Saturday game']],
      ['Before school resumes', ['Sunday reading']],
      ['Monday', ['Unit 1 HW 4', 'Catcher chapters']],
      ['Next 7 days', ['Vocab quiz', 'Next Friday']],
      ['Later', ['Project']],
      ['No due date', ['Someday']],
    ]);
    expect(groups.find((group) => group.key === 'next-school-day')?.detail).toBe('Next school day');
  });

  it('has no separate group when the next school day is tomorrow', () => {
    const groups = groupTasks([item('HW', '2026-09-23'), item('Essay', '2026-09-24')], { ...context, today: '2026-09-22' });
    expect(titles(groups)).toEqual([['Tomorrow', ['HW']], ['Next 7 days', ['Essay']]]);
    expect(groups.some((group) => group.key === 'next-school-day')).toBe(false);
  });

  it('on a Saturday shows Tomorrow for Sunday and Monday as the next school day', () => {
    const groups = groupTasks([item('Sunday', '2026-09-27'), item('Monday', '2026-09-28'), item('Tuesday', '2026-09-29')], { ...context, today: '2026-09-26' });
    expect(titles(groups)).toEqual([['Tomorrow', ['Sunday']], ['Monday', ['Monday']], ['Next 7 days', ['Tuesday']]]);
  });

  it('treats a holiday like a weekend', () => {
    const closed = schedule({ exceptions: [{ date: '2026-09-25', kind: 'closure', advanceCycle: false }] });
    // Thursday before a Friday off: Friday reads as Tomorrow, Monday is the next school day.
    const groups = groupTasks([item('Friday', '2026-09-25'), item('Monday', '2026-09-28')], { ...context, schedule: closed, today: '2026-09-24' });
    expect(titles(groups)).toEqual([['Tomorrow', ['Friday']], ['Monday', ['Monday']]]);
  });

  it('keeps Monday holiday deadlines ahead of Tuesday schoolwork', () => {
    const closed = schedule({ exceptions: [{ date: '2026-10-12', kind: 'closure', advanceCycle: false }] });
    const groups = groupTasks([
      item('Tuesday homework', '2026-10-13'),
      item('Monday video', '2026-10-12', '23:59'),
      item('Wednesday quiz', '2026-10-14'),
    ], { ...context, schedule: closed, today: '2026-10-10' });
    expect(titles(groups)).toEqual([
      ['Before school resumes', ['Monday video']],
      ['Tuesday', ['Tuesday homework']],
      ['Next 7 days', ['Wednesday quiz']],
    ]);
    expect(groups[0].days?.map((day) => day.title)).toEqual(['Monday, Oct 12']);
    expect(groups.flatMap((group) => group.items)).toHaveLength(3);
  });

  it('places the first day back after a long break after Next 7 days, with its date in the title', () => {
    const closures = Array.from({ length: 12 }, (_, index) => ({ date: addDays('2026-12-21', index), kind: 'closure' as const, advanceCycle: false }));
    const closed = schedule({ exceptions: closures });
    // Friday 2026-12-18; school is closed through 2027-01-01, so Monday 2027-01-04 is the first day back.
    const groups = groupTasks([item('Weekend', '2026-12-20'), item('Midweek', '2026-12-23'), item('Break homework', '2026-12-29'), item('Back', '2027-01-04'), item('After', '2027-01-06')], { ...context, schedule: closed, today: '2026-12-18' });
    expect(titles(groups)).toEqual([['Next 7 days', ['Weekend', 'Midweek']], ['Before school resumes', ['Break homework']], ['Monday, Jan 4', ['Back']], ['Later', ['After']]]);
  });

  it('splits Next 7 days into one section per day', () => {
    // Tuesday 2026-10-20: Thursday and Friday work sit under their own day headings.
    const tasks = [item('Quiz retake', '2026-10-22'), item('Project 1', '2026-10-22', '23:59'), item('Unit 2 test', '2026-10-23', '23:59'), item('Monday reading', '2026-10-26')];
    const groups = groupTasks(tasks, { ...context, today: '2026-10-20' });
    const week = groups.find((group) => group.key === 'week')!;
    expect(week.days?.map((day) => [day.title, day.items.map((entry) => entry.task.title)])).toEqual([
      ['Thursday, Oct 22', ['Quiz retake', 'Project 1']],
      ['Friday, Oct 23', ['Unit 2 test']],
      ['Monday, Oct 26', ['Monday reading']],
    ]);
    expect(groups.find((group) => group.key === 'today')).toBeUndefined();
  });

  it('gives every dated group day sections and leaves No due date alone', () => {
    const groups = groupTasks([
      item('Late', '2026-10-19'), item('Earlier late', '2026-10-16'), item('Now', '2026-10-20'), item('Next', '2026-10-21'),
      item('Week', '2026-10-23'), item('Far', '2026-11-05'), item('Far later', '2026-11-12'), item('Someday', null),
    ], { ...context, today: '2026-10-20' });
    expect(groups.map((group) => [group.key, group.days?.map((day) => day.date)])).toEqual([
      ['overdue', ['2026-10-16', '2026-10-19']],
      ['today', ['2026-10-20']],
      ['tomorrow', ['2026-10-21']],
      ['week', ['2026-10-23']],
      ['later', ['2026-11-05', '2026-11-12']],
      ['undated', undefined],
    ]);
    expect(groups[0].days![0]).toMatchObject({ weekday: 'Fri', day: '16', month: 'Oct', title: 'Friday, Oct 16' });
  });

  it('orders day sections by date and keeps the incoming order within a day', () => {
    const days = splitByDay([item('High Friday', '2026-10-23'), item('High Thursday', '2026-10-22'), item('Low Friday', '2026-10-23')]);
    expect(days.map((day) => [day.date, day.items.map((entry) => entry.task.title)])).toEqual([['2026-10-22', ['High Thursday']], ['2026-10-23', ['High Friday', 'Low Friday']]]);
  });

  it('keeps the incoming order inside each group so a priority sort survives', () => {
    const groups = groupTasks([item('B', '2026-09-28', '10:00'), item('A', '2026-09-28', '08:00')], { ...context, today: '2026-09-25' });
    expect(groups[0].items.map((entry) => entry.task.title)).toEqual(['B', 'A']);
  });
});
