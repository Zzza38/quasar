import { describe, expect, it } from 'vitest';
import { importedEventOnDate } from './imported-events';
import type { TaskItem } from './app-state';
import type { Task } from '@/domain/task';

function item(imported: Partial<NonNullable<Task['imported']>> = {}): TaskItem {
  const task: Task = { title: 'Homework', notes: '', completed: false, dueDate: '2026-09-11', dueTime: null, classId: null, imported: {
    subscriptionId: 'feed', uid: 'event', recurrenceId: null, startDate: '2026-09-11', startTime: null, endDate: '2026-09-13', endTime: null, timeZone: 'America/New_York', allDay: true, sourceRemoved: false, sourceUpdatedAt: '2026-09-11T00:00:00Z', ...imported,
  } };
  return { id: 'task', task, entity: { id: 'task', kind: 'task', version: 1, deleted: false, data: task } };
}

describe('imported calendar day placement', () => {
  it('shows all-day spans through the day before the exclusive end regardless of display time zone', () => {
    expect(importedEventOnDate(item(), '2026-09-10', 'Pacific/Honolulu')).toBe(false);
    expect(importedEventOnDate(item(), '2026-09-11', 'Pacific/Honolulu')).toBe(true);
    expect(importedEventOnDate(item(), '2026-09-12', 'Pacific/Honolulu')).toBe(true);
    expect(importedEventOnDate(item(), '2026-09-13', 'Pacific/Honolulu')).toBe(false);
  });
  it('places timed events in the viewing time zone and excludes a midnight end', () => {
    const event = item({ allDay: false, startTime: '01:00', endDate: '2026-09-11', endTime: '03:00' });
    expect(importedEventOnDate(event, '2026-09-10', 'America/Los_Angeles')).toBe(true);
    expect(importedEventOnDate(event, '2026-09-11', 'America/Los_Angeles')).toBe(false);
  });
  it('places an instant with no end on only its local date', () => {
    const event = item({ allDay: false, startTime: '01:00', endDate: null });
    expect(importedEventOnDate(event, '2026-09-10', 'America/Los_Angeles')).toBe(true);
    expect(importedEventOnDate(event, '2026-09-11', 'America/Los_Angeles')).toBe(false);
  });
  it('keeps completed and source-removed items on the calendar', () => {
    const event = item({ sourceRemoved: true });
    event.task.completed = true;
    expect(importedEventOnDate(event, '2026-09-11', 'UTC')).toBe(true);
  });
  it('uses actual day boundaries across daylight saving changes', () => {
    const event = item({ allDay: false, startDate: '2026-03-08', startTime: '23:30', endDate: '2026-03-09', endTime: '00:00' });
    expect(importedEventOnDate(event, '2026-03-08', 'America/New_York')).toBe(true);
    expect(importedEventOnDate(event, '2026-03-09', 'America/New_York')).toBe(false);
  });
});
