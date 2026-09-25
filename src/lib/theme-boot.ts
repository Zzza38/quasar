/**
 * The theme constants and the boot script, without 'use client': server code (the root layout, and the /admin
 * proxy, which allows this exact script by its hash) must read the real string rather than a client reference.
 * src/lib/theme.ts re-exports them for client code.
 */

import type { AccentId } from './theme';

export const DEFAULT_ACCENT: AccentId = 'ocean';
export const APPEARANCE_KEY = 'quasar.appearance';
export const ACCENT_KEY = 'quasar.accent';

/**
 * The page background of each appearance (--background in globals.css). The browser and installed-app
 * bar takes it from the theme-color meta tags, which layout.tsx picks by the OS scheme alone, so every
 * tag is rewritten to the painted appearance; otherwise choosing Light on a dark phone keeps a dark bar.
 */
export const THEME_COLORS = { light: '#f4f5f9', dark: '#0b0d12' } as const;
export const THEME_COLOR_SELECTOR = 'meta[name="theme-color"]';

/** Inline in <head>; must stay dependency-free and tolerate blocked storage. */
export const themeBootScript = `(function(){try{var a=localStorage.getItem(${JSON.stringify(APPEARANCE_KEY)})||'system';var c=localStorage.getItem(${JSON.stringify(ACCENT_KEY)})||${JSON.stringify(DEFAULT_ACCENT)};var d=a==='dark'||(a==='system'&&window.matchMedia('(prefers-color-scheme: dark)').matches);var r=document.documentElement;r.dataset.appearance=d?'dark':'light';r.dataset.appearancePreference=a;r.dataset.accent=c;var m=document.querySelectorAll(${JSON.stringify(THEME_COLOR_SELECTOR)});for(var i=0;i<m.length;i++)m[i].setAttribute('content',d?${JSON.stringify(THEME_COLORS.dark)}:${JSON.stringify(THEME_COLORS.light)});}catch(e){}})();`;
