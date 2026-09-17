import { expect, it } from 'vitest';
import { parseScheduleTime } from './schedule-time';

it('switches between morning and afternoon when typing school hours', () => {
  expect(parseScheduleTime('12:10', '11:10')).toBe('12:10');
  expect(parseScheduleTime('1:30', '11:30')).toBe('13:30');
  expect(parseScheduleTime('9:15', '13:15')).toBe('09:15');
  expect(parseScheduleTime('11:15', '12:15')).toBe('11:15');
});
it('honors explicit AM/PM and 24-hour input including noon and midnight', () => {
  expect(parseScheduleTime('1:30 am')).toBe('01:30');
  expect(parseScheduleTime('9:15 PM')).toBe('21:15');
  expect(parseScheduleTime('12:00 AM')).toBe('00:00');
  expect(parseScheduleTime('12:00 pm')).toBe('12:00');
  expect(parseScheduleTime('23:15')).toBe('23:15');
  expect(parseScheduleTime('00:15')).toBe('00:15');
});
it('preserves an explicit meridiem when only minutes change', () => {
  expect(parseScheduleTime('9:30', '21:15')).toBe('21:30');
  expect(parseScheduleTime('1:30', '01:15')).toBe('01:30');
});
it('rejects incomplete and invalid times', () => {
  for (const text of ['', '1:', '1:7', '24:00', '8:60', '13:00 PM', '0:00 AM']) expect(parseScheduleTime(text)).toBeNull();
});

it('flips AM/PM across 11 and 12 in both directions at noon and midnight', () => {
  expect(parseScheduleTime('12:15', '11:15')).toBe('12:15');
  expect(parseScheduleTime('11:15', '12:15')).toBe('11:15');
  expect(parseScheduleTime('12:15', '23:15')).toBe('00:15');
  expect(parseScheduleTime('11:15', '00:15')).toBe('23:15');
  expect(parseScheduleTime('12:30', '00:15')).toBe('00:30');
  expect(parseScheduleTime('12:15 PM', '23:15')).toBe('12:15');
  expect(parseScheduleTime('11:15 AM', '00:15')).toBe('11:15');
});
