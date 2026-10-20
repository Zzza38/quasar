import { describe, expect, it } from 'vitest';
import { exampleSchedule, examplePersonalSchedule } from '@/domain/example';
import { cycleDaySlots, diffCycleDaySlots, personalScheduleSchema, resolveDay, scheduleSchema, withCycleDay, type Schedule } from '@/domain/schedule';
import { makesPrivateCopy, queueTimetableEdit, rebaseTimetableEdit, rebaseLegacyTimetableEdit, removeClass, saveTimetableEdit, saveLegacyTimetableEdit, useSchoolTimetable } from './personal-timetable';
it('automatically saves a changed day as an override while other days follow the school', () => {
  const next = structuredClone(exampleSchedule);
  next.cycleDays[0].slots[0].end = '08:55';
  next.periods.push({ id: 'unused-class', label: 'Unused class', kind: 'class' });
  const saved = saveTimetableEdit(exampleSchedule, examplePersonalSchedule, next, { ...examplePersonalSchedule.assignments, 'unused-class': 'algebra' });
  expect(saved.customSchedule).toBeNull();
  expect(saved.cycleDayOverrides).toEqual([diffCycleDaySlots(exampleSchedule.cycleDays[0], next.cycleDays[0].slots)]);
  expect(saved.assignments['unused-class']).toBeUndefined();
  const restored = saveTimetableEdit(exampleSchedule, saved, exampleSchedule, saved.assignments);
  expect(restored.cycleDayOverrides).toEqual([]);
});
it('keeps date adjustments when saving a timetable change', () => {
  const personal = { ...examplePersonalSchedule, dateOverrides: [{ date: '2026-09-15', closed: true }] };
  expect(saveTimetableEdit(exampleSchedule, personal, exampleSchedule, personal.assignments).dateOverrides).toEqual(personal.dateOverrides);
});
it('keeps overrides for a rotation day the school removed when another day is edited', () => {
  const orphan = { cycleDayId: 'removed-day', slots: [{ id: 'x', periodId: exampleSchedule.periods[0].id, start: '09:00', end: '10:00' }] };
  const personal = { ...examplePersonalSchedule, cycleDayOverrides: [orphan] };
  const next = structuredClone(exampleSchedule);
  next.cycleDays[0].slots[0].end = '08:55';
  const saved = saveTimetableEdit(exampleSchedule, personal, next, personal.assignments);
  expect(saved.cycleDayOverrides).toEqual([diffCycleDaySlots(exampleSchedule.cycleDays[0], next.cycleDays[0].slots), orphan]);
});
it('removing a class keeps its private time blocks and other schedule adjustments', () => {
  const personal = { ...examplePersonalSchedule, classes: [...examplePersonalSchedule.classes, { id: 'art', name: 'Art' }] };
  // ClassAssignmentGrid places an unplaced class as its own private period, labelled with the class name.
  const next = structuredClone(exampleSchedule);
  next.periods.push({ id: 'class-art', label: 'Art', kind: 'class' });
  next.cycleDays[0].slots.push({ id: 'art-slot', periodId: 'class-art', start: '12:00', end: '12:45' });
  const placed = saveTimetableEdit(exampleSchedule, personal, next, { ...personal.assignments, 'class-art': 'art' });
  const withDate = { ...placed, dateOverrides: [{ date: '2026-09-09', slots: [{ id: 'd', periodId: 'class-art', start: '13:00', end: '13:30' }, { id: 'e', periodId: 'A', start: '14:00', end: '14:30' }] }] };
  expect(resolveDay(exampleSchedule, '2026-09-08', withDate).periods.some(period => period.label === 'Art')).toBe(true);
  const removed = removeClass(withDate, 'art');
  expect(personalScheduleSchema.safeParse(removed).success).toBe(true);
  expect(removed.classes.map(cls => cls.id)).not.toContain('art');
  expect(removed.assignments['class-art']).toBeUndefined();
  expect(removed.customSchedule).toEqual(withDate.customSchedule);
  expect(removed.dateOverrides).toEqual(withDate.dateOverrides);
  expect(resolveDay(exampleSchedule, '2026-09-08', removed).periods.some(period => period.label === 'Unassigned block' && period.start === '12:00')).toBe(true);
});
it('removing a class keeps school periods and their times, clearing only the assignment', () => {
  const removed = removeClass(examplePersonalSchedule, 'algebra');
  expect(removed.assignments).toEqual({ B: 'english', C: 'biology', D: 'history' });
  expect(removed.customSchedule).toBeNull();
  expect(removed.cycleDayOverrides).toEqual(examplePersonalSchedule.cycleDayOverrides);
});

