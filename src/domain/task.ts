import { z } from 'zod';
import { Temporal } from '@js-temporal/polyfill';
import { dateSchema } from './schedule';
// Task dates share the schedule's 1900-2199 range. A repeating task whose next date would leave it simply ends (see Service.sync).
export { dateSchema };
export const timeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const timeZoneSchema = z.string().max(100).refine(value => {
  try { new Intl.DateTimeFormat('en-US', { timeZone: value }); return true; } catch { return false; }
}, 'Enter a valid time zone');
export const taskSchema = z.object({
  title: z.string().trim().min(1).max(300),
  dueDate: dateSchema.nullable(), dueTime: timeSchema.nullable(),
  classId: z.string().min(1).max(100).nullable(),
  notes: z.string().max(10000), completed: z.boolean(),
  /** When the task was last checked off. Server-owned (see stampCompletion); absent on tasks completed before it existed. */
  completedAt: z.string().datetime().optional(),
  priority: z.enum(['low', 'normal', 'high']).optional(),
  subtasks: z.array(z.object({ id: z.uuid(), title: z.string().trim().min(1).max(300), completed: z.boolean() }).strict()).max(100).refine(items => new Set(items.map(item => item.id)).size === items.length, 'Checklist items need unique IDs').optional(),
  recurrence: z.object({ frequency: z.enum(['daily', 'weekly', 'monthly']), interval: z.number().int().min(1).max(365), until: dateSchema.nullable(), anchorDate: dateSchema.optional() }).strict().nullable().optional(),
  reminder: z.object({ minutesBefore: z.number().int().min(0).max(10080), timeZone: timeZoneSchema }).strict().nullable().optional(),
  imported: z.object({ subscriptionId: z.string().min(1).max(100), uid: z.string().min(1).max(2000), recurrenceId: z.string().max(2000).nullable(), startDate: dateSchema, startTime: timeSchema.nullable(), endDate: dateSchema.nullable(), endTime: timeSchema.nullable(), timeZone: timeZoneSchema, allDay: z.boolean(), sourceRemoved: z.boolean(), sourceUpdatedAt: z.string().datetime(), url: z.url({ protocol: /^https?$/ }).max(2000).nullable().optional() }).strict().nullable().optional()
}).strict().superRefine((task, ctx) => {
  if (task.dueTime && !task.dueDate) ctx.addIssue({ code: 'custom', message: 'A due time needs a due date', path: ['dueTime'] });
  if (task.recurrence && (!task.dueDate || task.imported)) ctx.addIssue({ code: 'custom', message: 'Repeating tasks need a due date and cannot be calendar imports', path: ['recurrence'] });
  if (task.recurrence?.until && task.dueDate && task.recurrence.until < task.dueDate) ctx.addIssue({ code: 'custom', message: 'Repeat end date cannot be before the due date', path: ['recurrence', 'until'] });
  if (task.reminder && !task.dueDate) ctx.addIssue({ code: 'custom', message: 'A reminder needs a due date', path: ['reminder'] });
});
export type Task = z.infer<typeof taskSchema>;
/**
 * Sent with every workspace load and sync by clients that read `completedAt`. Bundles built before it parse tasks
 * strictly and send nothing, so the server leaves `completedAt` out of what it returns to them (Service.workspace
 * and Service.sync); raise it when task data gains another field that such a bundle would reject.
 */
export const TASK_CLIENT_VERSION = 2;

/**
 * Older builds accepted any 4-digit year, so a task can be stored with a date outside 1900-2199 that taskSchema now
 * rejects. This returns a copy with such dates dropped (an out-of-range due date also clears the due time, reminder
 * and repeat, which need one; an imported end date clears its end time; an imported start date drops the calendar
 * link, which the next refresh restores, because parseICalendar starts such a VTODO on its due date instead) when that makes the task valid again, so it can be shown and fixed instead
 * of hidden. Returns null when the task is already valid or cannot be repaired this way.
 */
