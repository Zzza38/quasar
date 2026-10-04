import { cycleDaySchema, type Schedule, type ScheduleSlot } from '@/domain/schedule';

export type PeriodPlacement = { periodId: string; dayId?: string; slotId?: string };
export const minutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
export const clockTime = (value: number) => `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;

export const PLACEMENT_BLOCKED = 'That block overlaps another class or has invalid times. Choose a free time.';

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
    if (!cycleDaySchema.safeParse(day).success) return PLACEMENT_BLOCKED;
  }
  return next;
}

/**
 * The class block a carried class goes into, and the assignments that put it there, or undefined when it lands on
 * free time. `at` is the minute under the pointer and `start`/`end` the time a free placement would take.
 * Blocks are containers and classes fill them: a class from the palette takes the block (replacing what it held),
 * and a class dragged out of a block trades places with what the other block held, leaving its old block empty
 * when that was nothing. From the palette a near miss counts too: pointed at free time, a placement that would
 * overlap an empty block goes into that block. `changes` is null when the class is already in the block.
 */
export function classFill(schedule: Schedule, assignments: Record<string, string>, source: PeriodPlacement, dayId: string, at: number, start: number, end: number): { slot: ScheduleSlot; changes: Record<string, string | null> | null } | undefined {
  const classId = assignments[source.periodId];
  const day = schedule.cycleDays.find(entry => entry.id === dayId);
  if (!classId || !day) return undefined;
  const blocks = day.slots.filter(slot => schedule.periods.find(period => period.id === slot.periodId)?.kind === 'class' && !(source.dayId === dayId && source.slotId === slot.id));
  const distance = (slot: ScheduleSlot) => Math.min(Math.abs(minutes(slot.start) - at), Math.abs(minutes(slot.end) - at));
  const under = day.slots.find(entry => minutes(entry.start) <= at && at < minutes(entry.end));
  const slot = under ? blocks.find(entry => entry === under)
    : source.dayId ? undefined : blocks.filter(entry => !assignments[entry.periodId] && minutes(entry.start) < end && minutes(entry.end) > start).sort((a, b) => distance(a) - distance(b))[0];
  if (!slot) return undefined;
  const held = assignments[slot.periodId];
  if (held === classId) return { slot, changes: null };
  return { slot, changes: source.dayId ? { [slot.periodId]: classId, [source.periodId]: held ?? null } : { [slot.periodId]: classId } };
}

/**
 * The empty class block a period that is not a class (advisory, lunch, study hall) goes into, and the timetable
 * with it there, or undefined when it lands on free time or on a block that has a class. The block keeps its time
 * and becomes that period's; a block the period was dragged out of is removed. As with classes, a near miss from
 * the palette counts: pointed at free time, a placement that would overlap an empty block goes into that block.
 * A block that changed since it was picked up (another device moved it) is left to placeTimedPeriod to report.
 */
export function periodFill(schedule: Schedule, assignments: Record<string, string>, source: PeriodPlacement, dayId: string, at: number, start: number, end: number): { slot: ScheduleSlot; next: Schedule } | undefined {
  const period = schedule.periods.find(entry => entry.id === source.periodId);
  const day = schedule.cycleDays.find(entry => entry.id === dayId);
  const sourceSlot = source.dayId ? schedule.cycleDays.find(entry => entry.id === source.dayId)?.slots.find(slot => slot.id === source.slotId) : undefined;
  if (!period || period.kind === 'class' || !day || (source.dayId && sourceSlot?.periodId !== source.periodId)) return undefined;
  const empty = day.slots.filter(slot => schedule.periods.find(entry => entry.id === slot.periodId)?.kind === 'class' && !assignments[slot.periodId]);
  const distance = (slot: ScheduleSlot) => Math.min(Math.abs(minutes(slot.start) - at), Math.abs(minutes(slot.end) - at));
  const under = day.slots.find(entry => minutes(entry.start) <= at && at < minutes(entry.end));
  const slot = under ? empty.find(entry => entry === under)
    : source.dayId ? undefined : empty.filter(entry => minutes(entry.start) < end && minutes(entry.end) > start).sort((a, b) => distance(a) - distance(b))[0];
  if (!slot) return undefined;
  const next = { ...schedule, cycleDays: schedule.cycleDays.map(entry => ({ ...entry, slots: entry.slots
    .filter(item => !(entry.id === source.dayId && item.id === source.slotId))
    .map(item => entry.id === dayId && item.id === slot.id ? { ...item, periodId: source.periodId } : item) })) };
  return { slot, next };
}
