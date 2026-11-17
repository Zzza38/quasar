import { addDays, weekdayOf } from '@/lib/format';
import { effectiveSchedule, resolveDayInRange, type PersonalSchedule, type Schedule } from './schedule';

/** The next date each cycle day falls on, from today, looking up to 90 days ahead. A day that does not come up is absent. */
export function nextCycleDates(school: Schedule, personal: PersonalSchedule, today: string, cycleDays: number): Map<string, string> {
  const found = new Map<string, string>();
  for (let offset = 0; offset < 90 && found.size < cycleDays; offset += 1) {
    const date = addDays(today, offset);
    const day = resolveDayInRange(school, date, personal);
    if (!day) break;
    if (!day.closed && !found.has(day.cycleDayId)) found.set(day.cycleDayId, date);
  }
  return found;
}

/**
 * The cycle days whose turn is lost to a day off before they next meet, with that day off. A closure that advances
 * the rotation uses up a cycle day: with no school on Wednesday's Day 8, Thursday is Day 9 and Day 8 does not meet
 * until the rotation comes round again. `next` is nextCycleDates' result. A day off that only delays its cycle day
 * (school resumes on the same one) is not a skip, and neither is a weekend.
 */
export function skippedCycleDates(school: Schedule, personal: PersonalSchedule, today: string, next: Map<string, string>): Map<string, string> {
  const weekdays = effectiveSchedule(school, personal).schoolWeekdays;
  const last = [...next.values()].sort().at(-1);
  const waiting = new Map<string, string>();
  const skipped = new Map<string, string>();
  if (!last) return skipped;
  for (let date = today; date < last; date = addDays(date, 1)) {
    const day = resolveDayInRange(school, date, personal);
    if (!day) break;
    if (day.closed) {
      const upcoming = next.get(day.cycleDayId);
      if (weekdays.includes(weekdayOf(date)) && upcoming && date < upcoming && !waiting.has(day.cycleDayId)) waiting.set(day.cycleDayId, date);
      continue;
    }
    // School met on another cycle day after the day off, so the rotation moved on without the waiting one.
    for (const [id, off] of waiting) if (id !== day.cycleDayId && date < next.get(id)! && !skipped.has(id)) skipped.set(id, off);
  }
  return skipped;
}
