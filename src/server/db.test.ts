import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { openDatabase } from './db';

const directories: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function tempPath() {
  const dir = mkdtempSync(join(tmpdir(), 'quasar-db-')); directories.push(dir);
  return join(dir, 'test.sqlite');
}
const plan = (db: Database.Database, sql: string, ...params: unknown[]) =>
  (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as { detail: string }[]).map(row => row.detail).join('\n');

describe('openDatabase migrations', () => {
  it('rolls a failed migration back as a whole and closes the handle', () => {
    const path = tempPath();
    // A users table from something else: the users_school index cannot be created on it.
    const foreign = new Database(path); foreign.exec('CREATE TABLE users(x TEXT)'); foreign.close();
    const close = vi.spyOn(Database.prototype, 'close');
    expect(() => openDatabase(path)).toThrow(/school_id/);
    expect(close).toHaveBeenCalledTimes(1);
    close.mockRestore();
    const check = new Database(path);
    try {
      // Nothing from the earlier steps was committed, so a second opener never sees a half-migrated schema.
      const tables = (check.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(row => row.name);
      expect(tables).toEqual(['users']);
    } finally { check.close(); }
  });

  it('reopens an existing file without repeating work and records every version', () => {
    const path = tempPath();
    openDatabase(path).close();
    const db = openDatabase(path);
    try {
      const versions = (db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as { version: number }[]).map(row => row.version);
      expect(versions).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
      expect(db.inTransaction).toBe(false);
    } finally { db.close(); }
  });

  it('repairs tasks an older build saved with a date outside 1900-2199 as a new version', () => {
    const path = tempPath();
    const setup = openDatabase(path);
    const base = { title: 'Old', dueTime: null, classId: null, notes: '', completed: false };
    const good = { ...base, dueDate: '2026-09-24' };
    setup.prepare('INSERT INTO users(id,google_sub,email,created_at) VALUES(?,?,?,?)').run('u', 'u', 'u@example.com', 'now');
    const put = setup.prepare('INSERT INTO entities(owner_id,id,kind,version,data,deleted) VALUES(?,?,?,?,?,?)');
    put.run('u', 'bad', 'task', 3, JSON.stringify({ ...base, dueDate: '0002-01-01', dueTime: '08:00' }), 0);
    put.run('u', 'good', 'task', 2, JSON.stringify(good), 0);
    // Opened before migration 11 existed.
    setup.prepare('DELETE FROM schema_migrations WHERE version IN (11, 13)').run();
    setup.close();
    const db = openDatabase(path);
    try {
      const rows = db.prepare('SELECT id, version, data FROM entities ORDER BY id').all() as { id: string; version: number; data: string }[];
      expect(rows.map(row => [row.id, row.version, JSON.parse(row.data)])).toEqual([['bad', 4, { ...base, dueDate: null }], ['good', 2, good]]);
      const history = db.prepare("SELECT version, entity FROM entity_history WHERE id='bad'").get() as { version: number; entity: string };
      expect(history.version).toBe(4);
      expect(JSON.parse(history.entity)).toMatchObject({ id: 'bad', kind: 'task', version: 4, deleted: false, data: { dueDate: null } });
    } finally { db.close(); }
  });

  it('repairs a calendar import ending after 2199 on a database that already recorded migration 11', () => {
    const path = tempPath();
    const setup = openDatabase(path);
    const imported = { subscriptionId: 'sub', uid: 'u', recurrenceId: null, startDate: '2026-10-01', startTime: '09:00', endDate: '2300-01-01', endTime: '10:00', timeZone: 'UTC', allDay: false, sourceRemoved: false, sourceUpdatedAt: '2026-09-01T00:00:00.000Z', url: null };
    const task = { title: 'Assembly', dueDate: '2026-10-01', dueTime: '09:00', classId: null, notes: '', completed: false, imported };
    setup.prepare('INSERT INTO users(id,google_sub,email,created_at) VALUES(?,?,?,?)').run('u', 'u', 'u@example.com', 'now');
    setup.prepare('INSERT INTO entities(owner_id,id,kind,version,data,deleted) VALUES(?,?,?,?,?,?)').run('u', 'ical_1', 'task', 1, JSON.stringify(task), 0);
    // Opened by the build whose repair left imported end dates alone.
    setup.prepare('DELETE FROM schema_migrations WHERE version=13').run();
    setup.close();
    const db = openDatabase(path);
    try {
      const row = db.prepare("SELECT version, data FROM entities WHERE id='ical_1'").get() as { version: number; data: string };
      expect(row.version).toBe(2);
      expect(JSON.parse(row.data)).toEqual({ ...task, imported: { ...imported, endDate: null, endTime: null } });
      expect(db.prepare("SELECT version FROM entity_history WHERE id='ical_1'").get()).toEqual({ version: 2 });
    } finally { db.close(); }
  });

  it('adds the proposal tally threshold to a database that recorded migration 12 without it', () => {
    const path = tempPath();
    const setup = openDatabase(path);
    // Opened by the build whose migration 12 stored only the tallied counts.
    setup.exec('ALTER TABLE schedule_proposals DROP COLUMN tally_threshold');
    setup.close();
    const db = openDatabase(path);
    try {
      const columns = (db.pragma('table_info(schedule_proposals)') as { name: string }[]).map(column => column.name);
      expect(columns).toEqual(expect.arrayContaining(['tally_for', 'tally_against', 'tally_threshold']));
    } finally { db.close(); }
  });

  it('indexes the audit log lookups and the push subscription cascade', () => {
    const db = openDatabase(':memory:');
    try {
      expect(plan(db, "SELECT count(*) n FROM audit_log WHERE actor_id=? AND action='school.create' AND created_at > ?", 'u', 't')).toContain('audit_log_actor');
      expect(plan(db, "SELECT count(*) FROM audit_log a WHERE a.action='member.remove' AND json_extract(a.detail, '$.userId')=?", 'u')).toContain('audit_log_action');
      expect(plan(db, 'SELECT 1 FROM notification_deliveries WHERE subscription_id=?', 's')).toContain('notification_deliveries_subscription');
    } finally { db.close(); }
  });

  it('indexes pending friend requests by sender and push subscriptions by owner', () => {
    const db = openDatabase(':memory:');
    try {
      expect(plan(db, "SELECT count(*) n FROM friendships WHERE requester_id=? AND status='pending'", 'u')).toContain('friendships_requester');
      const push = plan(db, 'SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE owner_id=? ORDER BY created_at, id', 'u');
      expect(push).toContain('push_subscriptions_owner');
    } finally { db.close(); }
  });
});
