import { Temporal } from "@js-temporal/polyfill";
import { z } from "zod";
import { scheduledPeriodIds } from "./period-status";

const idSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/, "Use a stable ID with letters, numbers, underscores, or hyphens");
const labelSchema = z.string().trim().min(1).max(120);

export const dateSchema = z.string().regex(/^(19|20|21)\d{2}-\d{2}-\d{2}$/).refine((value) => {
  try { Temporal.PlainDate.from(value, { overflow: "reject" }); return true; } catch { return false; }
}, "Use a real date between 1900 and 2199 in YYYY-MM-DD format");

export const timeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use a time in HH:mm format");

export const periodSchema = z.strictObject({
  id: idSchema,
  label: labelSchema,
  kind: z.enum(["class", "lunch", "other"]),
});

export const slotSchema = z.strictObject({
  id: idSchema,
  periodId: idSchema,
  start: timeSchema,
  end: timeSchema,
}).refine((slot) => slot.start < slot.end, { message: "A period must end after it starts on the same day", path: ["end"] });

const slotsSchema = z.array(slotSchema).max(100).superRefine((slots, context) => {
  const ids = new Set<string>();
  slots.forEach((slot, index) => {
    if (ids.has(slot.id)) context.addIssue({ code: "custom", message: "Slot IDs must be unique within a day", path: [index, "id"] });
    ids.add(slot.id);
    if (index > 0 && slots[index - 1].end > slot.start) context.addIssue({ code: "custom", message: "Slots must be in time order without overlaps", path: [index, "start"] });
  });
});

export const cycleDaySchema = z.strictObject({ id: idSchema, label: labelSchema, slots: slotsSchema });

export const exceptionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ date: dateSchema, kind: z.literal("closure"), advanceCycle: z.boolean() }),
  z.strictObject({ date: dateSchema, kind: z.literal("replacement"), slots: slotsSchema, advanceCycle: z.boolean() }),
  z.strictObject({ date: dateSchema, kind: z.literal("reset"), cycleDayId: idSchema, advanceCycle: z.boolean(), slots: slotsSchema.optional(), closed: z.boolean().optional() }),
]);

const weekdaysSchema = z.array(z.number().int().min(1).max(7)).max(7).refine((values) => new Set(values).size === values.length, "Weekdays must be unique; Monday is 1 and Sunday is 7");

/** The anchor names the cycle day ON that date. Advancement occurs AFTER each date. */
const baseScheduleSchema = z.strictObject({
  version: z.literal(1),
  timeZone: z.string().min(1).max(100).refine((value) => {
    try { new Intl.DateTimeFormat("en-US", { timeZone: value }); return true; } catch { return false; }
  }, "Use an IANA time zone, such as America/New_York"),
  periods: z.array(periodSchema).min(1).max(300),
  cycleDays: z.array(cycleDaySchema).min(1).max(366),
  anchorDate: dateSchema,
  anchorCycleDayId: idSchema,
  schoolWeekdays: weekdaysSchema.refine((values) => values.length > 0, "Choose at least one school weekday"),
  advanceWeekdays: weekdaysSchema,
  exceptions: z.array(exceptionSchema).max(5000),
}).superRefine((schedule, context) => {
  const periodIds = new Set(schedule.periods.map((period) => period.id));
  const cycleDayIds = new Set(schedule.cycleDays.map((day) => day.id));
  if (periodIds.size !== schedule.periods.length) context.addIssue({ code: "custom", message: "Period IDs must be unique", path: ["periods"] });
  if (cycleDayIds.size !== schedule.cycleDays.length) context.addIssue({ code: "custom", message: "Cycle day IDs must be unique", path: ["cycleDays"] });
  if (!cycleDayIds.has(schedule.anchorCycleDayId)) context.addIssue({ code: "custom", message: "The anchor must refer to an existing cycle day", path: ["anchorCycleDayId"] });
  const checkSlots = (slots: z.infer<typeof slotsSchema>, path: (string | number)[]) => slots.forEach((slot, index) => {
    if (!periodIds.has(slot.periodId)) context.addIssue({ code: "custom", message: "This period does not exist", path: [...path, index, "periodId"] });
  });
  schedule.cycleDays.forEach((day, index) => checkSlots(day.slots, ["cycleDays", index, "slots"]));
  const dates = new Set<string>();
  schedule.exceptions.forEach((exception, index) => {
    if (dates.has(exception.date)) context.addIssue({ code: "custom", message: "Only one school exception is allowed per date", path: ["exceptions", index, "date"] });
    dates.add(exception.date);
    if (exception.kind === "replacement" || (exception.kind === "reset" && exception.slots)) checkSlots(exception.slots!, ["exceptions", index, "slots"]);
    if (exception.kind === "reset") {
      if (!cycleDayIds.has(exception.cycleDayId)) context.addIssue({ code: "custom", message: "The reset must refer to an existing cycle day", path: ["exceptions", index, "cycleDayId"] });
      if (exception.closed === true && exception.slots !== undefined) context.addIssue({ code: "custom", message: "A closed reset date cannot also contain slots", path: ["exceptions", index, "slots"] });
    }
  });
});

