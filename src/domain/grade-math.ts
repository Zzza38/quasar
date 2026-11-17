/**
 * Grade what-ifs for one class (Quasar AI Plus, schoology-grades beta): the class average with made-up scores, and
 * the score needed on one assignment or exam to reach a target. Pure math; src/server/schoology.ts reads the data.
 *
 * How Schoology grades a class, as read from real gradebooks (2026-11-01):
 * - A term grade is the weighted average of its categories' grades, over the categories that have one. When no
 *   category has a weight, it is total points over all counted assignments instead.
 * - A category's grade is either total points (earned / possible) or the average of each assignment's percent; the
 *   API doesn't say which, so `calibrate` picks whichever reproduces the grade Schoology reports for the category.
 * - Excused assignments don't count; missing and incomplete ones count as zero; ungraded and pending ones don't
 *   count. A category can drop its lowest N scores.
 * - The course grade is the weighted average of the term and any final exams that have a grade.
 * When the model can't reproduce Schoology's number (a teacher setting the API doesn't show), the class is anchored
 * to Schoology's number and only the change a what-if makes is modeled; `approximate` says so.
 */

export type GradeException = 'excused' | 'incomplete' | 'missing' | null;
export type GradeItem = { id: string; title: string; categoryId: string; earned: number | null; max: number; exception: GradeException; pending: boolean; due: string | null };
export type GradeCategory = { id: string; title: string; weight: number; dropLowest: number; reported: number | null };
/** A final exam weighted at course level (Schoology lists it beside the grading period). */
export type ExamPart = { id: string; title: string; weight: number; max: number; earned: number | null };
export type ClassGrades = { sectionId: string; title: string; categories: GradeCategory[]; items: GradeItem[]; termWeight: number; termReported: number | null; exams: ExamPart[]; reported: number | null };

/** Made-up scores: earned points on ungraded items and exams, assignments that don't exist yet, and a final with a typed weight. */
export type Scenario = {
  scores?: Record<string, number>;
  extras?: { id: string; categoryId: string; max: number; earned: number }[];
  newExam?: { weight: number; percent: number } | null;
};

type Mode = 'points' | 'average';
export type Calibration = { modes: Record<string, Mode>; categoryOffset: Record<string, number>; courseOffset: number; approximate: boolean };

const CLOSE = 0.06;
const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** The scores a category counts, as [earned, max] pairs, with what-ifs filled in. */
function counted(cls: ClassGrades, categoryId: string, scenario: Scenario): [number, number][] {
  const pairs: [number, number][] = [];
  for (const item of cls.items) {
    if (item.categoryId !== categoryId || item.exception === 'excused') continue;
    if (item.exception === 'missing' || item.exception === 'incomplete') { pairs.push([0, item.max]); continue; }
    const made = scenario.scores?.[item.id];
    if (isNumber(made) && item.earned === null) pairs.push([made, item.max]);
    else if (item.earned !== null && !item.pending) pairs.push([item.earned, item.max]);
  }
  for (const extra of scenario.extras ?? []) if (extra.categoryId === categoryId) pairs.push([extra.earned, extra.max]);
  return pairs;
}

function categoryGrade(pairs: [number, number][], mode: Mode, dropLowest: number): number | null {
  let kept = pairs;
  if (dropLowest > 0) {
    const scored = pairs.filter(([, max]) => max > 0).sort((a, b) => a[0] / a[1] - b[0] / b[1]);
    const drop = new Set(scored.slice(0, Math.min(dropLowest, Math.max(0, scored.length - 1))));
    kept = pairs.filter(pair => !drop.has(pair));
  }
  if (mode === 'average') {
    const percents = kept.filter(([, max]) => max > 0).map(([earned, max]) => 100 * earned / max);
    return percents.length ? percents.reduce((sum, value) => sum + value, 0) / percents.length : null;
  }
  const max = kept.reduce((sum, [, value]) => sum + value, 0), earned = kept.reduce((sum, [value]) => sum + value, 0);
  return max > 0 ? 100 * earned / max : null;
}

