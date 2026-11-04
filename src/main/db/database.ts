/**
 * SQLite access via Node's built-in `node:sqlite`.
 *
 * Why the built-in module rather than a native addon:
 *   Electron 45.2.1 bundles Node 24.22.1, which ships `node:sqlite`
 *   (SQLite 3.51.3). Using it means Phutrue has ZERO native modules — no
 *   electron-rebuild step, no ABI mismatch between the test runner's Node and
 *   Electron's Node, and no prebuilt-binary download at install time.
 *
 * Concurrency model: `node:sqlite` is synchronous. That is fine here because
 * every statement is bounded and runs in the main process, but it means callers
 * must never issue an unbounded query. All list operations are paginated and
 * indexed.
 */

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, renameSync } from 'node:fs';
import path from 'node:path';

import { AppError, ErrorCodes } from '../../shared/result.js';
import { MIGRATIONS } from './migrations/index.js';

export type Db = DatabaseSync;

/**
 * Open (or create) the database and bring the schema up to date.
 *
 * @param file Absolute path, or ':memory:' for tests.
 */
export function openDatabase(
  file: string,
  options: { onQuarantine?: (movedTo: string) => void } = {}
): Db {
  if (file === ':memory:') {
    const mem = new DatabaseSync(file);
    mem.exec('PRAGMA foreign_keys = ON');
    migrate(mem);
    return mem;
  }

  mkdirSync(path.dirname(file), { recursive: true });

  /*
   * Recover from a database that a failed migration left behind.
   *
   * A migration runs inside a transaction, so its schema rolls back - but the
   * FILE remains, and `schema_version` is still 0. On the next launch version 1
   * runs again and, because it uses plain CREATE TABLE, collides with whatever
   * survived. The result is an installation that cannot start, ever, with no
   * in-app way out: the user would have to know to go and delete a file under
   * AppData.
   *
   * Recovery only happens when the database provably holds nothing: no accounts,
   * no messages, no drafts, no queued mail, no secrets. With real data present
   * the error is raised and the file is left exactly where it is.
   *
   * The connection is closed on every path that fails. This matters on Windows,
   * which will not delete or rename a file while a handle is open: a leaked
   * connection turns one failed start into a database that is locked for the
   * rest of the session.
   */
  const open = (): Db => {
    const fresh = new DatabaseSync(file);

    // WAL keeps readers from blocking the writer during a long sync, and
    // survives an abrupt process kill without corrupting the database.
    fresh.exec('PRAGMA journal_mode = WAL');
    fresh.exec('PRAGMA synchronous = NORMAL');
    // Enforce foreign keys — SQLite defaults them off, which silently allows
    // orphaned messages to accumulate.
    fresh.exec('PRAGMA foreign_keys = ON');
    // Wait rather than fail immediately if another connection holds a lock.
    fresh.exec('PRAGMA busy_timeout = 5000');
    return fresh;
  };

  let db: Db | null = null;
  try {
    db = open();
    migrate(db);

    // A schema that claims a version but has lost its tables cannot be used.
    // This is a real failure mode; it must not be discovered by the user later.
    verifySchema(db);
    return db;
  } catch (err) {
    db?.close();

    /*
     * If it failed because the file cannot be renamed, the connection handle is
     * gone but the error is still the user's problem - so rethrow with context
     * rather than trying to recover a second time.
     */
    if (!holdsNoUserData(file)) {
      /*
       * There is mail or an account in here, so nothing is moved or deleted.
       * Say that plainly and give the user the one thing that resolves it,
       * instead of leaving them with a raw SQLite string and no next step.
       */
      const cause = err instanceof AppError ? err.safeMessage : describeDbError(err);
      throw new AppError(
        ErrorCodes.DB_ERROR,
        `Existing data was left untouched, but it could not be upgraded: ${cause}\n\n` +
          `The file has not been changed. To start over, move this file out of ` +
          `the way and reopen Phutrue:\n${file}`,
        { cause: err }
      );
    }

    const movedTo = quarantine(file);
    // Reported rather than swallowed: a user whose file was set aside needs to
    // know, and a support report needs the path.
    options.onQuarantine?.(movedTo);

    const rebuilt = open();
    try {
      migrate(rebuilt);
      verifySchema(rebuilt);
    } catch (again) {
      rebuilt.close();
      throw again;
    }
    return rebuilt;
  }
}

/**
 * Confirm the schema is complete, not merely that the file opened.
 *
 * A database can report a schema version while missing the tables that version
 * promised - a half-applied migration, or a file copied mid-write. Reading
 * `schema_version` alone would not notice, and the user would meet the problem
 * as a crash on the first query instead of a clear message at start-up.
 */
const REQUIRED_TABLES = [
  'accounts', 'secrets', 'folders', 'messages', 'attachments',
  'drafts', 'outbox', 'settings', 'schema_version',
] as const;

export function verifySchema(db: Db): void {
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all() as { name: string }[];
  const present = new Set(rows.map((r) => r.name));

  const missing = REQUIRED_TABLES.filter((t) => !present.has(t));
  if (missing.length > 0) {
    throw new AppError(
      ErrorCodes.DB_ERROR,
      `The local database is incomplete: missing ${missing.join(', ')}.`
    );
  }

  const { v } = db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as {
    v: number | null;
  };
  const latest = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;
  if (v !== latest) {
    throw new AppError(
      ErrorCodes.DB_ERROR,
      `The local database is at version ${String(v)}, but this build needs ${latest}.`
    );
  }
}

