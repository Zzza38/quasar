'use client';

import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { errorMessage } from '@/client/api';
import { cycleDaySlots, describeDayIssues, effectiveSchedule, nextClass, resolveDay, type ResolvedPeriod, type StudentClass } from '@/domain/schedule';
import { addDays, classColor, daysBetween, formatMinutes, formatRange, formatRoom, formatSeconds, formatTime, minutesLeft, minutesUntil, relativeDate, formatDate, weekdayOf } from '@/lib/format';
import { heroBase } from '@/lib/color';
import { classmatesFor, withLabel } from '@/lib/classmates';
import { cn } from '@/lib/utils';
import type { AppState, TaskItem } from '../app-state';
import { clockTime, isOverdue, openBellTimes, sortByDue, taskItems } from '../app-state';
import { Icon } from '../icon';
import { LunchDay } from '../lunch-menu';
import { DateAdjustmentSheet } from '../overrides';
import { PeriodSheet } from '../period-sheet';
import { Button, Chip, ColorDot, EmptyState, Eyebrow, Hint, Input, Section, Select, StatTile } from '../primitives';
import { buttonVariants } from '../ui/button';
import { SetupChecklist, coreSetupDone } from '../setup-checklist';
import { Card, CardContent } from '../ui/card';
import { Checkbox } from '../ui/checkbox';
import { Progress } from '../ui/progress';
import { ToggleGroup, ToggleGroupItem } from '../ui/toggle-group';

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
  const later = tasks.length - dueSoon.length;
  // Same rule as the task rows and the Tasks page groups: overdue is the more urgent number, so it wins the tile.
  const nowTime = clockTime(now, timeZone);
  const overdue = tasks.filter((item) => isOverdue(item.task, today, nowTime)).length;
  const dueToday = tasks.filter((item) => item.task.dueDate === today && !isOverdue(item.task, today, nowTime)).length;
  const periodsLeft = day && !day.closed ? day.periods.filter((period) => new Date(period.endAt).getTime() > now.getTime()).length : 0;
  const hasSetup = personal.classes.length > 0;
  // Until classes exist and sit on periods the countdown has nothing to show, so setup comes first.
  const setupFirst = !coreSetupDone(personal, schedule);
  // resolveDay follows the private schedule when there is one, so the rotation position must come from the same schedule.
  const effective = effectiveSchedule(schedule, personal);
  const cycleIndex = day && !day.closed ? effective.cycleDays.findIndex((entry) => entry.id === day.cycleDayId) : -1;
  const cyclePosition = day && !day.closed && effective.cycleDays.length > 1 && cycleIndex >= 0 && !day.cycleDayLabel.includes(String(cycleIndex + 1)) ? ` · ${cycleIndex + 1} of ${effective.cycleDays.length}` : '';
  // During school hours, quick add files new tasks under the class that is on now or just ended.
  const suggestedClassId = useMemo(() => {
    if (!day || day.closed || day.periods.length === 0) return null;
    const nowMs = now.getTime();
    if (nowMs < new Date(day.periods[0].startAt).getTime() || nowMs > new Date(day.periods[day.periods.length - 1].endAt).getTime() + 15 * 60_000) return null;
    const started = day.periods.filter((period) => period.class && new Date(period.startAt).getTime() <= nowMs);
    return started[started.length - 1]?.class?.id ?? null;
  }, [day, now]);
  const [changePeriod, setChangePeriod] = useState<ResolvedPeriod | null>(null);
  const [adjustDay, setAdjustDay] = useState(false);
  const { onComplete, undoBar } = useCompletionUndo(state);

  return <div className="grid grid-cols-[minmax(0,1fr)] gap-5 animate-in fade-in-0 duration-300">
    <header className="flex flex-wrap items-end justify-between gap-3">
      <div className="grid gap-1">
        <Eyebrow>{formatDate(today, { weekday: 'long', year: true })}</Eyebrow>
        <h1 className="text-[30px] lg:text-[36px]">{greeting(now, timeZone)}, {context.user.displayName}</h1>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {day && !day.closed && <Chip tone="accent" icon="layers">{day.cycleDayLabel}{cyclePosition}</Chip>}
        {day?.closed && <Chip icon="coffee">No school today</Chip>}
      </div>
    </header>

    {setupFirst && <SetupChecklist state={state} />}

    <NowCard next={next} following={following} now={now} today={today} onSetup={() => state.navigate('classes')} onFixSchedule={() => openBellTimes(state)} privateSchedule={personal.customSchedule !== null} hasSetup={hasSetup} noSchedule={effective.cycleDays.every((entry) => cycleDaySlots(entry, personal).length === 0)} />

    {!setupFirst && <SetupChecklist state={state} />}

    <div className="grid grid-cols-2 gap-3">
      {overdue > 0
        ? <StatTile icon="tasks" tone="danger" value={overdue} label="overdue" onClick={() => state.navigate('tasks')} />
        : <StatTile icon="tasks" tone={dueToday > 0 ? 'accent' : 'success'} value={dueToday} label="due today" onClick={() => state.navigate('tasks')} />}
      <StatTile icon="clock" tone="accent" value={periodsLeft} label={periodsLeft === 1 ? 'period left' : 'periods left'} onClick={() => state.navigate('schedule')} />
    </div>

    <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
      <Section title="Today" id="today-timeline" description={day && !day.closed ? `${day.periods.length} periods · ${day.periods.length ? formatRange(day.periods[0].start, day.periods[day.periods.length - 1].end) : ''}` : undefined} action={<div className="flex flex-wrap gap-1">{day && !day.closed && day.periods.length > 0 && <Button size="sm" variant="ghost" onClick={() => openBellTimes(state)} title={personal.customSchedule ? 'Edit my private schedule' : 'Fix the shared bell schedule'}>Wrong time?</Button>}<Button size="sm" variant="ghost" iconRight="arrowRight" onClick={() => state.navigate('schedule')}>Full schedule</Button></div>}>
        {day?.closed && <div className="grid justify-items-start gap-2 py-3">
          <p className="text-sm text-muted-foreground">No periods today. Enjoy the day off.</p>
          {nextSchoolDay && <p className="text-sm">Next school day: <button type="button" className="font-semibold text-primary hover:underline" onClick={() => state.navigate('schedule', { date: nextSchoolDay.date })}>{relativeDate(nextSchoolDay.date, today, { weekday: 'long' })}</button> · {nextSchoolDay.resolved.cycleDayLabel}</p>}
        </div>}
        {day && !day.closed && day.periods.length === 0 && <p className="py-4 text-sm text-muted-foreground">No periods on this day.</p>}
        {day && day.periods.length > 0 && <Timeline periods={day.periods} now={now} timeZone={timeZone} onPeriodSelect={state.personalValid ? setChangePeriod : undefined} tag={(period) => classmatesTag(state, today, period)} />}
        {day && !day.closed && <LunchDay state={state} date={today} />}
        {day && day.issues.length > 0 && <Hint tone="danger">{describeDayIssues(day.issues).join(' ')} Review your adjustments under Classes.</Hint>}
      </Section>

      <Section title={<>Up next{dueSoon.length > 0 && <Chip className="ml-2 align-middle">{dueSoon.length}</Chip>}</>} id="today-tasks" action={<Button size="sm" variant="ghost" iconRight="arrowRight" onClick={() => state.navigate('tasks')}>All tasks</Button>}>
        <QuickAdd today={today} classes={personal.classes} suggestedClassId={suggestedClassId}
          onAdd={(title, extra) => state.saveTask(crypto.randomUUID(), { title, dueDate: extra.dueDate ?? null, dueTime: null, classId: extra.classId ?? null, notes: '', completed: false })} />
        {shown.length === 0 && <EmptyState icon="checkCircle" title="Nothing due soon">Add anything you need to get done. Homework, forms, practice.</EmptyState>}
        {shown.length > 0 && <ul className="grid gap-0.5">{shown.map((item) => <TaskRow key={item.id} item={item} state={state} onComplete={onComplete} />)}</ul>}
        {undoBar}
        {dueSoon.length > shown.length
          ? <Button variant="ghost" size="sm" className="justify-self-start" onClick={() => state.navigate('tasks')}>{dueSoon.length - shown.length} more</Button>
          : later > 0 && <Button variant="ghost" size="sm" className="justify-self-start" onClick={() => state.navigate('tasks')}>{later} due later</Button>}
      </Section>
    </div>
    {state.personalValid && <PeriodSheet state={state} period={changePeriod} date={today} onClose={() => setChangePeriod(null)} onAdjustDay={() => { setChangePeriod(null); setAdjustDay(true); }} />}
    <DateAdjustmentSheet open={adjustDay} onClose={() => setAdjustDay(false)} date={today} school={schedule} personal={personal} save={state.savePersonal} />
  </div>;
}

