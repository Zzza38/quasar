'use client';

import { useMemo, useState } from 'react';
import { displayPeriodLabel, resolveDayInRange } from '@/domain/schedule';
import { addDays, classColor, formatDate, formatRange, relativeDate } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { AppState } from './app-state';
import { Icon } from './icon';
import { effectiveSchedule } from './overrides';
import { Button, Chip, ColorDot, Hint } from './primitives';

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
      const day = resolveDayInRange(school, date, personal);
      if (!day) break;
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
      return <div key={day.id} className={cn('grid self-start overflow-hidden rounded-2xl bg-muted/70 ring-1 ring-inset ring-foreground/[0.04] transition-colors', isToday && 'ring-primary/40', expanded && 'bg-card shadow-card ring-foreground/[0.06]', expanded && isToday && 'ring-primary/40')}>
        {/* One control per row: the row opens the day, and the jump and adjust actions live inside it. */}
        <button type="button" className="flex min-w-0 items-center gap-3 rounded-2xl p-3 text-left outline-none transition-colors hover:bg-foreground/[0.03] focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset" aria-expanded={expanded} onClick={() => setOpen(expanded ? null : day.id)}>
          <span className={cn('grid size-9 shrink-0 place-items-center rounded-xl text-[13px] font-extrabold tabular-nums', isToday ? 'bg-primary-soft text-primary-soft-foreground inset-ring inset-ring-primary/50' : 'bg-card text-foreground shadow-card ring-1 ring-foreground/[0.06]')}>{multi ? index + 1 : <Icon name="calendar" size={16} />}</span>
          <span className="grid min-w-0 flex-1">
            <strong className="flex items-center gap-1.5 text-sm font-bold"><span className="truncate">{day.label}</span>{override && <Chip tone="now">Adjusted</Chip>}</strong>
            <Hint className="truncate">{slots.length === 0 ? 'No periods' : <>{slots.length} periods<span className="max-sm:hidden"> · {formatRange(slots[0].start, slots[slots.length - 1].end)}</span></>}</Hint>
          </span>
          {next && multi && <span className={cn('shrink-0 whitespace-nowrap text-xs tabular-nums', isToday ? 'font-bold text-primary-soft-foreground' : 'font-semibold text-muted-foreground')}><span className="sr-only">Next: </span>{nextLabel(next, today)}</span>}
          <Icon name="chevronDown" size={16} className={cn('shrink-0 text-muted-foreground transition-transform', expanded && 'rotate-180')} />
        </button>
        {expanded && <ul className="grid gap-1 border-t border-foreground/[0.05] px-3 py-3 text-sm">
          {slots.map((slot) => {
            const period = schedule.periods.find((entry) => entry.id === slot.periodId);
            const cls = personal.classes.find((entry) => entry.id === personal.assignments[slot.periodId]);
            return <li key={slot.id} className="flex items-center gap-2.5 rounded-lg px-1 py-1"><ColorDot color={classColor(cls?.id, period?.kind ?? 'other', cls?.color).dot} /><span className="min-w-0 flex-1 truncate font-medium">{cls?.name ?? displayPeriodLabel(period, false)}{cls && period && cls.name !== displayPeriodLabel(period, cls.name) ? <span className="font-normal text-muted-foreground"> · {period.label}</span> : ''}</span><span className="text-xs tabular-nums text-muted-foreground">{formatRange(slot.start, slot.end)}</span></li>;
          })}
          {slots.length === 0 && <li className="text-xs text-muted-foreground">No periods on this day.</li>}
        </ul>}
        {expanded && <div className="flex flex-wrap justify-end gap-2 border-t border-foreground/[0.05] px-3 py-2.5">
          {next && multi && onJump && <Button size="sm" icon="calendar" onClick={() => onJump(next)}>{isToday ? 'Show today' : `Show ${formatDate(next, { weekday: 'short' })}`}</Button>}
          <Button size="sm" icon="edit" onClick={() => onAdjust(day.id)}>Adjust {day.label}</Button>
        </div>}
      </div>;
    })}
  </div>;
}
