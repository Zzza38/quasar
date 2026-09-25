import { Temporal } from "@js-temporal/polyfill";
import { describe, expect, it, vi } from "vitest";
import { examplePersonalSchedule, exampleSchedule } from "./example";
import {
  clampDate,
  cycleDaysWithPeriod,
  describeDayIssues,
  detectOverrideConflicts,
  emptyPersonalSchedule,
  nextClass,
  personalScheduleSchema,
  REMOVED_PERIOD_LABEL,
  resolveDay,
  resolveDayInRange,
  rotationNeverAdvances,
  scheduleSchema,
  withCycleDay,
  type Schedule,
} from "./schedule";

function schedule(changes: Partial<Schedule> = {}): Schedule {
  return scheduleSchema.parse({ ...structuredClone(exampleSchedule), ...changes });
}

describe("schedule validation", () => {
  it("round trips class assignments, split classes, and distinct lunch waves through JSON", () => {
    const school = schedule({
      periods: [
        { id: "A", label: "A", kind: "class" },
        { id: "lunch-1", label: "First lunch", kind: "lunch" },
        { id: "lunch-2", label: "Second lunch", kind: "lunch" },
      ],
      cycleDays: [{ id: "day-1", label: "Every day", slots: [
        { id: "before-lunch", periodId: "A", start: "10:00", end: "10:30" },
        { id: "lunch-slot-1", periodId: "lunch-1", start: "10:30", end: "11:00" },
        { id: "after-lunch", periodId: "A", start: "11:00", end: "11:30" },
        { id: "lunch-slot-2", periodId: "lunch-2", start: "11:30", end: "12:00" },
      ] }],
    });
    const personal = personalScheduleSchema.parse({
      ...emptyPersonalSchedule(),
      classes: [{ id: "science", name: "Science", room: "2", teacher: "Ms Smith" }],
      assignments: { A: "science" },
    });
    const restoredSchool = scheduleSchema.parse(JSON.parse(JSON.stringify(school)));
    const restoredPersonal = personalScheduleSchema.parse(JSON.parse(JSON.stringify(personal)));
    const day = resolveDay(restoredSchool, "2026-09-08", restoredPersonal);
    expect(day.periods.map((entry) => entry.kind)).toEqual(["class", "lunch", "class", "lunch"]);
    expect(day.periods.filter((entry) => entry.class?.id === "science")).toHaveLength(2);
    expect(day.issues).toEqual([]);
  });

  it.each([
    { anchorDate: "2026-02-30" },
    { timeZone: "Not/AZone" },
    { anchorCycleDayId: "missing" },
    { schoolWeekdays: [1, 1] },
    { advanceWeekdays: [0, 8] },
    { periods: [...exampleSchedule.periods, exampleSchedule.periods[0]] },
    { exceptions: [{ date: "2026-09-10", kind: "closure" }] },
    { exceptions: [{ date: "2026-09-10", kind: "closure", advanceCycle: false }, { date: "2026-09-10", kind: "closure", advanceCycle: true }] },
    { exceptions: [{ date: "2026-09-10", kind: "reset", cycleDayId: "missing", advanceCycle: true }] },
  ])("rejects invalid schedule data: %j", (changes) => {
    expect(scheduleSchema.safeParse({ ...exampleSchedule, ...changes }).success).toBe(false);
  });

  it("rejects overlaps, missing periods, duplicate slots, and overnight slots", () => {
    const day = structuredClone(exampleSchedule.cycleDays[0]);
    for (const invalidSlot of [
      { ...day.slots[1], start: "08:30" },
      { ...day.slots[1], periodId: "missing" },
      { ...day.slots[1], id: day.slots[0].id },
      { ...day.slots[1], start: "23:00", end: "01:00" },
    ]) {
      expect(scheduleSchema.safeParse({ ...exampleSchedule, cycleDays: [{ ...day, slots: [day.slots[0], invalidSlot] }] }).success).toBe(false);
    }
  });

  it("rejects assignments to missing classes and duplicate personal overrides", () => {
    expect(personalScheduleSchema.safeParse({ ...emptyPersonalSchedule(), assignments: { A: "missing" } }).success).toBe(false);
    expect(personalScheduleSchema.safeParse({ ...emptyPersonalSchedule(), dateOverrides: [{ date: "2026-09-08", closed: true }, { date: "2026-09-08", closed: false }] }).success).toBe(false);
    expect(personalScheduleSchema.safeParse({ ...emptyPersonalSchedule(), unexpected: true }).success).toBe(false);
  });
});