export const GRADES = ['9', '10', '11', '12'] as const;
export const gradeSchema = z.enum(GRADES);
export type Grade = z.infer<typeof gradeSchema>;
export const gradesSchema = z.array(gradeSchema).min(1, 'Choose at least one grade').max(GRADES.length)
  .refine((grades) => new Set(grades).size === grades.length, 'Grades must be unique');
export const gradeLabel = (grade: Grade) => `Grade ${grade}`;
export const scheduleSchema = baseScheduleSchema.safeExtend({
  gradeSchedules: z.partialRecord(gradeSchema, baseScheduleSchema).optional(),
});

/** Grades without a separate schedule keep using the school's default. */
export function scheduleForGrade(schedule: Schedule, grade?: Grade): Schedule {
  return (grade && schedule.gradeSchedules?.[grade]) || schedule;
}

export function effectiveSchedule(schedule: Schedule, personal: PersonalSchedule): Schedule {
  return personal.customSchedule ?? scheduleForGrade(schedule, personal.grade);
}

export function applyScheduleToGrades(current: Schedule, draft: Schedule, grades: Grade[]): Schedule {
  gradesSchema.parse(grades);
  const { gradeSchedules: _variants, ...base } = draft;
  if (grades.length === GRADES.length) return scheduleSchema.parse(base);
  return scheduleSchema.parse({ ...current, gradeSchedules: {
    ...current.gradeSchedules, ...Object.fromEntries(grades.map((grade) => [grade, base])),
  } });
}

export const classSchema = z.strictObject({
  id: idSchema,
  name: labelSchema,
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, "Choose a valid hex color").optional(),
  room: z.string().trim().max(120).optional(),
  teacher: z.string().trim().max(120).optional(),
  directoryId: z.string().uuid().optional(),
});

export const personalScheduleSchema = z.strictObject({
  grade: gradeSchema.optional(),
  classes: z.array(classSchema).max(300),
  assignments: z.record(idSchema, idSchema),
  cycleDayOverrides: z.array(z.strictObject({ cycleDayId: idSchema, slots: slotsSchema })).max(366),
  dateOverrides: z.array(z.strictObject({
    date: dateSchema,
    closed: z.boolean().optional(),
    slots: slotsSchema.optional(),
    shiftMinutes: z.number().int().min(-720).max(720).optional(),
  }).refine((value) => !(value.closed === true && value.slots !== undefined), "A closed date cannot also contain slots")).max(5000),
  customSchedule: scheduleSchema.nullable().optional(),
}).superRefine((personal, context) => {
  const classIds = new Set(personal.classes.map((entry) => entry.id));
  if (classIds.size !== personal.classes.length) context.addIssue({ code: "custom", message: "Class IDs must be unique", path: ["classes"] });
  for (const [periodId, classId] of Object.entries(personal.assignments)) {
    if (!classIds.has(classId)) context.addIssue({ code: "custom", message: "The assigned class does not exist", path: ["assignments", periodId] });
  }
  if (new Set(personal.cycleDayOverrides.map((entry) => entry.cycleDayId)).size !== personal.cycleDayOverrides.length) context.addIssue({ code: "custom", message: "Only one override is allowed per cycle day", path: ["cycleDayOverrides"] });
  if (new Set(personal.dateOverrides.map((entry) => entry.date)).size !== personal.dateOverrides.length) context.addIssue({ code: "custom", message: "Only one personal override is allowed per date", path: ["dateOverrides"] });
});