/**
 * Does this database provably hold nothing a user would miss?
 *
 * Deliberately conservative: any unreadable state, and any table that cannot be
 * inspected, counts as "has content". The only thing this may return true for is
 * a database with no accounts, no messages, no drafts and no queued mail.
 */
function holdsNoUserData(file: string): boolean {
  let probe: DatabaseSync | null = null;
  try {
    probe = new DatabaseSync(file, { readOnly: true });
    const tables = (
      probe.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]
    ).map((t) => t.name);

    for (const table of ['accounts', 'messages', 'drafts', 'outbox']) {
      if (!tables.includes(table)) continue;
      const row = probe.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
      if (row.n > 0) return false;
    }
    // secrets without accounts can still be an encrypted credential worth keeping.
    if (tables.includes('secrets')) {
      const row = probe.prepare('SELECT COUNT(*) AS n FROM secrets').get() as { n: number };
      if (row.n > 0) return false;
    }
    return true;
  } catch {
    // Cannot tell. Treat as precious.
    return false;
  } finally {
    probe?.close();
  }
}

/**
 * Move an unusable database aside so the application can start.
 *
 * Renamed, never deleted: if this ever runs when it should not, the file is
 * still in the same directory, and the new name is shown to the user.
 */
function quarantine(file: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = `${file}.unusable-${stamp}`;
  renameSync(file, target);
  // The WAL and shared-memory companions belong to the file that just moved.
  for (const suffix of ['-wal', '-shm']) {
    try { renameSync(file + suffix, target + suffix); } catch { /* not present */ }
  }
  return target;
}

/** Current schema version, or 0 for a fresh database. */
function schemaVersion(db: Db): number {
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
  const row = db.prepare('SELECT version FROM schema_version LIMIT 1').get() as
    | { version: number }
    | undefined;
  if (!row) {
    db.prepare('INSERT INTO schema_version (version) VALUES (0)').run();
    return 0;
  }
  return row.version;
}

/**
 * Apply every migration newer than the current version, in order, inside a
 * transaction each. Forward-only: there is no down-migration, which matches the
 * rule that user data is never silently destroyed.
 */
export function migrate(db: Db): void {
  let current = schemaVersion(db);

  for (const m of MIGRATIONS) {
    if (m.version <= current) continue;

    db.exec('BEGIN');
    try {
      m.up(db);
      db.prepare('UPDATE schema_version SET version = ?').run(m.version);
      db.exec('COMMIT');
      current = m.version;
    } catch (err) {
      try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }

      /*
       * The reason has to be in the message, not only in `cause`.
       *
       * This code previously reported "Database migration to version N failed."
       * and nothing else. A user hit it on a fresh install: the dialog named the
       * version and the file path but not the actual SQLite complaint, so the
       * cause could not be determined from the app, only guessed at. SQLite's
       * messages are safe to show - they carry no user data, only schema and
       * file names - and without one this error is undiagnosable.
       */
      throw new AppError(
        ErrorCodes.DB_ERROR,
        `Database migration to version ${m.version} (${m.name}) failed: ${describeDbError(err)}`,
        { cause: err }
      );
    }
  }
}

/**
 * A one-line description of a failure raised by SQLite.
 *
 * Includes the status code, because `ERR_SQLITE_ERROR` alone does not
 * distinguish "your database has an unexpected table" from "the disk is full" -
 * and those need very different responses from a user.
 */
export function describeDbError(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    const suffix = typeof code === 'string' && code !== '' ? ` [${code}]` : '';
    return `${err.message}${suffix}`;
  }
  return String(err);
}

/** Wrap a set of statements in a transaction. Rolls back on any throw. */
export function transaction<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* already rolled back */ }
    throw err;
  }
}

/** Convenience for reading a single row that must exist. */
export function requireRow<T>(row: T | undefined, what: string): T {
  if (row === undefined) {
    throw new AppError(ErrorCodes.NOT_FOUND, `${what} not found.`);
  }
  return row;
}

/** Current unix ms. */
export const now = (): number => Date.now();

/**
 * Health check used by tests and the about screen. Throws if the database is
 * not usable.
 */
export function checkIntegrity(db: Db): void {
  const row = db.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
  if (row.integrity_check !== 'ok') {
    throw new AppError(ErrorCodes.DB_ERROR, 'Database integrity check failed.');
  }
}

/* ------------------------------------------------------------------ *
 * Typed row access
 *
 * node:sqlite returns `Record<string, SQLOutputValue>`. Rather than casting at
 * every call site (which hides real mistakes), these two helpers localise the
 * cast and keep the rest of the code fully typed.
 * ------------------------------------------------------------------ */

/** Run a query and return typed rows. */
export function allRows<T>(db: Db, sql: string, ...params: Array<string | number | null>): T[] {
  return db.prepare(sql).all(...params) as unknown as T[];
}

/** Run a query expected to return at most one row. */
export function oneRow<T>(db: Db, sql: string, ...params: Array<string | number | null>): T | undefined {
  return db.prepare(sql).get(...params) as unknown as T | undefined;
}

/** Execute a statement and return the number of affected rows. */
export function run(db: Db, sql: string, ...params: Array<string | number | null>): number {
  return Number(db.prepare(sql).run(...params).changes);
}
