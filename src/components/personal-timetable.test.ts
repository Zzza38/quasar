import { describe, expect, it } from 'vitest';
import { exampleSchedule, examplePersonalSchedule } from '@/domain/example';
import { personalScheduleSchema, resolveDay, scheduleSchema, withCycleDay, type Schedule } from '@/domain/schedule';
import { makesPrivateCopy, queueTimetableEdit, rebaseTimetableEdit, removeClass, saveTimetableEdit } from './personal-timetable';
it('automatically saves a changed day as an override while other days follow the school', () => {
  const next = structuredClone(exampleSchedule);
  next.cycleDays[0].slots[0].end = '08:55';
  next.periods.push({ id: 'unused-class', label: 'Unused class', kind: 'class' });
  const saved = saveTimetableEdit(exampleSchedule, examplePersonalSchedule, next, { ...examplePersonalSchedule.assignments, 'unused-class': 'algebra' });
  expect(saved.customSchedule).toBeNull();
  expect(saved.cycleDayOverrides).toEqual([{ cycleDayId: 'day-1', slots: next.cycleDays[0].slots }]);
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
  expect(saved.cycleDayOverrides).toEqual([{ cycleDayId: 'day-1', slots: next.cycleDays[0].slots }, orphan]);
});
it('removing a class also removes the private block made for it, and only that block', () => {
  const personal = { ...examplePersonalSchedule, classes: [...examplePersonalSchedule.classes, { id: 'art', name: 'Art' }] };
  // ClassAssignmentGrid places an unplaced class as its own private period, labelled with the class name.
  const next = structuredClone(exampleSchedule);
  next.periods.push({ id: 'class-art', label: 'Art', kind: 'class' });
  next.cycleDays[0].slots.push({ id: 'art-slot', periodId: 'class-art', start: '12:00', end: '12:45' });
  const placed = saveTimetableEdit(exampleSchedule, personal, next, { ...personal.assignments, 'class-art': 'art' });
  const withDate = { ...placed, dateOverrides: [{ date: '2026-09-09', slots: [{ id: 'd', periodId: 'class-art', start: '13:00', end: '13:30' }, { id: 'e', periodId: 'A', start: '14:00', end: '14:30' }] }] };
  expect(resolveDay(exampleSchedule, '2026-09-08', withDate).periods.some(period => period.label === 'Art')).toBe(true);
  const removed = removeClass(exampleSchedule, withDate, 'art');
  expect(personalScheduleSchema.safeParse(removed).success).toBe(true);
  expect(removed.classes.map(cls => cls.id)).not.toContain('art');
  expect(removed.assignments['class-art']).toBeUndefined();
  expect(removed.customSchedule?.periods.map(period => period.id)).toEqual(exampleSchedule.periods.map(period => period.id));
  expect(removed.customSchedule?.cycleDays).toEqual(exampleSchedule.cycleDays);
  expect(removed.dateOverrides[0].slots?.map(slot => slot.id)).toEqual(['e']);
  expect(resolveDay(exampleSchedule, '2026-09-08', removed).periods.some(period => period.label === 'Art')).toBe(false);
});
it('removing a class keeps school periods and their times, clearing only the assignment', () => {
  const removed = removeClass(exampleSchedule, examplePersonalSchedule, 'algebra');
  expect(removed.assignments).toEqual({ B: 'english', C: 'biology', D: 'history' });
  expect(removed.customSchedule).toBeNull();
  expect(removed.cycleDayOverrides).toEqual(examplePersonalSchedule.cycleDayOverrides);
});

describe('knowing when a timetable edit makes a private copy', () => {
  const personal = { ...examplePersonalSchedule, classes: [...examplePersonalSchedule.classes, { id: 'art', name: 'Art' }] };
  const assignments = { ...personal.assignments, 'class-art': 'art' };
  const changed = (change: (draft: Schedule) => void) => { const next = structuredClone(exampleSchedule); change(next); return next; };

  it('is true for placing an unplaced class in free time, which adds a period the school does not have', () => {
    const next = changed((draft) => {
      draft.periods.push({ id: 'class-art', label: 'Art', kind: 'class' });
      draft.cycleDays[0].slots.push({ id: 'art-slot', periodId: 'class-art', start: '12:00', end: '12:45' });
    });
    expect(makesPrivateCopy(exampleSchedule, personal, next, assignments)).toBe(true);
    expect(saveTimetableEdit(exampleSchedule, personal, next, assignments).customSchedule).not.toBeNull();
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

  it('keeps slots in time order and falls back to the edited slots when a merge would overlap', () => {
    const early = edit((draft) => { draft.cycleDays[1].slots.unshift({ id: 'zero', periodId: 'A', start: '07:00', end: '07:50' }); });
    expect(early(clearSlot(base)).cycleDays[1].slots[0].id).toBe('zero');
    // A slot added at noon and the last class stretched past noon cannot both be kept, so the later edit's slots win.
    const addNoon = edit((draft) => { draft.cycleDays[0].slots.push({ id: 'noon', periodId: 'A', start: '12:00', end: '13:00' }); });
    const stretch = edit((draft) => { draft.cycleDays[0].slots[3] = { ...draft.cycleDays[0].slots[3], end: '12:30' }; });
    const result = stretch(addNoon(rename(base)));
    expect(scheduleSchema.safeParse(result).success).toBe(true);
    expect(result.cycleDays[0].label).toBe('Monday A');
    expect(result.cycleDays[0].slots.map((slot) => [slot.id, slot.end])).toEqual([['first', '09:00'], ['second', '10:10'], ['lunch-slot', '10:45'], ['third', '12:30']]);
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
