import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { exampleSchedule, examplePersonalSchedule } from '@/domain/example';
import { describe, expect, it } from 'vitest';
import { ClassAssignmentGrid, describePendingChange, queuePendingChange, type PendingChange } from './class-assignment-grid';

const noop = () => {};

describe('waiting private-copy confirmations', () => {
  it('keeps a pending rename when the click that blurred it adds a day, and confirming runs both', () => {
    const ran: string[] = [];
    const rename: PendingChange = { kind: 'copy', actions: ['Renaming a day'], runs: [() => ran.push('rename')] };
    const add: PendingChange = { kind: 'copy', actions: ['Adding a day'], runs: [() => ran.push('add')] };
    const queue = queuePendingChange(queuePendingChange([], rename), add);
    expect(queue).toHaveLength(1);
    for (const run of queue[0].runs) run();
    expect(ran).toEqual(['rename', 'add']);
    expect(describePendingChange(queue[0])).toEqual({
      title: 'Make your own copy of the timetable?',
      body: 'Renaming a day and adding a day make your own copy of the timetable. School corrections, such as new bell times, will no longer reach you.',
      confirmLabel: 'Make my own copy',
    });
  });

  it('words a single edit and names each kind of edit only once', () => {
    const one: PendingChange = { kind: 'copy', actions: ['Placing this class'], runs: [noop] };
    expect(describePendingChange(one).body).toMatch(/^Placing this class makes your own copy/);
    const queue = [one, { ...one }, { kind: 'copy' as const, actions: ['Removing a day'], runs: [noop] }, { kind: 'copy' as const, actions: ['Adding a day'], runs: [noop] }]
      .reduce<PendingChange[]>(queuePendingChange, []);
    expect(queue[0].runs).toHaveLength(4);
    expect(describePendingChange(queue[0]).body).toMatch(/^Placing this class, removing a day and adding a day make your own copy/);
  });

  it('asks about each day removed from a private copy in turn, once per day', () => {
    const remove = (dayId: string, label: string): PendingChange => ({ kind: 'remove', dayId, label, runs: [noop] });
    const queue = [remove('day-2', 'Day 2'), remove('day-3', 'Day 3'), remove('day-2', 'Day 2')].reduce<PendingChange[]>(queuePendingChange, []);
    expect(queue.map((entry) => entry.kind === 'remove' && entry.dayId)).toEqual(['day-2', 'day-3']);
    expect(describePendingChange(queue[0])).toEqual({ title: 'Remove Day 2 from your private rotation?', body: 'Dates will be recalculated across the remaining days.', confirmLabel: 'Remove day' });
  });
});


describe('school-following controls', () => {
  const grid = (personal = examplePersonalSchedule) => createElement(ClassAssignmentGrid, { schedule: exampleSchedule, schoolSchedule: exampleSchedule, personal, save: async () => {}, onSchoolCorrection: noop });

  it('hides structure controls while following school and retains bell-time editing', () => {
    const html = renderToStaticMarkup(grid());
    expect(html).not.toContain('aria-label="Day 1 name"');
    expect(html).not.toContain('aria-label="Remove Day 1"');
    expect(html).not.toContain('Add rotation day');
    expect(html).toContain('Edit times');
  });

  it('keeps private schedule management available', () => {
    const html = renderToStaticMarkup(grid({ ...examplePersonalSchedule, customSchedule: exampleSchedule }));
    expect(html).toContain('aria-label="Day 1 name"');
    expect(html).toContain('Add rotation day');
  });

  it('disables assignments and bell-time editing together when locked', () => {
    const html = renderToStaticMarkup(createElement(ClassAssignmentGrid, { schedule: exampleSchedule, personal: examplePersonalSchedule, save: async () => {}, onSchoolCorrection: noop, disabled: true }));
    const placement = html.match(/<button[^>]*aria-label="Place Algebra"[^>]*>/)?.[0];
    const times = html.match(/<button[^>]*>Edit times/)?.[0];
    const resize = html.match(/<button[^>]*aria-label="Resize [^"]*"[^>]*>/g) ?? [];
    expect(placement).toContain('disabled=""');
    expect(times).toContain('disabled=""');
    expect(resize.length).toBeGreaterThan(0);
    expect(resize.every(button => button.includes('disabled=""'))).toBe(true);
  });
});
