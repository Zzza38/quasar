import { describe, expect, it } from 'vitest';
import { barTint, contrastWithWhite, heroBase, hexToHsv, hsvToHex, relativeLuminance } from './color';

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

describe('bar tint', () => {
  it('keeps the hue of the colour underneath', () => {
    const channels = (hex: string) => [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16));
    const [indigoRed, , indigoBlue] = channels(barTint('#4f46e5'));
    expect(indigoBlue).toBeGreaterThan(indigoRed);
    const [tealRed, tealGreen] = channels(barTint('#0f766e'));
    expect(tealGreen).toBeGreaterThan(tealRed);
    const [red, green] = channels(barTint('#dc2626'));
    expect(red).toBeGreaterThan(green);
  });

  it('comes out equally light over a dark colour and a bright one', () => {
    const tints = ['#4f46e5', '#0f766e', '#dc2626', '#d97706', '#0284c7', '#3d4453', '#111827'].map((hex) => relativeLuminance(barTint(hex)));
    for (const luminance of tints) expect(luminance).toBeGreaterThan(0.6);
    expect(Math.max(...tints) - Math.min(...tints)).toBeLessThan(0.16);
  });

  it('tints a dull colour as much as a vivid one, and leaves greys grey', () => {
    const spread = (hex: string) => { const values = [1, 3, 5].map((offset) => parseInt(barTint(hex).slice(offset, offset + 2), 16)); return Math.max(...values) - Math.min(...values); };
    expect(spread('#0f766e')).toBeGreaterThan(40);
    expect(spread('#808080')).toBe(0);
    expect(spread('#000000')).toBe(0);
  });

  it('gets whiter as the amount drops, and is plain white for values that are not hex', () => {
    expect(barTint('#4f46e5', 0)).toBe('#ffffff');
    expect(relativeLuminance(barTint('#4f46e5', 0.14))).toBeGreaterThan(relativeLuminance(barTint('#4f46e5', 0.6)));
    expect(barTint('var(--muted-foreground)')).toBe('#ffffff');
  });
});
