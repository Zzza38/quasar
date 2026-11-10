import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ClassGrades, GradeItem } from '@/domain/grade-math';
import type { SavedGoal } from '@/domain/grade-goals';
import { GradesBoard, Ruler, goalOptions, gradeClasses } from './grades';
import { selectModel } from './primitives';

const item = (id: string, title: string, categoryId: string, earned: number | null, max: number, due: string, extra: Partial<GradeItem> = {}): GradeItem =>
  ({ id, title, categoryId, earned, max, exception: null, pending: false, due, ...extra });
const biology: ClassGrades = {
  sectionId: '11', title: 'AP Biology: Section 2', termWeight: 100, termReported: 92.79, reported: 92.79, exams: [],
  categories: [{ id: '1', title: 'Tests', weight: 50, dropLowest: 0, reported: 91.33 }, { id: '2', title: 'Labs', weight: 30, dropLowest: 0, reported: 93.75 }, { id: '3', title: 'Homework', weight: 20, dropLowest: 0, reported: 95 }],
  items: [
    item('101', 'Unit 1 Test', '1', 92, 100, '2026-09-19'), item('102', 'Unit 2 Test', '1', 88, 100, '2026-10-10'), item('103', 'Unit 3 Test', '1', 94, 100, '2026-10-31'),
    item('104', 'Unit 4 Test: Cell energy', '1', null, 100, '2026-11-14'),
    item('201', 'Osmosis lab', '2', 38, 40, '2026-09-26'), item('202', 'Photosynthesis lab', '2', 37, 40, '2026-10-17'), item('203', 'Enzyme lab report', '2', null, 40, '2026-11-12'),
    item('301', 'Homework set', '3', 57, 60, '2026-10-20'), item('302', 'HW 7', '3', null, 10, '2026-11-10'),
  ],
};
const precalc: ClassGrades = {
  sectionId: '12', title: 'Precalculus', termWeight: 100, termReported: 80, reported: 80, exams: [],
  categories: [{ id: '1', title: 'Tests', weight: 100, dropLowest: 0, reported: 80 }],
  items: [item('401', 'Test 1', '1', 90, 100, '2026-09-24'), item('402', 'Test 2', '1', 90, 100, '2026-10-22'), item('403', 'Problem set 7', '1', null, 25, '2026-10-27', { exception: 'missing' }), item('404', 'Unit 3 Test', '1', null, 100, '2026-11-20')],
};
const art: ClassGrades = { sectionId: '13', title: 'Studio Art', termWeight: 100, termReported: null, reported: null, exams: [], categories: [{ id: '1', title: 'Portfolio', weight: 100, dropLowest: 0, reported: null }],
  items: [item('501', 'Portfolio check 1', '1', null, 50, '2026-11-16')] };
const book = { name: 'Sam', checkedAt: '2026-11-10T20:42:00.000Z', goals: {}, classes: [
  { detail: biology, grade: '92.8%', graded: 6, classId: 'bio' }, { detail: precalc, grade: '80%', graded: 2, classId: null }, { detail: art, grade: null, graded: 0, classId: null },
] };
const mine = [{ id: 'bio', name: 'AP Biology', room: '214', teacher: 'Ms. Okafor', color: '#16a34a' }];
const noop = () => undefined;
const board = (goals: Record<string, SavedGoal>, selected: string | null, extra: { typed?: Record<string, Record<string, string>>; plusLocked?: boolean } = {}) =>
  renderToStaticMarkup(createElement(GradesBoard, { classes: gradeClasses(book, goals, mine), selected, today: '2026-11-10', mobile: false, online: true, plusLocked: extra.plusLocked ?? false,
    typed: extra.typed ?? {}, goalNote: null, onSelect: noop, onTyped: noop, onClear: noop, onGoal: noop }));
const text = (html: string) => html.replace(/<[^>]+>/g, '');

describe('the goal ruler', () => {
  it('puts percent cutoffs above the line and their letters below it', () => {
    const html = renderToStaticMarkup(createElement(Ruler, { color: '#16a34a', now: 92.79, goal: 93 }));
    expect(html).toContain('aria-label="Now 92.79%, goal 93.0%"');
    const percents = [...html.matchAll(/data-ruler="percent" class="([^"]*)"[^>]*>([^<]+)</g)], letters = [...html.matchAll(/data-ruler="letter" class="([^"]*)"[^>]*>([^<]+)</g)];
    expect(percents.map(match => match[2])).toEqual(['80%', '83%', '87%', '90%', '93%']);
    expect(letters.map(match => match[2])).toEqual(['B-', 'B', 'B+', 'A-', 'A']);
    // The track sits at top-9 (36px): percent labels are pinned to the top edge, letters under the track.
    for (const match of percents) expect(match[1]).toContain('top-0');
    for (const match of letters) expect(match[1]).toContain('top-[52px]');
    expect(html).toContain('top-9 h-2');
    // The goal's own letter is the emphasised one.
    expect(letters.find(match => match[2] === 'A')![1]).toContain('font-extrabold');
    expect(letters.find(match => match[2] === 'A-')![1]).not.toContain('font-extrabold');
  });
  it('adds the what-if marker only when there is one', () => {
    expect(renderToStaticMarkup(createElement(Ruler, { color: '#000', now: 90, goal: 93 }))).not.toContain('border-dashed');
    const html = renderToStaticMarkup(createElement(Ruler, { color: '#000', now: 90, goal: 93, whatIf: 94.2 }));
    expect(html).toContain('what if 94.2%');
    expect(html).toContain('border-dashed');
  });
});

