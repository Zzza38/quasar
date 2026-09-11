/** Wire format shared by the API and the durable offline queue. */
export type EntityKind = "task" | "personal";

export interface Entity {
  id: string;
  kind: EntityKind;
  version: number;
  data: Record<string, unknown>;
  deleted: boolean;
}

export interface Mutation {
  mutationId: string;
  id: string;
  kind: EntityKind;
  base: Entity | null;
  /** null is a deletion, including a retry of a deletion. */
  data: Record<string, unknown> | null;
}

export type SyncResult =
  | { status: "applied"; entity: Entity }
  | { status: "conflict"; current: Entity | null; paths: string[] };

const missing = Symbol("missing");
type Value = unknown | typeof missing;

function equal(a: Value, b: Value): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((value, index) => equal(value, b[index]));
  }
  if (isObject(a) && isObject(b)) {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length &&
      keys.every((key) => Object.hasOwn(b, key) && equal(a[key], b[key]));
  }
  return false;
}

function isObject(value: Value): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function pointer(path: string, key: string) {
  return `${path}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`;
}

function isKeyedArray(value: Value, key: string): value is Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return false;
  const ids = new Set<string>();
  return value.every((item) => {
    if (!isObject(item) || typeof item[key] !== "string" || ids.has(item[key])) return false;
    ids.add(item[key]);
    return true;
  });
}

function mergeValue(base: Value, local: Value, remote: Value, path: string, conflicts: string[]): Value {
  if (equal(local, remote)) return local;
  if (equal(base, local)) return remote;
  if (equal(base, remote)) return local;

  if (isObject(base) && isObject(local) && isObject(remote)) {
    const result: Record<string, unknown> = {};
    for (const key of new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)])) {
      const value = mergeValue(
        Object.hasOwn(base, key) ? base[key] : missing,
        Object.hasOwn(local, key) ? local[key] : missing,
        Object.hasOwn(remote, key) ? remote[key] : missing,
        pointer(path, key),
        conflicts,
      );
      if (value !== missing) Object.defineProperty(result, key, { value, enumerable: true, writable: true, configurable: true });
    }
    return result;
  }

  // Periods, classes, slots, and overrides have stable IDs. Editing separate
  // items should not turn an entire schedule into a conflict.
  const stableKey = ["id", "date", "cycleDayId"].find((key) =>
    isKeyedArray(base, key) && isKeyedArray(local, key) && isKeyedArray(remote, key));
  if (stableKey && isKeyedArray(base, stableKey) && isKeyedArray(local, stableKey) && isKeyedArray(remote, stableKey)) {
    const itemId = (item: Record<string, unknown>) => item[stableKey] as string;
    const byId = (items: typeof base) => new Map(items.map((item) => [itemId(item), item]));
    const [baseMap, localMap, remoteMap] = [byId(base), byId(local), byId(remote)];
    const merged = new Map<string, Record<string, unknown>>();
    for (const id of new Set([...baseMap.keys(), ...localMap.keys(), ...remoteMap.keys()])) {
      const value = mergeValue(baseMap.get(id) ?? missing, localMap.get(id) ?? missing,
        remoteMap.get(id) ?? missing, pointer(path, id), conflicts);
      if (value !== missing) merged.set(id, value as Record<string, unknown>);
    }
    const common = new Set(base.filter((item) => localMap.has(itemId(item)) && remoteMap.has(itemId(item))).map(itemId));
    const order = (items: typeof base) => items.filter((item) => common.has(itemId(item))).map(itemId);
    const [baseOrder, localOrder, remoteOrder] = [order(base), order(local), order(remote)];
    const localReordered = !equal(localOrder, baseOrder);
    const remoteReordered = !equal(remoteOrder, baseOrder);
    if (localReordered && remoteReordered && !equal(localOrder, remoteOrder)) conflicts.push(pointer(path, "$order"));
    // Preserve a one-device reorder and each insertion's neighboring anchors.
    // Appending additions would silently move an inserted rotation day to the
    // end of the cycle when the other device only changed a day label.
    const preferred = localReordered ? local : remote;
    const alternate = localReordered ? remote : local;
    const ids = [...new Set([...preferred, ...alternate].map(itemId))].filter((id) => merged.has(id));
    const rank = new Map(ids.map((id, index) => [id, index]));
    const edges = new Map(ids.map((id) => [id, new Set<string>()]));
    const incoming = new Map(ids.map((id) => [id, 0]));
    const constrain = (items: typeof base, insertionsOnly: boolean) => {
      const sequence = items.map(itemId).filter((id) => merged.has(id));
      for (let index = 1; index < sequence.length; index++) {
        const [before, after] = [sequence[index - 1], sequence[index]];
        // Unchanged base-to-base edges on the other device must not undo a
        // legitimate unilateral reorder. New-item edges preserve its anchors.
        if (insertionsOnly && baseMap.has(before) && baseMap.has(after)) continue;
        if (!edges.get(before)!.has(after)) {
          edges.get(before)!.add(after);
          incoming.set(after, incoming.get(after)! + 1);
        }
      }
    };
    constrain(preferred, false);
    constrain(alternate, true);
    const ready = ids.filter((id) => incoming.get(id) === 0);
    const ordered: string[] = [];
    while (ready.length) {
      ready.sort((a, b) => rank.get(a)! - rank.get(b)!);
      const id = ready.shift()!;
      ordered.push(id);
      for (const next of edges.get(id)!) {
        incoming.set(next, incoming.get(next)! - 1);
        if (incoming.get(next) === 0) ready.push(next);
      }
    }
    if (ordered.length !== ids.length && !conflicts.includes(pointer(path, "$order"))) {
      conflicts.push(pointer(path, "$order"));
    }
    const result = (ordered.length === ids.length ? ordered : ids).map((id) => merged.get(id)!);
    // Bell schedule slots have chronological order. Independent insertions
    // must be placed by time, otherwise two valid edits create a false overlap.
    if (path.endsWith("/slots") && result.every((item) => typeof item.start === "string" && typeof item.end === "string")) {
      result.sort((a, b) => (a.start as string).localeCompare(b.start as string));
    }
    return result;
  }

  conflicts.push(path || "/");
  return local;
}

/**
 * Three-way merge against the last state the editing device actually saw.
 * Conflict paths are JSON pointers (stable IDs address array members).
 * Deleted records remain tombstones so a stale edit cannot resurrect them.
 */
export function mergeMutation(mutation: Mutation, current: Entity | null): SyncResult {
  if (current && (current.kind !== mutation.kind || current.id !== mutation.id)) {
    throw new Error("Mutation and current entity identities do not match");
  }
  if (mutation.base && (mutation.base.kind !== mutation.kind || mutation.base.id !== mutation.id)) {
    throw new Error("Mutation base identity does not match");
  }
  if (mutation.base && (!current || mutation.base.version > current.version)) {
    return { status: "conflict", current, paths: ["/"] };
  }
  const conflicts: string[] = [];
  const base = mutation.base && !mutation.base.deleted ? mutation.base.data : missing;
  const remote = current && !current.deleted ? current.data : missing;
  const local = mutation.data === null ? missing : mutation.data;
  const data = mergeValue(base, local, remote, "", conflicts);
  if (conflicts.length) return { status: "conflict", current, paths: conflicts };
  return {
    status: "applied",
    entity: {
      id: mutation.id,
      kind: mutation.kind,
      version: (current?.version ?? 0) + 1,
      deleted: data === missing,
      data: data === missing ? {} : data as Record<string, unknown>,
    },
  };
}
