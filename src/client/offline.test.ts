import "fake-indexeddb/auto";
import { TRPCError } from "@trpc/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import { mergeMutation, type Entity, type Mutation, type SyncResult } from "../domain/sync";
import { emptyPersonalSchedule } from "../domain/schedule";
import { openDatabase, type Db } from "../server/db";
import { Service } from "../server/service";
import { CalendarService } from "../server/calendar";
import type { fetchFeed } from "../server/feed-fetch";
import { clearOfflineAccount, getLastAccountId, openWorkspace, requestPersistentStorage, storagePersistence, type OfflineWorkspace } from "./offline";

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
      // Mirrors Service.sync: calendar metadata only changes through calendar synchronization.
      if (mutation.kind === "task" && mutation.data && JSON.stringify(mutation.data.imported ?? null) !== JSON.stringify(mutation.base?.data.imported ?? null)) {
        throw Object.assign(new Error("Calendar source metadata can only be changed by calendar synchronization."), { data: { code: "BAD_REQUEST" } });
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

const databases: Db[] = [];
const feed = (...events: Array<[uid: string, title: string]>) => ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Quasar tests//EN",
  ...events.flatMap(([uid, title]) => ["BEGIN:VEVENT", `UID:${uid}`, "DTSTART;VALUE=DATE:20260912", `SUMMARY:${title}`, "END:VEVENT"]), "END:VCALENDAR"].join("\r\n");

/** The real Service.sync and CalendarService on an in-memory database, reached the way the tRPC client reports errors. */
function realServer() {
  const db = openDatabase(":memory:");
  databases.push(db);
  const owner = crypto.randomUUID();
  db.prepare("INSERT INTO users(id,google_sub,email,display_name,full_name,created_at) VALUES(?,?,?,?,?,?)").run(owner, owner, `${owner}@example.com`, "Maya", "Maya Patel", "2026-09-11T00:00:00Z");
  let now = new Date("2026-09-11T12:00:00Z");
  const fetcher = vi.fn<typeof fetchFeed>().mockResolvedValue({ status: 200, text: feed(["a1", "Read chapter 1"], ["a2", "Lab report"]), etag: "v1" });
  const service = new Service(db);
  const calendar = new CalendarService(db, { secret: "test-only-secret-that-is-at-least-32-characters", fetcher, now: () => now });
  return {
    owner, service, calendar, fetcher,
    advance() { now = new Date(now.getTime() + 61_000); },
    entities: () => service.workspace(owner).entities,
    async send(mutation: Mutation): Promise<SyncResult> {
      try {
        return structuredClone(service.sync(owner, structuredClone(mutation)));
      } catch (error) {
        if (error instanceof TRPCError) throw Object.assign(new Error(error.message), { data: { code: error.code } });
        if (error instanceof ZodError) throw Object.assign(new Error(error.message), { data: { code: "BAD_REQUEST" } });
        throw error;
      }
    },
  };
}

afterEach(async () => {
  for (const db of databases.splice(0)) db.close();
  handles.forEach((handle) => handle.close());
  handles.length = 0;
  for (const account of accounts) await clearOfflineAccount(account);
  accounts.clear();
});

