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
import { mkdirSync } from 'node:fs';
import path from 'node:path';

import { AppError, ErrorCodes } from '../../shared/result.js';
import { MIGRATIONS } from './migrations/index.js';

export type Db = DatabaseSync;

/**
 * Open (or create) the database and bring the schema up to date.
 *
 * @param file Absolute path, or ':memory:' for tests.
 */
export function openDatabase(file: string): Db {
  if (file !== ':memory:') {
    mkdirSync(path.dirname(file), { recursive: true });
  }

  const db = new DatabaseSync(file);

  // WAL keeps readers from blocking the writer during a long sync, and survives
  // an abrupt process kill without corrupting the database. Not applicable to
  // in-memory databases.
  if (file !== ':memory:') {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
  }

  // Enforce foreign keys — SQLite defaults them off, which silently allows
  // orphaned messages to accumulate.
  db.exec('PRAGMA foreign_keys = ON');
  // Wait rather than fail immediately if another connection holds a lock.
  db.exec('PRAGMA busy_timeout = 5000');

  migrate(db);
  return db;
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
      db.exec('ROLLBACK');
      throw new AppError(
        ErrorCodes.DB_ERROR,
        `Database migration to version ${m.version} failed.`,
        { cause: err }
      );
    }
  }
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
