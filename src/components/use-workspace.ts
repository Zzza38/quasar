'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { removeStaleWorkers, serviceWorkerEnabled } from '@/client/service-worker-support';
import { signOut } from 'next-auth/react';
import { api, errorMessage, isTransportFailure, isUnauthorized, type Workspace } from '@/client/api';
import { clearOfflineAccount, getLastAccountId, openWorkspace, requestPersistentStorage, storagePersistence, type OfflineWorkspace, type WorkspaceSnapshot } from '@/client/offline';
import { TASK_CLIENT_VERSION } from '@/domain/task';
import type { EntityKind } from '@/domain/sync';
import { cachedContext, persistedContext, storedContext, upgradedContext, withClassmates, type WorkspaceClassmates, type WorkspaceContext } from './app-state';
import { clearSetupState } from './setup-state';

/**
 * Account, offline store and synchronization state for the signed-in shell.
 * The behavior here (account checks around uploads, offline fallback only for
 * transport failures, verified sign-out before clearing the cache) is a
 * product rule; presentation components must not bypass it.
 */

/** Tells the server this build reads `completedAt`, so it sends tasks with it (older builds get them without). */
const TASK_FIELDS = { clientVersion: TASK_CLIENT_VERSION };

/** A proxy's HTML error page, parsed as JSON by the tRPC client. */
const UNPARSABLE_RESPONSE = /not valid JSON|Unexpected token|Unexpected end of JSON/i;

/**
 * The store's lastError is null after a dropped connection (flush classifies it with isTransportFailure) and the
 * errorMessage() text of any other failed upload, so a current value is always a real failure. Builds before
 * that stored the raw message of every failure, and such a value stays in IndexedDB until the next save, resolve
 * or upload clears it; these checks keep a legacy dropped-connection message from showing as a failed sync.
 */
function legacyTransportError(message: string) {
  return UNPARSABLE_RESPONSE.test(message) || isTransportFailure(new Error(message));
}

/** Whether the offline copy is ready, after first installing the service worker and refreshing its shells when `prepare` is set. */
async function offlineStatus(prepare: boolean): Promise<boolean> {
  try {
    if (!serviceWorkerEnabled) { await removeStaleWorkers(); return false; }
    if (!('serviceWorker' in navigator)) return false;
    const registration = prepare ? await navigator.serviceWorker.register('/sw.js') : await navigator.serviceWorker.getRegistration();
    if (!registration) return false;
    let worker = registration.active;
    if (!worker) {
      const activated = await new Promise<ServiceWorkerRegistration>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Offline setup did not finish.')), 15_000);
        navigator.serviceWorker.ready.then((value) => { clearTimeout(timer); resolve(value); }, reject);
      });
      worker = activated.active;
    }
    return worker ? await workerStatus(worker, prepare) : false;
  } catch { return false; }
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
  | { kind: 'offline'; ready: boolean | null; pending: number }
  | { kind: 'saved' };

/**
 * What the server rendered into the page for this request (src/app/page.tsx), so the first paint needs no API call:
 * the landing page for a signed-out visitor, or the signed-in account's workspace. `none` is the fallback when the
 * server could not decide (for example it could not open the database); the client then boots the way it always
 * did, device cache first.
 */
export type InitialBoot =
  | { kind: 'signed-out'; signInError: string | null; callbackPath: string; renderedAt: number }
  | { kind: 'workspace'; workspace: Workspace; renderedAt: number }
  | { kind: 'none'; renderedAt: number };

/** The server's copy of an account as a snapshot, shown until the device store (with this device's waiting changes) takes over. */
export function serverSnapshot(workspace: Workspace): WorkspaceSnapshot {
  return { accountId: workspace.user.id, entities: workspace.entities, pending: 0, conflicts: [], context: null, lastError: null };
}

