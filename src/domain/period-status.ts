import type { PersonalSchedule, Schedule } from './schedule';

/** The caller supplies the effective grade/private schedule. */
export function scheduledPeriodIds(schedule: Schedule, personal?: PersonalSchedule): Set<string> {
  return new Set([
    ...schedule.cycleDays.flatMap(day => (personal?.cycleDayOverrides.find(override => override.cycleDayId === day.id)?.slots ?? day.slots).map(slot => slot.periodId)),
    ...schedule.exceptions.flatMap(exception => 'slots' in exception ? (exception.slots ?? []).map(slot => slot.periodId) : []),
    ...(personal?.dateOverrides.flatMap(override => (override.slots ?? []).map(slot => slot.periodId)) ?? []),
  ]);
}
