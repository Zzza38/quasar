'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { errorMessage } from '@/client/api';
import { nextClass, resolveDay } from '@/domain/schedule';
import { addDays, classColor, daysBetween, formatMinutes, formatRange, formatSeconds, formatTime, minutesUntil, relativeDate, formatDate } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { AppState } from '../app-state';
import { sortByDue, taskItems } from '../app-state';
import { Icon } from '../icon';
import { Button, Chip, ColorDot, EmptyState, Eyebrow, Hint, Input, Section } from '../primitives';
import { Card, CardContent } from '../ui/card';
import { Checkbox } from '../ui/checkbox';
import { Progress } from '../ui/progress';

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

  return <div className="grid gap-5 animate-in fade-in-0 duration-200">
    <header className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <p className="text-sm text-muted-foreground">{formatDate(today, { weekday: 'long', year: true })}</p>
        <h1>{greeting(now, timeZone)}, {context.user.displayName}</h1>
      </div>
      {day && !day.closed && <Chip tone="accent" icon="layers">{day.cycleDayLabel}</Chip>}
      {day?.closed && <Chip icon="coffee">No school today</Chip>}
    </header>

    <NowCard next={next} following={following} now={now} today={today} onSetup={() => state.navigate('classes')} hasSetup={hasSetup} noSchedule={schedule.cycleDays.every((entry) => entry.slots.length === 0)} />

    <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
      <Section title="Today" id="today-timeline" aria-labelledby="today-timeline" action={<Button size="sm" variant="ghost" iconRight="arrowRight" onClick={() => state.navigate('schedule')}>Full schedule</Button>}>
        {day?.closed && <div className="grid gap-1 py-4">
          <p className="text-sm text-muted-foreground">No periods today.</p>
          {nextSchoolDay && <p className="text-sm">Next school day: <button type="button" className="font-medium text-primary hover:underline" onClick={() => state.navigate('schedule', { date: nextSchoolDay.date })}>{relativeDate(nextSchoolDay.date, today, { weekday: 'long' })}</button> · {nextSchoolDay.resolved.cycleDayLabel}</p>}
        </div>}
        {day && !day.closed && day.periods.length === 0 && <p className="py-4 text-sm text-muted-foreground">No periods on this day.</p>}
        {day && day.periods.length > 0 && <Timeline periods={day.periods} now={now} />}
        {day && day.issues.length > 0 && <Hint tone="danger">{day.issues.length} period(s) could not be shown because of a time adjustment. Review them under Classes.</Hint>}
      </Section>

      <Section title={<>Up next{tasks.length > 0 && <Chip className="ml-2 align-middle">{tasks.length}</Chip>}</>} id="today-tasks" aria-labelledby="today-tasks" action={<Button size="sm" variant="ghost" iconRight="arrowRight" onClick={() => state.navigate('tasks')}>All tasks</Button>}>
        <QuickAdd onAdd={(title) => state.saveTask(crypto.randomUUID(), { title, dueDate: null, dueTime: null, classId: null, notes: '', completed: false })} />
        {shown.length === 0 && <EmptyState icon="checkCircle" title="Nothing due soon">Add anything you need to get done. Homework, forms, practice.</EmptyState>}
        {shown.length > 0 && <ul className="grid">{shown.map((item) => <TaskRow key={item.id} item={item} state={state} />)}</ul>}
        {dueSoon.length > shown.length && <Button variant="ghost" size="sm" onClick={() => state.navigate('tasks')}>{dueSoon.length - shown.length} more</Button>}
      </Section>
    </div>
  </div>;
}

