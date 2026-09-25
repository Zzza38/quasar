import type { WorkspaceContext } from '@/components/app-state';
import { resolveDay, type ResolvedPeriod, type Schedule } from '@/domain/schedule';
import { sameClass } from '@/domain/class-match';

export type Classmate = { id: string; displayName: string };

/** Friends whose resolved timetable has this same class at this same time on this date. */
export function classmatesFor(context: Pick<WorkspaceContext, 'community'>, schedule: Schedule, date: string, period: Pick<ResolvedPeriod, 'periodId' | 'startAt' | 'endAt' | 'class'>): Classmate[] {
  const own = period.class;
  if (!own?.name) return [];
  return (context.community?.classmates ?? [])
    .filter((friend) => {
      try {
        const day = resolveDay(schedule, date, friend.personal);
        return !day.closed && day.periods.some((theirs) => theirs.periodId === period.periodId && theirs.startAt === period.startAt && theirs.endAt === period.endAt && theirs.class && sameClass(own, theirs.class));
      } catch { return false; }
    })
    .map((friend) => ({ id: friend.id, displayName: friend.displayName }));
}

/** "With Evan", "With Evan and Maya", "With Evan, Maya and 2 more". Accepts names or classmates. */
export function withLabel(people: Array<string | Pick<Classmate, 'displayName'>>): string | null {
  const names = people.map((person) => typeof person === 'string' ? person : person.displayName);
  if (names.length === 0) return null;
  if (names.length === 1) return `With ${names[0]}`;
  if (names.length === 2) return `With ${names[0]} and ${names[1]}`;
  return `With ${names[0]}, ${names[1]} and ${names.length - 2} more`;
}