describe("rotation and calendar exceptions", () => {
  it("resolves an arbitrary rotation length and stable periods in changing positions", () => {
    const school = schedule();
    expect(resolveDay(school, "2026-09-08").cycleDayId).toBe("day-1");
    expect(resolveDay(school, "2026-09-21").cycleDayId).toBe("day-10");
    expect(resolveDay(school, "2026-09-22").cycleDayId).toBe("day-1");
    expect(resolveDay(school, "2026-09-08").periods[0].periodId).toBe("A");
    expect(resolveDay(school, "2026-09-09").periods.some((entry) => entry.periodId === "A")).toBe(false);
    expect(resolveDay(school, "2026-09-10").periods[3].periodId).toBe("A");
    const short = schedule({ cycleDays: exampleSchedule.cycleDays.slice(0, 3) });
    expect(resolveDay(short, "2026-09-11").cycleDayId).toBe("day-1");
  });

  it("works before the anchor including weekends and a prior paused holiday", () => {
    const school = schedule({ exceptions: [{ date: "2026-09-07", kind: "closure", advanceCycle: false }] });
    expect(resolveDay(school, "2026-09-04").cycleDayId).toBe("day-10");
    expect(resolveDay(school, "2026-09-07")).toMatchObject({ closed: true, cycleDayId: "day-1", periods: [] });
    expect(resolveDay(school, "2026-08-25").cycleDayId).toBe("day-2");
  });

  it("counts an advancing weekend closure or weekend replacement when working back from the anchor", () => {
    // Without exceptions Friday 2026-09-04 is day-9: only Friday and Monday advance before the Tuesday anchor.
    expect(resolveDay(schedule(), "2026-09-04").cycleDayId).toBe("day-9");
    const closure = schedule({ exceptions: [{ date: "2026-09-05", kind: "closure", advanceCycle: true }] });
    expect(resolveDay(closure, "2026-09-04").cycleDayId).toBe("day-8");
    expect(resolveDay(closure, "2026-09-05")).toMatchObject({ closed: true, cycleDayId: "day-9" });
    expect(resolveDay(closure, "2026-09-07").cycleDayId).toBe("day-10");
    expect(resolveDay(closure, "2026-09-08").cycleDayId).toBe("day-1");
    const replacement = schedule({ exceptions: [{ date: "2026-09-06", kind: "replacement", advanceCycle: true, slots: [{ id: "assembly", periodId: "A", start: "12:00", end: "13:00" }] }] });
    expect(resolveDay(replacement, "2026-09-04").cycleDayId).toBe("day-8");
    expect(resolveDay(replacement, "2026-09-05")).toMatchObject({ closed: true, cycleDayId: "day-9" });
    expect(resolveDay(replacement, "2026-09-06")).toMatchObject({ closed: false, cycleDayId: "day-9", periods: [{ slotId: "assembly" }] });
    expect(resolveDay(replacement, "2026-09-07").cycleDayId).toBe("day-10");
  });

  it("separates school attendance weekdays from rotation advancement weekdays", () => {
    const calendarRotation = schedule({ advanceWeekdays: [1, 2, 3, 4, 5, 6, 7] });
    expect(resolveDay(calendarRotation, "2026-09-12").closed).toBe(true);
    expect(resolveDay(calendarRotation, "2026-09-14").cycleDayId).toBe("day-7");
    expect(resolveDay(schedule(), "2026-09-14").cycleDayId).toBe("day-5");
    expect(resolveDay(schedule({ advanceWeekdays: [] }), "2026-12-14").cycleDayId).toBe("day-1");
  });

  it("starts advancing on school days when a one-day schedule gets a second day", () => {
    const single = schedule({ cycleDays: [{ id: "day-1", label: "Every day", slots: [] }], anchorCycleDayId: "day-1", advanceWeekdays: [], exceptions: [] });
    expect(rotationNeverAdvances(single)).toBe(false);
    const grown = scheduleSchema.parse(withCycleDay(single, { id: "day-2", label: "Day 2", slots: [] }));
    expect(grown.advanceWeekdays).toEqual(single.schoolWeekdays);
    expect(rotationNeverAdvances(grown)).toBe(false);
    expect(resolveDay(grown, "2026-09-08").cycleDayId).toBe("day-1");
    expect(resolveDay(grown, "2026-09-09").cycleDayId).toBe("day-2");
    // An existing rotation keeps the advance days it chose, even an empty list.
    const stuck = schedule({ advanceWeekdays: [] });
    expect(rotationNeverAdvances(stuck)).toBe(true);
    expect(withCycleDay(stuck, { id: "day-extra", label: "Extra", slots: [] }).advanceWeekdays).toEqual([]);
    expect(withCycleDay(schedule(), { id: "day-extra", label: "Extra", slots: [] }).advanceWeekdays).toEqual(schedule().advanceWeekdays);
  });

  it("pauses or advances rotation on closures according to the explicit exception", () => {
    for (const advanceCycle of [false, true]) {
      const school = schedule({ exceptions: [{ date: "2026-09-09", kind: "closure", advanceCycle }] });
      expect(resolveDay(school, "2026-09-09").periods).toEqual([]);
      expect(resolveDay(school, "2026-09-10").cycleDayId).toBe(advanceCycle ? "day-3" : "day-2");
    }
  });

  it("opens a weekend replacement and independently advances its rotation", () => {
    const school = schedule({ exceptions: [{
      date: "2026-09-12", kind: "replacement", advanceCycle: true,
      slots: [{ id: "assembly", periodId: "A", start: "12:00", end: "13:00" }],
    }] });
    expect(resolveDay(school, "2026-09-12")).toMatchObject({ closed: false, periods: [{ slotId: "assembly" }] });
    expect(resolveDay(school, "2026-09-14").cycleDayId).toBe("day-6");
  });

  it("applies resets on their date and starts the next date from their advancement rule", () => {
    const school = schedule({ exceptions: [{ date: "2026-09-10", kind: "reset", cycleDayId: "day-8", advanceCycle: false }] });
    expect(resolveDay(school, "2026-09-09").cycleDayId).toBe("day-2");
    expect(resolveDay(school, "2026-09-10").cycleDayId).toBe("day-8");
    expect(resolveDay(school, "2026-09-11").cycleDayId).toBe("day-8");
    expect(resolveDay(school, "2026-09-14").cycleDayId).toBe("day-9");
  });

  it("handles resets before the anchor without overriding the anchor later", () => {
    const school = schedule({ exceptions: [{ date: "2026-09-01", kind: "reset", cycleDayId: "day-3", advanceCycle: true }] });
    expect(resolveDay(school, "2026-08-31").cycleDayId).toBe("day-2");
    expect(resolveDay(school, "2026-09-01").cycleDayId).toBe("day-3");
    expect(resolveDay(school, "2026-09-07").cycleDayId).toBe("day-7");
    expect(resolveDay(school, "2026-09-08").cycleDayId).toBe("day-1");
    const sameDate = schedule({ exceptions: [{ date: "2026-09-08", kind: "reset", cycleDayId: "day-9", advanceCycle: true }] });
    expect(resolveDay(sameDate, "2026-09-08").cycleDayId).toBe("day-9");
  });

  it("combines a cycle reset with special bells or an explicit closure", () => {
    const school = schedule({ exceptions: [
      { date: "2026-09-09", kind: "reset", cycleDayId: "day-5", advanceCycle: false, closed: true },
      { date: "2026-09-10", kind: "reset", cycleDayId: "day-7", advanceCycle: true, slots: [{ id: "short-day", periodId: "B", start: "08:00", end: "08:30" }] },
    ] });
    expect(resolveDay(school, "2026-09-09")).toMatchObject({ cycleDayId: "day-5", closed: true });
    expect(resolveDay(school, "2026-09-10")).toMatchObject({ cycleDayId: "day-7", periods: [{ slotId: "short-day" }] });
    expect(resolveDay(school, "2026-09-11").cycleDayId).toBe("day-8");
  });
});

