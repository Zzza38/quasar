import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import { mergeMutation, mergePreferringLocal, type Entity, type EntityKind, type Mutation, type SyncResult } from "../domain/sync";
import { personalScheduleSchema } from "../domain/schedule";
import { completionTime, stampCompletion, taskSchema, withoutCompletionEdit } from "../domain/task";
import { errorMessage, isPermanentRejection, isTransportFailure } from "./api";

interface ConflictInfo {
  current: Entity | null;
  paths: string[];
  /** Set when the server refused the change itself; the student retries it against `current` or discards it. */
  rejected?: string;
}

interface QueuedMutation {
  mutation: Mutation;
  state: "queued" | "sending" | "conflict";
  conflict?: ConflictInfo;
}

interface StoredWorkspace {
  accountId: string;
  server: Entity[];
  queue: QueuedMutation[];
  context: Record<string, unknown> | null;
  lastError: string | null;
  lease: { owner: string; until: number } | null;
  /**
   * Set by the tab that is signing out, so other tabs of the same account stop queueing and uploading
   * until it finishes. Missing in records written before this field existed.
   */
  signingOut?: { owner: string; until: number } | null;
}

interface OfflineDatabase extends DBSchema {
  workspaces: { key: string; value: StoredWorkspace };
  meta: { key: string; value: string };
}

export interface WorkspaceSnapshot {
  accountId: string;
  /** Optimistic records, including tombstones. Filter deleted records for display. */
  entities: Entity[];
  /** Includes mutations waiting for conflict resolution. */
  pending: number;
  conflicts: Array<{ mutation: Mutation; current: Entity | null; paths: string[]; rejected?: string }>;
  context: Record<string, unknown> | null;
  lastError: string | null;
}

// Keep the persisted legacy key so Quasar retains existing unsynced edits.
const DATABASE = "whatsnext-offline-v1";
const LEASE_MS = 30_000;
/** A crashed or closed tab's sign-out marker stops blocking the other tabs after this long. */
const SIGN_OUT_MS = 120_000;
const SIGNING_OUT_ELSEWHERE = "Signing out in another tab. Wait for it to finish, then try again.";
const keyOf = (value: { kind: EntityKind; id: string }) => `${value.kind}:${value.id}`;
const clone = <T>(value: T): T => structuredClone(value);

function connect(): Promise<IDBPDatabase<OfflineDatabase>> {
  return openDB<OfflineDatabase>(DATABASE, 1, {
    upgrade(database) {
      database.createObjectStore("workspaces", { keyPath: "accountId" });
      database.createObjectStore("meta");
    },
  });
}

function empty(accountId: string): StoredWorkspace {
  return { accountId, server: [], queue: [], context: null, lastError: null, lease: null, signingOut: null };
}

function optimistic(state: StoredWorkspace): Entity[] {
  const entities = new Map(state.server.map((entity) => [keyOf(entity), entity]));
  for (const { mutation } of state.queue) {
    const key = keyOf(mutation);
    entities.set(key, {
      id: mutation.id,
      kind: mutation.kind,
      version: entities.get(key)?.version ?? mutation.base?.version ?? 0,
      data: mutation.data ?? {},
      deleted: mutation.data === null,
    });
  }
  return [...entities.values()];
}

const schemaFor = (kind: EntityKind) => kind === "task" ? taskSchema : personalScheduleSchema;

/**
 * A task's `imported` calendar metadata belongs to the server's calendar refresh, which the server enforces
 * against the mutation's base. Every payload built against a base carries that base's value (or none).
 */
function withServerImported(kind: EntityKind, data: Record<string, unknown>, source: Entity | null): Record<string, unknown>;
function withServerImported(kind: EntityKind, data: Record<string, unknown> | null, source: Entity | null): Record<string, unknown> | null;
function withServerImported(kind: EntityKind, data: Record<string, unknown> | null, source: Entity | null) {
  if (kind !== "task" || data === null) return data;
  const next = { ...data };
  if (source && !source.deleted && Object.hasOwn(source.data, "imported")) next.imported = clone(source.data.imported);
  else delete next.imported;
  return next;
}

/**
 * A task's completedAt is server-owned too (the server restamps it), so a local stamp is never an edit that
 * could conflict with the time another device completed the same task.
 */
function withoutServerFields(kind: EntityKind, data: Record<string, unknown> | null, base: Entity | null): Record<string, unknown> | null {
  const next = withServerImported(kind, data, base);
  return kind === "task" && next ? withoutCompletionEdit(next, base) : next;
}