/** Slate for periods with no class colour; heroBase only darkens hex colours, and the muted-foreground variable is too light for white text in dark mode. */
const NEUTRAL_HERO = '#64748b';

/** The Now card's gradient base: the period's colour, darkened until white text reaches 4.5:1. CSS variables fall back to NEUTRAL_HERO. */
export function nowCardBase(dot: string): string {
  return heroBase(/^#[0-9a-fA-F]{6}$/.test(dot) ? dot : NEUTRAL_HERO);
}

function NowCard({ next, following, now, today, onSetup, onFixSchedule, privateSchedule, hasSetup, noSchedule }: { next: ReturnType<typeof nextClass>; following: ReturnType<typeof nextClass>; now: Date; today: string; onSetup: () => void; onFixSchedule: () => void; privateSchedule: boolean; hasSetup: boolean; noSchedule: boolean }) {
  if (!next) return <Card role="region" aria-label="Next class"><CardContent className="grid gap-2 py-2">
    <Eyebrow>Up next</Eyebrow>
    <h2 className="text-xl">{noSchedule ? 'Your schedule has no periods yet' : 'No upcoming periods'}</h2>
    <p className="text-sm text-muted-foreground">{!noSchedule ? 'Nothing is scheduled for the next year.' : privateSchedule ? 'Add periods to your private schedule.' : 'Add periods to the school schedule or build a private one.'}</p>
    {noSchedule && <div><Button size="sm" onClick={onFixSchedule}>{privateSchedule ? 'Edit my private schedule' : 'Open the school schedule'}</Button></div>}
  </CardContent></Card>;
  const current = next.status === 'current';
  // Rounded up, like the seconds view, so a running period never reads "0 min"; elapsed is then whole minutes gone.
  const until = minutesLeft(current ? next.endAt : next.startAt, now);
  const total = current ? Math.max(1, minutesUntil(next.endAt, new Date(next.startAt))) : 0;
  const elapsed = current ? Math.min(total, Math.max(0, total - until)) : 0;
  const name = next.class?.name ?? next.label;
  const color = classColor(next.class?.id, next.kind, next.class?.color);
  const countdown = next.date === today && (current || until < 60 * 12);
  const when = next.date === today ? `Today at ${formatTime(next.start)}` : `${relativeDate(next.date, today, { weekday: 'long' })} at ${formatTime(next.start)}`;
  const meta = [next.class && next.class.name !== next.label ? next.label : null, next.class?.room ? formatRoom(next.class.room) || null : null, next.class?.teacher ?? null].filter(Boolean);
  // Light class colours (amber, lime, yellow) are darkened just enough for white text to reach 4.5:1.
  const base = nowCardBase(color.dot);
  return <Card className="hero-card rounded-3xl text-white shadow-float ring-0" style={{ background: `linear-gradient(120deg, ${base} 0%, color-mix(in srgb, ${base} 78%, #0b1020) 100%)` }} role="region" aria-label="Next class">
    <CardContent className="grid gap-5 px-5 py-1 sm:px-7 sm:py-3">
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-4">
        <div className="grid min-w-0 gap-2">
          <span className="text-[11px] font-bold uppercase tracking-[0.14em] text-white">
            {current ? 'Right now' : 'Up next'}
          </span>
          <h2 className="text-[34px] leading-[1.05] font-extrabold tracking-[-0.03em] text-white sm:text-[40px]">{name}</h2>
          <p className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[14px] font-medium text-white">
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
      <div className="flex flex-wrap items-center justify-between gap-2 text-[13.5px] font-medium text-white">
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
 * "Ends in 9 min" that reveals seconds ("Ends in 8:23") while hovered, focused or
 * tapped. Minutes round up in both modes (see minutesLeft). The shared leading text
 * stays put; the differing tails slide open/closed.
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
  const compact = formatMinutes(precise ? Math.ceil(seconds / 60) : minutes);
  const exact = formatSeconds(seconds);
  let shared = 0;
  while (shared < compact.length && shared < exact.length && compact[shared] === exact[shared]) shared += 1;
  // Refresh the clock in the same event as the state change so the first precise frame is current.
  const show = (set: (value: boolean) => void, value: boolean) => () => { if (value) setTick(Date.now()); set(value); };
  return <button type="button" className="display-number inline-flex cursor-pointer items-baseline whitespace-pre rounded-xl text-[30px] font-extrabold leading-none text-white outline-none focus-visible:ring-2 focus-visible:ring-white/60 sm:text-[38px]"
    aria-label={precise ? `${label} ${exact} (${seconds >= 3600 ? 'hours, minutes and seconds' : 'minutes and seconds'})` : `${label} ${compact}`} aria-pressed={pinned} title={pinned ? 'Hide seconds' : 'Show seconds'}
    onPointerEnter={(event) => { if (event.pointerType !== 'touch') show(setHover, true)(); }} onPointerLeave={show(setHover, false)}
    onFocus={(event) => show(setFocus, event.currentTarget.matches(':focus-visible'))()} onBlur={show(setFocus, false)} onClick={show(setPinned, !pinned)}>
    <small aria-hidden="true" className="mr-2 text-[13px] font-bold uppercase tracking-[0.12em] text-white">{label}</small>
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

/**
 * A day's periods in order. `onPeriodSelect` (Today and Schedule, never someone else's day) turns class
 * and lunch rows into buttons named "Change {label}". `tag` may return plain text, shown as a chip, or
 * its own element (for example a button), which stays clickable above the row button.
 */
export function Timeline({ periods, now, compact, timeZone, tag, onPeriodSelect }: { periods: ResolvedPeriod[]; now: Date; compact?: boolean; timeZone?: string; tag?: (period: ResolvedPeriod) => ReactNode; onPeriodSelect?: (period: ResolvedPeriod) => void }) {
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
      // Fade finished periods only while the day is under way, and fade the colour bar rather than the text so room and teacher stay readable.
      const dim = sameDay && status === 'past';
      const color = classColor(period.class?.id, period.kind, period.class?.color);
      const detail = [period.class && period.class.name !== period.label ? period.label : null, period.class?.room ? formatRoom(period.class.room) : null, period.class?.teacher].filter(Boolean).join(' · ');
      const selectable = onPeriodSelect && (period.kind === 'class' || period.kind === 'lunch');
      const tagged = tag?.(period);
      return <li key={period.slotId} className="contents">
        {sameDay && index === markerBefore && <div aria-hidden="true" className="flex items-center gap-2 px-2 py-0.5 text-[11px] font-bold text-now-foreground">
          <span className="size-2 rounded-full bg-now animate-now-pulse" /><span className="h-px flex-1 bg-now/50" /><span>Now · {nowLabel}</span>
        </div>}
        <div className={cn('relative grid grid-cols-[64px_1fr] items-stretch gap-3 rounded-2xl px-2.5 py-2.5 transition-colors', status === 'now' && 'bg-now-soft ring-1 ring-inset ring-now/30', status !== 'now' && (selectable || status === 'future') && 'hover:bg-muted/70')}>
          {/* Stretched over the row; the tag sits above it so both stay clickable without nesting buttons. */}
          {selectable && <button type="button" aria-label={`Change ${period.label}`} title={`Change ${period.label}`} className="absolute inset-0 cursor-pointer rounded-2xl outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background" onClick={() => onPeriodSelect(period)} />}
          <div className="grid content-start text-[12.5px] tabular-nums text-muted-foreground"><strong className={cn('text-[13.5px] font-bold', status === 'now' ? 'text-now-foreground' : dim ? 'text-muted-foreground' : 'text-foreground')}>{formatTime(period.start)}</strong>{!compact && <span>{formatTime(period.end)}</span>}</div>
          <div className="flex min-w-0 items-start gap-3">
            <span className={cn('w-1.5 min-h-[36px] shrink-0 self-stretch rounded-full', dim && 'opacity-40')} style={{ background: color.dot }} />
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <strong className={cn('text-[15px] font-bold tracking-tight', dim && 'text-muted-foreground')}>{period.class?.name ?? period.label}</strong>
                {dim && <span className="sr-only">(ended)</span>}
                {status === 'now' && <Chip tone="now">Now</Chip>}
                {tagged !== null && tagged !== undefined && tagged !== false && tagged !== '' && (typeof tagged === 'string' ? <Chip tone="accent" icon="users">{tagged}</Chip> : <span className="relative z-10 inline-flex">{tagged}</span>)}
                {period.kind === 'lunch' && !period.class && <Icon name="coffee" size={14} className="text-muted-foreground" />}
              </div>
              <Hint className={cn(!detail && period.kind === 'class' && !period.class && 'italic')}>{detail || (period.kind === 'class' && !period.class ? 'No class assigned' : ' ')}</Hint>
            </div>
          </div>
        </div>
      </li>;
    })}
  </ol>;
}

