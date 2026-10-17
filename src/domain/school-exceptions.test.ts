import { expect, it } from 'vitest';
import { exampleSchedule } from './example';
import { applySchoolExceptions, emptyPersonalSchedule, GRADES, resolveDay, scheduleForGrade, scheduleSchema, type Schedule } from './schedule';
import { applySchoolDefaultEdits, schoolExceptionGroups, setSchoolExceptionForGrades } from './school-exceptions';

const date = '2026-10-12';
const closure = { date, kind: 'closure' as const, advanceCycle: false };

it('groups shared exceptions and keeps distinct same-date exceptions and root-only dates', () => {
  const replacement = { date, kind: 'replacement' as const, slots: exampleSchedule.cycleDays[0].slots, advanceCycle: true };
  const school: Schedule = { ...exampleSchedule, exceptions: [closure], gradeSchedules: {
    '9': { ...exampleSchedule, exceptions: [replacement] },
    '10': exampleSchedule,
    '11': { ...exampleSchedule, exceptions: [replacement] },
    '12': exampleSchedule,
  } };
  const groups = schoolExceptionGroups(school);
  expect(groups).toHaveLength(2);
  expect(groups.find(group => group.schoolDefault)).toMatchObject({ exception: closure, grades: [] });
  expect(groups.find(group => !group.schoolDefault)).toMatchObject({ exception: replacement, grades: ['9', '11'], schedule: school.gradeSchedules!['9'] });
});

it('targets a closure to selected grades and preserves their bell times and other exceptions', () => {
  const existing = { ...closure, date: '2026-10-13' };
  const variant = { ...exampleSchedule, cycleDays: exampleSchedule.cycleDays.map(day => ({ ...day, label: `Ninth ${day.label}` })), exceptions: [existing] };
  const current: Schedule = { ...exampleSchedule, gradeSchedules: { '9': variant } };
  const draft = setSchoolExceptionForGrades(current, null, closure, ['9', '11']);
  const saved = applySchoolExceptions(current, draft);
  expect(scheduleSchema.parse(saved)).toEqual(saved);
  expect(saved.exceptions).toEqual([]);
  expect(saved.gradeSchedules?.['9']?.cycleDays).toEqual(variant.cycleDays);
  expect(saved.gradeSchedules?.['9']?.exceptions).toEqual([existing, closure]);
  for (const grade of GRADES) {
    expect(resolveDay(saved, date, { ...emptyPersonalSchedule(), grade }).closed).toBe(['9', '11'].includes(grade));
  }
  expect(schoolExceptionGroups(saved).find(group => group.exception.date === date)?.grades).toEqual(['9', '11']);
});

it('narrows an all-grade exception and materializes exclusions for grades using the default', () => {
  const current: Schedule = { ...exampleSchedule, exceptions: [closure], gradeSchedules: { '9': { ...exampleSchedule, exceptions: [closure] } } };
  const draft = setSchoolExceptionForGrades(current, closure, closure, ['9']);
  expect(draft.exceptions).toEqual([]);
  for (const grade of GRADES) expect(resolveDay(draft, date, { ...emptyPersonalSchedule(), grade }).closed).toBe(grade === '9');
  expect(resolveDay(draft, date).closed).toBe(false);
});

it('moves, broadens and deletes an exception while preserving a distinct grade exception', () => {
  const specific = { ...closure, advanceCycle: true };
  const current: Schedule = { ...exampleSchedule, gradeSchedules: { '12': { ...exampleSchedule, exceptions: [specific] } } };
  const targeted = setSchoolExceptionForGrades(current, null, closure, ['9']);
  const moved = { date: '2026-10-14', kind: 'reset' as const, cycleDayId: 'day-6', advanceCycle: true };
  const expanded = setSchoolExceptionForGrades(targeted, closure, moved, [...GRADES]);
  expect(expanded.exceptions).toEqual([moved]);
  expect(scheduleForGrade(expanded, '12').exceptions).toEqual([specific, moved]);
  for (const grade of GRADES) expect(resolveDay(expanded, moved.date, { ...emptyPersonalSchedule(), grade }).cycleDayId).toBe('day-6');
  const removed = setSchoolExceptionForGrades(expanded, moved, null, []);
  expect(removed.exceptions).toEqual([]);
  expect(scheduleForGrade(removed, '12').exceptions).toEqual([specific]);
  expect(schoolExceptionGroups(removed)).toHaveLength(1);
});

