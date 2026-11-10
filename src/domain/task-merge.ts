import { taskSchema, type Task } from './task';

/**
 * Merging duplicate tasks (src/server/merges.ts): one task is kept and the rest are folded into it and deleted.
 * Shared with the client, which previews the merge before the student confirms it.
 */
export const MERGE_MAX = 6;

type Candidate = { id: string; task: Task };
const PRIORITY_RANK = { low: 0, normal: 1, high: 2 } as const;

/** How much a task carries that a merge would otherwise have to copy over. */
const detail = (task: Task) => (task.classId ? 2 : 0) + (task.priority ? 1 : 0) + (task.dueDate ? 2 : 0) + (task.dueTime ? 1 : 0)
  + (task.notes.trim() ? 1 : 0) + (task.subtasks?.length ? 2 : 0) + (task.reminder ? 1 : 0);

/**
 * The task to keep: a live calendar import first, since the feed keeps updating it (deleting it instead would leave
 * the student's copy frozen), then the one with the most filled in. Ties keep the first one given.
 */
export function pickKeep<T extends Candidate>(tasks: T[]): T {
  const score = ({ task }: Candidate) => (task.imported && !task.imported.sourceRemoved ? 100 : 0) + detail(task);
  return tasks.reduce((best, entry) => score(entry) > score(best) ? entry : best);
}

/**
 * `keep` with what only the others have: a class, a due date, a reminder, notes and checklist steps it lacks, the
 * highest priority, and completion when any copy was checked off (with that copy's completion time). The title, the
 * repeat and the calendar link stay `keep`'s own.
 */
export function mergeTasks(keep: Task, others: Task[]): Task {
  const merged: Task = { ...keep, ...(keep.subtasks ? { subtasks: [...keep.subtasks] } : {}) };
  for (const other of others) {
    merged.classId ??= other.classId;
    if (!merged.workLocation && other.workLocation) {
      merged.workLocation = other.workLocation;
      if (other.workLocationSource) merged.workLocationSource = other.workLocationSource;
    }
    if (other.priority && (!merged.priority || PRIORITY_RANK[other.priority] > PRIORITY_RANK[merged.priority])) merged.priority = other.priority;
    if (!merged.dueDate && other.dueDate) Object.assign(merged, { dueDate: other.dueDate, dueTime: other.dueTime });
    if (!merged.reminder && other.reminder && merged.dueDate) merged.reminder = other.reminder;
    const note = other.notes.trim();
    if (note && !merged.notes.includes(note)) merged.notes = merged.notes.trim() ? `${merged.notes.trimEnd()}\n\n${note}` : note;
    const steps = new Set((merged.subtasks ?? []).map((step) => step.title.trim().toLowerCase()));
    const ids = new Set((merged.subtasks ?? []).map((step) => step.id));
    for (const step of other.subtasks ?? []) {
      if (steps.has(step.title.trim().toLowerCase()) || ids.has(step.id)) continue;
      steps.add(step.title.trim().toLowerCase()); ids.add(step.id);
      merged.subtasks = [...(merged.subtasks ?? []), step];
    }
    if (other.completed && !merged.completed) Object.assign(merged, { completed: true, ...(other.completedAt ? { completedAt: other.completedAt } : {}) });
  }
  merged.notes = merged.notes.slice(0, 10000);
  if (merged.subtasks) merged.subtasks = merged.subtasks.slice(0, 100);
  const parsed = taskSchema.safeParse(merged);
  return parsed.success ? parsed.data : keep;
}
