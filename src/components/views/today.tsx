'use client';

import { useMemo, useState } from 'react';
import { errorMessage } from '@/client/api';
import { nextClass, resolveDay } from '@/domain/schedule';
import { addDays, classColor, daysBetween, formatMinutes, formatRange, formatTime, minutesUntil, relativeDate, formatDate } from '@/lib/format';
import type { AppState } from '../app-state';
import { sortByDue, taskItems } from '../app-state';
import { Icon } from '../icon';
import { Button, Chip, ColorDot, EmptyState, Input } from '../ui';

function greeting(now: Date, timeZone: string): string {
  const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', hour12: false }).format(now));
  return hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
}

export function TodayView({ state }: { state: AppState }) {
  const { schedule, personal, now, today, timeZone, context } = state;
  const next = useMemo(() => nextClass(schedule, now, personal), [schedule, now, personal]);
  const following = useMemo(() => next?.status === 'current' ? nextClass(schedule, next.endAt, personal) : null, [schedule, next, personal]);
  const day = useMemo(() => { try { return resolveDay(schedule, today, personal); } catch { return null; } }, [schedule, today, personal]);
  const nextSchoolDay = useMemo(() => {
    if (!day || !day.closed) return null;
    for (let offset = 1; offset <= 60; offset += 1) { const date = addDays(today, offset); const resolved = resolveDay(schedule, date, personal); if (!resolved.closed && resolved.periods.length > 0) return { date, resolved }; }
    return null;
  }, [day, schedule, today, personal]);
  const tasks = useMemo(() => sortByDue(taskItems(state.snapshot.entities).filter((item) => !item.task.completed)), [state.snapshot.entities]);
  const dueSoon = tasks.filter((item) => !item.task.dueDate || daysBetween(today, item.task.dueDate) <= 2);
  const shown = dueSoon.slice(0, 6);
  const hasSetup = personal.classes.length > 0;

  return <div className="grid gap-5 fade-in">
    <header className="flex items-end justify-between gap-3 flex-wrap">
      <div>
        <p className="text-sm text-text-2">{formatDate(today, { weekday: 'long', year: true })}</p>
        <h1>{greeting(now, timeZone)}, {context.user.displayName}</h1>
      </div>
      {day && !day.closed && <Chip tone="accent" icon="layers">{day.cycleDayLabel}</Chip>}
      {day?.closed && <Chip icon="coffee">No school today</Chip>}
    </header>

    <NowCard next={next} following={following} now={now} today={today} onSetup={() => state.navigate('classes')} hasSetup={hasSetup} noSchedule={schedule.cycleDays.every((entry) => entry.slots.length === 0)} />

    <div className="grid gap-5 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] items-start">
      <section className="card card-pad grid gap-3" aria-labelledby="today-timeline">
        <div className="flex items-center justify-between gap-2"><h2 id="today-timeline" className="text-[17px]">Today</h2><Button size="sm" variant="ghost" iconRight="arrowRight" onClick={() => state.navigate('schedule')}>Full schedule</Button></div>
        {day?.closed && <div className="py-4 grid gap-1">
          <p className="text-text-2 text-sm">No periods today.</p>
          {nextSchoolDay && <p className="text-sm">Next school day: <button type="button" className="text-accent font-medium" onClick={() => state.navigate('schedule', { date: nextSchoolDay.date })}>{relativeDate(nextSchoolDay.date, today, { weekday: 'long' })}</button> · {nextSchoolDay.resolved.cycleDayLabel}</p>}
        </div>}
        {day && !day.closed && day.periods.length === 0 && <p className="text-text-2 text-sm py-4">No periods on this day.</p>}
        {day && day.periods.length > 0 && <Timeline periods={day.periods} now={now} />}
        {day && day.issues.length > 0 && <p className="hint" style={{ color: 'var(--danger-text)' }}>{day.issues.length} period(s) could not be shown because of a time adjustment. Review them under Classes.</p>}
      </section>

      <section className="card card-pad grid gap-3" aria-labelledby="today-tasks">
        <div className="flex items-center justify-between gap-2"><h2 id="today-tasks" className="text-[17px]">Up next{tasks.length > 0 && <span className="ml-2 chip">{tasks.length}</span>}</h2><Button size="sm" variant="ghost" iconRight="arrowRight" onClick={() => state.navigate('tasks')}>All tasks</Button></div>
        <QuickAdd onAdd={(title) => state.saveTask(crypto.randomUUID(), { title, dueDate: null, dueTime: null, classId: null, notes: '', completed: false })} />
        {shown.length === 0 && <EmptyState icon="checkCircle" title="Nothing due soon">Add anything you need to get done. Homework, forms, practice.</EmptyState>}
        {shown.length > 0 && <ul className="grid">{shown.map((item) => <TaskRow key={item.id} item={item} state={state} />)}</ul>}
        {dueSoon.length > shown.length && <Button variant="ghost" size="sm" onClick={() => state.navigate('tasks')}>{dueSoon.length - shown.length} more</Button>}
      </section>
    </div>
  </div>;
}

