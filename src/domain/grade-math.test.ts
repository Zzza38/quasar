import { describe, expect, it } from 'vitest';
import { calibrate, classGrade, classGradesFromSchoology, scoreNeeded, type ClassGrades, type GradeItem } from './grade-math';

let next = 0;
const item = (categoryId: string, earned: number | null, max: number, extra: Partial<GradeItem> = {}): GradeItem =>
  ({ id: `i${++next}`, title: 'Assignment', categoryId, earned, max, exception: null, pending: false, due: null, ...extra });
const cls = (parts: Partial<ClassGrades>): ClassGrades =>
  ({ sectionId: '1', title: 'Class', categories: [], items: [], termWeight: 100, termReported: null, exams: [], reported: null, ...parts });
const category = (id: string, weight: number, reported: number | null = null, dropLowest = 0) => ({ id, title: id, weight, dropLowest, reported });
const grade = (c: ClassGrades, scenario = {}) => classGrade(c, calibrate(c), scenario);

describe('class grade', () => {
  it('weights categories and skips ones with nothing graded', () => {
    const c = cls({ categories: [category('hw', 20), category('test', 80), category('project', 50)],
      items: [item('hw', 9, 10), item('hw', 10, 10), item('test', 40, 50), item('project', null, 100)] });
    // hw 95%, test 80%; project has no grade so its weight drops out.
    expect(grade(c)).toBeCloseTo((20 * 95 + 80 * 80) / 100, 6);
  });

  it('uses total points when no category has a weight', () => {
    const c = cls({ categories: [category('a', 0), category('b', 0)], items: [item('a', 45, 50), item('b', 5, 50), item('c', 10, 10)] });
    expect(grade(c)).toBeCloseTo(100 * 60 / 110, 6);
  });

  it('leaves out excused, ungraded and pending work and counts missing and incomplete as zero', () => {
    const base = [item('hw', 8, 10)];
    const with_ = (extra: GradeItem) => grade(cls({ categories: [category('hw', 100)], items: [...base, extra] }));
    expect(with_(item('hw', null, 10, { exception: 'excused' }))).toBeCloseTo(80, 6);
    expect(with_(item('hw', 2, 10, { exception: 'excused' }))).toBeCloseTo(80, 6);
    expect(with_(item('hw', null, 10))).toBeCloseTo(80, 6);
    expect(with_(item('hw', 10, 10, { pending: true }))).toBeCloseTo(80, 6);
    expect(with_(item('hw', null, 10, { exception: 'missing' }))).toBeCloseTo(40, 6);
    expect(with_(item('hw', 7, 10, { exception: 'incomplete' }))).toBeCloseTo(40, 6);
  });

  it('drops the lowest scores a category drops, but never its only one', () => {
    const c = cls({ categories: [category('quiz', 100, null, 1)], items: [item('quiz', 2, 10), item('quiz', 9, 10), item('quiz', 7, 10)] });
    expect(grade(c)).toBeCloseTo(80, 6);
    expect(grade(cls({ categories: [category('quiz', 100, null, 1)], items: [item('quiz', 2, 10)] }))).toBeCloseTo(20, 6);
  });

  it('reproduces a real gradebook that averages percents in one category and totals points in another', () => {
    // Shaped on a real Spanish class: Exam is total points, IPA is the average of its two percents.
    const full = (n: number, max: number) => Array.from({ length: n }, () => item('classwork', max, max));
    const c = cls({
      categories: [category('classwork', 20, 100), category('exam', 45, 80.67), category('hw', 20, 100), category('ipa', 15, 83.21)],
      items: [...full(5, 25), item('classwork', null, 75), item('ipa', 71.25, 75), item('ipa', 35.71, 50), item('ipa', null, 50),
        item('exam', 47, 50), item('exam', 32, 50), item('exam', 42, 50), item('exam', null, 100), item('hw', 50, 50), item('hw', 5, 5)],
      reported: 88.78,
    });
    const calibration = calibrate(c);
    expect(calibration.approximate).toBe(false);
    expect(calibration.modes.ipa).toBe('average');
    expect(classGrade(c, calibration)).toBeCloseTo(88.78, 1);
  });

  it('anchors to Schoology when its number can’t be reproduced, and still moves with what-ifs', () => {
    const open = item('hw', null, 10);
    const c = cls({ categories: [category('hw', 100, 96.92)], items: [item('hw', 10, 10), item('hw', 9, 10), item('hw', 5, 5), open], reported: 96.92 });
    const calibration = calibrate(c);
    expect(calibration.approximate).toBe(true);
    expect(classGrade(c, calibration)).toBeCloseTo(96.92, 6);
    expect(classGrade(c, calibration, { scores: { [open.id]: 0 } })!).toBeLessThan(96.92);
  });

  it('weights final exams beside the term and ignores ones not taken yet', () => {
    const c = cls({ categories: [category('all', 0)], items: [item('all', 64, 100)], termWeight: 80,
      exams: [{ id: 'e1', title: 'Midterm', weight: 10, max: 100, earned: 90 }, { id: 'e2', title: 'Final', weight: 10, max: 100, earned: null }] });
    expect(grade(c)).toBeCloseTo((80 * 64 + 10 * 90) / 90, 6);
    expect(grade(c, { scores: { e2: 50 } })).toBeCloseTo((80 * 64 + 10 * 90 + 10 * 50) / 100, 6);
  });

  it('updates live as made-up scores and new assignments are added', () => {
    const open = item('test', null, 50);
    const c = cls({ categories: [category('hw', 20), category('test', 80)], items: [item('hw', 10, 10), item('test', 40, 50), open] });
    expect(grade(c, { scores: { [open.id]: 50 } })).toBeCloseTo(20 + 80 * 0.9, 6);
    expect(grade(c, { extras: [{ id: 'x', categoryId: 'hw', max: 10, earned: 0 }] })).toBeCloseTo(20 * 0.5 + 80 * 0.8, 6);
  });
});

