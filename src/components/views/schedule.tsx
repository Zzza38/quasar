'use client';

import { useEffect, useMemo, useState } from 'react';
import { clampDate, dateSchema, describeDayIssues, FIRST_DATE, LAST_DATE, resolveDay, resolveDayInRange, type ResolvedPeriod } from '@/domain/schedule';
import { addDays, formatDate, formatRange, monthGrid, monthOf, relativeDate, sameMonth, weekdayOf } from '@/lib/format';
import { cn } from '@/lib/utils';
import { sortByDue, taskItems, type AppState } from '../app-state';
import { Icon } from '../icon';
import { DateAdjustmentSheet, effectiveSchedule } from '../overrides';
import { Button, Chip, Hint, IconButton, Input, PageHeader, Section } from '../primitives';
import { Card, CardContent } from '../ui/card';
import { classmatesTag, TaskRow, Timeline, useCompletionUndo } from './today';
import { PeriodSheet } from '../period-sheet';
import { LunchDay } from '../lunch-menu';
import { ImportedEvents } from '../imported-events';

const WEEKDAY_HEADERS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function ScheduleView({ state }: { state: AppState }) {
  const { schedule: school, personal, now, today } = state;
  const schedule = effectiveSchedule(school, personal);
  const requested = state.params.get('date');
  // Only an explicit pick is stored, so the default follows state.today when the app resumes on a later day.
  const [picked, setPicked] = useState<string | null>(() => requested && dateSchema.safeParse(requested).success ? requested : null);
  const date = picked ?? today;
  // The month on screen. Null follows the selected date; paging with the arrows detaches it until the next pick.
  const [paged, setPaged] = useState<string | null>(null);
  const shown = paged ?? date;
  // Every move goes through here: the date input can step past the ends of the range dateSchema accepts.
  const setDate = (value: string) => { setPicked(value === today ? null : clampDate(value)); setPaged(null); };
  // Strip ?date= in place so Back does not land on it again and loop.
  useEffect(() => {
    if (!requested) return;
    if (dateSchema.safeParse(requested).success) setPicked(requested);
    state.navigate('schedule', undefined, { replace: true });
  }, [requested, state]);
  const [adjustDate, setAdjustDate] = useState<string | null>(null);
  const [changePeriod, setChangePeriod] = useState<ResolvedPeriod | null>(null);
  const { onComplete, undoBar } = useCompletionUndo(state);

  const month = monthOf(shown);
  // Six weeks always cover a month; the sixth is dropped when it holds none of it. Dates past the supported range resolve to null.
  const cells = useMemo(() => {
    const dates = monthGrid(shown);
    const rows = sameMonth(dates[35], shown) ? 42 : 35;
    return dates.slice(0, rows).map((entry) => ({ date: entry, day: resolveDayInRange(school, entry, personal) }));
  }, [school, personal, shown]);
  const selected = useMemo(() => { try { return resolveDay(school, date, personal); } catch { return null; } }, [school, date, personal]);
  const override = personal.dateOverrides.find((entry) => entry.date === date);
  const adjusted = useMemo(() => new Set(personal.dateOverrides.map((entry) => entry.date)), [personal.dateOverrides]);
  const rotation = schedule.cycleDays.length > 1;
  const relative = relativeDate(date, today);
  const isRelative = ['Today', 'Tomorrow', 'Yesterday'].includes(relative);
  // Overdue work belongs to Today and Tasks, so past days list nothing.
  const due = useMemo(() => date < today ? [] : sortByDue(taskItems(state.snapshot.entities).filter((item) => !item.task.imported && !item.task.completed && item.task.dueDate === date)), [state.snapshot.entities, date, today]);
  const dueCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of taskItems(state.snapshot.entities)) if (!item.task.imported && !item.task.completed && item.task.dueDate && item.task.dueDate >= today) counts.set(item.task.dueDate, (counts.get(item.task.dueDate) ?? 0) + 1);
    return counts;
  }, [state.snapshot.entities, today]);
  const dueTitle = `Due ${isRelative ? relative.toLowerCase() : formatDate(date, { weekday: 'long' })}`;
  const pickDate = (value: string) => { if (value && dateSchema.safeParse(value).success) setDate(value); };
  const pageMonth = (direction: -1 | 1) => setPaged(clampDate(addDays(month.start, direction < 0 ? -1 : month.days)));
  const issueText = selected ? describeDayIssues(selected.issues).join(' ') : '';

  return <div className="grid grid-cols-[minmax(0,1fr)] gap-5 animate-in fade-in-0 duration-300">
    <PageHeader title="Schedule" eyebrow={rotation ? `${schedule.cycleDays.length}-day rotation` : 'Daily bell schedule'} />

    <div className="grid items-start gap-5 lg:grid-cols-[minmax(21rem,2fr)_minmax(0,3fr)]">
      {/* Less side padding on phones: seven columns need the width. Sticky on wide screens so paging and the day stay side by side. */}
      <Card id="schedule-month" role="region" aria-label="Month" className="lg:sticky lg:top-4"><CardContent className="grid gap-3 max-sm:px-2">
        <div className="flex items-center justify-between gap-2">
          <IconButton label="Previous month" icon="chevronLeft" size="lg" onClick={() => pageMonth(-1)} />
          <div className="grid justify-items-center gap-0.5 text-center">
            <strong className="text-[15px] font-bold tracking-tight">{month.label}</strong>
            {paged !== null && !sameMonth(paged, date) && <button type="button" className="text-xs font-semibold text-primary hover:underline" onClick={() => setPaged(null)}>Back to {date === today ? 'today' : formatDate(date)}</button>}
          </div>
          <IconButton label="Next month" icon="chevronRight" size="lg" onClick={() => pageMonth(1)} />
        </div>
        <div className="grid grid-cols-7 gap-1">
          {WEEKDAY_HEADERS.map((name) => <span key={name} aria-hidden="true" className="pb-1 text-center text-[10.5px] font-bold uppercase tracking-wide text-muted-foreground">{name}</span>)}
          {cells.map(({ date: entry, day }) => {
            const inMonth = sameMonth(entry, shown);
            const active = entry === date;
            const isToday = entry === today;
            const closed = !day || day.closed;
            const weekend = weekdayOf(entry) >= 6;
            const dueCount = dueCounts.get(entry);
            const caption = !day ? '' : day.closed ? (weekend ? '' : '–') : rotation ? day.cycleDayLabel : '';
            const label = `${formatDate(entry, { weekday: 'long' })}: ${!day ? 'outside the supported dates' : day.closed ? 'no school' : rotation ? day.cycleDayLabel : `${day.periods.length} periods`}${dueCount ? `, ${dueCount} due` : ''}${adjusted.has(entry) ? ', adjusted by you' : ''}`;
            return <button key={entry} type="button" aria-pressed={active} aria-label={label} onClick={() => pickDate(entry)}
              className={cn('relative grid min-h-[3rem] content-center justify-items-center gap-px rounded-lg px-0.5 pt-1 pb-2 text-center outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background sm:min-h-[3.5rem]',
                active ? 'bg-primary-soft text-primary-soft-foreground' : 'hover:bg-muted', !inMonth && 'opacity-40', inMonth && closed && !active && 'text-muted-foreground')}>
              {/* Today is the one filled number; the selected day is the tinted cell. Together they still read as one shape. */}
              <span className={cn('grid size-6 place-items-center rounded-full text-[13.5px] font-bold tabular-nums', isToday && 'bg-primary text-primary-foreground')}>{Number(entry.slice(8))}</span>
              {/* Phones drop the word so "Day 10" fits in a 48px column; "A"/"B" style labels show unchanged. */}
              <small className={cn('h-[15px] max-w-full truncate text-[10.5px] font-semibold leading-[15px]', !active && 'text-muted-foreground')}><span className="max-sm:hidden">{caption}</span><span className="sm:hidden">{caption.replace(/^Day\s+/i, '')}</span></small>
              {dueCount ? <span aria-hidden="true" className="absolute bottom-1 size-1.5 rounded-full bg-primary" /> : null}
              {adjusted.has(entry) && <Icon name="edit" size={9} aria-hidden="true" className="absolute top-1 right-1 text-muted-foreground" />}
            </button>;
          })}
        </div>
        <div className="flex items-center justify-between gap-2 border-t border-foreground/[0.06] pt-3">
          <Button size="sm" variant={date === today ? 'soft' : 'ghost'} onClick={() => setDate(today)}>Today</Button>
          <label className="sr-only" htmlFor="schedule-date">Go to date</label>
          <Input id="schedule-date" type="date" value={date} min={FIRST_DATE} max={LAST_DATE} className="h-9 max-w-[150px] font-semibold" onChange={(event) => pickDate(event.target.value)} />
        </div>
      </CardContent></Card>

      <Section id="day-title" action={<Button size="sm" icon="edit" onClick={() => setAdjustDate(date)}>{override ? 'Edit adjustment' : 'Adjust this day'}</Button>}
        title={<>{isRelative ? relative : relativeDate(date, today, { weekday: 'long' })}{isRelative ? <span className="font-medium text-muted-foreground"> · {formatDate(date, { weekday: 'long' })}</span> : ''}</>}
        description={<span className="flex flex-wrap gap-1.5 pt-1">
          {selected?.closed ? <Chip icon="coffee">No school</Chip> : selected ? <Chip tone="accent" icon="layers">{selected.cycleDayLabel}</Chip> : null}
          {selected && !selected.closed && selected.periods.length > 0 && <Chip tone="outline" icon="clock">{formatRange(selected.periods[0].start, selected.periods[selected.periods.length - 1].end)}</Chip>}
          {override && <Chip tone="now" icon="edit">Adjusted by you</Chip>}
          {school.exceptions.some((entry) => entry.date === date) && !personal.customSchedule && <Chip icon="calendar">School exception</Chip>}
        </span>}>
        {selected?.closed && <p className="py-2 text-sm text-muted-foreground">No periods on this date.</p>}
        {selected && !selected.closed && selected.periods.length === 0 && <p className="py-2 text-sm text-muted-foreground">No periods on this day.</p>}
        {selected && selected.periods.length > 0 && <Timeline periods={selected.periods} now={now} timeZone={state.timeZone} tag={(period) => classmatesTag(state, date, period)} onPeriodSelect={state.personalValid ? setChangePeriod : undefined} />}
        {/* Under the timeline, as on Today: the classes are what this card is for. */}
        {selected && !selected.closed && <LunchDay state={state} date={date} />}
        {issueText && <Hint tone="danger">{issueText}{override && selected?.issues.some((issue) => issue.reason === 'shift-outside-day') ? ' Edit the adjustment to fix this.' : ''}</Hint>}
        {due.length > 0 && <section className="grid gap-2 border-t border-foreground/[0.06] pt-4" aria-labelledby="schedule-due-title">
          <h3 id="schedule-due-title" className="text-[11px] font-extrabold uppercase tracking-[0.12em] text-muted-foreground">{dueTitle}</h3>
          <ul className="grid gap-1">{due.map((item) => <TaskRow key={item.id} item={item} state={state} showDate={false} onComplete={onComplete} />)}</ul>
        </section>}
        {undoBar}
        <ImportedEvents state={state} date={date} />
      </Section>
    </div>

    <DateAdjustmentSheet open={adjustDate !== null} onClose={() => setAdjustDate(null)} date={adjustDate ?? date} school={school} personal={personal} save={state.savePersonal} />
    {state.personalValid && <PeriodSheet state={state} period={changePeriod} date={date} onClose={() => setChangePeriod(null)} onAdjustDay={() => { setChangePeriod(null); setAdjustDate(date); }} />}
  </div>;
}
