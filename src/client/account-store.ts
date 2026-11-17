/** A tab-local store whose async writers expire on every account transition, including A → B → A. */
export function accountStore<T>(empty: () => T) {
  let owner: string | null = null;
  let generation = 0;
  let value = empty();
  const listeners = new Set<() => void>();
  return {
    select(accountId: string | null) {
      if (owner !== accountId) { owner = accountId; generation++; value = empty(); }
      return value;
    },
    capture() { const current = generation; return () => current === generation; },
    get: () => value,
    update(next: Partial<T>) { value = { ...value, ...next }; listeners.forEach(listener => listener()); },
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}
