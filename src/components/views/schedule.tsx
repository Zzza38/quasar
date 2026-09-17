'use client';

import { useEffect, useMemo, useState } from 'react';
import { dateSchema, resolveDay } from '@/domain/schedule';
import { addDays, classColor, formatDate, formatRange, relativeDate, weekOf } from '@/lib/format';
import type { AppState } from '../app-state';
import { Icon } from '../icon';
import { AdjustmentsList, CycleDayAdjustmentSheet, DateAdjustmentSheet, effectiveSchedule } from '../overrides';
import { Button, Chip, ColorDot, Hint, IconButton, Input, Panel, Section, WeekStrip } from '../primitives';
import { Card, CardContent } from '../ui/card';
import { Timeline } from './today';
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

  return <div className="grid gap-4 animate-in fade-in-0 duration-200">
    <header className="flex flex-wrap items-end justify-between gap-3">
      <h1>Schedule</h1>
      <div className="flex items-center gap-1.5">
        <IconButton label="Previous day" icon="chevronLeft" variant="secondary" onClick={() => setDate(addDays(date, -1))} />
        <Button size="sm" variant={date === today ? 'soft' : 'secondary'} onClick={() => setDate(today)}>Today</Button>
        <IconButton label="Next day" icon="chevronRight" variant="secondary" onClick={() => setDate(addDays(date, 1))} />
        <label className="sr-only" htmlFor="schedule-date">Go to date</label>
        <Input id="schedule-date" type="date" value={date} min="1900-01-01" max="2199-12-31" className="max-w-[150px]" onChange={(event) => { if (event.target.value && dateSchema.safeParse(event.target.value).success) setDate(event.target.value); }} />
      </div>
    </header>

    <Card aria-label="Week"><CardContent className="grid gap-3">
      <div className="flex items-center justify-between gap-2">
        <IconButton label="Previous week" icon="chevronLeft" onClick={() => setDate(addDays(date, -7))} />
        <strong className="text-sm">{formatDate(week[0].date)} – {formatDate(week[6].date, { year: true })}</strong>
        <IconButton label="Next week" icon="chevronRight" onClick={() => setDate(addDays(date, 7))} />
      </div>
      <WeekStrip selected={date} today={today} onSelect={setDate} days={week.map(({ date: entry, day }) => ({ date: entry, closed: day.closed, caption: day.closed ? '—' : rotation ? day.cycleDayLabel : `${day.periods.length} periods`, label: `${formatDate(entry, { weekday: 'long' })}: ${day.closed ? 'no school' : day.cycleDayLabel}` }))} />
    </CardContent></Card>

    <Section id="day-title" action={<Button size="sm" icon="edit" onClick={() => setAdjustDate(date)}>{override ? 'Edit adjustment' : 'Adjust this day'}</Button>}
      title={<>{relativeDate(date, today, { weekday: 'long' })}{['Today', 'Tomorrow', 'Yesterday'].includes(relativeDate(date, today)) ? <span className="font-medium text-muted-foreground"> · {formatDate(date, { weekday: 'long' })}</span> : ''}</>}
      description={<span className="flex flex-wrap gap-1.5">
        {selected?.closed ? <Chip icon="coffee">No school</Chip> : selected ? <Chip tone="accent" icon="layers">{selected.cycleDayLabel}</Chip> : null}
        {override && <Chip tone="now" icon="edit">Adjusted by you</Chip>}
        {school.exceptions.some((entry) => entry.date === date) && !personal.customSchedule && <Chip icon="calendar">School exception</Chip>}
      </span>}>
      {selected?.closed && <p className="py-2 text-sm text-muted-foreground">No periods on this date.</p>}
      {selected && !selected.closed && selected.periods.length === 0 && <p className="py-2 text-sm text-muted-foreground">No periods on this day.</p>}
      {selected && selected.periods.length > 0 && <Timeline periods={selected.periods} now={now} />}
      {selected && selected.issues.length > 0 && <Hint tone="danger">{selected.issues.length} period(s) could not be placed on this date{selected.issues.some((issue) => issue.reason === 'shift-outside-day') ? ' because a time shift moves them outside the day' : ''}. Edit the adjustment to fix this.</Hint>}
      <ImportedEvents state={state} date={date} />
    </Section>

    <Section id="rotation-title" title={rotation ? 'Rotation' : 'Daily bell schedule'}>
      <RotationOverview state={state} onAdjust={setAdjustCycleDay} onJump={setDate} />
    </Section>

    {(personal.dateOverrides.length > 0 || personal.cycleDayOverrides.length > 0) && <Section id="adjustments-title" title="Your adjustments">
      <AdjustmentsList school={school} personal={personal} save={state.savePersonal} onEditDate={(entry) => { setDate(entry); setAdjustDate(entry); }} onEditCycleDay={setAdjustCycleDay} />
    </Section>}

    <CalendarFeeds state={state} />
    <DateAdjustmentSheet open={adjustDate !== null} onClose={() => setAdjustDate(null)} date={adjustDate ?? date} school={school} personal={personal} save={state.savePersonal} />
    <CycleDayAdjustmentSheet open={adjustCycleDay !== null} onClose={() => setAdjustCycleDay(null)} cycleDayId={adjustCycleDay} school={school} personal={personal} save={state.savePersonal} />
  </div>;
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
  return <div className="grid gap-2">
    {schedule.cycleDays.map((day) => {
      const override = personal.cycleDayOverrides.find((entry) => entry.cycleDayId === day.id);
      const slots = override?.slots ?? day.slots;
      const expanded = open === day.id;
      const next = nextDates.get(day.id);
      return <Panel key={day.id} className="p-0">
        <div className="flex items-center gap-2 p-3">
          <button type="button" className="flex min-w-0 flex-1 items-center gap-2 rounded-md text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50" aria-expanded={expanded} onClick={() => setOpen(expanded ? null : day.id)}>
            <Icon name={expanded ? 'chevronDown' : 'chevronRight'} size={16} className="text-muted-foreground" />
            <span className="grid min-w-0">
              <strong className="truncate text-sm">{day.label}{override && <Chip tone="now" className="ml-2">Adjusted</Chip>}</strong>
              <Hint>{slots.length === 0 ? 'No periods' : `${slots.length} periods · ${formatRange(slots[0].start, slots[slots.length - 1].end)}`}{next && schedule.cycleDays.length > 1 ? ` · ${next === today ? 'today' : `next ${relativeDate(next, today) === 'Tomorrow' ? 'tomorrow' : formatDate(next, { weekday: 'short' })}`}` : ''}</Hint>
            </span>
          </button>
          {next && onJump && <Button size="sm" variant="ghost" className="max-[560px]:hidden" onClick={() => onJump(next)} aria-label={`Show ${day.label} on ${formatDate(next)}`}>{formatDate(next)}</Button>}
          <IconButton size="sm" icon="edit" onClick={() => onAdjust(day.id)} label={`Adjust ${day.label}`} />
        </div>
        {expanded && <ul className="grid gap-1 px-3 pb-3 text-sm">
          {slots.map((slot) => {
            const period = schedule.periods.find((entry) => entry.id === slot.periodId);
            const cls = personal.classes.find((entry) => entry.id === personal.assignments[slot.periodId]);
            return <li key={slot.id} className="flex items-center gap-2"><ColorDot color={classColor(cls?.id, period?.kind ?? 'other', cls?.color).dot} /><span className="min-w-0 flex-1 truncate">{cls?.name ?? period?.label ?? slot.periodId}{cls && period && cls.name !== period.label ? <span className="text-muted-foreground"> · {period.label}</span> : ''}</span><span className="tabular-nums text-muted-foreground">{formatRange(slot.start, slot.end)}</span></li>;
          })}
          {slots.length === 0 && <li className="text-xs text-muted-foreground">No periods on this day.</li>}
        </ul>}
      </Panel>;
    })}
  </div>;
}
