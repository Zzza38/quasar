'use client';

import { useEffect, useMemo, useState } from 'react';
import { dateSchema, resolveDay } from '@/domain/schedule';
import { addDays, classColor, formatDate, formatRange, relativeDate, weekOf } from '@/lib/format';
import type { AppState } from '../app-state';
import { Icon } from '../icon';
import { AdjustmentsList, CycleDayAdjustmentSheet, DateAdjustmentSheet, effectiveSchedule } from '../overrides';
import { Button, Chip, ColorDot, IconButton, Input, SectionHeader } from '../ui';
import { Timeline } from './today';

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

  return <div className="grid gap-4 fade-in">
    <header className="flex items-end justify-between gap-3 flex-wrap">
      <div><h1>Schedule</h1><p className="text-sm text-text-2">Times in {schedule.timeZone.replaceAll('_', ' ')}{personal.customSchedule ? ' · your private schedule' : ''}</p></div>
      <div className="flex items-center gap-1.5">
        <IconButton label="Previous day" icon="chevronLeft" variant="secondary" onClick={() => setDate(addDays(date, -1))} />
        <Button size="sm" variant={date === today ? 'soft' : 'secondary'} onClick={() => setDate(today)}>Today</Button>
        <IconButton label="Next day" icon="chevronRight" variant="secondary" onClick={() => setDate(addDays(date, 1))} />
        <label className="sr-only" htmlFor="schedule-date">Go to date</label>
        <Input id="schedule-date" small type="date" value={date} min="1900-01-01" max="2199-12-31" className="max-w-[150px]" onChange={(event) => { if (event.target.value && dateSchema.safeParse(event.target.value).success) setDate(event.target.value); }} />
      </div>
    </header>

    <section className="card card-pad grid gap-3" aria-label="Week">
      <div className="flex items-center justify-between gap-2">
        <IconButton label="Previous week" icon="chevronLeft" onClick={() => setDate(addDays(date, -7))} />
        <strong className="text-sm">{formatDate(week[0].date)} – {formatDate(week[6].date, { year: true })}</strong>
        <IconButton label="Next week" icon="chevronRight" onClick={() => setDate(addDays(date, 7))} />
      </div>
      <div className="week-strip">
        {week.map(({ date: entry, day }) => <button key={entry} type="button" className={`week-day${entry === today ? ' today' : ''}${day.closed ? ' closed' : ''}`} aria-pressed={entry === date} onClick={() => setDate(entry)} aria-label={`${formatDate(entry, { weekday: 'long' })}: ${day.closed ? 'no school' : day.cycleDayLabel}`}>
          <span>{formatDate(entry, { weekday: 'short' }).slice(0, 3)}</span><strong>{Number(entry.slice(8))}</strong><small>{day.closed ? '—' : rotation ? day.cycleDayLabel : `${day.periods.length} periods`}</small>
        </button>)}
      </div>
    </section>

    <section className="card card-pad grid gap-3" aria-labelledby="day-title">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h2 id="day-title" className="text-[17px]">{relativeDate(date, today, { weekday: 'long' })}{['Today', 'Tomorrow', 'Yesterday'].includes(relativeDate(date, today)) ? <span className="text-text-2 font-medium"> · {formatDate(date, { weekday: 'long' })}</span> : ''}</h2>
          <div className="flex gap-1.5 flex-wrap mt-1">
            {selected?.closed ? <Chip icon="coffee">No school</Chip> : selected ? <Chip tone="accent" icon="layers">{selected.cycleDayLabel}</Chip> : null}
            {override && <Chip tone="now" icon="edit">Adjusted by you</Chip>}
            {school.exceptions.some((entry) => entry.date === date) && !personal.customSchedule && <Chip icon="calendar">School exception</Chip>}
          </div>
        </div>
        <Button size="sm" icon="edit" onClick={() => setAdjustDate(date)}>{override ? 'Edit adjustment' : 'Adjust this day'}</Button>
      </div>
      {selected?.closed && <p className="text-sm text-text-2 py-2">No periods on this date.</p>}
      {selected && !selected.closed && selected.periods.length === 0 && <p className="text-sm text-text-2 py-2">No periods on this day.</p>}
      {selected && selected.periods.length > 0 && <Timeline periods={selected.periods} now={now} />}
      {selected && selected.issues.length > 0 && <p className="hint" style={{ color: 'var(--danger-text)' }}>{selected.issues.length} period(s) could not be placed on this date{selected.issues.some((issue) => issue.reason === 'shift-outside-day') ? ' because a time shift moves them outside the day' : ''}. Edit the adjustment to fix this.</p>}
    </section>

    <section className="card card-pad grid gap-3" aria-labelledby="rotation-title">
      <SectionHeader title={<span id="rotation-title">{rotation ? 'Rotation' : 'Daily bell schedule'}</span>} description={rotation ? `${schedule.cycleDays.length} rotation days. Weekends${school.exceptions.length ? ', closures' : ''} and non-school days pause the cycle unless the school says otherwise.` : 'The same periods repeat every school day.'} />
      <RotationOverview state={state} onAdjust={setAdjustCycleDay} onJump={setDate} />
    </section>

    {(personal.dateOverrides.length > 0 || personal.cycleDayOverrides.length > 0) && <section className="card card-pad grid gap-3" aria-labelledby="adjustments-title">
      <SectionHeader title={<span id="adjustments-title">Your adjustments</span>} description="Only your view changes. The school schedule stays the same for everyone else." />
      <AdjustmentsList school={school} personal={personal} save={state.savePersonal} onEditDate={(entry) => { setDate(entry); setAdjustDate(entry); }} onEditCycleDay={setAdjustCycleDay} />
    </section>}

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
      return <div key={day.id} className="panel">
        <div className="flex items-center gap-2 p-3">
          <button type="button" className="flex items-center gap-2 min-w-0 flex-1 text-left" aria-expanded={expanded} onClick={() => setOpen(expanded ? null : day.id)}>
            <Icon name={expanded ? 'chevronDown' : 'chevronRight'} size={16} className="text-text-3" />
            <span className="min-w-0 grid">
              <strong className="text-sm truncate">{day.label}{override && <span className="chip chip-now ml-2">Adjusted</span>}</strong>
              <span className="hint">{slots.length === 0 ? 'No periods' : `${slots.length} periods · ${formatRange(slots[0].start, slots[slots.length - 1].end)}`}{next && schedule.cycleDays.length > 1 ? ` · ${next === today ? 'today' : `next ${relativeDate(next, today) === 'Tomorrow' ? 'tomorrow' : formatDate(next, { weekday: 'short' })}`}` : ''}</span>
            </span>
          </button>
          {next && onJump && <Button size="sm" variant="ghost" className="max-[560px]:hidden" onClick={() => onJump(next)} aria-label={`Show ${day.label} on ${formatDate(next)}`}>{formatDate(next)}</Button>}
          <IconButton size="sm" icon="edit" onClick={() => onAdjust(day.id)} label={`Adjust ${day.label}`} />
        </div>
        {expanded && <ul className="grid gap-1 px-3 pb-3 text-sm">
          {slots.map((slot) => {
            const period = schedule.periods.find((entry) => entry.id === slot.periodId);
            const cls = personal.classes.find((entry) => entry.id === personal.assignments[slot.periodId]);
            return <li key={slot.id} className="flex items-center gap-2"><ColorDot color={classColor(cls?.id, period?.kind ?? 'other').dot} /><span className="min-w-0 flex-1 truncate">{cls?.name ?? period?.label ?? slot.periodId}{cls && period && cls.name !== period.label ? <span className="text-text-3"> · {period.label}</span> : ''}</span><span className="tabular text-text-2">{formatRange(slot.start, slot.end)}</span></li>;
          })}
          {slots.length === 0 && <li className="hint">No periods on this day.</li>}
        </ul>}
      </div>;
    })}
  </div>;
}
