'use client';

import { useEffect, useMemo, useState } from 'react';
import { dateSchema, resolveDay } from '@/domain/schedule';
import { addDays, classColor, formatDate, formatRange, relativeDate, weekOf } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { AppState } from '../app-state';
import { Icon } from '../icon';
import { AdjustmentsList, CycleDayAdjustmentSheet, DateAdjustmentSheet, effectiveSchedule } from '../overrides';
import { Button, Chip, ColorDot, Hint, IconButton, Input, PageHeader, Section, WeekStrip } from '../primitives';
import { Card, CardContent } from '../ui/card';
import { Timeline } from './today';
import { classmatesFor, withLabel } from '@/lib/classmates';
import { CalendarFeeds } from '../calendar-feeds';
import { ImportedEvents } from '../imported-events';

export function ScheduleView({ state }: { state: AppState }) {
  const { schedule: school, personal, now, today } = state;
  const schedule = effectiveSchedule(school, personal);
  const requested = state.params.get('date');
  const [date, setDate] = useState(() => requested && dateSchema.safeParse(requested).success ? requested : today);
  useEffect(() => { if (requested) state.navigate('schedule'); }, [requested, state]);
  const [adjustDate, setAdjustDate] = useState<string | null>(null);
  const [adjustCycleDay, setAdjustCycleDay] = useState<string | null>(null);

  const week = useMemo(() => weekOf(date).map((entry) => ({ date: entry, day: resolveDay(school, entry, personal) })), [school, date, personal]);
  const selected = useMemo(() => { try { return resolveDay(school, date, personal); } catch { return null; } }, [school, date, personal]);
  const override = personal.dateOverrides.find((entry) => entry.date === date);
  const rotation = schedule.cycleDays.length > 1;
  const relative = relativeDate(date, today);
  const isRelative = ['Today', 'Tomorrow', 'Yesterday'].includes(relative);

  return <div className="grid gap-5 animate-in fade-in-0 duration-300">
    <PageHeader title="Schedule" eyebrow={rotation ? `${schedule.cycleDays.length}-day rotation` : 'Daily bell schedule'}
      actions={<div className="flex items-center gap-1.5">
        <div className="flex items-center rounded-xl bg-card p-1 shadow-card ring-1 ring-foreground/[0.06]">
          <IconButton label="Previous day" icon="chevronLeft" variant="ghost" size="sm" onClick={() => setDate(addDays(date, -1))} />
          <Button size="sm" variant={date === today ? 'soft' : 'ghost'} onClick={() => setDate(today)}>Today</Button>
          <IconButton label="Next day" icon="chevronRight" variant="ghost" size="sm" onClick={() => setDate(addDays(date, 1))} />
        </div>
        <label className="sr-only" htmlFor="schedule-date">Go to date</label>
        <Input id="schedule-date" type="date" value={date} min="1900-01-01" max="2199-12-31" className="h-10 max-w-[150px] font-semibold" onChange={(event) => { if (event.target.value && dateSchema.safeParse(event.target.value).success) setDate(event.target.value); }} />
      </div>} />

    <Card aria-label="Week"><CardContent className="grid gap-3">
      <div className="flex items-center justify-between gap-2">
        <IconButton label="Previous week" icon="chevronLeft" size="sm" onClick={() => setDate(addDays(date, -7))} />
        <strong className="text-sm font-bold tracking-tight">{formatDate(week[0].date)} – {formatDate(week[6].date, { year: true })}</strong>
        <IconButton label="Next week" icon="chevronRight" size="sm" onClick={() => setDate(addDays(date, 7))} />
      </div>
      <WeekStrip selected={date} today={today} onSelect={setDate} days={week.map(({ date: entry, day }) => ({ date: entry, closed: day.closed, caption: day.closed ? '-' : rotation ? day.cycleDayLabel : `${day.periods.length} periods`, label: `${formatDate(entry, { weekday: 'long' })}: ${day.closed ? 'no school' : day.cycleDayLabel}` }))} />
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
      {selected && selected.periods.length > 0 && <Timeline periods={selected.periods} now={now} timeZone={state.timeZone} tag={(period) => withLabel(classmatesFor(state.context, period))} />}
      {selected && selected.issues.length > 0 && <Hint tone="danger">{selected.issues.length} period(s) could not be placed on this date{selected.issues.some((issue) => issue.reason === 'shift-outside-day') ? ' because a time shift moves them outside the day' : ''}. Edit the adjustment to fix this.</Hint>}
      <ImportedEvents state={state} date={date} />
    </Section>

    <Section id="rotation-title" title={rotation ? 'Rotation' : 'Daily bell schedule'} description={rotation ? 'Every day of the cycle and when it comes up next.' : undefined}>
      <RotationOverview state={state} onAdjust={setAdjustCycleDay} onJump={setDate} />
    </Section>

    {(personal.dateOverrides.length > 0 || personal.cycleDayOverrides.length > 0) && <Section id="adjustments-title" title="Your adjustments" icon="edit">
      <AdjustmentsList school={school} personal={personal} save={state.savePersonal} onEditDate={(entry) => { setDate(entry); setAdjustDate(entry); }} onEditCycleDay={setAdjustCycleDay} />
    </Section>}

    <CalendarFeeds state={state} />
    <DateAdjustmentSheet open={adjustDate !== null} onClose={() => setAdjustDate(null)} date={adjustDate ?? date} school={school} personal={personal} save={state.savePersonal} />
    <CycleDayAdjustmentSheet open={adjustCycleDay !== null} onClose={() => setAdjustCycleDay(null)} cycleDayId={adjustCycleDay} school={school} personal={personal} save={state.savePersonal} />
  </div>;
}

