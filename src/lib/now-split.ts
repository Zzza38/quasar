/**
 * Geometry of Today's split Now card (NowSplitCard in components/views/today.tsx). The card stands for the time from
 * one period's start to the next period's start: the period that is on keeps what is left of it, a grey part is the
 * time between the two, and the next period grows from the far edge as the clock runs.
 */

/** Largest share of the card the grey part may take, so a long break does not crowd out both classes. */
export const MAX_GAP_SHARE = 30;
/** The next period's share when the current one has only just begun: a sliver of colour, no text. */
export const MIN_NEXT_SHARE = 2.5;

export interface NowSplit {
  /** `class`: a period is on. `passing`: it has ended and the next one has not begun. */
  phase: 'class' | 'passing';
  /** Share of the card (0 to 100) for the grey part. */
  gap: number;
  /** Share of the card for the next period. During `passing` it takes everything the grey part leaves. */
  next: number;
  /** How much of the current period is over, 0 to 100. 100 during `passing`. */
  progress: number;
  /** Whole minutes between the two periods still to come, rounded up. */
  gapMinutes: number;
}

/**
 * Shares for the moment `now`, all four in epoch milliseconds: `start` and `end` of the period that is on or has just
 * ended, and `nextStart` of the one after it. Null when the moment is outside start..nextStart or the times make no span.
 */
export function nowSplit({ start, end, nextStart, now }: { start: number; end: number; nextStart: number; now: number }): NowSplit | null {
  if (![start, end, nextStart, now].every(Number.isFinite)) return null;
  // Periods that overlap leave no time between them.
  const gapStart = Math.min(end, nextStart);
  if (gapStart <= start || now < start || now >= nextStart) return null;
  const span = nextStart - start;
  const gapMs = nextStart - gapStart;
  const fullGap = Math.min(MAX_GAP_SHARE, gapMs / span * 100);
  if (now < gapStart) {
    const done = (now - start) / (gapStart - start);
    return { phase: 'class', gap: fullGap, next: Math.max(MIN_NEXT_SHARE, done * (100 - fullGap)), progress: done * 100, gapMinutes: Math.ceil(gapMs / 60_000) };
  }
  const left = nextStart - now;
  const gap = left / gapMs * fullGap;
  return { phase: 'passing', gap, next: 100 - gap, progress: 100, gapMinutes: Math.ceil(left / 60_000) };
}
