import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/** Schema migrations; append-only. Index = version - 1. */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE tickets (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL DEFAULT 'feature',
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'backlog',
    priority TEXT NOT NULL DEFAULT 'p2',
    lane TEXT NOT NULL DEFAULT 'feature',
    labels TEXT NOT NULL DEFAULT '[]',
    scope_paths TEXT NOT NULL DEFAULT '[]',
    owner TEXT,
    lease_until INTEGER,
    claimed_at INTEGER,
    attempts INTEGER NOT NULL DEFAULT 0,
    rework_count INTEGER NOT NULL DEFAULT 0,
    blocked_reason TEXT,
    unblock_condition TEXT,
    spec_ref TEXT,
    branch TEXT,
    github_issue INTEGER,
    pr_url TEXT,
    external_key TEXT UNIQUE,
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    closed_at INTEGER,
    version INTEGER NOT NULL DEFAULT 1
  );
  CREATE INDEX tickets_status ON tickets(status);
  CREATE INDEX tickets_owner ON tickets(owner);

  CREATE TABLE acceptance_criteria (
    ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    ac_id TEXT NOT NULL,
    text TEXT NOT NULL,
    verdict TEXT NOT NULL DEFAULT 'Unknown',
    evidence TEXT,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (ticket_id, ac_id)
  );

  CREATE TABLE deps (
    ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    depends_on TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    kind TEXT NOT NULL DEFAULT 'blocks',
    created_at INTEGER NOT NULL,
    PRIMARY KEY (ticket_id, depends_on, kind)
  );
  CREATE INDEX deps_on ON deps(depends_on);

  CREATE TABLE comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_id TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
    kind TEXT NOT NULL DEFAULT 'note',
    actor TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX comments_ticket ON comments(ticket_id);

  CREATE TABLE sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ticket_id TEXT REFERENCES tickets(id) ON DELETE SET NULL,
    session_id TEXT NOT NULL,
    harness TEXT,
    actor TEXT,
    transcript_path TEXT,
    branch TEXT,
    commit_range TEXT,
    reason TEXT,
    started_at INTEGER NOT NULL,
    ended_at INTEGER
  );
  CREATE INDEX sessions_ticket ON sessions(ticket_id);

  CREATE TABLE agents (
    id TEXT PRIMARY KEY,
    harness TEXT,
    skills TEXT NOT NULL DEFAULT '[]',
    last_seen INTEGER NOT NULL
  );

  CREATE TABLE events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    actor TEXT NOT NULL,
    actor_kind TEXT NOT NULL,
    action TEXT NOT NULL,
    ticket_id TEXT,
    payload TEXT NOT NULL DEFAULT '{}',
    prev_hash TEXT NOT NULL,
    hash TEXT NOT NULL
  );
  CREATE INDEX events_ticket ON events(ticket_id);
  CREATE TRIGGER events_no_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
  CREATE TRIGGER events_no_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;

  CREATE TABLE outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    target TEXT NOT NULL,
    payload TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_try INTEGER NOT NULL,
    last_error TEXT,
    created_at INTEGER NOT NULL,
    done_at INTEGER
  );

  CREATE TABLE locks (
    name TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
];

export const SCHEMA_VERSION = MIGRATIONS.length;

export function openDatabase(file: string): DatabaseSync {
  if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA busy_timeout = 10000;");
  if (file !== ":memory:") db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON; PRAGMA synchronous = NORMAL;");
  migrate(db);
  return db;
}

function migrate(db: DatabaseSync): void {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
  let version = row.user_version;
  while (version < MIGRATIONS.length) {
    db.exec("BEGIN IMMEDIATE");
    try {
      // Re-check under the write lock: another process may have migrated meanwhile.
      const now = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
      if (now > version) {
        db.exec("COMMIT");
        version = now;
        continue;
      }
      db.exec(MIGRATIONS[version]);
      db.exec(`PRAGMA user_version = ${version + 1}`);
      db.exec("COMMIT");
      version += 1;
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
}