export interface WorkspaceSession {
  context: WorkspaceContext | null;
  snapshot: WorkspaceSnapshot | null;
  loading: boolean;
  authRequired: boolean;
  online: boolean;
  syncing: boolean;
  writing: boolean;
  offlineReady: boolean | null;
  /**
   * Whether the browser keeps this device's saved data (and waiting changes) through low storage:
   * true when persistent, false when it may be evicted, null until known or when the browser cannot tell.
   */
  storagePersistent: boolean | null;
  error: string;
  sync: SyncState;
  logout: { asking: boolean; pending: boolean };
  /** Reloads the workspace from the server. Resolves true when it loaded; failures are reported through `error` and resolve false. */
  initialize: () => Promise<boolean>;
  synchronize: () => Promise<void>;
  /** False when this browser or build cannot keep an offline copy, so retrying setup cannot help. */
  offlineSupported: boolean;
  prepareOffline: () => Promise<void>;
  save: (kind: EntityKind, id: string, data: Record<string, unknown> | null) => Promise<void>;
  resolve: (mutationId: string, choice: 'local' | 'remote') => Promise<void>;
  requestLogout: () => void;
  finishLogout: (discard: boolean) => Promise<void>;
  cancelLogout: () => void;
  dismissError: () => void;
}

/**
 * Starts `load` and resolves with its outcome, unless a newer call replaced it in `latest` meanwhile; then it
 * resolves with the newer call's outcome, since the older load was cancelled rather than failed.
 */
export function followLatest(load: () => Promise<boolean>, latest: { current: Promise<boolean> | null }): Promise<boolean> {
  const run: Promise<boolean> = load().then((loaded) => {
    const newest = latest.current;
    return newest === run || !newest ? loaded : newest;
  });
  latest.current = run;
  return run;
}

/**
 * Runs one synchronize() at a time. A call made while one runs is remembered, and once the running one has fully
 * ended `onRerun` is called once, so a change saved after that run passed its upload loop is not left for the next poll.
 */
export function createSyncGate() {
  let running: Promise<void> | null = null;
  let rerun = false;
  return {
    /** Resolves when the running sync has fully finished; null when none is running. */
    get running() { return running; },
    async run(task: () => Promise<void>, onRerun: () => void): Promise<void> {
      if (running) { rerun = true; return; }
      let finished!: () => void;
      running = new Promise<void>((resolve) => { finished = resolve; });
      try { await task(); } finally {
        running = null; finished();
        if (rerun) { rerun = false; onRerun(); }
      }
    },
  };
}

/** The outside world a sign-out talks to, injected so the sequence can be tested. */
export interface SignOutSteps {
  session: () => Promise<{ user: { id: string } } | null>;
  /** Whether `store` is still the workspace on screen (a sync that ended in a sign-in prompt detaches it). */
  attached: (store: OfflineWorkspace) => boolean;
  /** Uploads waiting changes; may end in a sign-in prompt that detaches the store. */
  synchronize: () => Promise<void>;
  /** Stops this browser's reminders, removing the server subscription for `accountId` when given. */
  unsubscribePush: (accountId: string | null) => Promise<void>;
  signOut: () => Promise<void>;
  /** Forgets this browser's per-account settings (push opt-in, setup progress). */
  forget: (accountId: string) => void;
  detach: () => void;
  clear: typeof clearOfflineAccount;
}

/**
 * Signs this device out of `store`'s account. Resolves 'signed-out' once the server session ended and the account's
 * device cache is gone, or `{ kept }` when the session ended but a change queued meanwhile kept the cache (it then waits
 * behind the sign-in screen). Throws, leaving the session and every saved change in place, when signing out is not safe.
 * Other tabs of the account stop queueing and uploading until this ends, whatever the outcome.
 */
