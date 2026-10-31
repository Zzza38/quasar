import { cycleDaySlots, effectiveSchedule, type PersonalSchedule, type Schedule } from './schedule';

/** The caller supplies the effective grade/private schedule. */
export function scheduledPeriodIds(schedule: Schedule, personal?: PersonalSchedule): Set<string> {
  return new Set([
    ...schedule.cycleDays.flatMap(day => (personal ? cycleDaySlots(day, personal) : day.slots).map(slot => slot.periodId)),
    ...schedule.exceptions.flatMap(exception => 'slots' in exception ? (exception.slots ?? []).map(slot => slot.periodId) : []),
    ...(personal?.dateOverrides.flatMap(override => (override.slots ?? []).map(slot => slot.periodId)) ?? []),
  ]);
}

/**
 * Class blocks in the rotation with neither a class nor a free mark, when there are only one or two and at least one
 * other block has a class: those are most likely the student's free periods. A student with no classes placed gets none.
 */
export function suggestedFreePeriodIds(school: Schedule, personal: PersonalSchedule): Set<string> {
  const schedule = effectiveSchedule(school, personal);
  const classIds = new Set(personal.classes.map(cls => cls.id));
  const blocks = [...new Set(schedule.cycleDays.flatMap(day => cycleDaySlots(day, personal).map(slot => slot.periodId)))]
    .filter(id => schedule.periods.find(period => period.id === id)?.kind === 'class');
  const placed = blocks.filter(id => classIds.has(personal.assignments[id]));
  const empty = blocks.filter(id => !classIds.has(personal.assignments[id]) && !personal.freePeriods?.includes(id));
  return empty.length > 0 && empty.length <= 2 && placed.length > 0 ? new Set(empty) : new Set();
}

/** Marks `periodId` a free period, dropping any (dangling) class assignment it had. */
export function markFreePeriod(personal: PersonalSchedule, periodId: string): PersonalSchedule {
  const { [periodId]: _dropped, ...assignments } = personal.assignments;
  return { ...personal, assignments, freePeriods: [...(personal.freePeriods ?? []).filter(id => id !== periodId), periodId] };
}
