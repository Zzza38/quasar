import { emptyPersonalSchedule, scheduleSchema, type PersonalSchedule } from "./schedule";

/** Editable starter data, not an approved real school schedule. Each lunch wave has its own stable period. */
export const exampleSchedule = scheduleSchema.parse({
  version: 1,
  timeZone: "America/New_York",
  periods: [
    { id: "A", label: "A", kind: "class" },
    { id: "B", label: "B", kind: "class" },
    { id: "C", label: "C", kind: "class" },
    { id: "D", label: "D", kind: "class" },
    { id: "lunch", label: "Lunch", kind: "lunch" },
  ],
  cycleDays: Array.from({ length: 10 }, (_, index) => ({
    id: `day-${index + 1}`,
    label: `Day ${index + 1}`,
    slots: [
      { id: "first", periodId: ["A", "B", "C", "D"][index % 4], start: "08:00", end: "09:00" },
      { id: "second", periodId: ["B", "C", "D", "A"][index % 4], start: "09:10", end: "10:10" },
      { id: "lunch-slot", periodId: "lunch", start: "10:15", end: "10:45" },
      { id: "third", periodId: ["C", "D", "A", "B"][index % 4], start: "10:50", end: "11:50" },
    ],
  })),
  anchorDate: "2026-09-08",
  anchorCycleDayId: "day-1",
  schoolWeekdays: [1, 2, 3, 4, 5],
  advanceWeekdays: [1, 2, 3, 4, 5],
  exceptions: [],
});

export const examplePersonalSchedule: PersonalSchedule = {
  ...emptyPersonalSchedule(),
  classes: [
    { id: "algebra", name: "Algebra", room: "101" },
    { id: "english", name: "English", room: "204" },
    { id: "biology", name: "Biology", room: "Lab 2" },
    { id: "history", name: "History", room: "305" },
  ],
  assignments: { A: "algebra", B: "english", C: "biology", D: "history" },
};