describe('score needed', () => {
  const open = item('test', null, 100);
  const c = cls({ categories: [category('hw', 20), category('test', 80), category('bonus', 0)], items: [item('hw', 10, 10), item('test', 70, 100), open] });
  const calibration = calibrate(c);

  it('finds the lowest score that reaches the goal', () => {
    const result = scoreNeeded(c, calibration, {}, { kind: 'item', id: open.id }, 83);
    expect(result.status).toBe('reachable');
    if (result.status !== 'reachable') return;
    // 20 + 80 * (70 + x) / 200 >= 83  →  x >= 87.5
    expect(result.needed).toBeCloseTo(87.5, 2);
    expect(classGrade(c, calibration, { scores: { [open.id]: result.needed } })!).toBeGreaterThanOrEqual(83 - 1e-9);
    expect(classGrade(c, calibration, { scores: { [open.id]: result.needed - 0.02 } })!).toBeLessThan(83);
  });

  it('says when the goal is already locked in, out of reach, or not affected', () => {
    // A zero on it still leaves 20 + 80 * 70 / 200 = 48%.
    expect(scoreNeeded(c, calibration, {}, { kind: 'item', id: open.id }, 45)).toMatchObject({ status: 'locked', worst: 48 });
    const out = scoreNeeded(c, calibration, {}, { kind: 'item', id: open.id }, 99);
    expect(out).toMatchObject({ status: 'out-of-reach' });
    if (out.status === 'out-of-reach') expect(out.best).toBeCloseTo(20 + 80 * 0.85, 6);
    expect(scoreNeeded(c, calibration, {}, { kind: 'extra', categoryId: 'bonus', max: 10 }, 90)).toMatchObject({ status: 'no-effect' });
  });

  it('solves for a new assignment, and for a final described only by its weight', () => {
    const extra = scoreNeeded(c, calibration, {}, { kind: 'extra', categoryId: 'test', max: 100 }, 80);
    expect(extra.status).toBe('reachable');
    // Now 76%. With a 20% final: 0.8 * 76 + 0.2 * x >= 80  →  x >= 96.
    const final = scoreNeeded(c, calibration, {}, { kind: 'newExam', weight: 20 }, 80);
    expect(final).toMatchObject({ status: 'reachable', max: 100 });
    if (final.status === 'reachable') expect(final.needed).toBeCloseTo(96, 2);
  });

  it('copes with a dropped lowest score, where the needed score can be dropped', () => {
    const quiz = item('quiz', null, 10);
    const d = cls({ categories: [category('quiz', 100, null, 1)], items: [item('quiz', 6, 10), item('quiz', 8, 10), quiz] });
    const result = scoreNeeded(d, calibrate(d), {}, { kind: 'item', id: quiz.id }, 85);
    // Dropping the 6: (8 + x) / 20 >= 0.85  →  x >= 9.
    expect(result).toMatchObject({ status: 'reachable' });
    if (result.status === 'reachable') expect(result.needed).toBeCloseTo(9, 2);
  });
});

describe('reading Schoology', () => {
  it('builds a class from users/{uid}/grades with its exams', () => {
    const raw = {
      section_id: 77,
      period: [{ period_id: 'p1', assignment: [
        { assignment_id: 1, grade: 9, max_points: 10, exception: 0, pending: null, category_id: 5 },
        { assignment_id: 2, grade: null, max_points: 20, exception: 3, pending: null, category_id: 5 },
        { assignment_id: 3, grade: null, max_points: 20, exception: 0, pending: 1, category_id: 6 },
        { assignment_id: 900, grade: null, max_points: 100, exception: 0, pending: null, category_id: 0 },
      ] }],
      final_grade: [
        { period_id: 'p1', grade: 30, weight: 80, grading_category: [{ category_id: 5, grade: 30 }, { category_id: 6, grade: null }] },
        { period_id: 'a900', grade: null, weight: 20 },
        { period_id: 'final', grade: 30 },
      ],
      grading_category: [{ id: 5, title: 'Homework', weight: 0 }, { id: 6, title: 'Tests', weight: 0 }],
    };
    const c = classGradesFromSchoology(raw, [{ id: 1, title: 'Lab', due: '2026-11-02 23:59:00' }, { id: 900, title: 'Final exam' }], 'Chemistry');
    expect(c).toMatchObject({ sectionId: '77', title: 'Chemistry', termWeight: 80, termReported: 30, reported: 30 });
    expect(c.items.map(entry => [entry.id, entry.title, entry.exception, entry.pending, entry.due])).toEqual([
      ['1', 'Lab', null, false, '2026-11-02'], ['2', 'Assignment', 'missing', false, null], ['3', 'Assignment', null, true, null]]);
    expect(c.exams).toEqual([{ id: '900', title: 'Final exam', weight: 20, max: 100, earned: null }]);
    expect(c.categories.map(entry => [entry.title, entry.reported])).toEqual([['Homework', 30], ['Tests', null]]);
    expect(grade(c)).toBeCloseTo(30, 6);
    const need = scoreNeeded(c, calibrate(c), {}, { kind: 'item', id: '900' }, 40);
    expect(need).toMatchObject({ status: 'reachable' });
    if (need.status === 'reachable') expect(need.needed).toBeCloseTo(80, 2);
  });
});
