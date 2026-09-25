import { cycleDaySchema, scheduleForGrade, scheduleSchema, type PersonalSchedule, type Schedule, type ScheduleSlot } from '@/domain/schedule';
import { slugId } from '@/lib/format';

/** Keep ordinary timetable edits as day overrides so untouched days follow school updates. */
export function saveTimetableEdit(basis: Schedule, personal: PersonalSchedule, next: Schedule, assignments: PersonalSchedule['assignments']): PersonalSchedule {
  const used = new Set(next.cycleDays.flatMap(day => day.slots.map(slot => slot.periodId)));
  next = scheduleSchema.parse({ ...next, periods: next.periods.filter(period => basis.periods.some(entry => entry.id === period.id) || used.has(period.id)) });
  const keptAssignments = { ...personal.assignments, ...Object.fromEntries(Object.entries(assignments).filter(([id]) => next.periods.some(period => period.id === id))) };
  const sameStructure = JSON.stringify(next.cycleDays.map(day => [day.id, day.label])) === JSON.stringify(basis.cycleDays.map(day => [day.id, day.label])) && next.periods.every(period => basis.periods.some(entry => JSON.stringify(entry) === JSON.stringify(period)));
  if (personal.customSchedule || !sameStructure) return { ...personal, assignments: keptAssignments, customSchedule: next, cycleDayOverrides: [] };
  const cycleDayOverrides = next.cycleDays.filter(day => JSON.stringify(day.slots) !== JSON.stringify(basis.cycleDays.find(entry => entry.id === day.id)?.slots)).map(day => ({ cycleDayId: day.id, slots: day.slots }));
  // The editor only sees the school's current days. Overrides for a day the school removed stay saved until the
  // student removes them, as the conflict notice promises, so they come back if the school restores that day.
  const orphaned = personal.cycleDayOverrides.filter(override => !basis.cycleDays.some(day => day.id === override.cycleDayId));
  return { ...personal, assignments: keptAssignments, cycleDayOverrides: [...cycleDayOverrides, ...orphaned] };
}

/**
 * Whether saving `next` would switch a student who follows the school timetable to a private copy of it, which
 * school corrections no longer reach: renaming, adding or removing a day, or placing a block for a period the
 * school does not have (such as the `class-<id>` period ClassAssignmentGrid makes for an unplaced class).
 * An edit that cannot be saved at all is not a switch; saving it reports its own error.
 */
export function makesPrivateCopy(basis: Schedule, personal: PersonalSchedule, next: Schedule, assignments: PersonalSchedule['assignments']): boolean {
  if (personal.customSchedule) return false;
  try { return saveTimetableEdit(basis, personal, next, assignments).customSchedule != null; } catch { return false; }
}

type CycleDay = Schedule['cycleDays'][number];
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Replays one edit to a day onto the newest copy of it. The label and each slot (by slot ID) change only where the
 * edit changed them, so an earlier edit to another slot or to the name survives. If the merged slots would overlap,
 * the edited day's slots win, as they did before a same-day merge was possible.
 */
function rebaseDay(before: CycleDay | undefined, after: CycleDay, latest: CycleDay): CycleDay {
  if (!before) return after;
  const label = after.label !== before.label ? after.label : latest.label;
  const beforeSlots = new Map(before.slots.map((slot) => [slot.id, slot]));
  const afterSlots = new Map(after.slots.map((slot) => [slot.id, slot]));
  const slots = latest.slots
    .filter((slot) => !(beforeSlots.has(slot.id) && !afterSlots.has(slot.id)))
    .map((slot) => { const edited = afterSlots.get(slot.id); return edited && !same(edited, beforeSlots.get(slot.id)) ? edited : slot; });
  for (const slot of after.slots) if (!beforeSlots.has(slot.id) && !slots.some((entry) => entry.id === slot.id)) slots.push(slot);
  slots.sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end));
  const merged = { ...latest, label, slots };
  return cycleDaySchema.safeParse(merged).success ? merged : { ...latest, label, slots: after.slots };
}