function NowCard({ next, following, now, today, onSetup, hasSetup, noSchedule }: { next: ReturnType<typeof nextClass>; following: ReturnType<typeof nextClass>; now: Date; today: string; onSetup: () => void; hasSetup: boolean; noSchedule: boolean }) {
  if (!next) return <Card aria-label="Next class"><CardContent className="grid gap-2">
    <Eyebrow>Up next</Eyebrow>
    <h2>{noSchedule ? 'Your schedule has no periods yet' : 'No upcoming periods'}</h2>
    <p className="text-sm text-muted-foreground">{noSchedule ? 'Add periods to the school schedule or build a private one.' : 'Nothing is scheduled for the next year.'}</p>
  </CardContent></Card>;
  const current = next.status === 'current';
  const until = current ? minutesUntil(next.endAt, now) : minutesUntil(next.startAt, now);
  const total = current ? Math.max(1, minutesUntil(next.endAt, new Date(next.startAt))) : 0;
  const elapsed = current ? Math.min(total, Math.max(0, total - until)) : 0;
  const name = next.class?.name ?? next.label;
  const color = classColor(next.class?.id, next.kind, next.class?.color);
  const countdown = next.date === today && (current || until < 60 * 12);
  const when = next.date === today ? `Today at ${formatTime(next.start)}` : `${relativeDate(next.date, today, { weekday: 'long' })} at ${formatTime(next.start)}`;
  return <Card className="text-white ring-0 shadow-lg" style={{ background: `linear-gradient(135deg, ${color.dot}, color-mix(in srgb, ${color.dot} 70%, #111))` }} aria-label="Next class">
    <CardContent className="grid gap-3 sm:px-5">
      <div className="flex items-center justify-between gap-2">
        <Eyebrow className="text-white/80">{current ? 'Right now' : 'Up next'}</Eyebrow>
        {countdown
          ? <Countdown label={current ? 'Ends in' : 'Starts in'} target={current ? next.endAt : next.startAt} minutes={until} />
          : <span className="text-sm font-semibold tabular-nums text-white/90">{when}</span>}
      </div>
      <div>
        <h2 className="text-[30px] leading-tight text-white">{name}</h2>
        <p className="mt-1 text-[15px] text-white/85">
          <span className="tabular-nums">{formatRange(next.start, next.end)}</span>
          {next.class && next.class.name !== next.label ? ` · ${next.label}` : ''}
          {next.class?.room ? ` · Room ${next.class.room}` : ''}
          {next.class?.teacher ? ` · ${next.class.teacher}` : ''}
        </p>
      </div>
      {current && <Progress value={(elapsed / total) * 100} aria-label="Period progress" aria-valuetext={`${elapsed} of ${total} minutes`} className="h-1.5 bg-white/25 *:data-[slot=progress-indicator]:bg-white *:data-[slot=progress-indicator]:transition-[transform] *:data-[slot=progress-indicator]:duration-1000 *:data-[slot=progress-indicator]:ease-linear" />}
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-white/85">
        <span>{following ? <>Then <strong className="text-white">{following.class?.name ?? following.label}</strong> at <span className="tabular-nums">{formatTime(following.start)}</span>{following.date !== next.date ? ` ${relativeDate(following.date, today)}` : ''}</> : current ? 'Last period of the day' : `${next.cycleDayLabel}`}</span>
        {!hasSetup && !next.class && next.kind === 'class' && <button type="button" className="font-medium text-white underline underline-offset-2" onClick={onSetup}>Add your classes</button>}
      </div>
    </CardContent>
  </Card>;
}

/**
 * "Ends in 8 min" that reveals seconds ("Ends in 8:23") while hovered, focused or
 * tapped. The shared leading text stays put; the differing tails slide open/closed.
 */
