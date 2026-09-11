'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { signOut } from 'next-auth/react';
import { api, errorMessage, isUnauthorized, type Workspace } from '@/client/api';
import { clearOfflineAccount, getLastAccountId, openWorkspace, type OfflineWorkspace, type WorkspaceSnapshot } from '@/client/offline';
import type { EntityKind } from '@/domain/sync';
import type { WorkspaceContext } from './app-state';

/**
 * Account, offline store and synchronization state for the signed-in shell.
 * The behavior here (account checks around uploads, offline fallback only for
 * transport failures, verified sign-out before clearing the cache) is a
 * product rule; presentation components must not bypass it.
 */

function contextOf(workspace: Workspace): WorkspaceContext {
  const { entities: _entities, ...context } = workspace;
  return context;
}

function transportFailure(error: unknown) {
  return !navigator.onLine || (error instanceof Error && /failed to fetch|fetch failed|networkerror|network request|load failed/i.test(error.message));
}

async function workerStatus(worker: ServiceWorker, prepare: boolean): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => { channel.port1.close(); reject(new Error('Offline setup did not finish.')); }, 15_000);
    channel.port1.onmessage = (event: MessageEvent<{ ready: boolean }>) => {
      clearTimeout(timer); channel.port1.close(); resolve(event.data.ready);
    };
    worker.postMessage({ type: prepare ? 'PREPARE_OFFLINE' : 'OFFLINE_STATUS' }, [channel.port2]);
  });
}

export type SyncState =
  | { kind: 'saving' }
  | { kind: 'syncing' }
  | { kind: 'conflict'; count: number }
  | { kind: 'failed'; message: string }
  | { kind: 'pending'; count: number }
  | { kind: 'offline'; ready: boolean | null }
  | { kind: 'saved' };

export interface WorkspaceSession {
  context: WorkspaceContext | null;
  snapshot: WorkspaceSnapshot | null;
  loading: boolean;
  authRequired: boolean;
  online: boolean;
  syncing: boolean;
  writing: boolean;
  offlineReady: boolean | null;
  error: string;
  sync: SyncState;
  logout: { asking: boolean; pending: boolean };
  initialize: () => Promise<void>;
  synchronize: () => Promise<void>;
  prepareOffline: () => Promise<void>;
  save: (kind: EntityKind, id: string, data: Record<string, unknown> | null) => Promise<void>;
  resolve: (mutationId: string, choice: 'local' | 'remote') => Promise<void>;
  requestLogout: () => void;
  finishLogout: (discard: boolean) => Promise<void>;
  cancelLogout: () => void;
  dismissError: () => void;
}

