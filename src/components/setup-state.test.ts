import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checklist, classesStep, clearSetupState, feedStep } from './setup-state';

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (name: string) => values.get(name) ?? null,
    setItem: (name: string, value: string) => { values.set(name, String(value)); },
    removeItem: (name: string) => { values.delete(name); },
    clear: () => values.clear(),
  };
}

describe('clearSetupState', () => {
  beforeEach(() => { vi.stubGlobal('localStorage', memoryStorage()); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('removes every setup flag of the signed-out account and leaves other data alone', () => {
    const me = '11111111-aaaa';
    const other = '22222222-bbbb';
    classesStep.begin(me); feedStep.begin(me); checklist.dismiss(me); checklist.tick('verify', me); checklist.tick('install', me);
    classesStep.begin(other); checklist.tick('verify', other);
    localStorage.setItem('quasar-theme', 'dark');

    clearSetupState(me);

    const keys = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index));
    expect(keys.some((name) => name?.includes(me))).toBe(false);
    expect(classesStep.pending(me)).toBe(false);
    expect(checklist.ticked('verify', me)).toBe(false);
    expect(classesStep.pending(other)).toBe(true);
    expect(checklist.ticked('verify', other)).toBe(true);
    expect(localStorage.getItem('quasar-theme')).toBe('dark');
  });

  it('does nothing when storage is unavailable', () => {
    vi.stubGlobal('localStorage', undefined);
    expect(() => clearSetupState('me')).not.toThrow();
  });
});
