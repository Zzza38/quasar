export type HSV = { h: number; s: number; v: number };

export function hexToHsv(hex: string): HSV {
  const [r, g, b] = [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16) / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min;
  const hue = !delta ? 0 : max === r ? ((g - b) / delta) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
  return { h: (hue * 60 + 360) % 360, s: max ? delta / max * 100 : 0, v: max * 100 };
}

export function hsvToHex({ h, s, v }: HSV): string {
  const saturation = s / 100, value = v / 100;
  const channel = (n: number) => {
    const k = (n + h / 60) % 6;
    return Math.round(255 * (value - value * saturation * Math.max(0, Math.min(k, 4 - k, 1)))).toString(16).padStart(2, '0');
  };
  return `#${channel(5)}${channel(3)}${channel(1)}`;
}

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
const HERO_SHADE = '#0b1020';

function channels(hex: string): [number, number, number] {
  const full = hex.length === 4 ? `#${[...hex.slice(1)].map((digit) => digit + digit).join('')}` : hex;
  return [1, 3, 5].map((offset) => parseInt(full.slice(offset, offset + 2), 16)) as [number, number, number];
}

/** WCAG relative luminance of a #rgb or #rrggbb colour. */
export function relativeLuminance(hex: string): number {
  const [r, g, b] = channels(hex).map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio of white text on this colour (1 to 21). */
export function contrastWithWhite(hex: string): number {
  return 1.05 / (relativeLuminance(hex) + 0.05);
}

/**
 * Background for white text: the colour itself when white already reaches 4.5:1, otherwise the
 * lightest 5% step of `color-mix(in srgb, hex, #0b1020)` that does. Non-hex input (CSS variables)
 * is returned unchanged.
 */
export function heroBase(hex: string): string {
  if (!HEX.test(hex)) return hex;
  if (contrastWithWhite(hex) >= 4.5) return hex;
  const from = channels(hex);
  const to = channels(HERO_SHADE);
  for (let percent = 95; percent >= 0; percent -= 5) {
    const mixed = `#${from.map((channel, index) => Math.round((channel * percent + to[index] * (100 - percent)) / 100).toString(16).padStart(2, '0')).join('')}`;
    if (contrastWithWhite(mixed) >= 4.5) return mixed;
  }
  return HERO_SHADE;
}
