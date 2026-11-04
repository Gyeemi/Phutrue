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