export function useWorkspace(): WorkspaceSession {
  const [context, setContext] = useState<WorkspaceContext | null>(null);
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [authRequired, setAuthRequired] = useState(false);
  const [online, setOnline] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [writing, setWriting] = useState(false);
  const [offlineReady, setOfflineReady] = useState<boolean | null>(null);
  const [error, setError] = useState('');
  const [askingLogout, setAskingLogout] = useState(false);
  const [logoutPending, setLogoutPending] = useState(false);
  const workspaceRef = useRef<OfflineWorkspace | null>(null);
  const unsubscribeRef = useRef<(() => void) | null>(null);
  const generationRef = useRef(0);
  const syncLock = useRef(false);
  const logoutRef = useRef(false);

  const prepareOffline = useCallback(async (prepare = true) => {
    setOfflineReady(null);
    try {
      if (!('serviceWorker' in navigator)) { setOfflineReady(false); return; }
      const registration = prepare ? await navigator.serviceWorker.register('/sw.js') : await navigator.serviceWorker.getRegistration();
      if (!registration) { setOfflineReady(false); return; }
      let worker = registration.active;
      if (!worker) {
        const activated = await new Promise<ServiceWorkerRegistration>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('Offline setup did not finish.')), 15_000);
          navigator.serviceWorker.ready.then((value) => { clearTimeout(timer); resolve(value); }, reject);
        });
        worker = activated.active;
      }
      setOfflineReady(worker ? await workerStatus(worker, prepare) : false);
    } catch { setOfflineReady(false); }
  }, []);

  const detach = useCallback(() => {
    unsubscribeRef.current?.(); unsubscribeRef.current = null;
    workspaceRef.current?.close(); workspaceRef.current = null;
  }, []);

  const requireSignIn = useCallback((message = '') => {
    detach(); setContext(null); setSnapshot(null); setAuthRequired(true); setLoading(false); setError(message);
  }, [detach]);

  const attach = useCallback(async (store: OfflineWorkspace) => {
    if (workspaceRef.current !== store) { detach(); workspaceRef.current = store; }
    const update = async () => {
      try {
        const value = await store.read();
        if (workspaceRef.current === store) {
          setSnapshot(value);
          if (value.context) setContext(value.context as WorkspaceContext);
        }
      } catch (err) {
        if (workspaceRef.current === store) requireSignIn(errorMessage(err));
      }
    };
    unsubscribeRef.current = store.subscribe(() => { void update(); });
    await update();
  }, [detach, requireSignIn]);

  const synchronize = useCallback(async (duringLogout = false) => {
    const store = workspaceRef.current;
    if (!store || syncLock.current || !navigator.onLine || (logoutRef.current && !duringLogout)) return;
    syncLock.current = true; setSyncing(true);
    try {
      const session = await api.session.query();
      if (!session) { requireSignIn('Sign in again to continue. Your waiting changes are saved on this device.'); return; }
      if (session.user.id !== store.accountId) { requireSignIn('The signed-in account changed. Sign in again to open the correct account. Your waiting changes are preserved.'); return; }
      const fresh = await api.workspace.query();
      if (workspaceRef.current !== store) return;
      if (fresh.user.id !== store.accountId) { requireSignIn('The signed-in account changed. Sign in again to continue.'); return; }
      await store.setContext(contextOf(fresh));
      await store.ingest(fresh.entities);
      await store.sync(async (mutation) => {
        // A fresh account check on every upload prevents another tab's account
        // switch from sending this device's queue to a different account.
        const active = await api.session.query();
        if (!active || active.user.id !== store.accountId) {
          requireSignIn('Sign in to the original account before syncing these changes.');
          throw new Error('The signed-in account changed.');
        }
        return api.sync.mutate({ ...mutation, accountId: store.accountId });
      });
      const state = await store.read();
      if (workspaceRef.current === store) { setSnapshot(state); setOnline(true); setError(''); }
    } catch (err) {
      if (isUnauthorized(err)) requireSignIn('Sign in again to sync. Your waiting changes are saved on this device.');
      else if (workspaceRef.current === store) {
        if (transportFailure(err)) { setOnline(false); setError(''); }
        else setError(errorMessage(err));
      }
    } finally { syncLock.current = false; setSyncing(false); }
  }, [requireSignIn]);

  const initialize = useCallback(async () => {
    if (logoutRef.current) return;
    const generation = ++generationRef.current;
    setLoading(true); setError('');
    let authenticatedId: string | null = null;
    try {
      const session = await api.session.query();
      if (generation !== generationRef.current) return;
      if (!session) { requireSignIn(); return; }
      authenticatedId = session.user.id;
      const fresh = await api.workspace.query();
      if (generation !== generationRef.current) return;
      if (fresh.user.id !== session.user.id) { requireSignIn('The signed-in account changed. Sign in again to continue.'); return; }
      const store = workspaceRef.current?.accountId === session.user.id ? workspaceRef.current : await openWorkspace(session.user.id);
      if (generation !== generationRef.current) { if (workspaceRef.current !== store) store.close(); return; }
      await store.setContext(contextOf(fresh)); await store.ingest(fresh.entities);
      unsubscribeRef.current?.(); await attach(store);
      setContext(contextOf(fresh)); setAuthRequired(false); setOnline(true);
      void prepareOffline();
    } catch (err) {
      if (generation !== generationRef.current) return;
      if (isUnauthorized(err)) { requireSignIn('Sign in again to continue. Your waiting changes are preserved.'); return; }
      if (transportFailure(err)) {
        try {
          const accountId = authenticatedId ?? await getLastAccountId();
          if (generation !== generationRef.current) return;
          if (accountId) {
            const store = workspaceRef.current?.accountId === accountId ? workspaceRef.current : await openWorkspace(accountId);
            const saved = await store.read();
            if (generation !== generationRef.current) { if (workspaceRef.current !== store) store.close(); return; }
            if (saved.context) {
              unsubscribeRef.current?.(); await attach(store); setAuthRequired(false); setOnline(false); void prepareOffline(false); return;
            }
            if (workspaceRef.current !== store) store.close();
          }
        } catch (cacheError) { setError(errorMessage(cacheError)); return; }
        setError('Connect to the internet and sign in once to save this account for offline use.');
      } else setError(errorMessage(err));
    } finally { if (generation === generationRef.current) setLoading(false); }
  }, [attach, prepareOffline, requireSignIn]);

  useEffect(() => {
    void initialize();
    const onOnline = () => { setOnline(true); void initialize(); };
    const onOffline = () => setOnline(false);
    window.addEventListener('online', onOnline); window.addEventListener('offline', onOffline);
    const timer = setInterval(() => { void synchronize(); }, 15_000);
    return () => {
      generationRef.current += 1; detach(); clearInterval(timer);
      window.removeEventListener('online', onOnline); window.removeEventListener('offline', onOffline);
    };
  }, [detach, initialize, synchronize]);

  useEffect(() => {
    if (online && snapshot && snapshot.pending > snapshot.conflicts.length) void synchronize();
  }, [online, snapshot?.pending, snapshot?.conflicts.length, synchronize]);

  const save = useCallback(async (kind: EntityKind, id: string, data: Record<string, unknown> | null) => {
    if (logoutRef.current) throw new Error('Sign-out is in progress. Please wait before saving another change.');
    const store = workspaceRef.current;
    if (!store) throw new Error('Sign in again to save changes.');
    setWriting(true);
    try { await store.save(kind, id, data); setSnapshot(await store.read()); }
    finally { setWriting(false); }
    void synchronize();
  }, [synchronize]);

  const resolve = useCallback(async (mutationId: string, choice: 'local' | 'remote') => {
    const store = workspaceRef.current;
    if (!store) throw new Error('Sign in again to resolve this change.');
    await store.resolve(mutationId, choice);
    setSnapshot(await store.read());
    void synchronize();
  }, [synchronize]);

  const finishLogout = useCallback(async (discard: boolean) => {
    if (logoutRef.current) return;
    if (!navigator.onLine) { setError('Connect to the internet to sign out. Your saved data and waiting changes are preserved.'); return; }
    if (syncLock.current || writing) { setError('Wait for the current save to finish, then sign out.'); return; }
    logoutRef.current = true;
    generationRef.current += 1;
    setLoading(false);
    setLogoutPending(true); setError('');
    try {
      const store = workspaceRef.current;
      // Confirm that the server is reachable before doing anything that could
      // remove this device's private data. A browser's online flag is not enough.
      const session = await api.session.query();
      if (store && !discard) {
        const before = await store.read();
        if (before.pending) {
          if (!session || session.user.id !== store.accountId) throw new Error('Sign in to the original account to sync these changes, or explicitly discard them before signing out.');
          await synchronize(true);
          const state = await store.read();
          if (state.pending) throw new Error('Some changes are still waiting. Connect and resolve conflicts before signing out, or choose to discard them.');
        }
      }
      await signOut({ redirect: false, callbackUrl: '/' });
      // next-auth's client does not expose the sign-out response status. Check
      // the cookie-backed session before deleting the offline account.
      if (await api.session.query()) throw new Error('Sign-out did not finish. Your saved data is preserved; please try again.');
      if (store) { const accountId = store.accountId; detach(); await clearOfflineAccount(accountId); }
      setContext(null); setSnapshot(null); setAuthRequired(true); setAskingLogout(false);
      window.location.assign('/');
    } catch (err) {
      setError(transportFailure(err) ? 'Could not finish signing out. Reconnect and try again. Your saved data and waiting changes are preserved.' : errorMessage(err));
    } finally { logoutRef.current = false; setLogoutPending(false); }
  }, [detach, synchronize, writing]);

  const requestLogout = useCallback(() => {
    if (snapshot?.pending) setAskingLogout(true);
    else void finishLogout(false);
  }, [finishLogout, snapshot?.pending]);

  const sync: SyncState = writing ? { kind: 'saving' }
    : syncing ? { kind: 'syncing' }
    : snapshot?.conflicts.length ? { kind: 'conflict', count: snapshot.conflicts.length }
    : snapshot?.lastError ? { kind: 'failed', message: snapshot.lastError }
    : snapshot?.pending ? { kind: 'pending', count: snapshot.pending }
    : !online ? { kind: 'offline', ready: offlineReady }
    : { kind: 'saved' };

  return {
    context, snapshot, loading, authRequired, online, syncing, writing, offlineReady, error, sync,
    logout: { asking: askingLogout, pending: logoutPending },
    initialize, synchronize: () => synchronize(), prepareOffline: () => prepareOffline(), save, resolve,
    requestLogout, finishLogout, cancelLogout: () => setAskingLogout(false), dismissError: () => setError(''),
  };
}
