'use client';

import { useEffect, useState } from 'react';
import { api } from './api';
import { DEFAULT_MOD_OVERRIDES, type ModOverrides } from '@/domain/mods';

const EVENT = 'quasar:mod-overrides';
export function publishModOverrides(accountId: string, overrides: ModOverrides) {
  window.dispatchEvent(new CustomEvent(EVENT, { detail: { accountId, overrides } }));
}

/** Server overrides survive reloads; session choices remain local to the mod menu. */
export function useModOverrides(accountId: string | null | undefined) {
  const [snapshot, setSnapshot] = useState<{ accountId: string | null | undefined; overrides: ModOverrides }>({ accountId, overrides: DEFAULT_MOD_OVERRIDES });
  useEffect(() => {
    setSnapshot({ accountId, overrides: DEFAULT_MOD_OVERRIDES });
    if (!accountId) return;
    let disposed = false;
    let pending = false;
    let generation = 0;
    const refresh = async () => {
      if (pending || document.hidden) return;
      pending = true;
      const started = generation;
      try {
        const next = await api.mods.query();
        if (!disposed && started === generation && next.accountId === accountId) {
          setSnapshot(previous => Object.keys(next.overrides).every(key => next.overrides[key as keyof ModOverrides] === previous.overrides[key as keyof ModOverrides]) ? previous : { accountId, overrides: next.overrides });
        }
      } catch { /* Keep the last server decision while offline; the next poll retries. */ }
      finally { pending = false; }
    };
    const changed = (event: Event) => {
      const detail = (event as CustomEvent<{ accountId: string; overrides: ModOverrides }>).detail;
      if (detail.accountId !== accountId) return;
      generation++;
      setSnapshot({ accountId, overrides: detail.overrides });
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
  }, [accountId]);
  return snapshot.accountId === accountId ? snapshot.overrides : DEFAULT_MOD_OVERRIDES;
}
