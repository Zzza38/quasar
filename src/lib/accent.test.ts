import { describe, expect, it } from 'vitest';
import { customAccentTokens } from './accent';
import { relativeLuminance } from './color';

function contrast(a: string, b: string) {
  const x = relativeLuminance(a), y = relativeLuminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

describe('custom accent contrast', () => {
  it('keeps buttons, soft labels and focus rings readable for extreme colors in both appearances', () => {
    for (const dark of [false, true]) {
      for (const color of ['#ffffff', '#000000', '#ffff00', '#00ff00', '#0000ff', '#ff0000', '#808080', '#facc15']) {
        const tokens = customAccentTokens(color, dark);
        expect(contrast(tokens['--primary'], tokens['--primary-foreground'])).toBeGreaterThanOrEqual(4.5);
        expect(contrast(tokens['--primary-soft'], tokens['--primary-soft-foreground'])).toBeGreaterThanOrEqual(4.5);
        expect(contrast(tokens['--ring'], dark ? '#13161d' : '#f4f5f9')).toBeGreaterThanOrEqual(3);
      }
    }
  });
});
