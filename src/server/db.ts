import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { repairTaskDates } from '@/domain/task';

export type Db = Database.Database;
/**
 * True for SQLITE_BUSY and its variants: another connection (the web server or the worker) held the write lock
 * for longer than busy_timeout. The data is fine; the same work can simply run again later. Transactions that
 * may write use `.immediate()`, so they wait for the lock at BEGIN (where busy_timeout applies) instead of
 * failing at once when a read inside a deferred transaction has to become a write.
 */
export function isBusy(error: unknown): boolean {
  const code = error && typeof error === 'object' && 'code' in error ? String((error as { code: unknown }).code) : '';
  return code.startsWith('SQLITE_BUSY');
}
export function openDatabase(path = process.env.DATABASE_PATH || './data/quasar.sqlite'): Db {
  if (path !== ':memory:') mkdirSync(dirname(resolve(path)), { recursive: true, mode: 0o700 });
  const db = new Database(path);
  try {
    db.pragma('busy_timeout = 5000');
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    // Every step runs in one write transaction. The web server and the worker restart together after a deploy, and
    // both open the database: the second opener waits at BEGIN (where busy_timeout applies) and then finds each step
    // already applied, instead of racing a check-then-ALTER ("duplicate column name") or failing when a read has to
    // become a write (SQLITE_BUSY_SNAPSHOT). A failed migration rolls back as a whole and the handle is closed, so
    // getDb() can simply try again on the next request.
    db.transaction(() => migrate(db)).immediate();
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}
/** Every step is idempotent, so it is safe to run on each open; openDatabase runs it inside one immediate transaction. */
function migrate(db: Db): void {
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
  {
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
  }
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
  {
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
  }
  // Onboarding migration: remember the Google profile name to prefill the names step, and let
  // support requests come from students who have not joined a school yet.
  {
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
  }
  // Phase-4 migration: one-to-one chat between accepted friends, messaging pauses, and chat reports.
  // Three steps in order, because the reports indexes need the new columns.
  {
    db.exec(`
      CREATE TABLE IF NOT EXISTS chat_threads (
        id TEXT PRIMARY KEY,
        user_low TEXT NOT NULL REFERENCES users(id),
        user_high TEXT NOT NULL REFERENCES users(id),
        revision INTEGER NOT NULL DEFAULT 0,
        last_message_at TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(user_low, user_high),
        CHECK(user_low < user_high)
      );
      CREATE INDEX IF NOT EXISTS chat_threads_high ON chat_threads(user_high);
      CREATE INDEX IF NOT EXISTS chat_threads_last ON chat_threads(last_message_at);

      CREATE TABLE IF NOT EXISTS chat_members (
        thread_id TEXT NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id),
        last_read_seq INTEGER NOT NULL DEFAULT 0,
        notified_seq INTEGER NOT NULL DEFAULT 0,
        muted INTEGER NOT NULL DEFAULT 0,
        first_sent_at TEXT,
        PRIMARY KEY(thread_id, user_id)
      );
      CREATE INDEX IF NOT EXISTS chat_members_user ON chat_members(user_id);
      CREATE INDEX IF NOT EXISTS chat_members_first_sent ON chat_members(user_id, first_sent_at) WHERE first_sent_at IS NOT NULL;

      CREATE TABLE IF NOT EXISTS chat_messages (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL,
        thread_id TEXT NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
        sender_id TEXT NOT NULL REFERENCES users(id),
        body TEXT NOT NULL,
        created_at TEXT NOT NULL,
        deleted_at TEXT,
        deleted_by TEXT CHECK (deleted_by IN ('sender','support')),
        revision INTEGER NOT NULL,
        UNIQUE(sender_id, id)
      );
      CREATE INDEX IF NOT EXISTS chat_messages_thread_seq ON chat_messages(thread_id, seq);
      CREATE INDEX IF NOT EXISTS chat_messages_thread_revision ON chat_messages(thread_id, revision);
      CREATE INDEX IF NOT EXISTS chat_messages_sender_time ON chat_messages(sender_id, created_at);
      CREATE INDEX IF NOT EXISTS chat_messages_created ON chat_messages(created_at);
      CREATE INDEX IF NOT EXISTS chat_messages_deleted ON chat_messages(deleted_at) WHERE deleted_at IS NOT NULL;

      CREATE TABLE IF NOT EXISTS chat_pauses (
        user_id TEXT PRIMARY KEY REFERENCES users(id),
        until TEXT,
        actor_id TEXT NOT NULL REFERENCES users(id),
        reason TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    const reportColumns = db.pragma('table_info(reports)') as {name: string}[];
    // No foreign key on thread_id on purpose: pruning a thread must not be blocked by an old report.
    if (!reportColumns.some(column => column.name === 'thread_id')) db.exec('ALTER TABLE reports ADD COLUMN thread_id TEXT');
    // Frozen JSON snapshot; NULL for profile reports and after the 180-day purge.
    if (!reportColumns.some(column => column.name === 'evidence')) db.exec('ALTER TABLE reports ADD COLUMN evidence TEXT');
    // 'danger' | 'bullying' | 'sexual' | 'spam' | 'other'; NULL for phase-3 profile reports.
    if (!reportColumns.some(column => column.name === 'category')) db.exec('ALTER TABLE reports ADD COLUMN category TEXT');
    const userColumns = db.pragma('table_info(users)') as {name: string}[];
    if (!userColumns.some(column => column.name === 'chat_push')) db.exec('ALTER TABLE users ADD COLUMN chat_push INTEGER NOT NULL DEFAULT 1');
    db.exec(`
      CREATE INDEX IF NOT EXISTS reports_thread ON reports(reporter_id, thread_id, resolved_at);
      CREATE INDEX IF NOT EXISTS reports_reported ON reports(reported_id, resolved_at);
      INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(6, datetime('now'));
    `);
  }
  // Global chat migration: one room every member with names can read and post in, owner-moderated.
  db.exec(`
    CREATE TABLE IF NOT EXISTS global_chat (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      revision INTEGER NOT NULL DEFAULT 0,
      last_message_at TEXT
    );
    INSERT OR IGNORE INTO global_chat(id, revision) VALUES(1, 0);

    CREATE TABLE IF NOT EXISTS global_messages (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL,
      sender_id TEXT NOT NULL REFERENCES users(id),
      body TEXT NOT NULL,
      created_at TEXT NOT NULL,
      edited_at TEXT,
      deleted_at TEXT,
      deleted_by TEXT CHECK (deleted_by IN ('sender','owner')),
      reason TEXT,
      revision INTEGER NOT NULL,
      UNIQUE(sender_id, id)
    );
    CREATE INDEX IF NOT EXISTS global_messages_revision ON global_messages(revision);
    CREATE INDEX IF NOT EXISTS global_messages_sender_time ON global_messages(sender_id, created_at);
    CREATE INDEX IF NOT EXISTS global_messages_created ON global_messages(created_at);

    CREATE TABLE IF NOT EXISTS global_members (
      user_id TEXT PRIMARY KEY REFERENCES users(id),
      last_read_seq INTEGER NOT NULL DEFAULT 0,
      notified_seq INTEGER NOT NULL DEFAULT 0,
      muted INTEGER NOT NULL DEFAULT 0
    );
  `);
  // The owner's reason for an edit or removal, shown to everyone under the message.
  const globalColumns = db.pragma('table_info(global_messages)') as {name: string}[];
  if (!globalColumns.some(column => column.name === 'reason')) db.exec('ALTER TABLE global_messages ADD COLUMN reason TEXT');
  const memberColumns = db.pragma('table_info(global_members)') as {name: string}[];
  if (!memberColumns.some(column => column.name === 'notified_seq')) db.exec('ALTER TABLE global_members ADD COLUMN notified_seq INTEGER NOT NULL DEFAULT 0');
  db.exec("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(7, datetime('now'))");
  // Global message IDs are unique across the room, not only per sender: owner Remove and Edit address a
  // message by ID, so another member must never be able to post under an ID already in use. Rows that
  // reused an ID before this index existed keep the oldest row's ID; later copies get a fresh UUID.
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='global_messages_id'").get()) {
    db.exec(`UPDATE global_messages SET id = lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2)
        || '-' || substr('89ab', 1 + abs(random()) % 4, 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))
      WHERE seq NOT IN (SELECT min(seq) FROM global_messages GROUP BY id);
      CREATE UNIQUE INDEX IF NOT EXISTS global_messages_id ON global_messages(id);`);
  }
  // Sync quotas count an account's receipts from the last day.
  db.exec('CREATE INDEX IF NOT EXISTS mutation_receipts_owner_time ON mutation_receipts(owner_id, created_at)');
  // Migration 8: audit_log only grows, so the per-account rate limits (school creation, schedule scans, calendar
  // additions) and the report history counts (removals and pauses of one student) need indexes rather than full scans.
  // The history counts filter by action first, which leaves only the rare owner actions for json_extract; an index on
  // the extracted value is avoided because it would make any insert with a non-JSON detail fail. Deleting a push
  // subscription cascades to its deliveries, where subscription_id is the last primary-key column.
  db.exec(`
    CREATE INDEX IF NOT EXISTS audit_log_actor ON audit_log(actor_id, action, created_at);
    CREATE INDEX IF NOT EXISTS audit_log_action ON audit_log(action, created_at);
    CREATE INDEX IF NOT EXISTS notification_deliveries_subscription ON notification_deliveries(subscription_id);
    INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(8, datetime('now'));
  `);
  // Migration 9: the worker prunes notification_deliveries every minute by time (reminder and support rows by
  // reminder_at, chat rows by entity_id and updated_at). entity_id is not the leading primary-key column, so without
  // these each prune scanned the whole table.
  db.exec(`
    CREATE INDEX IF NOT EXISTS notification_deliveries_reminder_at ON notification_deliveries(reminder_at);
    CREATE INDEX IF NOT EXISTS notification_deliveries_entity_updated ON notification_deliveries(entity_id, updated_at);
    INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(9, datetime('now'));
  `);
  // Migration 10: every friend request counts the sender's pending requests (requester_id, status), and the chat and
  // support push jobs look up each recipient's browsers every minute (owner_id). Neither column led an index.
  db.exec(`
    CREATE INDEX IF NOT EXISTS friendships_requester ON friendships(requester_id, status);
    CREATE INDEX IF NOT EXISTS push_subscriptions_owner ON push_subscriptions(owner_id, created_at);
    INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(10, datetime('now'));
  `);
  // Migration 11: task dates were narrowed to the schedule's 1900-2199 range, but older builds let a typed year such
  // as 0002 or 2300 be saved. Such a task fails taskSchema, so it would be hidden everywhere and could not be edited.
  // repairTaskDates drops the out-of-range dates; the repair is a new version with a history row, so devices pick it
  // up on their next sync and three-way merges still find the old version as a base.
  // Migration 13 is the same repair run again: it now also drops a calendar import's end date after 2199 (an event
  // ending, or a VTODO due, past it), which the first version left in place, so databases that recorded 11 before
  // that repair it too. A fresh database runs the repair once and records both.
  if (!db.prepare('SELECT 1 FROM schema_migrations WHERE version=13').get()) {
    const rows = db.prepare("SELECT owner_id, id, version, data FROM entities WHERE kind='task' AND deleted=0").all() as { owner_id: string; id: string; version: number; data: string }[];
    const update = db.prepare('UPDATE entities SET version=?, data=? WHERE owner_id=? AND id=?');
    const history = db.prepare('INSERT INTO entity_history VALUES(?,?,?,?)');
    for (const row of rows) {
      let repaired;
      try { repaired = repairTaskDates(JSON.parse(row.data)); } catch { continue; }
      if (!repaired) continue;
      const version = row.version + 1;
      update.run(version, JSON.stringify(repaired), row.owner_id, row.id);
      history.run(row.owner_id, row.id, version, JSON.stringify({ id: row.id, kind: 'task', version, data: repaired, deleted: false }));
    }
    db.exec("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(11, datetime('now')), (13, datetime('now'))");
  }
  // Migration 12: each proposal keeps the counted votes and the threshold from its last tally, so a closed proposal goes
  // on showing the result that decided it after voters leave or the school grows (open proposals count current
  // verified members live). Proposals that closed before this have NULL here and show their raw vote counts and the
  // live threshold, as they always did. Each column is added only if missing, so a database that recorded 12 before
  // tally_threshold existed gains it too.
  const proposalColumns = db.pragma('table_info(schedule_proposals)') as {name: string}[];
  if (!proposalColumns.some(column => column.name === 'tally_for')) db.exec('ALTER TABLE schedule_proposals ADD COLUMN tally_for INTEGER');
  if (!proposalColumns.some(column => column.name === 'tally_against')) db.exec('ALTER TABLE schedule_proposals ADD COLUMN tally_against INTEGER');
  if (!proposalColumns.some(column => column.name === 'tally_threshold')) db.exec('ALTER TABLE schedule_proposals ADD COLUMN tally_threshold INTEGER');
  db.exec("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(12, datetime('now'))");
  // Migration 14: the school's lunch menu. `menu_source` is the Nutrislice menu the school follows as JSON
  // (src/server/menu.ts, MenuSource) or '' for none; menu_weeks caches one fetched week per school so every
  // student opening Today does not fetch the menu provider again (rows are refreshed after MENU_CACHE_MS and
  // pruned once the week is two months old).
  const menuColumns = db.pragma('table_info(schools)') as {name: string}[];
  if (!menuColumns.some(column => column.name === 'menu_source')) db.exec("ALTER TABLE schools ADD COLUMN menu_source TEXT NOT NULL DEFAULT ''");
  db.exec(`
    CREATE TABLE IF NOT EXISTS menu_weeks (
      school_id TEXT NOT NULL REFERENCES schools(id), week_start TEXT NOT NULL,
      source TEXT NOT NULL, days TEXT NOT NULL, fetched_at TEXT NOT NULL,
      PRIMARY KEY(school_id, week_start)
    );
    INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(14, datetime('now'));
  `);
  // Migration 15: the owner's user console (src/server/support.ts). `session_epoch` is copied into each session token
  // at sign-in and compared on every request (getAuth in src/server/auth.ts), so raising it signs the account out
  // everywhere; `suspended_at` refuses the account until support lifts it. Owner actions record the request's
  // address and browser in audit_log (`ip`, `user_agent`) so a session used from somewhere unexpected stands out.
  const accountColumns = db.pragma('table_info(users)') as {name: string}[];
  if (!accountColumns.some(column => column.name === 'session_epoch')) db.exec('ALTER TABLE users ADD COLUMN session_epoch INTEGER NOT NULL DEFAULT 0');
  if (!accountColumns.some(column => column.name === 'suspended_at')) db.exec('ALTER TABLE users ADD COLUMN suspended_at TEXT');
  if (!accountColumns.some(column => column.name === 'suspended_reason')) db.exec('ALTER TABLE users ADD COLUMN suspended_reason TEXT');
  const auditColumns = db.pragma('table_info(audit_log)') as {name: string}[];
  if (!auditColumns.some(column => column.name === 'ip')) db.exec('ALTER TABLE audit_log ADD COLUMN ip TEXT');
  if (!auditColumns.some(column => column.name === 'user_agent')) db.exec('ALTER TABLE audit_log ADD COLUMN user_agent TEXT');
  db.exec("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(15, datetime('now'))");
  // Migration 16: audit_log is append-only. Nothing in the app updates or deletes it (the rate limits only count
  // rows), so a bug or a future owner tool cannot quietly rewrite history. Someone with the database file can still
  // drop the triggers; the server log's copy of each owner action (Service.audit) is the tamper evidence for that.
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS audit_log_no_update BEFORE UPDATE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS audit_log_no_delete BEFORE DELETE ON audit_log BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
    INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(16, datetime('now'));
  `);
  // Migration 17 (docs/CHAT.md §12-§14): profile pictures, friend groups, read and delivery markers, typing
  // signals, appeals against sanctions and group reports.
  // - users: the Google profile picture URL saved at sign-in, an uploaded picture (a small JPEG or WebP blob), its
  //   version (cache-busts the avatar URL) and whether the student chose initials over any picture.
  // - chat_members: how far the other person's device has fetched (delivered_seq) and a typing signal's expiry.
  // - chat_groups, chat_group_members, chat_group_messages: friend groups, mirroring the one-to-one tables.
  // - reports.group_id: a report of a group message (no foreign key, like thread_id: pruning must not be blocked).
  // - support_requests.kind: '' for the existing requests and feedback; 'appeal:pause' and 'appeal:ban' for appeals.
  {
    const userColumns = db.pragma('table_info(users)') as {name: string}[];
    if (!userColumns.some(column => column.name === 'google_picture')) db.exec("ALTER TABLE users ADD COLUMN google_picture TEXT NOT NULL DEFAULT ''");
    if (!userColumns.some(column => column.name === 'avatar')) db.exec('ALTER TABLE users ADD COLUMN avatar BLOB');
    if (!userColumns.some(column => column.name === 'avatar_mime')) db.exec("ALTER TABLE users ADD COLUMN avatar_mime TEXT NOT NULL DEFAULT ''");
    if (!userColumns.some(column => column.name === 'avatar_version')) db.exec('ALTER TABLE users ADD COLUMN avatar_version INTEGER NOT NULL DEFAULT 0');
    if (!userColumns.some(column => column.name === 'avatar_hidden')) db.exec('ALTER TABLE users ADD COLUMN avatar_hidden INTEGER NOT NULL DEFAULT 0');
    const memberColumns = db.pragma('table_info(chat_members)') as {name: string}[];
    if (!memberColumns.some(column => column.name === 'delivered_seq')) db.exec('ALTER TABLE chat_members ADD COLUMN delivered_seq INTEGER NOT NULL DEFAULT 0');
    if (!memberColumns.some(column => column.name === 'typing_until')) db.exec('ALTER TABLE chat_members ADD COLUMN typing_until TEXT');
    const reportColumns = db.pragma('table_info(reports)') as {name: string}[];
    if (!reportColumns.some(column => column.name === 'group_id')) db.exec('ALTER TABLE reports ADD COLUMN group_id TEXT');
    const requestColumns = db.pragma('table_info(support_requests)') as {name: string}[];
    if (!requestColumns.some(column => column.name === 'kind')) db.exec("ALTER TABLE support_requests ADD COLUMN kind TEXT NOT NULL DEFAULT ''");
    db.exec(`
      CREATE TABLE IF NOT EXISTS chat_groups (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        creator_id TEXT NOT NULL REFERENCES users(id),
        revision INTEGER NOT NULL DEFAULT 0,
        last_message_at TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS chat_groups_creator ON chat_groups(creator_id, created_at);
      CREATE INDEX IF NOT EXISTS chat_groups_last ON chat_groups(last_message_at);

      CREATE TABLE IF NOT EXISTS chat_group_members (
        group_id TEXT NOT NULL REFERENCES chat_groups(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id),
        role TEXT NOT NULL CHECK (role IN ('admin','member')),
        joined_at TEXT NOT NULL,
        left_at TEXT,
        last_read_seq INTEGER NOT NULL DEFAULT 0,
        delivered_seq INTEGER NOT NULL DEFAULT 0,
        notified_seq INTEGER NOT NULL DEFAULT 0,
        muted INTEGER NOT NULL DEFAULT 0,
        typing_until TEXT,
        PRIMARY KEY(group_id, user_id)
      );
      CREATE INDEX IF NOT EXISTS chat_group_members_user ON chat_group_members(user_id, left_at);

      CREATE TABLE IF NOT EXISTS chat_group_messages (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        group_id TEXT NOT NULL REFERENCES chat_groups(id) ON DELETE CASCADE,
        sender_id TEXT NOT NULL REFERENCES users(id),
        body TEXT NOT NULL,
        created_at TEXT NOT NULL,
        deleted_at TEXT,
        deleted_by TEXT CHECK (deleted_by IN ('sender','admin','support')),
        revision INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS chat_group_messages_group_seq ON chat_group_messages(group_id, seq);
      CREATE INDEX IF NOT EXISTS chat_group_messages_group_revision ON chat_group_messages(group_id, revision);
      CREATE INDEX IF NOT EXISTS chat_group_messages_sender_time ON chat_group_messages(sender_id, created_at);
      CREATE INDEX IF NOT EXISTS chat_group_messages_created ON chat_group_messages(created_at);
      INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES(17, datetime('now'));
    `);
  }
}
const globalDb = globalThis as unknown as { quasarDb?: Db };
export function getDb(): Db {
  return globalDb.quasarDb ??= openDatabase();
}
