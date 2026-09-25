import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Storage = { getItem: (key: string) => string | null; setItem: (key: string, value: string) => void };

/** A theme-color meta tag as layout.tsx emits it, one per OS colour scheme. */
function meta(content: string) {
  const attributes: Record<string, string> = { name: 'theme-color', content };
  return { attributes, setAttribute: (name: string, value: string) => { attributes[name] = value; } };
}

/** A browser-like page with the given localStorage and OS scheme, and a fresh copy of the theme module. */
async function page(storage: Storage, osDark = false) {
  const dataset: Record<string, string> = {};
  const metas = [meta('#f4f5f9'), meta('#0b0d12')];
  vi.stubGlobal('localStorage', storage);
  vi.stubGlobal('document', { documentElement: { dataset }, querySelectorAll: (selector: string) => selector === 'meta[name="theme-color"]' ? metas : [] });
  vi.stubGlobal('window', { matchMedia: () => ({ matches: osDark }), dispatchEvent: () => true });
  vi.stubGlobal('CustomEvent', class { constructor(readonly type: string) {} });
  vi.resetModules();
  return { theme: await import('./theme'), dataset, colors: () => metas.map((tag) => tag.attributes.content) };
}

const blocked: Storage = {
  getItem: () => { throw new DOMException('The operation is insecure.', 'SecurityError'); },
  setItem: () => { throw new DOMException('The operation is insecure.', 'SecurityError'); },
};

function memoryStorage(initial: Record<string, string> = {}, full = false): Storage & { values: Record<string, string> } {
  const values = { ...initial };
  return {
    values,
    getItem: (key) => values[key] ?? null,
    setItem: (key, value) => { if (full) throw new DOMException('Quota exceeded.', 'QuotaExceededError'); values[key] = value; },
  };
}

describe('theme choice', () => {
  beforeEach(() => { vi.unstubAllGlobals(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('stores and paints a choice when storage works', async () => {
    const storage = memoryStorage();
    const { theme, dataset } = await page(storage);
    theme.saveAccent('rose');
    theme.saveAppearance('dark');
    expect(storage.values).toEqual({ 'quasar.accent': 'rose', 'quasar.appearance': 'dark' });
    expect(dataset).toMatchObject({ accent: 'rose', appearance: 'dark', appearancePreference: 'dark' });
  });

  it('still applies the choice for this page when site storage is blocked', async () => {
    const { theme, dataset } = await page(blocked);
    theme.saveAccent('grape');
    theme.saveAppearance('dark');
    expect(dataset).toMatchObject({ accent: 'grape', appearance: 'dark' });
    expect(theme.readStored()).toEqual({ appearance: 'dark', accent: 'grape' });
  });

  it('points the browser bar colour at the chosen appearance, not the OS scheme', async () => {
    const { theme, colors } = await page(memoryStorage(), true);
    theme.saveAppearance('light');
    expect(colors()).toEqual(['#f4f5f9', '#f4f5f9']);
    theme.saveAppearance('dark');
    expect(colors()).toEqual(['#0b0d12', '#0b0d12']);
    theme.saveAppearance('system');
    expect(colors()).toEqual(['#0b0d12', '#0b0d12']);
  });

  it('sets the bar colour from the stored appearance before the first paint', async () => {
    const { theme, dataset, colors } = await page(memoryStorage({ 'quasar.appearance': 'dark' }));
    new Function(theme.themeBootScript)();
    expect(dataset.appearance).toBe('dark');
    expect(colors()).toEqual(['#0b0d12', '#0b0d12']);
  });

  it('applies the new choice over the old stored one when the storage quota is full', async () => {
    const { theme, dataset } = await page(memoryStorage({ 'quasar.accent': 'forest', 'quasar.appearance': 'light' }, true));
    expect(theme.readStored()).toEqual({ appearance: 'light', accent: 'forest' });
    theme.saveAccent('sunset');
    expect(dataset.accent).toBe('sunset');
    expect(theme.readStored()).toEqual({ appearance: 'light', accent: 'sunset' });
  });
});
