'use client';

import type { ReactNode } from 'react';
import type { Task } from '@/domain/task';
import { formatDate, formatDateTime, reminderLabel } from '@/lib/format';
import type { AppState } from './app-state';
import { Hint } from './primitives';

/** Read-only task details from a merge's saved originals or the current kept task. */
export function MergeTaskDetails({ label, task, origin, state, previous }: {
  label: string; task: Task | null; origin: string; state: AppState; previous?: Task | null;
}) {
  const changed = (key: keyof Task) => !!previous && JSON.stringify(task?.[key]) !== JSON.stringify(previous[key]);
  const field = (label: string, value: ReactNode, key?: keyof Task | (keyof Task)[]) => <div className="grid min-w-0 gap-1">
    <dt className="text-xs font-medium text-muted-foreground">{label}{key && (Array.isArray(key) ? key.some(changed) : changed(key)) && <span className="ml-2 text-primary">Changed</span>}</dt>
    <dd className="min-w-0 whitespace-pre-wrap break-words text-sm [overflow-wrap:anywhere]">{value}</dd>
  </div>;
  const dateTime = (iso: string) => new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: state.timeZone }).format(new Date(iso));
  return <section aria-label={label} className="grid min-w-0 content-start gap-4 rounded-xl border bg-card p-4">
    <h4 className="text-sm font-bold">{label}</h4>
    {!task ? <Hint>These saved task details could not be read.</Hint> : <dl className="grid min-w-0 gap-4">
      {field('Title', task.title, 'title')}
      <div className="grid grid-cols-2 gap-4">
        {field('Class', state.personal.classes.find(cls => cls.id === task.classId)?.name ?? (task.classId ? 'Class no longer available' : 'No class'), 'classId')}
        {field('Due', task.dueDate ? formatDateTime(task.dueDate, task.dueTime) : 'No due date', ['dueDate', 'dueTime'])}
        {field('Priority', task.priority ? task.priority[0].toUpperCase() + task.priority.slice(1) : 'Normal', 'priority')}
        {field('Status', task.completed ? 'Completed' : 'Not completed', 'completed')}
      </div>
      {task.completedAt && field('Completed at', dateTime(task.completedAt), 'completedAt')}
      {field('Work happens', task.workLocation ? `${task.workLocation === 'in-class' ? 'In class' : 'Out of class'}${task.workLocationSource === 'ai' ? ' · Labeled by AI' : ''}` : 'Not labeled', ['workLocation', 'workLocationSource'])}
      {field('Notes', task.notes || 'No notes', 'notes')}
      {field('Checklist', task.subtasks?.length ? <ul className="grid gap-2">{task.subtasks.map(step => <li key={step.id} className="flex items-start gap-2">
        <span className="shrink-0 text-xs text-muted-foreground">{step.completed ? 'Done' : 'To do'}</span><span>{step.title}</span>
      </li>)}</ul> : 'No checklist steps', 'subtasks')}
      {field('Reminder', task.reminder ? `${reminderLabel(task.reminder.minutesBefore)} · ${task.reminder.timeZone}` : 'No reminder', 'reminder')}
      {field('Repeats', task.recurrence ? `Every ${task.recurrence.interval} ${task.recurrence.frequency === 'daily' ? 'day' : task.recurrence.frequency === 'weekly' ? 'week' : 'month'}${task.recurrence.interval === 1 ? '' : 's'}${task.recurrence.until ? ` until ${formatDate(task.recurrence.until)}` : ', with no end date'}` : 'Does not repeat', 'recurrence')}
      {task.recurrence?.anchorDate && field('Repeat starts from', formatDate(task.recurrence.anchorDate))}
      {field('Source', origin)}
      {task.imported && <>
        {field('Source link', task.imported.url ? <a className="text-primary underline underline-offset-2" href={task.imported.url} target="_blank" rel="noreferrer">{task.imported.url}</a> : 'No source link')}
        {field('Calendar event', `${formatDateTime(task.imported.startDate, task.imported.startTime)}${task.imported.endDate ? ` to ${formatDateTime(task.imported.endDate, task.imported.endTime)}` : ''}${task.imported.allDay ? ' · All day' : ''}`)}
        {field('Calendar time zone', task.imported.timeZone)}
        {field('Calendar status', task.imported.sourceRemoved ? 'Removed from the source calendar' : 'Linked to the source calendar')}
        {field('Last source update', dateTime(task.imported.sourceUpdatedAt))}
        {field('Calendar event ID', task.imported.uid)}
        {task.imported.recurrenceId && field('Calendar occurrence', task.imported.recurrenceId)}
      </>}
    </dl>}
  </section>;
}