/**
 * "With Bob" on a timeline row; opens that friend's profile, or People when there are several.
 * A plain function, not a component, so rows without classmates get null and no empty wrapper.
 */
export function classmatesTag(state: AppState, date: string, period: ResolvedPeriod): ReactNode {
  const mates = classmatesFor(state.context, state.schedule, date, period);
  const label = withLabel(mates);
  if (!label) return null;
  const only = mates.length === 1 ? mates[0] : null;
  const action = only ? `See ${only.displayName}’s day` : 'See your friends';
  return <button type="button" className="rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background" title={action} onClick={() => state.navigate('people', only ? { member: only.id } : undefined)}>
    <Chip tone="accent" icon="users" className="transition-colors hover:bg-primary/20">{label}</Chip>
    <span className="sr-only">. {action}</span>
  </button>;
}

export type QuickAddExtra = { dueDate?: string | null; classId?: string | null };

/** The first Monday–Friday after tomorrow, for the third due chip. */
function nextWeekday(today: string): string {
  let date = addDays(today, 2);
  while (weekdayOf(date) > 5) date = addDays(date, 1);
  return date;
}

/**
 * One-line task entry. Once there is text, a row of due chips (Today / Tomorrow / next weekday) and a
 * class picker appear when `today` and `classes` are given; `suggestedClassId` preselects the class.
 * Enter still submits straight away. The field stays focused (read-only while saving) so the phone
 * keyboard stays open between tasks.
 */
