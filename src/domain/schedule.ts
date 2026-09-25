import { Temporal } from "@js-temporal/polyfill";
import { z } from "zod";
import { scheduledPeriodIds } from "./period-status";

const idSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/, "Use a stable ID with letters, numbers, underscores, or hyphens");
const labelSchema = z.string().trim().min(1).max(120);

export const dateSchema = z.string().regex(/^(19|20|21)\d{2}-\d{2}-\d{2}$/).refine((value) => {
  try { Temporal.PlainDate.from(value, { overflow: "reject" }); return true; } catch { return false; }
}, "Use a real date between 1900 and 2199 in YYYY-MM-DD format");

/** The range dateSchema accepts. Date navigation clamps to it so resolveDay never sees a date it rejects. */
export const FIRST_DATE = "1900-01-01";
export const LAST_DATE = "2199-12-31";

/** Clamps a YYYY-MM-DD date into FIRST_DATE..LAST_DATE (ISO strings with four-digit years compare in date order). */
export function clampDate(value: string): string {
  return value < FIRST_DATE ? FIRST_DATE : value > LAST_DATE ? LAST_DATE : value;
}

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

/** A rotation day's slots for this student: their cycle-day override when they saved one, else the day's own. */
export function cycleDaySlots(day: Schedule["cycleDays"][number], personal: Pick<PersonalSchedule, "cycleDayOverrides">): ScheduleSlot[] {
  return personal.cycleDayOverrides.find((entry) => entry.cycleDayId === day.id)?.slots ?? day.slots;
}

