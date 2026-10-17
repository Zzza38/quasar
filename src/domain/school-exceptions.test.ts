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

it.each([{ grades: ['9'] as const }, { grades: GRADES }])('removes resets for a deleted rotation day from inherited variants for $grades', ({ grades }) => {
  const removedId = exampleSchedule.cycleDays[0].id;
  const retainedId = exampleSchedule.cycleDays[1].id;
  const reset = { date, kind: 'reset' as const, cycleDayId: removedId, advanceCycle: true };
  const retained = { ...reset, date: '2026-10-13', cycleDayId: retainedId };
  const specific = { ...exampleSchedule, cycleDays: exampleSchedule.cycleDays.map(day => ({ ...day, label: `Senior ${day.label}` })) };
  let current: Schedule = { ...exampleSchedule, gradeSchedules: { '12': specific } };
  current = setSchoolExceptionForGrades(current, null, reset, [...grades]);
  current = setSchoolExceptionForGrades(current, null, retained, ['9']);
  current = setSchoolExceptionForGrades(current, null, { ...closure, date: '2026-10-14' }, ['10']);
  const draft = {
    ...current,
    cycleDays: current.cycleDays.filter(day => day.id !== removedId),
    anchorCycleDayId: current.anchorCycleDayId === removedId ? retainedId : current.anchorCycleDayId,
    exceptions: current.exceptions.filter(exception => !(exception.kind === 'reset' && exception.cycleDayId === removedId)),
  };
  const result = applySchoolDefaultEdits(current, draft);
  expect(scheduleSchema.parse(result)).toEqual(result);
  for (const grade of ['9', '10', '11'] as const) {
    expect(scheduleForGrade(result, grade).exceptions).toEqual(scheduleForGrade(current, grade).exceptions.filter(exception => exception !== reset));
    expect(scheduleForGrade(result, grade).cycleDays).toEqual(draft.cycleDays);
  }
  expect(scheduleForGrade(result, '12')).toEqual(scheduleForGrade(current, '12'));
});

it.each([
  { grades: ['9'] as const, kind: 'replacement' as const },
  { grades: GRADES, kind: 'replacement' as const },
  { grades: ['9'] as const, kind: 'reset' as const },
  { grades: GRADES, kind: 'reset' as const },
])('removes deleted periods from $kind exception slots for $grades', ({ grades, kind }) => {
  const slots = exampleSchedule.cycleDays[0].slots;
  const removedId = slots[0].periodId;
  const exception = kind === 'replacement'
    ? { date, kind, slots, advanceCycle: true }
    : { date, kind, slots, cycleDayId: exampleSchedule.cycleDays[0].id, advanceCycle: true };
  const specific = { ...exampleSchedule, timeZone: 'America/Los_Angeles' };
  let current: Schedule = { ...exampleSchedule, gradeSchedules: { '12': specific } };
  current = setSchoolExceptionForGrades(current, null, exception, [...grades]);
  current = setSchoolExceptionForGrades(current, null, { ...closure, date: '2026-10-13' }, ['10']);
  const draft = {
    ...current,
    periods: current.periods.filter(period => period.id !== removedId),
    cycleDays: current.cycleDays.map(day => ({ ...day, slots: day.slots.filter(slot => slot.periodId !== removedId) })),
    exceptions: current.exceptions.map(entry => 'slots' in entry && entry.slots ? { ...entry, slots: entry.slots.filter(slot => slot.periodId !== removedId) } : entry),
  };
  const result = applySchoolDefaultEdits(current, draft);
  expect(scheduleSchema.parse(result)).toEqual(result);
  for (const grade of ['9', '10', '11'] as const) {
    expect(scheduleForGrade(result, grade).exceptions).toEqual(scheduleForGrade(current, grade).exceptions.map(entry => 'slots' in entry && entry.slots ? { ...entry, slots: entry.slots.filter(slot => slot.periodId !== removedId) } : entry));
    expect(scheduleForGrade(result, grade).periods).toEqual(draft.periods);
  }
  expect(scheduleForGrade(result, '12')).toEqual(scheduleForGrade(current, '12'));
});

it('preserves unrelated invalid exception references while editing regular fields', () => {
  const invalidReset = { date, kind: 'reset' as const, cycleDayId: 'unfinished-day', advanceCycle: true };
  const invalidReplacement = { date: '2026-10-13', kind: 'replacement' as const, slots: [{ id: 'unfinished-slot', periodId: 'unfinished-period', start: '08:00', end: '09:00' }], advanceCycle: true };
  let current = setSchoolExceptionForGrades(exampleSchedule, null, invalidReset, ['9']);
  current = setSchoolExceptionForGrades(current, null, invalidReplacement, ['9']);
  const result = applySchoolDefaultEdits(current, { ...current, timeZone: 'America/Chicago' });
  expect(scheduleForGrade(result, '9').exceptions).toEqual([invalidReset, invalidReplacement]);
  expect(scheduleForGrade(result, '9').timeZone).toBe('America/Chicago');
});
