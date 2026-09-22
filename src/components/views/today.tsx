'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { errorMessage } from '@/client/api';
import { nextClass, resolveDay } from '@/domain/schedule';
import { addDays, classColor, daysBetween, formatMinutes, formatRange, formatSeconds, formatTime, minutesUntil, relativeDate, formatDate } from '@/lib/format';
import { classmatesFor, withLabel } from '@/lib/classmates';
import { cn } from '@/lib/utils';
import type { AppState } from '../app-state';
import { sortByDue, taskItems } from '../app-state';
import { Icon } from '../icon';
import { Button, Chip, ColorDot, EmptyState, Eyebrow, Hint, Input, Section, StatTile } from '../primitives';
import { buttonVariants } from '../ui/button';
import { SetupChecklist } from '../setup-checklist';
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
  const dueToday = tasks.filter((item) => item.task.dueDate && item.task.dueDate <= today).length;
  const periodsLeft = day && !day.closed ? day.periods.filter((period) => new Date(period.endAt).getTime() > now.getTime()).length : 0;
  const hasSetup = personal.classes.length > 0;
  const cycleIndex = day && !day.closed ? schedule.cycleDays.findIndex((entry) => entry.id === day.cycleDayId) : -1;

  return <div className="grid gap-5 animate-in fade-in-0 duration-300">
    <header className="flex flex-wrap items-end justify-between gap-3">
      <div className="grid gap-1">
        <Eyebrow>{formatDate(today, { weekday: 'long', year: true })}</Eyebrow>
        <h1 className="text-[30px] lg:text-[36px]">{greeting(now, timeZone)}, {context.user.displayName}</h1>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {day && !day.closed && <Chip tone="accent" icon="layers">{day.cycleDayLabel}</Chip>}
        {day?.closed && <Chip icon="coffee">No school today</Chip>}
      </div>
    </header>

    <SetupChecklist state={state} />

    <NowCard next={next} following={following} now={now} today={today} onSetup={() => state.navigate('classes')} onFixSchedule={() => state.navigate('school', { fix: 'times' })} hasSetup={hasSetup} noSchedule={schedule.cycleDays.every((entry) => entry.slots.length === 0)} />

    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
      <StatTile icon="tasks" tone={dueToday > 0 ? 'danger' : 'success'} value={dueToday} label={dueToday === 1 ? 'task due today' : 'tasks due today'} onClick={() => state.navigate('tasks')} />
      <StatTile icon="clock" tone="accent" value={periodsLeft} label={periodsLeft === 1 ? 'period left today' : 'periods left today'} onClick={() => state.navigate('schedule')} />
      <StatTile icon="layers" tone="now" className="max-sm:col-span-2" value={cycleIndex >= 0 ? `${cycleIndex + 1} of ${schedule.cycleDays.length}` : '-'} label={schedule.cycleDays.length > 1 ? 'rotation day' : 'daily schedule'} onClick={() => state.navigate('schedule')} />
    </div>

    <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
      <Section title="Today" id="today-timeline" aria-labelledby="today-timeline" description={day && !day.closed ? `${day.periods.length} periods · ${day.periods.length ? formatRange(day.periods[0].start, day.periods[day.periods.length - 1].end) : ''}` : undefined} action={<div className="flex flex-wrap gap-1">{day && !day.closed && day.periods.length > 0 && <Button size="sm" variant="ghost" onClick={() => state.navigate('school', { fix: 'times' })} title="Fix the shared bell schedule">Wrong time?</Button>}<Button size="sm" variant="ghost" iconRight="arrowRight" onClick={() => state.navigate('schedule')}>Full schedule</Button></div>}>
        {day?.closed && <div className="grid justify-items-start gap-2 py-3">
          <p className="text-sm text-muted-foreground">No periods today. Enjoy the day off.</p>
          {nextSchoolDay && <p className="text-sm">Next school day: <button type="button" className="font-semibold text-primary hover:underline" onClick={() => state.navigate('schedule', { date: nextSchoolDay.date })}>{relativeDate(nextSchoolDay.date, today, { weekday: 'long' })}</button> · {nextSchoolDay.resolved.cycleDayLabel}</p>}
        </div>}
        {day && !day.closed && day.periods.length === 0 && <p className="py-4 text-sm text-muted-foreground">No periods on this day.</p>}
        {day && day.periods.length > 0 && <Timeline periods={day.periods} now={now} timeZone={timeZone} tag={(period) => withLabel(classmatesFor(context, period.class?.name))} />}
        {day && day.issues.length > 0 && <Hint tone="danger">{day.issues.length} period(s) could not be shown because of a time adjustment. Review them under Classes.</Hint>}
      </Section>

      <Section title={<>Up next{tasks.length > 0 && <Chip className="ml-2 align-middle">{tasks.length}</Chip>}</>} id="today-tasks" aria-labelledby="today-tasks" action={<Button size="sm" variant="ghost" iconRight="arrowRight" onClick={() => state.navigate('tasks')}>All tasks</Button>}>
        <QuickAdd onAdd={(title) => state.saveTask(crypto.randomUUID(), { title, dueDate: null, dueTime: null, classId: null, notes: '', completed: false })} />
        {shown.length === 0 && <EmptyState icon="checkCircle" title="Nothing due soon">Add anything you need to get done. Homework, forms, practice.</EmptyState>}
        {shown.length > 0 && <ul className="grid gap-0.5">{shown.map((item) => <TaskRow key={item.id} item={item} state={state} />)}</ul>}
        {dueSoon.length > shown.length && <Button variant="ghost" size="sm" onClick={() => state.navigate('tasks')}>{dueSoon.length - shown.length} more</Button>}
      </Section>
    </div>
  </div>;
}

