// The index database. Derived tables are a cache of the transcripts and can be rebuilt at any time;
// the durable tables (triage, integrity alerts, re-pricing events) are never dropped by a rebuild.
import { DatabaseSync } from 'node:sqlite';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

export const SCHEMA_VERSION = 5;

const DURABLE = `
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS triage(finding_id TEXT PRIMARY KEY, status TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS integrity_alerts(
  id INTEGER PRIMARY KEY, path TEXT NOT NULL, session_id TEXT NOT NULL, at INTEGER NOT NULL, reason TEXT NOT NULL,
  old_size INTEGER NOT NULL, new_size INTEGER NOT NULL, ack_at INTEGER, ack_note TEXT);
CREATE TABLE IF NOT EXISTS price_events(id INTEGER PRIMARY KEY, at INTEGER NOT NULL, detail TEXT NOT NULL);
`;

const DERIVED_TABLES = ['files', 'sessions', 'api_calls', 'tool_calls', 'events', 'prompts', 'findings', 'type_counts', 'file_touch', 'cost_state', 'links', 'search'];

const DERIVED = `
CREATE TABLE files(
  id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE, project TEXT NOT NULL, session_id TEXT NOT NULL, agent_id TEXT, agent_type TEXT,
  size INTEGER NOT NULL DEFAULT 0, mtime_ms REAL NOT NULL DEFAULT 0, offset INTEGER NOT NULL DEFAULT 0, lines INTEGER NOT NULL DEFAULT 0,
  tail_hash TEXT NOT NULL DEFAULT '', deep_offset INTEGER NOT NULL DEFAULT 0, deep_hash TEXT NOT NULL DEFAULT '',
  skipped INTEGER NOT NULL DEFAULT 0, missing INTEGER NOT NULL DEFAULT 0,
  cwd TEXT, title TEXT, version TEXT, entrypoint TEXT, git_branch TEXT, permission_mode TEXT, first_ts INTEGER, last_ts INTEGER);
CREATE INDEX files_session ON files(session_id);
CREATE TABLE sessions(
  id TEXT PRIMARY KEY, project TEXT NOT NULL, cwd TEXT, title TEXT, first_ts INTEGER, last_ts INTEGER, version TEXT, entrypoint TEXT,
  git_branch TEXT, permission_mode TEXT, has_main INTEGER NOT NULL DEFAULT 1, prompts INTEGER NOT NULL DEFAULT 0, models TEXT NOT NULL DEFAULT '[]',
  api_calls INTEGER NOT NULL DEFAULT 0, input INTEGER NOT NULL DEFAULT 0, output INTEGER NOT NULL DEFAULT 0, cache_read INTEGER NOT NULL DEFAULT 0,
  cache_w5 INTEGER NOT NULL DEFAULT 0, cache_w1 INTEGER NOT NULL DEFAULT 0, cost REAL NOT NULL DEFAULT 0, unpriced INTEGER NOT NULL DEFAULT 0,
  reported_cost REAL, reported_runs INTEGER NOT NULL DEFAULT 0, tool_calls INTEGER NOT NULL DEFAULT 0, tool_errors INTEGER NOT NULL DEFAULT 0,
  tool_denied INTEGER NOT NULL DEFAULT 0, api_errors INTEGER NOT NULL DEFAULT 0, hook_failures INTEGER NOT NULL DEFAULT 0,
  compactions INTEGER NOT NULL DEFAULT 0, subagents INTEGER NOT NULL DEFAULT 0, risk INTEGER NOT NULL DEFAULT 0, findings INTEGER NOT NULL DEFAULT 0);
CREATE INDEX sessions_last ON sessions(last_ts);
CREATE TABLE api_calls(
  message_id TEXT PRIMARY KEY, file_id INTEGER NOT NULL, session_id TEXT NOT NULL, agent_id TEXT, ts INTEGER NOT NULL, model TEXT,
  input INTEGER NOT NULL, output INTEGER NOT NULL, cache_read INTEGER NOT NULL, cache_w5 INTEGER NOT NULL, cache_w1 INTEGER NOT NULL,
  cost REAL, skill TEXT, plugin TEXT, line INTEGER NOT NULL);
CREATE INDEX api_calls_session ON api_calls(session_id, ts);
CREATE INDEX api_calls_ts ON api_calls(ts);
CREATE INDEX api_calls_file ON api_calls(file_id);
CREATE TABLE tool_calls(
  id TEXT PRIMARY KEY, file_id INTEGER NOT NULL, session_id TEXT NOT NULL, agent_id TEXT, ts INTEGER NOT NULL, name TEXT NOT NULL,
  category TEXT NOT NULL, mcp_server TEXT, target TEXT NOT NULL DEFAULT '', cwd TEXT, status TEXT NOT NULL DEFAULT 'pending',
  denial_kind TEXT, perm_decision TEXT, perm_source TEXT, perm_reason TEXT, result_ts INTEGER, duration_ms INTEGER,
  line INTEGER NOT NULL, result_line INTEGER, skill TEXT);
CREATE INDEX tool_calls_session ON tool_calls(session_id, ts);
CREATE INDEX tool_calls_ts ON tool_calls(ts);
CREATE INDEX tool_calls_file ON tool_calls(file_id);
CREATE TABLE events(
  id INTEGER PRIMARY KEY, file_id INTEGER NOT NULL, session_id TEXT NOT NULL, agent_id TEXT, ts INTEGER NOT NULL, kind TEXT NOT NULL,
  name TEXT, status TEXT, duration_ms INTEGER, detail TEXT, a INTEGER, b INTEGER, line INTEGER NOT NULL);
CREATE INDEX events_session ON events(session_id, ts);
CREATE INDEX events_kind ON events(kind, ts);
CREATE INDEX events_file ON events(file_id);
CREATE TABLE prompts(file_id INTEGER NOT NULL, session_id TEXT NOT NULL, ts INTEGER NOT NULL, line INTEGER NOT NULL, origin TEXT NOT NULL, text TEXT NOT NULL);
CREATE INDEX prompts_session ON prompts(session_id, ts);
CREATE INDEX prompts_file ON prompts(file_id);
CREATE TABLE findings(
  id TEXT PRIMARY KEY, file_id INTEGER NOT NULL, session_id TEXT NOT NULL, tool_call_id TEXT, rule_id TEXT NOT NULL, severity TEXT NOT NULL,
  rank INTEGER NOT NULL, evidence TEXT NOT NULL, ts INTEGER NOT NULL, line INTEGER NOT NULL);
CREATE INDEX findings_session ON findings(session_id);
CREATE INDEX findings_ts ON findings(ts);
CREATE INDEX findings_file ON findings(file_id);
CREATE TABLE type_counts(file_id INTEGER NOT NULL, type TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY(file_id, type));
CREATE TABLE file_touch(file_id INTEGER NOT NULL, session_id TEXT NOT NULL, path TEXT NOT NULL, op TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY(file_id, path, op));
CREATE INDEX file_touch_session ON file_touch(session_id);
CREATE TABLE cost_state(file_id INTEGER NOT NULL, session_id TEXT NOT NULL, start_time INTEGER NOT NULL, total REAL NOT NULL, PRIMARY KEY(file_id, start_time));
CREATE TABLE links(file_id INTEGER NOT NULL, session_id TEXT NOT NULL, url TEXT NOT NULL, label TEXT, PRIMARY KEY(session_id, url));
CREATE VIRTUAL TABLE search USING fts5(text, session_id UNINDEXED, file_id UNINDEXED, line UNINDEXED, kind UNINDEXED, tokenize = 'unicode61');
`;

