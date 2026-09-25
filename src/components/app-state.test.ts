import { describe, expect, it, vi } from 'vitest';
import { emptyPersonalSchedule, type PersonalSchedule } from '@/domain/schedule';
import type { Workspace } from '@/client/api';
import { exampleSchedule } from '@/domain/example';
import type { Task } from '@/domain/task';
import { cachedContext, clockTime, isOverdue, openBellTimes, persistedContext, personalSaver, storedContext, taskItems, UNREADABLE_PERSONAL, upgradedContext, withClassmates } from './app-state';

describe('personalSaver', () => {
  it('refuses every save while the saved personal schedule is unreadable, so its empty fallback never replaces it', async () => {
    const save = vi.fn(async (_personal: PersonalSchedule) => {});
    const savePersonal = personalSaver(false, save);
    await expect(savePersonal({ ...emptyPersonalSchedule(), grade: '9' })).rejects.toThrow(UNREADABLE_PERSONAL);
    expect(save).not.toHaveBeenCalled();
  });

  it('saves the validated document when the saved copy was readable', async () => {
    const save = vi.fn(async (_personal: PersonalSchedule) => {});
    const next = { ...emptyPersonalSchedule(), grade: '9' as const, classes: [{ id: 'algebra', name: 'Algebra' }] };
    await personalSaver(true, save)(next);
    expect(save).toHaveBeenCalledWith(next);
  });

  it('rejects instead of throwing synchronously when the document is invalid', async () => {
    const save = vi.fn(async (_personal: PersonalSchedule) => {});
    const invalid = { ...emptyPersonalSchedule(), unexpected: true } as unknown as PersonalSchedule;
    const result = personalSaver(true, save)(invalid);
    await expect(result).rejects.toThrow();
    expect(save).not.toHaveBeenCalled();
  });
});

describe('persistedContext', () => {
  const classmates = [{ id: 'friend-1', displayName: 'Maya Marker', classes: [{ periodId: 'A', name: 'zebra biology marker', key: 'biology marker zebra' }] }];
  const workspace = {
    user: { id: 'me' }, school: null, entities: [{ id: 'task-1' }], review: null, isAdmin: false, subscriptions: [], importConflicts: [],
    community: { verification: { status: 'verified', method: 'domain' }, incomingRequests: 1, friendCount: 1, classmates, unreadChats: 0, unreadAt: '2026-09-01T00:00:00.000Z', chatPush: true },
  } as unknown as Workspace;

  it('keeps friend names and class lists out of the copy saved on the device', () => {
    const saved = persistedContext(workspace);
    const text = JSON.stringify(saved);
    expect(text).not.toContain('Maya Marker');
    expect(text).not.toContain('zebra biology marker');
    expect(text).not.toContain('task-1');
    expect(saved.community).toEqual({ ...workspace.community, classmates: [] });
    // The server response itself is left alone for the in-memory copy.
    expect(workspace.community.classmates).toBe(classmates);
  });

  it('puts the in-memory classmates back for the views', () => {
    const shown = withClassmates(persistedContext(workspace), classmates);
    expect(shown.community.classmates).toEqual(classmates);
    expect(shown.community.friendCount).toBe(1);
  });

  it('reads back a context saved by this build', () => {
    const saved = storedContext(workspace);
    expect(JSON.stringify(saved)).not.toContain('Maya Marker');
    expect(cachedContext(structuredClone(saved))).toEqual(persistedContext(workspace));
  });

  it('ignores a context saved by an older build in another shape instead of rendering it', () => {
    // Saved before user.suggestedNames existed: reading it as the current shape crashed the names step.
    const legacy = { ...persistedContext(workspace), user: { id: 'me', displayName: '', fullName: '' } } as unknown as Record<string, unknown>;
    expect(cachedContext(legacy)).toBeNull();
    expect(cachedContext({ ...storedContext(workspace), contextVersion: 1 })).toBeNull();
    expect(cachedContext(null)).toBeNull();
    expect(upgradedContext(legacy)).toBeNull();
  });

  it('reads a context the build before CONTEXT_VERSION saved, without its friends, and re-saves it stamped', () => {
    // That build saved the whole workspace context unversioned (friends' timetables included) with suggestedNames.
    const { entities: _entities, ...unversioned } = structuredClone({ ...workspace, user: { id: 'me', displayName: 'Maya', fullName: 'Maya Chen', suggestedNames: { displayName: 'Maya', fullName: 'Maya Chen' } } });
    const saved = unversioned as unknown as Record<string, unknown>;
    const read = cachedContext(saved);
    expect(read).not.toBeNull();
    expect(read!.user.suggestedNames).toEqual({ displayName: 'Maya', fullName: 'Maya Chen' });
    expect(read!.community.friendCount).toBe(1);
    expect(JSON.stringify(read)).not.toContain('Maya Marker');
    const upgraded = upgradedContext(saved);
    expect(upgraded).not.toBeNull();
    expect(JSON.stringify(upgraded)).not.toContain('zebra biology marker');
    expect(cachedContext(upgraded)).toEqual(read);
    // Once stamped there is nothing left to upgrade.
    expect(upgradedContext(upgraded)).toBeNull();
    expect(upgradedContext(storedContext(workspace))).toBeNull();
  });
});

