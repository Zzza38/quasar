import { z } from 'zod';
import { LETTER_CUTOFFS, affectsGrade, calibrate, categoryGrades, classGrade, scoreNeeded, type Calibration, type ClassGrades, type NeedResult, type NeedTarget, type Scenario } from './grade-math';

/**
 * Grade goals for Classes → Grades (schoology-connect beta): the goal a member saves per Schoology class, the
 * assignment their plan leans on, and the numbers the goal ruler and the "what you need" line show. Pure; the math
 * itself is src/domain/grade-math.ts, and src/server/schoology.ts stores the goals.
 *
 * A goal is a letter (its percent comes from LETTER_CUTOFFS, common US cutoffs a school may not share) or a custom
 * percent from 0 to 100 with up to two decimals. Everything downstream works from `goalPercent`, so the ruler, the
 * needed score and the what-ifs can never disagree about what the goal is.
 */

const LETTERS = LETTER_CUTOFFS.map(entry => entry.letter) as [string, ...string[]];
const round2 = (value: number) => Math.round(value * 100) / 100;

export const gradeGoalSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('letter'), letter: z.enum(LETTERS) }),
  z.object({ kind: z.literal('percent'), percent: z.number().min(0, 'Type a goal from 0 to 100.').max(100, 'Type a goal from 0 to 100.').transform(round2) }),
]);
export type GradeGoal = z.infer<typeof gradeGoalSchema>;

const id = z.string().regex(/^\d{1,20}$/);
/** What the plan leans on: an ungraded assignment or exam, a new assignment in a category, or a final by weight. */
export const planTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('item'), id }),
  z.object({ kind: z.literal('extra'), categoryId: id, max: z.number().positive().max(100_000).transform(round2) }),
  z.object({ kind: z.literal('newExam'), weight: z.number().positive().max(100).transform(round2) }),
]);
export type PlanTarget = z.infer<typeof planTargetSchema>;
export type SavedGoal = { goal: GradeGoal | null; plan: PlanTarget | null };

/** Reads what a member typed as a custom goal: a number from 0 to 100, decimals allowed. Null for anything else. */
export function parseGoalPercent(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d{1,3}(\.\d*)?$|^\.\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isFinite(value) && value >= 0 && value <= 100 ? round2(value) : null;
}

export const goalPercent = (goal: GradeGoal): number =>
  goal.kind === 'percent' ? goal.percent : LETTER_CUTOFFS.find(entry => entry.letter === goal.letter)!.percent;

/** "94.5%", "96.0%", "92.75%": one decimal at least, two when the number has them. */
export function formatPercent(value: number | null): string {
  if (value === null) return '—';
  const rounded = round2(value);
  return `${Number.isInteger(rounded * 10) ? rounded.toFixed(1) : rounded.toFixed(2)}%`;
}
/** A goal's short name: the letter, or the percent as typed ("94.5%", "90%"). */
export const goalLabel = (goal: GradeGoal): string => goal.kind === 'letter' ? goal.letter : `${goal.percent}%`;

/** The letter for a percent by the common cutoffs, or null below the lowest one (schools disagree down there). */
export const letterFor = (percent: number | null): string | null =>
  percent === null ? null : LETTER_CUTOFFS.find(entry => percent >= entry.percent - 1e-9)?.letter ?? null;

/**
 * The goal shown before a member picks one: keep the letter they have now (the lowest letter when they are under
 * every cutoff). It is a starting point, never saved until they choose it.
 */
export function defaultGoal(now: number): GradeGoal {
  return { kind: 'letter', letter: letterFor(now) ?? LETTER_CUTOFFS.at(-1)!.letter };
}

/**
 * The class's calibration with the course anchored to the exact grade Schoology reports. `calibrate` allows a
 * rounding-sized gap between its model and Schoology's number; closing it means "Now" is Schoology's grade
 * everywhere, and a what-if with nothing typed changes nothing.
 */
export function anchor(cls: ClassGrades): Calibration {
  const calibration = calibrate(cls);
  const modeled = classGrade(cls, calibration);
  if (cls.reported === null || modeled === null) return calibration;
  return { ...calibration, courseOffset: calibration.courseOffset + (cls.reported - modeled) };
}

export type OpenWork = { id: string; title: string; due: string | null; max: number; categoryId: string | null; examWeight: number | null };

/**
 * Ungraded work that can still move the course grade, soonest due first (undated last), and how many ungraded
 * items can't (an unweighted category, or worth no points).
 */
export function openWork(cls: ClassGrades, calibration: Calibration): { open: OpenWork[]; uncounted: number } {
  const items = cls.items.filter(item => item.earned === null && item.exception === null && !item.pending);
  const all: OpenWork[] = [
    ...items.map(item => ({ id: item.id, title: item.title, due: item.due, max: item.max, categoryId: item.categoryId, examWeight: null })),
    ...cls.exams.filter(exam => exam.earned === null).map(exam => ({ id: exam.id, title: exam.title, due: null, max: exam.max, categoryId: null, examWeight: exam.weight })),
  ];
  const open = all.filter(entry => affectsGrade(cls, calibration, entry.id))
    .sort((a, b) => (a.due ?? '9999').localeCompare(b.due ?? '9999'));
  return { open, uncounted: all.length - open.length };
}

/** The ungraded item a perfect score helps most, so the first plan a member sees is about the work that matters. */
export function defaultPlan(cls: ClassGrades, calibration: Calibration, open: OpenWork[]): PlanTarget | null {
  let best: { id: string; swing: number } | null = null;
  for (const entry of open) {
    const low = classGrade(cls, calibration, { scores: { [entry.id]: 0 } }), high = classGrade(cls, calibration, { scores: { [entry.id]: entry.max } });
    const swing = low === null || high === null ? 0 : high - low;
    if (!best || swing > best.swing + 1e-9) best = { id: entry.id, swing };
  }
  return best ? { kind: 'item', id: best.id } : null;
}

