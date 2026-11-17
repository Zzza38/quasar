import type { Schedule } from "./schedule";

/** A run of school days with no school, or one day on a special bell schedule. `start` and `end` are the same for one day. */
export interface DayOff {
  start: string;
  end: string;
  kind: "closed" | "special";
}

const DAY_MS = 86_400_000;
const nextDate = (date: string) => new Date(Date.parse(`${date}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10);
/** ISO weekday: Monday is 1 and Sunday is 7, as in `schoolWeekdays`. */
const weekday = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay() || 7;

/**
 * The next days off and special schedules from the schedule's exceptions, soonest first. Closures on back-to-back
 * school days join into one run, and a weekend between two closures does not split it. A closure on a day the
 * school never meets is left out, and so is a reset that only moves the rotation.
 */
export function upcomingDaysOff(schedule: Pick<Schedule, "exceptions" | "schoolWeekdays">, today: string, limit = 4): DayOff[] {
  const meets = (date: string) => schedule.schoolWeekdays.includes(weekday(date));
  const noSchoolBetween = (from: string, to: string) => {
    for (let date = nextDate(from); date < to; date = nextDate(date)) if (meets(date)) return false;
    return true;
  };
  const entries = schedule.exceptions
    .filter((entry) => entry.date >= today)
    .map((entry): { date: string; kind: DayOff["kind"] | null } => {
      const closed = entry.kind === "closure" || (entry.kind === "reset" && entry.closed === true);
      const special = entry.kind === "replacement" || (entry.kind === "reset" && entry.slots !== undefined);
      return { date: entry.date, kind: closed ? (meets(entry.date) ? "closed" : null) : special ? "special" : null };
    })
    .filter((entry): entry is { date: string; kind: DayOff["kind"] } => entry.kind !== null)
    .sort((left, right) => left.date.localeCompare(right.date));
  const runs: DayOff[] = [];
  for (const entry of entries) {
    const last = runs[runs.length - 1];
    if (last && last.kind === "closed" && entry.kind === "closed" && noSchoolBetween(last.end, entry.date)) last.end = entry.date;
    else runs.push({ start: entry.date, end: entry.date, kind: entry.kind });
  }
  return runs.slice(0, limit);
}