describe('isOverdue', () => {
  const task = (changes: Partial<Task>): Task => ({ title: 'Essay', dueDate: '2026-09-24', dueTime: null, classId: null, notes: '', completed: false, ...changes });
  const now = clockTime(new Date('2026-09-24T14:00:00Z'), 'America/New_York');

  it('reads the clock in the school zone', () => {
    expect(now).toBe('10:00');
  });

  it('counts a past due date, or a due time earlier today that has passed, and nothing else', () => {
    expect(isOverdue(task({ dueDate: '2026-09-23' }), '2026-09-24', now)).toBe(true);
    // Due today at 8:00, seen at 10:00: the row, the Today tile and the Tasks groups all call it overdue.
    expect(isOverdue(task({ dueTime: '08:00' }), '2026-09-24', now)).toBe(true);
    expect(isOverdue(task({ dueTime: '10:00' }), '2026-09-24', now)).toBe(false);
    expect(isOverdue(task({ dueTime: null }), '2026-09-24', now)).toBe(false);
    expect(isOverdue(task({ dueDate: '2026-09-25', dueTime: '08:00' }), '2026-09-24', now)).toBe(false);
    expect(isOverdue(task({ dueDate: null }), '2026-09-24', now)).toBe(false);
    expect(isOverdue(task({ dueDate: '2026-09-23', completed: true }), '2026-09-24', now)).toBe(false);
  });
});

describe('openBellTimes', () => {
  it('sends students with a private schedule to it, since school corrections do not change what they see', () => {
    const navigate = vi.fn();
    openBellTimes({ personal: emptyPersonalSchedule(), navigate });
    expect(navigate).toHaveBeenLastCalledWith('school', { fix: 'times' });
    openBellTimes({ personal: { ...emptyPersonalSchedule(), customSchedule: exampleSchedule }, navigate });
    expect(navigate).toHaveBeenLastCalledWith('classes', { private: 'open' });
  });
});

describe('taskItems', () => {
  it('shows a task saved with an out-of-range year without that date, and still skips unreadable ones', () => {
    const base = { title: 'Old', dueTime: null, classId: null, notes: '', completed: false };
    const items = taskItems([
      { id: 'far', kind: 'task', version: 1, deleted: false, data: { ...base, dueDate: '2300-05-01' } },
      { id: 'broken', kind: 'task', version: 1, deleted: false, data: { ...base, title: '' } },
    ]);
    expect(items.map(item => [item.id, item.task.dueDate])).toEqual([['far', null]]);
  });
});