describe("next class and time zones", () => {
  it("returns assigned current and upcoming classes at precise period boundaries", () => {
    const school = schedule();
    expect(nextClass(school, "2026-09-08T11:59:59Z", examplePersonalSchedule)).toMatchObject({ status: "upcoming", periodId: "A", class: { name: "Algebra" }, startAt: "2026-09-08T12:00:00Z" });
    expect(nextClass(school, "2026-09-08T12:00:00Z", examplePersonalSchedule)).toMatchObject({ status: "current", periodId: "A" });
    expect(nextClass(school, "2026-09-08T13:00:00Z", examplePersonalSchedule)).toMatchObject({ status: "upcoming", periodId: "B" });
    expect(nextClass(school, "2026-09-08T14:15:00Z", examplePersonalSchedule)).toMatchObject({ status: "current", kind: "lunch" });
  });

  it("uses the school date rather than the UTC or browser date", () => {
    const school = schedule({ timeZone: "America/Los_Angeles" });
    expect(nextClass(school, "2026-09-08T01:00:00Z")).toMatchObject({ date: "2026-09-08", startAt: "2026-09-08T15:00:00Z", cycleDayId: "day-1" });
    const early = schedule({ timeZone: "Pacific/Honolulu", cycleDays: [{ id: "day-1", label: "Day 1", slots: [{ id: "evening", periodId: "A", start: "16:00", end: "17:00" }] }] });
    expect(nextClass(early, "2026-09-08T01:00:00Z")).toMatchObject({ date: "2026-09-07", startAt: "2026-09-08T02:00:00Z" });
  });

  it("crosses the spring and fall DST weekends using local school times", () => {
    const school = schedule();
    expect(nextClass(school, "2026-03-06T22:00:00Z")).toMatchObject({ date: "2026-03-09", startAt: "2026-03-09T12:00:00Z" });
    expect(nextClass(school, "2026-10-30T22:00:00Z")).toMatchObject({ date: "2026-11-02", startAt: "2026-11-02T13:00:00Z" });
  });

  it("reports an impossible DST-gap slot without losing the saved configuration", () => {
    const school = schedule({ schoolWeekdays: [7], cycleDays: [{ id: "day-1", label: "Sunday", slots: [{ id: "gap", periodId: "A", start: "02:30", end: "03:00" }] }] });
    expect(resolveDay(school, "2026-03-08")).toMatchObject({ periods: [], issues: [{ slotId: "gap", reason: "nonexistent-time" }] });
    expect(school.cycleDays[0].slots).toHaveLength(1);
    expect(resolveDay(school, "2026-03-15").periods).toHaveLength(1);
  });

  it("does not silently move nonexistent gap times onto another scheduled period", () => {
    const school = schedule({ schoolWeekdays: [7], cycleDays: [{ id: "day-1", label: "Sunday", slots: [
      { id: "gap", periodId: "A", start: "02:00", end: "02:30" },
      { id: "real", periodId: "B", start: "03:00", end: "03:30" },
    ] }] });
    expect(resolveDay(school, "2026-03-08")).toMatchObject({ periods: [{ slotId: "real" }], issues: [{ slotId: "gap", reason: "nonexistent-time" }] });
  });

  it("chooses the earlier occurrence of repeated fall-back local times", () => {
    const school = schedule({ schoolWeekdays: [7], cycleDays: [{ id: "day-1", label: "Sunday", slots: [{ id: "fold", periodId: "A", start: "01:00", end: "01:30" }] }] });
    expect(resolveDay(school, "2026-11-01").periods[0]).toMatchObject({ startAt: "2026-11-01T05:00:00Z", endAt: "2026-11-01T05:30:00Z" });
  });

  it("resolves a period that ends inside the fall-back fold with the start's earlier offset", () => {
    // 01:30 happens twice and takes the earlier (EDT) instant; 02:00 happens once (EST). The documented rule
    // gives this 30-minute slot 90 minutes of real time on the night the clocks go back.
    const school = schedule({ schoolWeekdays: [7], cycleDays: [{ id: "day-1", label: "Sunday", slots: [{ id: "fold", periodId: "A", start: "01:30", end: "02:00" }] }] });
    const day = resolveDay(school, "2026-11-01");
    expect(day.issues).toEqual([]);
    expect(day.periods[0]).toMatchObject({ start: "01:30", end: "02:00", startAt: "2026-11-01T05:30:00Z", endAt: "2026-11-01T07:00:00Z" });
    expect(resolveDay(school, "2026-11-08").periods[0]).toMatchObject({ startAt: "2026-11-08T06:30:00Z", endAt: "2026-11-08T07:00:00Z" });
  });

  it("looks 370 days ahead by default and no further", () => {
    const special = (date: string) => schedule({ cycleDays: [{ id: "day-1", label: "Day 1", slots: [] }], anchorCycleDayId: "day-1", exceptions: [
      { date, kind: "replacement", advanceCycle: false, slots: [{ id: "far", periodId: "A", start: "08:00", end: "09:00" }] },
    ] });
    // Offsets 0..369 from 2026-09-08 reach 2027-09-12.
    expect(nextClass(special("2027-09-12"), "2026-09-08T10:00:00Z")).toMatchObject({ date: "2027-09-12", slotId: "far" });
    expect(nextClass(special("2027-09-13"), "2026-09-08T10:00:00Z")).toBeNull();
    expect(nextClass(special("2027-09-13"), "2026-09-08T10:00:00Z", emptyPersonalSchedule(), 371)).toMatchObject({ date: "2027-09-13" });
  });

  it("skips closures and returns null when no period exists in the look-ahead window", () => {
    const school = schedule({ exceptions: [{ date: "2026-09-08", kind: "closure", advanceCycle: false }] });
    expect(nextClass(school, new Date("2026-09-08T10:00:00Z"), emptyPersonalSchedule(), 1)).toBeNull();
    expect(nextClass(school, "2026-09-08T10:00:00Z")).toMatchObject({ date: "2026-09-09", cycleDayId: "day-1" });
  });
});