/** Labels of the rotation days on which `periodId` meets for this student, cycle-day overrides included. */
export function cycleDaysWithPeriod(schedule: Schedule, personal: Pick<PersonalSchedule, "cycleDayOverrides">, periodId: string): string[] {
  return schedule.cycleDays.filter((day) => cycleDaySlots(day, personal).some((slot) => slot.periodId === periodId)).map((day) => day.label);
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

/**
 * Adds a rotation day at the end. A one-day schedule has no reason to advance, so its advance days are often
 * empty, and a rotation with no advance days never leaves its anchor day. Growing past one day therefore
 * starts advancing on school days, so the new day actually comes up.
 */
export function withCycleDay(schedule: Schedule, day: Schedule["cycleDays"][number]): Schedule {
  const grows = schedule.cycleDays.length <= 1 && schedule.advanceWeekdays.length === 0;
  return {
    ...schedule,
    cycleDays: [...schedule.cycleDays, day],
    ...(schedule.cycleDays.length === 0 ? { anchorCycleDayId: day.id } : {}),
    ...(grows ? { advanceWeekdays: [...schedule.schoolWeekdays] } : {}),
  };
}

/** A rotation of several days with no advance days: only the anchor day (or a reset exception's day) ever comes up. */
export function rotationNeverAdvances(schedule: Schedule): boolean {
  return schedule.cycleDays.length > 1 && schedule.advanceWeekdays.length === 0;
}

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

/**
 * One sentence per issue reason. Only shifted and daylight-saving-gap periods are left out of the day; a slot whose
 * period the school removed is still shown (as REMOVED_PERIOD_LABEL). `preview` words it for an unsaved adjustment.
 */
export function describeDayIssues(issues: ScheduleIssue[], preview = false): string[] {
  const count = (reason: ScheduleIssue["reason"]) => issues.filter((issue) => issue.reason === reason).length;
  const periods = (n: number) => (n === 1 ? "1 period" : `${n} periods`);
  const be = (n: number) => (preview ? "would be" : n === 1 ? "is" : "are");
  const shifted = count("shift-outside-day");
  const skipped = count("nonexistent-time");
  const removed = count("missing-period");
  const lines: string[] = [];
  if (shifted) lines.push(`${periods(shifted)} ${be(shifted)} left out because the time shift moves ${shifted === 1 ? "it" : "them"} outside the day.`);
  if (skipped) lines.push(`${periods(skipped)} ${be(skipped)} skipped because ${skipped === 1 ? "its time does" : "their times do"} not exist on this date (daylight-saving change).`);
  if (removed) lines.push(`${periods(removed)} ${preview ? "would use" : removed === 1 ? "uses" : "use"} a period the school removed.`);
  return lines;
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

type Exception = Schedule["exceptions"][number];
type ResetException = Extract<Exception, { kind: "reset" }>;

/**
 * Exceptions sorted by date with prefix sums of how far each one moves the rotation compared with a normal
 * day, so a resolveDay call costs a few binary searches instead of a Temporal date per exception. Views
 * resolve hundreds of days per render (nextClass looks a year ahead) and a schedule may hold 5000 exceptions.
 * Cached per exceptions array; schedules are replaced rather than mutated, and a new advanceWeekdays array
 * (which changes the deltas) rebuilds the index.
 */
interface ExceptionIndex {
  advanceWeekdays: readonly number[];
  size: number;
  sorted: Exception[];
  dates: string[];
  /** deltas[i] = sum of the advance deltas of sorted[0..i). */
  deltas: number[];
  resets: ResetException[];
  resetDates: string[];
}
const exceptionIndexes = new WeakMap<Schedule["exceptions"], ExceptionIndex>();

function exceptionIndex(schedule: Schedule): ExceptionIndex {
  const cached = exceptionIndexes.get(schedule.exceptions);
  if (cached && cached.advanceWeekdays === schedule.advanceWeekdays && cached.size === schedule.exceptions.length) return cached;
  // A stable sort keeps same-date entries in their saved order, matching the order a linear scan would see.
  const sorted = [...schedule.exceptions].sort((left, right) => left.date.localeCompare(right.date));
  const deltas = [0];
  for (const exception of sorted) {
    const normallyAdvances = schedule.advanceWeekdays.includes(Temporal.PlainDate.from(exception.date).dayOfWeek);
    deltas.push(deltas[deltas.length - 1] + Number(exception.advanceCycle) - Number(normallyAdvances));
  }
  const resets = sorted.filter((entry): entry is ResetException => entry.kind === "reset");
  const index: ExceptionIndex = {
    advanceWeekdays: schedule.advanceWeekdays, size: schedule.exceptions.length, sorted, dates: sorted.map((entry) => entry.date), deltas,
    resets, resetDates: resets.map((entry) => entry.date),
  };
  exceptionIndexes.set(schedule.exceptions, index);
  return index;
}

/** First index whose value is >= target (or > target when `after`). */
function searchDates(dates: string[], target: string, after = false): number {
  let low = 0;
  let high = dates.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (dates[middle] < target || (after && dates[middle] === target)) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** Count advances in [start, end), using whole weeks instead of iterating every date. */
function advancesBetween(schedule: Schedule, index: ExceptionIndex, start: Temporal.PlainDate, end: Temporal.PlainDate): number {
  const days = start.until(end).days;
  let count = Math.floor(days / 7) * schedule.advanceWeekdays.length;
  for (let offset = 0; offset < days % 7; offset += 1) {
    if (schedule.advanceWeekdays.includes(modulo(start.dayOfWeek - 1 + offset, 7) + 1)) count += 1;
  }
  return count + index.deltas[searchDates(index.dates, end.toString())] - index.deltas[searchDates(index.dates, start.toString())];
}

function cycleDayForDate(schedule: Schedule, index: ExceptionIndex, date: Temporal.PlainDate) {
  const dateString = date.toString();
  // An anchor is a reset too. The most recent reset determines the phase; on the anchor's own date a reset wins.
  // Before every boundary, the earliest one is used (the anchor when it shares that date).
  const anchor = { date: schedule.anchorDate, cycleDayId: schedule.anchorCycleDayId };
  const reset = index.resets[searchDates(index.resetDates, dateString, true) - 1];
  const earliest = index.resets[0] && index.resets[0].date < anchor.date ? index.resets[0] : anchor;
  const boundary = anchor.date <= dateString
    ? (reset && reset.date >= anchor.date ? reset : anchor)
    : reset ?? earliest;
  const origin = Temporal.PlainDate.from(boundary.date);
  const distance = dateString >= boundary.date
    ? advancesBetween(schedule, index, origin, date)
    : -advancesBetween(schedule, index, date, origin);
  const startIndex = schedule.cycleDays.findIndex((entry) => entry.id === boundary.cycleDayId);
  return schedule.cycleDays[modulo(startIndex + distance, schedule.cycleDays.length)];
}

/** Shown for a slot whose period is gone (a personal override kept after the school removed it); never the raw id. */
export const REMOVED_PERIOD_LABEL = "Removed period";

/**
 * Precedence: school rotation -> school exception -> personal cycle override -> personal date override.
 * Personal edits never change shared rotation advancement. A custom schedule replaces the school schedule.
 * DST uses the earlier offset for repeated times. Nonexistent local times during a DST gap
 * are reported in issues and skipped, leaving the saved edit intact for the student to adjust.
 */
/** resolveDay for dates that may fall outside FIRST_DATE..LAST_DATE (a week or preview strip at the edge): null there. */
export function resolveDayInRange(schoolSchedule: Schedule, dateString: string, personal: PersonalSchedule = emptyPersonalSchedule()): ResolvedDay | null {
  return dateSchema.safeParse(dateString).success ? resolveDay(schoolSchedule, dateString, personal) : null;
}

export function resolveDay(schoolSchedule: Schedule, dateString: string, personal: PersonalSchedule = emptyPersonalSchedule()): ResolvedDay {
  const schedule = effectiveSchedule(schoolSchedule, personal);
  const date = Temporal.PlainDate.from(dateSchema.parse(dateString));
  const index = exceptionIndex(schedule);
  const cycleDay = cycleDayForDate(schedule, index, date);
  const found = searchDates(index.dates, dateString);
  const exception = index.dates[found] === dateString ? index.sorted[found] : undefined;
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
      label: period?.label ?? assignedClass?.name ?? REMOVED_PERIOD_LABEL,
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
      add("period-unscheduled", periodId, `${cls ? `“${cls.name}” (${newPeriod.label})` : `“${newPeriod.label}”`} has no times set. The period still exists, but is not on any day. Your assignment and personal adjustments are still saved.`);
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
