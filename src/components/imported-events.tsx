'use client';

import { useMemo, useState } from 'react';
import { Temporal } from '@js-temporal/polyfill';
import { errorMessage } from '@/client/api';
import { addDays, formatDate, formatRange, formatTime } from '@/lib/format';
import { taskItems, type AppState, type TaskItem } from './app-state';
import { Chip, ErrorText } from './ui';

/** Event ends are exclusive, including all-day and midnight endings. */
export function importedEventOnDate(item: TaskItem, date: string, timeZone: string): boolean {
  const source = item.task.imported;
  if (!source) return false;
  const startDate = source.startDate ?? item.task.dueDate;
  if (!startDate) return false;
  if (source.allDay) return date >= startDate && date < (source.endDate && source.endDate > startDate ? source.endDate : addDays(startDate, 1));
  try {
    const start = Temporal.PlainDateTime.from(`${startDate}T${source.startTime ?? item.task.dueTime ?? '00:00'}`).toZonedDateTime(source.timeZone);
    const end = source.endDate ? Temporal.PlainDateTime.from(`${source.endDate}T${source.endTime ?? '00:00'}`).toZonedDateTime(source.timeZone) : start;
    const dayStart = Temporal.PlainDate.from(date).toZonedDateTime(timeZone);
    const dayEnd = dayStart.add({ days: 1 });
    return Temporal.ZonedDateTime.compare(start, dayEnd) < 0 && (Temporal.ZonedDateTime.compare(end, start) > 0 ? Temporal.ZonedDateTime.compare(end, dayStart) > 0 : Temporal.ZonedDateTime.compare(start, dayStart) >= 0);
  } catch { return date === startDate; }
}

function eventTime(item: TaskItem, timeZone: string): string {
  const source = item.task.imported!;
  if (source.allDay) return 'All day';
  try {
    const start = Temporal.PlainDateTime.from(`${source.startDate}T${source.startTime ?? '00:00'}`).toZonedDateTime(source.timeZone).withTimeZone(timeZone);
    const startTime = start.toPlainTime().toString().slice(0, 5);
    if (!source.endDate) return formatTime(startTime);
    const end = Temporal.PlainDateTime.from(`${source.endDate}T${source.endTime ?? '00:00'}`).toZonedDateTime(source.timeZone).withTimeZone(timeZone);
    const endTime = end.toPlainTime().toString().slice(0, 5);
    return start.toPlainDate().equals(end.toPlainDate()) ? formatRange(startTime, endTime) : `${formatDate(start.toPlainDate().toString())}, ${formatTime(startTime)} – ${formatDate(end.toPlainDate().toString())}, ${formatTime(endTime)}`;
  } catch { return source.startTime ? formatTime(source.startTime) : 'All day'; }
}

export function ImportedEvents({ state, date }: { state: AppState; date: string }) {
  const items = useMemo(() => taskItems(state.snapshot.entities).filter((item) => importedEventOnDate(item, date, state.timeZone)).sort((a, b) => Number(Boolean(b.task.imported?.allDay)) - Number(Boolean(a.task.imported?.allDay)) || `${a.task.imported?.startDate}T${a.task.imported?.startTime ?? ''}`.localeCompare(`${b.task.imported?.startDate}T${b.task.imported?.startTime ?? ''}`)), [state.snapshot.entities, date, state.timeZone]);
  const [pending, setPending] = useState<string[]>([]);
  const [error, setError] = useState('');
  if (items.length === 0) return null;
  return <div className="grid gap-2 pt-3 border-t border-border" aria-label="Imported calendar entries">
    <h3 className="text-[13px] uppercase tracking-wide text-text-3 font-bold">From your calendars</h3>
    <ul className="grid gap-2">{items.map((item) => {
      const source = item.task.imported!;
      const feed = state.context.subscriptions?.find((entry) => entry.id === source.subscriptionId);
      return <li key={item.id} className={`panel p-3 flex items-start gap-3${item.task.completed ? ' opacity-60' : ''}`}>
        <input type="checkbox" className="mt-1" checked={item.task.completed} disabled={pending.includes(item.id)} aria-label={`${item.task.completed ? 'Mark incomplete' : 'Complete'}: ${item.task.title}`} onChange={(event) => {
          const completed = event.target.checked;
          setError(''); setPending((value) => [...value, item.id]);
          void state.saveTask(item.id, { ...item.task, completed }).catch((err) => setError(errorMessage(err))).finally(() => setPending((value) => value.filter((id) => id !== item.id)));
        }} />
        <div className="min-w-0 flex-1 grid gap-1">
          <button type="button" className={`text-sm text-left font-semibold break-words${item.task.completed ? ' line-through text-text-3' : ''}`} onClick={() => state.navigate('tasks', { edit: item.id })}>{item.task.title}</button>
          <p className="text-sm text-text-2 tabular">{eventTime(item, state.timeZone)}</p>
          <div className="flex gap-1.5 flex-wrap"><Chip icon="calendar">{feed?.name ?? 'Imported calendar'}</Chip>{item.task.completed && <Chip>Completed</Chip>}{source.sourceRemoved && <Chip tone="warning">Removed from source</Chip>}</div>
        </div>
      </li>;
    })}</ul>
    <ErrorText>{error}</ErrorText>
  </div>;
}
