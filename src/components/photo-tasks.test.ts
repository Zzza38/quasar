import { describe, expect, it } from 'vitest';
import type { Task } from '@/domain/task';
import type { TaskItem } from './app-state';
import { draftRows, draftTask, existingMatch } from './photo-tasks';

const base: Task = { title: 'Read chapter 5', dueDate: '2026-11-06', dueTime: null, classId: null, notes: '', completed: false };
const item = (id: string, task: Partial<Task>): TaskItem => ({ id, task: { ...base, ...task }, entity: { id, kind: 'task', version: 1, data: {}, deleted: false } as TaskItem['entity'] });
const read = (title: string, dueDate: string | null, extra: Partial<{ dueTime: string | null; classId: string | null; notes: string; kind: 'test' | 'quiz' | 'none' }> = {}) =>
  ({ title, dueDate, dueTime: null, notes: '', classId: null, kind: 'none' as const, ...extra });

describe('Photo to tasks review', () => {
  it('flags a row with the same title and due date as an existing task, ignoring case and punctuation', () => {
    const items = [item('a', { title: 'Read Chapter 5!' }), item('b', { title: 'Unit 3 test', dueDate: '2026-11-10' })];
    expect(existingMatch(read('read chapter 5', '2026-11-06'), items)?.id).toBe('a');
    expect(existingMatch(read('Read chapter 5', '2026-11-07'), items)).toBeNull();
    expect(existingMatch(read('Read chapter 6', '2026-11-06'), items)).toBeNull();
    const rows = draftRows([read('Read chapter 5', '2026-11-06'), read('Lab report', null)], items);
    // A likely duplicate starts unticked, so saving doesn't make a second copy unless the student asks.
    expect(rows.map(row => [row.include, row.existing])).toEqual([[false, 'Read Chapter 5!'], [true, null]]);
  });

  it('saves a reviewed row as a normal task, a test at high priority', () => {
    const [row] = draftRows([read('  Unit 3 test ', '2026-11-10', { dueTime: '08:00', classId: 'bio', kind: 'test', notes: 'Ch 7-9' })], []);
    expect(draftTask(row)).toEqual({ title: 'Unit 3 test', dueDate: '2026-11-10', dueTime: '08:00', classId: 'bio', notes: 'Ch 7-9', completed: false, priority: 'high' });
    // Clearing the date in review drops the time with it.
    expect(draftTask({ ...row, dueDate: null, kind: 'none' })).toMatchObject({ dueDate: null, dueTime: null, priority: 'normal' });
  });
});
