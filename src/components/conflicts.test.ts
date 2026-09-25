import { describe, expect, it } from 'vitest';
import type { Task } from '@/domain/task';
import { conflictSource, importedSourceLabel, taskFields } from './conflicts';

const imported = (fields: Partial<NonNullable<Task['imported']>>): NonNullable<Task['imported']> => ({
  subscriptionId: 'sub', uid: 'uid', recurrenceId: null, startDate: '2026-10-30', startTime: null, endDate: null, endTime: null,
  timeZone: 'America/New_York', allDay: true, sourceRemoved: false, sourceUpdatedAt: '2026-10-01T00:00:00.000Z', ...fields,
});

describe('conflict table calendar source', () => {
  it('reads an all-day DTEND as exclusive, so a one-day event shows a single date', () => {
    expect(importedSourceLabel(imported({ endDate: '2026-10-31' }))).toBe('Subscribed · Fri, Oct 30 · All day');
    expect(importedSourceLabel(imported({ endDate: null }))).toBe('Subscribed · Fri, Oct 30 · All day');
  });
  it('ends a multi-day all-day event on the day before its DTEND', () => {
    expect(importedSourceLabel(imported({ endDate: '2026-11-02', sourceRemoved: true }))).toBe('Removed from source · Fri, Oct 30 – Sun, Nov 1 · All day');
  });
  it('keeps a timed event\'s end as given', () => {
    const label = importedSourceLabel(imported({ allDay: false, startTime: '09:00', endDate: '2026-10-30', endTime: '10:00' }));
    expect(label).toContain('Fri, Oct 30');
    expect(label).toContain(' – ');
    expect(label).not.toContain('All day');
  });
});

describe('conflict table reminder', () => {
  it('labels the lead time the way the task editor does', () => {
    const reminder = taskFields([]).find((field) => field.key === 'reminder')!;
    const task = (minutesBefore: number) => ({ title: 'Essay', dueDate: '2026-10-30', dueTime: null, classId: null, notes: '', completed: false, reminder: { minutesBefore, timeZone: 'UTC' } });
    expect(reminder.render(task(1440))).toMatch(/^1 day before · /);
    expect(reminder.render(task(60))).toMatch(/^1 hour before · /);
    expect(reminder.render(task(0))).toMatch(/^At due time · /);
  });
});

describe('conflict attribution', () => {
  const task = (version: number, data: Record<string, unknown>) => ({ id: 't1', kind: 'task' as const, version, deleted: false, data: { title: 'Essay', notes: '', dueDate: '2026-10-30', dueTime: null, classId: null, completed: false, ...data } });
  const base = task(1, { imported: imported({}) });
  const conflict = (current: ReturnType<typeof task>, paths: string[]) => ({ mutation: { mutationId: 'm1', id: 't1', kind: 'task' as const, base, data: { ...base.data, title: 'Mine' } }, current, paths });
  const restamped = imported({ startTime: '09:00', allDay: false, sourceUpdatedAt: '2026-10-02T00:00:00.000Z' });

  it('names the calendar when its refresh was the only write since this device\'s base', () => {
    expect(conflictSource(conflict(task(2, { title: 'From the feed', imported: restamped }), ['/title']))).toBe('calendar');
  });
  it('stays neutral when a restamp sits next to another write that may have been another device\'s edit', () => {
    // Another device edited the title (v2), then a refresh changed only the event's start time (v3).
    expect(conflictSource(conflict(task(3, { title: 'Other device', imported: restamped }), ['/title']))).toBe('either');
    expect(conflictSource(conflict(task(3, { notes: 'Other device', imported: restamped }), ['/notes']))).toBe('either');
  });
  it('names another device when only the source metadata changed next to a competing edit it does not write', () => {
    // Another device edited the checklist while a refresh changed only the event's start time.
    expect(conflictSource(conflict(task(3, { subtasks: [], imported: restamped }), ['/subtasks']))).toBe('device');
    expect(conflictSource(conflict(task(3, { imported: { ...restamped, sourceRemoved: true } }), ['/']))).toBe('device');
  });
  it('names another device when the calendar metadata is unchanged', () => {
    expect(conflictSource(conflict(task(2, { title: 'Other device', imported: imported({}) }), ['/title']))).toBe('device');
  });
});
