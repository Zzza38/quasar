import type { WorkspaceContext } from '@/components/app-state';
import { resolveDay, type ResolvedPeriod, type Schedule } from '@/domain/schedule';
import { classMatcher } from '@/domain/class-match';

export type Classmate = { id: string; displayName: string; avatar: string | null };

/** Friends whose resolved timetable has this same class (classMatcher, through the school directory) at this same time on this date. */
export function classmatesFor(context: Pick<WorkspaceContext, 'community'>, schedule: Schedule, date: string, period: Pick<ResolvedPeriod, 'periodId' | 'startAt' | 'endAt' | 'class'>): Classmate[] {
  const own = period.class;
  if (!own?.name) return [];
  const sameClass = classMatcher(context.community?.classDirectory);
  return (context.community?.classmates ?? [])
    .filter((friend) => {
      try {
        const day = resolveDay(schedule, date, friend.personal);
        return !day.closed && day.periods.some((theirs) => theirs.periodId === period.periodId && theirs.startAt === period.startAt && theirs.endAt === period.endAt && theirs.class && sameClass(own, theirs.class));
      } catch { return false; }
    })
    // A workspace cached before avatars were sent has none.
    .map((friend) => ({ id: friend.id, displayName: friend.displayName, avatar: friend.avatar ?? null }));
}

/** Where some classmates go once a period ends: their next period's class (or label), its room, and when it starts. */
export type NextStop = { title: string; room: string | null; startAt: string | null; classmates: Classmate[] };

export const DONE_FOR_TODAY = 'Done for today';
export const FREE_PERIOD = 'Free';
/** A class period the friend has not filled in, so it is not known to be free. */
export const NO_CLASS_SET = 'No class set';

/**
 * Groups `mates` by the period each one has next after `period` ends on `date`: "Chemistry" in STU 2, "Lunch",
 * "Free" for a period they marked free, "No class set" for a class period they left empty, or "Done for today". Groups come in start order, the
 * done-for-today group last; friends in a group keep the order of `mates`.
 */
export function nextStops(context: Pick<WorkspaceContext, 'community'>, schedule: Schedule, date: string, period: Pick<ResolvedPeriod, 'endAt'>, mates: Classmate[]): NextStop[] {
  const friends = new Map((context.community?.classmates ?? []).map((friend) => [friend.id, friend]));
  const groups = new Map<string, NextStop>();
  for (const mate of mates) {
    let next: ResolvedPeriod | undefined;
    try {
      const personal = friends.get(mate.id)?.personal;
      const day = personal ? resolveDay(schedule, date, personal) : null;
      next = day && !day.closed ? day.periods.find((theirs) => theirs.startAt >= period.endAt) : undefined;
    } catch { next = undefined; }
    const title = !next ? DONE_FOR_TODAY : next.free ? FREE_PERIOD : next.kind === 'class' && !next.class ? NO_CLASS_SET : next.class?.name || next.label;
    const room = next?.class?.room?.trim() || null;
    const key = `${title.trim().toLowerCase()}\u0000${room?.toLowerCase() ?? ''}`;
    const group = groups.get(key) ?? { title, room, startAt: next?.startAt ?? null, classmates: [] };
    group.classmates.push(mate);
    if (next && group.startAt && next.startAt < group.startAt) group.startAt = next.startAt;
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => (a.startAt ?? '￿').localeCompare(b.startAt ?? '￿'));
}