function nextLabel(next: string, today: string): string {
  const relative = relativeDate(next, today);
  if (next === today) return 'Today';
  if (relative === 'Tomorrow') return 'Tomorrow';
  return formatDate(next, { weekday: 'short' });
}

export function RotationOverview({ state, onAdjust, onJump }: { state: AppState; onAdjust: (cycleDayId: string) => void; onJump?: (date: string) => void }) {
  const { schedule: school, personal, today } = state;
  const schedule = effectiveSchedule(school, personal);
  const [open, setOpen] = useState<string | null>(null);
  const nextDates = useMemo(() => {
    const found = new Map<string, string>();
    for (let offset = 0; offset < 90 && found.size < schedule.cycleDays.length; offset += 1) {
      const date = addDays(today, offset);
      const day = resolveDay(school, date, personal);
      if (!day.closed && !found.has(day.cycleDayId)) found.set(day.cycleDayId, date);
    }
    return found;
  }, [school, personal, today, schedule.cycleDays.length]);
  const multi = schedule.cycleDays.length > 1;
  return <div className={cn('grid gap-2.5', multi && 'sm:grid-cols-2')}>
    {schedule.cycleDays.map((day, index) => {
      const override = personal.cycleDayOverrides.find((entry) => entry.cycleDayId === day.id);
      const slots = override?.slots ?? day.slots;
      const expanded = open === day.id;
      const next = nextDates.get(day.id);
      const isToday = next === today;
      return <div key={day.id} className={cn('grid gap-0 self-start overflow-hidden rounded-2xl bg-muted/70 ring-1 ring-inset ring-foreground/[0.04] transition-colors', isToday && 'bg-primary-soft/60 ring-primary/30', expanded && 'bg-card shadow-card ring-foreground/[0.06]')}>
        <div className="flex items-center gap-2 p-3">
          <button type="button" className="flex min-w-0 flex-1 items-center gap-3 rounded-lg text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50" aria-expanded={expanded} onClick={() => setOpen(expanded ? null : day.id)}>
            <span className={cn('grid size-9 shrink-0 place-items-center rounded-xl text-[13px] font-extrabold tabular-nums', isToday ? 'bg-primary text-primary-foreground' : 'bg-card text-foreground shadow-card ring-1 ring-foreground/[0.06]')}>{multi ? index + 1 : <Icon name="calendar" size={16} />}</span>
            <span className="grid min-w-0 flex-1">
              <strong className="flex items-center gap-1.5 text-sm font-bold"><span className="truncate">{day.label}</span>{override && <Chip tone="now">Adjusted</Chip>}</strong>
              <Hint className="truncate">{slots.length === 0 ? 'No periods' : `${slots.length} periods · ${formatRange(slots[0].start, slots[slots.length - 1].end)}`}</Hint>
            </span>
            <Icon name="chevronDown" size={16} className={cn('shrink-0 text-muted-foreground transition-transform', expanded && 'rotate-180')} />
          </button>
          {next && multi && onJump && <Button size="sm" variant={isToday ? 'soft' : 'ghost'} className="shrink-0 whitespace-nowrap px-2 text-xs" onClick={() => onJump(next)} aria-label={`Show ${day.label} on ${formatDate(next)}`}>{nextLabel(next, today)}</Button>}
          <IconButton size="sm" icon="edit" onClick={() => onAdjust(day.id)} label={`Adjust ${day.label}`} />
        </div>
        {expanded && <ul className="grid gap-1 border-t border-foreground/[0.05] px-3 py-3 text-sm">
          {slots.map((slot) => {
            const period = schedule.periods.find((entry) => entry.id === slot.periodId);
            const cls = personal.classes.find((entry) => entry.id === personal.assignments[slot.periodId]);
            return <li key={slot.id} className="flex items-center gap-2.5 rounded-lg px-1 py-1"><ColorDot color={classColor(cls?.id, period?.kind ?? 'other', cls?.color).dot} /><span className="min-w-0 flex-1 truncate font-medium">{cls?.name ?? period?.label ?? slot.periodId}{cls && period && cls.name !== period.label ? <span className="font-normal text-muted-foreground"> · {period.label}</span> : ''}</span><span className="text-xs tabular-nums text-muted-foreground">{formatRange(slot.start, slot.end)}</span></li>;
          })}
          {slots.length === 0 && <li className="text-xs text-muted-foreground">No periods on this day.</li>}
        </ul>}
      </div>;
    })}
  </div>;
}