describe("durable offline workspace", () => {
  it("upgrades the saved context in one step and never over a newer copy written meanwhile", async () => {
    const store = await workspace();
    await store.setContext({ legacy: true });
    const upgrade = (context: Record<string, unknown> | null) => context?.legacy ? { upgraded: true } : null;
    await store.upgradeContext(upgrade);
    expect((await store.read()).context).toEqual({ upgraded: true });
    // A network load saved a newer context before the upgrade ran: it is left alone.
    await store.setContext({ fresh: true });
    await store.upgradeContext(upgrade);
    expect((await store.read()).context).toEqual({ fresh: true });
  });

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
    expect(remote.entities.get("task:t1")?.data).toEqual(taskData({ title: "Read chapter 3", notes: "Library copy", completed: true, completedAt: expect.any(String) }));
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
    expect(remote.entities.get("task:t1")?.data).toEqual(taskData({ title: "Study", completed: true, completedAt: expect.any(String) }));
    expect((await reopened.read()).pending).toBe(0);
  });

  it("keeps the other device's non-conflicting edits when the student keeps their changes", async () => {
    const local = await workspace();
    const base = task({ title: "Read", notes: "" });
    await local.ingest([base]);
    await local.save("task", "t1", taskData({ title: "Study" }));
    const remote = server([task({ title: "Write", notes: "Library copy, due Friday" }, 2)]);
    await local.sync(remote.send);
    const conflict = (await local.read()).conflicts[0];
    expect(conflict.paths).toEqual(["/title"]);
    await local.resolve(conflict.mutation.mutationId, "local");
    await local.sync(remote.send);
    expect(remote.entities.get("task:t1")?.data).toEqual(taskData({ title: "Study", notes: "Library copy, due Friday" }));
    expect((await local.read()).pending).toBe(0);
  });

  it("uploads a kept change to an imported task after a calendar refresh restamped its metadata", async () => {
    const imported = (sourceUpdatedAt: string) => ({ subscriptionId: "s1", uid: "u1", recurrenceId: null, startDate: "2026-09-12", startTime: null, endDate: null, endTime: null, timeZone: "America/New_York", allDay: true, sourceRemoved: false, sourceUpdatedAt, url: null });
    const local = await workspace();
    const v1 = task({ title: "Read", imported: imported("2026-09-11T12:00:00.000Z") });
    const v2 = task({ title: "Write", imported: imported("2026-09-12T12:00:00.000Z") }, 2);
    await local.ingest([v1]);
    await local.save("task", "t1", { ...v1.data, title: "Study" });
    await local.save("task", "t2", taskData({ title: "Call home" }));
    const remote = server([v2]);
    await local.sync(remote.send);
    const conflict = (await local.read()).conflicts[0];
    expect(conflict.paths).toEqual(["/title"]);
    await local.resolve(conflict.mutation.mutationId, "local");
    await local.sync(remote.send);
    expect(remote.entities.get("task:t1")?.data).toEqual({ ...v2.data, title: "Study" });
    // "Keep my draft" in the task sheet saves a draft that still has the metadata it was opened with.
    await local.ingest([...remote.entities.values()]);
    await local.save("task", "t1", { ...v1.data, title: "Study hard" });
    await local.sync(remote.send);
    expect(remote.entities.get("task:t1")?.data).toEqual({ ...v2.data, title: "Study hard" });
    expect(remote.entities.get("task:t2")?.data.title).toBe("Call home");
    const state = await local.read();
    expect(state.pending).toBe(0);
    expect(state.lastError).toBeNull();
  });

  it("parks a change the server refuses so later uploads still go through, then retries or discards it", async () => {
    const local = await workspace();
    await local.ingest([task({ title: "Read" })]);
    await local.save("task", "t1", taskData({ title: "Refused" }));
    await local.save("task", "t1", taskData({ title: "Refused again" }));
    await local.save("task", "t2", taskData({ title: "Call home" }));
    const remote = server([task({ title: "Read" })]);
    let refuse = true;
    const send = async (mutation: Mutation) => {
      if (refuse && mutation.id === "t1") throw Object.assign(new Error("This change is too large."), { data: { code: "BAD_REQUEST" } });
      return remote.send(mutation);
    };
    await local.sync(send);
    expect(remote.entities.get("task:t2")?.data.title).toBe("Call home");
    let state = await local.read();
    expect(state.pending).toBe(2);
    expect(state.lastError).toBeNull();
    expect(state.conflicts).toEqual([expect.objectContaining({ rejected: "This change is too large.", current: task({ title: "Read" }) })]);
    await local.sync(send);
    expect(remote.requests.filter((request) => request.id === "t1")).toHaveLength(0);
    refuse = false;
    await local.resolve(state.conflicts[0].mutation.mutationId, "local");
    await local.sync(send);
    expect(remote.entities.get("task:t1")?.data.title).toBe("Refused again");
    await local.save("task", "t1", taskData({ title: "Refused once more" }));
    refuse = true;
    await local.sync(send);
    state = await local.read();
    await local.resolve(state.conflicts[0].mutation.mutationId, "remote");
    state = await local.read();
    expect(state.pending).toBe(0);
    expect(state.entities.find((entity) => entity.id === "t1")?.data.title).toBe("Refused again");
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

  it("lets another tab take over a send that outlived its lease without applying the change twice", async () => {
    const first = await workspace();
    const second = await workspace(first.accountId);
    await first.save("task", "t1", taskData({ title: "Slow upload" }));
    const remote = server();
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let started!: () => void;
      const sending = new Promise<void>((resolve) => { started = resolve; });
      const stalled = first.sync(async (mutation) => { started(); await gate; return remote.send(mutation); });
      await sending;
      // Within the lease the other tab waits.
      await second.sync(remote.send);
      expect(remote.requests).toHaveLength(0);
      vi.setSystemTime(Date.now() + 31_000);
      await second.sync(remote.send);
      expect(remote.requests).toHaveLength(1);
      expect((await second.read()).pending).toBe(0);
      // The stalled tab's request finally lands: the same mutation ID and base, answered from the receipt.
      release();
      await stalled;
    } finally { vi.useRealTimers(); }
    expect(remote.requests).toHaveLength(2);
    expect(remote.requests[1].mutationId).toBe(remote.requests[0].mutationId);
    expect(remote.requests[1].base).toEqual(remote.requests[0].base);
    expect(remote.entities.get("task:t1")?.version).toBe(1);
    const state = await first.read();
    expect(state.pending).toBe(0);
    expect(state.entities.find((entity) => entity.id === "t1")?.version).toBe(1);
  });

  it("tells another open tab when its account is cleared, and that tab cannot write it back", async () => {
    const leaving = await workspace();
    const other = await workspace(leaving.accountId);
    await other.save("task", "t1", taskData({ title: "Private" }));
    const told = new Promise<void>((resolve) => { other.subscribe(resolve); });
    await clearOfflineAccount(leaving.accountId);
    await told;
    await expect(other.read()).rejects.toThrow("cleared");
    await expect(other.save("task", "t2", taskData({ title: "After" }))).rejects.toThrow("cleared");
    await expect(other.sync(async () => { throw new Error("must not upload"); })).rejects.toThrow("cleared");
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
    expect((await local.read()).entities[0]).toEqual(task({ title: "Read", completed: true, completedAt: expect.any(String) }, 2));
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

  it("stops other tabs from queueing or uploading while one tab signs out, and lets that tab finish", async () => {
    const leaving = await workspace();
    const other = await workspace(leaving.accountId);
    await other.save("task", "t1", taskData({ title: "Discarded" }));
    await leaving.beginSignOut();
    await expect(leaving.beginSignOut()).resolves.toBeUndefined();
    await expect(other.beginSignOut()).rejects.toThrow("Signing out in another tab");
    await expect(other.save("task", "t2", taskData({ title: "Too late" }))).rejects.toThrow("Signing out in another tab");
    const remote = server();
    // The change the student chose to discard is not uploaded from the other tab.
    await other.sync(remote.send);
    expect(remote.requests).toHaveLength(0);
    expect((await other.read()).pending).toBe(1);
    // The signing-out tab can still run its final sync.
    await leaving.sync(remote.send);
    expect(remote.requests).toHaveLength(1);
    await leaving.endSignOut();
    await other.save("task", "t2", taskData({ title: "After" }));
    expect((await other.read()).pending).toBe(1);
  });

  it("lets a crashed tab's sign-out marker expire", async () => {
    const leaving = await workspace();
    const other = await workspace(leaving.accountId);
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      await leaving.beginSignOut();
      await expect(other.save("task", "t1", taskData({ title: "Blocked" }))).rejects.toThrow("Signing out in another tab");
      vi.setSystemTime(Date.now() + 121_000);
      await other.save("task", "t1", taskData({ title: "Saved" }));
    } finally { vi.useRealTimers(); }
    expect((await other.read()).pending).toBe(1);
  });

  it("keeps the cache when a change was queued after a sign-out that keeps changes checked the queue", async () => {
    const leaving = await workspace();
    const older = await workspace(leaving.accountId);
    await leaving.beginSignOut();
    expect((await leaving.read()).pending).toBe(0);
    // A tab without the marker check (or after it expired) queues a change before the delete.
    await leaving.endSignOut();
    await older.save("task", "t1", taskData({ title: "Late edit" }));
    await expect(clearOfflineAccount(leaving.accountId, { requireEmptyQueue: true })).rejects.toThrow("kept on this device");
    expect((await older.read()).pending).toBe(1);
    expect(await getLastAccountId()).toBe(leaving.accountId);
    // A discarding sign-out still clears it.
    await clearOfflineAccount(leaving.accountId);
    await expect(older.read()).rejects.toThrow("cleared");
  });

  it("releases the sign-out marker when the store was detached during sign-out, so the next session can save", async () => {
    const leaving = await workspace();
    const other = await workspace(leaving.accountId);
    await leaving.beginSignOut();
    // The final sync ended in requireSignIn, which closes the handle before finishLogout releases the marker.
    leaving.close();
    await leaving.endSignOut();
    const next = await workspace(leaving.accountId);
    await next.save("task", "t1", taskData({ title: "Signed back in" }));
    await other.save("task", "t2", taskData({ title: "Other tab" }));
    expect((await next.read()).pending).toBe(2);
  });

  it("never releases another tab's newer sign-out marker from a closed handle", async () => {
    const stalled = await workspace();
    const leaving = await workspace(stalled.accountId);
    const other = await workspace(stalled.accountId);
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      await stalled.beginSignOut();
      // The stalled tab's marker expired, so another tab started its own sign-out.
      vi.setSystemTime(Date.now() + 121_000);
      await leaving.beginSignOut();
      stalled.close();
      await stalled.endSignOut();
      await expect(other.save("task", "t1", taskData({ title: "Blocked" }))).rejects.toThrow("Signing out in another tab");
    } finally { vi.useRealTimers(); }
  });

  it("releases other tabs when a sign-out that keeps changes is refused", async () => {
    const leaving = await workspace();
    const other = await workspace(leaving.accountId);
    await other.save("task", "t1", taskData({ title: "Waiting" }));
    await leaving.beginSignOut();
    leaving.close();
    await expect(clearOfflineAccount(leaving.accountId, { requireEmptyQueue: true })).rejects.toThrow("kept on this device");
    await other.save("task", "t2", taskData({ title: "Next" }));
    expect((await other.read()).pending).toBe(2);
  });

  it("stamps a completion offline and keeps it when another device completed the same task first", async () => {
    const local = await workspace();
    const base = task({ title: "Read" });
    await local.ingest([base]);
    await local.save("task", "t1", { ...base.data, completed: true });
    const stamped = (await local.read()).entities[0].data.completedAt as string;
    expect(Date.parse(stamped)).toBeLessThanOrEqual(Date.now());
    // The other device's completion reached the server first, with its own time, and was refreshed in here.
    const done = task({ title: "Read", completed: true, completedAt: "2026-09-01T12:00:00.000Z" }, 2);
    await local.ingest([done]);
    const remote = server([done]);
    await local.sync(remote.send);
    expect((await local.read()).conflicts).toHaveLength(0);
    expect(remote.entities.get("task:t1")?.data.completedAt).toBe("2026-09-01T12:00:00.000Z");
    // Reopening drops the stamp.
    await local.save("task", "t1", { ...(await local.read()).entities[0].data, completed: false });
    expect((await local.read()).entities[0].data.completedAt).toBeUndefined();
  });
});

