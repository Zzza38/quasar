import { describe, expect, it } from 'vitest';
import { classGrade, type ClassGrades, type GradeItem } from './grade-math';
import { anchor, categoryLines, defaultGoal, defaultPlan, displayNeeded, formatPercent, goalLabel, goalPercent, gradeCounts, gradeGoalSchema, letterFor, openWork, outlook, parseGoalPercent, planTargetSchema, resolvePlan, rulerPosition, rulerWindow } from './grade-goals';

const item = (id: string, categoryId: string, earned: number | null, max: number, due: string, extra: Partial<GradeItem> = {}): GradeItem =>
  ({ id, title: `Item ${id}`, categoryId, earned, max, exception: null, pending: false, due, ...extra });
/** Tests 50%, labs 30%, homework 20%; Schoology reports the grade rounded to two decimals, as it does. */
const biology = (): ClassGrades => ({
  sectionId: '11', title: 'AP Biology', termWeight: 100, termReported: 92.79, reported: 92.79, exams: [],
  categories: [{ id: '1', title: 'Tests', weight: 50, dropLowest: 0, reported: 91.33 }, { id: '2', title: 'Labs', weight: 30, dropLowest: 0, reported: 93.75 },
    { id: '3', title: 'Homework', weight: 20, dropLowest: 0, reported: 95 }, { id: '4', title: 'Practice', weight: 0, dropLowest: 0, reported: null }],
  items: [
    item('101', '1', 92, 100, '2026-09-19'), item('102', '1', 88, 100, '2026-10-10'), item('103', '1', 94, 100, '2026-10-31'), item('104', '1', null, 100, '2026-11-14'),
    item('201', '2', 38, 40, '2026-09-26'), item('202', '2', 37, 40, '2026-10-17'), item('203', '2', null, 40, '2026-11-12'),
    item('301', '3', 57, 60, '2026-10-20'), item('302', '3', null, 10, '2026-11-10'),
    item('401', '4', null, 10, '2026-11-11'),
  ],
});

