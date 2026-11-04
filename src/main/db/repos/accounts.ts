/**
 * Account persistence.
 *
 * Never stores a password or token. `credentialRef(accountId)` points into the
 * encrypted `secrets` table instead.
 */

import type { DatabaseSync } from 'node:sqlite';
import type { Account, AccountDraft, AccountSyncState, AuthKind, OAuthProvider } from '../../../shared/models.js';
import { allRows, now, oneRow, requireRow } from '../database.js';

interface AccountRow {
  id: number;
  label: string;
  email: string;
  display_name: string;
  auth_kind: string;
  oauth_provider: string | null;
  imap_host: string;
  imap_port: number;
  imap_secure: number;
  smtp_host: string;
  smtp_port: number;
  smtp_secure: number;
  smtp_user: string | null;
  sync_state: string;
  last_error: string | null;
  last_synced_at: number | null;
  created_at: number;
}

function toAccount(r: AccountRow): Account {
  return {
    id: r.id,
    label: r.label,
    email: r.email,
    displayName: r.display_name,
    authKind: r.auth_kind as AuthKind,
    oauthProvider: r.oauth_provider as OAuthProvider | null,
    imapHost: r.imap_host,
    imapPort: r.imap_port,
    imapSecure: r.imap_secure === 1,
    smtpHost: r.smtp_host,
    smtpPort: r.smtp_port,
    smtpSecure: r.smtp_secure === 1,
    smtpUser: r.smtp_user,
    syncState: r.sync_state as AccountSyncState,
    lastError: r.last_error,
    lastSyncedAt: r.last_synced_at,
    createdAt: r.created_at,
  };
}

export interface CreateAccountInput extends AccountDraft {
  authKind?: AuthKind;
  oauthProvider?: OAuthProvider | null;
}

export function createAccountRepo(db: DatabaseSync) {
  return {
    list(): Account[] {
      const rows = allRows<AccountRow>(db, 'SELECT * FROM accounts ORDER BY created_at ASC');
      return rows.map(toAccount);
    },

    get(id: number): Account {
      const row = oneRow<AccountRow>(db, 'SELECT * FROM accounts WHERE id = ?', id);
      return toAccount(requireRow(row, 'Account'));
    },

    findByEmail(email: string): Account | null {
      const row = oneRow<AccountRow>(db, 'SELECT * FROM accounts WHERE email = ?', email.toLowerCase());
      return row ? toAccount(row) : null;
    },

    create(input: CreateAccountInput): Account {
      const result = db
        .prepare(
          `INSERT INTO accounts
             (label,email,display_name,auth_kind,oauth_provider,imap_host,imap_port,imap_secure,
              smtp_host,smtp_port,smtp_secure,smtp_user,created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
        )
        .run(
          input.label,
          input.email.toLowerCase(),
          input.displayName,
          input.authKind ?? 'password',
          input.oauthProvider ?? null,
          input.imapHost,
          input.imapPort,
          input.imapSecure ? 1 : 0,
          input.smtpHost,
          input.smtpPort,
          input.smtpSecure ? 1 : 0,
          input.smtpUser ?? null,
          now()
        );
      return this.get(Number(result.lastInsertRowid));
    },

    update(id: number, patch: Partial<CreateAccountInput>): Account {
      const current = this.get(id); // throws NOT_FOUND if absent
      db.prepare(
        `UPDATE accounts SET
           label = ?, display_name = ?, imap_host = ?, imap_port = ?, imap_secure = ?,
           smtp_host = ?, smtp_port = ?, smtp_secure = ?, smtp_user = ?
         WHERE id = ?`
      ).run(
        patch.label ?? current.label,
        patch.displayName ?? current.displayName,
        patch.imapHost ?? current.imapHost,
        patch.imapPort ?? current.imapPort,
        (patch.imapSecure ?? current.imapSecure) ? 1 : 0,
        patch.smtpHost ?? current.smtpHost,
        patch.smtpPort ?? current.smtpPort,
        (patch.smtpSecure ?? current.smtpSecure) ? 1 : 0,
        patch.smtpUser ?? current.smtpUser,
        id
      );
      return this.get(id);
    },

    setSyncState(id: number, state: AccountSyncState, error: string | null): void {
      db.prepare('UPDATE accounts SET sync_state = ?, last_error = ? WHERE id = ?').run(state, error, id);
    },

    markSynced(id: number): void {
      db.prepare("UPDATE accounts SET sync_state = 'idle', last_synced_at = ?, last_error = NULL WHERE id = ?")
        .run(now(), id);
    },

    remove(id: number): void {
      this.get(id); // throws when missing, rather than silently succeeding
      // Cascades to folders, messages, drafts, outbox via foreign keys.
      db.prepare('DELETE FROM accounts WHERE id = ?').run(id);
    },
  };
}

export type AccountRepo = ReturnType<typeof createAccountRepo>;
