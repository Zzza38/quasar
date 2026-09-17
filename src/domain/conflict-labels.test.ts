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
