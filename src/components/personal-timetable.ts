import { scheduleSchema, type PersonalSchedule, type Schedule } from '@/domain/schedule';

/** Keep ordinary timetable edits as day overrides so untouched days follow school updates. */
export function saveTimetableEdit(basis: Schedule, personal: PersonalSchedule, next: Schedule, assignments: PersonalSchedule['assignments']): PersonalSchedule {
  const used = new Set(next.cycleDays.flatMap(day => day.slots.map(slot => slot.periodId)));
  next = scheduleSchema.parse({ ...next, periods: next.periods.filter(period => basis.periods.some(entry => entry.id === period.id) || used.has(period.id)) });
  const keptAssignments = { ...personal.assignments, ...Object.fromEntries(Object.entries(assignments).filter(([id]) => next.periods.some(period => period.id === id))) };
  const sameStructure = JSON.stringify(next.cycleDays.map(day => [day.id, day.label])) === JSON.stringify(basis.cycleDays.map(day => [day.id, day.label])) && next.periods.every(period => basis.periods.some(entry => JSON.stringify(entry) === JSON.stringify(period)));
  if (personal.customSchedule || !sameStructure) return { ...personal, assignments: keptAssignments, customSchedule: next, cycleDayOverrides: [] };
  const cycleDayOverrides = next.cycleDays.filter(day => JSON.stringify(day.slots) !== JSON.stringify(basis.cycleDays.find(entry => entry.id === day.id)?.slots)).map(day => ({ cycleDayId: day.id, slots: day.slots }));
  return { ...personal, assignments: keptAssignments, cycleDayOverrides };
}
