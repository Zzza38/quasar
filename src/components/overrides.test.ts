import { describe, expect, it } from 'vitest';
import { committedShift, parseShift } from './overrides';

describe('shift field', () => {
  it('keeps the last valid shift while the text is not a number yet, instead of snapping to 0', () => {
    for (const text of ['', '-', ' ', '1.5', 'abc', '--5']) expect(parseShift(text), text).toBeNull();
  });

  it('commits whole minutes, negative ones included, clamped to ±720', () => {
    expect(parseShift('-15')).toBe(-15);
    expect(parseShift('45')).toBe(45);
    expect(parseShift('-0')).toBe(0);
    expect(Object.is(parseShift('-0'), 0)).toBe(true);
    expect(parseShift('900')).toBe(720);
    expect(parseShift('-900')).toBe(-720);
  });

  it('commits no shift for an emptied field, so clearing it and saving removes the shift', () => {
    expect(committedShift('', 30)).toBe(0);
    expect(committedShift('  ', -45)).toBe(0);
  });

  it('keeps the last shift while another partial entry is typed, and commits whole numbers', () => {
    expect(committedShift('1.5', 30)).toBe(30);
    expect(committedShift('abc', 30)).toBe(30);
    expect(committedShift('-15', 30)).toBe(-15);
    expect(committedShift('900', 0)).toBe(720);
  });
});
