import { useSyncExternalStore } from 'react';

/** Bounded, account-scoped snapshots of server responses. Never use for drafts or credentials. */
export const RECEIVED_INVALIDATED = 'quasar:received-invalidated';
const GENERATION = 'quasar-received-generation';
const subscribeToNothing = () => () => {};
/** Match server HTML first; client navigation can use storage on its first render. */
export const useReceivedCacheReady = () => useSyncExternalStore(subscribeToNothing, () => true, () => false);
const PREFIX = 'quasar-received-v1:';
export const RECEIVED_TTL = 24 * 60 * 60_000;
const MAX_BYTES = 2_000_000;
const MAX_ENTRIES = 32;
type RecordValue = { version: 1; at: number; value: unknown; revision?: number };
const key = (account: string, resource: string) => `${PREFIX}${encodeURIComponent(account)}:${encodeURIComponent(resource)}`;
function storage(): Storage | null {
  try { return typeof window === 'undefined' ? null : window.localStorage; } catch { return null; }
}
function keys(store: Storage): string[] {
  return Array.from({ length: store.length }, (_, i) => store.key(i)!).filter(k => k?.startsWith(PREFIX));
}
function parse(raw: string | null): RecordValue | null {
  try {
    if (!raw || raw.length * 2 > MAX_BYTES) return null;
    const row = JSON.parse(raw);
    return row?.version === 1 && (row.revision === undefined || Number.isFinite(row.revision)) && Number.isFinite(row.at) && row.at <= Date.now() && Date.now() - row.at < RECEIVED_TTL ? row : null;
  } catch { return null; }
}
/** Requests begun before a purge must not restore the purged private snapshot. */
export function receivedGeneration(): string | null {
  try { return storage()?.getItem(GENERATION) ?? null; } catch { return null; }
}
function invalidate(store: Storage) {
  store.setItem(GENERATION, `${Date.now()}:${Math.random()}`);
  window.dispatchEvent(new Event(RECEIVED_INVALIDATED));
}
export function watchReceivedInvalidation(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const changed = (event: StorageEvent) => { if (event.key === GENERATION || event.key === null) listener(); };
  window.addEventListener('storage', changed);
  window.addEventListener(RECEIVED_INVALIDATED, listener);
  return () => { window.removeEventListener('storage', changed); window.removeEventListener(RECEIVED_INVALIDATED, listener); };
}
export function pruneReceivedThreads(account: string, allowed: string[]): void {
  try {
    const store = storage(); if (!store) return;
    const prefix = `${PREFIX}${encodeURIComponent(account)}:`;
    const keep = new Set(allowed.map(resource => key(account, resource)));
    let removed = false;
    for (const id of keys(store)) if (id.startsWith(prefix) && decodeURIComponent(id.slice(prefix.length)).startsWith('thread:') && !keep.has(id)) { store.removeItem(id); removed = true; }
    if (removed) invalidate(store);
  } catch { /* unavailable */ }
}
export function readReceived<T>(account: string, resource: string, valid: (value: unknown) => value is T): T | null {
  try {
    const store = storage(); if (!store) return null;
    const id = key(account, resource), row = parse(store.getItem(id));
    if (row && valid(row.value)) return row.value;
    store.removeItem(id);
  } catch { /* Disabled or malformed storage behaves like a cache miss. */ }
  return null;
}
export function writeReceived(account: string, resource: string, value: unknown, revision?: number): void {
  try {
    const store = storage(); if (!store) return;
    const id = key(account, resource);
    const existing = parse(store.getItem(id));
    // A slow response in another tab must not replace a newer deletion or reaction.
    if (revision !== undefined && existing?.revision !== undefined && revision < existing.revision) return;
    const raw = JSON.stringify({ version: 1, at: Date.now(), value, revision });
    if (raw.length * 2 > MAX_BYTES / 2) { store.removeItem(id); return; }
    const entries = keys(store).filter(k => k !== id).flatMap(k => {
      const text = store.getItem(k), row = parse(text);
      if (!row) { store.removeItem(k); return []; }
      return [{ key: k, at: row.at, size: (text!.length + k.length) * 2 }];
    }).sort((a, b) => a.at - b.at);
    let bytes = entries.reduce((sum, entry) => sum + entry.size, (raw.length + id.length) * 2);
    while (entries.length >= MAX_ENTRIES || bytes > MAX_BYTES) {
      const oldest = entries.shift(); if (!oldest) break;
      store.removeItem(oldest.key); bytes -= oldest.size;
    }
    store.setItem(id, raw);
  } catch { /* Quota and privacy settings must never break network delivery. */ }
}
export function removeReceived(account: string, resource?: string): void {
  try {
    const store = storage(); if (!store) return;
    if (resource !== undefined) store.removeItem(key(account, resource));
    else for (const id of keys(store)) if (id.startsWith(`${PREFIX}${encodeURIComponent(account)}:`)) store.removeItem(id);
    invalidate(store);
  } catch { /* Best effort when storage is unavailable. */ }
}
export function clearReceived(): void {
  try { const store = storage(); if (store) { for (const id of keys(store)) store.removeItem(id); invalidate(store); } } catch { /* unavailable */ }
}
