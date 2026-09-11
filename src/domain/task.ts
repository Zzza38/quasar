import { z } from 'zod';
import { Temporal } from '@js-temporal/polyfill';
export const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  try { return Temporal.PlainDate.from(value).toString() === value; } catch { return false; }
}, 'Enter a valid date');
export const timeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
export const taskSchema = z.object({
  title: z.string().trim().min(1).max(300),
  dueDate: dateSchema.nullable(), dueTime: timeSchema.nullable(),
  classId: z.string().min(1).max(100).nullable(),
  notes: z.string().max(10000), completed: z.boolean()
}).strict().refine(task => !task.dueTime || task.dueDate, { message: 'A due time needs a due date', path: ['dueTime'] });
export type Task = z.infer<typeof taskSchema>;
export function upcomingTasks<T extends {data: Record<string, unknown>; deleted: boolean}>(entities: T[]): T[] {
  return entities.filter(e => !e.deleted && !e.data.completed).sort((a, b) =>
    `${a.data.dueDate || '9999-12-31'}T${a.data.dueTime || '23:59'}`.localeCompare(`${b.data.dueDate || '9999-12-31'}T${b.data.dueTime || '23:59'}`));
}