describe("offline workspace against the real server", () => {
  it("resolves an offline edit to an imported task that the calendar source changed, either way", async () => {
    const remote = realServer();
    const subscription = await remote.calendar.subscribe(remote.owner, { name: "Homework", url: "https://school.example/calendar.ics", timeZone: "America/New_York" });
    const byTitle = (title: string) => remote.entities().find((entity) => entity.data.title === title)!;
    const [kept, dropped] = [byTitle("Read chapter 1"), byTitle("Lab report")];
    const local = await workspace();
    await local.ingest(remote.entities());
    // Offline: the student edits both imported tasks while the teacher renames both at the source.
    await local.save("task", kept.id, { ...kept.data, title: "Study" });
    await local.save("task", dropped.id, { ...dropped.data, title: "Lab report draft" });
    remote.fetcher.mockResolvedValue({ status: 200, text: feed(["a1", "Read chapter 2"], ["a2", "Lab report v2"]), etag: "v2" });
    remote.advance();
    await remote.calendar.refresh(remote.owner, subscription.id);
    const refreshed = remote.entities().find((entity) => entity.id === kept.id)!;
    expect(refreshed.data.title).toBe("Read chapter 2");
    expect(refreshed.data.imported).not.toEqual(kept.data.imported);

    await local.sync(remote.send);
    let state = await local.read();
    expect(state.conflicts.map((conflict) => conflict.paths)).toEqual([["/title"], ["/title"]]);
    const conflictFor = (id: string) => state.conflicts.find((conflict) => conflict.mutation.id === id)!.mutation.mutationId;
    await local.resolve(conflictFor(kept.id), "local");
    await local.resolve(conflictFor(dropped.id), "remote");
    await local.sync(remote.send);

    state = await local.read();
    expect(state.pending).toBe(0);
    expect(state.lastError).toBeNull();
    const server = remote.entities();
    expect(server.find((entity) => entity.id === kept.id)?.data).toMatchObject({ title: "Study", imported: refreshed.data.imported });
    expect(server.find((entity) => entity.id === dropped.id)?.data.title).toBe("Lab report v2");
    // A later unrelated edit still uploads, so nothing is stuck behind a refused payload.
    await local.save("task", "t-new", taskData({ title: "Call home" }));
    await local.sync(remote.send);
    expect(remote.entities().find((entity) => entity.id === "t-new")?.data.title).toBe("Call home");
    expect((await local.read()).pending).toBe(0);
  });

  it("completes a repeating task offline and gets exactly one successor after reconnecting", async () => {
    const remote = realServer();
    const local = await workspace();
    await local.save("task", "r1", taskData({ title: "Practice", dueDate: "2026-09-14", recurrence: { frequency: "weekly", interval: 1, until: null } }));
    await local.sync(remote.send);
    const saved = (await local.read()).entities.find((entity) => entity.id === "r1")!;
    await local.save("task", "r1", { ...saved.data, completed: true });
    // The first upload after reconnecting loses its acknowledgement, so the same mutation is sent again.
    await expect(local.sync(async (mutation) => { await remote.send(mutation); throw new TypeError("Failed to fetch"); })).rejects.toThrow("Failed to fetch");
    await local.sync(remote.send);
    expect((await local.read()).pending).toBe(0);
    await local.ingest(remote.entities());
    const tasks = (await local.read()).entities.filter((entity) => !entity.deleted);
    expect(tasks).toHaveLength(2);
    expect(tasks.find((entity) => entity.id === "r1")?.data.completed).toBe(true);
    expect(tasks.find((entity) => entity.id !== "r1")?.data).toMatchObject({ title: "Practice", dueDate: "2026-09-21", completed: false });
  });
});