/**
 * Replays an edit that turned `before` into `after` onto `latest`, the newest timetable, touching only what the edit
 * changed. The timetable grid builds edits from the render it showed, which may predate a save still running, so
 * replaying keeps that save's changes: other fields, days, and on a changed day its other slots and its name.
 * An edit that would leave no rotation day changes nothing.
 */
export function rebaseTimetableEdit(before: Schedule, after: Schedule): (latest: Schedule) => Schedule {
  return (latest) => {
    const merged = { ...latest } as Record<string, unknown>;
    for (const key of Object.keys(after) as (keyof Schedule)[]) {
      if (key !== 'cycleDays' && !same(after[key], before[key])) merged[key] = after[key];
    }
    const beforeDays = new Map(before.cycleDays.map((day) => [day.id, day]));
    const afterDays = new Map(after.cycleDays.map((day) => [day.id, day]));
    const days = latest.cycleDays
      .filter((day) => !(beforeDays.has(day.id) && !afterDays.has(day.id)))
      .map((day) => { const edited = afterDays.get(day.id); return edited && !same(edited, beforeDays.get(day.id)) ? rebaseDay(beforeDays.get(day.id), edited, day) : day; });
    for (const day of after.cycleDays) if (!beforeDays.has(day.id) && !days.some((entry) => entry.id === day.id)) days.push(day);
    // A timetable needs a rotation day. Two removals built from one render (Day 1, then Day 2 of a two-day rotation)
    // would leave none once the first is saved, so the later one is skipped instead of failing to save.
    if (!days.length) return latest;
    return { ...(merged as Schedule), cycleDays: days };
  };
}

/** Edits made while a save is running, saved together next. */
export type QueuedTimetableEdit = { change?: (latest: Schedule) => Schedule; assign?: PersonalSchedule['assignments'] };

/** Adds `edit` behind the edits already queued: its timetable change applies after theirs, and its assignments win. */
export function queueTimetableEdit(queued: QueuedTimetableEdit | null, edit: QueuedTimetableEdit): QueuedTimetableEdit {
  const earlier = queued?.change;
  const later = edit.change;
  const change = later && earlier ? (latest: Schedule) => later(earlier(latest)) : later ?? earlier;
  return { change, assign: { ...queued?.assign, ...edit.assign } };
}

/**
 * Removes a class, its period assignments and the private blocks made for it. ClassAssignmentGrid gives an
 * unplaced class its own period (`class-<id>`, labelled with the class name); once placed, that period lives only
 * in the private timetable, so leaving it behind would keep showing the removed class's name. School periods,
 * and private periods the student made some other way, stay; only their assignment to this class is cleared.
 */
export function removeClass(school: Schedule, personal: PersonalSchedule, classId: string): PersonalSchedule {
  const schoolPeriods = new Set(scheduleForGrade(school, personal.grade).periods.map(period => period.id));
  const base = slugId(`class-${classId}`, []);
  const dropped = new Set((personal.customSchedule?.periods ?? [])
    .filter(period => !schoolPeriods.has(period.id) && personal.assignments[period.id] === classId && (period.id === base || period.id.startsWith(`${base}-`)))
    .map(period => period.id));
  const keep = (slots: ScheduleSlot[]) => slots.filter(slot => !dropped.has(slot.periodId));
  const custom = personal.customSchedule;
  return {
    ...personal,
    classes: personal.classes.filter(cls => cls.id !== classId),
    assignments: Object.fromEntries(Object.entries(personal.assignments).filter(([, id]) => id !== classId)),
    cycleDayOverrides: personal.cycleDayOverrides.map(entry => ({ ...entry, slots: keep(entry.slots) })),
    dateOverrides: personal.dateOverrides.map(entry => entry.slots ? { ...entry, slots: keep(entry.slots) } : entry),
    ...(custom && dropped.size > 0 ? { customSchedule: {
      ...custom,
      periods: custom.periods.filter(period => !dropped.has(period.id)),
      cycleDays: custom.cycleDays.map(day => ({ ...day, slots: keep(day.slots) })),
      exceptions: custom.exceptions.map(entry => 'slots' in entry && entry.slots ? { ...entry, slots: keep(entry.slots) } : entry),
    } } : {}),
  };
}