function Countdown({ label, target, minutes }: { label: string; target: string; minutes: number }) {
  const [hover, setHover] = useState(false);
  const [focus, setFocus] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [tick, setTick] = useState(() => Date.now());
  const precise = hover || focus || pinned;
  useEffect(() => {
    if (!precise) return;
    const timer = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [precise]);
  const seconds = precise ? Math.max(0, Math.round((new Date(target).getTime() - tick) / 1000)) : minutes * 60;
  const compact = formatMinutes(precise ? Math.floor(seconds / 60) : minutes);
  const exact = formatSeconds(seconds);
  let shared = 0;
  while (shared < compact.length && shared < exact.length && compact[shared] === exact[shared]) shared += 1;
  // Refresh the clock in the same event as the state change so the first precise frame is current.
  const show = (set: (value: boolean) => void, value: boolean) => () => { if (value) setTick(Date.now()); set(value); };
  return <button type="button" className="inline-flex cursor-pointer items-baseline whitespace-pre rounded-md text-sm font-semibold tabular-nums text-white/90 outline-none focus-visible:ring-2 focus-visible:ring-white/60"
    aria-label={precise ? `${label} ${exact} (${seconds >= 3600 ? 'hours, minutes and seconds' : 'minutes and seconds'})` : `${label} ${compact}`} aria-pressed={pinned} title={pinned ? 'Hide seconds' : 'Show seconds'}
    onPointerEnter={(event) => { if (event.pointerType !== 'touch') show(setHover, true)(); }} onPointerLeave={show(setHover, false)}
    onFocus={(event) => show(setFocus, event.currentTarget.matches(':focus-visible'))()} onBlur={show(setFocus, false)} onClick={show(setPinned, !pinned)}>
    <span aria-hidden="true">{label} {compact.slice(0, shared)}</span>
    <Reveal open={!precise}>{compact.slice(shared)}</Reveal>
    <Reveal open={precise}>{exact.slice(shared)}</Reveal>
  </button>;
}

/** Animates its text between zero and natural width. */
function Reveal({ open, children }: { open: boolean; children: ReactNode }) {
  return <span aria-hidden="true" className={cn('inline-grid transition-[grid-template-columns] duration-300 ease-out', open ? 'grid-cols-[1fr]' : 'grid-cols-[0fr]')}>
    <span className="min-w-0 overflow-hidden whitespace-pre">{children}</span>
  </span>;
}

export function Timeline({ periods, now, compact }: { periods: ReturnType<typeof resolveDay>['periods']; now: Date; compact?: boolean }) {
  const nowMs = now.getTime();
  return <ol className="grid gap-1">
    {periods.map((period) => {
      const start = new Date(period.startAt).getTime();
      const end = new Date(period.endAt).getTime();
      const status = nowMs >= end ? 'past' : nowMs >= start ? 'now' : 'future';
      const color = classColor(period.class?.id, period.kind, period.class?.color);
      return <li key={period.slotId} className={cn('grid grid-cols-[74px_1fr] items-stretch gap-3 rounded-xl px-2.5 py-2.5', status === 'now' && 'bg-now-soft', status === 'past' && 'opacity-55')}>
        <div className="grid content-start text-[13px] tabular-nums text-muted-foreground"><strong className="font-semibold text-foreground">{formatTime(period.start)}</strong>{!compact && <span>{formatTime(period.end)}</span>}</div>
        <div className="flex min-w-0 items-start gap-2.5">
          <span className="w-1 min-h-[34px] shrink-0 self-stretch rounded-full" style={{ background: color.dot }} />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2"><strong className="text-[15px] font-semibold">{period.class?.name ?? period.label}</strong>{status === 'now' && <Chip tone="now">Now</Chip>}{period.kind === 'lunch' && !period.class && <Icon name="coffee" size={14} className="text-muted-foreground" />}</div>
            <Hint>{[period.class && period.class.name !== period.label ? period.label : null, period.class?.room && `Room ${period.class.room}`, period.class?.teacher].filter(Boolean).join(' · ') || (period.kind === 'class' && !period.class ? 'No class assigned' : ' ')}</Hint>
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
    {error && <Hint tone="danger" role="alert">{error}</Hint>}
  </form>;
}

export function TaskRow({ item, state, showDate = true }: { item: ReturnType<typeof taskItems>[number]; state: AppState; showDate?: boolean }) {
  const [error, setError] = useState('');
  const { task } = item;
  const cls = state.personal.classes.find((entry) => entry.id === task.classId);
  const overdue = task.dueDate && !task.completed && (task.dueDate < state.today || (task.dueDate === state.today && task.dueTime !== null && task.dueTime < new Intl.DateTimeFormat('en-GB', { timeZone: state.timeZone, hour: '2-digit', minute: '2-digit', hour12: false }).format(state.now)));
  return <li className="flex items-start gap-3 rounded-xl px-2.5 py-3 transition-colors hover:bg-muted">
    <Checkbox className="mt-0.5 size-5 rounded-md [&_svg]:size-4" checked={task.completed} aria-label={`Mark ${task.title} ${task.completed ? 'incomplete' : 'complete'}`} onCheckedChange={async (checked) => { setError(''); try { await state.saveTask(item.id, { ...task, completed: checked === true }); } catch (err) { setError(errorMessage(err)); } }} />
    <button type="button" className="grid min-w-0 flex-1 gap-0.5 text-left" onClick={() => state.navigate('tasks', { edit: item.id })} aria-label={`Edit ${task.title}`}>
      <span className={cn('text-[15px] font-medium', task.completed && 'line-through text-muted-foreground')}>{task.title}</span>
      {(task.dueDate || cls || task.notes || task.priority || task.subtasks?.length || task.recurrence || task.imported || task.reminder) && <span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        {showDate && task.dueDate && <span className={cn(overdue && 'font-semibold text-destructive')}>{overdue ? 'Overdue · ' : ''}{relativeDate(task.dueDate, state.today)}{task.dueTime ? ` · ${formatTime(task.dueTime)}` : ''}</span>}
        {cls && <span className="inline-flex items-center gap-1.5"><ColorDot color={classColor(cls.id, 'class', cls.color).dot} size={8} />{cls.name}</span>}
        {task.priority && task.priority !== 'normal' && <span className={cn(task.priority === 'high' && 'text-destructive')}>{task.priority === 'high' ? 'High priority' : 'Low priority'}</span>}
        {!!task.subtasks?.length && <span>{task.subtasks.filter(entry => entry.completed).length}/{task.subtasks.length} checklist</span>}
        {task.recurrence && <span>Repeats {task.recurrence.frequency}</span>}
        {task.reminder && <span>Reminder</span>}
        {task.imported && <span>{task.imported.sourceRemoved ? 'Calendar · source removed' : 'Calendar'}</span>}
        {task.notes && <Icon name="edit" size={12} />}
      </span>}
      {error && <Hint tone="danger" role="alert">{error}</Hint>}
    </button>
  </li>;
}