describe('the goal picker on a card', () => {
  it('hands Select real options: every letter with its cutoff, then Custom', () => {
    // Select reads <option> children directly; options wrapped in a component would leave the picker blank.
    const letters = selectModel(goalOptions({ kind: 'letter', letter: 'A' })).items;
    expect(letters.map(item => [item.value, item.label])).toEqual([['A', 'A · 93%'], ['A-', 'A- · 90%'], ['B+', 'B+ · 87%'], ['B', 'B · 83%'], ['B-', 'B- · 80%'],
      ['C+', 'C+ · 77%'], ['C', 'C · 73%'], ['C-', 'C- · 70%'], ['D', 'D · 65%'], ['custom', 'Custom percentage…']]);
    expect(selectModel(goalOptions({ kind: 'percent', percent: 94.5 })).items.at(-1)).toMatchObject({ value: 'custom', label: 'Custom · 94.5%' });
  });
});

describe('the grades overview', () => {
  it('shows each class with Schoology\'s grade, a ruler and the score the next work needs', () => {
    const html = board({ '11': { goal: { kind: 'letter', letter: 'A' }, plan: null } }, null);
    const page = text(html);
    expect(html).toContain('aria-label="Open AP Biology grades"');
    // The member's own class name, room and teacher when the Schoology class matches one.
    expect(page).toContain('Room 214 · Ms. Okafor');
    expect(page).toContain('92.79%');
    expect(page).toMatch(/To reach A, get \d+\/100 or better on Unit 4 Test: Cell energy · due Nov 14/);
    expect(page).toContain('6 graded · 3 coming up');
    expect(html).toContain('aria-label="Goal for AP Biology"');
    // No saved goal: the plan starts from the letter the member has, and missing work is called out.
    expect(page).toMatch(/To stay at B-, get \d+\/100 or better on Unit 3 Test/);
    expect(page).toContain('1 missing · 1 coming up');
    // A class Schoology shows no grade for gets no ruler and no invented number.
    expect(page).toContain('No grade yet');
    expect(page).toContain('Schoology shows no grade here yet. Portfolio check 1 is due Nov 16. You can set a goal once a grade lands.');
    expect(html.match(/role="img"/g)).toHaveLength(2);
    expect(page).toContain('Letters use common cutoffs.');
    // Every control is a shadcn one: no native form elements anywhere on the page.
    expect(html.replace(/<select aria-hidden="true"[^>]*>.*?<\/select>/g, '')).not.toMatch(/<select|<textarea|type="(number|range|checkbox|radio|date)"/);
  });
});

