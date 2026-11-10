import { describe, expect, it } from 'vitest';
import { MAX_GAP_SHARE, MIN_NEXT_SHARE, nowSplit } from './now-split';

const MIN = 60_000;
// A 45 minute period, 5 minutes of passing, then the next period.
const period = { start: 0, end: 45 * MIN, nextStart: 50 * MIN };

describe('nowSplit', () => {
  it('gives the next period a sliver when the current one has just begun', () => {
    const split = nowSplit({ ...period, now: 1 * MIN })!;
    expect(split.phase).toBe('class');
    expect(split.gap).toBeCloseTo(10);
    expect(split.next).toBe(MIN_NEXT_SHARE);
    expect(split.progress).toBeCloseTo(100 / 45);
    expect(split.gapMinutes).toBe(5);
  });

  it('grows the next period with the clock and keeps the grey part the length of the passing time', () => {
    const split = nowSplit({ ...period, now: 27 * MIN })!;
    expect(split.gap).toBeCloseTo(10);
    expect(split.next).toBeCloseTo(54);
    expect(split.progress).toBeCloseTo(60);
  });

  it('leaves the current period nothing as it ends', () => {
    const split = nowSplit({ ...period, now: 45 * MIN - 1 })!;
    expect(split.phase).toBe('class');
    expect(split.gap + split.next).toBeCloseTo(100, 3);
  });

  it('shrinks the grey part through the passing time and gives the rest to the next period', () => {
    const split = nowSplit({ ...period, now: 47 * MIN })!;
    expect(split).toMatchObject({ phase: 'passing', progress: 100, gapMinutes: 3 });
    expect(split.gap).toBeCloseTo(6);
    expect(split.next).toBeCloseTo(94);
  });

  it('has no grey part when the periods run back to back', () => {
    const split = nowSplit({ start: 0, end: 45 * MIN, nextStart: 45 * MIN, now: 15 * MIN })!;
    expect(split.gap).toBe(0);
    expect(split.next).toBeCloseTo(100 / 3);
    expect(nowSplit({ start: 0, end: 45 * MIN, nextStart: 45 * MIN, now: 45 * MIN })).toBeNull();
  });

  it('caps the grey part of a long break and still fills the card at the end of the period', () => {
    const long = { start: 0, end: 45 * MIN, nextStart: 135 * MIN };
    const middle = nowSplit({ ...long, now: 30 * MIN })!;
    expect(middle.gap).toBe(MAX_GAP_SHARE);
    expect(middle.next).toBeCloseTo((100 - MAX_GAP_SHARE) * 2 / 3);
    const passing = nowSplit({ ...long, now: 90 * MIN })!;
    expect(passing.gap).toBeCloseTo(MAX_GAP_SHARE / 2);
    expect(passing.gapMinutes).toBe(45);
  });

  it('treats overlapping periods as back to back', () => {
    const split = nowSplit({ start: 0, end: 50 * MIN, nextStart: 45 * MIN, now: 15 * MIN })!;
    expect(split.gap).toBe(0);
    expect(split.progress).toBeCloseTo(100 / 3);
  });

  it('returns null outside the span and for times that make no span', () => {
    expect(nowSplit({ ...period, now: -1 })).toBeNull();
    expect(nowSplit({ ...period, now: 50 * MIN })).toBeNull();
    expect(nowSplit({ start: 10, end: 10, nextStart: 20, now: 10 })).toBeNull();
    expect(nowSplit({ ...period, now: Number.NaN })).toBeNull();
  });
});