export function repairTaskDates(data: unknown): Task | null {
  if (!data || typeof data !== 'object' || Array.isArray(data) || taskSchema.safeParse(data).success) return null;
  const inRange = (value: unknown) => typeof value === 'string' && dateSchema.safeParse(value).success;
  const task = { ...(data as Record<string, unknown>) };
  if (task.dueDate != null && !inRange(task.dueDate)) {
    Object.assign(task, { dueDate: null, dueTime: null });
    for (const key of ['reminder', 'recurrence']) if (task[key] != null) task[key] = null;
  }
  const recurrence = task.recurrence;
  if (recurrence && typeof recurrence === 'object' && !Array.isArray(recurrence)) {
    const next = { ...(recurrence as Record<string, unknown>) };
    if (next.until != null && !inRange(next.until)) next.until = null;
    if (next.anchorDate !== undefined && !inRange(next.anchorDate)) delete next.anchorDate;
    task.recurrence = next;
  }
  const imported = task.imported;
  if (imported && typeof imported === 'object' && !Array.isArray(imported)) {
    const next = { ...(imported as Record<string, unknown>) };
    if (next.endDate != null && !inRange(next.endDate)) Object.assign(next, { endDate: null, endTime: null });
    task.imported = next.startDate != null && !inRange(next.startDate) ? null : next;
  }
  const parsed = taskSchema.safeParse(task);
  return parsed.success ? parsed.data : null;
}

/** Called by the server on the first completion transition; never skips overdue occurrences. */
export function nextRecurringTask(task: Task): Task | null {
  if (!task.completed || !task.recurrence || !task.dueDate || task.imported) return null;
  const { frequency, interval, until } = task.recurrence;
  const due = Temporal.PlainDate.from(task.dueDate);
  let next: Temporal.PlainDate;
  if (frequency === 'monthly') {
    const anchor = Temporal.PlainDate.from(task.recurrence.anchorDate ?? task.dueDate);
    const month = due.with({ day: 1 }).add({ months: interval });
    next = month.with({ day: Math.min(anchor.day, month.daysInMonth) });
  } else next = due.add({ days: interval * (frequency === 'weekly' ? 7 : 1) });
  const dueDate = next.toString();
  if (until && dueDate > until) return null;
  const { completedAt: _completedAt, ...open } = task;
  return { ...open, dueDate, completed: false, recurrence: { ...task.recurrence, anchorDate: task.recurrence.anchorDate ?? task.dueDate }, ...(task.subtasks ? { subtasks: task.subtasks.map(item => ({ ...item, completed: false })) } : {}) };
}
/**
 * Keeps `completedAt` in step with `completed`: stamped with `now` when the task becomes completed, carried over
 * while it stays completed, and dropped when it is reopened. `previous` is the stored task (null when new or deleted).
 */
export function stampCompletion(data: Record<string, unknown>, previous: Record<string, unknown> | null, now: Date): Record<string, unknown> {
  const { completedAt: _completedAt, ...next } = data;
  if (data.completed !== true) return next;
  if (previous?.completed !== true) return { ...next, completedAt: now.toISOString() };
  return typeof previous.completedAt === 'string' ? { ...next, completedAt: previous.completedAt } : next;
}
/**
 * The time to stamp when a client's edit completes a task: the client's own stamp, so a task checked off offline
 * keeps when it was done, unless that is missing, unreadable or in the future.
 */
export function completionTime(claimed: unknown, now: Date): Date {
  const time = typeof claimed === 'string' ? Date.parse(claimed) : NaN;
  return Number.isFinite(time) && time <= now.getTime() ? new Date(time) : now;
}
/**
 * Removes a client's completedAt edit before a three-way merge (the field is server-owned, like calendar metadata),
 * so two devices that complete the same task never conflict over when it happened.
 */
export function withoutCompletionEdit(data: Record<string, unknown>, base: { deleted: boolean; data: Record<string, unknown> } | null): Record<string, unknown> {
  const { completedAt: _completedAt, ...next } = data;
  return base && !base.deleted && typeof base.data.completedAt === 'string' ? { ...next, completedAt: base.data.completedAt } : next;
}