describe("personal overrides and shared corrections", () => {
  it("applies personal cycle and date overrides without changing shared rotations", () => {
    const school = schedule();
    const personal = personalScheduleSchema.parse({
      ...examplePersonalSchedule,
      cycleDayOverrides: [{ cycleDayId: "day-1", slots: [{ id: "my-first", periodId: "D", start: "09:00", end: "10:00" }] }],
      dateOverrides: [{ date: "2026-09-08", shiftMinutes: 30 }],
    });
    expect(resolveDay(school, "2026-09-08", personal).periods).toMatchObject([{ slotId: "my-first", start: "09:30", class: { name: "History" } }]);
    expect(resolveDay(school, "2026-09-09", personal).cycleDayId).toBe("day-2");
    expect(resolveDay(school, "2026-09-08").periods[0].start).toBe("08:00");
  });

  it("lets a personal cycle override replace school replacement and special-bell slots, but not reopen a closed reset", () => {
    const mine = [{ id: "mine", periodId: "D", start: "09:00", end: "10:00" }];
    const school = schedule({ exceptions: [
      { date: "2026-09-08", kind: "replacement", advanceCycle: true, slots: [{ id: "assembly", periodId: "A", start: "12:00", end: "13:00" }] },
      { date: "2026-09-10", kind: "reset", cycleDayId: "day-7", advanceCycle: true, slots: [{ id: "short-day", periodId: "B", start: "08:00", end: "08:30" }] },
      { date: "2026-09-11", kind: "reset", cycleDayId: "day-2", advanceCycle: true, closed: true },
      { date: "2026-09-12", kind: "replacement", advanceCycle: true, slots: [{ id: "saturday", periodId: "A", start: "10:00", end: "11:00" }] },
    ] });
    const personal = personalScheduleSchema.parse({ ...emptyPersonalSchedule(), cycleDayOverrides: [
      { cycleDayId: "day-1", slots: mine }, { cycleDayId: "day-7", slots: mine }, { cycleDayId: "day-2", slots: mine }, { cycleDayId: "day-3", slots: mine },
    ] });
    expect(resolveDay(school, "2026-09-08", personal)).toMatchObject({ cycleDayId: "day-1", closed: false, periods: [{ slotId: "mine" }] });
    expect(resolveDay(school, "2026-09-10", personal)).toMatchObject({ cycleDayId: "day-7", closed: false, periods: [{ slotId: "mine" }] });
    expect(resolveDay(school, "2026-09-11", personal)).toMatchObject({ cycleDayId: "day-2", closed: true, periods: [] });
    // The weekend replacement is day-3 (the closed reset advanced) and opens with the student's own day-3 slots.
    expect(resolveDay(school, "2026-09-12", personal)).toMatchObject({ cycleDayId: "day-3", closed: false, periods: [{ slotId: "mine" }] });
    expect(resolveDay(school, "2026-09-12").periods).toMatchObject([{ slotId: "saturday" }]);
  });

  it("applies personal date overrides on top of a private schedule", () => {
    const personal = personalScheduleSchema.parse({
      ...examplePersonalSchedule,
      customSchedule: schedule({ timeZone: "America/Chicago", anchorCycleDayId: "day-5" }),
      dateOverrides: [{ date: "2026-09-08", shiftMinutes: 30 }, { date: "2026-09-09", closed: true }],
    });
    expect(nextClass(schedule(), "2026-09-08T12:00:00Z", personal)).toMatchObject({ date: "2026-09-08", cycleDayId: "day-5", periodId: "A", start: "08:30", startAt: "2026-09-08T13:30:00Z", class: { name: "Algebra" } });
    expect(resolveDay(schedule(), "2026-09-09", personal)).toMatchObject({ cycleDayId: "day-6", closed: true, periods: [] });
    expect(nextClass(schedule(), "2026-09-08T18:00:00Z", personal)).toMatchObject({ date: "2026-09-10", cycleDayId: "day-7" });
  });

  it("lists the rotation days a period meets on with the student's cycle-day overrides", () => {
    const school = schedule({ cycleDays: [
      { id: "day-1", label: "Day 1", slots: [{ id: "first", periodId: "A", start: "08:00", end: "09:00" }] },
      { id: "day-2", label: "Day 2", slots: [{ id: "first", periodId: "B", start: "08:00", end: "09:00" }] },
      { id: "day-3", label: "Day 3", slots: [{ id: "first", periodId: "A", start: "08:00", end: "09:00" }] },
    ], anchorCycleDayId: "day-1" });
    expect(cycleDaysWithPeriod(school, emptyPersonalSchedule(), "A")).toEqual(["Day 1", "Day 3"]);
    const moved = { ...emptyPersonalSchedule(), cycleDayOverrides: [
      { cycleDayId: "day-3", slots: [{ id: "first", periodId: "B", start: "08:00", end: "09:00" }] },
      { cycleDayId: "day-2", slots: [{ id: "first", periodId: "A", start: "08:00", end: "09:00" }] },
    ] };
    expect(cycleDaysWithPeriod(school, moved, "A")).toEqual(["Day 1", "Day 2"]);
    expect(cycleDaysWithPeriod(school, moved, "B")).toEqual(["Day 3"]);
  });

  it("preserves a school closure unless a personal date explicitly reopens it", () => {
    const school = schedule({ exceptions: [{ date: "2026-09-08", kind: "closure", advanceCycle: false }] });
    const personal = personalScheduleSchema.parse({ ...emptyPersonalSchedule(), cycleDayOverrides: [{ cycleDayId: "day-1", slots: exampleSchedule.cycleDays[0].slots }] });
    expect(resolveDay(school, "2026-09-08", personal).closed).toBe(true);
    personal.dateOverrides.push({ date: "2026-09-08", closed: false });
    expect(resolveDay(school, "2026-09-08", personal).periods).toHaveLength(4);
  });

  it("retains edits and reports removed IDs and changed shared days", () => {
    const original = schedule();
    const changed = schedule();
    changed.periods = changed.periods.filter((entry) => entry.id !== "A");
    changed.cycleDays = changed.cycleDays.map((day) => ({ ...day, slots: day.slots.filter((slot) => slot.periodId !== "A") }));
    const personal = personalScheduleSchema.parse({ ...examplePersonalSchedule, cycleDayOverrides: [{ cycleDayId: "day-1", slots: original.cycleDays[0].slots }] });
    const before = JSON.stringify(personal);
    const conflicts = detectOverrideConflicts(original, changed, personal);
    expect(conflicts).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "period-removed", target: "A" }), expect.objectContaining({ kind: "shared-day-changed", target: "day-1" })]));
    expect(JSON.stringify(personal)).toBe(before);
    const day = resolveDay(changed, "2026-09-08", personal);
    expect(day.periods[0].class?.name).toBe("Algebra");
    expect(day.issues).toContainEqual({ slotId: "first", reason: "missing-period" });
    // The removed period's internal id never becomes the label students see.
    expect(day.periods[0].label).toBe("Algebra");
    const unassigned = resolveDay(changed, "2026-09-08", { ...personal, assignments: {} });
    expect(unassigned.periods[0]).toMatchObject({ periodId: "A", label: REMOVED_PERIOD_LABEL });
    expect(unassigned.periods.map((period) => period.label)).not.toContain("A");
  });

  it("flags removed cycle overrides and schedule changes beneath date overrides", () => {
    const original = schedule();
    const changed = schedule({ cycleDays: exampleSchedule.cycleDays.slice(0, 9), exceptions: [{ date: "2026-09-09", kind: "closure", advanceCycle: false }] });
    const personal = personalScheduleSchema.parse({ ...emptyPersonalSchedule(), cycleDayOverrides: [{ cycleDayId: "day-10", slots: [] }], dateOverrides: [{ date: "2026-09-09", shiftMinutes: 15 }] });
    expect(detectOverrideConflicts(original, changed, personal)).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "cycle-day-removed" }), expect.objectContaining({ kind: "shared-date-changed", target: "2026-09-09" })]));
  });

  it("preserves an invalidated time shift and reports it for a user decision", () => {
    const original = schedule();
    const changed = schedule({ cycleDays: [{ id: "day-1", label: "Late day", slots: [{ id: "late", periodId: "A", start: "23:00", end: "23:45" }] }] });
    const personal = personalScheduleSchema.parse({ ...emptyPersonalSchedule(), dateOverrides: [{ date: "2026-09-08", shiftMinutes: 30 }] });
    expect(resolveDay(changed, "2026-09-08", personal).issues).toContainEqual({ slotId: "late", reason: "shift-outside-day" });
    expect(detectOverrideConflicts(original, changed, personal)).toContainEqual(expect.objectContaining({ kind: "invalid-shift" }));
    expect(personal.dateOverrides[0].shiftMinutes).toBe(30);
  });

  it("does not flag unrelated school edits, and honors independent personal schedules", () => {
    const original = schedule();
    const changed = schedule();
    changed.cycleDays[1].slots[0].end = "09:05";
    const personal = personalScheduleSchema.parse({ ...emptyPersonalSchedule(), cycleDayOverrides: [{ cycleDayId: "day-1", slots: original.cycleDays[0].slots }] });
    expect(detectOverrideConflicts(original, changed, personal)).toEqual([]);
    personal.customSchedule = schedule({ timeZone: "America/Chicago", anchorCycleDayId: "day-5" });
    expect(resolveDay(changed, "2026-09-08", personal).cycleDayId).toBe("day-5");
    expect(nextClass(changed, "2026-09-08T12:00:00Z", personal)?.startAt).toBe("2026-09-08T13:00:00Z");
    expect(detectOverrideConflicts(original, changed, personal)).toEqual([]);
  });
});

