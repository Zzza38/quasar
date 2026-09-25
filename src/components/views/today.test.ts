import { describe, expect, it } from 'vitest';
import { contrastWithWhite } from '@/lib/color';
import { classColor } from '@/lib/format';
import { nowCardBase } from './today';

describe('Now card colour', () => {
  it('gives an unassigned period a concrete base that keeps white text at 4.5:1', () => {
    const dot = classColor(undefined, 'other').dot;
    expect(dot.startsWith('var(')).toBe(true);
    const base = nowCardBase(dot);
    expect(base).toMatch(/^#[0-9a-f]{6}$/i);
    expect(contrastWithWhite(base)).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps class and lunch colours, darkened only as far as white text needs', () => {
    for (const dot of [classColor('algebra').dot, classColor(undefined, 'lunch').dot, '#facc15'])
      expect(contrastWithWhite(nowCardBase(dot)), dot).toBeGreaterThanOrEqual(4.5);
    expect(nowCardBase('#1e3a8a')).toBe('#1e3a8a');
  });
});
