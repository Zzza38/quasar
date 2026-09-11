import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { emptyPersonalSchedule, personalScheduleSchema } from "@/domain/schedule";
import type { Entity, EntityKind, Mutation, SyncResult } from "@/domain/sync";
import { openDatabase, type Db } from "./db";
import { Service } from "./service";

const databases: Db[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

function fixture() {
  const db = openDatabase(":memory:");
  databases.push(db);
  const userId = randomUUID();
  db.prepare("INSERT INTO users(id,google_sub,email,display_name,full_name,created_at) VALUES(?,?,?,?,?,?)")
    .run(userId, userId, "student@example.com", "Student", "Student Name", new Date().toISOString());
  return { db, userId, service: new Service(db) };
}

function mutation(kind: EntityKind, data: Record<string, unknown>, base: Entity | null = null): Mutation {
  return { mutationId: randomUUID(), id: base?.id ?? (kind === "personal" ? "personal" : randomUUID()), kind, base, data };
}

function applied(result: SyncResult): Entity {
  if (result.status !== "applied") throw new Error("Expected a successful mutation");
  return result.entity;
}

describe("semantic synchronization conflicts", () => {
  it("preserves individually valid class deletion and assignment edits as a durable user choice", () => {
    const { service, userId, db } = fixture();
    const initial = personalScheduleSchema.parse({ ...emptyPersonalSchedule(), classes: [{ id: "algebra", name: "Algebra" }] });
    const base = applied(service.sync(userId, mutation("personal", initial)));
    const remote = applied(service.sync(userId, mutation("personal", { ...initial, classes: [] }, base)));
    const localData = { ...initial, assignments: { A: "algebra" } };
    const local = mutation("personal", localData, base);

    const result = service.sync(userId, local);
    expect(result).toMatchObject({ status: "conflict", current: remote, paths: ["/assignments/A"] });
    expect(service.sync(userId, local)).toEqual(result);
    expect(service.entity(userId, "personal")).toEqual(remote);
    expect(local.data).toEqual(localData);
    expect(db.prepare("SELECT count(*) count FROM entity_history WHERE owner_id=? AND id=?").get(userId, "personal")).toEqual({ count: 2 });

    // The student can explicitly retain the local complete value, restoring its class.
    const resolved = applied(service.sync(userId, mutation("personal", localData, remote)));
    expect(resolved.data).toEqual(localData);
    expect(resolved.version).toBe(remote.version + 1);
  });

  it("surfaces clearing a due date against concurrently adding a due time", () => {
    const { service, userId } = fixture();
    const initial = { title: "Read chapter", dueDate: "2026-09-15", dueTime: null, classId: null, notes: "", completed: false };
    const base = applied(service.sync(userId, mutation("task", initial)));
    const remote = applied(service.sync(userId, mutation("task", { ...initial, dueDate: null }, base)));
    const local = mutation("task", { ...initial, dueTime: "08:00" }, base);
    const result = service.sync(userId, local);

    expect(result).toMatchObject({ status: "conflict", current: remote, paths: ["/dueTime"] });
    expect(service.sync(userId, local)).toEqual(result);
    expect(service.entity(userId, base.id)).toEqual(remote);
    const resolved = applied(service.sync(userId, mutation("task", local.data!, remote)));
    expect(resolved.data).toMatchObject({ dueDate: "2026-09-15", dueTime: "08:00" });
  });

  it("continues to reject invalid input rather than storing it as a synchronization conflict", () => {
    const { service, userId, db } = fixture();
    expect(() => service.sync(userId, mutation("personal", { ...emptyPersonalSchedule(), assignments: { A: "missing" } })))
      .toThrow("assigned class does not exist");
    expect(service.entity(userId, "personal")).toBeNull();
    expect(db.prepare("SELECT count(*) count FROM mutation_receipts").get()).toEqual({ count: 0 });
  });
});