function NowCard({ next, following, now, today, onSetup, hasSetup, noSchedule }: { next: ReturnType<typeof nextClass>; following: ReturnType<typeof nextClass>; now: Date; today: string; onSetup: () => void; hasSetup: boolean; noSchedule: boolean }) {
  if (!next) return <section className="card card-pad grid gap-2" aria-label="Next class">
    <div className="eyebrow">Up next</div>
    <h2>{noSchedule ? 'Your schedule has no periods yet' : 'No upcoming periods'}</h2>
    <p className="text-sm text-text-2">{noSchedule ? 'Add periods to the school schedule or build a private one.' : 'Nothing is scheduled for the next year.'}</p>
  </section>;
  const current = next.status === 'current';
  const until = current ? minutesUntil(next.endAt, now) : minutesUntil(next.startAt, now);
  const total = current ? Math.max(1, minutesUntil(next.endAt, new Date(next.startAt))) : 0;
  const elapsed = current ? Math.min(total, Math.max(0, total - until)) : 0;
  const name = next.class?.name ?? next.label;
  const color = classColor(next.class?.id, next.kind, next.class?.color);
  const when = next.date === today ? (current ? `Ends in ${formatMinutes(until)}` : until < 60 * 12 ? `Starts in ${formatMinutes(until)}` : `Today at ${formatTime(next.start)}`) : `${relativeDate(next.date, today, { weekday: 'long' })} at ${formatTime(next.start)}`;
  return <section className="card overflow-hidden text-white" style={{ background: `linear-gradient(135deg, ${color.dot}, color-mix(in srgb, ${color.dot} 70%, #111))`, borderColor: 'transparent' }} aria-label="Next class">
    <div className="card-pad grid gap-3">
      <div className="flex items-center justify-between gap-2">
        <span className="eyebrow" style={{ color: 'rgb(255 255 255 / .8)' }}>{current ? 'Right now' : 'Up next'}</span>
        <span className="text-sm font-semibold tabular" style={{ color: 'rgb(255 255 255 / .9)' }}>{when}</span>
      </div>
      <div>
        <h2 className="text-[30px] leading-tight">{name}</h2>
        <p className="mt-1 text-[15px]" style={{ color: 'rgb(255 255 255 / .85)' }}>
          <span className="tabular">{formatRange(next.start, next.end)}</span>
          {next.class && next.class.name !== next.label ? ` · ${next.label}` : ''}
          {next.class?.room ? ` · Room ${next.class.room}` : ''}
          {next.class?.teacher ? ` · ${next.class.teacher}` : ''}
        </p>
      </div>
      {current && <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={elapsed} aria-label="Period progress"><span style={{ width: `${(elapsed / total) * 100}%` }} /></div>}
      <div className="flex items-center justify-between gap-2 flex-wrap text-sm" style={{ color: 'rgb(255 255 255 / .85)' }}>
        <span>{following ? <>Then <strong className="text-white">{following.class?.name ?? following.label}</strong> at <span className="tabular">{formatTime(following.start)}</span>{following.date !== next.date ? ` ${relativeDate(following.date, today)}` : ''}</> : current ? 'Last period of the day' : `${next.cycleDayLabel}`}</span>
        {!hasSetup && !next.class && next.kind === 'class' && <button type="button" className="underline underline-offset-2 font-medium text-white" onClick={onSetup}>Add your classes</button>}
      </div>
    </div>
  </section>;
}