/** The saved plan when it still applies to the gradebook (the assignment got graded, the category went away), else the default. */
export function resolvePlan(cls: ClassGrades, calibration: Calibration, open: OpenWork[], saved: PlanTarget | null): PlanTarget | null {
  if (saved?.kind === 'item' && open.some(entry => entry.id === saved.id)) return saved;
  if (saved?.kind === 'extra' && planCategories(cls).some(category => category.id === saved.categoryId)) return saved;
  if (saved?.kind === 'newExam' && cls.exams.length === 0) return saved;
  return defaultPlan(cls, calibration, open);
}

/** Categories a made-up assignment can go in: the listed ones, weighted first. */
export function planCategories(cls: ClassGrades): { id: string; title: string; weight: number }[] {
  return [...cls.categories].sort((a, b) => Number(b.weight > 0) - Number(a.weight > 0)).map(({ id: categoryId, title, weight }) => ({ id: categoryId, title, weight }));
}

export type Outlook =
  /** The plan's own assignment has a what-if score typed: where those scores finish, against the goal. */
  | { kind: 'projected'; projected: number; met: boolean }
  /** What the plan's assignment needs, with any other what-if scores counted. */
  | { kind: 'need'; result: NeedResult; above: boolean; trying: boolean }
  /** Nothing to plan around. */
  | { kind: 'no-plan'; met: boolean; away: number };

/**
 * The "what you need" line for one class. `scenario` holds the what-if scores typed so far; the plan target's own
 * typed score (if any) is answered with where the member would finish instead of being solved for.
 */
export function outlook(cls: ClassGrades, calibration: Calibration, goal: number, target: PlanTarget | null, scenario: Scenario = {}): Outlook | null {
  const now = classGrade(cls, calibration);
  if (now === null) return null;
  const typed = scenario.scores ?? {};
  const trying = Object.keys(typed).length > 0;
  if (!target) return { kind: 'no-plan', met: now >= goal - 1e-9, away: Math.max(0, goal - now) };
  if (target.kind === 'item' && target.id in typed) {
    const projected = classGrade(cls, calibration, scenario) ?? now;
    return { kind: 'projected', projected, met: projected >= goal - 1e-9 };
  }
  const need: NeedTarget = target.kind === 'item' ? target : target.kind === 'extra' ? { kind: 'extra', categoryId: target.categoryId, max: target.max } : { kind: 'newExam', weight: target.weight };
  return { kind: 'need', result: scoreNeeded(cls, calibration, scenario, need, goal), above: now >= goal - 1e-9, trying };
}

/**
 * The needed score as a student reads it: rounded up to a whole point, since that still reaches the goal, unless
 * that would pass the assignment's maximum (9.2 out of 9.5 stays 9.2).
 */
export function displayNeeded(needed: number, max: number): number {
  const whole = Math.ceil(needed - 1e-9);
  return whole <= max ? whole : needed;
}

export type RulerTick = { letter: string; percent: number };
/** The ruler's range and letter ticks. The default view is 76 to 100; it widens to keep every marker on the track. */
export function rulerWindow(values: (number | null)[]): { lo: number; hi: number; ticks: RulerTick[] } {
  const marks = values.filter((value): value is number => value !== null && Number.isFinite(value));
  const min = Math.min(...marks, 100), max = Math.max(...marks, 0);
  const lo = min >= 79 ? 76 : Math.max(0, Math.floor((min - 3) / 5) * 5);
  const hi = Math.max(100, Math.ceil(max));
  // A cutoff right at either end would have its label hang off the track.
  const inside = LETTER_CUTOFFS.filter(entry => { const at = rulerPosition(entry.percent, lo, hi); return at >= 6 && at <= 96; }).reverse();
  // A wide range has no room for every plus and minus: keep the whole letters.
  const ticks = hi - lo <= 26 ? inside : inside.filter(entry => /^[A-D]$/.test(entry.letter));
  return { lo, hi, ticks };
}
/** Where a percent sits on the ruler, 0 to 100, clamped to the track. */
export const rulerPosition = (value: number, lo: number, hi: number): number => Math.max(0, Math.min(100, (value - lo) / (hi - lo) * 100));

export type CategoryLine = { id: string; title: string; weight: number; now: number | null; whatIf: number | null };
/** Each category's grade as Schoology reports it (or as modeled when it doesn't), and its what-if grade when that differs. */
export function categoryLines(cls: ClassGrades, calibration: Calibration, scenario: Scenario): CategoryLine[] {
  const now = categoryGrades(cls, calibration, {});
  const trying = Object.keys(scenario.scores ?? {}).length > 0;
  const next = trying ? categoryGrades(cls, calibration, scenario) : null;
  return cls.categories.map(category => {
    const current = category.reported ?? now.get(category.id) ?? null, modeledNow = now.get(category.id) ?? null, made = next?.get(category.id) ?? null;
    const changed = made !== null && (modeledNow === null || Math.abs(made - modeledNow) > 0.049);
    return { id: category.id, title: category.title, weight: category.weight, now: current, whatIf: changed ? (current !== null && modeledNow !== null ? current + (made - modeledNow) : made) : null };
  });
}

export type GradeCounts = { graded: number; missing: number; open: number };
export function gradeCounts(cls: ClassGrades, open: OpenWork[]): GradeCounts {
  return {
    graded: cls.items.filter(item => item.earned !== null && !item.pending && item.exception === null).length + cls.exams.filter(exam => exam.earned !== null).length,
    missing: cls.items.filter(item => item.exception === 'missing').length,
    open: open.length,
  };
}
