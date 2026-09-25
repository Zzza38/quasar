import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, type Db } from './db';
import { Service } from './service';
import type { Entity, Mutation, SyncResult } from '@/domain/sync';
const databases: Db[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
const legacy = { title: 'Study', dueDate: '2024-01-31', dueTime: null, classId: null, notes: '', completed: false };
function fixture() {
  const db = openDatabase(':memory:'); databases.push(db);
  const owner = randomUUID();
  db.prepare('INSERT INTO users(id,google_sub,email,display_name,full_name,created_at) VALUES(?,?,?,?,?,?)').run(owner, owner, 'test@example.com', 'Test', 'Test User', new Date().toISOString());
  const service = new Service(db);
  return { db, owner, service };
}
function mutation(data: Record<string, unknown> | null, base: Entity | null = null): Mutation { return { mutationId: randomUUID(), id: base?.id ?? randomUUID(), kind: 'task', base, data }; }
function applied(result: SyncResult) { if (result.status !== 'applied') throw Error('Expected applied'); return result.entity; }
describe('recurring task synchronization', () => {
  it('creates one successor transactionally across retries, stale completions and reopening', () => {
    const { service, owner, db } = fixture();
    const base = applied(service.sync(owner, mutation({ ...legacy, recurrence: { frequency: 'monthly', interval: 1, until: null } })));
    const completion = mutation({ ...base.data, completed: true }, base);
    const completed = applied(service.sync(owner, completion));
    expect(service.sync(owner, completion)).toEqual({ status: 'applied', entity: completed });
    applied(service.sync(owner, mutation({ ...base.data, completed: true }, base)));
    const reopened = applied(service.sync(owner, mutation({ ...completed.data, completed: false }, completed)));
    applied(service.sync(owner, mutation({ ...reopened.data, completed: true }, reopened)));
    const rows = service.workspace(owner).entities;
    expect(rows).toHaveLength(2);
    const next = rows.find(item => item.id !== base.id)!;
    expect(next.data).toMatchObject({ dueDate: '2024-02-29', completed: false, recurrence: { anchorDate: '2024-01-31' } });
    expect(db.prepare('SELECT count(*) n FROM recurring_successors').get()).toEqual({ n: 1 });
    applied(service.sync(owner, mutation({ ...next.data, completed: true }, next)));
    expect(service.workspace(owner).entities.find(item => item.data.dueDate === '2024-03-31')?.data.completed).toBe(false);
  });
  it('does not recreate a deleted successor or create one for a task created completed', () => {
    const { service, owner } = fixture();
    const data = { ...legacy, recurrence: { frequency: 'daily', interval: 1, until: null } };
    const base = applied(service.sync(owner, mutation(data)));
    const done = applied(service.sync(owner, mutation({ ...base.data, completed: true }, base)));
    const next = service.workspace(owner).entities.find(item => item.id !== base.id)!;
    applied(service.sync(owner, mutation(null, next)));
    const reopened = applied(service.sync(owner, mutation({ ...done.data, completed: false }, done)));
    applied(service.sync(owner, mutation({ ...reopened.data, completed: true }, reopened)));
    expect(service.entity(owner, next.id)?.deleted).toBe(true);
    applied(service.sync(owner, mutation({ ...data, completed: true })));
    expect(service.workspace(owner).entities).toHaveLength(3);
  });
  it('ends the series instead of storing a successor dated past 2199', () => {
    const { service, owner, db } = fixture();
    const base = applied(service.sync(owner, mutation({ ...legacy, dueDate: '2199-12-31', recurrence: { frequency: 'daily', interval: 1, until: null } })));
    applied(service.sync(owner, mutation({ ...base.data, completed: true }, base)));
    expect(service.workspace(owner).entities).toHaveLength(1);
    expect(db.prepare('SELECT count(*) n FROM recurring_successors').get()).toEqual({ n: 0 });
  });
  it('accepts historical legacy bases while merging newly added optional fields', () => {
    const { service, owner } = fixture();
    const base = applied(service.sync(owner, mutation(legacy)));
    expect(base.data).toEqual(legacy);
    applied(service.sync(owner, mutation({ ...base.data, priority: 'high' }, base)));
    const merged = applied(service.sync(owner, mutation({ ...base.data, notes: 'Offline edit' }, base)));
    expect(merged.data).toMatchObject({ priority: 'high', notes: 'Offline edit' });
  });
});
describe('calendar task metadata ownership', () => {
  it('rejects forged source metadata but allows unchanged historical metadata to merge newer source updates', () => {
    const { service, owner, db } = fixture();
    const imported = { subscriptionId: 'feed', uid: 'event', recurrenceId: null, startDate: '2024-01-31', startTime: null, endDate: null, endTime: null, timeZone: 'UTC', allDay: true, sourceRemoved: false, sourceUpdatedAt: '2024-01-01T00:00:00.000Z' };
    expect(() => service.sync(owner, mutation({ ...legacy, imported }))).toThrow('metadata');
    const base: Entity = { id: randomUUID(), kind: 'task', version: 1, data: { ...legacy, imported }, deleted: false };
    db.prepare('INSERT INTO entities(owner_id,id,kind,version,data,deleted) VALUES(?,?,?,?,?,0)').run(owner, base.id, 'task', 1, JSON.stringify(base.data));
    db.prepare('INSERT INTO entity_history VALUES(?,?,?,?)').run(owner, base.id, 1, JSON.stringify(base));
    expect(() => service.sync(owner, mutation({ ...base.data, imported: null }, base))).toThrow('metadata');
    expect(() => service.sync(owner, mutation({ ...base.data, imported: { ...imported, uid: 'other' } }, base))).toThrow('metadata');
    const remote: Entity = { ...base, version: 2, data: { ...base.data, imported: { ...imported, sourceRemoved: true } } };
    db.prepare('UPDATE entities SET version=2,data=? WHERE owner_id=? AND id=?').run(JSON.stringify(remote.data), owner, base.id);
    db.prepare('INSERT INTO entity_history VALUES(?,?,?,?)').run(owner, base.id, 2, JSON.stringify(remote));
    const result = applied(service.sync(owner, mutation({ ...base.data, completed: true }, base)));
    expect(result.data).toMatchObject({ completed: true, imported: { sourceRemoved: true } });
    expect(service.workspace(owner).entities).toHaveLength(1);
  });
});
describe('completion time', () => {
  it('stamps when a task is completed, keeps it while completed and clears it on reopening', () => {
    const { service, owner } = fixture();
    const base = applied(service.sync(owner, mutation({ ...legacy, completedAt: '2020-01-01T00:00:00.000Z' })));
    expect(base.data.completedAt).toBeUndefined();
    const before = Date.now();
    const done = applied(service.sync(owner, mutation({ ...base.data, completed: true }, base)));
    expect(Date.parse(done.data.completedAt as string)).toBeGreaterThanOrEqual(before - 1000);
    const renamed = applied(service.sync(owner, mutation({ ...done.data, title: 'Study more', completedAt: '2020-01-01T00:00:00.000Z' }, done)));
    expect(renamed.data.completedAt).toBe(done.data.completedAt);
    const reopened = applied(service.sync(owner, mutation({ ...renamed.data, completed: false }, renamed)));
    expect(reopened.data.completedAt).toBeUndefined();
  });
  it('keeps an offline completion time, and two devices completing the same task never conflict', () => {
    const { service, owner } = fixture();
    const base = applied(service.sync(owner, mutation(legacy)));
    const first = applied(service.sync(owner, mutation({ ...base.data, completed: true, completedAt: '2024-01-30T08:00:00.000Z' }, base)));
    expect(first.data.completedAt).toBe('2024-01-30T08:00:00.000Z');
    const second = applied(service.sync(owner, mutation({ ...base.data, completed: true, completedAt: '2024-01-30T09:00:00.000Z' }, base)));
    expect(second.data.completedAt).toBe('2024-01-30T08:00:00.000Z');
    // A stamp from the future is not trusted.
    const reopened = applied(service.sync(owner, mutation({ ...second.data, completed: false }, second)));
    const future = applied(service.sync(owner, mutation({ ...reopened.data, completed: true, completedAt: '2199-01-01T00:00:00.000Z' }, reopened)));
    expect(Date.parse(future.data.completedAt as string)).toBeLessThanOrEqual(Date.now());
  });
  it('does not carry the completion time to the next repeat', () => {
    const { service, owner } = fixture();
    const base = applied(service.sync(owner, mutation({ ...legacy, recurrence: { frequency: 'daily', interval: 1, until: null } })));
    applied(service.sync(owner, mutation({ ...base.data, completed: true }, base)));
    const next = service.workspace(owner).entities.find(item => item.id !== base.id)!;
    expect(next.data.completed).toBe(false);
    expect(next.data.completedAt).toBeUndefined();
  });
});
