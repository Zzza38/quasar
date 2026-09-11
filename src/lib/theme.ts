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

export function useTheme() {
  const [state, setState] = useState<{ appearance: Appearance; accent: AccentId }>({ appearance: 'system', accent: DEFAULT_ACCENT });
  const [resolved, setResolved] = useState<'light' | 'dark'>('light');
  useEffect(() => { setState(readStored()); }, []);
  useEffect(() => {
    setResolved(apply(state.appearance, state.accent));
    if (state.appearance !== 'system') return;
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => setResolved(apply('system', state.accent));
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [state]);
  const setAppearance = useCallback((appearance: Appearance) => {
    try { localStorage.setItem(APPEARANCE_KEY, appearance); } catch { /* Private mode; the choice lasts for this page. */ }
    setState((current) => ({ ...current, appearance }));
  }, []);
  const setAccent = useCallback((accent: AccentId) => {
    try { localStorage.setItem(ACCENT_KEY, accent); } catch { /* Private mode; the choice lasts for this page. */ }
    setState((current) => ({ ...current, accent }));
  }, []);
  return { ...state, resolved, setAppearance, setAccent };
}
