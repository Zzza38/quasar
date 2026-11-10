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
            // The Schedule month grid's cells: today is a grey tile with a short underline under its number, and the
            // chosen day is a grey outline. No accent fill and no ring inside a ring.
            className={cn('group/day grid min-h-[3rem] min-w-0 content-center justify-items-center gap-px rounded-lg px-0.5 pt-1 pb-2 text-center outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background sm:min-h-[3.5rem]',
              'data-[state=on]:inset-ring-[1.5px] data-[state=on]:inset-ring-control-border', isToday ? 'bg-foreground/[0.06] data-[state=on]:bg-foreground/[0.09]' : 'data-[state=off]:hover:bg-muted')}>
            <span className={cn('grid size-6 place-items-center rounded-full text-[13.5px] font-bold tabular-nums',
              isToday && 'relative font-extrabold after:absolute after:-bottom-px after:left-1/2 after:h-0.5 after:w-3.5 after:-translate-x-1/2 after:rounded-full after:bg-primary')}>{index + 1}</span>
            <small className="h-[15px] max-w-full truncate text-[10.5px] font-semibold leading-[15px] text-muted-foreground group-data-[state=on]/day:text-foreground">{date ? (isToday ? 'Today' : formatDate(date, { weekday: 'short' }).slice(0, 3)) : ' '}</small>
          </ChoiceItem>;
        })}
      </ChoiceGroup>
    </div>}
    {/* Inset like the timeline's rows (their px-2.5 is room for the hover tile), so the day name lines up with the times. */}
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 px-2.5">
      <div className="grid min-w-0 gap-0.5">
        <h3 className="flex flex-wrap items-center gap-2 text-[15.5px] font-bold tracking-tight">{day.label}{multi && next && <span className="font-semibold text-muted-foreground">· {relativeDate(next, today, { weekday: 'long' })}</span>}{adjusted && <Chip tone="now">Adjusted</Chip>}</h3>
        <Hint>{periods.length === 0 ? 'No periods' : `${periods.length} periods · ${formatRange(periods[0].start, periods[periods.length - 1].end)}`}</Hint>
      </div>
      <div className="flex flex-wrap gap-1">
        <Button size="sm" variant="ghost" icon="edit" onClick={() => onAdjust(day.id)}>Adjust {day.label}</Button>
        {next && onJump && <Button size="sm" variant="ghost" iconRight="arrowRight" onClick={() => onJump(next)}>Full schedule</Button>}
      </div>
    </div>
    {periods.length > 0 ? <Timeline periods={periods} now={BEFORE_ALL} /> : <p className="px-2.5 py-4 text-sm text-muted-foreground">No periods on this day.</p>}
  </div>;
}
