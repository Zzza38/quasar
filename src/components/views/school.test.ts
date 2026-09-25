import { describe, expect, it } from 'vitest';
import { schoolLocks } from './school';

describe('school lock state', () => {
  it('lets members edit a small unlocked school', () => {
    expect(schoolLocks({ supportLocked: false, memberLocked: false, memberCount: 9 })).toEqual({ locked: false, voting: false });
  });

  it('switches to proposals and votes at 10 members or once member-locked', () => {
    expect(schoolLocks({ supportLocked: false, memberLocked: false, memberCount: 10 })).toEqual({ locked: true, voting: true });
    expect(schoolLocks({ supportLocked: false, memberLocked: true, memberCount: 4 })).toEqual({ locked: true, voting: true });
    expect(schoolLocks({ supportLocked: true, memberLocked: false, memberCount: 25 })).toEqual({ locked: true, voting: true });
  });

  it('locks a small support-locked school without offering proposals the server would reject', () => {
    expect(schoolLocks({ supportLocked: true, memberLocked: false, memberCount: 5 })).toEqual({ locked: true, voting: false });
  });
});
