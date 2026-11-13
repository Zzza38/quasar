import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearReceived, readReceived, receivedGeneration, RECEIVED_TTL, removeReceived, writeReceived, pruneReceivedThreads } from './received-cache';
import { clearChatCache, threadSnapshot, validThread } from './chat-cache';
import { readGradeCache, writeGradeCache } from './grade-cache';

class MemoryStorage implements Storage {
  entries = new Map<string, string>();
  get length() { return this.entries.size; }
  clear() { this.entries.clear(); }
  key(i: number) { return [...this.entries.keys()][i] ?? null; }
  getItem(key: string) { return this.entries.get(key) ?? null; }
  setItem(key: string, value: string) { this.entries.set(key, String(value)); }
  removeItem(key: string) { this.entries.delete(key); }
}
const valid = (value: unknown): value is { body: string } => !!value && typeof value === 'object' && 'body' in value && typeof value.body === 'string';
let storage: MemoryStorage;
beforeEach(() => { storage = new MemoryStorage(); vi.stubGlobal('window', { localStorage: storage, dispatchEvent: vi.fn() }); });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('received browser snapshots', () => {
  it('survives module reload and isolates accounts and conversation kinds', async () => {
    writeReceived('a', 'thread:peer:same', { body: 'private' });
    writeReceived('a', 'thread:group:same', { body: 'group' });
    vi.resetModules();
    const reloaded = await import('./received-cache');
    expect(reloaded.readReceived('a', 'thread:peer:same', valid)?.body).toBe('private');
    expect(reloaded.readReceived('a', 'thread:group:same', valid)?.body).toBe('group');
    expect(reloaded.readReceived('b', 'thread:peer:same', valid)).toBeNull();
  });
  it('does not let an older response from another tab overwrite a newer revision', () => {
    writeReceived('a', 'thread:peer:p', { body: 'deleted' }, 12);
    writeReceived('a', 'thread:peer:p', { body: 'old reaction response' }, 11);
    expect(readReceived('a', 'thread:peer:p', valid)?.body).toBe('deleted');
    writeReceived('a', 'thread:peer:p', { body: 'new server state' }, 13);
    expect(readReceived('a', 'thread:peer:p', valid)?.body).toBe('new server state');
  });
  it('expires without extending lifetime when read', () => {
    vi.useFakeTimers(); writeReceived('a', 'inbox', { body: 'old' });
    vi.advanceTimersByTime(RECEIVED_TTL - 1); expect(readReceived('a', 'inbox', valid)).not.toBeNull();
    vi.advanceTimersByTime(1); expect(readReceived('a', 'inbox', valid)).toBeNull();
  });
  it('drops malformed JSON, wrong versions and invalid payloads', () => {
    for (const bad of ['{', JSON.stringify({ version: 2, at: Date.now(), value: { body: 'old' } }), JSON.stringify({ version: 1, at: Date.now(), value: {} })]) {
      storage.setItem('quasar-received-v1:a:inbox', bad);
      expect(readReceived('a', 'inbox', valid)).toBeNull();
      expect(storage.getItem('quasar-received-v1:a:inbox')).toBeNull();
    }
  });
  it('bounds entries and bytes, and refuses oversized snapshots', () => {
    for (let i = 0; i < 40; i++) writeReceived('a', `thread:peer:${i}`, { body: 'x'.repeat(40_000) });
    expect(storage.length).toBeLessThanOrEqual(32);
    expect([...storage.entries].reduce((n, [k, v]) => n + (k.length + v.length) * 2, 0)).toBeLessThanOrEqual(2_000_000);
    writeReceived('a', 'huge', { body: 'x'.repeat(600_000) });
    expect(readReceived('a', 'huge', valid)).toBeNull();
  });
  it('purges one account or conversation and changes the in-flight generation', () => {
    writeReceived('a', 'thread:peer:1', { body: 'one' }); writeReceived('b', 'inbox', { body: 'two' });
    const before = receivedGeneration(); removeReceived('a', 'thread:peer:1');
    expect(receivedGeneration()).not.toBe(before);
    expect(readReceived('a', 'thread:peer:1', valid)).toBeNull();
    expect(readReceived('b', 'inbox', valid)?.body).toBe('two');
    removeReceived('b'); expect(readReceived('b', 'inbox', valid)).toBeNull();
    clearReceived(); expect([...storage.entries.keys()].filter(k => k.startsWith('quasar-received-v1:'))).toEqual([]);
  });
  it('removes conversations no longer present in the authoritative inbox', () => {
    for (const resource of ['thread:peer:a', 'thread:group:b', 'thread:school:c', 'inbox']) writeReceived('a', resource, { body: 'test' });
    pruneReceivedThreads('a', ['thread:peer:a']);
    expect(readReceived('a', 'thread:peer:a', valid)).not.toBeNull();
    expect(readReceived('a', 'thread:group:b', valid)).toBeNull();
    expect(readReceived('a', 'thread:school:c', valid)).toBeNull();
    expect(readReceived('a', 'inbox', valid)).not.toBeNull();
  });
  it('purges local blocks and leaves without deleting grades or another account', () => {
    for (const resource of ['thread:peer:p', 'thread:group:g', 'grades', 'inbox']) writeReceived('a', resource, { body: 'received' });
    writeReceived('b', 'inbox', { body: 'other account' });
    clearChatCache('a', 'group:g');
    expect(readReceived('a', 'thread:group:g', valid)).toBeNull();
    expect(readReceived('a', 'thread:peer:p', valid)).not.toBeNull();
    clearChatCache('a');
    expect(readReceived('a', 'thread:peer:p', valid)).toBeNull();
    expect(readReceived('a', 'grades', valid)).not.toBeNull();
    expect(readReceived('b', 'inbox', valid)).not.toBeNull();
  });
  it('falls back safely when storage is missing or refuses access', () => {
    vi.stubGlobal('window', { get localStorage() { throw new Error('blocked'); } });
    expect(() => writeReceived('a', 'inbox', { body: 'text' })).not.toThrow();
    expect(readReceived('a', 'inbox', valid)).toBeNull();
    expect(() => clearReceived()).not.toThrow();
  });
  it('caps thread history and rejects malformed nested message data', () => {
    const value = { peer: { id: 'p', displayName: 'Peer', fullName: null, avatar: null, verified: true }, room: null, group: null, pause: null,
      receipts: [{ id: 'p', displayName: 'Peer', avatar: null, deliveredSeq: 1, readSeq: 1, typing: true }], hasEarlier: false, muted: false,
      messages: Array.from({ length: 110 }, (_, seq) => ({ id: `m${seq}`, seq, revision: seq, fromMe: false, body: 'received', createdAt: '2026-11-13T00:00:00Z', deletedBy: null, original: null, removed: null, replyTo: null, reactions: [] })),
    };
    const capped = threadSnapshot(value);
    expect(capped.messages).toHaveLength(100); expect(capped.messages[0].seq).toBe(10);
    expect(capped.hasEarlier).toBe(true); expect(capped.receipts).toEqual([]);
    expect(validThread(capped)).toBe(true);
    expect(validThread({ ...capped, messages: [{ ...capped.messages[0], reactions: [{}] }] })).toBe(false);
  });
  it('validates gradebooks before displaying persisted data', () => {
    const book = { name: 'Student', checkedAt: new Date().toISOString(), classes: [], goals: {} };
    writeGradeCache('a', book); expect(readGradeCache('a')).toEqual(book); expect(readGradeCache('b')).toBeNull();
    writeReceived('a', 'grades', { ...book, classes: [{ detail: {} }] }); expect(readGradeCache('a')).toBeNull();
  });
});
