import { describe, expect, it } from 'vitest';
import { exampleSchedule } from './example';
import { applySchoolClosures, applyScheduleToGrades, emptyPersonalSchedule, GRADES, gradesSchema, resolveDay, scheduleForGrade, scheduleSchema, type Schedule } from './schedule';

it('keeps unrelated grade exceptions and explicit grade edits when publishing school closures', () => {
  const closure = { date: '2026-10-12', kind: 'closure' as const, advanceCycle: false };
  const gradeClosure = { date: '2026-10-13', kind: 'closure' as const, advanceCycle: false };
  const current: Schedule = { ...exampleSchedule, exceptions: [], gradeSchedules: { '9': { ...exampleSchedule, exceptions: [gradeClosure] } } };
  const result = applySchoolClosures(current, { ...current, exceptions: [closure] });
  expect(result.gradeSchedules?.['9']?.exceptions).toEqual([gradeClosure, closure]);
  const removed = applySchoolClosures(result, { ...result, exceptions: [] });
  expect(removed.gradeSchedules?.['9']?.exceptions).toEqual([gradeClosure]);
  const explicit: Schedule = { ...current, exceptions: [closure], gradeSchedules: { '9': { ...current.gradeSchedules!['9']!, exceptions: [gradeClosure, { ...closure, advanceCycle: true }] } } };
  expect(applySchoolClosures(current, explicit)).toEqual(explicit);
});

it('preserves grade schedules omitted by an admin draft and permits explicit removal', () => {
  const gradeClosure = { date: '2026-10-13', kind: 'closure' as const, advanceCycle: false };
  const closure = { date: '2026-10-12', kind: 'closure' as const, advanceCycle: false };
  const current: Schedule = { ...exampleSchedule, exceptions: [], gradeSchedules: { '9': { ...exampleSchedule, exceptions: [gradeClosure] } } };
  const { gradeSchedules: _variants, ...base } = current;
  const result = applySchoolClosures(current, { ...base, exceptions: [closure] });
  expect(result.gradeSchedules?.['9']).toEqual({ ...current.gradeSchedules!['9'], exceptions: [gradeClosure, closure] });
  expect(applySchoolClosures(result, { ...base, exceptions: [] }).gradeSchedules?.['9']?.exceptions).toEqual([gradeClosure]);
  expect(applySchoolClosures(current, { ...base, gradeSchedules: {} }).gradeSchedules).toEqual({});
});

describe('grade schedules', () => {
  const changed = { ...exampleSchedule, cycleDays: exampleSchedule.cycleDays.map((day) => ({ ...day, label: `Junior ${day.label}` })) };
  it('applies one schedule to multiple grades without changing other grades', () => {
    const result = applyScheduleToGrades(exampleSchedule, changed, ['9', '10']);
    expect(scheduleForGrade(result, '9').cycleDays).toEqual(changed.cycleDays);
    expect(scheduleForGrade(result, '10').cycleDays).toEqual(changed.cycleDays);
    expect(scheduleForGrade(result, '11').cycleDays).toEqual(exampleSchedule.cycleDays);
    const revised = applyScheduleToGrades(result, exampleSchedule, ['9']);
    expect(scheduleForGrade(revised, '10').cycleDays).toEqual(changed.cycleDays);
    expect(scheduleSchema.parse(JSON.parse(JSON.stringify(revised)))).toEqual(revised);
  });
  it('uses the student grade and gives private schedules precedence', () => {
    const school = applyScheduleToGrades(exampleSchedule, changed, ['9']);
    const personal = { ...emptyPersonalSchedule(), grade: '9' as const };
    expect(resolveDay(school, '2026-09-08', personal)).toEqual(resolveDay(changed, '2026-09-08'));
    expect(resolveDay(school, '2026-09-08', { ...personal, customSchedule: exampleSchedule })).toEqual(resolveDay(exampleSchedule, '2026-09-08'));
  });
  it('applies all grades to the default and replaces previous grade schedules', () => {
    const school = applyScheduleToGrades(exampleSchedule, changed, ['9']);
    expect(applyScheduleToGrades(school, exampleSchedule, [...GRADES])).toEqual(exampleSchedule);
  });
  it('rejects empty, duplicate and unsupported grades and invalid grade schedules', () => {
    for (const grades of [[], ['9', '9'], ['K'], ['1'], ['8'], ['13']]) expect(gradesSchema.safeParse(grades).success).toBe(false);
    expect(scheduleSchema.safeParse({ ...exampleSchedule, gradeSchedules: { '9': { ...changed, periods: [] } } }).success).toBe(false);
  });
});

it.each([false, true])('preserves saved grade exceptions on closure dates with grade maps included: %s', (includeGrades) => {
  const replacement = { date: '2026-10-12', kind: 'replacement' as const, slots: exampleSchedule.cycleDays[0].slots, advanceCycle: false };
  const specificClosure = { date: '2026-10-14', kind: 'closure' as const, advanceCycle: false };
  const schoolClosure = { ...specificClosure, advanceCycle: true };
  const current: Schedule = { ...exampleSchedule, exceptions: [schoolClosure], gradeSchedules: {
    '9': { ...exampleSchedule, exceptions: [replacement, specificClosure] },
    '10': { ...exampleSchedule, exceptions: [schoolClosure] },
  } };
  const { gradeSchedules: _variants, ...base } = current;
  const draft: Schedule = { ...(includeGrades ? current : base), exceptions: [
    { date: replacement.date, kind: 'closure', advanceCycle: false },
  ] };
  const added = applySchoolClosures(current, draft);
  expect(added.gradeSchedules?.['9']?.exceptions).toEqual([replacement, specificClosure]);
  expect(added.gradeSchedules?.['10']?.exceptions).toEqual([draft.exceptions[0]]);
  const { gradeSchedules: _added, ...addedBase } = added;
  const removed = applySchoolClosures(added, { ...(includeGrades ? added : addedBase), exceptions: [] });
  expect(removed.gradeSchedules?.['9']?.exceptions).toEqual([replacement, specificClosure]);
  expect(removed.gradeSchedules?.['10']?.exceptions).toEqual([]);
});


it('uses grade-nine lunch on Days 6–10 even when the old default has no lunch', () => {
  const fallback = { ...exampleSchedule, cycleDays: exampleSchedule.cycleDays.map(day => ({ ...day, slots: day.slots.filter(slot => slot.periodId !== 'lunch') })) };
  const school = applyScheduleToGrades(fallback, exampleSchedule, ['9']);
  const dates = ['2026-09-15', '2026-09-16', '2026-09-17', '2026-09-18', '2026-09-21'];
  dates.forEach((date, index) => {
    const day = resolveDay(school, date, { ...emptyPersonalSchedule(), grade: '9' });
    expect(day.cycleDayId).toBe(`day-${index + 6}`);
    expect(day.periods.filter(period => period.kind === 'lunch')).toHaveLength(1);
    expect(resolveDay(school, date).periods.some(period => period.kind === 'lunch')).toBe(false);
  });
});
