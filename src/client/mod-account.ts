'use client';

import { useEffect, useState } from 'react';
import { api } from './api';

export function useModAccount() {
  const [accountId, setAccountId] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let disposed = false, pending = false, generation = 0;
    const refresh = async () => {
      if (pending || document.hidden) return;
      pending = true;
      const started = generation;
      try {
        const session = await api.session.query();
        if (!disposed && started === generation) setAccountId(session?.user.id ?? null);
      } catch { /* Keep the last verified identity until the next successful check. */ }
      finally { pending = false; }
    };
    const resume = () => { void refresh(); };
    const storage = (event: StorageEvent) => {
      if (event.key !== 'nextauth.message') return;
      generation++;
      setAccountId(undefined);
      resume();
    };
    window.addEventListener('storage', storage);
    window.addEventListener('focus', resume);
    document.addEventListener('visibilitychange', resume);
    const timer = window.setInterval(resume, 2000);
    resume();
    return () => {
      disposed = true;
      clearInterval(timer);
      window.removeEventListener('storage', storage);
      window.removeEventListener('focus', resume);
      document.removeEventListener('visibilitychange', resume);
    };
  }, []);
  return accountId;
}