export function QuickAdd({ onAdd, placeholder = 'Add a task…', today, classes = [], suggestedClassId = null }: { onAdd: (title: string, extra: QuickAddExtra) => Promise<void>; placeholder?: string; today?: string; classes?: StudentClass[]; suggestedClassId?: string | null }) {
  const [title, setTitle] = useState('');
  const [due, setDue] = useState('');
  // null follows the suggestion; '' means the student picked "No class".
  const [classId, setClassId] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const [error, setError] = useState('');
  // An object so adding the same title twice still restarts the timer and re-announces.
  const [added, setAdded] = useState<{ title: string } | null>(null);
  useEffect(() => {
    if (!added) return;
    const timer = setTimeout(() => setAdded(null), 3000);
    return () => clearTimeout(timer);
  }, [added]);
  const chosenClass = classId ?? (suggestedClassId && classes.some((cls) => cls.id === suggestedClassId) ? suggestedClassId : '');
  const weekday = today ? nextWeekday(today) : null;
  const dueOptions = today && weekday ? [
    { value: today, label: 'Today', name: 'Due today' },
    { value: addDays(today, 1), label: 'Tomorrow', name: 'Due tomorrow' },
    { value: weekday, label: formatDate(weekday, { weekday: 'short' }).split(',')[0], name: `Due ${formatDate(weekday, { weekday: 'long' }).split(',')[0]}` },
  ] : [];
  const showExtras = title.trim() !== '' && (dueOptions.length > 0 || classes.length > 0);
  return <form className="grid gap-1.5" onSubmit={async (event) => {
    event.preventDefault();
    const trimmed = title.trim();
    if (!trimmed || pendingRef.current) return;
    pendingRef.current = true; setPending(true); setError('');
    try {
      await onAdd(trimmed, { dueDate: due || null, classId: chosenClass || null });
      setTitle(''); setDue(''); setClassId(null); setAdded({ title: trimmed });
    } catch (err) { setError(errorMessage(err)); } finally { pendingRef.current = false; setPending(false); }
  }}>
    <div className="relative">
      <Icon name="plus" size={16} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
      <Input aria-label="New task" enterKeyHint="done" placeholder={placeholder} maxLength={300} value={title} readOnly={pending} aria-busy={pending || undefined} onChange={(event) => setTitle(event.target.value)} className="h-11 rounded-full bg-muted/70 pl-10 pr-20 shadow-none focus-visible:bg-card dark:bg-input/20" />
      <Button type="submit" variant="primary" size="sm" aria-label="Add task" busy={pending} disabled={!title.trim()} className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-full px-3.5 pointer-coarse:h-9 pointer-coarse:min-h-0 disabled:opacity-0">Add</Button>
    </div>
    {showExtras && <div className="flex flex-wrap items-center gap-1.5 animate-in fade-in-0 duration-200">
      {dueOptions.length > 0 && <ToggleGroup type="single" value={due} onValueChange={setDue} aria-label="Quick add due date" variant="outline" size="sm" spacing={1} className="flex-wrap">
        {dueOptions.map((option) => <ToggleGroupItem key={option.value} value={option.value} aria-label={option.name} className="h-7 pointer-coarse:h-9 rounded-full bg-card px-3 text-xs font-semibold data-[state=on]:border-primary data-[state=on]:bg-primary data-[state=on]:text-primary-foreground">{option.label}</ToggleGroupItem>)}
      </ToggleGroup>}
      {classes.length > 0 && <Select small aria-label="Quick add class" value={chosenClass} onChange={(event) => setClassId(event.target.value)} className="w-auto max-w-[12rem] data-[size=sm]:h-7 data-[size=sm]:rounded-full pointer-coarse:data-[size=sm]:h-9">
        <option value="">No class</option>
        {classes.map((cls) => <option key={cls.id} value={cls.id}>{cls.name}</option>)}
      </Select>}
    </div>}
    {error && <Hint tone="danger" role="alert">{error}</Hint>}
    {!error && added && <Hint role="status">Added: {added.title}</Hint>}
  </form>;
}

