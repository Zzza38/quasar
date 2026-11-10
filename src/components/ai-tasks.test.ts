import { describe, expect, it } from 'vitest';
import type { Task } from '@/domain/task';
import type { TaskItem } from './app-state';
import { applySuggestion, sortCandidates, sortAttemptKey } from './ai-tasks';

const base: Task = { title: 'Unit 2 Test', dueDate: '2026-10-27', dueTime: null, classId: null, notes: '', completed: false };
const item = (id: string, task: Partial<Task>): TaskItem => ({ id, task: { ...base, ...task }, entity: { id, kind: 'task', version: 1, data: {}, deleted: false } as TaskItem['entity'] });

describe('AI task suggestions on the client', () => {
  it('tracks attempts by account and task content, not fields that sorting itself fills', () => {
    const before = item('a', {});
    expect(sortAttemptKey('owner', before)).toBe(sortAttemptKey('owner', item('a', { priority: 'high', classId: 'bio', workLocation: 'in-class' })));
    expect(sortAttemptKey('owner', before)).not.toBe(sortAttemptKey('other', before));
    expect(sortAttemptKey('owner', before)).not.toBe(sortAttemptKey('owner', item('a', { notes: 'New directions' })));
  });
  it('never replaces a class or priority the student set', () => {
    expect(applySuggestion(base, { classId: 'bio', priority: 'high' })).toMatchObject({ classId: 'bio', priority: 'high' });
    expect(applySuggestion({ ...base, classId: 'chem' }, { classId: 'bio', priority: 'high' })).toMatchObject({ classId: 'chem', priority: 'high' });
    expect(applySuggestion({ ...base, priority: 'low' }, { classId: null, priority: 'high' })).toMatchObject({ classId: null, priority: 'low' });
  });

  it('labels missing work settings with AI provenance and preserves a manual choice', () => {
    const suggestion = { classId: 'bio', priority: 'normal' as const, workLocation: 'in-class' as const };
    expect(applySuggestion(base, suggestion)).toMatchObject({ workLocation: 'in-class', workLocationSource: 'ai' });
    expect(applySuggestion({ ...base, workLocation: 'out-of-class', workLocationSource: 'manual' }, suggestion))
      .toMatchObject({ workLocation: 'out-of-class', workLocationSource: 'manual' });
  });

  it('offers open tasks with no priority yet, soonest due first', () => {
    const items = [
      item('later', { dueDate: '2026-11-02' }),
      item('done', { completed: true }),
      item('set', { priority: 'normal', workLocation: 'out-of-class' }),
      item('needs-location', { priority: 'normal', dueDate: '2026-10-25' }),
      item('soon', { dueDate: '2026-10-24' }),
      item('undated', { dueDate: null }),
    ];
    expect(sortCandidates(items).map((entry) => entry.id)).toEqual(['soon', 'needs-location', 'later', 'undated']);
  });
});
