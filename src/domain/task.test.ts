import { describe, expect, it } from 'vitest';
import { nextRecurringTask, taskSchema, type Task } from './task';
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
  it('rejects duplicate checklist IDs and preserves imported metadata', () => {
    const item = { id: '12345678-1234-4234-8234-123456789abc', title: 'Read', completed: false };
    expect(taskSchema.safeParse({ ...task, subtasks: [item, item] }).success).toBe(false);
    const imported = { subscriptionId: 'feed', uid: 'event', recurrenceId: null, startDate: '2024-01-31', startTime: null, endDate: '2024-02-01', endTime: null, timeZone: 'UTC', allDay: true, sourceRemoved: false, sourceUpdatedAt: '2024-01-01T00:00:00.000Z' };
    expect(taskSchema.parse({ ...task, imported }).imported).toEqual(imported);
    expect(taskSchema.safeParse({ ...monthly, imported }).success).toBe(false);
    expect(nextRecurringTask({ ...monthly, imported })).toBeNull();
  });
});