export type Schedule = z.infer<typeof scheduleSchema>;
export type PersonalSchedule = z.infer<typeof personalScheduleSchema>;
export type SchoolPeriod = z.infer<typeof periodSchema>;
export type ScheduleSlot = z.infer<typeof slotSchema>;
export type StudentClass = z.infer<typeof classSchema>;

export function emptyPersonalSchedule(): PersonalSchedule {
  return { classes: [], assignments: {}, cycleDayOverrides: [], dateOverrides: [], customSchedule: null };
}

export interface ResolvedPeriod {
  slotId: string;
  periodId: string;
  label: string;
  kind: SchoolPeriod["kind"];
  start: string;
  end: string;
  startAt: string;
  endAt: string;
  class?: StudentClass;
}

export interface ScheduleIssue {
  slotId: string;
  reason: "missing-period" | "shift-outside-day" | "nonexistent-time";
}

export interface ResolvedDay {
  date: string;
  cycleDayId: string;
  cycleDayLabel: string;
  closed: boolean;
  periods: ResolvedPeriod[];
  issues: ScheduleIssue[];
}

const modulo = (value: number, base: number) => ((value % base) + base) % base;
const toMinutes = (value: string) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
const toTime = (value: number) => `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;

/** Count advances in [start, end), using whole weeks instead of iterating every date. */
function advancesBetween(schedule: Schedule, start: Temporal.PlainDate, end: Temporal.PlainDate): number {
  const days = start.until(end).days;
  let count = Math.floor(days / 7) * schedule.advanceWeekdays.length;
  for (let offset = 0; offset < days % 7; offset += 1) {
    if (schedule.advanceWeekdays.includes(modulo(start.dayOfWeek - 1 + offset, 7) + 1)) count += 1;
  }
  const first = start.toString();
  const last = end.toString();
  for (const exception of schedule.exceptions) {
    if (exception.date < first || exception.date >= last) continue;
    const normallyAdvances = schedule.advanceWeekdays.includes(Temporal.PlainDate.from(exception.date).dayOfWeek);
    count += Number(exception.advanceCycle) - Number(normallyAdvances);
  }
  return count;
}

function cycleDayForDate(schedule: Schedule, date: Temporal.PlainDate) {
  const dateString = date.toString();
  // An anchor is a reset too. The most recent reset determines the phase.
  const boundaries = [
    { date: schedule.anchorDate, cycleDayId: schedule.anchorCycleDayId },
    ...schedule.exceptions.filter((entry) => entry.kind === "reset"),
  ].sort((left, right) => left.date.localeCompare(right.date));
  const boundary = boundaries.findLast((entry) => entry.date <= dateString) ?? boundaries[0];
  const origin = Temporal.PlainDate.from(boundary.date);
  const distance = dateString >= boundary.date
    ? advancesBetween(schedule, origin, date)
    : -advancesBetween(schedule, date, origin);
  const startIndex = schedule.cycleDays.findIndex((entry) => entry.id === boundary.cycleDayId);
  return schedule.cycleDays[modulo(startIndex + distance, schedule.cycleDays.length)];
}

/**
 * Precedence: school rotation -> school exception -> personal cycle override -> personal date override.
 * Personal edits never change shared rotation advancement. A custom schedule replaces the school schedule.
 * DST uses the earlier offset for repeated times. Nonexistent local times during a DST gap
 * are reported in issues and skipped, leaving the saved edit intact for the student to adjust.
 */
export function resolveDay(schoolSchedule: Schedule, dateString: string, personal: PersonalSchedule = emptyPersonalSchedule()): ResolvedDay {
  const schedule = effectiveSchedule(schoolSchedule, personal);
  const date = Temporal.PlainDate.from(dateSchema.parse(dateString));
  const cycleDay = cycleDayForDate(schedule, date);
  const exception = schedule.exceptions.find((entry) => entry.date === dateString);
  const cycleOverride = personal.cycleDayOverrides.find((entry) => entry.cycleDayId === cycleDay.id);
  const dateOverride = personal.dateOverrides.find((entry) => entry.date === dateString);
  let closed = !schedule.schoolWeekdays.includes(date.dayOfWeek);
  let slots = cycleDay.slots;
  if (exception?.kind === "closure") closed = true;
  if (exception?.kind === "replacement") { closed = false; slots = exception.slots; }
  if (exception?.kind === "reset") {
    if (exception.slots !== undefined) { closed = false; slots = exception.slots; }
    if (exception.closed !== undefined) closed = exception.closed;
  }
  if (cycleOverride) slots = cycleOverride.slots;
  if (dateOverride?.slots !== undefined) { closed = false; slots = dateOverride.slots; }
  if (dateOverride?.closed !== undefined) closed = dateOverride.closed;
  const result: ResolvedDay = { date: dateString, cycleDayId: cycleDay.id, cycleDayLabel: cycleDay.label, closed, periods: [], issues: [] };
  if (closed) return result;

  for (const slot of slots) {
    const startMinutes = toMinutes(slot.start) + (dateOverride?.shiftMinutes ?? 0);
    const endMinutes = toMinutes(slot.end) + (dateOverride?.shiftMinutes ?? 0);
    if (startMinutes < 0 || endMinutes >= 1440) {
      result.issues.push({ slotId: slot.id, reason: "shift-outside-day" });
      continue;
    }
    const start = toTime(startMinutes);
    const end = toTime(endMinutes);
    const localStart = date.toPlainDateTime(start);
    const localEnd = date.toPlainDateTime(end);
    const zonedStart = localStart.toZonedDateTime(schedule.timeZone, { disambiguation: "compatible" });
    const zonedEnd = localEnd.toZonedDateTime(schedule.timeZone, { disambiguation: "compatible" });
    const startAt = zonedStart.toInstant();
    const endAt = zonedEnd.toInstant();
    if (!zonedStart.toPlainDateTime().equals(localStart) || !zonedEnd.toPlainDateTime().equals(localEnd) || Temporal.Instant.compare(startAt, endAt) >= 0) {
      result.issues.push({ slotId: slot.id, reason: "nonexistent-time" });
      continue;
    }
    const period = schedule.periods.find((entry) => entry.id === slot.periodId);
    if (!period) result.issues.push({ slotId: slot.id, reason: "missing-period" });
    const assignedClass = personal.classes.find((entry) => entry.id === personal.assignments[slot.periodId]);
    result.periods.push({
      slotId: slot.id,
      periodId: slot.periodId,
      label: period?.label ?? slot.periodId,
      kind: period?.kind ?? "other",
      start,
      end,
      startAt: startAt.toString(),
      endAt: endAt.toString(),
      ...(assignedClass ? { class: assignedClass } : {}),
    });
  }
  result.periods.sort((left, right) => left.startAt.localeCompare(right.startAt));
  return result;
}

export interface NextClass extends ResolvedPeriod {
  date: string;
  cycleDayId: string;
  cycleDayLabel: string;
  status: "current" | "upcoming";
}

/** Includes lunch and unassigned periods; returns the current period first, otherwise the next one. */
export function nextClass(schedule: Schedule, now: Date | string, personal: PersonalSchedule = emptyPersonalSchedule(), lookAheadDays = 370): NextClass | null {
  if (!Number.isInteger(lookAheadDays) || lookAheadDays < 1 || lookAheadDays > 3660) throw new RangeError("lookAheadDays must be an integer between 1 and 3660");
  const instant = Temporal.Instant.from(now instanceof Date ? now.toISOString() : now);
  const firstDate = instant.toZonedDateTimeISO(effectiveSchedule(schedule, personal).timeZone).toPlainDate();
  for (let offset = 0; offset < lookAheadDays; offset += 1) {
    const day = resolveDay(schedule, firstDate.add({ days: offset }).toString(), personal);
    const period = day.periods.find((entry) => Temporal.Instant.compare(entry.endAt, instant) > 0);
    if (period) return { ...period, date: day.date, cycleDayId: day.cycleDayId, cycleDayLabel: day.cycleDayLabel, status: Temporal.Instant.compare(period.startAt, instant) <= 0 ? "current" : "upcoming" };
  }
  return null;
}

export interface OverrideConflict {
  id: string;
  kind: "period-unscheduled" | "period-removed" | "period-changed" | "cycle-day-removed" | "shared-day-changed" | "shared-date-changed" | "invalid-shift";
  target: string;
  message: string;
}

const equal = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

/** Read-only: call before accepting a new school revision; retain personal data until the student decides. */
export function detectOverrideConflicts(previous: Schedule, current: Schedule, personal: PersonalSchedule): OverrideConflict[] {
  if (personal.customSchedule) return [];
  const schoolPeriods = new Map(current.periods.map(period => [period.id, period]));
  const periodLabels = new Map([...current.periods, ...previous.periods].map(period => [period.id, period.label]));
  previous = scheduleForGrade(previous, personal.grade);
  current = scheduleForGrade(current, personal.grade);
  const conflicts: OverrideConflict[] = [];
  const add = (kind: OverrideConflict["kind"], target: string, message: string) => {
    const id = `${kind}:${target}`;
    if (!conflicts.some((entry) => entry.id === id)) conflicts.push({ id, kind, target, message });
  };
  const previouslyScheduled = scheduledPeriodIds(previous);
  const currentlyScheduled = scheduledPeriodIds(current);
  const referencedPeriods = new Set([
    ...Object.keys(personal.assignments),
    ...personal.cycleDayOverrides.flatMap((entry) => entry.slots.map((slot) => slot.periodId)),
    ...personal.dateOverrides.flatMap((entry) => (entry.slots ?? []).map((slot) => slot.periodId)),
  ]);
  for (const periodId of referencedPeriods) {
    const oldPeriod = previous.periods.find((entry) => entry.id === periodId);
    const newPeriod = current.periods.find((entry) => entry.id === periodId) ?? schoolPeriods.get(periodId);
    if (!newPeriod) {
      const label = oldPeriod?.label ?? periodLabels.get(periodId);
      const cls = personal.classes.find(entry => entry.id === personal.assignments[periodId]);
      const subject = cls ? `Your class “${cls.name}” was assigned to ${label ? `“${label}”` : 'a period that is no longer listed'}` : label ? `The period “${label}”` : 'A period used by your personal adjustments';
      add("period-removed", periodId, `${subject}${cls && label ? ', which is no longer listed in your school schedule' : cls ? '' : ' is no longer listed in your school schedule'}. Review it in your classes. Your class and personal adjustments are still saved.`);
    }
    else if (!currentlyScheduled.has(periodId) && (previouslyScheduled.has(periodId) || !current.periods.some(period => period.id === periodId))) {
      const cls = personal.classes.find(entry => entry.id === personal.assignments[periodId]);
      add("period-unscheduled", periodId, `${cls ? `“${cls.name}” (${newPeriod.label})` : `“${newPeriod.label}”`} is Unscheduled. The period still exists, but has no scheduled times. Your assignment and personal adjustments are still saved.`);
    }
    else if (oldPeriod && !equal(oldPeriod, newPeriod)) add("period-changed", periodId, `The school changed period ${newPeriod.label}. Review your saved class assignment or override.`);
  }
  for (const override of personal.cycleDayOverrides) {
    const oldDay = previous.cycleDays.find((entry) => entry.id === override.cycleDayId);
    const newDay = current.cycleDays.find((entry) => entry.id === override.cycleDayId);
    if (!newDay) add("cycle-day-removed", override.cycleDayId, "This cycle day no longer exists at school. Your personal version is saved.");
    else if (!equal(oldDay?.slots, newDay.slots)) add("shared-day-changed", override.cycleDayId, "School period times or order changed beneath your personal override. Your version is still applied.");
  }
  for (const override of personal.dateOverrides) {
    const oldDay = resolveDay(previous, override.date);
    const newDay = resolveDay(current, override.date);
    if (!equal(oldDay, newDay)) add("shared-date-changed", override.date, "The school changed this date beneath your personal override. Your version is still applied.");
    if (resolveDay(current, override.date, personal).issues.some((issue) => issue.reason === "shift-outside-day")) add("invalid-shift", override.date, "Your saved time shift now moves a period outside this date. Adjust the shift to restore that period.");
  }
  if (personal.cycleDayOverrides.length > 0 && (previous.timeZone !== current.timeZone || !equal(previous.schoolWeekdays, current.schoolWeekdays) || !equal(previous.advanceWeekdays, current.advanceWeekdays) || previous.anchorDate !== current.anchorDate || previous.anchorCycleDayId !== current.anchorCycleDayId || !equal(previous.exceptions, current.exceptions) || !equal(previous.cycleDays.map((entry) => entry.id), current.cycleDays.map((entry) => entry.id)))) {
    for (const override of personal.cycleDayOverrides) add("shared-day-changed", override.cycleDayId, "School rotation rules or exceptions changed. Review which dates use your saved cycle-day override.");
  }
  return conflicts;
}