/** Restamps a rebased task against the latest server copy, keeping the local stamp when this edit completes it. */
function withLocalCompletion(kind: EntityKind, data: Record<string, unknown>, sent: Record<string, unknown> | null, current: Entity | null): Record<string, unknown> {
  if (kind !== "task") return data;
  const now = new Date();
  return stampCompletion(data, current && !current.deleted ? current.data : null, completionTime(sent?.completedAt, now));
}

/**
 * "Keep my changes": the local value wins only where the edits actually compete, so the other side's
 * independent edits survive. A combination that breaks a cross-field invariant (the conflict itself came
 * from validation) falls back to the whole local version, which was valid when it was saved.
 */
function keepLocal(conflicted: Mutation, local: Entity, current: Entity | null): Record<string, unknown> | null {
  if (local.deleted) return null;
  const desired = withServerImported(local.kind, local.data, conflicted.base);
  let data = desired;
  if (!conflicted.base || !current || conflicted.base.version <= current.version) {
    const merged = mergePreferringLocal({ ...conflicted, data: desired }, current);
    if (merged && schemaFor(local.kind).safeParse(withServerImported(local.kind, merged, current)).success) data = merged;
  }
  return withServerImported(local.kind, data, current);
}

function snapshot(state: StoredWorkspace): WorkspaceSnapshot {
  return {
    accountId: state.accountId,
    entities: optimistic(state),
    pending: state.queue.length,
    conflicts: state.queue.filter((item) => item.state === "conflict").map((item) => ({
      mutation: item.mutation,
      current: item.conflict!.current,
      paths: item.conflict!.paths,
      ...(item.conflict!.rejected ? { rejected: item.conflict!.rejected } : {}),
    })),
    context: state.context,
    lastError: state.lastError,
  };
}

/** Call only following fresh online authentication, or to reopen a known account offline. */
export async function openWorkspace(accountId: string): Promise<OfflineWorkspace> {
  if (!accountId) throw new Error("An authenticated account is required");
  const database = await connect();
  const transaction = database.transaction(["workspaces", "meta"], "readwrite");
  if (!await transaction.objectStore("workspaces").get(accountId)) {
    await transaction.objectStore("workspaces").put(empty(accountId));
  }
  await transaction.objectStore("meta").put(accountId, "lastAccountId");
  await transaction.done;
  return new OfflineWorkspace(database, accountId);
}

/**
 * Whether the browser already keeps this origin's storage, without asking for it (so it never shows a prompt).
 * Resolves true when storage is persistent, false when it is best-effort, and null when it cannot tell. Never throws.
 */
export async function storagePersistence(): Promise<boolean | null> {
  try {
    const storage = typeof navigator === "undefined" ? undefined : navigator.storage;
    return storage?.persisted ? await storage.persisted() : null;
  } catch {
    return null;
  }
}

/**
 * Asks the browser to keep this origin's storage, so the queue of unsynced edits is not evicted silently
 * when the device runs low on space. Best effort: browsers grant it by their own heuristics (an installed
 * app, engagement), and some may still clear storage for sites that go unused. Firefox asks the student with a
 * permission prompt, so call this only after the student acted (a save), never on a routine load. Resolves true
 * when storage is persistent, false when the browser keeps it best-effort, and null when it cannot tell. Never throws.
 */
export async function requestPersistentStorage(): Promise<boolean | null> {
  try {
    const storage = typeof navigator === "undefined" ? undefined : navigator.storage;
    if (!storage?.persisted || !storage.persist) return null;
    if (await storage.persisted()) return true;
    return await storage.persist();
  } catch {
    return null;
  }
}

/** Only use this fallback for a network failure, never for an authentication rejection. */
export async function getLastAccountId(): Promise<string | null> {
  const database = await connect();
  try {
    return await database.get("meta", "lastAccountId") ?? null;
  } finally {
    database.close();
  }
}

/**
 * Explicit sign-out removes this device's private cache, including queued changes. With `requireEmptyQueue`
 * (a sign-out that did not choose to discard changes) it refuses, keeping the cache, when a change was queued
 * after the caller last checked, for example by another tab; the check and the delete are one transaction.
 */
