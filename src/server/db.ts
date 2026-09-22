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
  db.exec(`
    CREATE TABLE IF NOT EXISTS school_classes (
      id TEXT PRIMARY KEY, school_id TEXT NOT NULL REFERENCES schools(id),
      data TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
      deleted INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS school_classes_school ON school_classes(school_id, deleted);
    INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(3, datetime('now'));
  `);
  // Phase-3 migration: school verification, profiles, friendships, safety controls and schedule voting.
  db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS school_verifications (
        user_id TEXT NOT NULL REFERENCES users(id), school_id TEXT NOT NULL REFERENCES schools(id),
        method TEXT NOT NULL, actor_id TEXT REFERENCES users(id), verified_at TEXT NOT NULL,
        PRIMARY KEY(user_id, school_id)
      );
      CREATE TABLE IF NOT EXISTS verification_requests (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), school_id TEXT NOT NULL REFERENCES schools(id),
        proof TEXT NOT NULL, created_at TEXT NOT NULL, resolved_at TEXT, decision TEXT, actor_id TEXT REFERENCES users(id)
      );
      CREATE INDEX IF NOT EXISTS verification_requests_open ON verification_requests(resolved_at, created_at);
      CREATE TABLE IF NOT EXISTS friendships (
        user_low TEXT NOT NULL REFERENCES users(id), user_high TEXT NOT NULL REFERENCES users(id),
        requester_id TEXT NOT NULL REFERENCES users(id), status TEXT NOT NULL,
        created_at TEXT NOT NULL, responded_at TEXT,
        PRIMARY KEY(user_low, user_high)
      );
      CREATE INDEX IF NOT EXISTS friendships_high ON friendships(user_high, status);
      CREATE TABLE IF NOT EXISTS blocks (
        blocker_id TEXT NOT NULL REFERENCES users(id), blocked_id TEXT NOT NULL REFERENCES users(id),
        created_at TEXT NOT NULL, PRIMARY KEY(blocker_id, blocked_id)
      );
      CREATE TABLE IF NOT EXISTS reports (
        id TEXT PRIMARY KEY, reporter_id TEXT NOT NULL REFERENCES users(id), reported_id TEXT NOT NULL REFERENCES users(id),
        school_id TEXT REFERENCES schools(id), reason TEXT NOT NULL, created_at TEXT NOT NULL,
        resolved_at TEXT, actor_id TEXT REFERENCES users(id), outcome TEXT
      );
      CREATE INDEX IF NOT EXISTS reports_open ON reports(resolved_at, created_at);
      CREATE TABLE IF NOT EXISTS school_bans (
        school_id TEXT NOT NULL REFERENCES schools(id), user_id TEXT NOT NULL REFERENCES users(id),
        actor_id TEXT NOT NULL REFERENCES users(id), reason TEXT NOT NULL, created_at TEXT NOT NULL,
        PRIMARY KEY(school_id, user_id)
      );
      CREATE TABLE IF NOT EXISTS schedule_proposals (
        id TEXT PRIMARY KEY, school_id TEXT NOT NULL REFERENCES schools(id), proposer_id TEXT NOT NULL REFERENCES users(id),
        base_version INTEGER NOT NULL, schedule TEXT NOT NULL, summary TEXT NOT NULL, status TEXT NOT NULL,
        created_at TEXT NOT NULL, closed_at TEXT, actor_id TEXT REFERENCES users(id)
      );
      CREATE INDEX IF NOT EXISTS schedule_proposals_school ON schedule_proposals(school_id, status);
      CREATE TABLE IF NOT EXISTS proposal_votes (
        proposal_id TEXT NOT NULL REFERENCES schedule_proposals(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id),
        vote TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(proposal_id, user_id)
      );
      INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(4, datetime('now'));
    `);
    const schoolColumns = db.pragma('table_info(schools)') as {name: string}[];
    if (!schoolColumns.some(column => column.name === 'email_domains')) db.exec("ALTER TABLE schools ADD COLUMN email_domains TEXT NOT NULL DEFAULT ''");
  })();
  // Onboarding migration: remember the Google profile name to prefill the names step, and let
  // support requests come from students who have not joined a school yet.
  db.transaction(() => {
    const userColumns = db.pragma('table_info(users)') as {name: string}[];
    if (!userColumns.some(column => column.name === 'google_name')) db.exec("ALTER TABLE users ADD COLUMN google_name TEXT NOT NULL DEFAULT ''");
    const requestColumns = db.pragma('table_info(support_requests)') as {name: string; notnull: number}[];
    if (requestColumns.find(column => column.name === 'school_id')?.notnull) {
      db.exec(`
        CREATE TABLE support_requests_next (
          id TEXT PRIMARY KEY, school_id TEXT REFERENCES schools(id),
          user_id TEXT NOT NULL REFERENCES users(id), message TEXT NOT NULL,
          created_at TEXT NOT NULL, resolved_at TEXT
        );
        INSERT INTO support_requests_next SELECT id, school_id, user_id, message, created_at, resolved_at FROM support_requests;
        DROP TABLE support_requests;
        ALTER TABLE support_requests_next RENAME TO support_requests;
      `);
    }
    db.exec("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(5, datetime('now'))");
  })();
  return db;
}
const globalDb = globalThis as unknown as { quasarDb?: Db };
export function getDb(): Db {
  return globalDb.quasarDb ??= openDatabase();
}
