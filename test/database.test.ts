/**
 * Database: schema creation, migrations, constraints, FTS and transactions.
 *
 * These run against a real in-memory SQLite via node:sqlite — not a mock — so a
 * schema error fails the test rather than production.
 */

import { describe, expect, it } from 'vitest';
import { openDatabase, migrate, transaction, checkIntegrity } from '../src/main/db/database.js';
import { MIGRATIONS } from '../src/main/db/migrations/index.js';

function fresh() {
  return openDatabase(':memory:');
}

describe('openDatabase', () => {
  it('creates the schema and records the version', () => {
    const db = fresh();
    const row = db.prepare('SELECT version FROM schema_version').get() as { version: number };
    expect(row.version).toBe(MIGRATIONS[MIGRATIONS.length - 1]!.version);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r) => (r as { name: string }).name);

    for (const t of ['accounts', 'secrets', 'folders', 'messages', 'attachments', 'drafts', 'outbox', 'settings']) {
      expect(tables).toContain(t);
    }
  });

  it('enables foreign keys', () => {
    const db = fresh();
    const row = db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number };
    expect(row.foreign_keys).toBe(1);
  });

  it('is idempotent — a second migrate() is a no-op', () => {
    const db = fresh();
    expect(() => migrate(db)).not.toThrow();
    expect(() => migrate(db)).not.toThrow();
    const row = db.prepare('SELECT version FROM schema_version').get() as { version: number };
    expect(row.version).toBe(MIGRATIONS[MIGRATIONS.length - 1]!.version);
  });

  it('passes an integrity check', () => {
    expect(() => checkIntegrity(fresh())).not.toThrow();
  });
});

describe('constraints', () => {
  function seedAccount(db: ReturnType<typeof fresh>) {
    db.prepare(
      `INSERT INTO accounts (label,email,display_name,auth_kind,imap_host,imap_port,smtp_host,smtp_port,created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`
    ).run('Work', 'a@example.com', 'A', 'password', 'imap.example.com', 993, 'smtp.example.com', 465, Date.now());
    return Number((db.prepare('SELECT id FROM accounts').get() as { id: number }).id);
  }

  it('rejects a duplicate email', () => {
    const db = fresh();
    seedAccount(db);
    expect(() => seedAccount(db)).toThrow();
  });

  it('cascades deletes from account to folders and messages', () => {
    const db = fresh();
    const accountId = seedAccount(db);

    db.prepare(
      `INSERT INTO folders (account_id,path,name,role) VALUES (?,?,?,?)`
    ).run(accountId, 'INBOX', 'Inbox', 'inbox');
    const folderId = Number((db.prepare('SELECT id FROM folders').get() as { id: number }).id);

    db.prepare(
      `INSERT INTO messages (account_id,folder_id,uid,subject,date) VALUES (?,?,?,?,?)`
    ).run(accountId, folderId, '1', 'Hello', Date.now());

    expect((db.prepare('SELECT COUNT(*) c FROM messages').get() as { c: number }).c).toBe(1);

    db.prepare('DELETE FROM accounts WHERE id = ?').run(accountId);

    expect((db.prepare('SELECT COUNT(*) c FROM folders').get() as { c: number }).c).toBe(0);
    expect((db.prepare('SELECT COUNT(*) c FROM messages').get() as { c: number }).c).toBe(0);
  });

  it('prevents duplicate (folder, uid) messages', () => {
    const db = fresh();
    const accountId = seedAccount(db);
    db.prepare(`INSERT INTO folders (account_id,path,name) VALUES (?,?,?)`).run(accountId, 'INBOX', 'Inbox');
    const folderId = Number((db.prepare('SELECT id FROM folders').get() as { id: number }).id);

    const insert = () =>
      db.prepare(`INSERT INTO messages (account_id,folder_id,uid,subject,date) VALUES (?,?,?,?,?)`)
        .run(accountId, folderId, '42', 'dup', Date.now());

    insert();
    expect(insert).toThrow(); // unique index is what stops sync duplicates
  });

  it('rejects an invalid sync_state', () => {
    const db = fresh();
    expect(() =>
      db.prepare(
        `INSERT INTO accounts (label,email,display_name,auth_kind,imap_host,imap_port,smtp_host,smtp_port,sync_state,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`
      ).run('W', 'b@example.com', '', 'password', 'h', 993, 'h', 465, 'bogus', Date.now())
    ).toThrow();
  });

  it('rejects an invalid folder role', () => {
    const db = fresh();
    const accountId = seedAccount(db);
    expect(() =>
      db.prepare(`INSERT INTO folders (account_id,path,name,role) VALUES (?,?,?,?)`)
        .run(accountId, 'X', 'X', 'nonsense')
    ).toThrow();
  });
});

