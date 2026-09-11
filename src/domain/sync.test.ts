import { describe, expect, it } from "vitest";
import { mergeMutation, type Entity, type Mutation } from "./sync";

const entity = (data: Record<string, unknown>, version = 1): Entity => ({ id: "task-1", kind: "task", version, data, deleted: false });
const edit = (base: Entity | null, data: Record<string, unknown> | null): Mutation => ({ mutationId: "mutation-1", id: "task-1", kind: "task", base, data });

describe("three-way entity synchronization", () => {
  it("creates a record and merges independent task completion and note edits", () => {
    expect(mergeMutation(edit(null, { title: "Read" }), null)).toMatchObject({ status: "applied", entity: { version: 1, data: { title: "Read" } } });
    const base = entity({ title: "Read", completed: false, notes: "" });
    expect(mergeMutation(edit(base, { ...base.data, completed: true }), entity({ ...base.data, notes: "Chapter 2" }, 2)))
      .toMatchObject({ status: "applied", entity: { version: 3, data: { title: "Read", completed: true, notes: "Chapter 2" } } });
  });

  it("reports the exact competing fields without mutating either value", () => {
    const base = entity({ title: "Read", notes: "" });
    const remote = entity({ title: "Write", notes: "" }, 2);
    const local = edit(base, { title: "Study", notes: "" });
    expect(mergeMutation(local, remote)).toEqual({ status: "conflict", current: remote, paths: ["/title"] });
    expect(local.data?.title).toBe("Study");
    expect(remote.data.title).toBe("Write");
  });

  it("merges concurrent identical edits", () => {
    const base = entity({ title: "Read" });
    expect(mergeMutation(edit(base, { title: "Study" }), entity({ title: "Study" }, 2)))
      .toMatchObject({ status: "applied", entity: { data: { title: "Study" } } });
  });

  it("preserves edit-versus-delete conflicts in both directions", () => {
    const base = entity({ title: "Read" });
    const tombstone = { ...base, version: 2, deleted: true, data: {} };
    expect(mergeMutation(edit(base, { title: "Study" }), tombstone)).toMatchObject({ status: "conflict", paths: ["/"] });
    expect(mergeMutation(edit(base, null), entity({ title: "Study" }, 2))).toMatchObject({ status: "conflict", paths: ["/"] });
    expect(mergeMutation(edit(base, null), tombstone)).toMatchObject({ status: "applied", entity: { deleted: true } });
  });

  it("merges different class and lunch edits by stable item ID", () => {
    const base = entity({ classes: [{ id: "math", name: "Math", room: "1" }, { id: "lunch", name: "Lunch", room: "Cafe" }] });
    const local = edit(base, { classes: [{ id: "math", name: "Algebra", room: "1" }, { id: "lunch", name: "Lunch", room: "Cafe" }] });
    const remote = entity({ classes: [{ id: "math", name: "Math", room: "1" }, { id: "lunch", name: "Lunch wave B", room: "Cafe" }] }, 2);
    expect(mergeMutation(local, remote)).toMatchObject({ status: "applied", entity: { data: { classes: [
      { id: "math", name: "Algebra", room: "1" }, { id: "lunch", name: "Lunch wave B", room: "Cafe" },
    ] } } });
  });

  it("merges different fields in one item and preserves independent new items", () => {
    const base = entity({ slots: [{ id: "A", start: "08:00", end: "09:00" }] });
    const local = edit(base, { slots: [{ id: "A", start: "08:10", end: "09:00" }, { id: "B", start: "09:10", end: "10:00" }] });
    const remote = entity({ slots: [{ id: "A", start: "08:00", end: "09:05" }, { id: "C", start: "10:10", end: "11:00" }] }, 2);
    const result = mergeMutation(local, remote);
    expect(result.status).toBe("applied");
    if (result.status === "applied") expect(result.entity.data.slots).toEqual([
      { id: "A", start: "08:10", end: "09:05" }, { id: "B", start: "09:10", end: "10:00" }, { id: "C", start: "10:10", end: "11:00" },
    ]);
  });

  it("detects an edited item deleted by another device", () => {
    const base = entity({ classes: [{ id: "A", name: "Math" }] });
    expect(mergeMutation(edit(base, { classes: [] }), entity({ classes: [{ id: "A", name: "Algebra" }] }, 2)))
      .toMatchObject({ status: "conflict", paths: ["/classes/A"] });
  });

  it("preserves a one-device reorder and reports competing reorders", () => {
    const items = [{ id: "A", room: "1" }, { id: "B", room: "2" }, { id: "C", room: "3" }];
    const base = entity({ slots: items });
    const local = edit(base, { slots: [items[1], items[0], items[2]] });
    expect(mergeMutation(local, entity({ slots: [items[0], items[1], { ...items[2], room: "4" }] }, 2)))
      .toMatchObject({ status: "applied", entity: { data: { slots: [items[1], items[0], { ...items[2], room: "4" }] } } });
    expect(mergeMutation(local, entity({ slots: [items[0], items[2], items[1]] }, 2)))
      .toMatchObject({ status: "conflict", paths: ["/slots/$order"] });
  });

  it("preserves an inserted rotation day's position while another device edits a label", () => {
    const [a, b, x] = [{ id: "A", label: "Day A" }, { id: "B", label: "Day B" }, { id: "X", label: "New day" }];
    const base = entity({ cycleDays: [a, b] });
    const local = edit(base, { cycleDays: [a, x, b] });
    const remote = entity({ cycleDays: [a, { ...b, label: "Updated day B" }] }, 2);
    expect(mergeMutation(local, remote)).toMatchObject({ status: "applied", entity: { data: {
      cycleDays: [a, x, { ...b, label: "Updated day B" }],
    } } });
    // The same intent is preserved regardless of which device uploads first.
    expect(mergeMutation(edit(base, remote.data), entity(local.data!, 2))).toMatchObject({ status: "applied", entity: { data: {
      cycleDays: [a, x, { ...b, label: "Updated day B" }],
    } } });
  });

  it("preserves independent insertions at the beginning, middle, and end of a rotation", () => {
    const [a, b, c, x, y, z] = ["A", "B", "C", "X", "Y", "Z"].map((id) => ({ id, label: id }));
    const base = entity({ cycleDays: [a, b, c] });
    const local = edit(base, { cycleDays: [x, a, b, z, c] });
    const remote = entity({ cycleDays: [a, y, b, c, { id: "End", label: "End" }] }, 2);
    expect(mergeMutation(local, remote)).toMatchObject({ status: "applied", entity: { data: {
      cycleDays: [x, a, y, b, z, c, { id: "End", label: "End" }],
    } } });
  });

  it("asks for an order choice when a reorder reverses an insertion's anchors", () => {
    const [a, b, x] = ["A", "B", "X"].map((id) => ({ id, label: id }));
    const base = entity({ cycleDays: [a, b] });
    expect(mergeMutation(edit(base, { cycleDays: [a, x, b] }), entity({ cycleDays: [b, a] }, 2)))
      .toMatchObject({ status: "conflict", paths: ["/cycleDays/$order"] });
    expect(mergeMutation(edit(entity({ cycleDays: [] }), { cycleDays: [a, b] }), entity({ cycleDays: [b, a] }, 2)))
      .toMatchObject({ status: "conflict", paths: ["/cycleDays/$order"] });
  });

  it("treats primitive and ambiguous duplicate-ID arrays atomically", () => {
    const base = entity({ weekdays: [1, 2, 3] });
    expect(mergeMutation(edit(base, { weekdays: [1, 2] }), entity({ weekdays: [2, 3] }, 2))).toMatchObject({ status: "conflict", paths: ["/weekdays"] });
    const duplicate = entity({ slots: [{ id: "A", time: 1 }, { id: "A", time: 2 }] });
    expect(mergeMutation(edit(duplicate, { slots: [{ id: "A", time: 3 }, { id: "A", time: 2 }] }), entity({ slots: [{ id: "A", time: 1 }, { id: "A", time: 4 }] }, 2)))
      .toMatchObject({ status: "conflict", paths: ["/slots"] });
  });

  it("keeps nested field removal distinct from null", () => {
    const base = entity({ notes: "Read", settings: { room: "2", color: "blue" } });
    expect(mergeMutation(edit(base, { settings: { room: "2", color: "blue" } }), entity({ notes: "Read", settings: { room: "3", color: "blue" } }, 2)))
      .toMatchObject({ status: "applied", entity: { data: { settings: { room: "3", color: "blue" } } } });
    expect(mergeMutation(edit(base, { settings: base.data.settings }), entity({ notes: null, settings: base.data.settings }, 2)))
      .toMatchObject({ status: "conflict", paths: ["/notes"] });
  });

  it("rejects identity mismatch and future or absent base revisions", () => {
    const base = entity({ title: "Read" }, 5);
    expect(mergeMutation(edit(base, { title: "Write" }), entity({ title: "Read" }, 4))).toMatchObject({ status: "conflict" });
    expect(mergeMutation(edit(base, null), null)).toMatchObject({ status: "conflict" });
    expect(() => mergeMutation(edit(base, null), { ...base, id: "another" })).toThrow("identities");
  });

  it("merges independent cycle-day and date overrides by their domain keys", () => {
    const base = entity({
      cycleDayOverrides: [{ cycleDayId: "day1", slots: [] }, { cycleDayId: "day2", slots: [] }],
      dateOverrides: [{ date: "2026-09-10", shiftMinutes: 0 }, { date: "2026-09-11", shiftMinutes: 0 }],
      exceptions: [],
    });
    const local = edit(base, {
      cycleDayOverrides: [{ cycleDayId: "day1", slots: [{ id: "A", start: "08:00", end: "09:00" }] }, { cycleDayId: "day2", slots: [] }],
      dateOverrides: [{ date: "2026-09-10", shiftMinutes: 30 }, { date: "2026-09-11", shiftMinutes: 0 }],
      exceptions: [{ date: "2026-09-12", kind: "closure", advanceCycle: false }],
    });
    const remote = entity({
      cycleDayOverrides: [{ cycleDayId: "day1", slots: [] }, { cycleDayId: "day2", slots: [{ id: "B", start: "08:00", end: "09:00" }] }],
      dateOverrides: [{ date: "2026-09-10", shiftMinutes: 0 }, { date: "2026-09-11", shiftMinutes: -15 }],
      exceptions: [{ date: "2026-09-13", kind: "closure", advanceCycle: true }],
    }, 2);
    const result = mergeMutation(local, remote);
    expect(result).toMatchObject({ status: "applied", entity: { data: {
      cycleDayOverrides: [{ cycleDayId: "day1", slots: [{ id: "A" }] }, { cycleDayId: "day2", slots: [{ id: "B" }] }],
      dateOverrides: [{ date: "2026-09-10", shiftMinutes: 30 }, { date: "2026-09-11", shiftMinutes: -15 }],
    } } });
    if (result.status === "applied") expect(result.entity.data.exceptions).toHaveLength(2);
  });
});
