import { describe, expect, it } from 'vitest';
import { completionTime, nextRecurringTask, repairTaskDates, stampCompletion, taskSchema, withoutCompletionEdit, type Task } from './task';
const task: Task = { title: 'Homework', dueDate: '2024-01-31', dueTime: null, classId: null, notes: '', completed: true };
const monthly: Task = { ...task, recurrence: { frequency: 'monthly', interval: 1, until: null } };
describe('richer tasks', () => {
  it('preserves the exact phase 1 shape without injecting defaults', () => {
    expect(taskSchema.parse(task)).toEqual(task);
    expect(Object.keys(taskSchema.parse(task))).toEqual(Object.keys(task));
  });
  it('clamps month ends and restores the original day after February', () => {
    const feb = nextRecurringTask(monthly)!;
    expect(feb.dueDate).toBe('2024-02-29');
    expect(feb.recurrence?.anchorDate).toBe('2024-01-31');
    expect(nextRecurringTask({ ...feb, completed: true })?.dueDate).toBe('2024-03-31');
    expect(nextRecurringTask({ ...monthly, dueDate: '2023-01-31' })?.dueDate).toBe('2023-02-28');
  });
  it('supports weekly intervals, year boundaries and inclusive end dates', () => {
    const weekly: Task = { ...task, dueDate: '2024-12-25', recurrence: { frequency: 'weekly', interval: 2, until: '2025-01-08' } };
    const next = nextRecurringTask(weekly)!;
    expect(next.dueDate).toBe('2025-01-08');
    expect(nextRecurringTask({ ...next, completed: true })).toBeNull();
  });
  it('resets completion and checklist while preserving task settings and item IDs', () => {
    const subtask = { id: '12345678-1234-4234-8234-123456789abc', title: 'Read', completed: true };
    const next = nextRecurringTask({ ...monthly, priority: 'high', subtasks: [subtask], reminder: { minutesBefore: 30, timeZone: 'America/New_York' } })!;
    expect(next.completed).toBe(false);
    expect(next.subtasks).toEqual([{ ...subtask, completed: false }]);
    expect(next.priority).toBe('high');
    expect(next.reminder).toEqual({ minutesBefore: 30, timeZone: 'America/New_York' });
    expect(subtask.completed).toBe(true);
  });
  it('only advances completed repeating tasks', () => {
    expect(nextRecurringTask({ ...monthly, completed: false })).toBeNull();
    expect(nextRecurringTask(task)).toBeNull();
    expect(nextRecurringTask({ ...monthly, dueDate: null })).toBeNull();
  });
  it('validates date-dependent features and recurrence bounds', () => {
    expect(taskSchema.safeParse({ ...monthly, dueDate: null }).success).toBe(false);
    expect(taskSchema.safeParse({ ...task, dueDate: null, reminder: { minutesBefore: 0, timeZone: 'UTC' } }).success).toBe(false);
    expect(taskSchema.safeParse({ ...monthly, recurrence: { frequency: 'daily', interval: 0, until: null } }).success).toBe(false);
    expect(taskSchema.safeParse({ ...monthly, recurrence: { frequency: 'monthly', interval: 1, until: '2024-01-30' } }).success).toBe(false);
    expect(taskSchema.safeParse({ ...task, reminder: { minutesBefore: 0, timeZone: 'Invalid/Zone' } }).success).toBe(false);
    expect(taskSchema.safeParse({ ...task, reminder: { minutesBefore: 0, timeZone: 'UTC' } }).success).toBe(true);
  });
  it('keeps task dates within the 1900-2199 range the schedule accepts', () => {
    expect(taskSchema.safeParse({ ...task, dueDate: '9999-12-31' }).success).toBe(false);
    expect(taskSchema.safeParse({ ...task, dueDate: '1899-12-31' }).success).toBe(false);
    expect(taskSchema.safeParse({ ...task, dueDate: '2199-12-31' }).success).toBe(true);
    expect(taskSchema.safeParse({ ...monthly, recurrence: { frequency: 'monthly', interval: 1, until: '2200-01-01' } }).success).toBe(false);
    // The successor of a task due on the last accepted day steps outside the range, so the schema rejects it.
    const next = nextRecurringTask({ ...task, dueDate: '2199-12-31', completed: true, recurrence: { frequency: 'daily', interval: 1, until: null } });
    expect(next?.dueDate).toBe('2200-01-01');
    expect(taskSchema.safeParse(next).success).toBe(false);
  });
  it('rejects duplicate checklist IDs and preserves imported metadata', () => {
    const item = { id: '12345678-1234-4234-8234-123456789abc', title: 'Read', completed: false };
    expect(taskSchema.safeParse({ ...task, subtasks: [item, item] }).success).toBe(false);
    const imported = { subscriptionId: 'feed', uid: 'event', recurrenceId: null, startDate: '2024-01-31', startTime: null, endDate: '2024-02-01', endTime: null, timeZone: 'UTC', allDay: true, sourceRemoved: false, sourceUpdatedAt: '2024-01-01T00:00:00.000Z' };
    expect(taskSchema.parse({ ...task, imported }).imported).toEqual(imported);
    expect(taskSchema.safeParse({ ...monthly, imported }).success).toBe(false);
    expect(nextRecurringTask({ ...monthly, imported })).toBeNull();
  });
});
describe('completion time', () => {
  const now = new Date('2026-09-24T12:00:00.000Z');
  it('stamps on completion, carries the stamp while completed and drops it on reopening', () => {
    const open = { ...task, completed: false };
    expect(stampCompletion({ ...task }, open, now).completedAt).toBe('2026-09-24T12:00:00.000Z');
    expect(stampCompletion({ ...task }, null, now).completedAt).toBe('2026-09-24T12:00:00.000Z');
    const done = { ...task, completedAt: '2026-09-01T08:00:00.000Z' };
    expect(stampCompletion({ ...task, title: 'Renamed' }, done, now).completedAt).toBe('2026-09-01T08:00:00.000Z');
    expect(stampCompletion({ ...done, completed: false }, done, now)).not.toHaveProperty('completedAt');
    // Completed before the stamp existed: stays unstamped rather than looking just done.
    expect(stampCompletion({ ...task }, task, now)).not.toHaveProperty('completedAt');
    expect(taskSchema.parse(done)).toEqual(done);
  });
  it('trusts a client stamp only when it is a real time that is not in the future', () => {
    expect(completionTime('2026-09-20T07:30:00.000Z', now).toISOString()).toBe('2026-09-20T07:30:00.000Z');
    expect(completionTime('2027-01-01T00:00:00.000Z', now)).toBe(now);
    expect(completionTime('yesterday', now)).toBe(now);
    expect(completionTime(undefined, now)).toBe(now);
  });
  it('treats a client change to the stamp as no edit', () => {
    const base = { deleted: false, data: { ...task, completedAt: '2026-09-01T08:00:00.000Z' } };
    expect(withoutCompletionEdit({ ...task, completedAt: '2026-09-02T08:00:00.000Z' }, base).completedAt).toBe('2026-09-01T08:00:00.000Z');
    expect(withoutCompletionEdit({ ...task, completedAt: '2026-09-02T08:00:00.000Z' }, null)).not.toHaveProperty('completedAt');
  });
  it('starts the next repeat without the completion time', () => {
    expect(nextRecurringTask({ ...monthly, completedAt: '2024-01-31T20:00:00.000Z' })).not.toHaveProperty('completedAt');
  });
});
describe('repairTaskDates', () => {
  it('leaves valid and unrepairable tasks alone', () => {
    expect(repairTaskDates(task)).toBeNull();
    expect(repairTaskDates({ ...task, title: '' })).toBeNull();
    expect(repairTaskDates(null)).toBeNull();
  });
  it('drops an out-of-range due date with the fields that need one, so an older build\'s task stays visible', () => {
    const stored = { ...task, dueDate: '0002-03-04', dueTime: '09:00', reminder: { minutesBefore: 60, timeZone: 'UTC' }, recurrence: { frequency: 'daily', interval: 1, until: null } };
    expect(taskSchema.safeParse(stored).success).toBe(false);
    expect(repairTaskDates(stored)).toEqual({ ...task, dueDate: null, dueTime: null, reminder: null, recurrence: null });
    expect(repairTaskDates({ ...task, dueDate: '2300-01-01' })).toEqual({ ...task, dueDate: null });
  });
  it('keeps a valid due date and repeat but drops an out-of-range end or anchor date', () => {
    const repaired = repairTaskDates({ ...monthly, recurrence: { frequency: 'monthly', interval: 1, until: '2300-01-01', anchorDate: '0001-01-31' } });
    expect(repaired).toEqual({ ...monthly, recurrence: { frequency: 'monthly', interval: 1, until: null } });
  });
  it('drops a calendar import\'s end date past 2199 so the imported task stays visible', () => {
    const imported = { subscriptionId: 'sub', uid: 'u', recurrenceId: null, startDate: '2026-10-01', startTime: '09:00', endDate: '2300-01-01', endTime: '10:00', timeZone: 'UTC', allDay: false, sourceRemoved: false, sourceUpdatedAt: '2026-09-01T00:00:00.000Z', url: null };
    const event = { ...task, dueDate: '2026-10-01', imported };
    expect(taskSchema.safeParse(event).success).toBe(false);
    expect(repairTaskDates(event)).toEqual({ ...event, imported: { ...imported, endDate: null, endTime: null } });
    // A VTODO due after 2199 loses its due date too.
    expect(repairTaskDates({ ...event, dueDate: '2300-01-01', dueTime: '10:00' })).toEqual({ ...event, dueDate: null, dueTime: null, imported: { ...imported, endDate: null, endTime: null } });
  });
});
