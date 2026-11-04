/**
 * Forward-only schema migrations.
 *
 * Rules:
 *   - Never edit a migration that has shipped; add a new one.
 *   - Every migration must be safe to run on a database with user data in it.
 *   - Destructive changes (dropping a column or table holding user data) require
 *     an explicit data-preserving step, never a bare DROP.
 */

import type { DatabaseSync } from 'node:sqlite';

export interface Migration {
  version: number;
  name: string;
  up(db: DatabaseSync): void;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial schema',
    up(db) {
      /* ---- accounts ------------------------------------------- */
      db.exec(`
        CREATE TABLE accounts (
          id             INTEGER PRIMARY KEY AUTOINCREMENT,
          label          TEXT    NOT NULL,
          email          TEXT    NOT NULL,
          display_name   TEXT    NOT NULL DEFAULT '',
          auth_kind      TEXT    NOT NULL CHECK (auth_kind IN ('password','oauth2')),
          oauth_provider TEXT    CHECK (oauth_provider IN ('google','microsoft')),
          imap_host      TEXT    NOT NULL,
          imap_port      INTEGER NOT NULL,
          imap_secure    INTEGER NOT NULL DEFAULT 1,
          smtp_host      TEXT    NOT NULL,
          smtp_port      INTEGER NOT NULL,
          smtp_secure    INTEGER NOT NULL DEFAULT 1,
          smtp_user      TEXT,
          sync_state     TEXT    NOT NULL DEFAULT 'idle'
                                 CHECK (sync_state IN ('idle','syncing','offline','error')),
          last_error     TEXT,
          last_synced_at INTEGER,
          created_at     INTEGER NOT NULL
        );
      `);
      db.exec('CREATE UNIQUE INDEX idx_accounts_email ON accounts(email)');

      /* ---- secrets -------------------------------------------- */
      // Only DPAPI-wrapped ciphertext ever lands here. There is no plaintext
      // column, by design.
      db.exec(`
        CREATE TABLE secrets (
          ref        TEXT PRIMARY KEY,
          ciphertext BLOB    NOT NULL,
          updated_at INTEGER NOT NULL
        );
      `);

      /* ---- folders -------------------------------------------- */
      db.exec(`
        CREATE TABLE folders (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          account_id   INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          path         TEXT    NOT NULL,
          name         TEXT    NOT NULL,
          role         TEXT    NOT NULL DEFAULT 'other'
                               CHECK (role IN ('inbox','sent','drafts','archive','spam','trash','other')),
          delimiter    TEXT    NOT NULL DEFAULT '/',
          unread_count INTEGER NOT NULL DEFAULT 0,
          total_count  INTEGER NOT NULL DEFAULT 0,
          uid_validity TEXT,
          uid_next     TEXT,
          sort_order   INTEGER NOT NULL DEFAULT 0
        );
      `);
      db.exec('CREATE UNIQUE INDEX idx_folders_account_path ON folders(account_id, path)');
      db.exec('CREATE INDEX idx_folders_account ON folders(account_id, sort_order)');

      /* ---- messages ------------------------------------------- */
      db.exec(`
        CREATE TABLE messages (
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          account_id      INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          folder_id       INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
          uid             TEXT    NOT NULL,
          message_id      TEXT,
          subject         TEXT    NOT NULL DEFAULT '',
          from_name       TEXT    NOT NULL DEFAULT '',
          from_address    TEXT    NOT NULL DEFAULT '',
          to_addresses    TEXT    NOT NULL DEFAULT '',
          cc_addresses    TEXT    NOT NULL DEFAULT '',
          bcc_addresses   TEXT    NOT NULL DEFAULT '',
          reply_to        TEXT,
          snippet         TEXT    NOT NULL DEFAULT '',
          body_text       TEXT,
          body_html_raw   TEXT,
          date            INTEGER NOT NULL,
          is_read         INTEGER NOT NULL DEFAULT 0,
          is_starred      INTEGER NOT NULL DEFAULT 0,
          has_attachments INTEGER NOT NULL DEFAULT 0,
          size            INTEGER NOT NULL DEFAULT 0,
          in_reply_to     TEXT,
          refs            TEXT,
          body_fetched    INTEGER NOT NULL DEFAULT 0
        );
      `);
      // One message per UID per folder — prevents duplicates from overlapping
      // sync runs.
      db.exec('CREATE UNIQUE INDEX idx_messages_uid ON messages(folder_id, uid)');
      db.exec('CREATE INDEX idx_messages_folder_date ON messages(folder_id, date DESC)');
      db.exec('CREATE INDEX idx_messages_account ON messages(account_id)');
      db.exec('CREATE INDEX idx_messages_unread ON messages(folder_id, is_read, date DESC)');
      db.exec('CREATE INDEX idx_messages_msgid ON messages(message_id)');

      /* ---- attachments ---------------------------------------- */
      db.exec(`
        CREATE TABLE attachments (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
          content_id TEXT,
          filename   TEXT    NOT NULL,
          mime_type  TEXT    NOT NULL,
          size       INTEGER NOT NULL DEFAULT 0,
          cached_path TEXT,
          is_inline  INTEGER NOT NULL DEFAULT 0
        );
      `);
      db.exec('CREATE UNIQUE INDEX idx_attachments_unique ON attachments(message_id, filename, COALESCE(content_id, \'\'))');

      /* ---- drafts --------------------------------------------- */
      db.exec(`
        CREATE TABLE drafts (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          folder_id  INTEGER REFERENCES folders(id) ON DELETE SET NULL,
          to_json    TEXT NOT NULL DEFAULT '[]',
          cc_json    TEXT NOT NULL DEFAULT '[]',
          bcc_json   TEXT NOT NULL DEFAULT '[]',
          subject    TEXT NOT NULL DEFAULT '',
          html       TEXT NOT NULL DEFAULT '',
          attach_json TEXT NOT NULL DEFAULT '[]',
          in_reply_to TEXT,
          refs_json  TEXT NOT NULL DEFAULT '[]',
          updated_at INTEGER NOT NULL
        );
      `);
      db.exec('CREATE INDEX idx_drafts_account ON drafts(account_id, updated_at DESC)');

      /* ---- outbox --------------------------------------------- */
      // Durable send queue. A row exists until the SMTP server has accepted the
      // message, so a crash mid-send cannot lose or duplicate mail.
      db.exec(`
        CREATE TABLE outbox (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          account_id  INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
          payload     TEXT NOT NULL,
          attempts    INTEGER NOT NULL DEFAULT 0,
          last_error  TEXT,
          created_at  INTEGER NOT NULL,
          sent_at     INTEGER
        );
      `);
      db.exec('CREATE INDEX idx_outbox_pending ON outbox(account_id, sent_at)');

      /* ---- settings ------------------------------------------- */
      db.exec(`
        CREATE TABLE settings (
          key   TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
      `);

      /* ---- full-text search ----------------------------------- */
      // External-content FTS5 over messages. Kept in sync by triggers so search
      // cannot drift from the table it indexes.
      db.exec(`
        CREATE VIRTUAL TABLE messages_fts USING fts5(
          subject, from_address, from_name, body_text,
          content='messages',
          content_rowid='id',
          tokenize='unicode61 remove_diacritics 2'
        );
      `);
      db.exec(`
        CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
          INSERT INTO messages_fts(rowid, subject, from_address, from_name, body_text)
          VALUES (new.id, new.subject, new.from_address, new.from_name, COALESCE(new.body_text,''));
        END;
      `);
      db.exec(`
        CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
          INSERT INTO messages_fts(messages_fts, rowid, subject, from_address, from_name, body_text)
          VALUES ('delete', old.id, old.subject, old.from_address, old.from_name, COALESCE(old.body_text,''));
        END;
      `);
      db.exec(`
        CREATE TRIGGER messages_au AFTER UPDATE ON messages BEGIN
          INSERT INTO messages_fts(messages_fts, rowid, subject, from_address, from_name, body_text)
          VALUES ('delete', old.id, old.subject, old.from_address, old.from_name, COALESCE(old.body_text,''));
          INSERT INTO messages_fts(rowid, subject, from_address, from_name, body_text)
          VALUES (new.id, new.subject, new.from_address, new.from_name, COALESCE(new.body_text,''));
        END;
      `);
    },
  },

  {
    version: 2,
    name: 'oauth account tokens and pending authorisations',
    up(db) {
      /*
       * OAuth metadata lives separately from `accounts` for two reasons:
       *
       *  1. It is optional. A password account has no tokens, and adding five
       *     nullable columns to `accounts` would make the common case carry the
       *     uncommon one's shape.
       *  2. Token LIFETIME and SCOPES are operational state, not identity. They
       *     change on every refresh, so keeping them apart means account rows
       *     are not rewritten constantly.
       *
       * No token material is stored here — not even encrypted. The ciphertext
       * lives in `secrets` via safeStorage, and this table only holds a
       * reference plus non-secret bookkeeping. A database dump therefore
       * reveals no token, even before DPAPI is considered.
       */
      db.exec(`
        CREATE TABLE oauth_accounts (
          account_id     INTEGER PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
          provider       TEXT    NOT NULL CHECK (provider IN ('google','microsoft')),
          -- When the access token expires, epoch ms. Never a token.
          expires_at     INTEGER NOT NULL DEFAULT 0,
          -- Space-separated scopes the provider actually granted, which can be
          -- narrower than what was requested.
          scope          TEXT    NOT NULL DEFAULT '',
          -- Provider-side subject/account id, used to recognise a re-authorised
          -- account rather than creating a duplicate.
          subject        TEXT,
          -- Human-readable state; the message is safe to display.
          status         TEXT    NOT NULL DEFAULT 'connected'
                                 CHECK (status IN ('connected','expired','error','revoked')),
          last_error     TEXT,
          created_at     INTEGER NOT NULL,
          updated_at     INTEGER NOT NULL
        );
      `);
      db.exec('CREATE INDEX idx_oauth_accounts_subject ON oauth_accounts(provider, subject)');

      /*
       * Short-lived authorisation attempts.
       *
       * These are stored so a callback can be matched to the request that
       * started it, including across a main-process restart, and so `state` can
       * be marked consumed exactly once. The PKCE verifier IS here — it is a
       * secret, but a single-use one that expires in minutes, and it must
       * survive the round trip through the browser. It is deleted the moment the
       * attempt is consumed, and `expires_at` bounds its lifetime.
       *
       * `state` is stored as a hash, not the raw value: the raw state travels
       * through the browser, so a leaked table must not let an attacker forge a
       * callback.
       */
      db.exec(`
        CREATE TABLE oauth_pending (
          state_hash     TEXT PRIMARY KEY,
          provider       TEXT    NOT NULL CHECK (provider IN ('google','microsoft')),
          code_verifier  TEXT    NOT NULL,
          redirect_uri   TEXT    NOT NULL,
          -- Set once the callback has been consumed, so a replay is detectable.
          consumed_at    INTEGER,
          created_at     INTEGER NOT NULL,
          expires_at     INTEGER NOT NULL
        );
      `);
      db.exec('CREATE INDEX idx_oauth_pending_expiry ON oauth_pending(expires_at)');
    },
  },
];