describe('transactions', () => {
  it('rolls back every statement when one throws', () => {
    const db = fresh();
    const insert = db.prepare(
      `INSERT INTO settings (key,value) VALUES (?,?)`
    );

    expect(() =>
      transaction(db, () => {
        insert.run('a', '1');
        insert.run('b', '2');
        throw new Error('boom');
      })
    ).toThrow('boom');

    // Neither write survived.
    expect((db.prepare('SELECT COUNT(*) c FROM settings').get() as { c: number }).c).toBe(0);
  });

  it('commits when the body succeeds', () => {
    const db = fresh();
    transaction(db, () => {
      db.prepare('INSERT INTO settings (key,value) VALUES (?,?)').run('theme', 'dark');
    });
    const row = db.prepare('SELECT value FROM settings WHERE key=?').get('theme') as { value: string };
    expect(row.value).toBe('dark');
  });
});

describe('full-text search', () => {
  it('indexes inserts and removes on delete via triggers', () => {
    const db = fresh();
    const accountId = Number(
      (db.prepare(
        `INSERT INTO accounts (label,email,display_name,auth_kind,imap_host,imap_port,smtp_host,smtp_port,created_at)
         VALUES ('W','c@example.com','','password','h',993,'h',465,0)`
      ).run(), db.prepare('SELECT id FROM accounts').get() as { id: number }).id
    );
    db.prepare('INSERT INTO folders (account_id,path,name) VALUES (?,?,?)').run(accountId, 'INBOX', 'Inbox');
    const folderId = Number((db.prepare('SELECT id FROM folders').get() as { id: number }).id);

    db.prepare(
      `INSERT INTO messages (account_id,folder_id,uid,subject,from_address,body_text,date)
       VALUES (?,?,?,?,?,?,?)`
    ).run(accountId, folderId, '1', 'Quarterly invoice', 'billing@vendor.test', 'Please find the invoice attached.', Date.now());

    const hit = db
      .prepare("SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'invoice'")
      .all();
    expect(hit.length).toBe(1);

    const bodyHit = db
      .prepare("SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'attached'")
      .all();
    expect(bodyHit.length).toBe(1);

    db.prepare('DELETE FROM messages WHERE uid = ?').run('1');
    const afterDelete = db
      .prepare("SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'invoice'")
      .all();
    expect(afterDelete.length).toBe(0);
  });

  it('updates the index when a message is edited', () => {
    const db = fresh();
    const accountId = Number(
      (db.prepare(
        `INSERT INTO accounts (label,email,display_name,auth_kind,imap_host,imap_port,smtp_host,smtp_port,created_at)
         VALUES ('W','d@example.com','','password','h',993,'h',465,0)`
      ).run(), db.prepare('SELECT id FROM accounts').get() as { id: number }).id
    );
    db.prepare('INSERT INTO folders (account_id,path,name) VALUES (?,?,?)').run(accountId, 'INBOX', 'Inbox');
    const folderId = Number((db.prepare('SELECT id FROM folders').get() as { id: number }).id);

    db.prepare(`INSERT INTO messages (account_id,folder_id,uid,subject,date) VALUES (?,?,?,?,?)`)
      .run(accountId, folderId, '1', 'alpha', Date.now());

    db.prepare('UPDATE messages SET subject = ? WHERE uid = ?').run('beta', '1');

    expect(db.prepare("SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'alpha'").all().length).toBe(0);
    expect(db.prepare("SELECT rowid FROM messages_fts WHERE messages_fts MATCH 'beta'").all().length).toBe(1);
  });
});

