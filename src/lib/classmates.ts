import type { WorkspaceContext } from '@/components/app-state';
import type { ResolvedPeriod } from '@/domain/schedule';
import { classKey } from '@/domain/class-match';

export type Classmate = { id: string; displayName: string };

/** Friends who have the same class in this same period: the same directory entry, or the same words in any order (see classKey). */
export function classmatesFor(context: Pick<WorkspaceContext, 'community'>, period: Pick<ResolvedPeriod, 'periodId' | 'class'>): Classmate[] {
  const own = period.class;
  if (!own?.name) return [];
  const key = classKey(own.name);
  return (context.community?.classmates ?? [])
    .filter((friend) => friend.classes.some((cls) => cls.periodId === period.periodId && (own.directoryId && cls.directoryId ? cls.directoryId === own.directoryId : key !== '' && cls.key === key)))
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
