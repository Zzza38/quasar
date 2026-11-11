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

const linear = (channel: number) => { const value = channel / 255; return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4; };
const gamma = (value: number) => Math.round(255 * Math.min(1, Math.max(0, value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055)));

/** OKLab lightness and the two colour axes of a #rgb or #rrggbb colour. */
function toOklab(hex: string): [number, number, number] {
  const [r, g, b] = channels(hex).map(linear);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}

/** The sRGB hex of an OKLab colour; channels outside sRGB are clipped. */
function fromOklab(lightness: number, a: number, b: number): string {
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const rgb = [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
  return `#${rgb.map((value) => gamma(value).toString(16).padStart(2, '0')).join('')}`;
}

/** Lightness the hue is taken at before it is mixed into white, and the most colour it may carry there. */
const TINT_LIGHTNESS = 0.72;
const TINT_CHROMA = 0.21;

/**
 * White with `amount` (0 to 1) of a colour's hue mixed in, for a light fill that sits on that colour: the Now card's
 * progress bar. The hue is taken at one fixed lightness, so fills over a dark class colour and a bright one come out
 * equally light; mixing in the colour itself would make the fill follow the background and read as see-through.
 * Greys stay grey. Non-hex input (CSS variables) gives plain white.
 */
export function barTint(hex: string, amount = 0.35): string {
  if (!HEX.test(hex)) return '#ffffff';
  const [, a, b] = toOklab(hex);
  const chroma = Math.hypot(a, b);
  if (chroma < 1e-4) return fromOklab(1 - amount * (1 - TINT_LIGHTNESS), 0, 0);
  // Dull class colours (a dark teal) are brought up to a full tint; near-greys keep little colour.
  const scale = Math.min(TINT_CHROMA, chroma * 2.4) / chroma * amount;
  return fromOklab(1 - amount * (1 - TINT_LIGHTNESS), a * scale, b * scale);
}
