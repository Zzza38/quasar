import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import { mergeMutation, type Entity, type Mutation, type SyncResult } from "../domain/sync";
import { emptyPersonalSchedule } from "../domain/schedule";
import { clearOfflineAccount, getLastAccountId, openWorkspace, type OfflineWorkspace } from "./offline";

const handles: OfflineWorkspace[] = [];
const accounts = new Set<string>();
async function workspace(accountId = crypto.randomUUID()) {
  accounts.add(accountId);
  const opened = await openWorkspace(accountId);
  handles.push(opened);
  return opened;
}
const taskData = (data: Record<string, unknown>) => ({ title: "Read", notes: "", completed: false, dueDate: null, dueTime: null, classId: null, ...data });
const task = (data: Record<string, unknown>, version = 1): Entity => ({ kind: "task", id: "t1", data: taskData(data), version, deleted: false });

function server(initial: Entity[] = []) {
  const entities = new Map(initial.map((entity) => [`${entity.kind}:${entity.id}`, entity]));
  const receipts = new Map<string, { mutation: string; result: SyncResult }>();
  const requests: Mutation[] = [];
  return {
    entities, requests,
    async send(mutation: Mutation): Promise<SyncResult> {
      requests.push(structuredClone(mutation));
      const prior = receipts.get(mutation.mutationId);
      if (prior) {
        expect(JSON.stringify(mutation)).toBe(prior.mutation);
        return structuredClone(prior.result);
      }
      const key = `${mutation.kind}:${mutation.id}`;
      const current = entities.get(key) ?? null;
      const result = mergeMutation(mutation, current);
      if (result.status === "applied") entities.set(key, structuredClone(result.entity));
      receipts.set(mutation.mutationId, { mutation: JSON.stringify(mutation), result: structuredClone(result) });
      return result;
    },
  };
}

afterEach(async () => {
  handles.forEach((handle) => handle.close());
  handles.length = 0;
  for (const account of accounts) await clearOfflineAccount(account);
  accounts.clear();
});

