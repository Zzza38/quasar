import { afterEach, expect, it, vi } from 'vitest';
import { CHAT_SUBSCRIBER_LIMIT, formatChatEvent, notifyChat, subscribeChat } from './chat-events';

const disposers: (() => void)[] = [];
afterEach(() => { for (const dispose of disposers.splice(0)) dispose(); });
const listen = (...args: Parameters<typeof subscribeChat>) => disposers.push(subscribeChat(...args));

it('fans out to every tab of each selected account, once, and unsubscribes', () => {
  const a = vi.fn(), b = vi.fn(), c = vi.fn();
  listen('alice', a); listen('alice', b); listen('bob', c);
  notifyChat(['alice', 'alice'], { kind: 'peer', key: 'bob' });
  expect(a).toHaveBeenCalledExactlyOnceWith({ kind: 'peer', key: 'bob' });
  expect(b).toHaveBeenCalledTimes(1); expect(c).not.toHaveBeenCalled();
  disposers[0]();
  notifyChat(['alice'], { kind: 'peer', key: 'bob' });
  expect(a).toHaveBeenCalledTimes(1); expect(b).toHaveBeenCalledTimes(2);
});

it('broadcasts global events to all subscribed accounts, with only kind and key', () => {
  const a = vi.fn(), b = vi.fn();
  listen('alice', a); listen('bob', b);
  const event = { kind: 'global' as const, key: 'global', body: 'private text' };
  notifyChat([], event);
  expect(a).toHaveBeenCalledExactlyOnceWith({ kind: 'global', key: 'global' });
  expect(b).toHaveBeenCalledExactlyOnceWith({ kind: 'global', key: 'global' });
});

it('never throws with zero subscribers or when a subscriber throws', () => {
  expect(() => notifyChat(['absent'], { kind: 'peer', key: 'x' })).not.toThrow();
  const good = vi.fn();
  listen('alice', () => { throw new Error('closed stream'); }); listen('alice', good);
  expect(() => notifyChat(['alice'], { kind: 'peer', key: 'x' })).not.toThrow();
  expect(good).toHaveBeenCalledTimes(1);
});

it('caps each account independently and closes the oldest subscriber', () => {
  const oldest = vi.fn(), close = vi.fn(() => { disposers[0](); throw new Error('already closed'); });
  listen('alice', oldest, close);
  for (let i = 0; i < CHAT_SUBSCRIBER_LIMIT; i++) listen('alice', vi.fn());
  const other = vi.fn(); listen('bob', other);
  expect(close).toHaveBeenCalledExactlyOnceWith('capacity');
  notifyChat(['alice', 'bob'], { kind: 'group', key: 'group' });
  expect(oldest).not.toHaveBeenCalled(); expect(other).toHaveBeenCalledTimes(1);
});

it('formats an SSE frame without message data or injected lines', () => {
  expect(formatChatEvent({ kind: 'peer', key: 'id\nother' })).toBe('event: chat\ndata: {"kind":"peer","key":"id\\nother"}\n\n');
});
