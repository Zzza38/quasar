import { expect, it } from 'vitest';
import { exampleSchedule, examplePersonalSchedule } from '@/domain/example';
import { saveTimetableEdit } from './personal-timetable';
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
