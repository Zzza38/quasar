import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import { mergeMutation, type Entity, type EntityKind, type Mutation, type SyncResult } from "../domain/sync";
import { personalScheduleSchema } from "../domain/schedule";
import { taskSchema } from "../domain/task";

interface QueuedMutation {
  mutation: Mutation;
  state: "queued" | "sending" | "conflict";
  conflict?: { current: Entity | null; paths: string[] };
}

interface StoredWorkspace {
  accountId: string;
  server: Entity[];
  queue: QueuedMutation[];
  context: Record<string, unknown> | null;
  lastError: string | null;
  lease: { owner: string; until: number } | null;
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
  conflicts: Array<{ mutation: Mutation; current: Entity | null; paths: string[] }>;
  context: Record<string, unknown> | null;
  lastError: string | null;
}

const DATABASE = "whatsnext-offline-v1";
const LEASE_MS = 30_000;
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
  return { accountId, server: [], queue: [], context: null, lastError: null, lease: null };
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

function snapshot(state: StoredWorkspace): WorkspaceSnapshot {
  return {
    accountId: state.accountId,
    entities: optimistic(state),
    pending: state.queue.length,
    conflicts: state.queue.filter((item) => item.state === "conflict").map((item) => ({
      mutation: item.mutation,
      current: item.conflict!.current,
      paths: item.conflict!.paths,
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

/** Only use this fallback for a network failure, never for an authentication rejection. */
export async function getLastAccountId(): Promise<string | null> {
  const database = await connect();
  try {
    return await database.get("meta", "lastAccountId") ?? null;
  } finally {
    database.close();
  }
}

/** Explicit sign-out removes this device's private cache, including queued changes. */
export async function clearOfflineAccount(accountId: string): Promise<void> {
  const database = await connect();
  try {
    const transaction = database.transaction(["workspaces", "meta"], "readwrite");
    await transaction.objectStore("workspaces").delete(accountId);
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

export class OfflineWorkspace {
  private readonly listeners = new Set<() => void>();
  private readonly channel: BroadcastChannel | null;
  private syncing: Promise<void> | null = null;
  private closed = false;

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
      const base = optimistic(state).find((entity) => entity.id === id && entity.kind === kind) ?? null;
      state.queue.push({
        state: "queued",
        mutation: { mutationId: crypto.randomUUID(), kind, id, base, data: desired },
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
          state.lease = { owner, until: Date.now() + LEASE_MS };
          const blocked = new Set<string>();
          for (const item of state.queue) {
            const key = keyOf(item.mutation);
            if (item.state === "conflict") { blocked.add(key); continue; }
            if (blocked.has(key)) continue;
            if (item.state === "queued") {
              const current = state.server.find((entity) => keyOf(entity) === key) ?? null;
              const rebased = mergeMutation(item.mutation, current);
              if (rebased.status === "conflict") {
                item.state = "conflict";
                item.conflict = { current: rebased.current, paths: rebased.paths };
                blocked.add(key);
                continue;
              }
              if (!rebased.entity.deleted) {
                const schema = item.mutation.kind === "task" ? taskSchema : personalScheduleSchema;
                const validation = schema.safeParse(rebased.entity.data);
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
              item.mutation.data = rebased.entity.deleted ? null : rebased.entity.data;
              item.state = "sending";
            }
            return clone(item.mutation);
          }
          return null;
        });
        if (!claimed) return;
        const result = await sendMutation(claimed);
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
        state.lastError = error instanceof Error ? error.message : "Sync failed. Your changes are saved on this device.";
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
            base: current, data: local.deleted ? null : local.data,
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
