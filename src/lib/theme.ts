'use client';

import { useCallback, useEffect, useState } from 'react';

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

export const DEFAULT_ACCENT: AccentId = 'ocean';
const APPEARANCE_KEY = 'quasar.appearance';
const ACCENT_KEY = 'quasar.accent';

/** Inline in <head>; must stay dependency-free and tolerate blocked storage. */
export const themeBootScript = `(function(){try{var a=localStorage.getItem(${JSON.stringify(APPEARANCE_KEY)})||'system';var c=localStorage.getItem(${JSON.stringify(ACCENT_KEY)})||${JSON.stringify(DEFAULT_ACCENT)};var d=a==='dark'||(a==='system'&&window.matchMedia('(prefers-color-scheme: dark)').matches);var r=document.documentElement;r.dataset.appearance=d?'dark':'light';r.dataset.appearancePreference=a;r.dataset.accent=c;}catch(e){}})();`;

function isAppearance(value: string | null): value is Appearance { return value === 'system' || value === 'light' || value === 'dark'; }
function isAccent(value: string | null): value is AccentId { return ACCENTS.some((accent) => accent.id === value); }

function readStored(): { appearance: Appearance; accent: AccentId } {
  try {
    const appearance = localStorage.getItem(APPEARANCE_KEY);
    const accent = localStorage.getItem(ACCENT_KEY);
    return { appearance: isAppearance(appearance) ? appearance : 'system', accent: isAccent(accent) ? accent : DEFAULT_ACCENT };
  } catch { return { appearance: 'system', accent: DEFAULT_ACCENT }; }
}

function apply(appearance: Appearance, accent: AccentId): 'light' | 'dark' {
  const dark = appearance === 'dark' || (appearance === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  const root = document.documentElement;
  root.dataset.appearance = dark ? 'dark' : 'light';
  root.dataset.appearancePreference = appearance;
  root.dataset.accent = accent;
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
    const onStorage = (event: StorageEvent) => { if (event.key === null || event.key === APPEARANCE_KEY || event.key === ACCENT_KEY) sync(); };
    const onVisible = () => { if (document.visibilityState === 'visible') sync(); };
    media.addEventListener('change', sync);
    window.addEventListener('storage', onStorage);
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('pageshow', sync);
    sync();
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
  const setAppearance = useCallback((appearance: Appearance) => {
    try { localStorage.setItem(APPEARANCE_KEY, appearance); } catch { /* Private mode; the choice lasts for this page. */ }
    sync();
  }, []);
  const setAccent = useCallback((accent: AccentId) => {
    try { localStorage.setItem(ACCENT_KEY, accent); } catch { /* Private mode; the choice lasts for this page. */ }
    sync();
  }, []);
  return { ...(state ?? DEFAULTS), resolved, setAppearance, setAccent };
}
