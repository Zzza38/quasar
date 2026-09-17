import { cycleDaySchema, type Schedule, type ScheduleSlot } from '@/domain/schedule';

export type PeriodPlacement = { periodId: string; dayId?: string; slotId?: string };
export const minutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
export const clockTime = (value: number) => `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;

/** Move a block or change its duration without changing other blocks. */
export function placeTimedPeriod(schedule: Schedule, source: PeriodPlacement, dayId: string, time: Pick<ScheduleSlot, 'start' | 'end'>, newId: string): Schedule | string {
  const sourceSlot = source.dayId ? schedule.cycleDays.find(day => day.id === source.dayId)?.slots.find(slot => slot.id === source.slotId) : undefined;
  if (!schedule.cycleDays.some(day => day.id === dayId) || !schedule.periods.some(period => period.id === source.periodId) || (source.dayId && (!sourceSlot || sourceSlot.periodId !== source.periodId))) return 'This period changed. Select it again.';
  const next = { ...schedule, cycleDays: schedule.cycleDays.map(day => {
    let slots = day.id === source.dayId ? day.slots.filter(slot => slot.id !== source.slotId) : [...day.slots];
    if (day.id === dayId) slots.push({ id: source.dayId === dayId ? source.slotId! : newId, periodId: source.periodId, start: time.start, end: time.end });
    return { ...day, slots: slots.sort((a, b) => a.start.localeCompare(b.start)) };
  }) };
  for (const day of next.cycleDays.filter(day => day.id === dayId || day.id === source.dayId)) {
    if (!cycleDaySchema.safeParse(day).success) return 'That block overlaps another class or has invalid times. Choose a free time.';
  }
  return next;
}
