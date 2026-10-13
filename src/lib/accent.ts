export const ACCENT_IDS = ['ocean', 'indigo', 'grape', 'forest', 'sunset', 'rose', 'graphite'] as const;
export type PresetAccentId = typeof ACCENT_IDS[number];
export type AccentId = PresetAccentId | `#${string}`;

export function isCustomAccent(value: string | null): value is `#${string}` {
  return value !== null && /^#[\da-f]{6}$/i.test(value);
}

export function isAccent(value: string | null): value is AccentId {
  return isCustomAccent(value) || ACCENT_IDS.some((id) => id === value);
}

/** Self-contained so the same palette calculation can run in the pre-paint script. */
export function customAccentTokens(hex: string, dark: boolean): Record<string, string> {
  const mix = (from: string, to: string, amount: number) => '#' + [1, 3, 5].map((offset) =>
    Math.round(parseInt(from.slice(offset, offset + 2), 16) * (1 - amount) + parseInt(to.slice(offset, offset + 2), 16) * amount).toString(16).padStart(2, '0')).join('');
  const luminance = (color: string) => {
    const [r, g, b] = [1, 3, 5].map((offset) => {
      const channel = parseInt(color.slice(offset, offset + 2), 16) / 255;
      return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const contrast = (a: string, b: string) => {
    const x = luminance(a), y = luminance(b);
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  };
  const readable = (color: string, background: string) => {
    const target = dark ? '#ffffff' : '#000000';
    for (let step = 0; step <= 100; step++) {
      const candidate = mix(color, target, step / 100);
      if (contrast(candidate, background) >= 4.5) return candidate;
    }
    return target;
  };
  const foreground = dark ? '#0b0d12' : '#ffffff';
  const primary = readable(hex, foreground);
  const soft = mix(primary, dark ? '#13161d' : '#ffffff', dark ? 0.78 : 0.9);
  return {
    '--primary': primary,
    '--primary-foreground': foreground,
    '--primary-soft': soft,
    '--primary-soft-foreground': readable(primary, soft),
    '--ring': primary,
  };
}

export const CUSTOM_ACCENT_PROPERTIES = ['--primary', '--primary-foreground', '--primary-soft', '--primary-soft-foreground', '--ring'] as const;
