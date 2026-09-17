import { z } from 'zod';
import { Temporal } from '@js-temporal/polyfill';
export const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  try { return Temporal.PlainDate.from(value).toString() === value; } catch { return false; }
}, 'Enter a valid date');
export const timeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const timeZoneSchema = z.string().max(100).refine(value => {
  try { new Intl.DateTimeFormat('en-US', { timeZone: value }); return true; } catch { return false; }
}, 'Enter a valid time zone');
export const taskSchema = z.object({
  title: z.string().trim().min(1).max(300),
  dueDate: dateSchema.nullable(), dueTime: timeSchema.nullable(),
  classId: z.string().min(1).max(100).nullable(),
  notes: z.string().max(10000), completed: z.boolean(),
  priority: z.enum(['low', 'normal', 'high']).optional(),
  subtasks: z.array(z.object({ id: z.uuid(), title: z.string().trim().min(1).max(300), completed: z.boolean() }).strict()).max(100).refine(items => new Set(items.map(item => item.id)).size === items.length, 'Checklist items need unique IDs').optional(),
  recurrence: z.object({ frequency: z.enum(['daily', 'weekly', 'monthly']), interval: z.number().int().min(1).max(365), until: dateSchema.nullable(), anchorDate: dateSchema.optional() }).strict().nullable().optional(),
  reminder: z.object({ minutesBefore: z.number().int().min(0).max(10080), timeZone: timeZoneSchema }).strict().nullable().optional(),
  imported: z.object({ subscriptionId: z.string().min(1).max(100), uid: z.string().min(1).max(2000), recurrenceId: z.string().max(2000).nullable(), startDate: dateSchema, startTime: timeSchema.nullable(), endDate: dateSchema.nullable(), endTime: timeSchema.nullable(), timeZone: timeZoneSchema, allDay: z.boolean(), sourceRemoved: z.boolean(), sourceUpdatedAt: z.string().datetime() }).strict().nullable().optional()
}).strict().superRefine((task, ctx) => {
  if (task.dueTime && !task.dueDate) ctx.addIssue({ code: 'custom', message: 'A due time needs a due date', path: ['dueTime'] });
  if (task.recurrence && (!task.dueDate || task.imported)) ctx.addIssue({ code: 'custom', message: 'Repeating tasks need a due date and cannot be calendar imports', path: ['recurrence'] });
  if (task.recurrence?.until && task.dueDate && task.recurrence.until < task.dueDate) ctx.addIssue({ code: 'custom', message: 'Repeat end date cannot be before the due date', path: ['recurrence', 'until'] });
  if (task.reminder && !task.dueDate) ctx.addIssue({ code: 'custom', message: 'A reminder needs a due date', path: ['reminder'] });
});
export type Task = z.infer<typeof taskSchema>;

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
  return { ...task, dueDate, completed: false, recurrence: { ...task.recurrence, anchorDate: task.recurrence.anchorDate ?? task.dueDate }, ...(task.subtasks ? { subtasks: task.subtasks.map(item => ({ ...item, completed: false })) } : {}) };
}
export function upcomingTasks<T extends {data: Record<string, unknown>; deleted: boolean}>(entities: T[]): T[] {
  return entities.filter(e => !e.deleted && !e.data.completed).sort((a, b) =>
    `${a.data.dueDate || '9999-12-31'}T${a.data.dueTime || '23:59'}`.localeCompare(`${b.data.dueDate || '9999-12-31'}T${b.data.dueTime || '23:59'}`));
}
