import type { WorkspaceContext } from '@/components/app-state';
import type { ResolvedPeriod } from '@/domain/schedule';

export type Classmate = { id: string; displayName: string };

/** Friends who have a class with this name in this same period. Names are compared case-insensitively, the way the profile view does. */
export function classmatesFor(context: Pick<WorkspaceContext, 'community'>, period: Pick<ResolvedPeriod, 'periodId' | 'class'>): Classmate[] {
  const className = period.class?.name;
  if (!className) return [];
  const key = className.trim().toLowerCase();
  return (context.community?.classmates ?? [])
    .filter((friend) => friend.classes.some((cls) => cls.periodId === period.periodId && cls.name === key))
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