describe('a selected class', () => {
  it('lays out the switcher rail, the gradebook, and the goal with what-ifs', () => {
    const html = board({ '11': { goal: { kind: 'letter', letter: 'A' }, plan: null } }, '11');
    const page = text(html);
    expect(html).toContain('aria-label="Classes with grades"');
    expect(html).toContain('aria-current="true"');
    expect(page).toContain('All classes3 classes');
    expect(page).toContain('A · 0.2 to go');
    // Precalculus has no saved goal, so the rail doesn't claim one is met.
    expect(page).toContain('PrecalculusNo goal set');
    expect(page).not.toContain('at goal');
    expect(page).toContain('Nothing graded yet');
    expect(page).toContain('Ms. Okafor · Room 214 · 6 graded · 3 coming up');
    for (const category of ['Tests50%', 'Labs30%', 'Homework20%']) expect(page).toContain(category);
    expect(page).toContain('91.33%');
    for (const label of ['Score for HW 7', 'Score for Enzyme lab report', 'Score for Unit 4 Test: Cell energy']) expect(html).toContain(`aria-label="${label}"`);
    expect(page).toContain('Tests · Due Nov 14');
    expect(page).toContain('94/100');
    expect(page).toContain('Goal type');
    expect(page).toContain('Plan around');
    expect(page).toContain('Type a score next to anything coming up to see where you’d land. Nothing is sent to Schoology.');
    expect(page).not.toContain('close estimates');
    expect(html.replace(/<select aria-hidden="true"[^>]*>.*?<\/select>/g, '')).not.toMatch(/<select|<textarea|type="(number|range|checkbox|radio|date)"/);
  });

  it('uses a custom 94.5 goal on the ruler, in the needed score and against the what-ifs', () => {
    const goals = { '11': { goal: { kind: 'percent' as const, percent: 94.5 }, plan: { kind: 'item' as const, id: '302' } } };
    const html = board(goals, '11');
    const page = text(html);
    expect(page).toContain('Custom · 94.5%');
    expect(page).toContain('Target percentage');
    expect(html).toMatch(/id="goal-11-percent"[^>]*value="94\.5"/);
    expect(html).toContain('aria-label="Now 92.79%, goal 94.5%"');
    expect(page).toContain('94.5% · 1.7 to go');
    expect(page).toMatch(/94\.5% is out of reach on HW 7 alone\. A perfect score gets you to 9\d\.\d+%\./);
    // Typed scores re-plan around the same 94.5, and say so in the dashed what-if style.
    const tried = board(goals, '11', { typed: { '11': { '104': '100', '203': '40' } } });
    const triedPage = text(tried);
    expect(tried).toContain('data-plan-line="what-if"');
    expect(triedPage).toMatch(/With those scores, you’d need \d+\/10 or better on HW 7 to reach 94\.5%|With those scores, 94\.5% is out of reach on HW 7 alone|With those scores, 94\.5% is locked in/);
    expect(tried).toMatch(/aria-label="Now 92\.79%, goal 94\.5%, what if 9\d(\.\d+)?%"/);
    expect(triedPage).toMatch(/(Reaches your goal of 94\.5%|\d+(\.\d+)? short of 94\.5%)/);
    expect(triedPage).toContain('Your Schoology grade is still 92.79%. Nothing here is sent to Schoology.');
    expect(triedPage).toMatch(/9\d\.\d+% what if/);
  });

  it('says a typed score on the plan\'s own assignment finishes short or reaches the goal', () => {
    const goals = { '11': { goal: { kind: 'letter' as const, letter: 'A' }, plan: { kind: 'item' as const, id: '104' } } };
    expect(text(board(goals, '11', { typed: { '11': { '104': '100' } } }))).toMatch(/With these scores you’d finish at 9\d\.\d+%, enough for A\./);
    expect(text(board(goals, '11', { typed: { '11': { '104': '40' } } }))).toMatch(/With these scores you’d finish at \d+\.\d+%, short of A \(93%\)\./);
    // Text that isn't a score is ignored rather than treated as zero.
    expect(text(board(goals, '11', { typed: { '11': { '104': 'abc' } } }))).toMatch(/To reach A, get \d+\/100 or better/);
  });

  it('calls out missing work, and offers an unsaved goal without counting it as saved', () => {
    const page = text(board({}, '12'));
    expect(page).toContain('Problem set 7 is missing. Schoology counts it as 0.');
    expect(page).toContain('Missing · 0/25');
    expect(page).toContain('This starts at the letter you have now. Nothing is saved until you choose.');
    expect(page).toContain('Set as my goal');
    expect(text(board({ '12': { goal: { kind: 'letter', letter: 'B' }, plan: null } }, '12'))).not.toContain('Set as my goal');
  });

  it('keeps what-ifs behind Plus when billing says so, and shows a gradebook without a grade plainly', () => {
    const locked = board({}, '11', { plusLocked: true });
    expect(locked).not.toContain('aria-label="Score for');
    expect(text(locked)).toContain('Trying out scores is part of Quasar AI Plus.');
    const ungraded = text(board({}, '13'));
    expect(ungraded).toContain('Schoology shows no grade here yet. You can set a goal once a grade lands.');
    expect(ungraded).not.toContain('Goal type');
  });

  it('warns when Schoology weighs a class in a way the gradebook can\'t reproduce', () => {
    const odd = { ...book, classes: [{ detail: { ...biology, reported: 90.2, termReported: 90.2 }, grade: '90.2%', graded: 6, classId: 'bio' }] };
    const html = renderToStaticMarkup(createElement(GradesBoard, { classes: gradeClasses(odd, {}, mine), selected: '11', today: '2026-11-10', mobile: false, online: true, plusLocked: false,
      typed: {}, goalNote: null, onSelect: noop, onTyped: noop, onClear: noop, onGoal: noop }));
    expect(text(html)).toContain('so the needed scores and what-ifs here are close estimates');
    expect(text(html)).toMatch(/get about \d+\/100 or better/);
    expect(text(html)).toContain('90.2%');
  });
});
