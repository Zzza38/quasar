import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearOfflineAccount, openWorkspace, type OfflineWorkspace } from '@/client/offline';
import { createSyncGate, followLatest, signOutDevice, type SignOutSteps } from './use-workspace';

function deferred() {
  let resolve!: (value: boolean) => void;
  const promise = new Promise<boolean>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('workspace reload outcome', () => {
  it('reports whether the load succeeded, so a failed reload is not shown as reloaded', async () => {
    const latest = { current: null as Promise<boolean> | null };
    await expect(followLatest(async () => false, latest)).resolves.toBe(false);
    await expect(followLatest(async () => true, latest)).resolves.toBe(true);
  });

  it('answers a superseded call with the newer load’s outcome', async () => {
    const latest = { current: null as Promise<boolean> | null };
    const older = deferred();
    const newer = deferred();
    const first = followLatest(() => older.promise, latest);
    const second = followLatest(() => newer.promise, latest);
    older.resolve(false);
    newer.resolve(true);
    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(true);
  });
});

describe('sync gate', () => {
  it('runs a sync called during a running one once more after it ends, so a late save is uploaded', async () => {
    const gate = createSyncGate();
    const first = deferred();
    const runs: string[] = [];
    let reruns = 0;
    const running = gate.run(async () => { runs.push('first'); await first.promise; }, () => { reruns += 1; });
    expect(gate.running).not.toBeNull();
    // Two saves land while it runs: they fold into one rerun, and neither starts a sync of its own.
    await gate.run(async () => { runs.push('second'); }, () => undefined);
    await gate.run(async () => { runs.push('third'); }, () => undefined);
    expect(reruns).toBe(0);
    first.resolve(true);
    await running;
    expect(runs).toEqual(['first']);
    expect(reruns).toBe(1);
    expect(gate.running).toBeNull();
  });

  it('does not rerun when nothing arrived meanwhile, and releases the gate after a failure', async () => {
    const gate = createSyncGate();
    let reruns = 0;
    await gate.run(async () => undefined, () => { reruns += 1; });
    await expect(gate.run(async () => { throw new Error('boom'); }, () => { reruns += 1; })).rejects.toThrow('boom');
    expect(reruns).toBe(0);
    expect(gate.running).toBeNull();
  });

  it('lets sign-out wait for the running sync to finish', async () => {
    const gate = createSyncGate();
    const upload = deferred();
    let finished = false;
    void gate.run(async () => { await upload.promise; finished = true; }, () => undefined);
    const waiting = gate.running!.then(() => finished);
    upload.resolve(true);
    await expect(waiting).resolves.toBe(true);
  });
});

describe('signing out of a device', () => {
  const handles: OfflineWorkspace[] = [];
  const accounts = new Set<string>();
  async function workspace(accountId: string = crypto.randomUUID()) {
    accounts.add(accountId);
    const opened = await openWorkspace(accountId);
    handles.push(opened);
    return opened;
  }
  const taskData = (title: string) => ({ title, notes: '', completed: false, dueDate: null, dueTime: null, classId: null });
  afterEach(async () => {
    handles.splice(0).forEach((handle) => handle.close());
    for (const account of accounts) await clearOfflineAccount(account);
    accounts.clear();
  });

  /** A signed-in server whose session ends when signOut() runs; `attached` is the store on screen. */
  function steps(store: OfflineWorkspace, overrides: Partial<SignOutSteps> = {}) {
    let signedIn: string | null = store.accountId;
    let attached: OfflineWorkspace | null = store;
    const calls = { signOut: 0, cleared: [] as string[], forgotten: [] as string[] };
    const value: SignOutSteps = {
      session: async () => signedIn ? { user: { id: signedIn } } : null,
      attached: (candidate) => attached === candidate,
      synchronize: async () => undefined,
      unsubscribePush: async () => undefined,
      signOut: async () => { calls.signOut += 1; signedIn = null; },
      forget: (accountId) => { calls.forgotten.push(accountId); },
      detach: () => { attached?.close(); attached = null; },
      clear: async (accountId, options) => { await clearOfflineAccount(accountId, options); calls.cleared.push(accountId); },
      ...overrides,
    };
    return { value, calls, switchAccount: (id: string) => { signedIn = id; }, detach: () => value.detach() };
  }

  it('signs out and clears the device cache', async () => {
    const store = await workspace();
    const world = steps(store);
    await expect(signOutDevice(store, false, world.value)).resolves.toBe('signed-out');
    expect(world.calls.signOut).toBe(1);
    expect(world.calls.cleared).toEqual([store.accountId]);
    expect(world.calls.forgotten).toContain(store.accountId);
  });

  it('releases the sign-out marker when the final sync ended in a sign-in prompt, so the next session can save', async () => {
    const store = await workspace();
    await store.save('task', 't1', taskData('Waiting'));
    const world = steps(store);
    // The session changed during the upload: requireSignIn detached (closed) the store.
    world.value.synchronize = async () => { world.detach(); };
    await expect(signOutDevice(store, false, world.value)).rejects.toThrow('closed');
    expect(world.calls.signOut).toBe(0);
    const next = await workspace(store.accountId);
    await next.save('task', 't2', taskData('Signed back in'));
    expect((await next.read()).pending).toBe(2);
  });

  it('refuses when another tab switched the signed-in account, keeping this account and releasing other tabs', async () => {
    const store = await workspace();
    const other = await workspace(store.accountId);
    await other.save('task', 't1', taskData('Waiting'));
    const world = steps(store);
    world.switchAccount('someone-else');
    await expect(signOutDevice(store, true, world.value)).rejects.toThrow('Your session changed');
    expect(world.calls.signOut).toBe(0);
    expect(world.calls.cleared).toEqual([]);
    await other.save('task', 't2', taskData('Still saving'));
    expect((await other.read()).pending).toBe(2);
  });

  it('refuses before starting when the store on screen is no longer this one', async () => {
    const store = await workspace();
    const world = steps(store);
    world.detach();
    const reopened = await workspace(store.accountId);
    await expect(signOutDevice(store, false, world.value)).rejects.toThrow('Your session changed');
    await reopened.save('task', 't1', taskData('Not blocked'));
    expect(world.calls.signOut).toBe(0);
  });

  it('keeps a change another tab queued during sign-out behind the sign-in screen, and releases the marker', async () => {
    const store = await workspace();
    const older = await workspace(store.accountId);
    const world = steps(store);
    // A tab that outlived the marker's expiry queues a change after the queue check, just before the cache is cleared.
    const signOut = world.value.signOut;
    world.value.signOut = async () => {
      await signOut();
      vi.setSystemTime(Date.now() + 121_000);
      await older.save('task', 't1', taskData('Late edit'));
      vi.useRealTimers();
    };
    vi.useFakeTimers({ toFake: ['Date'] });
    let outcome: Awaited<ReturnType<typeof signOutDevice>>;
    try { outcome = await signOutDevice(store, false, world.value); } finally { vi.useRealTimers(); }
    expect(outcome).toEqual({ kept: expect.stringContaining('kept on this device') });
    expect(world.calls.cleared).toEqual([]);
    expect((await older.read()).pending).toBe(1);
    await older.save('task', 't2', taskData('Not blocked'));
  });

  it('needs the original account signed in before it syncs waiting changes', async () => {
    const store = await workspace();
    await store.save('task', 't1', taskData('Waiting'));
    const world = steps(store, { session: async () => null });
    const synchronize = vi.fn(async () => undefined);
    world.value.synchronize = synchronize;
    await expect(signOutDevice(store, false, world.value)).rejects.toThrow('Sign in to the original account');
    expect(synchronize).not.toHaveBeenCalled();
    expect((await store.read()).pending).toBe(1);
  });

  it('discards waiting changes without uploading them when the student chose to', async () => {
    const store = await workspace();
    await store.save('task', 't1', taskData('Discard me'));
    const synchronize = vi.fn(async () => undefined);
    const world = steps(store, { synchronize });
    await expect(signOutDevice(store, true, world.value)).resolves.toBe('signed-out');
    expect(synchronize).not.toHaveBeenCalled();
    expect(world.calls.cleared).toEqual([store.accountId]);
  });
});