/* ------------------------------------------------------------------ *
 * Starting on an unusable database
 *
 * Every test before this one used `:memory:` or a directory that did not exist,
 * which means they all started from nothing. A real installation does not always
 * do that. The first run of the installer reached users whose AppData already
 * held a `phutrue.db`, and it failed to start - with a message that named the
 * version and the path but not the cause, so nothing could be concluded from it.
 * ------------------------------------------------------------------ */

import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const tmpDb = (): { dir: string; file: string } => {
  const dir = mkdtempSync(path.join(tmpdir(), 'phutrue-db-'));
  return { dir, file: path.join(dir, 'phutrue.db') };
};

describe('a database left half-migrated', () => {
  /**
   * The reported bug, in full.
   *
   * A user's third install failed with "table accounts already exists" while
   * `schema_version` still said 0. That is a database where some of migration 1
   * ran and the version was never recorded. Migrations used plain CREATE TABLE,
   * so re-running them re-created an object that was already there and threw -
   * every launch, forever.
   */

  it('finishes the migration in place, keeping the file and any data', () => {
    const { dir, file } = tmpDb();
    try {
      // Partially applied migration 1, with a row already in it: this is data a
      // user would not want thrown away, and no version recorded.
      const shell = new DatabaseSync(file);
      shell.exec('CREATE TABLE accounts (id INTEGER PRIMARY KEY AUTOINCREMENT, '
        + 'label TEXT NOT NULL, email TEXT NOT NULL, display_name TEXT NOT NULL DEFAULT \'\', '
        + 'auth_kind TEXT NOT NULL, oauth_provider TEXT, imap_host TEXT NOT NULL, '
        + 'imap_port INTEGER NOT NULL, imap_secure INTEGER NOT NULL DEFAULT 1, '
        + 'smtp_host TEXT NOT NULL, smtp_port INTEGER NOT NULL, '
        + 'smtp_secure INTEGER NOT NULL DEFAULT 1, smtp_user TEXT, '
        + 'sync_state TEXT NOT NULL DEFAULT \'idle\', last_error TEXT, '
        + 'last_synced_at INTEGER, created_at INTEGER NOT NULL)');
      shell.exec("INSERT INTO accounts (label, email, auth_kind, imap_host, imap_port, "
        + "smtp_host, smtp_port, created_at) VALUES ('Old', 'old@example.com', 'password', "
        + "'imap.example.com', 993, 'smtp.example.com', 587, 1)");
      shell.exec('CREATE TABLE schema_version (version INTEGER NOT NULL)');
      shell.exec('INSERT INTO schema_version (version) VALUES (0)');
      shell.close();

      let moved = '';
      const db = openDatabase(file, { onQuarantine: (to) => { moved = to; } });

      // The row survived: the fix completes the schema rather than starting over.
      expect(db.prepare('SELECT email FROM accounts').get()).toEqual({
        email: 'old@example.com',
      });
      // And the schema is now complete and versioned.
      expect(db.prepare('SELECT MAX(version) AS v FROM schema_version').get()).toEqual({
        v: MIGRATIONS[MIGRATIONS.length - 1]!.version,
      });
      expect(db.prepare('SELECT COUNT(*) AS n FROM messages').get()).toEqual({ n: 0 });
      db.close();

      // Nothing was moved aside, because nothing had to be.
      expect(moved).toBe('');
      expect(readdirSync(dir).some((f) => f.includes('unusable'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('runs every migration twice without error', () => {
    // The property that makes recovery possible at all. If this ever regresses,
    // a half-applied migration becomes fatal again.
    const db = openDatabase(':memory:');
    expect(() => migrate(db)).not.toThrow();
    expect(() => migrate(db)).not.toThrow();
    db.close();
  });

  it('accepts a database that has every table but no version row', () => {
    const { dir, file } = tmpDb();
    try {
      // Schema complete, version marker lost: an interrupted UPDATE, or a file
      // restored from a partial backup.
      const shell = new DatabaseSync(file);
      shell.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
      shell.exec('CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT)');
      shell.close();

      const db = openDatabase(file);
      expect(db.prepare('SELECT MAX(version) AS v FROM schema_version').get()).toEqual({
        v: MIGRATIONS[MIGRATIONS.length - 1]!.version,
      });
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('a version marker that was lost', () => {
  it('re-migrates over a complete schema without touching the data', () => {
    /*
     * The reported failure, stated as a property: a database whose schema is
     * up to date but whose version was never recorded - an interrupted UPDATE,
     * a file restored from a partial backup, a copy taken mid-write - must still
     * start, and must still have its rows.
     *
     * Migrations used to be written as plain CREATE TABLE, so this threw "table
     * accounts already exists" on every launch. Making the DDL idempotent is
     * what fixes it; this test is what stops that regressing.
     */
    const { dir, file } = tmpDb();
    try {
      const first = openDatabase(file);
      first
        .prepare(
          `INSERT INTO accounts (label, email, auth_kind, imap_host, imap_port,
             smtp_host, smtp_port, created_at)
           VALUES ('Work', 'work@example.com', 'password', 'imap.example.com', 993,
             'smtp.example.com', 587, 1)`
        )
        .run();
      // Simulate the lost marker while the schema itself stays intact.
      first.prepare('UPDATE schema_version SET version = 0').run();
      first.close();

      const second = openDatabase(file);
      expect(second.prepare('SELECT email FROM accounts').get()).toEqual({
        email: 'work@example.com',
      });
      expect(second.prepare('SELECT MAX(version) AS v FROM schema_version').get()).toEqual({
        v: MIGRATIONS[MIGRATIONS.length - 1]!.version,
      });
      second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('a database that contains real data is never touched', () => {
  it('leaves accounts alone and refuses to start', () => {
    const { dir, file } = tmpDb();
    try {
      const shell = new DatabaseSync(file);
      shell.exec("CREATE TABLE accounts (id INTEGER PRIMARY KEY, email TEXT)");
      shell.exec("INSERT INTO accounts (email) VALUES ('someone@example.com')");
      shell.close();

      // Refuses rather than quarantines: discarding an account row silently is
      // exactly the behaviour this project forbids.
      expect(() => openDatabase(file)).toThrow(/left untouched/i);
      // The user is told both what went wrong and how to get out of it.
      expect(() => openDatabase(file)).toThrow(/move this file out of the way/i);

      // And the row is still there afterwards.
      const check = new DatabaseSync(file, { readOnly: true });
      expect(check.prepare('SELECT email FROM accounts').get()).toEqual({
        email: 'someone@example.com',
      });
      check.close();
      expect(readdirSync(dir).some((f) => f.includes('unusable'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('a normal start is unaffected by the recovery path', () => {
  it('creates a fresh database on a clean directory', () => {
    const { dir, file } = tmpDb();
    try {
      const seen: string[] = [];
      const db = openDatabase(file, { onQuarantine: (to) => seen.push(to) });
      expect(db.prepare('SELECT MAX(version) AS v FROM schema_version').get()).toEqual({
        v: MIGRATIONS[MIGRATIONS.length - 1]!.version,
      });
      db.close();
      // Nothing to recover means no dialog.
      expect(seen).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reopens an already-migrated database without moving it', () => {
    const { dir, file } = tmpDb();
    try {
      openDatabase(file).close();
      const seen: string[] = [];
      const db = openDatabase(file, { onQuarantine: (to) => seen.push(to) });
      db.close();
      expect(seen).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the failure message names the cause', () => {
  it('includes the SQLite complaint, not just the version', () => {
    // `secrets` collides with migration 1, so the migration fails for a reason
    // SQLite names - and the message must repeat that name rather than replace
    // it with "migration failed".
    const { dir, file } = tmpDb();
    try {
      const shell = new DatabaseSync(file);
      shell.exec('CREATE TABLE secrets (ref TEXT PRIMARY KEY)');
      shell.exec("INSERT INTO secrets (ref) VALUES ('keep-me')");
      shell.close();

      let message = '';
      try {
        openDatabase(file);
      } catch (err) {
        message = (err as Error).message;
      }

      // The message names the actual problem - a table whose columns do not
      // match - rather than a raw "table already exists" from a CREATE.
      expect(message).toMatch(/does not match the expected schema|missing/i);
      expect(message).toMatch(/accounts|secrets/);
      rmSync(dir, { recursive: true, force: true });
    } catch (outer) {
      throw outer;
    }
  });

  it('keeps a database that holds a secret, rather than rebuilding it', () => {
    // A `secrets` row can be a credential. It is user data even with no account
    // rows, so the file must survive untouched.
    const { dir, file } = tmpDb();
    try {
      const shell = new DatabaseSync(file);
      shell.exec('CREATE TABLE secrets (ref TEXT PRIMARY KEY)');
      shell.exec("INSERT INTO secrets (ref) VALUES ('keep-me')");
      shell.close();

      expect(() => openDatabase(file)).toThrow();

      const check = new DatabaseSync(file, { readOnly: true });
      expect(check.prepare('SELECT ref FROM secrets').get()).toEqual({ ref: 'keep-me' });
      check.close();
      expect(readdirSync(dir).some((f) => f.includes('unusable'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('a table that exists with the wrong shape', () => {
  it('is replaced when it is empty, so the app ends up correct', () => {
    const { dir, file } = tmpDb();
    try {
      // IF NOT EXISTS skips an existing table, so a truncated `accounts` would
      // otherwise slip through and fail on the first query instead of at start.
      const shell = new DatabaseSync(file);
      shell.exec('CREATE TABLE accounts (id INTEGER PRIMARY KEY, email TEXT)');
      shell.exec('CREATE TABLE schema_version (version INTEGER NOT NULL)');
      shell.exec('INSERT INTO schema_version (version) VALUES (0)');
      shell.close();

      let moved = '';
      const db = openDatabase(file, { onQuarantine: (to) => { moved = to; } });

      // The wrong table is gone and the right one is there.
      const cols = (db.prepare('PRAGMA table_info(accounts)').all() as { name: string }[]).map(
        (c) => c.name
      );
      expect(cols).toContain('sync_state');
      expect(cols).toContain('imap_host');
      db.close();

      // Nothing was deleted: the old file is on disk under another name.
      expect(moved).toContain('unusable');
      expect(readdirSync(dir).some((f) => f.includes('unusable'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is refused when the table holds rows', () => {
    const { dir, file } = tmpDb();
    try {
      const shell = new DatabaseSync(file);
      shell.exec('CREATE TABLE accounts (id INTEGER PRIMARY KEY, email TEXT)');
      shell.exec("INSERT INTO accounts (email) VALUES ('keep@example.com')");
      shell.exec('CREATE TABLE schema_version (version INTEGER NOT NULL)');
      shell.exec('INSERT INTO schema_version (version) VALUES (0)');
      shell.close();

      // A row exists, so the file is not ours to replace. The message must say
      // that rather than quietly discarding an account.
      expect(() => openDatabase(file)).toThrow(/left untouched/i);

      const check = new DatabaseSync(file, { readOnly: true });
      expect(check.prepare('SELECT email FROM accounts').get()).toEqual({
        email: 'keep@example.com',
      });
      check.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('a schema that claims a version but has lost its tables', () => {
  it('is rebuilt, because it holds nothing', () => {
    const { dir, file } = tmpDb();
    try {
      // Version 1 recorded, but `messages` was never created: the state a
      // half-applied migration or a mid-write file copy leaves behind. Reading
      // schema_version alone would call this healthy.
      const shell = new DatabaseSync(file);
      shell.exec('CREATE TABLE schema_version (version INTEGER NOT NULL)');
      shell.exec('INSERT INTO schema_version (version) VALUES (1)');
      shell.exec('CREATE TABLE accounts (id INTEGER PRIMARY KEY)');
      shell.close();

      const db = openDatabase(file);
      // Rebuilt to a complete schema rather than handed to the user broken.
      expect(db.prepare('SELECT COUNT(*) AS n FROM messages').get()).toEqual({ n: 0 });
      expect(db.prepare('SELECT MAX(version) AS v FROM schema_version').get()).toEqual({
        v: MIGRATIONS[MIGRATIONS.length - 1]!.version,
      });
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is refused when it holds data, rather than silently replaced', () => {
    const { dir, file } = tmpDb();
    try {
      const shell = new DatabaseSync(file);
      shell.exec('CREATE TABLE schema_version (version INTEGER NOT NULL)');
      shell.exec('INSERT INTO schema_version (version) VALUES (1)');
      shell.exec('CREATE TABLE accounts (id INTEGER PRIMARY KEY, email TEXT)');
      shell.exec("INSERT INTO accounts (email) VALUES ('keep@example.com')");
      shell.close();

      expect(() => openDatabase(file)).toThrow(/left untouched/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
