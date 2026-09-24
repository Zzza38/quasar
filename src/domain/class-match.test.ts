import { describe, expect, it } from 'vitest';
import { classKey, sameClass } from './class-match';

describe('class matching', () => {
  it('treats word order, case, punctuation and honors spellings as the same class', () => {
    for (const name of ['Honors Spanish 2', 'Spanish 2 Honors', 'Spanish 2H', 'spanish  2 – honours', 'SPANISH 2 HON.']) expect(classKey(name)).toBe('2 honors spanish');
    expect(classKey('Pre-AP Computer Science')).toBe('ap computer pre science');
    expect(sameClass({ name: 'Honors Spanish 2' }, { name: 'Spanish 2 Honors' })).toBe(true);
  });
  it('keeps genuinely different classes apart', () => {
    expect(sameClass({ name: 'Spanish 2 Honors' }, { name: 'Spanish 3 Honors' })).toBe(false);
    expect(sameClass({ name: 'Spanish 2 Honors' }, { name: 'Spanish 2' })).toBe(false);
    expect(sameClass({ name: 'Algebra II' }, { name: 'Algebra II and Trigonometry' })).toBe(false);
  });
  it('trusts the school directory over the typed name', () => {
    expect(sameClass({ name: 'Spanish 2 Honors', directoryId: 'd1' }, { name: 'Español 2', directoryId: 'd1' })).toBe(true);
    expect(sameClass({ name: 'Spanish 2 Honors', directoryId: 'd1' }, { name: 'Spanish 2 Honors', directoryId: 'd2' })).toBe(false);
    // A directory class and a hand-typed class still match by name.
    expect(sameClass({ name: 'Spanish 2 Honors', directoryId: 'd1' }, { name: 'Honors Spanish 2' })).toBe(true);
  });
});
