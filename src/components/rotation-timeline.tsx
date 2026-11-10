'use client';

import { useMemo, useState, type CSSProperties } from 'react';
import { REMOVED_PERIOD_LABEL, cycleDaySlots, displayPeriodLabel, type PersonalSchedule, type ResolvedPeriod, type Schedule } from '@/domain/schedule';
import { formatDate, formatRange, relativeDate } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { AppState } from './app-state';
import { effectiveSchedule } from './overrides';
import { Button, Chip, ChoiceGroup, ChoiceItem, Hint } from './primitives';
import { nextCycleDates } from './rotation-overview';
import { Timeline } from './views/today';

/** A moment before every period, so the Today timeline draws a rotation day with no "now" row and nothing faded. */
const BEFORE_ALL = new Date(0);

/**
 * A cycle day's periods in the shape the Today timeline draws. The times are the rotation's own, with this student's
 * recurring adjustments, and not those of any one date: an exception or a one-day change does not show here.
 */
export function cycleDayPeriods(schedule: Schedule, day: Schedule['cycleDays'][number], personal: PersonalSchedule): ResolvedPeriod[] {
  return cycleDaySlots(day, personal)
    .filter((slot) => slot.start < slot.end)
    .sort((left, right) => left.start.localeCompare(right.start))
    .map((slot) => {
      const period = schedule.periods.find((entry) => entry.id === slot.periodId);
      const assigned = personal.classes.find((entry) => entry.id === personal.assignments[slot.periodId]);
      return {
        slotId: slot.id, periodId: slot.periodId,
        label: period ? displayPeriodLabel(period, assigned?.name ?? false) : assigned?.name ?? REMOVED_PERIOD_LABEL,
        kind: period?.kind ?? 'other',
        start: slot.start, end: slot.end,
        // The timeline only compares these with BEFORE_ALL, so any date does.
        startAt: `2000-01-01T${slot.start}:00Z`, endAt: `2000-01-01T${slot.end}:00Z`,
        ...(assigned ? { class: assigned } : period?.kind === 'class' && personal.freePeriods?.includes(slot.periodId) ? { free: true as const } : {}),
      };
    });
}

/**
 * The rotation drawn like the Today card: pick a day of the cycle, and its periods show as the same timeline rows.
 * It opens on today's cycle day, or on the next school day's when there is no school today.
 */
export function RotationTimeline({ state, onAdjust, onJump }: { state: AppState; onAdjust: (cycleDayId: string) => void; onJump?: (date: string) => void }) {
  const { schedule: school, personal, today } = state;
  const schedule = effectiveSchedule(school, personal);
  const nextDates = useMemo(() => nextCycleDates(school, personal, today, schedule.cycleDays.length), [school, personal, today, schedule.cycleDays.length]);
  const soonest = useMemo(() => [...nextDates].sort((left, right) => left[1].localeCompare(right[1]))[0]?.[0], [nextDates]);
  const [picked, setPicked] = useState<string | null>(null);
  const day = schedule.cycleDays.find((entry) => entry.id === picked) ?? schedule.cycleDays.find((entry) => entry.id === soonest) ?? schedule.cycleDays[0];
  const periods = useMemo(() => day ? cycleDayPeriods(schedule, day, personal) : [], [schedule, day, personal]);
  if (!day) return <Hint>This schedule has no days yet.</Hint>;
  const count = schedule.cycleDays.length;
  const multi = count > 1;
  const next = nextDates.get(day.id);
  const adjusted = personal.cycleDayOverrides.some((entry) => entry.cycleDayId === day.id);
  // Phones fit six tiles across; a longer rotation wraps into two even rows.
  const columns = { '--cols': count <= 10 ? count : Math.ceil(count / 2), '--cols-phone': count <= 6 ? count : Math.ceil(count / 2) } as CSSProperties;
  return <div className="grid gap-4">
    {multi && <div style={columns}>
      <ChoiceGroup label="Day of the rotation" value={day.id} onChange={setPicked} className="grid grid-cols-[repeat(var(--cols-phone),minmax(0,1fr))] gap-1.5 sm:grid-cols-[repeat(var(--cols),minmax(0,1fr))]">
        {schedule.cycleDays.map((entry, index) => {
          const date = nextDates.get(entry.id);
          const isToday = date === today;
          return <ChoiceItem key={entry.id} value={entry.id} aria-label={`${entry.label}${date ? `, next ${relativeDate(date, today, { weekday: 'long' })}` : ''}`}
            className={cn('group/day grid min-w-0 justify-items-center gap-0.5 rounded-2xl px-0.5 py-2 outline-none transition-[background-color,box-shadow] focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
              'text-muted-foreground hover:bg-muted data-[state=on]:bg-primary-soft data-[state=on]:text-primary-soft-foreground data-[state=on]:inset-ring data-[state=on]:inset-ring-primary/70')}>
            <span className={cn('grid size-8 place-items-center rounded-full text-[15px] font-extrabold tabular-nums text-foreground group-data-[state=on]/day:text-primary-soft-foreground', isToday && 'bg-primary-soft text-primary-soft-foreground inset-ring-[1.5px] inset-ring-primary dark:inset-ring-primary/80')}>{index + 1}</span>
            <small className="max-w-full truncate text-[10.5px] font-semibold max-sm:tracking-tight">{date ? (isToday ? 'Today' : formatDate(date, { weekday: 'short' }).slice(0, 3)) : ' '}</small>
          </ChoiceItem>;
        })}
      </ChoiceGroup>
    </div>}
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
      <div className="grid min-w-0 gap-0.5">
        <h3 className="flex flex-wrap items-center gap-2 text-[15.5px] font-bold tracking-tight">{day.label}{multi && next && <span className="font-semibold text-muted-foreground">· {relativeDate(next, today, { weekday: 'long' })}</span>}{adjusted && <Chip tone="now">Adjusted</Chip>}</h3>
        <Hint>{periods.length === 0 ? 'No periods' : `${periods.length} periods · ${formatRange(periods[0].start, periods[periods.length - 1].end)}`}</Hint>
      </div>
      <div className="flex flex-wrap gap-1">
        <Button size="sm" variant="ghost" icon="edit" onClick={() => onAdjust(day.id)}>Adjust {day.label}</Button>
        {next && onJump && <Button size="sm" variant="ghost" iconRight="arrowRight" onClick={() => onJump(next)}>Full schedule</Button>}
      </div>
    </div>
    {periods.length > 0 ? <Timeline periods={periods} now={BEFORE_ALL} /> : <p className="py-4 text-sm text-muted-foreground">No periods on this day.</p>}
  </div>;
}