export async function signOutDevice(store: OfflineWorkspace | null, discard: boolean, steps: SignOutSteps): Promise<'signed-out' | { kept: string }> {
  // The running sync may have ended in requireSignIn and detached the store; never report a
  // sign-out that skipped clearing this account's device cache.
  if (store && !steps.attached(store)) throw new Error('Your session changed. Sign in again, then sign out.');
  try {
    // Other tabs of this account stop queueing and uploading until this sign-out ends, so a change
    // the student chose to discard is not uploaded elsewhere and no new one slips in unseen.
    if (store) await store.beginSignOut();
    // Confirm that the server is reachable before doing anything that could
    // remove this device's private data. A browser's online flag is not enough.
    const session = await steps.session();
    // signOut() ends whichever account the cookie now holds. When another tab switched accounts, that is not
    // the account shown here, and clearing this one's cache would leave the signed-out account's data behind.
    if (store && session && session.user.id !== store.accountId) throw new Error('Your session changed. Sign in again, then sign out.');
    if (store && !discard) {
      const before = await store.read();
      if (before.pending) {
        if (!session) throw new Error('Sign in to the original account to sync these changes, or explicitly discard them before signing out.');
        await steps.synchronize();
        const state = await store.read();
        if (state.pending) throw new Error('Some changes are still waiting. Connect and resolve conflicts before signing out, or choose to discard them.');
      }
    }
    // Stop reminders on this shared browser while the authenticated account
    // can still remove its server subscription. A failure preserves the
    // signed-in session and offline data so the user can retry safely.
    await steps.unsubscribePush(session?.user.id ?? null);
    await steps.signOut();
    // next-auth's client does not expose the sign-out response status. Check
    // the cookie-backed session before deleting the offline account.
    if (await steps.session()) throw new Error('Sign-out did not finish. Your saved data is preserved; please try again.');
    if (session) steps.forget(session.user.id);
    // Without discard, the queue is checked again in the same transaction as the delete, in case a tab
    // that predates the sign-out marker (or outlived its expiry) queued a change after the check above.
    if (store) {
      steps.forget(store.accountId); steps.detach();
      // The server session has already ended, so a kept change waits behind the sign-in screen.
      try { await steps.clear(store.accountId, { requireEmptyQueue: !discard }); } catch (err) { return { kept: errorMessage(err) }; }
    }
    return 'signed-out';
  } finally {
    // Releases this tab's marker even when the final sync ended in requireSignIn and detached the store, so the
    // next sign-in here is not blocked as "signing out in another tab". A no-op once the account was cleared.
    if (store) await store.endSignOut();
  }
}