it('reverts to school times while keeping classes and valid school period assignments', () => {
  const personal = { ...examplePersonalSchedule, customSchedule: exampleSchedule, cycleDayOverrides: [{ cycleDayId: 'day-1', slots: [] }], dateOverrides: [{ date: '2026-09-09', closed: true }], assignments: { ...examplePersonalSchedule.assignments, 'class-art': 'algebra' } };
  const reset = useSchoolTimetable(exampleSchedule, personal);
  expect(reset.classes).toEqual(personal.classes);
  expect(reset.assignments).toEqual(examplePersonalSchedule.assignments);
  expect(reset.customSchedule).toBeNull();
  expect(reset.cycleDayOverrides).toEqual([]);
  expect(reset.dateOverrides).toEqual([]);
});

describe('knowing when a timetable edit makes a private copy', () => {
  const personal = { ...examplePersonalSchedule, classes: [...examplePersonalSchedule.classes, { id: 'art', name: 'Art' }] };
  const assignments = { ...personal.assignments, 'class-art': 'art' };
  const changed = (change: (draft: Schedule) => void) => { const next = structuredClone(exampleSchedule); change(next); return next; };

  it('keeps following school when placing an unplaced class in free time', () => {
    const next = changed((draft) => {
      draft.periods.push({ id: 'class-art', label: 'Art', kind: 'class' });
      draft.cycleDays[0].slots.push({ id: 'art-slot', periodId: 'class-art', start: '12:00', end: '12:45' });
    });
    expect(makesPrivateCopy(exampleSchedule, personal, next, assignments)).toBe(false);
    const saved = saveTimetableEdit(exampleSchedule, personal, next, assignments);
    expect(saved.customSchedule).toBeNull();
    expect(saved.periods).toEqual([{ id: 'class-art', label: 'Art', kind: 'class' }]);
    expect(cycleDaySlots(exampleSchedule.cycleDays[0], saved)).toEqual(next.cycleDays[0].slots);
  });

  it('is true for renaming, adding and removing a rotation day', () => {
    expect(makesPrivateCopy(exampleSchedule, personal, changed((draft) => { draft.cycleDays[0].label = 'Monday A'; }), assignments)).toBe(true);
    expect(makesPrivateCopy(exampleSchedule, personal, withCycleDay(exampleSchedule, { id: 'day-extra', label: 'Extra', slots: [] }), assignments)).toBe(true);
    expect(makesPrivateCopy(exampleSchedule, personal, changed((draft) => { draft.cycleDays.pop(); }), assignments)).toBe(true);
  });

  it('is false for edits that stay day overrides, and once the student already has a private copy', () => {
    // An unused private period (an unplaced class nobody dropped yet) is dropped on save, so it does not count.
    const retimed = changed((draft) => { draft.cycleDays[0].slots[0].end = '08:55'; draft.periods.push({ id: 'class-art', label: 'Art', kind: 'class' }); });
    expect(makesPrivateCopy(exampleSchedule, personal, retimed, assignments)).toBe(false);
    const renamed = changed((draft) => { draft.cycleDays[0].label = 'Monday A'; });
    const copied = saveTimetableEdit(exampleSchedule, personal, renamed, assignments);
    expect(makesPrivateCopy(exampleSchedule, copied, changed((draft) => { draft.cycleDays[1].label = 'Tuesday B'; }), assignments)).toBe(false);
  });

  it('is false for an edit that cannot be saved, so the save reports its own error instead', () => {
    const broken = changed((draft) => { draft.cycleDays[0].label = ''; });
    expect(() => saveTimetableEdit(exampleSchedule, personal, broken, assignments)).toThrow();
    expect(makesPrivateCopy(exampleSchedule, personal, broken, assignments)).toBe(false);
  });
});