describe('a custom percentage goal', () => {
  it('reads decimals from 0 to 100 and nothing else', () => {
    expect(parseGoalPercent('94.5')).toBe(94.5);
    expect(parseGoalPercent(' 0 ')).toBe(0);
    expect(parseGoalPercent('100')).toBe(100);
    expect(parseGoalPercent('100.0')).toBe(100);
    expect(parseGoalPercent('.5')).toBe(0.5);
    expect(parseGoalPercent('89.995')).toBe(90);
    expect(parseGoalPercent('92.345')).toBe(92.35);
    for (const bad of ['', ' ', '100.01', '101', '-1', '9e1', 'abc', '94,5', '1000', '94.5%', 'NaN', 'Infinity']) expect(parseGoalPercent(bad), bad).toBeNull();
  });
  it('validates what is saved: a known letter, or a percent kept to two decimals', () => {
    expect(gradeGoalSchema.parse({ kind: 'percent', percent: 94.5 })).toEqual({ kind: 'percent', percent: 94.5 });
    expect(gradeGoalSchema.parse({ kind: 'percent', percent: 87.126 })).toEqual({ kind: 'percent', percent: 87.13 });
    expect(gradeGoalSchema.parse({ kind: 'percent', percent: 0 })).toEqual({ kind: 'percent', percent: 0 });
    expect(gradeGoalSchema.parse({ kind: 'letter', letter: 'A-' })).toEqual({ kind: 'letter', letter: 'A-' });
    for (const bad of [{ kind: 'percent', percent: 100.01 }, { kind: 'percent', percent: -0.1 }, { kind: 'percent', percent: Number.NaN }, { kind: 'percent', percent: Infinity },
      { kind: 'percent', percent: '94.5' }, { kind: 'letter', letter: 'A+' }, { kind: 'letter', letter: '' }, { kind: 'gpa', value: 4 }, { kind: 'percent' }]) {
      expect(gradeGoalSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
    expect(planTargetSchema.safeParse({ kind: 'item', id: '104' }).success).toBe(true);
    expect(planTargetSchema.safeParse({ kind: 'item', id: '104; DROP' }).success).toBe(false);
    expect(planTargetSchema.safeParse({ kind: 'newExam', weight: 0 }).success).toBe(false);
    expect(planTargetSchema.safeParse({ kind: 'newExam', weight: 101 }).success).toBe(false);
  });
  it('is one number everywhere it is used', () => {
    expect(goalPercent({ kind: 'percent', percent: 94.5 })).toBe(94.5);
    expect(goalPercent({ kind: 'letter', letter: 'A' })).toBe(93);
    expect(goalPercent({ kind: 'letter', letter: 'B+' })).toBe(87);
    expect(goalLabel({ kind: 'percent', percent: 94.5 })).toBe('94.5%');
    expect(goalLabel({ kind: 'percent', percent: 90 })).toBe('90%');
    expect(goalLabel({ kind: 'letter', letter: 'A-' })).toBe('A-');
  });
});

describe('letters and formatting', () => {
  it('names letters by the common cutoffs and none below the lowest', () => {
    expect(letterFor(93)).toBe('A');
    expect(letterFor(92.99)).toBe('A-');
    expect(letterFor(86.1)).toBe('B');
    expect(letterFor(65)).toBe('D');
    expect(letterFor(64.9)).toBeNull();
    expect(letterFor(null)).toBeNull();
    expect(letterFor(104)).toBe('A');
  });
  it('starts a member without a saved goal at the letter they already have', () => {
    expect(defaultGoal(92.79)).toEqual({ kind: 'letter', letter: 'A-' });
    expect(defaultGoal(96)).toEqual({ kind: 'letter', letter: 'A' });
    expect(defaultGoal(41)).toEqual({ kind: 'letter', letter: 'D' });
  });
  it('shows one decimal, or two when the grade has them', () => {
    expect(formatPercent(96)).toBe('96.0%');
    expect(formatPercent(92.8)).toBe('92.8%');
    expect(formatPercent(92.75)).toBe('92.75%');
    expect(formatPercent(92.999)).toBe('93.0%');
    expect(formatPercent(null)).toBe('—');
  });
});

describe('planning toward a goal', () => {
  it('anchors "now" to exactly what Schoology reports', () => {
    const cls = biology();
    expect(classGrade(cls, anchor(cls))).toBeCloseTo(92.79, 10);
    // A teacher setting the API doesn't show: the model lands elsewhere, and the class is marked an estimate.
    const odd = { ...biology(), reported: 90.2, termReported: 90.2 };
    const calibration = anchor(odd);
    expect(classGrade(odd, calibration)).toBeCloseTo(90.2, 10);
    expect(calibration.approximate).toBe(true);
    expect(anchor(cls).approximate).toBe(false);
    // No grade from Schoology: nothing to anchor to.
    expect(anchor({ ...cls, reported: null }).courseOffset).toBe(0);
  });
  it('lists ungraded work that can move the grade, soonest first, and counts the rest', () => {
    const cls = biology(), calibration = anchor(cls);
    const { open, uncounted } = openWork(cls, calibration);
    expect(open.map(entry => entry.id)).toEqual(['302', '203', '104']);
    expect(uncounted).toBe(1);
    expect(gradeCounts(cls, open)).toEqual({ graded: 6, missing: 0, open: 3 });
    const withMissing = { ...cls, items: [...cls.items, item('303', '3', null, 10, '2026-10-27', { exception: 'missing' }), item('304', '3', null, 10, '2026-10-28', { exception: 'excused' }), item('305', '3', 8, 10, '2026-10-29', { pending: true })] };
    expect(gradeCounts(withMissing, open)).toEqual({ graded: 6, missing: 1, open: 3 });
    expect(openWork(withMissing, anchor(withMissing)).open.map(entry => entry.id)).toEqual(['302', '203', '104']);
  });
  it('leans on the work that moves the grade most unless the member picked something that still applies', () => {
    const cls = biology(), calibration = anchor(cls), { open } = openWork(cls, calibration);
    expect(defaultPlan(cls, calibration, open)).toEqual({ kind: 'item', id: '104' });
    expect(resolvePlan(cls, calibration, open, { kind: 'item', id: '302' })).toEqual({ kind: 'item', id: '302' });
    // Graded since, or no longer in the class: back to the default.
    expect(resolvePlan(cls, calibration, open, { kind: 'item', id: '101' })).toEqual({ kind: 'item', id: '104' });
    expect(resolvePlan(cls, calibration, open, { kind: 'item', id: '999' })).toEqual({ kind: 'item', id: '104' });
    expect(resolvePlan(cls, calibration, open, { kind: 'extra', categoryId: '1', max: 50 })).toEqual({ kind: 'extra', categoryId: '1', max: 50 });
    expect(resolvePlan(cls, calibration, open, { kind: 'extra', categoryId: '77', max: 50 })).toEqual({ kind: 'item', id: '104' });
    expect(resolvePlan(cls, calibration, open, { kind: 'newExam', weight: 20 })).toEqual({ kind: 'newExam', weight: 20 });
    expect(resolvePlan(cls, calibration, [], null)).toBeNull();
  });
  it('says what the next test needs for a letter goal', () => {
    const cls = biology(), calibration = anchor(cls);
    const view = outlook(cls, calibration, 93, { kind: 'item', id: '104' });
    expect(view).toMatchObject({ kind: 'need', above: false, trying: false, result: { status: 'reachable', max: 100 } });
    if (view?.kind !== 'need' || view.result.status !== 'reachable') throw new Error('expected a reachable need');
    // The needed score really reaches the goal, and one point less does not.
    const needed = displayNeeded(view.result.needed, 100);
    expect(classGrade(cls, calibration, { scores: { '104': needed } })!).toBeGreaterThanOrEqual(93 - 1e-9);
    expect(classGrade(cls, calibration, { scores: { '104': needed - 1 } })!).toBeLessThan(93);
    expect(outlook(cls, calibration, 90, { kind: 'item', id: '104' })).toMatchObject({ kind: 'need', above: true, result: { status: 'reachable' } });
    expect(outlook(cls, calibration, 65, { kind: 'item', id: '302' })).toMatchObject({ kind: 'need', result: { status: 'locked' } });
    expect(outlook(cls, calibration, 93, { kind: 'item', id: '401' })).toMatchObject({ kind: 'need', result: { status: 'no-effect' } });
  });
  it('uses a custom 94.5 goal for the needed score and the what-ifs alike', () => {
    const cls = biology(), calibration = anchor(cls);
    // Out of reach on homework alone, reachable on the test.
    const homework = outlook(cls, calibration, 94.5, { kind: 'item', id: '302' });
    expect(homework).toMatchObject({ kind: 'need', result: { status: 'out-of-reach' } });
    if (homework?.kind === 'need' && homework.result.status === 'out-of-reach') expect(homework.result.best).toBeCloseTo(classGrade(cls, calibration, { scores: { '302': 10 } })!, 10);
    const perfect = { scores: { '302': 10, '203': 40 } };
    const afterOthers = outlook(cls, calibration, 94.5, { kind: 'item', id: '104' }, perfect);
    expect(afterOthers).toMatchObject({ kind: 'need', trying: true, result: { status: 'reachable' } });
    if (afterOthers?.kind !== 'need' || afterOthers.result.status !== 'reachable') throw new Error('expected a reachable need');
    const needed = afterOthers.result.needed;
    expect(classGrade(cls, calibration, { scores: { ...perfect.scores, '104': needed } })!).toBeGreaterThanOrEqual(94.5 - 1e-6);
    expect(classGrade(cls, calibration, { scores: { ...perfect.scores, '104': needed - 0.5 } })!).toBeLessThan(94.5);
    // Typing a score on the plan's own assignment answers with where that finishes, against the same 94.5.
    const typed = { scores: { ...perfect.scores, '104': Math.ceil(needed) } };
    expect(outlook(cls, calibration, 94.5, { kind: 'item', id: '104' }, typed)).toMatchObject({ kind: 'projected', met: true });
    expect(outlook(cls, calibration, 94.5, { kind: 'item', id: '104' }, { scores: { '104': 50 } })).toMatchObject({ kind: 'projected', met: false });
    // A hair under the goal is not met: 94.49 against 94.5.
    const short = outlook({ ...cls, reported: 94.49, termReported: 94.49 }, anchor({ ...cls, reported: 94.49, termReported: 94.49 }), 94.5, null);
    expect(short).toMatchObject({ kind: 'no-plan', met: false });
    expect(short?.kind === 'no-plan' && short.away).toBeCloseTo(0.01, 6);
  });
  it('plans around a made-up assignment or a final when asked, and says nothing without a grade', () => {
    const cls = biology(), calibration = anchor(cls);
    expect(outlook(cls, calibration, 93, { kind: 'extra', categoryId: '1', max: 100 })).toMatchObject({ kind: 'need', result: { status: 'reachable', max: 100 } });
    expect(outlook(cls, calibration, 93, { kind: 'newExam', weight: 20 })).toMatchObject({ kind: 'need', result: { status: 'reachable', max: 100 } });
    expect(outlook(cls, calibration, 93, null)).toMatchObject({ kind: 'no-plan', met: false });
    const empty: ClassGrades = { ...cls, items: [], reported: null, termReported: null, categories: [] };
    expect(outlook(empty, anchor(empty), 93, null)).toBeNull();
  });
  it('rounds the needed score up to a whole point when the assignment allows it', () => {
    expect(displayNeeded(92.34, 100)).toBe(93);
    expect(displayNeeded(93, 100)).toBe(93);
    expect(displayNeeded(9.2, 10)).toBe(10);
    expect(displayNeeded(9.2, 9.5)).toBe(9.2);
  });
  it('shows what-if category grades only where a typed score changes them', () => {
    const cls = biology(), calibration = anchor(cls);
    expect(categoryLines(cls, calibration, {}).map(line => [line.title, line.now, line.whatIf])).toEqual([['Tests', 91.33, null], ['Labs', 93.75, null], ['Homework', 95, null], ['Practice', null, null]]);
    const lines = categoryLines(cls, calibration, { scores: { '104': 97 } });
    expect(lines[0].whatIf).toBeCloseTo(92.75, 1);
    expect(lines[1].whatIf).toBeNull();
  });
});

describe('the goal ruler', () => {
  it('keeps the usual 76 to 100 view with every cutoff from B- to A', () => {
    const { lo, hi, ticks } = rulerWindow([92.79, 93, null]);
    expect([lo, hi]).toEqual([76, 100]);
    expect(ticks).toEqual([{ letter: 'B-', percent: 80 }, { letter: 'B', percent: 83 }, { letter: 'B+', percent: 87 }, { letter: 'A-', percent: 90 }, { letter: 'A', percent: 93 }]);
    expect(rulerPosition(76, lo, hi)).toBe(0);
    expect(rulerPosition(88, lo, hi)).toBe(50);
    expect(rulerPosition(120, lo, hi)).toBe(100);
  });
  it('widens for low grades, low goals and extra credit so no marker falls off', () => {
    const low = rulerWindow([58.4, 70, null]);
    expect(low.lo).toBeLessThanOrEqual(55);
    expect(low.ticks.map(tick => tick.letter)).toEqual(['D', 'C', 'B', 'A']);
    expect(rulerWindow([92, 0, null]).lo).toBe(0);
    const high = rulerWindow([103.5, 93, null]);
    expect(high.hi).toBe(104);
    for (const window of [low, high]) for (const value of [58.4, 70, 103.5, 93]) {
      const at = rulerPosition(value, window.lo, window.hi);
      expect(at).toBeGreaterThanOrEqual(0); expect(at).toBeLessThanOrEqual(100);
    }
  });
});
