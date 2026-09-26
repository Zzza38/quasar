import { resolveDayInRange, type PersonalSchedule, type Schedule } from '@/domain/schedule';
import { addDays, daysBetween, formatDate } from '@/lib/format';
import { isOverdue, type TaskItem } from './app-state';

/** Far enough to look past a winter break, but bounded so a schedule with no reachable school day still returns. */
const SCHOOL_DAY_LOOKAHEAD = 60;

/**
 * The first date after `from` on which school meets, following the same rules as the timeline: school weekdays,
 * school closures and replacement days, and the student's own day-off overrides. Null when none is found within
 * the lookahead or the schedule cannot be resolved.
 */
export function nextSchoolDate(schedule: Schedule, personal: PersonalSchedule, from: string): string | null {
  try {
    for (let step = 1; step <= SCHOOL_DAY_LOOKAHEAD; step += 1) {
      const date = addDays(from, step);
      const day = resolveDayInRange(schedule, date, personal);
      if (!day) return null;
      if (!day.closed) return date;
    }
  } catch { return null; }
  return null;
}

export type TaskGroupKey = 'overdue' | 'today' | 'tomorrow' | 'next-school-day' | 'week' | 'later' | 'undated';

export interface TaskGroup {
  key: TaskGroupKey;
  title: string;
  /** A second, quieter label; only the next-school-day group has one. */
  detail?: string;
  items: TaskItem[];
}

/** Groups whose rows need no date chip: the heading already says when. */
export const DATED_GROUPS: ReadonlySet<TaskGroupKey> = new Set(['today', 'tomorrow', 'next-school-day']);

/**
 * The Tasks page groups, in display order, with empty groups dropped. Open tasks fall into Overdue, Today,
 * Tomorrow, the next school day, Next 7 days, Later or No due date. The next school day gets its own group
 * whenever it is not tomorrow, so on a Friday (or before a holiday) Monday's work is not lumped in with the
 * rest of the week. Work due on the days off in between still reads as Tomorrow or by its date. When a break
 * pushes the next school day past the week window, its group follows Next 7 days so groups stay in date order.
 * Items keep their incoming order within each group.
 */
export function groupTasks(items: TaskItem[], context: { today: string; nowTime: string; schedule: Schedule; personal: PersonalSchedule }): TaskGroup[] {
  const { today, nowTime } = context;
  const tomorrow = addDays(today, 1);
  const school = nextSchoolDate(context.schedule, context.personal, today);
  const schoolDelta = school ? daysBetween(today, school) : 0;
  const separate = school !== null && schoolDelta > 1;
  const late = (item: TaskItem) => isOverdue(item.task, today, nowTime);
  const dated = items.filter((item) => item.task.dueDate && !late(item));
  const on = (date: string) => dated.filter((item) => item.task.dueDate === date);
  const between = (from: number, to: number) => dated.filter((item) => {
    const delta = daysBetween(today, item.task.dueDate!);
    return delta >= from && delta <= to && !(separate && item.task.dueDate === school);
  });
  const schoolGroup: TaskGroup | null = separate ? {
    key: 'next-school-day',
    // "Monday" is enough within the week; further out (a break) the date says which Monday.
    title: schoolDelta <= 6 ? formatDate(school, { weekday: 'long' }).split(',')[0] : formatDate(school, { weekday: 'long' }),
    detail: 'Next school day',
    items: on(school),
  } : null;
  const groups: Array<TaskGroup | null> = [
    { key: 'overdue', title: 'Overdue', items: items.filter(late) },
    { key: 'today', title: 'Today', items: on(today) },
    { key: 'tomorrow', title: 'Tomorrow', items: on(tomorrow) },
    schoolDelta <= 7 ? schoolGroup : null,
    { key: 'week', title: 'Next 7 days', items: between(2, 7) },
    schoolDelta > 7 ? schoolGroup : null,
    { key: 'later', title: 'Later', items: between(8, Number.POSITIVE_INFINITY) },
    { key: 'undated', title: 'No due date', items: items.filter((item) => !item.task.dueDate) },
  ];
  return groups.filter((group): group is TaskGroup => group !== null && group.items.length > 0);
}
