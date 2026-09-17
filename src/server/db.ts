import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export type Db = Database.Database;
export function openDatabase(path = process.env.DATABASE_PATH || './data/quasar.sqlite'): Db {
  if (path !== ':memory:') mkdirSync(dirname(resolve(path)), { recursive: true, mode: 0o700 });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS schools (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, location TEXT NOT NULL,
      schedule TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
      approved INTEGER NOT NULL DEFAULT 0, member_locked INTEGER NOT NULL DEFAULT 0,
      support_locked INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, google_sub TEXT NOT NULL UNIQUE, email TEXT NOT NULL,
      display_name TEXT NOT NULL DEFAULT '', full_name TEXT NOT NULL DEFAULT '',
      school_id TEXT REFERENCES schools(id), reviewed_version INTEGER,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS users_school ON users(school_id);
    CREATE TABLE IF NOT EXISTS school_revisions (
      school_id TEXT NOT NULL REFERENCES schools(id), version INTEGER NOT NULL,
      schedule TEXT NOT NULL, actor_id TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL,
      PRIMARY KEY(school_id, version)
    );
    CREATE TABLE IF NOT EXISTS entities (
      owner_id TEXT NOT NULL REFERENCES users(id), id TEXT NOT NULL, kind TEXT NOT NULL,
      version INTEGER NOT NULL, data TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(owner_id, id)
    );
    CREATE TABLE IF NOT EXISTS entity_history (
      owner_id TEXT NOT NULL REFERENCES users(id), id TEXT NOT NULL,
      version INTEGER NOT NULL, entity TEXT NOT NULL, PRIMARY KEY(owner_id, id, version)
    );
    CREATE TABLE IF NOT EXISTS mutation_receipts (
      owner_id TEXT NOT NULL REFERENCES users(id), mutation_id TEXT NOT NULL,
      fingerprint TEXT NOT NULL, result TEXT NOT NULL, created_at TEXT NOT NULL,
      PRIMARY KEY(owner_id, mutation_id)
    );
    CREATE TABLE IF NOT EXISTS support_requests (
      id TEXT PRIMARY KEY, school_id TEXT NOT NULL REFERENCES schools(id),
      user_id TEXT NOT NULL REFERENCES users(id), message TEXT NOT NULL,
      created_at TEXT NOT NULL, resolved_at TEXT
    );
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, actor_id TEXT NOT NULL REFERENCES users(id),
      action TEXT NOT NULL, school_id TEXT REFERENCES schools(id), detail TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(1, datetime('now'));
  `);
  // Additive phase-2 migration. Existing entity history and offline bases remain intact.
  db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS calendar_subscriptions (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), name TEXT NOT NULL,
        url_encrypted TEXT NOT NULL, url_hash TEXT NOT NULL, time_zone TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1, etag TEXT, last_modified TEXT, cached_feed TEXT,
        last_attempt_at TEXT, last_success_at TEXT, next_refresh_at TEXT NOT NULL,
        last_error TEXT, failure_count INTEGER NOT NULL DEFAULT 0, lease_token TEXT, lease_until TEXT,
        UNIQUE(owner_id,url_hash)
      );
      CREATE INDEX IF NOT EXISTS calendar_due ON calendar_subscriptions(enabled,next_refresh_at);
      CREATE TABLE IF NOT EXISTS calendar_items (
        subscription_id TEXT NOT NULL REFERENCES calendar_subscriptions(id) ON DELETE CASCADE,
        item_key TEXT NOT NULL, entity_id TEXT NOT NULL, source_data TEXT NOT NULL,
        PRIMARY KEY(subscription_id,item_key)
      );
      CREATE TABLE IF NOT EXISTS calendar_conflicts (
        owner_id TEXT NOT NULL REFERENCES users(id), entity_id TEXT NOT NULL,
        subscription_id TEXT NOT NULL REFERENCES calendar_subscriptions(id) ON DELETE CASCADE,
        fields TEXT NOT NULL, incoming TEXT NOT NULL,
        PRIMARY KEY(owner_id,entity_id)
      );
      CREATE TABLE IF NOT EXISTS recurring_successors (
        owner_id TEXT NOT NULL REFERENCES users(id), parent_id TEXT NOT NULL, successor_id TEXT NOT NULL,
        PRIMARY KEY(owner_id,parent_id)
      );
      CREATE TABLE IF NOT EXISTS push_subscriptions (
        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id), endpoint TEXT NOT NULL UNIQUE,
        p256dh TEXT NOT NULL, auth TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS notification_deliveries (
        owner_id TEXT NOT NULL REFERENCES users(id), entity_id TEXT NOT NULL,
        subscription_id TEXT NOT NULL REFERENCES push_subscriptions(id) ON DELETE CASCADE,
        reminder_at TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT, updated_at TEXT NOT NULL,
        PRIMARY KEY(owner_id,entity_id,reminder_at,subscription_id)
      );
      INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES(2,datetime('now'));
    `);
    const columns = db.pragma('table_info(calendar_subscriptions)') as {name: string}[];
    if (!columns.some(column => column.name === 'cached_feed')) db.exec('ALTER TABLE calendar_subscriptions ADD COLUMN cached_feed TEXT');
  })();
  return db;
}
const globalDb = globalThis as unknown as { quasarDb?: Db };
export function getDb(): Db {
  return globalDb.quasarDb ??= openDatabase();
}
