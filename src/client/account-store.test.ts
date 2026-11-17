import { describe, expect, it } from 'vitest';
import { accountStore } from './account-store';

describe('account-owned asynchronous state', () => {
  it('clears every field on a switch and rejects an old response even after switching back', async () => {
    const store = accountStore(() => ({ plan: null as string | null, error: '', estimates: new Map<string, number>() }));
    store.select('A');
    const current = store.capture();
    let resolve!: (value: string) => void;
    const pending = new Promise<string>(done => { resolve = done; }).then(plan => { if (current()) store.update({ plan }); });
    store.update({ plan: 'private task', error: 'private error', estimates: new Map([['private task', 30]]) });
    expect(store.select('B')).toEqual({ plan: null, error: '', estimates: new Map() });
    store.select('A');
    resolve('stale task');
    await pending;
    expect(store.get().plan).toBeNull();
  });

  it('retains state for the same account and invalidates writers on sign-out', () => {
    const store = accountStore(() => ({ merged: [] as string[] }));
    store.select('A');
    const current = store.capture();
    store.update({ merged: ['private title'] });
    expect(store.select('A').merged).toEqual(['private title']);
    expect(current()).toBe(true);
    expect(store.select(null).merged).toEqual([]);
    expect(current()).toBe(false);
  });
});
