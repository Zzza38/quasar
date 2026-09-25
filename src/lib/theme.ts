'use client';

import { useEffect, useState } from 'react';

/**
 * Appearance and accent are device preferences stored in localStorage so they
 * work before sign-in and offline. `themeBootScript` applies them before the
 * first paint; `useTheme` keeps React in sync afterwards.
 */

export type Appearance = 'system' | 'light' | 'dark';
export type AccentId = 'ocean' | 'indigo' | 'grape' | 'forest' | 'sunset' | 'rose' | 'graphite';

export const ACCENTS: ReadonlyArray<{ id: AccentId; label: string; swatch: string }> = [
  { id: 'ocean', label: 'Ocean', swatch: '#0e7490' },
  { id: 'indigo', label: 'Indigo', swatch: '#4f46e5' },
  { id: 'grape', label: 'Grape', swatch: '#7e22ce' },
  { id: 'forest', label: 'Forest', swatch: '#15803d' },
  { id: 'sunset', label: 'Sunset', swatch: '#c2410c' },
  { id: 'rose', label: 'Rose', swatch: '#be185d' },
  { id: 'graphite', label: 'Graphite', swatch: '#334155' },
];

import { ACCENT_KEY, APPEARANCE_KEY, DEFAULT_ACCENT, THEME_COLORS, THEME_COLOR_SELECTOR, themeBootScript } from './theme-boot';
export { DEFAULT_ACCENT, THEME_COLORS, themeBootScript };

function isAppearance(value: string | null): value is Appearance { return value === 'system' || value === 'light' || value === 'dark'; }
function isAccent(value: string | null): value is AccentId { return ACCENTS.some((accent) => accent.id === value); }

type ThemeChoice = { appearance: Appearance; accent: AccentId };

/**
 * A choice storage refused (site data blocked, or the quota full). It is kept here and wins over
 * what storage holds, so the choice still applies for the life of this page.
 */
const unsaved: Partial<ThemeChoice> = {};

/** The current choice: what this page could not save, else what storage holds, else the defaults. */
export function readStored(): ThemeChoice {
  let appearance: string | null = null;
  let accent: string | null = null;
  try {
    appearance = localStorage.getItem(APPEARANCE_KEY);
    accent = localStorage.getItem(ACCENT_KEY);
  } catch { /* Storage is blocked; fall back to this page's choice or the defaults. */ }
  return {
    appearance: unsaved.appearance ?? (isAppearance(appearance) ? appearance : 'system'),
    accent: unsaved.accent ?? (isAccent(accent) ? accent : DEFAULT_ACCENT),
  };
}

function save<K extends keyof ThemeChoice>(field: K, key: string, value: ThemeChoice[K]): void {
  try { localStorage.setItem(key, value); delete unsaved[field]; } catch { unsaved[field] = value; }
  sync();
}

/** Stores and paints an appearance choice. */
export function saveAppearance(appearance: Appearance): void { save('appearance', APPEARANCE_KEY, appearance); }
/** Stores and paints an accent choice. */
export function saveAccent(accent: AccentId): void { save('accent', ACCENT_KEY, accent); }

function apply(appearance: Appearance, accent: AccentId): 'light' | 'dark' {
  const dark = appearance === 'dark' || (appearance === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  const root = document.documentElement;
  root.dataset.appearance = dark ? 'dark' : 'light';
  root.dataset.appearancePreference = appearance;
  root.dataset.accent = accent;
  document.querySelectorAll(THEME_COLOR_SELECTOR).forEach((meta) => meta.setAttribute('content', THEME_COLORS[dark ? 'dark' : 'light']));
  return dark ? 'dark' : 'light';
}

const THEME_EVENT = 'quasar:theme';
const DEFAULTS = { appearance: 'system' as Appearance, accent: DEFAULT_ACCENT };

/** Re-reads the stored choice and paints it. Every path that can change the theme ends here. */
function sync(): void {
  const stored = readStored();
  apply(stored.appearance, stored.accent);
  window.dispatchEvent(new CustomEvent(THEME_EVENT));
}

/**
 * Keeps the painted theme in step with the stored one for the whole life of the page, not
 * just while a picker is mounted: the OS flipping to dark at sunset, a change made in another
 * tab, or an installed app being resumed after a long time in the background.
 */
export function ThemeSync() {
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onStorage = (event: StorageEvent) => {
      if (event.key !== null && event.key !== APPEARANCE_KEY && event.key !== ACCENT_KEY) return;
      // Another tab saved a newer choice, which replaces one this page could not save.
      if (event.key === null || event.key === APPEARANCE_KEY) delete unsaved.appearance;
      if (event.key === null || event.key === ACCENT_KEY) delete unsaved.accent;
      sync();
    };
    const onVisible = () => { if (document.visibilityState === 'visible') sync(); };
    media.addEventListener('change', sync);
    window.addEventListener('storage', onStorage);
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('pageshow', sync);
    sync();
    // Pages are rendered by the server, so controls are visible before React has attached its handlers; this marks
    // the moment they are interactive (the browser tests wait for it before typing into a freshly loaded page).
    document.documentElement.dataset.hydrated = 'true';
    return () => {
      media.removeEventListener('change', sync);
      window.removeEventListener('storage', onStorage);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('pageshow', sync);
    };
  }, []);
  return null;
}

export function useTheme() {
  // Null until the stored choice has been read, so the first paint never applies the defaults over it.
  const [state, setState] = useState<{ appearance: Appearance; accent: AccentId } | null>(null);
  const [resolved, setResolved] = useState<'light' | 'dark'>('light');
  useEffect(() => {
    const load = () => { const stored = readStored(); setState(stored); setResolved(apply(stored.appearance, stored.accent)); };
    load();
    window.addEventListener(THEME_EVENT, load);
    return () => window.removeEventListener(THEME_EVENT, load);
  }, []);
  return { ...(state ?? DEFAULTS), resolved, setAppearance: saveAppearance, setAccent: saveAccent };
}