it('keeps intermediate invalid exception dates editable', () => {
  const edited = setSchoolExceptionForGrades(exampleSchedule, null, { ...closure, date: '2026-' }, ['9']);
  expect(edited.gradeSchedules?.['9']?.exceptions[0].date).toBe('2026-');
});

it.each([false, true])('preserves default-only and default-plus-grade scopes during content edits with grade 9 selected: %s', (includeGrade) => {
  const replacement = { date, kind: 'replacement' as const, slots: exampleSchedule.cycleDays[0].slots, advanceCycle: true };
  const current: Schedule = { ...exampleSchedule, exceptions: [closure], gradeSchedules: {
    '9': { ...exampleSchedule, exceptions: includeGrade ? [closure] : [] },
    '10': { ...exampleSchedule, exceptions: [replacement] },
    '11': exampleSchedule,
    '12': exampleSchedule,
  } };
  const group = schoolExceptionGroups(current).find(group => group.schoolDefault)!;
  const edited = { ...closure, advanceCycle: true };
  const result = setSchoolExceptionForGrades(current, group.exception, edited, group.grades, group.schoolDefault);
  expect(result.exceptions).toEqual([edited]);
  expect(result.gradeSchedules?.['9']?.exceptions).toEqual(includeGrade ? [edited] : []);
  expect(result.gradeSchedules?.['10']?.exceptions).toEqual([replacement]);
  expect(result.gradeSchedules?.['11']?.exceptions).toEqual([]);
  expect(result.gradeSchedules?.['12']?.exceptions).toEqual([]);
  const saved = scheduleSchema.parse(JSON.parse(JSON.stringify(result)));
  expect(schoolExceptionGroups(saved).find(group => group.schoolDefault)).toMatchObject({ exception: edited, grades: includeGrade ? ['9'] : [] });
});

it.each([{ grades: ['9'] as const }, { grades: GRADES }])('keeps inherited regular schedules editable after adding an exception for $grades', ({ grades }) => {
  const specific = { ...exampleSchedule, timeZone: 'America/Los_Angeles', cycleDays: exampleSchedule.cycleDays.map(day => ({ ...day, label: `Senior ${day.label}` })) };
  const original: Schedule = { ...exampleSchedule, gradeSchedules: { '12': specific } };
  const current = setSchoolExceptionForGrades(original, null, closure, [...grades]);
  const draft = {
    ...current,
    timeZone: 'America/Chicago',
    anchorDate: '2026-09-09',
    cycleDays: current.cycleDays.map(day => ({ ...day, slots: day.slots.map(slot => ({ ...slot, start: slot.id === 'first' ? '08:15' : slot.start })) })),
  };
  const result = applySchoolDefaultEdits(current, draft);
  expect(scheduleSchema.parse(result)).toEqual(result);
  for (const grade of ['9', '10', '11'] as const) {
    const variant = scheduleForGrade(result, grade);
    expect(variant.timeZone).toBe(draft.timeZone);
    expect(variant.anchorDate).toBe(draft.anchorDate);
    expect(variant.cycleDays).toEqual(draft.cycleDays);
    expect(variant.exceptions).toEqual(scheduleForGrade(current, grade).exceptions);
  }
  expect(scheduleForGrade(result, '12')).toEqual(scheduleForGrade(current, '12'));
  expect(result.exceptions).toEqual(current.exceptions);
});