function NowCard({ next, following, now, today, onSetup, onFixSchedule, hasSetup, noSchedule }: { next: ReturnType<typeof nextClass>; following: ReturnType<typeof nextClass>; now: Date; today: string; onSetup: () => void; onFixSchedule: () => void; hasSetup: boolean; noSchedule: boolean }) {
  if (!next) return <Card aria-label="Next class"><CardContent className="grid gap-2 py-2">
    <Eyebrow>Up next</Eyebrow>
    <h2 className="text-xl">{noSchedule ? 'Your schedule has no periods yet' : 'No upcoming periods'}</h2>
    <p className="text-sm text-muted-foreground">{noSchedule ? 'Add periods to the school schedule or build a private one.' : 'Nothing is scheduled for the next year.'}</p>
    {noSchedule && <div><Button size="sm" onClick={onFixSchedule}>Open the school schedule</Button></div>}
  </CardContent></Card>;
  const current = next.status === 'current';
  const until = current ? minutesUntil(next.endAt, now) : minutesUntil(next.startAt, now);
  const total = current ? Math.max(1, minutesUntil(next.endAt, new Date(next.startAt))) : 0;
  const elapsed = current ? Math.min(total, Math.max(0, total - until)) : 0;
  const name = next.class?.name ?? next.label;
  const color = classColor(next.class?.id, next.kind, next.class?.color);
  const countdown = next.date === today && (current || until < 60 * 12);
  const when = next.date === today ? `Today at ${formatTime(next.start)}` : `${relativeDate(next.date, today, { weekday: 'long' })} at ${formatTime(next.start)}`;
  const meta = [next.class && next.class.name !== next.label ? next.label : null, next.class?.room ? `Room ${next.class.room}` : null, next.class?.teacher ?? null].filter(Boolean);
  return <Card className="hero-card rounded-3xl text-white shadow-float ring-0" style={{ background: `linear-gradient(120deg, ${color.dot} 0%, color-mix(in srgb, ${color.dot} 78%, #0b1020) 100%)` }} aria-label="Next class">
    <CardContent className="grid gap-5 px-5 py-1 sm:px-7 sm:py-3">
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-4">
        <div className="grid min-w-0 gap-2">
          <span className="text-[11px] font-bold uppercase tracking-[0.14em] text-white/80">
            {current ? 'Right now' : 'Up next'}
          </span>
          <h2 className="text-[34px] leading-[1.05] font-extrabold tracking-[-0.03em] text-white sm:text-[40px]">{name}</h2>
          <p className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[14px] font-medium text-white/85">
            <span className="tabular-nums">{formatRange(next.start, next.end)}</span>
            {meta.map((entry) => <span key={entry} className="inline-flex items-center gap-2.5"><span aria-hidden="true" className="size-1 rounded-full bg-white/50" />{entry}</span>)}
          </p>
        </div>
        <div className="grid justify-items-start gap-1 sm:justify-items-end">
          {countdown
            ? <Countdown label={current ? 'Ends in' : 'Starts in'} target={current ? next.endAt : next.startAt} minutes={until} />
            : <span className="rounded-full bg-white/15 px-3 py-1.5 text-sm font-bold tabular-nums text-white ring-1 ring-inset ring-white/20">{when}</span>}
        </div>
      </div>
      {current && <Progress value={(elapsed / total) * 100} aria-label="Period progress" aria-valuetext={`${elapsed} of ${total} minutes`} className="h-2 bg-white/20 *:data-[slot=progress-indicator]:bg-white *:data-[slot=progress-indicator]:transition-[transform] *:data-[slot=progress-indicator]:duration-1000 *:data-[slot=progress-indicator]:ease-linear" />}
      <div className="flex flex-wrap items-center justify-between gap-2 text-[13.5px] font-medium text-white/85">
        <span className="inline-flex items-center gap-2">
          <Icon name="arrowRight" size={14} className="text-white/60" />
          {following ? <>Then <strong className="font-bold text-white">{following.class?.name ?? following.label}</strong> at <span className="tabular-nums">{formatTime(following.start)}</span>{following.date !== next.date ? ` ${relativeDate(following.date, today)}` : ''}</> : current ? 'Last period of the day' : `${next.cycleDayLabel}`}
        </span>
        {!hasSetup && !next.class && next.kind === 'class' && <button type="button" className="rounded-full bg-white/15 px-3 py-1 font-bold text-white ring-1 ring-inset ring-white/25 hover:bg-white/25" onClick={onSetup}>Add your classes</button>}
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
  return <button type="button" className="display-number inline-flex cursor-pointer items-baseline whitespace-pre rounded-xl text-[30px] font-extrabold leading-none text-white outline-none focus-visible:ring-2 focus-visible:ring-white/60 sm:text-[38px]"
    aria-label={precise ? `${label} ${exact} (${seconds >= 3600 ? 'hours, minutes and seconds' : 'minutes and seconds'})` : `${label} ${compact}`} aria-pressed={pinned} title={pinned ? 'Hide seconds' : 'Show seconds'}
    onPointerEnter={(event) => { if (event.pointerType !== 'touch') show(setHover, true)(); }} onPointerLeave={show(setHover, false)}
    onFocus={(event) => show(setFocus, event.currentTarget.matches(':focus-visible'))()} onBlur={show(setFocus, false)} onClick={show(setPinned, !pinned)}>
    <small aria-hidden="true" className="mr-2 text-[13px] font-bold uppercase tracking-[0.12em] text-white/70">{label}</small>
    <span aria-hidden="true">{compact.slice(0, shared)}</span>
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

export function Timeline({ periods, now, compact, timeZone, tag }: { periods: ReturnType<typeof resolveDay>['periods']; now: Date; compact?: boolean; timeZone?: string; tag?: (period: ReturnType<typeof resolveDay>['periods'][number]) => string | null }) {
  const nowMs = now.getTime();
  const nowLabel = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone }).format(now);
  // Where the "now" marker sits when the current moment falls between periods.
  const markerBefore = periods.findIndex((period, index) => new Date(period.startAt).getTime() > nowMs && (index === 0 || new Date(periods[index - 1].endAt).getTime() <= nowMs));
  // Only mark the gap on the day being shown, and no earlier than three hours before the first period.
  const sameDay = periods.length > 0 && nowMs >= new Date(periods[0].startAt).getTime() - 3 * 3600_000 && nowMs < new Date(periods[periods.length - 1].endAt).getTime();
  return <ol className="grid gap-1">
    {periods.map((period, index) => {
      const start = new Date(period.startAt).getTime();
      const end = new Date(period.endAt).getTime();
      const status = nowMs >= end ? 'past' : nowMs >= start ? 'now' : 'future';
      const color = classColor(period.class?.id, period.kind, period.class?.color);
      const detail = [period.class && period.class.name !== period.label ? period.label : null, period.class?.room && `Room ${period.class.room}`, period.class?.teacher].filter(Boolean).join(' · ');
      return <li key={period.slotId} className="contents">
        {sameDay && index === markerBefore && <div aria-hidden="true" className="flex items-center gap-2 px-2 py-0.5 text-[11px] font-bold text-now-foreground">
          <span className="size-2 rounded-full bg-now animate-now-pulse" /><span className="h-px flex-1 bg-now/50" /><span>Now · {nowLabel}</span>
        </div>}
        <div className={cn('grid grid-cols-[64px_1fr] items-stretch gap-3 rounded-2xl px-2.5 py-2.5 transition-colors', status === 'now' && 'bg-now-soft ring-1 ring-inset ring-now/30', status === 'past' && 'opacity-50', status === 'future' && 'hover:bg-muted/70')}>
          <div className="grid content-start text-[12.5px] tabular-nums text-muted-foreground"><strong className={cn('text-[13.5px] font-bold', status === 'now' ? 'text-now-foreground' : 'text-foreground')}>{formatTime(period.start)}</strong>{!compact && <span>{formatTime(period.end)}</span>}</div>
          <div className="flex min-w-0 items-start gap-3">
            <span className="w-1.5 min-h-[36px] shrink-0 self-stretch rounded-full" style={{ background: color.dot }} />
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2"><strong className="text-[15px] font-bold tracking-tight">{period.class?.name ?? period.label}</strong>{status === 'now' && <Chip tone="now">Now</Chip>}{tag?.(period) && <Chip tone="accent" icon="users">{tag(period)}</Chip>}{period.kind === 'lunch' && !period.class && <Icon name="coffee" size={14} className="text-muted-foreground" />}</div>
              <Hint className={cn(!detail && period.kind === 'class' && !period.class && 'italic')}>{detail || (period.kind === 'class' && !period.class ? 'No class assigned' : ' ')}</Hint>
            </div>
          </div>
        </div>
      </li>;
    })}
  </ol>;
}

