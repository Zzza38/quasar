import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Session } from 'next-auth';
import { openDatabase, type Db } from './db';
const auth = vi.hoisted(() => ({ session: null as Session | null, db: undefined as Db | undefined }));
vi.mock('next-auth', () => ({ getServerSession: vi.fn(async () => auth.session) }));
vi.mock('@/server/db', async importOriginal => ({ ...await importOriginal<typeof import('./db')>(), getDb: () => auth.db! }));
import { GET } from '@/app/api/chat/events/route';
import { notifyChat } from './chat-events';
import * as chatEvents from './chat-events';

const aborts: AbortController[] = [];
beforeEach(() => {
  auth.db = openDatabase(':memory:');
  auth.db.prepare('INSERT INTO users(id,google_sub,email,created_at) VALUES(?,?,?,?)').run('alice', 'alice', 'alice@example.com', new Date().toISOString());
  auth.session = { user: { id: 'alice' }, epoch: 0, authAt: Date.now(), expires: new Date(Date.now() + 86_400_000).toISOString() };
});
afterEach(() => {
  for (const abort of aborts.splice(0)) abort.abort();
  auth.db?.close(); vi.restoreAllMocks(); vi.useRealTimers();
});
const request = (signal?: AbortSignal) => {
  const abort = new AbortController(); aborts.push(abort);
  return new Request('http://localhost/api/chat/events', { signal: signal ?? abort.signal });
};

it('requires a valid session and refuses cross-site requests', async () => {
  auth.session = null;
  expect((await GET(request())).status).toBe(401);
  expect((await GET(new Request('http://localhost/api/chat/events', { headers: { 'sec-fetch-site': 'cross-site' } }))).status).toBe(403);
});

it('streams retry, account-scoped events and heartbeats, then unsubscribes on abort', async () => {
  vi.useFakeTimers();
  const abort = new AbortController();
  const response = await GET(request(abort.signal));
  expect(response.headers.get('content-type')).toBe('text/event-stream');
  expect(response.headers.get('cache-control')).toBe('no-cache, no-transform');
  expect(response.headers.get('connection')).toBe('keep-alive');
  expect(response.headers.get('x-accel-buffering')).toBe('no');
  const reader = response.body!.getReader(), decoder = new TextDecoder();
  expect(decoder.decode((await reader.read()).value)).toBe('retry: 3000\n\n');
  notifyChat(['bob'], { kind: 'peer', key: 'unrelated' });
  notifyChat(['alice'], { kind: 'peer', key: 'bob' });
  expect(decoder.decode((await reader.read()).value)).toBe('event: chat\ndata: {"kind":"peer","key":"bob"}\n\n');
  vi.advanceTimersByTime(25_000);
  expect(decoder.decode((await reader.read()).value)).toBe(': heartbeat\n\n');
  abort.abort();
  expect((await reader.read()).done).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
  expect(() => notifyChat(['alice'], { kind: 'peer', key: 'bob' })).not.toThrow();
});

it('closes the oldest stream at the account cap and cleans up cancelled readers', async () => {
  vi.useFakeTimers();
  const responses = [];
  for (let i = 0; i < 9; i++) responses.push(await GET(request()));
  const oldest = responses[0].body!.getReader();
  await oldest.read();
  expect(new TextDecoder().decode((await oldest.read()).value)).toBe('event: capacity\nretry: 3600000\ndata: {}\n\n');
  expect((await oldest.read()).done).toBe(true);
  for (const response of responses.slice(1)) await response.body!.cancel();
  expect(vi.getTimerCount()).toBe(0);
});

it('handles requests already aborted and stops buffering for stalled readers', async () => {
  vi.useFakeTimers();
  const abort = new AbortController(); abort.abort();
  const aborted = await GET(request(abort.signal));
  await aborted.body!.cancel();
  const response = await GET(request());
  for (let i = 0; i < 100; i++) notifyChat(['alice'], { kind: 'peer', key: 'bob' });
  expect(vi.getTimerCount()).toBe(0);
  await response.body!.cancel();
});

it.each(['suspension', 'epoch', 'expiry', 'sign-in age', 'deleted account'] as const)('ends an open stream with bye on heartbeat after %s', async reason => {
  vi.useFakeTimers();
  if (reason === 'sign-in age') auth.session!.expires = new Date(Date.now() + 32 * 86_400_000).toISOString();
  const subscribe = chatEvents.subscribeChat;
  const unsubscribed = vi.fn();
  vi.spyOn(chatEvents, 'subscribeChat').mockImplementation((...args) => {
    const unsubscribe = subscribe(...args);
    return () => { unsubscribe(); unsubscribed(); };
  });
  const response = await GET(request());
  const reader = response.body!.getReader(), decoder = new TextDecoder();
  await reader.read();
  if (reason === 'suspension') auth.db!.prepare('UPDATE users SET suspended_at=? WHERE id=?').run(new Date().toISOString(), 'alice');
  if (reason === 'epoch') auth.db!.prepare('UPDATE users SET session_epoch=session_epoch+1 WHERE id=?').run('alice');
  if (reason === 'expiry') vi.setSystemTime(new Date(auth.session!.expires));
  if (reason === 'sign-in age') vi.setSystemTime(auth.session!.authAt! + 31 * 86_400_000);
  if (reason === 'deleted account') auth.db!.prepare('DELETE FROM users WHERE id=?').run('alice');
  vi.advanceTimersByTime(25_000);
  expect(decoder.decode((await reader.read()).value)).toBe('event: bye\ndata: {}\n\n');
  expect((await reader.read()).done).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
  expect(unsubscribed).toHaveBeenCalledTimes(1);
  // A closed stream is no longer called by the bus, even if the database is unavailable.
  auth.db!.close();
  notifyChat(['alice'], { kind: 'peer', key: 'late' });
  expect((await reader.read()).done).toBe(true);
  auth.db = undefined;
});

it.each(['suspension', 'epoch', 'expiry'] as const)('validates %s before every event, before the first heartbeat', async reason => {
  vi.useFakeTimers();
  const response = await GET(request());
  const reader = response.body!.getReader(), decoder = new TextDecoder();
  await reader.read();
  if (reason === 'suspension') auth.db!.prepare('UPDATE users SET suspended_at=? WHERE id=?').run(new Date().toISOString(), 'alice');
  if (reason === 'epoch') auth.db!.prepare('UPDATE users SET session_epoch=session_epoch+1 WHERE id=?').run('alice');
  if (reason === 'expiry') vi.setSystemTime(new Date(auth.session!.expires));
  notifyChat(['alice'], { kind: 'global', key: 'global' });
  expect(decoder.decode((await reader.read()).value)).toBe('event: bye\ndata: {}\n\n');
  expect((await reader.read()).done).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});
