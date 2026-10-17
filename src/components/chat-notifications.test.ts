import { describe, expect, it } from 'vitest';
import { nudgeReason, snoozed } from './chat-notifications';

const on = { supported: true, config: { enabled: true }, permission: 'granted' as NotificationPermission, enrolled: true, chatPush: true };

describe('notifications nudge', () => {
  it('stays quiet when everything is on, or when the server cannot push at all', () => {
    expect(nudgeReason(on)).toBeNull();
    expect(nudgeReason({ ...on, config: { enabled: false }, chatPush: false })).toBeNull();
    expect(nudgeReason({ ...on, config: null, permission: 'default' })).toBeNull();
  });
  it('names what is off on this device, most fundamental first', () => {
    expect(nudgeReason({ ...on, supported: false })).toBe('unsupported');
    expect(nudgeReason({ ...on, permission: 'denied' })).toBe('denied');
    expect(nudgeReason({ ...on, chatPush: false })).toBe('switched-off');
    expect(nudgeReason({ ...on, permission: 'default' })).toBe('permission');
    expect(nudgeReason({ ...on, enrolled: false })).toBe('unsubscribed');
    expect(nudgeReason({ ...on, enrolled: null })).toBeNull();
  });
  it('rests for the stored day and ignores garbage', () => {
    const now = Date.now();
    expect(snoozed(String(now + 60_000), now)).toBe(true);
    expect(snoozed(String(now - 1), now)).toBe(false);
    expect(snoozed(null, now)).toBe(false);
    expect(snoozed('yesterday', now)).toBe(false);
  });
});
