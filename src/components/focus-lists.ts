import type { PersonalSchedule, Schedule } from '@/domain/schedule';
import { ASSESSMENT_DAYS } from '@/domain/ai';
import { daysBetween } from '@/lib/format';
import { isOverdue, sortByDue, type TaskItem } from './app-state';
import { nextSchoolDate } from './task-groups';

/**
 * The two summary lists. Do now (everyone, on Today) is rules only:
 * - Do now: overdue work, work due by the next school day, and high-priority work due within HIGH_SOON_DAYS.
 * - Upcoming tests and quizzes (ai-tasks beta, on Tasks): open tasks due within ASSESSMENT_DAYS that the AI calls a test or quiz.
 */
export const DO_NOW_MAX = 5;
export const HIGH_SOON_DAYS = 3;
export const ASSESSMENTS_MAX = 6;

/** The fallback when the AI can't be reached. Whole words only, so "Retest (optional)" and "contest" don't count. Spanish and French words are common in language classes. */
const ASSESSMENT = /\b(tests?|quiz(?:zes)?|exams?|midterms?|finals?|assessments?|examen(?:es)?|pruebas?|examens?|contr[oô]le|interro)\b/i;
export const isAssessment = (title: string) => ASSESSMENT.test(title) && !/\boptional\b/i.test(title);

export type FocusContext = { today: string; nowTime: string; schedule: Schedule; personal: PersonalSchedule };
export type DoNowItem = { item: TaskItem; reason: string };

export function doNow(items: TaskItem[], { today, nowTime, schedule, personal }: FocusContext): DoNowItem[] {
  const school = nextSchoolDate(schedule, personal, today);
  // Due by the next school day: tomorrow on a weeknight, Monday over a weekend. At least through tomorrow.
  const soon = Math.max(1, school ? daysBetween(today, school) : 1);
  const picked: Array<DoNowItem & { rank: number }> = [];
  for (const item of sortByDue(items.filter((entry) => !entry.task.completed && entry.task.dueDate))) {
    const { task } = item;
    const days = daysBetween(today, task.dueDate!);
    const high = task.priority === 'high';
    let reason: string | null = null, rank = 0;
    if (isOverdue(task, today, nowTime)) { reason = 'Overdue'; rank = 0; }
    else if (days === 0) { reason = 'Due today'; rank = high ? 1 : 2; }
    else if (days <= soon) { reason = days === 1 ? 'Due tomorrow' : 'Due next school day'; rank = high ? 3 : 4; }
    else if (high && days <= HIGH_SOON_DAYS) { reason = `High priority, due in ${days} days`; rank = 5; }
    // Low-priority work only makes the list once it is overdue or due today.
    if (!reason || (task.priority === 'low' && rank > 2)) continue;
    picked.push({ item, reason, rank });
  }
  // Stable sort keeps due order inside each rank.
  return picked.sort((left, right) => left.rank - right.rank).slice(0, DO_NOW_MAX).map(({ item, reason }) => ({ item, reason }));
}

export type AssessmentKind = 'test' | 'quiz';
export type AssessmentItem = { item: TaskItem; when: string; kind: AssessmentKind };

/** Open tasks due in the next ASSESSMENT_DAYS, soonest first: what the AI is asked to check. */
export function assessmentCandidates(items: TaskItem[], today: string): TaskItem[] {
  return sortByDue(items.filter((entry) => !entry.task.completed && entry.task.dueDate))
    .filter((entry) => { const days = daysBetween(today, entry.task.dueDate!); return days >= 0 && days <= ASSESSMENT_DAYS; });
}

/**
 * The candidates the AI called a test or quiz. `kindOf` returns undefined for a task it hasn't checked; when the AI
 * can't be reached the view passes `keywordKind`, which matches assessment words in the title instead.
 */
export function upcomingAssessments(items: TaskItem[], { today }: Pick<FocusContext, 'today'>, kindOf: (item: TaskItem) => AssessmentKind | 'none' | undefined): AssessmentItem[] {
  return assessmentCandidates(items, today).flatMap((item) => {
    const kind = kindOf(item);
    if (kind !== 'test' && kind !== 'quiz') return [];
    const days = daysBetween(today, item.task.dueDate!);
    return [{ item, kind, when: days === 0 ? 'Today' : days === 1 ? 'Tomorrow' : `In ${days} days` }];
  }).slice(0, ASSESSMENTS_MAX);
}

export const keywordKind = (item: TaskItem): AssessmentKind | 'none' => !isAssessment(item.task.title) ? 'none' : /\b(quiz(?:zes)?|pruebas?|interro)\b/i.test(item.task.title) ? 'quiz' : 'test';
