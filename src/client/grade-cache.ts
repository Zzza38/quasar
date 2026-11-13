import { z } from 'zod';
import { gradeGoalSchema, planTargetSchema } from '@/domain/grade-goals';
import type { RouterOutput } from './api';
import { readReceived, removeReceived, writeReceived } from './received-cache';
type Book = RouterOutput['schoology']['gradebook'];
const n = z.number(), text = z.string(), nullable = n.nullable();
const detail = z.object({
  sectionId: text, title: text, termWeight: n, termReported: nullable, reported: nullable,
  categories: z.array(z.object({ id: text, title: text, weight: n, dropLowest: n, reported: nullable })),
  items: z.array(z.object({ id: text, title: text, categoryId: text, earned: nullable, max: n, exception: z.enum(['excused', 'incomplete', 'missing']).nullable(), pending: z.boolean(), due: text.nullable() })),
  exams: z.array(z.object({ id: text, title: text, weight: n, max: n, earned: nullable })),
});
const schema = z.object({ name: text, checkedAt: text.datetime({ offset: true }), classes: z.array(z.object({ detail, grade: text.nullable(), classId: text.nullable() })), goals: z.record(text, z.object({ goal: gradeGoalSchema.nullable(), plan: planTargetSchema.nullable() })) });
export const readGradeCache = (account: string): Book | null => readReceived(account, 'grades', (value): value is Book => schema.safeParse(value).success);
export const writeGradeCache = (account: string, book: Book): void => writeReceived(account, 'grades', book);
export const clearGradeCache = (account: string): void => removeReceived(account, 'grades');
