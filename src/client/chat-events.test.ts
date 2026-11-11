import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { connectChatEvents } from './chat-events';

class FakeSource extends EventTarget {
  static CLOSED = 2;
  static instances: FakeSource[] = [];
  readyState = 0;
  onopen?: () => void;
  onerror?: () => void;
  close = vi.fn(() => { this.readyState = FakeSource.CLOSED; });
  constructor(readonly url: string) { super(); FakeSource.instances.push(this); }
  open() { this.readyState = 1; this.onopen?.(); }
  fail(state: number) { this.readyState = state; this.onerror?.(); }
  message(data: string) { this.dispatchEvent(new MessageEvent('chat', { data })); }
}
let page: EventTarget & { hidden: boolean };
let dispose: (() => void) | undefined;
beforeEach(() => {
  vi.useFakeTimers();
  FakeSource.instances = [];
  page = Object.assign(new EventTarget(), { hidden: false });
  vi.stubGlobal('window', {});
  vi.stubGlobal('document', page);
  vi.stubGlobal('EventSource', FakeSource);
});
afterEach(() => { dispose?.(); dispose = undefined; vi.unstubAllGlobals(); vi.useRealTimers(); });

it('parses named chat events, rejects malformed data, and removes extra fields', () => {
  const event = vi.fn(), state = vi.fn();
  dispose = connectChatEvents(event, state);
  const source = FakeSource.instances[0];
  expect(source.url).toBe('/api/chat/events');
  source.open(); expect(state).toHaveBeenLastCalledWith(true);
  for (const value of ['bad JSON', 'null', '{}', '{"kind":"unknown","key":"x"}', '{"kind":"peer","key":1}']) source.message(value);
  expect(event).not.toHaveBeenCalled();
  source.message('{"kind":"peer","key":"bob","body":"discard"}');
  expect(event).toHaveBeenCalledExactlyOnceWith({ kind: 'peer', key: 'bob' });
  dispose();
  source.message('{"kind":"peer","key":"late"}');
  expect(event).toHaveBeenCalledTimes(1);
});

it('lets EventSource reconnect network drops and retries terminal closure with capped backoff', () => {
  const state = vi.fn();
  dispose = connectChatEvents(vi.fn(), state);
  const source = FakeSource.instances[0]; source.open(); source.fail(0);
  expect(state).toHaveBeenLastCalledWith(false);
  vi.advanceTimersByTime(30_000); expect(FakeSource.instances).toHaveLength(1);
  source.fail(FakeSource.CLOSED);
  for (const delay of [3000, 6000, 12_000, 24_000, 30_000, 30_000]) {
    const before = FakeSource.instances.length;
    vi.advanceTimersByTime(delay - 1); expect(FakeSource.instances).toHaveLength(before);
    vi.advanceTimersByTime(1); expect(FakeSource.instances).toHaveLength(before + 1);
    FakeSource.instances.at(-1)!.fail(FakeSource.CLOSED);
  }
  dispose(); vi.advanceTimersByTime(60_000);
  expect(vi.getTimerCount()).toBe(0);
});

it('closes after one minute hidden, reopens on visibility, and disposes all work', () => {
  dispose = connectChatEvents(vi.fn());
  const source = FakeSource.instances[0];
  page.hidden = true; page.dispatchEvent(new Event('visibilitychange'));
  vi.advanceTimersByTime(59_999); expect(source.close).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1); expect(source.close).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(60_000); expect(FakeSource.instances).toHaveLength(1);
  page.hidden = false; page.dispatchEvent(new Event('visibilitychange'));
  expect(FakeSource.instances).toHaveLength(2);
  dispose(); page.dispatchEvent(new Event('visibilitychange'));
  expect(FakeSource.instances).toHaveLength(2);
  expect(FakeSource.instances[1].close).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

it('treats capacity as terminal until a hidden page becomes visible, ignoring browser reconnect errors', () => {
  const state = vi.fn();
  dispose = connectChatEvents(vi.fn(), state);
  const source = FakeSource.instances[0]; source.open();
  source.dispatchEvent(new MessageEvent('capacity', { data: '{}' }));
  expect(source.close).toHaveBeenCalledTimes(1);
  expect(state).toHaveBeenLastCalledWith(false);
  source.fail(FakeSource.CLOSED);
  page.dispatchEvent(new Event('visibilitychange'));
  vi.advanceTimersByTime(3_600_000);
  expect(FakeSource.instances).toHaveLength(1);
  page.hidden = true; page.dispatchEvent(new Event('visibilitychange'));
  // A quick tab switch is enough. Waiting for the hidden timeout is unnecessary.
  page.hidden = false; page.dispatchEvent(new Event('visibilitychange'));
  expect(FakeSource.instances).toHaveLength(2);
});

it('can reconnect manually after capacity by disposing and creating a connection', () => {
  dispose = connectChatEvents(vi.fn());
  FakeSource.instances[0].dispatchEvent(new MessageEvent('capacity', { data: '{}' }));
  dispose();
  dispose = connectChatEvents(vi.fn());
  expect(FakeSource.instances).toHaveLength(2);
});

it('closes bye immediately and delays a new connection by five to ten seconds', () => {
  dispose = connectChatEvents(vi.fn());
  const source = FakeSource.instances[0]; source.open();
  source.dispatchEvent(new MessageEvent('bye', { data: '{}' }));
  expect(source.close).toHaveBeenCalledTimes(1);
  source.fail(FakeSource.CLOSED);
  vi.advanceTimersByTime(4999);
  expect(FakeSource.instances).toHaveLength(1);
  vi.advanceTimersByTime(5001);
  expect(FakeSource.instances).toHaveLength(2);
  dispose();
  vi.advanceTimersByTime(60_000);
  expect(vi.getTimerCount()).toBe(0);
});
