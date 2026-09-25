import { describe, expect, it } from 'vitest';
import { nextBoardError, type BoardError, type BoardErrorEvent } from './proposals';

const replay = (events: BoardErrorEvent[], start: BoardError = null) => events.reduce(nextBoardError, start);
const closed = 'Voting on this proposal has closed.';

describe('proposal board error', () => {
  it('keeps why a vote failed through the reloads that follow, including the one a new revision triggers', () => {
    const shown = replay([{ type: 'action-start' }, { type: 'action-failed', text: closed }, { type: 'loaded' }, { type: 'loaded' }]);
    expect(shown?.text).toBe(closed);
  });

  it('does not let a failed reload replace why a vote failed', () => {
    const shown = replay([{ type: 'action-failed', text: closed }, { type: 'load-failed', text: 'Network error' }]);
    expect(shown?.text).toBe(closed);
  });

  it('clears the failure when the student acts again', () => {
    expect(replay([{ type: 'action-failed', text: closed }, { type: 'action-start' }])).toBeNull();
  });

  it('shows a failed reload until a reload succeeds', () => {
    const failed = replay([{ type: 'load-failed', text: 'Network error' }]);
    expect(failed?.text).toBe('Network error');
    expect(nextBoardError(failed, { type: 'loaded' })).toBeNull();
  });

  it('replaces a failed reload with a later action failure', () => {
    expect(replay([{ type: 'load-failed', text: 'Network error' }, { type: 'action-failed', text: closed }])?.text).toBe(closed);
  });
});