describe('replaying timetable edits made while a save is running', () => {
  // Every edit below is built from the same stale render, `base`, as the grid does while a save is in flight.
  const base = exampleSchedule;
  const edit = (change: (draft: Schedule) => void) => { const next = structuredClone(base); change(next); return rebaseTimetableEdit(base, next); };
  const rename = edit((draft) => { draft.cycleDays[0].label = 'Monday A'; });
  const clearSlot = edit((draft) => { draft.cycleDays[0].slots = draft.cycleDays[0].slots.filter((slot) => slot.id !== 'second'); });
  const moveThird = edit((draft) => { draft.cycleDays[0].slots[3] = { ...draft.cycleDays[0].slots[3], start: '11:00', end: '12:00' }; });

  it('skips a removal that would leave no rotation day, as when both days of a two-day rotation are removed from one render', () => {
    const twoDays: Schedule = { ...base, cycleDays: base.cycleDays.slice(0, 2), anchorCycleDayId: base.cycleDays[0].id };
    const [first, second] = twoDays.cycleDays;
    const removeFirst = rebaseTimetableEdit(twoDays, { ...twoDays, cycleDays: [second], anchorCycleDayId: second.id });
    const removeSecond = rebaseTimetableEdit(twoDays, { ...twoDays, cycleDays: [first] });
    const saved = removeFirst(twoDays);
    expect(saved.cycleDays.map((day) => day.id)).toEqual([second.id]);
    expect(removeSecond(saved)).toBe(saved);
    const queued = queueTimetableEdit(queueTimetableEdit(null, { change: removeFirst }), { change: removeSecond });
    expect(scheduleSchema.safeParse(queued.change!(twoDays)).success).toBe(true);
  });

  it('keeps an earlier change to the same day: a rename saved first survives clearing a slot built before it', () => {
    const saved = rename(base);
    const day = clearSlot(saved).cycleDays[0];
    expect(day.label).toBe('Monday A');
    expect(day.slots.map((slot) => slot.id)).toEqual(['first', 'lunch-slot', 'third']);
  });

  it('merges two queued edits to different slots of one day, applying them in order', () => {
    const queued = queueTimetableEdit(queueTimetableEdit(null, { change: clearSlot }), { change: moveThird });
    const result = queued.change!(base);
    expect(scheduleSchema.safeParse(result).success).toBe(true);
    expect(result.cycleDays[0].slots.map((slot) => [slot.id, slot.start])).toEqual([['first', '08:00'], ['lunch-slot', '10:15'], ['third', '11:00']]);
    expect(result.cycleDays.slice(1)).toEqual(base.cycleDays.slice(1));
  });

  it('keeps slots in time order and reports overlapping queued edits', () => {
    const early = edit((draft) => { draft.cycleDays[1].slots.unshift({ id: 'zero', periodId: 'A', start: '07:00', end: '07:50' }); });
    expect(early(clearSlot(base)).cycleDays[1].slots[0].id).toBe('zero');
    const addNoon = edit((draft) => { draft.cycleDays[0].slots.push({ id: 'noon', periodId: 'A', start: '12:00', end: '13:00' }); });
    const stretch = edit((draft) => { draft.cycleDays[0].slots[3] = { ...draft.cycleDays[0].slots[3], end: '12:30' }; });
    const saved = addNoon(rename(base));
    expect(() => stretch(saved)).toThrow('overlap');
    expect(saved.cycleDays[0].slots.some(slot => slot.id === 'noon')).toBe(true);
  });

  it('adds and removes whole days without disturbing the days another edit changed', () => {
    const added = edit((draft) => { Object.assign(draft, withCycleDay(draft, { id: 'day-11', label: 'Day 11', slots: [] })); });
    const removed = edit((draft) => { draft.cycleDays = draft.cycleDays.filter((day) => day.id !== 'day-2'); });
    const result = removed(added(rename(base)));
    expect(result.cycleDays.map((day) => day.id)).toEqual([...base.cycleDays.map((day) => day.id).filter((id) => id !== 'day-2'), 'day-11']);
    expect(result.cycleDays[0].label).toBe('Monday A');
    // Adding the same day twice, as a retried edit would, keeps one copy.
    expect(added(added(base)).cycleDays.filter((day) => day.id === 'day-11')).toHaveLength(1);
  });

  it('keeps a changed top-level field and lets the later queued assignment win', () => {
    const anchor = edit((draft) => { draft.anchorDate = '2026-09-09'; });
    expect(clearSlot(anchor(base)).anchorDate).toBe('2026-09-09');
    const queued = queueTimetableEdit(queueTimetableEdit(null, { assign: { A: 'algebra', B: 'english' } }), { assign: { A: 'history' } });
    expect(queued.assign).toEqual({ A: 'history', B: 'english' });
    expect(queued.change).toBeUndefined();
  });
});

it('replays independent fields of one slot without losing a queued change', () => {
  const before = exampleSchedule;
  const start = structuredClone(before);
  start.cycleDays[0].slots[0].start = '07:50';
  const end = structuredClone(before);
  end.cycleDays[0].slots[0].end = '08:55';
  const result = rebaseTimetableEdit(before, end)(rebaseTimetableEdit(before, start)(before));
  expect(result.cycleDays[0].slots[0]).toMatchObject({ start: '07:50', end: '08:55' });
});