export async function clearOfflineAccount(accountId: string, { requireEmptyQueue = false }: { requireEmptyQueue?: boolean } = {}): Promise<void> {
  const database = await connect();
  try {
    const transaction = database.transaction(["workspaces", "meta"], "readwrite");
    const workspaces = transaction.objectStore("workspaces");
    const state = requireEmptyQueue ? await workspaces.get(accountId) : undefined;
    if (state?.queue.length) {
      // The sign-out stops here, so release the other tabs.
      state.signingOut = null;
      await workspaces.put(state);
      await transaction.done;
      throw new Error("A change was saved while signing out, so it was kept on this device. Sign in again to sync it, or sign out and discard it.");
    }
    await workspaces.delete(accountId);
    if (await transaction.objectStore("meta").get("lastAccountId") === accountId) {
      await transaction.objectStore("meta").delete("lastAccountId");
    }
    await transaction.done;
    if (typeof BroadcastChannel !== "undefined") {
      const channel = new BroadcastChannel(DATABASE);
      channel.postMessage({ accountId, cleared: true });
      channel.close();
    }
  } finally {
    database.close();
  }
}

/** Clears a sign-out marker owned by `token`, for a handle that was closed before it could release its own. */
async function releaseSignOut(accountId: string, token: string): Promise<void> {
  const database = await connect();
  try {
    const transaction = database.transaction("workspaces", "readwrite");
    const state = await transaction.store.get(accountId);
    const owned = state?.signingOut?.owner === token;
    if (state && owned) {
      state.signingOut = null;
      await transaction.store.put(state);
    }
    await transaction.done;
    if (owned && typeof BroadcastChannel !== "undefined") {
      const channel = new BroadcastChannel(DATABASE);
      channel.postMessage({ accountId });
      channel.close();
    }
  } finally {
    database.close();
  }
}

export class OfflineWorkspace {
  private readonly listeners = new Set<() => void>();
  private readonly channel: BroadcastChannel | null;
  private syncing: Promise<void> | null = null;
  private closed = false;
  /** This handle's sign-out marker, which lets its own final sync run while other tabs wait. */
  private signOutToken: string | null = null;

  constructor(private readonly database: IDBPDatabase<OfflineDatabase>, readonly accountId: string) {
    this.channel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel(DATABASE) : null;
    if (this.channel) this.channel.onmessage = (event: MessageEvent<{ accountId: string }>) => {
      if (event.data.accountId === accountId) this.notify(false);
    };
  }

  private assertOpen() {
    if (this.closed) throw new Error("Offline workspace is closed");
  }

  private notify(broadcast = true) {
    for (const listener of this.listeners) listener();
    if (broadcast) this.channel?.postMessage({ accountId: this.accountId });
  }

  /** All writes, including lease claims, are atomic across browser tabs. */
  private async update<T>(change: (state: StoredWorkspace) => T): Promise<T> {
    this.assertOpen();
    const transaction = this.database.transaction("workspaces", "readwrite");
    const state = await transaction.store.get(this.accountId);
    if (!state) {
      transaction.abort();
      // Sign-out in another tab must not recreate a deleted private cache.
      await transaction.done.catch(() => undefined);
      throw new Error("This offline account was cleared. Sign in again.");
    }
    let result: T;
    try {
      result = change(state);
      await transaction.store.put(state);
      await transaction.done;
    } catch (error) {
      try { transaction.abort(); } catch { /* Already completed or aborted. */ }
      await transaction.done.catch(() => undefined);
      throw error;
    }
    this.notify();
    return result;
  }

  /** True while another tab's unexpired sign-out marker is set. */
  private signingOutElsewhere(state: StoredWorkspace): boolean {
    return !!state.signingOut && state.signingOut.until > Date.now() && state.signingOut.owner !== this.signOutToken;
  }

  /**
   * Marks the account as signing out, so every other tab refuses to queue or upload changes until
   * `endSignOut` or the marker expires. Refuses while another tab is already signing out.
   */
  async beginSignOut(): Promise<void> {
    const token = crypto.randomUUID();
    await this.update((state) => {
      if (this.signingOutElsewhere(state)) throw new Error(SIGNING_OUT_ELSEWHERE);
      state.signingOut = { owner: token, until: Date.now() + SIGN_OUT_MS };
    });
    this.signOutToken = token;
  }

  /**
   * Releases this handle's sign-out marker. Best effort: a cleared account has nothing to release. A handle closed
   * mid-sign-out (detached when the session changed during the final sync) still owns its marker, so it is released
   * through a fresh connection; otherwise the student's next session here would be blocked until it expired.
   */
  async endSignOut(): Promise<void> {
    const token = this.signOutToken;
    this.signOutToken = null;
    if (!token) return;
    if (this.closed) { await releaseSignOut(this.accountId, token).catch(() => undefined); return; }
    await this.update((state) => {
      if (state.signingOut?.owner === token) state.signingOut = null;
    }).catch(() => undefined);
  }

