import { describe, expect, it } from 'vitest';
import { examplePersonalSchedule, exampleSchedule } from '@/domain/example';
import type { Task } from '@/domain/task';
import { addDays } from '@/lib/format';
import type { TaskItem } from './app-state';
import { doNow, isAssessment, keywordKind, upcomingAssessments } from './focus-lists';

// 2026-09-24 is a Thursday; the next school day after Friday 09-25 is Monday 09-28.
const item = (title: string, dueDate: string | null, extra: Partial<Task> = {}): TaskItem =>
  ({ id: title, task: { title, dueDate, dueTime: null, classId: null, notes: '', completed: false, ...extra }, entity: { id: title, kind: 'task', version: 1, data: {}, deleted: false } as TaskItem['entity'] });
const context = (today: string) => ({ today, nowTime: '15:00', schedule: exampleSchedule, personal: examplePersonalSchedule });
const titles = (list: Array<{ item: TaskItem }>) => list.map((entry) => entry.item.task.title);

describe('Do now', () => {
  it('puts overdue work first, then today, then the next school day, then high priority due soon', () => {
    const today = '2026-09-24';
    const list = doNow([
      item('Reading due next week', addDays(today, 7)),
      item('Essay due in 3 days', addDays(today, 3), { priority: 'high' }),
      item('Worksheet tomorrow', addDays(today, 1)),
      item('Quiz today', today, { priority: 'high' }),
      item('Late lab', addDays(today, -1)),
      item('Notes today', today),
      item('Done today', today, { completed: true }),
      item('Undated', null),
    ], context(today));
    expect(list.map((entry) => [entry.item.task.title, entry.reason])).toEqual([
      ['Late lab', 'Overdue'], ['Quiz today', 'Due today'], ['Notes today', 'Due today'],
      ['Worksheet tomorrow', 'Due tomorrow'], ['Essay due in 3 days', 'High priority, due in 3 days'],
    ]);
  });

  it('reaches over the weekend to Monday, keeps low priority out until it is due today, and stops at five', () => {
    const friday = '2026-09-25';
    expect(titles(doNow([item('Monday homework', '2026-09-28'), item('Optional thing Monday', '2026-09-28', { priority: 'low' }), item('Low today', friday, { priority: 'low' })], context(friday))))
      .toEqual(['Low today', 'Monday homework']);
    expect(doNow(Array.from({ length: 8 }, (_, index) => item(`Late ${index}`, addDays(friday, -1 - index))), context(friday))).toHaveLength(5);
  });
});

describe('Upcoming tests and quizzes', () => {
  it('matches assessment words but not retests marked optional or words that only contain them', () => {
    for (const title of ['Unit 2 Test', 'Gas Law Quiz', 'ENGLISH QUIZ - RHETORICAL DEVICES', 'Quiz Unidad 1 presente de indicativo', 'Midterm exam', 'Prueba de vocabulario', 'Final']) expect(isAssessment(title)).toBe(true);
    for (const title of ['Unit 1 Retest (optional)', 'Optional practice quiz', 'Contest entry', 'Lab 2', 'Testing kit sign-up']) expect(isAssessment(title)).toBe(false);
  });

  it('lists what the AI called a test or quiz in the next three weeks, in date order with a countdown', () => {
    const today = '2026-09-24';
    const items = [
      item('Unit 3 Test', addDays(today, 25)),
      item('Gas Law Quiz', addDays(today, 1)),
      item('Old quiz', addDays(today, -2)),
      item('Chapter 7 assessment', addDays(today, 6)),
      item('Unit 2 review sheet', addDays(today, 5)),
      item('Spanish quiz', today),
      item('Finished quiz', addDays(today, 2), { completed: true }),
    ];
    // The AI decides: the review sheet is not a test, the oddly named assessment is, and an unchecked task waits.
    const ai: Record<string, 'test' | 'quiz' | 'none'> = { 'Gas Law Quiz': 'quiz', 'Chapter 7 assessment': 'test', 'Unit 2 review sheet': 'none', 'Unit 3 Test': 'test', 'Old quiz': 'quiz' };
    const list = upcomingAssessments(items, { today }, (entry) => ai[entry.task.title]);
    expect(list.map((entry) => [entry.item.task.title, entry.kind, entry.when])).toEqual([['Gas Law Quiz', 'quiz', 'Tomorrow'], ['Chapter 7 assessment', 'test', 'In 6 days']]);
    // Without the AI, the title fallback still finds the obvious ones.
    expect(upcomingAssessments(items, { today }, keywordKind).map((entry) => [entry.item.task.title, entry.kind])).toEqual([['Spanish quiz', 'quiz'], ['Gas Law Quiz', 'quiz'], ['Chapter 7 assessment', 'test']]);
  });
});
