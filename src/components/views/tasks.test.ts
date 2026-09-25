import { describe, expect, it } from 'vitest';
import { taskSchema, type Task } from '@/domain/task';
import { isOverdue } from '../app-state';
import { dateOnlyReminderNote, withoutBlankSubtasks } from './tasks';

describe('date-only reminder hint', () => {
  it('says reminders count from 9:00 AM and gives the time the chosen reminder actually arrives', () => {
    expect(dateOnlyReminderNote(10)).toBe('With no due time, reminders count from 9:00 AM, so this reminder comes at 8:50 AM.');
    expect(dateOnlyReminderNote(0)).toContain('this reminder comes at 9:00 AM.');
    expect(dateOnlyReminderNote(10)).toContain('this reminder comes at 8:50 AM.');
    expect(dateOnlyReminderNote(60)).toContain('this reminder comes at 8:00 AM.');
    expect(dateOnlyReminderNote(1440)).toContain('this reminder comes at 9:00 AM the day before.');
    expect(dateOnlyReminderNote(600)).toContain('this reminder comes at 11:00 PM the day before.');
    expect(dateOnlyReminderNote(10080)).toContain('this reminder comes at 9:00 AM 7 days before.');
  });

  it('says nothing when no reminder is chosen, since the task itself is not due at 9:00 AM', () => {
    expect(dateOnlyReminderNote()).toBe('');
    // A date-only task stays under Today until the day ends, so the 9:00 AM rule is only about reminders.
    const dateOnly: Task = { title: 'Essay', dueDate: '2026-09-24', dueTime: null, classId: null, notes: '', completed: false };
    expect(isOverdue(dateOnly, '2026-09-24', '10:00')).toBe(false);
  });
});

describe('saving a task with blank checklist items', () => {
  const base: Task = { title: 'Lab report', dueDate: null, dueTime: null, classId: null, notes: '', completed: false };

  it('drops items that are empty or only spaces so the schema accepts the rest', () => {
    const draft: Task = { ...base, subtasks: [
      { id: crypto.randomUUID(), title: 'Read the notes', completed: false },
      { id: crypto.randomUUID(), title: '   ', completed: false },
      { id: crypto.randomUUID(), title: '', completed: true },
    ] };
    expect(() => taskSchema.parse(draft)).toThrow();
    const saved = taskSchema.parse(withoutBlankSubtasks(draft));
    expect(saved.subtasks?.map((item) => item.title)).toEqual(['Read the notes']);
  });

  it('leaves a task without a checklist unchanged', () => {
    expect(withoutBlankSubtasks(base)).toBe(base);
  });
});
