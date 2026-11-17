import { resolveDayInRange, type PersonalSchedule, type ResolvedPeriod, type Schedule } from './schedule';
import type { Task } from './task';

/** Explicit assessment names mean class work, unless the task says it is preparation or a take-home assessment. */
export function workLocationOf(task: Pick<Task, 'title' | 'notes' | 'workLocation'>): Task['workLocation'] {
  if (task.workLocation) return task.workLocation;
  if (/\b(study|studying|review|prepare|preparation|practice|corrections?|optional|draft|essay|report|project|homework|hw|questions?|answers?|results?)\b/i.test(task.title) || /\b(take[ -]?home|at home)\b/i.test(`${task.title} ${task.notes}`)) return undefined;
  return /\b(tests?|quiz(?:zes)?|exams?|midterms?|finals?)\b/i.test(task.title) ? 'in-class' : undefined;
}

/** Work time is separate from the submission deadline, and follows current bell times and day overrides. */
export function taskClassPeriods(task: Task, schedule: Schedule, personal: PersonalSchedule): ResolvedPeriod[] {
  if (workLocationOf(task) !== 'in-class' || !task.classId || !task.dueDate) return [];
  const day = resolveDayInRange(schedule, task.dueDate, personal);
  if (!day || day.closed) return [];
  return day.periods.filter(period => period.class?.id === task.classId);
}