it('keeps both personal periods when two new blocks are queued from the same render', () => {
  const first = structuredClone(exampleSchedule);
  first.periods.push({ id: 'studio', label: 'Studio', kind: 'other' });
  first.cycleDays[0].slots.push({ id: 'studio-slot', periodId: 'studio', start: '12:00', end: '13:00' });
  const second = structuredClone(exampleSchedule);
  second.periods.push({ id: 'practice', label: 'Practice', kind: 'other' });
  second.cycleDays[0].slots.push({ id: 'practice-slot', periodId: 'practice', start: '13:00', end: '14:00' });
  const result = rebaseTimetableEdit(exampleSchedule, second)(rebaseTimetableEdit(exampleSchedule, first)(exampleSchedule));
  expect(scheduleSchema.safeParse(result).success).toBe(true);
  expect(result.periods.map(period => period.id)).toContain('studio');
  expect(result.periods.map(period => period.id)).toContain('practice');
});

it('reports a queued edit to a block removed by an earlier save', () => {
  const edited = structuredClone(exampleSchedule);
  edited.cycleDays[0].slots[0].end = '08:55';
  const latest = structuredClone(exampleSchedule);
  latest.cycleDays[0].slots.shift();
  expect(() => rebaseTimetableEdit(exampleSchedule, edited)(latest)).toThrow('removed');
});


describe('public timetable behavior outside the schedule-following beta', () => {
  it('keeps the public whole-slot replay while beta merges separate edits to a slot field', () => {
    const edited = structuredClone(exampleSchedule);
    edited.cycleDays[0].slots[0].end = '08:55';
    const updated = structuredClone(exampleSchedule);
    updated.cycleDays[0].slots[0].start = '08:05';
    expect(rebaseLegacyTimetableEdit(exampleSchedule, edited)(updated).cycleDays[0].slots[0]).toMatchObject({ start: '08:00', end: '08:55' });
    expect(rebaseTimetableEdit(exampleSchedule, edited)(updated).cycleDays[0].slots[0]).toMatchObject({ start: '08:05', end: '08:55' });
  });

  it('saves a complete edited day while the beta saves only the edited slot fields', () => {
    const next = structuredClone(exampleSchedule);
    next.cycleDays[0].slots[0].end = '08:55';
    const legacy = saveLegacyTimetableEdit(exampleSchedule, examplePersonalSchedule, next, examplePersonalSchedule.assignments);
    const beta = saveTimetableEdit(exampleSchedule, examplePersonalSchedule, next, examplePersonalSchedule.assignments);
    expect(legacy.cycleDayOverrides).toEqual([{ cycleDayId: next.cycleDays[0].id, slots: next.cycleDays[0].slots }]);
    expect(beta.cycleDayOverrides[0].slots).toBeUndefined();
    const correctedSchool = structuredClone(exampleSchedule);
    correctedSchool.cycleDays[0].slots[1].start = '09:15';
    expect(cycleDaySlots(correctedSchool.cycleDays[0], legacy)[1].start).toBe('09:10');
    expect(cycleDaySlots(correctedSchool.cycleDays[0], beta)[1].start).toBe('09:15');
  });

  it('asks for a private copy when a public user adds a period absent from the school', () => {
    const next = structuredClone(exampleSchedule);
    next.periods.push({ id: 'class-art', label: 'Art', kind: 'class' });
    next.cycleDays[0].slots.push({ id: 'private-art', periodId: 'class-art', start: '13:00', end: '13:45' });
    expect(makesPrivateCopy(exampleSchedule, examplePersonalSchedule, next, examplePersonalSchedule.assignments, false)).toBe(true);
    expect(makesPrivateCopy(exampleSchedule, examplePersonalSchedule, next, examplePersonalSchedule.assignments, true)).toBe(false);
    expect(saveLegacyTimetableEdit(exampleSchedule, examplePersonalSchedule, next, examplePersonalSchedule.assignments).customSchedule).toEqual(next);
  });

  it('keeps schedule locks, date adjustments, and orphaned legacy days', () => {
    const orphan = { cycleDayId: 'retired', slots: [] };
    const personal = { ...examplePersonalSchedule, scheduleLocked: true, cycleDayOverrides: [orphan], dateOverrides: [{ date: '2026-09-15', closed: true }] };
    const saved = saveLegacyTimetableEdit(exampleSchedule, personal, exampleSchedule, personal.assignments);
    expect(saved.scheduleLocked).toBe(true);
    expect(saved.dateOverrides).toEqual(personal.dateOverrides);
    expect(saved.cycleDayOverrides).toEqual([orphan]);
  });
});