describe("exception lookups", () => {
  /** The rotation rule written out directly: the latest boundary (anchor or reset) and a walk over every exception. */
  function referenceCycleDayId(school: Schedule, dateString: string): string {
    const boundaries = [{ date: school.anchorDate, cycleDayId: school.anchorCycleDayId }, ...school.exceptions.flatMap((entry) => entry.kind === "reset" ? [entry] : [])]
      .sort((left, right) => left.date.localeCompare(right.date));
    const boundary = boundaries.findLast((entry) => entry.date <= dateString) ?? boundaries[0];
    const [from, to, sign] = dateString >= boundary.date ? [boundary.date, dateString, 1] : [dateString, boundary.date, -1];
    let count = 0;
    for (let day = Temporal.PlainDate.from(from); day.toString() < to; day = day.add({ days: 1 })) {
      const exception = school.exceptions.find((entry) => entry.date === day.toString());
      count += exception ? Number(exception.advanceCycle) : Number(school.advanceWeekdays.includes(day.dayOfWeek));
    }
    const start = school.cycleDays.findIndex((entry) => entry.id === boundary.cycleDayId);
    return school.cycleDays[(((start + sign * count) % school.cycleDays.length) + school.cycleDays.length) % school.cycleDays.length].id;
  }

  it("matches a day-by-day walk around resets before, on and after the anchor", () => {
    const school = schedule({ exceptions: [
      { date: "2026-08-20", kind: "reset", cycleDayId: "day-4", advanceCycle: true },
      { date: "2026-09-08", kind: "reset", cycleDayId: "day-9", advanceCycle: false },
      { date: "2026-09-12", kind: "closure", advanceCycle: true },
      { date: "2026-09-15", kind: "closure", advanceCycle: false },
      { date: "2026-09-21", kind: "reset", cycleDayId: "day-2", advanceCycle: true },
      { date: "2026-10-01", kind: "replacement", advanceCycle: false, slots: [] },
    ] });
    for (let day = Temporal.PlainDate.from("2026-08-01"); day.toString() < "2026-10-20"; day = day.add({ days: 1 })) {
      expect(resolveDay(school, day.toString()).cycleDayId, day.toString()).toBe(referenceCycleDayId(school, day.toString()));
    }
    expect(resolveDay(school, "2026-09-15").closed).toBe(true);
    expect(resolveDay(school, "2026-10-01")).toMatchObject({ closed: false, periods: [] });
  });

  it("does not scale each resolved day with the number of exceptions", () => {
    const first = Temporal.PlainDate.from("2013-01-01");
    const exceptions = Array.from({ length: 5000 }, (_, offset) => ({ date: first.add({ days: offset }).toString(), kind: "closure" as const, advanceCycle: false }));
    const school = schedule({ anchorDate: "2013-01-01", exceptions });
    expect(resolveDay(school, "2026-09-08").cycleDayId).toBe(referenceCycleDayId(school, "2026-09-08"));
    const days = Array.from({ length: 90 }, (_, offset) => Temporal.PlainDate.from("2026-09-01").add({ days: offset }).toString());
    // Date parsing is the dominant cost; reading every exception date again for each day would take 90 × 5000
    // parses. The bound is the size of one pass over the exceptions for all 90 days together, so a few extra
    // parses per day in a refactor still pass while per-exception work per day does not.
    const from = vi.spyOn(Temporal.PlainDate, "from");
    try {
      for (const day of days) resolveDay(school, day);
      expect(from.mock.calls.length).toBeLessThan(exceptions.length);
    } finally {
      from.mockRestore();
    }
  });

  describe("after the schedule changes", () => {
    const exceptions: Schedule["exceptions"] = [
      { date: "2026-09-09", kind: "closure", advanceCycle: false },
      { date: "2026-09-16", kind: "replacement", advanceCycle: true, slots: [] },
      { date: "2026-09-22", kind: "closure", advanceCycle: false },
    ];
    const days = Array.from({ length: 40 }, (_, offset) => Temporal.PlainDate.from("2026-09-01").add({ days: offset }).toString());
    const expectReference = (school: Schedule) => {
      for (const day of days) expect(resolveDay(school, day).cycleDayId, day).toBe(referenceCycleDayId(school, day));
    };

    it("follows new advance days even when the exceptions array is reused", () => {
      const before = schedule({ exceptions });
      expectReference(before);
      const after: Schedule = { ...before, advanceWeekdays: [1, 3, 5] };
      expect(after.exceptions).toBe(before.exceptions);
      expectReference(after);
      expect(days.map((day) => resolveDay(after, day).cycleDayId)).not.toEqual(days.map((day) => resolveDay(before, day).cycleDayId));
      expectReference(before);
    });

    it("follows a replaced exceptions array", () => {
      const before = schedule({ exceptions });
      expectReference(before);
      const after: Schedule = { ...before, exceptions: [...before.exceptions, { date: "2026-09-14", kind: "reset", cycleDayId: "day-7", advanceCycle: true }] };
      expectReference(after);
      expect(resolveDay(after, "2026-09-14").cycleDayId).toBe("day-7");
      expect(resolveDay(before, "2026-09-14").cycleDayId).not.toBe("day-7");
    });

    it("follows an exception pushed onto the same array", () => {
      const school = schedule({ exceptions: structuredClone(exceptions) });
      expectReference(school);
      school.exceptions.push({ date: "2026-09-28", kind: "closure", advanceCycle: false });
      expectReference(school);
      expect(resolveDay(school, "2026-09-28").closed).toBe(true);
    });
  });
});