export function Timeline({ periods, now, compact }: { periods: ReturnType<typeof resolveDay>['periods']; now: Date; compact?: boolean }) {
  const nowMs = now.getTime();
  return <ol className="timeline">
    {periods.map((period) => {
      const start = new Date(period.startAt).getTime();
      const end = new Date(period.endAt).getTime();
      const status = nowMs >= end ? 'past' : nowMs >= start ? 'now' : 'future';
      const color = classColor(period.class?.id, period.kind, period.class?.color);
      return <li key={period.slotId} className={`timeline-row ${status}`}>
        <div className="timeline-time"><strong>{formatTime(period.start)}</strong>{!compact && <span>{formatTime(period.end)}</span>}</div>
        <div className="timeline-body">
          <span className="color-bar" style={{ background: color.dot }} />
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap"><strong className="text-[15px]">{period.class?.name ?? period.label}</strong>{status === 'now' && <Chip tone="now">Now</Chip>}{period.kind === 'lunch' && !period.class && <Icon name="coffee" size={14} className="text-text-3" />}</div>
            <div className="hint">{[period.class && period.class.name !== period.label ? period.label : null, period.class?.room && `Room ${period.class.room}`, period.class?.teacher].filter(Boolean).join(' · ') || (period.kind === 'class' && !period.class ? 'No class assigned' : ' ')}</div>
          </div>
        </div>
      </li>;
    })}
  </ol>;
}

export function QuickAdd({ onAdd, placeholder = 'Add a task and press Enter' }: { onAdd: (title: string) => Promise<void>; placeholder?: string }) {
  const [title, setTitle] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  return <form className="grid gap-1" onSubmit={async (event) => {
    event.preventDefault();
    const trimmed = title.trim();
    if (!trimmed) return;
    setPending(true); setError('');
    try { await onAdd(trimmed); setTitle(''); } catch (err) { setError(errorMessage(err)); } finally { setPending(false); }
  }}>
    <div className="flex gap-2">
      <Input aria-label="New task" placeholder={placeholder} maxLength={300} value={title} disabled={pending} onChange={(event) => setTitle(event.target.value)} />
      <Button type="submit" variant="primary" icon="plus" aria-label="Add task" busy={pending} disabled={!title.trim()} />
    </div>
    {error && <span className="hint" style={{ color: 'var(--danger-text)' }} role="alert">{error}</span>}
  </form>;
}

export function TaskRow({ item, state, showDate = true }: { item: ReturnType<typeof taskItems>[number]; state: AppState; showDate?: boolean }) {
  const [error, setError] = useState('');
  const { task } = item;
  const cls = state.personal.classes.find((entry) => entry.id === task.classId);
  const overdue = task.dueDate && !task.completed && (task.dueDate < state.today || (task.dueDate === state.today && task.dueTime !== null && task.dueTime < new Intl.DateTimeFormat('en-GB', { timeZone: state.timeZone, hour: '2-digit', minute: '2-digit', hour12: false }).format(state.now)));
  return <li className={`task-row${task.completed ? ' done' : ''}`}>
    <input type="checkbox" className="task-check" checked={task.completed} aria-label={`Mark ${task.title} ${task.completed ? 'incomplete' : 'complete'}`} onChange={async (event) => { setError(''); try { await state.saveTask(item.id, { ...task, completed: event.target.checked }); } catch (err) { setError(errorMessage(err)); } }} />
    <button type="button" className="min-w-0 flex-1 text-left grid gap-0.5" onClick={() => state.navigate('tasks', { edit: item.id })} aria-label={`Edit ${task.title}`}>
      <span className="task-title text-[15px] font-medium">{task.title}</span>
      {(task.dueDate || cls || task.notes || task.priority || task.subtasks?.length || task.recurrence || task.imported || task.reminder) && <span className="hint flex items-center gap-2 flex-wrap">
        {showDate && task.dueDate && <span style={overdue ? { color: 'var(--danger-text)', fontWeight: 600 } : undefined}>{overdue ? 'Overdue · ' : ''}{relativeDate(task.dueDate, state.today)}{task.dueTime ? ` · ${formatTime(task.dueTime)}` : ''}</span>}
        {cls && <span className="inline-flex items-center gap-1.5"><ColorDot color={classColor(cls.id, 'class', cls.color).dot} size={8} />{cls.name}</span>}
        {task.priority && task.priority !== 'normal' && <span style={task.priority === 'high' ? { color: 'var(--danger-text)' } : undefined}>{task.priority === 'high' ? 'High priority' : 'Low priority'}</span>}
        {!!task.subtasks?.length && <span>{task.subtasks.filter(entry => entry.completed).length}/{task.subtasks.length} checklist</span>}
        {task.recurrence && <span>Repeats {task.recurrence.frequency}</span>}
        {task.reminder && <span>Reminder</span>}
        {task.imported && <span>{task.imported.sourceRemoved ? 'Calendar · source removed' : 'Calendar'}</span>}
        {task.notes && <Icon name="edit" size={12} className="text-text-3" />}
      </span>}
      {error && <span className="hint" style={{ color: 'var(--danger-text)' }} role="alert">{error}</span>}
    </button>
  </li>;
}