export type Db = DatabaseSync;

const within = (child: string, parent: string) => child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);

/** Creates the owner-only state directory and refuses unsafe locations (AUTHZ-05, DATA-06). */
export function prepareStateDir(stateDir: string, claudeHome: string): string {
  const dir = resolve(stateDir);
  const home = existsSync(claudeHome) ? realpathSync(claudeHome) : resolve(claudeHome);
  if (within(dir, home) || within(dir, resolve(claudeHome))) throw new Error('The Aegis state directory may not be inside the Claude home.');
  if (existsSync(dir)) {
    const st = lstatSync(dir);
    if (st.isSymbolicLink()) throw new Error('The Aegis state directory is a symbolic link; refusing to use it.');
    if (!st.isDirectory()) throw new Error('The Aegis state path is not a directory.');
    if (typeof process.getuid === 'function' && st.uid !== process.getuid()) throw new Error('The Aegis state directory is owned by another user.');
    if ((st.mode & 0o077) !== 0) chmodSync(dir, 0o700);
  } else {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  if (within(realpathSync(dir), home)) throw new Error('The Aegis state directory may not be inside the Claude home.');
  return dir;
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/** One Aegis process per state directory. Returns the function that releases the lock. */
export function lockStateDir(dir: string): () => void {
  const lock = join(dir, 'aegis.lock');
  if (existsSync(lock)) {
    const pid = Number(readFileSync(lock, 'utf8').trim());
    if (Number.isInteger(pid) && pid > 0 && pid !== process.pid && alive(pid)) {
      throw new Error(`Another Aegis process (pid ${pid}) is using this state directory.`);
    }
  }
  writeFileSync(lock, String(process.pid), { mode: 0o600 });
  return () => {
    try {
      if (readFileSync(lock, 'utf8').trim() === String(process.pid)) rmSync(lock);
    } catch {
      /* already gone */
    }
  };
}

export function openDb(dir: string): Db {
  const file = join(dir, 'index.db');
  const previousMask = process.umask(0o077);
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(file);
    db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA temp_store = MEMORY; PRAGMA foreign_keys = OFF;');
    db.exec(DURABLE);
    const row = db.prepare("SELECT value FROM meta WHERE key = 'schema'").get() as { value: string } | undefined;
    if (!row || Number(row.value) !== SCHEMA_VERSION) rebuild(db);
  } finally {
    process.umask(previousMask);
  }
  for (const name of ['index.db', 'index.db-wal', 'index.db-shm']) {
    try {
      chmodSync(join(dir, name), 0o600);
    } catch {
      /* not created yet */
    }
  }
  return db;
}

/** Drops and recreates every derived table. Triage, integrity alerts and re-pricing events are kept. */
export function rebuild(db: Db) {
  db.exec('BEGIN');
  try {
    for (const t of DERIVED_TABLES) db.exec(`DROP TABLE IF EXISTS ${t}`);
    db.exec(DERIVED);
    db.prepare("INSERT INTO meta(key, value) VALUES('schema', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(SCHEMA_VERSION));
    db.prepare("DELETE FROM meta WHERE key IN ('price_hash', 'price_rates')").run();
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export const getMeta = (db: Db, key: string): string | undefined =>
  (db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined)?.value;

export const setMeta = (db: Db, key: string, value: string) =>
  db.prepare('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
