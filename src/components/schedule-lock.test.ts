import { describe, expect, it } from 'vitest';
import { emptyPersonalSchedule } from '@/domain/schedule';
import { withDefaultScheduleLock } from './schedule-lock';

describe('default schedule lock', () => {
  it('locks a beta member without changing the saved value or their timetable', () => {
    const saved = emptyPersonalSchedule();
    expect(withDefaultScheduleLock(saved, true)).toEqual({ ...saved, scheduleLocked: true });
    expect(saved.scheduleLocked).toBeUndefined();
  });

  it('respects explicit locked and unlocked choices', () => {
    for (const scheduleLocked of [true, false]) {
      const saved = { ...emptyPersonalSchedule(), scheduleLocked };
      expect(withDefaultScheduleLock(saved, true)).toBe(saved);
    }
  });

  it('keeps nonmembers unchanged', () => {
    const saved = emptyPersonalSchedule();
    expect(withDefaultScheduleLock(saved, false)).toBe(saved);
  });
});