describe("date range edges", () => {
  it("clamps navigation into the range resolveDay accepts", () => {
    expect(clampDate("1899-12-31")).toBe("1900-01-01");
    expect(clampDate("2200-01-05")).toBe("2199-12-31");
    expect(clampDate("2026-09-24")).toBe("2026-09-24");
  });

  it("resolves a week that runs past 2199 without throwing", () => {
    // 2199-12-31 is a Tuesday, so its Monday-to-Sunday week ends on 2200-01-05.
    expect(() => resolveDay(schedule(), "2200-01-01")).toThrow();
    expect(resolveDayInRange(schedule(), "2200-01-01")).toBeNull();
    expect(resolveDayInRange(schedule(), "2199-12-31")?.date).toBe("2199-12-31");
  });
});

describe("describeDayIssues", () => {
  it("words each reason separately and does not call a shown removed period hidden", () => {
    expect(describeDayIssues([{ slotId: "a", reason: "missing-period" }])).toEqual(["1 period uses a period the school removed."]);
    expect(describeDayIssues([{ slotId: "a", reason: "nonexistent-time" }, { slotId: "b", reason: "nonexistent-time" }])).toEqual(["2 periods are skipped because their times do not exist on this date (daylight-saving change)."]);
    expect(describeDayIssues([{ slotId: "a", reason: "shift-outside-day" }], true)).toEqual(["1 period would be left out because the time shift moves it outside the day."]);
    expect(describeDayIssues([])).toEqual([]);
  });
});
