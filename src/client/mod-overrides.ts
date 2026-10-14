'use client';

import { useEffect, useState } from 'react';
import { api } from './api';
import { DEFAULT_MOD_OVERRIDES, type ModOverrides } from '@/domain/mods';

const EVENT = 'quasar:mod-overrides';
export function publishModOverrides(overrides: ModOverrides) {
  window.dispatchEvent(new CustomEvent(EVENT, { detail: overrides }));
}

/** Server overrides survive reloads; session choices remain local to the mod menu. */
export function useModOverrides() {
  const [overrides, setOverrides] = useState<ModOverrides>(DEFAULT_MOD_OVERRIDES);
  useEffect(() => {
    let disposed = false;
    let pending = false;
    let generation = 0;
    const refresh = async () => {
      if (pending || document.hidden) return;
      pending = true;
      const started = generation;
      try {
        const next = await api.mods.query();
        if (!disposed && started === generation) setOverrides(previous =>
          Object.keys(next).every(key => next[key as keyof ModOverrides] === previous[key as keyof ModOverrides]) ? previous : next);
      } catch { /* Keep the last server decision while offline; the next poll retries. */ }
      finally { pending = false; }
    };
    const changed = (event: Event) => {
      generation++;
      setOverrides((event as CustomEvent<ModOverrides>).detail);
    };
    const resume = () => { void refresh(); };
    window.addEventListener(EVENT, changed);
    window.addEventListener('focus', resume);
    document.addEventListener('visibilitychange', resume);
    const timer = window.setInterval(resume, 2000);
    resume();
    return () => {
      disposed = true;
      clearInterval(timer);
      window.removeEventListener(EVENT, changed);
      window.removeEventListener('focus', resume);
      document.removeEventListener('visibilitychange', resume);
    };
  }, []);
  return overrides;
}