describe("persistent storage request", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("asks the browser to keep storage only when it is not already persistent", async () => {
    const persist = vi.fn(async () => true);
    vi.stubGlobal("navigator", { storage: { persisted: async () => false, persist } });
    await expect(requestPersistentStorage()).resolves.toBe(true);
    expect(persist).toHaveBeenCalledTimes(1);
    vi.stubGlobal("navigator", { storage: { persisted: async () => true, persist } });
    await expect(requestPersistentStorage()).resolves.toBe(true);
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it("reads whether storage is persistent without ever asking for it", async () => {
    const persist = vi.fn(async () => true);
    vi.stubGlobal("navigator", { storage: { persisted: async () => false, persist } });
    await expect(storagePersistence()).resolves.toBe(false);
    vi.stubGlobal("navigator", { storage: { persisted: async () => true, persist } });
    await expect(storagePersistence()).resolves.toBe(true);
    expect(persist).not.toHaveBeenCalled();
    vi.stubGlobal("navigator", {});
    await expect(storagePersistence()).resolves.toBeNull();
    vi.stubGlobal("navigator", { storage: { persisted: async () => { throw new Error("denied"); } } });
    await expect(storagePersistence()).resolves.toBeNull();
  });

  it("reports refused or unsupported persistence without throwing", async () => {
    vi.stubGlobal("navigator", { storage: { persisted: async () => false, persist: async () => false } });
    await expect(requestPersistentStorage()).resolves.toBe(false);
    vi.stubGlobal("navigator", {});
    await expect(requestPersistentStorage()).resolves.toBeNull();
    vi.stubGlobal("navigator", { storage: { persisted: async () => { throw new Error("denied"); }, persist: async () => true } });
    await expect(requestPersistentStorage()).resolves.toBeNull();
  });
});