/** The term grade and each category's grade, before any anchoring to Schoology. */
function model(cls: ClassGrades, modes: Record<string, Mode>, scenario: Scenario, offsets: Record<string, number> = {}) {
  const grades = new Map<string, number | null>();
  for (const category of cls.categories) {
    const grade = categoryGrade(counted(cls, category.id, scenario), modes[category.id] ?? 'points', category.dropLowest);
    grades.set(category.id, grade === null ? null : grade + (offsets[category.id] ?? 0));
  }
  const weighted = cls.categories.filter(category => category.weight > 0 && grades.get(category.id) !== null);
  let term: number | null;
  if (cls.categories.some(category => category.weight > 0)) {
    const total = weighted.reduce((sum, category) => sum + category.weight, 0);
    term = total > 0 ? weighted.reduce((sum, category) => sum + category.weight * grades.get(category.id)!, 0) / total : null;
  } else {
    const pairs = cls.categories.flatMap(category => counted(cls, category.id, scenario));
    // Items whose category Schoology doesn't list still count toward plain points.
    const listed = new Set(cls.categories.map(category => category.id));
    for (const id of new Set(cls.items.map(item => item.categoryId).filter(id => !listed.has(id)))) pairs.push(...counted(cls, id, scenario));
    const max = pairs.reduce((sum, [, value]) => sum + value, 0);
    term = max > 0 ? 100 * pairs.reduce((sum, [value]) => sum + value, 0) / max : null;
  }
  return { term, categories: grades };
}

function course(cls: ClassGrades, term: number | null, scenario: Scenario): number | null {
  const parts: [number, number][] = [];
  if (term !== null) parts.push([cls.termWeight, term]);
  for (const exam of cls.exams) {
    const earned = exam.earned ?? scenario.scores?.[exam.id];
    if (isNumber(earned) && exam.max > 0) parts.push([exam.weight, 100 * earned / exam.max]);
  }
  if (scenario.newExam) {
    // A final the student describes by weight: the rest of the course keeps its proportions.
    const rest = parts.reduce((sum, [weight]) => sum + weight, 0);
    const share = Math.min(Math.max(scenario.newExam.weight, 0), 100) / 100;
    const current = rest > 0 ? parts.reduce((sum, [weight, grade]) => sum + weight * grade, 0) / rest : null;
    return current === null ? scenario.newExam.percent : (1 - share) * current + share * scenario.newExam.percent;
  }
  const total = parts.reduce((sum, [weight]) => sum + weight, 0);
  return total > 0 ? parts.reduce((sum, [weight, grade]) => sum + weight * grade, 0) / total : null;
}

/** Works out each category's method and any anchoring needed so the current grade equals what Schoology reports. */
export function calibrate(cls: ClassGrades): Calibration {
  const modes: Record<string, Mode> = {}, categoryOffset: Record<string, number> = {};
  for (const category of cls.categories) {
    const pairs = counted(cls, category.id, {});
    const byPoints = categoryGrade(pairs, 'points', category.dropLowest), byAverage = categoryGrade(pairs, 'average', category.dropLowest);
    const reported = category.reported;
    if (reported === null || byPoints === null) { modes[category.id] = 'points'; continue; }
    if (Math.abs(byPoints - reported) <= CLOSE) modes[category.id] = 'points';
    else if (byAverage !== null && Math.abs(byAverage - reported) <= CLOSE) modes[category.id] = 'average';
    else { modes[category.id] = 'points'; categoryOffset[category.id] = reported - byPoints; }
  }
  const { term } = model(cls, modes, {}, categoryOffset);
  const computed = course(cls, term, {});
  const target = cls.reported ?? null;
  const courseOffset = target !== null && computed !== null && Math.abs(target - computed) > CLOSE ? target - computed : 0;
  return { modes, categoryOffset, courseOffset, approximate: courseOffset !== 0 || Object.keys(categoryOffset).length > 0 };
}