describe("durable offline workspace", () => {
  it("preserves cached context, class/lunch edits, and task completion after reopening", async () => {
    const first = await workspace();
    await first.setContext({ school: { name: "Example School" } });
    await first.save("personal", "personal", { ...emptyPersonalSchedule(), classes: [{ id: "A", name: "Algebra" }, { id: "L", name: "Lunch B" }] });
    await first.save("task", "t1", taskData({ title: "Read", completed: false }));
    await first.save("task", "t1", taskData({ title: "Read", completed: true }));
    first.close();
    const reopened = await workspace(first.accountId);
    const state = await reopened.read();
    expect(state.pending).toBe(3);
    expect(state.context).toEqual({ school: { name: "Example School" } });
    expect(state.entities).toContainEqual(expect.objectContaining({ kind: "personal", data: expect.objectContaining({ classes: [{ id: "A", name: "Algebra" }, { id: "L", name: "Lunch B" }] }) }));
    expect(state.entities.find((entity) => entity.id === "t1")?.data.completed).toBe(true);
    const remote = server();
    await reopened.sync(remote.send);
    expect((await reopened.read()).pending).toBe(0);
    expect(remote.entities.get("task:t1")?.data.completed).toBe(true);
    expect(remote.entities.size).toBe(2);
    expect(remote.requests[2].base).toEqual({ ...task({ title: "Read", completed: false }), version: 1 });
  });

  it("retries a lost acknowledgement with an identical ID and base after reload", async () => {
    const local = await workspace();
    const remote = server([task({ title: "Read", notes: "", completed: false })]);
    await local.ingest([...remote.entities.values()]);
    await local.save("task", "t1", taskData({ title: "Read", notes: "", completed: true }));
    await expect(local.sync(async (mutation) => {
      await remote.send(mutation);
      throw new Error("Connection lost after commit");
    })).rejects.toThrow("Connection lost");
    local.close();
    const reopened = await workspace(local.accountId);
    await reopened.ingest([...remote.entities.values()]);
    expect((await reopened.read()).pending).toBe(1);
    await reopened.sync(remote.send);
    expect(remote.requests[1]).toEqual(remote.requests[0]);
    expect(remote.entities.get("task:t1")?.version).toBe(2);
    expect((await reopened.read()).pending).toBe(0);
  });

  it("rebases a second offline edit without erasing a different device's note", async () => {
    const local = await workspace();
    const base = task({ title: "Read", notes: "", completed: false });
    await local.ingest([base]);
    await local.save("task", "t1", { ...base.data, completed: true });
    await local.save("task", "t1", { ...base.data, completed: true, title: "Read chapter 3" });
    const remote = server([task({ ...base.data, notes: "Library copy" }, 2)]);
    await local.sync(remote.send);
    expect(remote.entities.get("task:t1")?.data).toEqual(taskData({ title: "Read chapter 3", notes: "Library copy", completed: true }));
    expect(remote.requests[1].base?.data.notes).toBe("Library copy");
    expect((await local.read()).conflicts).toHaveLength(0);
  });

  it("persists conflicts and later local edits until an explicit local choice", async () => {
    const local = await workspace();
    const base = task({ title: "Read", completed: false });
    await local.ingest([base]);
    await local.save("task", "t1", taskData({ title: "Study", completed: false }));
    const remote = server([task({ title: "Write", completed: false }, 2)]);
    await local.sync(remote.send);
    await local.save("task", "t1", taskData({ title: "Study", completed: true }));
    local.close();
    const reopened = await workspace(local.accountId);
    const conflict = (await reopened.read()).conflicts[0];
    expect(conflict.mutation.data?.title).toBe("Study");
    expect(conflict.current?.data.title).toBe("Write");
    await reopened.resolve(conflict.mutation.mutationId, "local");
    await reopened.sync(remote.send);
    expect(remote.requests.at(-1)?.mutationId).not.toBe(conflict.mutation.mutationId);
    expect(remote.requests.at(-1)?.base).toEqual(task({ title: "Write", completed: false }, 2));
    expect(remote.entities.get("task:t1")?.data).toEqual(taskData({ title: "Study", completed: true }));
    expect((await reopened.read()).pending).toBe(0);
  });

  it("remote choice discards competing local edits and respects a remote deletion", async () => {
    const local = await workspace();
    const base = task({ title: "Read" });
    const deleted: Entity = { ...base, data: {}, deleted: true, version: 2 };
    await local.ingest([base]);
    await local.save("task", "t1", taskData({ title: "Study" }));
    const remote = server([deleted]);
    await local.sync(remote.send);
    await local.resolve((await local.read()).conflicts[0].mutation.mutationId, "remote");
    const state = await local.read();
    expect(state.pending).toBe(0);
    expect(state.entities).toEqual([deleted]);
  });

  it("syncs unrelated records while an entity is awaiting a conflict choice", async () => {
    const local = await workspace();
    const base = task({ title: "Read" });
    await local.ingest([base]);
    await local.save("task", "t1", taskData({ title: "Study" }));
    await local.save("task", "t1", taskData({ title: "Study again" }));
    await local.save("task", "t2", taskData({ title: "Call home" }));
    const remote = server([task({ title: "Write" }, 2)]);
    await local.sync(remote.send);
    expect(remote.entities.get("task:t2")?.data.title).toBe("Call home");
    expect((await local.read()).pending).toBe(2);
    expect((await local.read()).conflicts).toHaveLength(1);
  });

  it("keeps concurrent tab edits atomically and serializes live uploads", async () => {
    const first = await workspace();
    const second = await workspace(first.accountId);
    await Promise.all([first.save("task", "t1", taskData({ title: "One" })), second.save("task", "t2", taskData({ title: "Two" }))]);
    expect((await first.read()).pending).toBe(2);
    const remote = server();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let started!: () => void;
    const sending = new Promise<void>((resolve) => { started = resolve; });
    const upload = first.sync(async (mutation) => { started(); await gate; return remote.send(mutation); });
    await sending;
    await second.sync(remote.send);
    expect(remote.requests).toHaveLength(0);
    release();
    await upload;
    expect(remote.entities.size).toBe(2);
    expect(remote.requests).toHaveLength(2);
    expect((await second.read()).pending).toBe(0);
  });

  it("keeps accounts isolated and sign-out cannot resurrect a cleared cache", async () => {
    const first = await workspace();
    await first.save("task", "t1", taskData({ title: "Private first account" }));
    const second = await workspace();
    expect(await getLastAccountId()).toBe(second.accountId);
    expect((await second.read()).entities).toHaveLength(0);
    await clearOfflineAccount(first.accountId);
    expect(await getLastAccountId()).toBe(second.accountId);
    await expect(first.save("task", "t2", { title: "Should not persist" })).rejects.toThrow("cleared");
    await clearOfflineAccount(second.accountId);
    expect(await getLastAccountId()).toBeNull();
  });

  it("keeps local edits during refresh and never regresses acknowledged revisions", async () => {
    const local = await workspace();
    const base = task({ title: "Read", completed: false });
    await local.ingest([base]);
    await local.save("task", "t1", { ...base.data, completed: true });
    await local.ingest([base]);
    expect((await local.read()).entities[0].data.completed).toBe(true);
    const remote = server([base]);
    await local.sync(remote.send);
    await local.ingest([base]);
    expect((await local.read()).entities[0]).toEqual(task({ title: "Read", completed: true }, 2));
  });

  it("turns a due-date/time invariant violation into a choice before freezing a retry", async () => {
    const local = await workspace();
    const base = task({ dueDate: "2026-09-10", dueTime: null });
    const remoteEntity = task({ dueDate: null, dueTime: null }, 2);
    await local.ingest([base]);
    const desired = { ...base.data, dueTime: "15:00" };
    await local.save("task", "t1", desired);
    await local.ingest([remoteEntity]);
    const remote = server([remoteEntity]);
    await local.sync(remote.send);
    expect(remote.requests).toHaveLength(0);
    const conflict = (await local.read()).conflicts[0];
    expect(conflict.paths).toContain("/dueTime");
    expect(conflict.mutation.data).toEqual(desired);
    expect(conflict.mutation.base).toEqual(base);
    await local.resolve(conflict.mutation.mutationId, "local");
    await local.sync(remote.send);
    expect(remote.entities.get("task:t1")?.data).toEqual(desired);
    expect((await local.read()).pending).toBe(0);
  });

  it("preserves valid alternatives when a class deletion and new assignment cannot coexist", async () => {
    const local = await workspace();
    const base: Entity = {
      kind: "personal", id: "personal", version: 1, deleted: false,
      data: { ...emptyPersonalSchedule(), classes: [{ id: "A", name: "Algebra" }] },
    };
    const desired = { ...base.data, assignments: { P: "A" } };
    const remoteEntity = { ...base, version: 2, data: { ...base.data, classes: [] } };
    await local.ingest([base]);
    await local.save("personal", "personal", desired);
    await local.ingest([remoteEntity]);
    const remote = server([remoteEntity]);
    await local.sync(remote.send);
    expect(remote.requests).toHaveLength(0);
    const conflict = (await local.read()).conflicts[0];
    expect(conflict.paths).toContain("/assignments/P");
    expect(conflict.mutation.data).toEqual(desired);
    expect(conflict.current).toEqual(remoteEntity);
    await local.resolve(conflict.mutation.mutationId, "remote");
    expect((await local.read()).entities).toEqual([remoteEntity]);
  });
});
