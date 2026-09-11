import { describe, expect, it } from "vitest";
import { examplePersonalSchedule, exampleSchedule } from "./example";
import {
  detectOverrideConflicts,
  emptyPersonalSchedule,
  nextClass,
  personalScheduleSchema,
  resolveDay,
  scheduleSchema,
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

  it("separates school attendance weekdays from rotation advancement weekdays", () => {
    const calendarRotation = schedule({ advanceWeekdays: [1, 2, 3, 4, 5, 6, 7] });
    expect(resolveDay(calendarRotation, "2026-09-12").closed).toBe(true);
    expect(resolveDay(calendarRotation, "2026-09-14").cycleDayId).toBe("day-7");
    expect(resolveDay(schedule(), "2026-09-14").cycleDayId).toBe("day-5");
    expect(resolveDay(schedule({ advanceWeekdays: [] }), "2026-12-14").cycleDayId).toBe("day-1");
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
