import { describe, expect, it } from 'vitest';
import { contrastWithWhite, heroBase, hexToHsv, hsvToHex } from './color';

describe('color picker conversion', () => {
  it.each(['#000000', '#ffffff', '#808080', '#ff0000', '#00ff00', '#0000ff', '#be185d', '#123456'])('preserves %s through HSV editing', (hex) => {
    expect(hsvToHex(hexToHsv(hex))).toBe(hex);
  });
  it('supports hue changes and the spectrum endpoints', () => {
    expect(hsvToHex({ h: 120, s: 100, v: 100 })).toBe('#00ff00');
    expect(hsvToHex({ h: 240, s: 0, v: 100 })).toBe('#ffffff');
    expect(hsvToHex({ h: 60, s: 100, v: 0 })).toBe('#000000');
  });
});

describe('white text contrast', () => {
  it('matches the WCAG ratios at the extremes and for a known colour', () => {
    expect(contrastWithWhite('#ffffff')).toBeCloseTo(1, 5);
    expect(contrastWithWhite('#000000')).toBeCloseTo(21, 5);
    expect(contrastWithWhite('#d97706')).toBeCloseTo(3.19, 2);
    expect(contrastWithWhite('#fff')).toBeCloseTo(1, 5);
  });

  it('keeps colours that already pass', () => {
    for (const hex of ['#4f46e5', '#7c3aed', '#dc2626', '#c2410c', '#db2777']) expect(heroBase(hex)).toBe(hex);
  });

  it.each(['#d97706', '#65a30d', '#0891b2', '#059669', '#0284c7', '#ca8a04', '#fde047', '#ffffff'])('darkens %s until white reaches 4.5:1', (hex) => {
    const base = heroBase(hex);
    expect(base).toMatch(/^#[0-9a-f]{6}$/);
    expect(contrastWithWhite(base)).toBeGreaterThanOrEqual(4.5);
    expect(base).not.toBe(hex);
  });

  it('darkens only as far as needed', () => {
    for (const hex of ['#d97706', '#65a30d', '#0891b2']) expect(contrastWithWhite(heroBase(hex))).toBeLessThan(5.2);
  });

  it('passes CSS variables and other non-hex values through', () => {
    expect(heroBase('var(--muted-foreground)')).toBe('var(--muted-foreground)');
    expect(heroBase('rgb(0 0 0)')).toBe('rgb(0 0 0)');
  });
});