/** The course grade (percent) with a scenario's made-up scores. */
export function classGrade(cls: ClassGrades, calibration: Calibration, scenario: Scenario = {}): number | null {
  const { term } = model(cls, calibration.modes, scenario, calibration.categoryOffset);
  const grade = course(cls, term, scenario);
  return grade === null ? null : grade + calibration.courseOffset;
}

/** Each category's grade (percent) with a scenario's made-up scores, by category id; null where nothing counts yet. */
export function categoryGrades(cls: ClassGrades, calibration: Calibration, scenario: Scenario = {}): Map<string, number | null> {
  return model(cls, calibration.modes, scenario, calibration.categoryOffset).categories;
}

/** What the student is solving for: an ungraded assignment or exam, a new assignment in a category, or a final by weight. */
export type NeedTarget =
  | { kind: 'item'; id: string }
  | { kind: 'extra'; categoryId: string; max: number }
  | { kind: 'newExam'; weight: number };

export type NeedResult =
  | { status: 'reachable'; needed: number; max: number; percent: number }
  | { status: 'locked'; worst: number }
  | { status: 'out-of-reach'; best: number }
  | { status: 'no-effect'; grade: number | null };

/**
 * The lowest score on `target` that brings the course to `goal` percent, keeping the scenario's other what-ifs.
 * The course grade never goes down as that score goes up, so a bisection finds it even with dropped scores.
 */
export function scoreNeeded(cls: ClassGrades, calibration: Calibration, scenario: Scenario, target: NeedTarget, goal: number): NeedResult {
  const max = target.kind === 'newExam' ? 100 : target.kind === 'extra' ? target.max
    : (cls.items.find(item => item.id === target.id)?.max ?? cls.exams.find(exam => exam.id === target.id)?.max ?? 0);
  const at = (score: number) => {
    if (target.kind === 'item') return classGrade(cls, calibration, { ...scenario, scores: { ...scenario.scores, [target.id]: score } });
    if (target.kind === 'extra') return classGrade(cls, calibration, { ...scenario, extras: [...(scenario.extras ?? []), { id: 'need', categoryId: target.categoryId, max: target.max, earned: score }] });
    return classGrade(cls, calibration, { ...scenario, newExam: { weight: target.weight, percent: score } });
  };
  const low = at(0), high = at(max);
  if (!(max > 0) || low === null || high === null || high - low < 1e-9) return { status: 'no-effect', grade: high ?? low };
  if (low >= goal - 1e-9) return { status: 'locked', worst: low };
  if (high < goal - 1e-9) return { status: 'out-of-reach', best: high };
  let lo = 0, hi = max;
  for (let step = 0; step < 60; step++) { const mid = (lo + hi) / 2; if ((at(mid) ?? 0) >= goal - 1e-9) hi = mid; else lo = mid; }
  const needed = Math.ceil(hi * 100 - 1e-6) / 100;
  return { status: 'reachable', needed, max, percent: 100 * needed / max };
}

/** Whether a score on this item or exam can change the course grade (an unweighted category can't). */
export function affectsGrade(cls: ClassGrades, calibration: Calibration, id: string): boolean {
  const max = cls.items.find(item => item.id === id)?.max ?? cls.exams.find(exam => exam.id === id)?.max ?? 0;
  if (!(max > 0)) return false;
  const low = classGrade(cls, calibration, { scores: { [id]: 0 } }), high = classGrade(cls, calibration, { scores: { [id]: max } });
  return low !== null && high !== null && high - low > 1e-9;
}

/** Common US cutoffs for letter targets. Schools differ, so the student can type a percent instead. */
export const LETTER_CUTOFFS: { letter: string; percent: number }[] = [
  { letter: 'A', percent: 93 }, { letter: 'A-', percent: 90 }, { letter: 'B+', percent: 87 }, { letter: 'B', percent: 83 }, { letter: 'B-', percent: 80 },
  { letter: 'C+', percent: 77 }, { letter: 'C', percent: 73 }, { letter: 'C-', percent: 70 }, { letter: 'D', percent: 65 },
];