  async read(): Promise<WorkspaceSnapshot> {
    this.assertOpen();
    const state = await this.database.get("workspaces", this.accountId);
    if (!state) throw new Error("This offline account was cleared. Sign in again.");
    return snapshot(state);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  async setContext(context: Record<string, unknown>): Promise<void> {
    const saved = clone(context);
    await this.update((state) => { state.context = saved; });
  }

  /**
   * Replaces the saved context with `upgrade(saved)` in one transaction, so a newer context another tab or a network
   * load wrote meanwhile is never overwritten by the upgraded old one. `upgrade` returns null to leave it unchanged.
   */
  async upgradeContext(upgrade: (context: Record<string, unknown> | null) => Record<string, unknown> | null): Promise<void> {
    await this.update((state) => {
      const next = upgrade(state.context);
      if (next) state.context = clone(next);
    });
  }

  /** A complete authenticated server snapshot; local work always stays queued. */
  async ingest(entities: Entity[]): Promise<void> {
    const received = clone(entities);
    await this.update((state) => {
      const previous = new Map(state.server.map((entity) => [keyOf(entity), entity]));
      // A slower bootstrap must never replace an entity already acknowledged
      // by a newer sync response in this or another tab.
      state.server = received.map((entity) => {
        const old = previous.get(keyOf(entity));
        return old && old.version > entity.version ? old : entity;
      });
      for (const entity of previous.values()) {
        if (!received.some((incoming) => keyOf(incoming) === keyOf(entity))) state.server.push(entity);
      }
    });
  }

  /** Resolves after IndexedDB commits, before any network request is required. */
  async save(kind: EntityKind, id: string, data: Record<string, unknown> | null): Promise<void> {
    const desired = clone(data);
    await this.update((state) => {
      if (this.signingOutElsewhere(state)) throw new Error(SIGNING_OUT_ELSEWHERE);
      const base = optimistic(state).find((entity) => entity.id === id && entity.kind === kind) ?? null;
      state.queue.push({
        state: "queued",
        // A draft or undo snapshot may predate a calendar refresh; its stale metadata is not an edit.
        // completedAt is stamped here only so a task checked off offline sorts as just done; the server restamps it.
        mutation: { mutationId: crypto.randomUUID(), kind, id, base, data: withServerImported(kind, kind === "task" && desired ? stampCompletion(desired, base && !base.deleted ? base.data : null, new Date()) : desired, base) },
      });
      state.lastError = null;
    });
  }

  /**
   * Uploads ordered edits. A crashed tab's lease expires; retries keep the exact
   * original mutation ID and base, so duplicate requests are safe on the server.
   */
  sync(sendMutation: (mutation: Mutation) => Promise<SyncResult>): Promise<void> {
    this.assertOpen();
    if (this.syncing) return this.syncing;
    this.syncing = this.flush(sendMutation).finally(() => { this.syncing = null; });
    return this.syncing;
  }

  private async flush(sendMutation: (mutation: Mutation) => Promise<SyncResult>): Promise<void> {
    const owner = crypto.randomUUID();
    try {
      while (!this.closed) {
        const claimed = await this.update((state): Mutation | null => {
          if (state.lease && state.lease.owner !== owner && state.lease.until > Date.now()) return null;
          // Another tab is signing out: a change it chose to discard must not be uploaded from here.
          if (this.signingOutElsewhere(state)) return null;
          state.lease = { owner, until: Date.now() + LEASE_MS };
          const blocked = new Set<string>();
          for (const item of state.queue) {
            const key = keyOf(item.mutation);
            if (item.state === "conflict") { blocked.add(key); continue; }
            if (blocked.has(key)) continue;
            if (item.state === "queued") {
              const current = state.server.find((entity) => keyOf(entity) === key) ?? null;
              const rebased = mergeMutation({ ...item.mutation, data: withoutServerFields(item.mutation.kind, item.mutation.data, item.mutation.base) }, current);
              if (rebased.status === "conflict") {
                item.state = "conflict";
                item.conflict = { current: rebased.current, paths: rebased.paths };
                blocked.add(key);
                continue;
              }
              const data = rebased.entity.deleted ? null : withLocalCompletion(item.mutation.kind, withServerImported(item.mutation.kind, rebased.entity.data, current), item.mutation.data, current);
              if (data) {
                const validation = schemaFor(item.mutation.kind).safeParse(data);
                if (!validation.success) {
                  // Individually valid edits can break a cross-field invariant
                  // together (for example assigning a remotely deleted class).
                  // Keep the original alternatives; never freeze an invalid
                  // synthesized payload into a permanently rejected retry.
                  item.state = "conflict";
                  item.conflict = {
                    current,
                    paths: [...new Set(validation.error.issues.map((issue) =>
                      issue.path.length ? `/${issue.path.map((part) => String(part).replaceAll("~", "~0").replaceAll("/", "~1")).join("/")}` : "/"))],
                  };
                  blocked.add(key);
                  continue;
                }
              }
              item.mutation.base = current;
              item.mutation.data = data;
              item.state = "sending";
            }
            return clone(item.mutation);
          }
          return null;
        });
        if (!claimed) return;
        let result: SyncResult;
        try {
          result = await sendMutation(claimed);
        } catch (error) {
          if (!isPermanentRejection(error)) throw error;
          // The frozen payload would fail identically forever and hold up every later upload.
          // Park it as a choice for this entity only, keeping the server's reason, and go on.
          const reason = errorMessage(error);
          await this.update((state) => {
            const item = state.queue.find((entry) => entry.mutation.mutationId === claimed.mutationId);
            if (!item || item.state !== "sending") return;
            item.state = "conflict";
            item.conflict = { current: state.server.find((entity) => keyOf(entity) === keyOf(claimed)) ?? null, paths: ["/"], rejected: reason };
            state.lastError = null;
          });
          continue;
        }
        if (result.status === "applied" && (keyOf(result.entity) !== keyOf(claimed) || !Number.isInteger(result.entity.version))) {
          throw new Error("The server returned an invalid sync response");
        }
        await this.update((state) => {
          const index = state.queue.findIndex((item) => item.mutation.mutationId === claimed.mutationId);
          // Another tab may have finished the same idempotent retry first.
          if (index < 0) return;
          if (result.status === "applied") {
            const existing = state.server.findIndex((entity) => keyOf(entity) === keyOf(result.entity));
            if (existing < 0) state.server.push(result.entity);
            else if (state.server[existing].version <= result.entity.version) state.server[existing] = result.entity;
            state.queue.splice(index, 1);
          } else {
            state.queue[index].state = "conflict";
            state.queue[index].conflict = { current: result.current, paths: result.paths };
            if (result.current) {
              const existing = state.server.findIndex((entity) => keyOf(entity) === keyOf(result.current!));
              if (existing < 0) state.server.push(result.current);
              else if (state.server[existing].version <= result.current.version) state.server[existing] = result.current;
            }
          }
          state.lastError = null;
        });
      }
    } catch (error) {
      if (!this.closed) await this.update((state) => {
        // A dropped connection is not a sync failure: the queue is intact and retries once the connection is back.
        state.lastError = isTransportFailure(error) ? null : errorMessage(error);
      }).catch(() => undefined);
      throw error;
    } finally {
      if (!this.closed) await this.update((state) => {
        if (state.lease?.owner === owner) state.lease = null;
      }).catch(() => undefined);
    }
  }

  /** Explicit choice resolves this entity, including later edits made locally. */
  async resolve(mutationId: string, choice: "local" | "remote"): Promise<void> {
    await this.update((state) => {
      if (this.signingOutElsewhere(state)) throw new Error(SIGNING_OUT_ELSEWHERE);
      const item = state.queue.find((entry) => entry.mutation.mutationId === mutationId);
      if (!item || item.state !== "conflict" || !item.conflict) throw new Error("This conflict is no longer available");
      const key = keyOf(item.mutation);
      const local = optimistic(state).find((entity) => keyOf(entity) === key)!;
      const current = item.conflict.current;
      state.queue = state.queue.filter((entry) => keyOf(entry.mutation) !== key);
      if (current) {
        const index = state.server.findIndex((entity) => keyOf(entity) === key);
        if (index < 0) state.server.push(current);
        else if (state.server[index].version <= current.version) state.server[index] = current;
      } else {
        state.server = state.server.filter((entity) => keyOf(entity) !== key);
      }
      if (choice === "local") {
        state.queue.push({
          state: "queued",
          mutation: {
            mutationId: crypto.randomUUID(), id: local.id, kind: local.kind,
            base: current, data: keepLocal(item.mutation, local, current),
          },
        });
      }
      state.lastError = null;
    });
  }

  close(): void {
    this.closed = true;
    this.channel?.close();
    this.listeners.clear();
    this.database.close();
  }
}
