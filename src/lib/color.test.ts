import { describe, expect, it } from 'vitest';
import { hexToHsv, hsvToHex } from './color';

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
