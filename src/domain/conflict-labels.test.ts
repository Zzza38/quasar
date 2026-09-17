import { expect, it } from 'vitest';
import { detectOverrideConflicts, emptyPersonalSchedule } from './schedule';
import { exampleSchedule } from './example';

it('uses a class name when a removed period has no known label, without leaking internal IDs', () => {
  const personal = { ...emptyPersonalSchedule(), classes: [{ id: 'wellness', name: 'Foundations of Wellness' }], assignments: { 'period-23': 'wellness' } };
  const message = detectOverrideConflicts(exampleSchedule, exampleSchedule, personal)[0].message;
  expect(message).toContain('Foundations of Wellness');
  expect(message).not.toContain('period-23');
  expect(message).toContain('still saved');
});

it('identifies both the removed period and the saved class', () => {
  const previous = { ...exampleSchedule, periods: [...exampleSchedule.periods, { id: 'period-23', label: 'Block H (3)', kind: 'class' as const }] };
  const personal = { ...emptyPersonalSchedule(), classes: [{ id: 'wellness', name: 'Foundations of Wellness' }], assignments: { 'period-23': 'wellness' } };
  const message = detectOverrideConflicts(previous, exampleSchedule, personal)[0].message;
  expect(message).toContain('Foundations of Wellness');
  expect(message).toContain('Block H (3)');
  expect(message).not.toContain('period-23');
});

it('describes unnamed override periods without presenting an internal ID', () => {
  const personal = { ...emptyPersonalSchedule(), cycleDayOverrides: [{ cycleDayId: 'day-1', slots: [{ id: 'slot', periodId: 'period-23', start: '08:00', end: '09:00' }] }] };
  const conflict = detectOverrideConflicts(exampleSchedule, exampleSchedule, personal).find(entry => entry.kind === 'period-removed');
  expect(conflict?.message).toContain('personal adjustments');
  expect(conflict?.message).not.toContain('period-23');
});

it('labels an existing period with its last scheduled occurrence removed as Unscheduled', () => {
  const current = { ...exampleSchedule, cycleDays: exampleSchedule.cycleDays.map(day => ({ ...day, slots: day.slots.filter(slot => slot.periodId !== 'A') })) };
  const personal = { ...emptyPersonalSchedule(), classes: [{ id: 'wellness', name: 'Wellness' }], assignments: { A: 'wellness' } };
  const conflicts = detectOverrideConflicts(exampleSchedule, current, personal);
  expect(conflicts).toContainEqual(expect.objectContaining({ kind: 'period-unscheduled', target: 'A', message: expect.stringContaining('Unscheduled') }));
  expect(conflicts.some(conflict => conflict.kind === 'period-removed')).toBe(false);
  expect(detectOverrideConflicts(current, current, personal)).toEqual([]);
});

it('counts a period scheduled only on an exception date as scheduled', () => {
  const current = { ...exampleSchedule, cycleDays: exampleSchedule.cycleDays.map(day => ({ ...day, slots: day.slots.filter(slot => slot.periodId !== 'A') })), exceptions: [{ date: '2026-09-10', kind: 'replacement' as const, advanceCycle: false, slots: [exampleSchedule.cycleDays[0].slots[0]] }] };
  const personal = { ...emptyPersonalSchedule(), classes: [{ id: 'wellness', name: 'Wellness' }], assignments: { A: 'wellness' } };
  expect(detectOverrideConflicts(exampleSchedule, current, personal)).toEqual([]);
});