const num = (value: unknown): number | null => {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
};
const EXCEPTIONS: Record<string, GradeException> = { '1': 'excused', '2': 'incomplete', '3': 'missing' };

type RawItem = { assignment_id?: unknown; grade?: unknown; max_points?: unknown; exception?: unknown; pending?: unknown; category_id?: unknown };
type RawSectionGrades = {
  section_id?: unknown;
  period?: { period_id?: unknown; assignment?: RawItem[] }[];
  final_grade?: { period_id?: unknown; grade?: unknown; weight?: unknown; grading_category?: { category_id?: unknown; grade?: unknown }[] }[];
  grading_category?: { id?: unknown; title?: unknown; weight?: unknown }[];
};

/**
 * One class from Schoology's users/{uid}/grades section plus its assignment list (titles and due dates, which the
 * grades don't carry). Uses the latest grading period that has category grades; final exams are the final_grade
 * entries named "a<assignment id>".
 */
export function classGradesFromSchoology(raw: RawSectionGrades, assignments: { id?: unknown; title?: unknown; due?: unknown }[], title: string): ClassGrades {
  const info = new Map(assignments.map(entry => [String(entry.id), entry]));
  const finals = raw.final_grade ?? [];
  const term = [...finals].reverse().find(entry => /^p\d+$/.test(String(entry.period_id)) && entry.grading_category) ?? [...finals].reverse().find(entry => /^p\d+$/.test(String(entry.period_id)));
  const reportedCategories = new Map((term?.grading_category ?? []).map(entry => [String(entry.category_id), num(entry.grade)]));
  const allItems = (raw.period ?? []).flatMap(period => (period.assignment ?? []).map(item => ({ period: String(period.period_id), item })));
  const examIds = new Set(finals.map(entry => /^a(\d+)$/.exec(String(entry.period_id))?.[1]).filter((id): id is string => !!id));
  const describe = (id: string) => {
    const entry = info.get(id);
    const due = typeof entry?.due === 'string' ? /^\d{4}-\d{2}-\d{2}/.exec(entry.due)?.[0] ?? null : null;
    return { title: (typeof entry?.title === 'string' && entry.title.trim()) || 'Assignment', due };
  };
  const items: GradeItem[] = allItems
    .filter(({ period, item }) => (!term || period === String(term.period_id)) && !examIds.has(String(item.assignment_id)))
    .map(({ item }) => {
      const id = String(item.assignment_id);
      return { id, ...describe(id), categoryId: String(item.category_id ?? '0'), earned: num(item.grade), max: num(item.max_points) ?? 0,
        exception: EXCEPTIONS[String(item.exception ?? '0')] ?? null, pending: item.pending === true || String(item.pending) === '1' };
    });
  const exams: ExamPart[] = finals.flatMap(entry => {
    const id = /^a(\d+)$/.exec(String(entry.period_id))?.[1];
    if (!id) return [];
    const item = allItems.find(({ item: candidate }) => String(candidate.assignment_id) === id)?.item;
    const max = num(item?.max_points) ?? 100;
    const reported = num(entry.grade);
    return [{ id, title: describe(id).title, weight: num(entry.weight) ?? 0, max, earned: num(item?.grade) ?? (reported === null ? null : reported * max / 100) }];
  });
  const categories: GradeCategory[] = (raw.grading_category ?? []).map(entry => ({
    id: String(entry.id), title: (typeof entry.title === 'string' && entry.title) || 'Category', weight: num(entry.weight) ?? 0, dropLowest: 0,
    reported: reportedCategories.get(String(entry.id)) ?? null,
  }));
  const overall = finals.find(entry => String(entry.period_id) === 'final');
  return {
    sectionId: String(raw.section_id ?? ''), title, categories, items, exams,
    termWeight: num(term?.weight) ?? 100, termReported: num(term?.grade), reported: num(overall?.grade) ?? num(term?.grade),
  };
}