/**
 * Keeps the last completed task for five seconds with an Undo bar floating above the tab bar, so it is
 * seen wherever the row was. The timer pauses while the bar is hovered or focused. Completing from the
 * keyboard moves focus to Undo, since the finished row leaves the list. Repeating tasks are left out:
 * completing one makes the server create the next occurrence, which un-completing does not remove.
 */
export function useCompletionUndo(state: AppState): { onComplete: (item: TaskItem, options?: { focus?: boolean }) => void; undoBar: ReactNode } {
  const [recent, setRecent] = useState<TaskItem | null>(null);
  const [error, setError] = useState('');
  // The id being restored, so a newer completion's Undo is not shown as busy.
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [focusUndo, setFocusUndo] = useState(false);
  const undoRef = useRef<HTMLButtonElement>(null);
  const pending = !!recent && pendingId === recent.id;
  useEffect(() => {
    if (!recent || pending || error || hovered || focused) return;
    const timer = setTimeout(() => setRecent(null), 5000);
    return () => clearTimeout(timer);
  }, [recent, pending, error, hovered, focused]);
  useEffect(() => {
    if (!focusUndo || !recent) return;
    setFocusUndo(false);
    undoRef.current?.focus();
  }, [focusUndo, recent]);
  // When the bar goes away its hover and focus go with it.
  useEffect(() => { if (!recent) { setHovered(false); setFocused(false); } }, [recent]);
  const onComplete = useCallback((item: TaskItem, options?: { focus?: boolean }) => {
    if (item.task.recurrence) return;
    setError(''); setRecent(item);
    if (options?.focus) setFocusUndo(true);
  }, []);
  const undoBar = recent && <div role="status" className="fixed inset-x-4 bottom-[calc(var(--nav-h)+12px)] z-30 mx-auto flex max-w-md flex-wrap items-center gap-2 rounded-2xl bg-card px-3 py-1.5 text-sm shadow-float ring-1 ring-foreground/[0.08] animate-in fade-in-0 slide-in-from-bottom-2 duration-200 lg:bottom-6"
    onPointerEnter={() => setHovered(true)} onPointerLeave={() => setHovered(false)}
    onFocus={() => setFocused(true)} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false); }}>
    <Icon name="checkCircle" size={15} className="shrink-0 text-success" />
    <span className="min-w-0 flex-1 truncate">Completed: {recent.task.title}</span>
    <Button ref={undoRef} size="sm" variant="ghost" busy={pending} onClick={async () => {
      const target = recent;
      if (pendingId === target.id) return;
      setPendingId(target.id); setError('');
      try {
        await state.saveTask(target.id, { ...target.task, completed: false });
        // A task completed while this one was restoring keeps its own bar.
        setRecent((current) => current === target ? null : current);
        // Put focus back on the restored row's checkbox once it is back in the list.
        requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-task-check="${CSS.escape(target.id)}"]`)?.focus());
      } catch (err) { setError(errorMessage(err)); } finally { setPendingId((current) => current === target.id ? null : current); }
    }}>Undo<span className="sr-only">: {recent.task.title}</span></Button>
    {error && <Hint tone="danger" role="alert" className="basis-full">{error}</Hint>}
  </div>;
  return { onComplete, undoBar };
}

export function TaskRow({ item, state, showDate = true, onComplete }: { item: TaskItem; state: AppState; showDate?: boolean; onComplete?: (item: TaskItem, options?: { focus?: boolean }) => void }) {
  const [error, setError] = useState('');
  // Checkbox change events carry no pointer type, so remember whether the last press was a key.
  const keyboardRef = useRef(false);
  const metaId = useId();
  const { task } = item;
  const cls = state.personal.classes.find((entry) => entry.id === task.classId);
  const overdue = isOverdue(task, state.today, clockTime(state.now, state.timeZone));
  const dueToday = task.dueDate === state.today && !overdue;
  const hasMeta = task.dueDate || cls || task.notes || task.priority || task.subtasks?.length || task.recurrence || task.imported || task.reminder;
  return <li className="group/task flex items-start gap-3 rounded-2xl px-2.5 py-2.5 transition-colors hover:bg-muted/70">
    <Checkbox className="size-[22px] rounded-full border-2 border-control-border shadow-none transition-colors hover:border-primary data-checked:border-primary [&_svg]:size-3.5" checked={task.completed} aria-label={`Mark ${task.title} ${task.completed ? 'incomplete' : 'complete'}`} data-task-check={item.id}
      onKeyDown={() => { keyboardRef.current = true; }} onPointerDown={() => { keyboardRef.current = false; }} onCheckedChange={async (checked) => {
      setError('');
      const keyboard = keyboardRef.current;
      try { await state.saveTask(item.id, { ...task, completed: checked === true }); if (checked === true) onComplete?.(item, { focus: keyboard }); } catch (err) { setError(errorMessage(err)); }
    }} />
    <div className="grid min-w-0 flex-1 gap-1">
      {/* The name stays "Edit {title}"; the due date, class and priority are read as its description. */}
      <button type="button" className="grid w-full min-w-0 gap-1 rounded-xl text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background" onClick={() => state.navigate('tasks', { edit: item.id })} aria-label={`Edit ${task.title}`} aria-describedby={hasMeta ? metaId : undefined}>
        <span className={cn('text-[15px] font-semibold leading-snug', task.completed && 'line-through text-muted-foreground')}>{task.title}</span>
        {hasMeta && <span id={metaId} className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs font-medium text-muted-foreground">
          {showDate && task.dueDate && <span className={cn('inline-flex items-center gap-1 rounded-md px-1.5 py-0.5', overdue ? 'bg-destructive/10 font-bold text-destructive' : dueToday ? 'bg-primary-soft font-bold text-primary-soft-foreground' : 'bg-secondary')}><Icon name="calendar" size={11} strokeWidth={2.4} />{overdue ? 'Overdue · ' : ''}{relativeDate(task.dueDate, state.today)}{task.dueTime ? ` · ${formatTime(task.dueTime)}` : ''}</span>}
          {!showDate && task.dueTime && <span className="inline-flex items-center gap-1"><Icon name="clock" size={11} strokeWidth={2.4} />{formatTime(task.dueTime)}</span>}
          {cls && <span className="inline-flex items-center gap-1.5"><ColorDot color={classColor(cls.id, 'class', cls.color).dot} size={8} />{cls.name}</span>}
          {task.priority && task.priority !== 'normal' && <span className={cn('inline-flex items-center gap-1', task.priority === 'high' && 'font-bold text-destructive')}><Icon name={task.priority === 'high' ? 'arrowUp' : 'arrowDown'} size={11} strokeWidth={2.6} />{task.priority === 'high' ? 'High priority' : 'Low priority'}</span>}
          {!!task.subtasks?.length && <span className="inline-flex items-center gap-1"><Icon name="tasks" size={11} strokeWidth={2.4} />{task.subtasks.filter(entry => entry.completed).length}/{task.subtasks.length} checklist</span>}
          {task.recurrence && <span className="inline-flex items-center gap-1"><Icon name="refresh" size={11} strokeWidth={2.4} />Repeats {task.recurrence.frequency}</span>}
          {task.reminder && <span className="inline-flex items-center gap-1"><Icon name="bell" size={11} strokeWidth={2.4} />Reminder</span>}
          {task.imported && <span className="inline-flex items-center gap-1"><Icon name="calendar" size={11} strokeWidth={2.4} />{task.imported.sourceRemoved ? 'Calendar · source removed' : 'Calendar'}</span>}
          {task.notes && <span className="inline-flex"><Icon name="edit" size={12} aria-hidden="true" /><span className="sr-only">Has notes</span></span>}
        </span>}
      </button>
      {error && <Hint tone="danger" role="alert">{error}</Hint>}
    </div>
    {task.imported?.url && <a href={task.imported.url} target="_blank" rel="noopener noreferrer" className={cn(buttonVariants({ variant: 'ghost', size: 'icon-sm' }), 'shrink-0 text-muted-foreground')} aria-label={`Open link for ${task.title}`} title="Open link"><Icon name="externalLink" /></a>}
  </li>;
}