export function useWorkspace(initial?: InitialBoot): WorkspaceSession {
  // The server-rendered page starts the hook in its final state for the first paint: the workspace it rendered, or
  // the sign-in prompt. The mount effect below then reconciles with the device store and the server.
  const boot = useRef<InitialBoot>(initial ?? { kind: 'none', renderedAt: 0 }).current;
  const [context, setContext] = useState<WorkspaceContext | null>(() => boot.kind === 'workspace' ? persistedContext(boot.workspace) : null);
  // Friends' class lists from the latest server response. Memory only: the saved context leaves them out.
  const [classmates, setClassmates] = useState<WorkspaceClassmates>(() => boot.kind === 'workspace' ? boot.workspace.community.classmates : []);
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot | null>(() => boot.kind === 'workspace' ? serverSnapshot(boot.workspace) : null);
  const [loading, setLoading] = useState(boot.kind === 'none');
  const [authRequired, setAuthRequired] = useState(boot.kind === 'signed-out');
  const [online, setOnline] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [writing, setWriting] = useState(false);
  const [offlineReady, setOfflineReady] = useState<boolean | null>(null);
  const [storagePersistent, setStoragePersistent] = useState<boolean | null>(null);
  const [error, setError] = useState('');
  const [askingLogout, setAskingLogout] = useState(false);
  const [logoutPending, setLogoutPending] = useState(false);
  const workspaceRef = useRef<OfflineWorkspace | null>(null);
  const unsubscribeRef = useRef<(() => void) | null>(null);
  const generationRef = useRef(0);
  const [syncGate] = useState(createSyncGate);
  // Set once this page has prepared (or is preparing) the offline copy, so a routine refresh does not re-download
  // the shells or flicker the offline status. A failed setup clears it, so the next load tries again.
  const offlinePreparedRef = useRef(false);
  const logoutRef = useRef(false);
  // Set once this page has asked the browser to keep its storage (on the first save), so it asks at most once.
  const persistRequestedRef = useRef(false);
  // Set by "Discard and sign out" so a sync already running stops before it uploads anything else.
  const discardRef = useRef(false);

  const prepareOffline = useCallback(async (prepare = true) => {
    if (prepare) offlinePreparedRef.current = true;
    setOfflineReady(null);
    const ready = await offlineStatus(prepare);
    if (prepare && !ready) offlinePreparedRef.current = false;
    setOfflineReady(ready);
  }, []);

  const detach = useCallback(() => {
    unsubscribeRef.current?.(); unsubscribeRef.current = null;
    workspaceRef.current?.close(); workspaceRef.current = null;
  }, []);

  const requireSignIn = useCallback((message = '') => {
    detach(); setContext(null); setSnapshot(null); setClassmates([]); setAuthRequired(true); setLoading(false); setError(message);
  }, [detach]);

  const attach = useCallback(async (store: OfflineWorkspace) => {
    if (workspaceRef.current !== store) { detach(); workspaceRef.current = store; }
    const update = async () => {
      try {
        const value = await store.read();
        if (workspaceRef.current === store) {
          setSnapshot(value);
          // A context saved by an older build in another shape is skipped; the network load replaces it.
          const saved = cachedContext(value.context);
          if (saved) setContext(saved);
          // An unversioned copy from the build before CONTEXT_VERSION is re-saved stamped, which drops its friends' data.
          if (upgradedContext(value.context)) void store.upgradeContext(upgradedContext).catch(() => undefined);
        }
      } catch (err) {
        if (workspaceRef.current === store) requireSignIn(errorMessage(err));
      }
    };
    unsubscribeRef.current = store.subscribe(() => { void update(); });
    await update();
  }, [detach, requireSignIn]);

  /**
   * `background` is the idle poll: it only shows "Syncing…" when there is work to upload, so a
   * quiet check never flickers the status pill. User-started syncs (save, resolve, Retry) always show it.
   */
  const synchronize = useCallback(async function run({ background = false, duringLogout = false }: { background?: boolean; duringLogout?: boolean } = {}): Promise<void> {
    const store = workspaceRef.current;
    if (!store || !navigator.onLine || (logoutRef.current && !duringLogout)) return;
    // Uploads a change saved while a running sync was finishing, unless nothing is left to send.
    const rerun = () => { void store.read().then((state) => { if (workspaceRef.current === store && state.pending > state.conflicts.length) void run(); }, () => {}); };
    await syncGate.run(async () => {
      try {
        if (!background) setSyncing(true);
        else {
          const queued = await store.read();
          if (queued.pending > queued.conflicts.length) setSyncing(true);
        }
        const session = await api.session.query();
        // The server answered, so the app is online again even if a later step fails with a server
        // error (a connection that came back without a browser 'online' event must not stay "Offline").
        if (workspaceRef.current === store) setOnline(true);
        if (!session) { requireSignIn('Sign in again to continue. Your waiting changes are saved on this device.'); return; }
        if (session.user.id !== store.accountId) { requireSignIn('The signed-in account changed. Sign in again to open the correct account. Your waiting changes are preserved.'); return; }
        const fresh = await api.workspace.query(TASK_FIELDS);
        if (workspaceRef.current !== store) return;
        if (fresh.user.id !== store.accountId) { requireSignIn('The signed-in account changed. Sign in again to continue.'); return; }
        await store.setContext(storedContext(fresh));
        setClassmates(fresh.community.classmates);
        await store.ingest(fresh.entities);
        await store.sync(async (mutation) => {
          // A fresh account check on every upload prevents another tab's account
          // switch from sending this device's queue to a different account.
          const active = await api.session.query();
          if (!active || active.user.id !== store.accountId) {
            requireSignIn('Sign in to the original account before syncing these changes.');
            throw new Error('The signed-in account changed.');
          }
          if (discardRef.current) throw new Error('Sign-out discarded these changes.');
          return api.sync.mutate({ ...mutation, accountId: store.accountId, ...TASK_FIELDS });
        });
        // Completing a recurring task also creates its successor on the server.
        // Pull that authoritative result immediately instead of waiting for a
        // later polling cycle; ingest preserves any new local edits.
        const afterSync = await api.workspace.query(TASK_FIELDS);
        if (workspaceRef.current !== store) return;
        if (afterSync.user.id !== store.accountId) { requireSignIn('The signed-in account changed. Sign in again to continue.'); return; }
        await store.setContext(storedContext(afterSync));
        setClassmates(afterSync.community.classmates);
        await store.ingest(afterSync.entities);
        const state = await store.read();
        // Online was set when the server answered; the store work since then may have outlasted an offline event.
        if (workspaceRef.current === store) { setSnapshot(state); if (navigator.onLine) setOnline(true); setError(''); }
      } catch (err) {
        if (isUnauthorized(err)) requireSignIn('Sign in again to sync. Your waiting changes are saved on this device.');
        else if (workspaceRef.current === store) {
          // A dropped connection is not a failure: the store kept no error for it and the queue retries once back online.
          if (isTransportFailure(err)) { setOnline(false); setError(''); }
          else setError(errorMessage(err));
        }
      } finally { setSyncing(false); }
    }, rerun);
  }, [requireSignIn, syncGate]);

  /**
   * `fresh` is the workspace the server rendered into the page: it is taken as the answer, so the boot makes no
   * session or workspace request. `cachePaint: false` skips the cached-workspace paint (the server has already
   * answered that nobody is signed in), leaving the cache for the offline fallback below.
   */
  const load = useCallback(async ({ fresh: provided, cachePaint = true }: { fresh?: Workspace; cachePaint?: boolean } = {}): Promise<boolean> => {
    if (logoutRef.current) return false;
    const generation = ++generationRef.current;
    setLoading(true); setError('');
    let authenticatedId: string | null = null;
    // Show this device's last saved workspace straight away and refresh it in the
    // background. This is the last account used here, which is not necessarily the one
    // signed in now (a session can expire without a sign-out), so the session check below
    // drops it at once when it belongs to another account.
    // A refresh of a workspace already on screen skips this and only reloads it from the server below.
    try {
      const cachedId = workspaceRef.current || provided || !cachePaint ? null : await getLastAccountId();
      if (generation !== generationRef.current) return false;
      if (cachedId) {
        const store = await openWorkspace(cachedId);
        if (generation !== generationRef.current) { if (workspaceRef.current !== store) store.close(); return false; }
        const saved = await store.read();
        if (cachedContext(saved.context)) { unsubscribeRef.current?.(); await attach(store); setAuthRequired(false); }
        else if (workspaceRef.current !== store) store.close();
      }
    } catch { /* No usable cache; the network path below decides. */ }
    try {
      let current: Workspace;
      if (provided) { authenticatedId = provided.user.id; current = provided; }
      else {
        const session = await api.session.query();
        if (generation !== generationRef.current) return false;
        if (!session) { requireSignIn(); return false; }
        authenticatedId = session.user.id;
        // Another account's cached workspace must not stay on screen, or take edits, while this
        // account's workspace loads or if loading it fails.
        if (workspaceRef.current && workspaceRef.current.accountId !== session.user.id) { detach(); setContext(null); setSnapshot(null); setClassmates([]); }
        current = await api.workspace.query(TASK_FIELDS);
        if (generation !== generationRef.current) return false;
        if (current.user.id !== session.user.id) { requireSignIn('The signed-in account changed. Sign in again to continue.'); return false; }
      }
      const fresh = current;
      const store = workspaceRef.current?.accountId === fresh.user.id ? workspaceRef.current : await openWorkspace(fresh.user.id);
      if (generation !== generationRef.current) { if (workspaceRef.current !== store) store.close(); return false; }
      await store.setContext(storedContext(fresh)); await store.ingest(fresh.entities);
      unsubscribeRef.current?.(); await attach(store);
      // The device store's awaits above take real time, so the browser may have gone offline since the server answered.
      setContext(persistedContext(fresh)); setClassmates(fresh.community.classmates); setAuthRequired(false); if (navigator.onLine) setOnline(true);
      if (!offlinePreparedRef.current) void prepareOffline();
      // Only reads the current state: asking can show a permission prompt (Firefox), so that waits for a save.
      void storagePersistence().then(setStoragePersistent);
      return true;
    } catch (err) {
      if (generation !== generationRef.current) return false;
      if (isUnauthorized(err)) { requireSignIn('Sign in again to continue. Your waiting changes are preserved.'); return false; }
      if (isTransportFailure(err)) {
        try {
          const accountId = authenticatedId ?? await getLastAccountId();
          if (generation !== generationRef.current) return false;
          if (accountId) {
            const store = workspaceRef.current?.accountId === accountId ? workspaceRef.current : await openWorkspace(accountId);
            const saved = await store.read();
            if (generation !== generationRef.current) { if (workspaceRef.current !== store) store.close(); return false; }
            if (cachedContext(saved.context)) {
              unsubscribeRef.current?.(); await attach(store); setAuthRequired(false); setOnline(false); void prepareOffline(false); return false;
            }
            if (workspaceRef.current !== store) store.close();
          }
        } catch (cacheError) { setError(errorMessage(cacheError)); return false; }
        // The server was unreachable (even if the browser reports a connection: a tunnel outage, a captive portal,
        // a DNS failure or a timeout), so the no-cache notice must read as a connection problem, matching this text.
        setOnline(false);
        setError('Connect to the internet and sign in once to save this account for offline use.');
      } else {
        // The server answered, so the connection is fine; the notice shows a server error rather than "connect".
        setOnline(true);
        setError(errorMessage(err));
      }
      return false;
    } finally { if (generation === generationRef.current) setLoading(false); }
  }, [attach, detach, prepareOffline, requireSignIn]);
  // Resolves true only when this account's workspace was freshly loaded from the server; a cached or offline
  // attach, a sign-in prompt or an error resolves false. A call superseded by a newer one reports how the newer
  // one ends, so a caller never mistakes a cancelled load for a failure (or success).
  const latestLoadRef = useRef<Promise<boolean> | null>(null);
  const initialize = useCallback(() => followLatest(load, latestLoadRef), [load]);

  useEffect(() => {
    // The server's answer for this page load is the boot: its workspace goes straight into the device store (and a
    // background sync then uploads anything waiting there), or its sign-in verdict stands unless the session check
    // cannot reach the server, in which case the cached workspace opens for offline use. Without a server answer
    // (the neutral offline shell, or a server that could not decide) the boot is the usual cache-first load.
    if (boot.kind === 'workspace') void followLatest(() => load({ fresh: boot.workspace }), latestLoadRef).then((loaded) => { if (loaded) void synchronize({ background: true }); });
    else if (boot.kind === 'signed-out') void followLatest(() => load({ cachePaint: false }), latestLoadRef);
    else void initialize();
    const onOnline = () => { setOnline(true); void initialize(); };
    const onOffline = () => setOnline(false);
    window.addEventListener('online', onOnline); window.addEventListener('offline', onOffline);
    const timer = setInterval(() => { void synchronize({ background: true }); }, 15_000);
    return () => {
      generationRef.current += 1; detach(); clearInterval(timer);
      window.removeEventListener('online', onOnline); window.removeEventListener('offline', onOffline);
    };
  }, [boot, detach, initialize, load, synchronize]);

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
    // A waiting change lives only in this browser's storage, so the first save on this page asks the browser not to
    // evict it under storage pressure. Asked after the student acted, never on load: Firefox shows a prompt for it.
    if (!persistRequestedRef.current) { persistRequestedRef.current = true; void requestPersistentStorage().then(setStoragePersistent); }
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
    if (writing) { setError('Wait for the current save to finish, then sign out.'); return; }
    // Blocks new syncs; one already running (often the background poll) is awaited below.
    logoutRef.current = true;
    discardRef.current = discard;
    generationRef.current += 1;
    setLoading(false);
    setLogoutPending(true); setError('');
    const store = workspaceRef.current;
    try {
      if (syncGate.running) await syncGate.running;
      const outcome = await signOutDevice(store, discard, {
        session: () => api.session.query(),
        attached: (candidate) => workspaceRef.current === candidate,
        synchronize: () => synchronize({ duringLogout: true }),
        unsubscribePush: async (accountId) => {
          if (!('serviceWorker' in navigator && 'PushManager' in window)) return;
          const registration = await navigator.serviceWorker.getRegistration('/');
          const subscription = await registration?.pushManager.getSubscription();
          if (!subscription) return;
          if (accountId) await api.notifications.unsubscribe.mutate({ accountId, endpoint: subscription.endpoint });
          await subscription.unsubscribe();
        },
        signOut: async () => { await signOut({ redirect: false, callbackUrl: '/' }); },
        forget: (accountId) => { localStorage.removeItem(`quasar-push:${accountId}`); clearSetupState(accountId); },
        detach, clear: clearOfflineAccount,
      });
      if (outcome !== 'signed-out') { setAskingLogout(false); requireSignIn(outcome.kept); return; }
      setContext(null); setSnapshot(null); setClassmates([]); setAuthRequired(true); setAskingLogout(false);
      window.location.assign('/');
    } catch (err) {
      setError(isTransportFailure(err) ? 'Could not finish signing out. Reconnect and try again. Your saved data and waiting changes are preserved.' : errorMessage(err));
    } finally {
      logoutRef.current = false; discardRef.current = false; setLogoutPending(false);
    }
  }, [detach, requireSignIn, synchronize, syncGate, writing]);

  const requestLogout = useCallback(() => {
    if (snapshot?.pending) setAskingLogout(true);
    else void finishLogout(false);
  }, [finishLogout, snapshot?.pending]);

  // Red states outrank the transient spinner so they stay put (and announced once) while a retry runs.
  // Offline outranks a stored error: a dropped connection mid-upload is not a failed sync.
  const failure = snapshot?.lastError && !legacyTransportError(snapshot.lastError) ? snapshot.lastError : null;
  const sync: SyncState = writing ? { kind: 'saving' }
    : snapshot?.conflicts.length ? { kind: 'conflict', count: snapshot.conflicts.length }
    : !online ? { kind: 'offline', ready: offlineReady, pending: snapshot?.pending ?? 0 }
    : failure ? { kind: 'failed', message: errorMessage(new Error(failure)) }
    : syncing ? { kind: 'syncing' }
    : snapshot?.pending ? { kind: 'pending', count: snapshot.pending }
    : { kind: 'saved' };

  const visibleContext = useMemo(() => context && withClassmates(context, classmates), [context, classmates]);

  return {
    context: visibleContext, snapshot, loading, authRequired, online, syncing, writing, offlineReady, storagePersistent, error, sync,
    logout: { asking: askingLogout, pending: logoutPending },
    offlineSupported: serviceWorkerEnabled && typeof navigator !== 'undefined' && 'serviceWorker' in navigator,
    initialize, synchronize: () => synchronize(), prepareOffline: () => prepareOffline(), save, resolve,
    requestLogout, finishLogout, cancelLogout: () => setAskingLogout(false), dismissError: () => setError(''),
  };
}