export function QuickAdd({ onAdd, placeholder = 'Add a task…' }: { onAdd: (title: string) => Promise<void>; placeholder?: string }) {
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
    <div className="relative">
      <Icon name="plus" size={16} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
      <Input aria-label="New task" placeholder={placeholder} maxLength={300} value={title} disabled={pending} onChange={(event) => setTitle(event.target.value)} className="h-11 rounded-full bg-muted/70 pl-10 pr-20 shadow-none focus-visible:bg-card dark:bg-input/20" />
      <Button type="submit" variant="primary" size="sm" aria-label="Add task" busy={pending} disabled={!title.trim()} className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-full px-3.5 disabled:opacity-0">Add</Button>
    </div>
    {error && <Hint tone="danger" role="alert">{error}</Hint>}
  </form>;
}

export function TaskRow({ item, state, showDate = true }: { item: ReturnType<typeof taskItems>[number]; state: AppState; showDate?: boolean }) {
  const [error, setError] = useState('');
  const { task } = item;
  const cls = state.personal.classes.find((entry) => entry.id === task.classId);
  const overdue = task.dueDate && !task.completed && (task.dueDate < state.today || (task.dueDate === state.today && task.dueTime !== null && task.dueTime < new Intl.DateTimeFormat('en-GB', { timeZone: state.timeZone, hour: '2-digit', minute: '2-digit', hour12: false }).format(state.now)));
  const dueToday = task.dueDate === state.today && !overdue;
  const hasMeta = task.dueDate || cls || task.notes || task.priority || task.subtasks?.length || task.recurrence || task.imported || task.reminder;
  return <li className="group/task flex items-start gap-3 rounded-2xl px-2.5 py-2.5 transition-colors hover:bg-muted/70">
    <Checkbox className="size-[22px] rounded-full border-2 border-input shadow-none transition-colors hover:border-primary data-checked:border-primary [&_svg]:size-3.5" checked={task.completed} aria-label={`Mark ${task.title} ${task.completed ? 'incomplete' : 'complete'}`} onCheckedChange={async (checked) => { setError(''); try { await state.saveTask(item.id, { ...task, completed: checked === true }); } catch (err) { setError(errorMessage(err)); } }} />
    <button type="button" className="grid min-w-0 flex-1 gap-1 text-left outline-none" onClick={() => state.navigate('tasks', { edit: item.id })} aria-label={`Edit ${task.title}`}>
      <span className={cn('text-[15px] font-semibold leading-snug', task.completed && 'line-through text-muted-foreground')}>{task.title}</span>
      {hasMeta && <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs font-medium text-muted-foreground">
        {showDate && task.dueDate && <span className={cn('inline-flex items-center gap-1 rounded-md px-1.5 py-0.5', overdue ? 'bg-destructive/10 font-bold text-destructive' : dueToday ? 'bg-primary-soft font-bold text-primary-soft-foreground' : 'bg-secondary')}><Icon name="calendar" size={11} strokeWidth={2.4} />{overdue ? 'Overdue · ' : ''}{relativeDate(task.dueDate, state.today)}{task.dueTime ? ` · ${formatTime(task.dueTime)}` : ''}</span>}
        {!showDate && task.dueTime && <span className="inline-flex items-center gap-1"><Icon name="clock" size={11} strokeWidth={2.4} />{formatTime(task.dueTime)}</span>}
        {cls && <span className="inline-flex items-center gap-1.5"><ColorDot color={classColor(cls.id, 'class', cls.color).dot} size={8} />{cls.name}</span>}
        {task.priority && task.priority !== 'normal' && <span className={cn('inline-flex items-center gap-1', task.priority === 'high' && 'font-bold text-destructive')}><Icon name={task.priority === 'high' ? 'arrowUp' : 'arrowDown'} size={11} strokeWidth={2.6} />{task.priority === 'high' ? 'High priority' : 'Low priority'}</span>}
        {!!task.subtasks?.length && <span className="inline-flex items-center gap-1"><Icon name="tasks" size={11} strokeWidth={2.4} />{task.subtasks.filter(entry => entry.completed).length}/{task.subtasks.length} checklist</span>}
        {task.recurrence && <span className="inline-flex items-center gap-1"><Icon name="refresh" size={11} strokeWidth={2.4} />Repeats {task.recurrence.frequency}</span>}
        {task.reminder && <span className="inline-flex items-center gap-1"><Icon name="bell" size={11} strokeWidth={2.4} />Reminder</span>}
        {task.imported && <span className="inline-flex items-center gap-1"><Icon name="calendar" size={11} strokeWidth={2.4} />{task.imported.sourceRemoved ? 'Calendar · source removed' : 'Calendar'}</span>}
        {task.notes && <Icon name="edit" size={12} />}
      </span>}
      {error && <Hint tone="danger" role="alert">{error}</Hint>}
    </button>
    {task.imported?.url && <a href={task.imported.url} target="_blank" rel="noopener noreferrer" className={cn(buttonVariants({ variant: 'ghost', size: 'icon-sm' }), 'shrink-0 text-muted-foreground')} aria-label={`Open link for ${task.title}`} title="Open link"><Icon name="externalLink" /></a>}
  </li>;
}
