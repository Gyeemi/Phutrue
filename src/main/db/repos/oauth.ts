/**
 * OAuth persistence: pending authorisation attempts and account token metadata.
 *
 * No token material is stored by this module. Access and refresh tokens live in
 * `secrets`, wrapped by safeStorage. What is here is the bookkeeping needed to
 * complete a flow safely and to know when a token needs refreshing.
 */

import type { DatabaseSync } from 'node:sqlite';

import type { OAuthProvider, OAuthStatus } from '../../../shared/models.js';
import { now, oneRow, run } from '../database.js';

/** How long a pending authorisation attempt stays valid. */
export const PENDING_TTL_MS = 10 * 60 * 1000;

export interface PendingAttempt {
  stateHash: string;
  provider: OAuthProvider;
  codeVerifier: string;
  redirectUri: string;
  createdAt: number;
  expiresAt: number;
}

export interface OAuthAccountRow {
  accountId: number;
  provider: OAuthProvider;
  expiresAt: number;
  scope: string;
  subject: string | null;
  status: OAuthStatus;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}

interface PendingDbRow {
  state_hash: string;
  provider: string;
  code_verifier: string;
  redirect_uri: string;
  consumed_at: number | null;
  created_at: number;
  expires_at: number;
}

interface OAuthDbRow {
  account_id: number;
  provider: string;
  expires_at: number;
  scope: string;
  subject: string | null;
  status: string;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

export function createOAuthRepo(db: DatabaseSync, clock: () => number = now) {
  return {
    /* ---- pending attempts ------------------------------------------ */

    /** Store a new attempt. `stateHash` is SHA-256(state), never the raw state. */
    createPending(input: PendingAttempt): void {
      db.prepare(
        `INSERT INTO oauth_pending (state_hash, provider, code_verifier, redirect_uri, created_at, expires_at)
         VALUES (?,?,?,?,?,?)`
      ).run(
        input.stateHash,
        input.provider,
        input.codeVerifier,
        input.redirectUri,
        input.createdAt,
        input.expiresAt
      );
    },

    /**
     * Consume an attempt exactly once.
     *
     * This is the replay guard. It runs as a single UPDATE guarded by
     * `consumed_at IS NULL AND expires_at > ?`, so two concurrent callbacks with
     * the same state cannot both succeed — the second update matches no row.
     *
     * Returns the attempt when it was valid and unclaimed, otherwise null. The
     * caller must not distinguish "never existed" from "already used" in
     * user-facing text.
     */
    consumePending(stateHash: string, at: number = clock()): PendingAttempt | null {
      const changed = run(
        db,
        `UPDATE oauth_pending
            SET consumed_at = ?
          WHERE state_hash = ? AND consumed_at IS NULL AND expires_at > ?`,
        at,
        stateHash,
        at
      );
      if (changed === 0) return null;

      const row = oneRow<PendingDbRow>(
        db,
        `SELECT * FROM oauth_pending WHERE state_hash = ?`,
        stateHash
      );
      if (!row) return null;

      return {
        stateHash: row.state_hash,
        provider: row.provider as OAuthProvider,
        codeVerifier: row.code_verifier,
        redirectUri: row.redirect_uri,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
      };
    },

    /** Delete attempts past their lifetime. Returns how many were removed. */
    prunePending(at: number = clock()): number {
      return run(db, 'DELETE FROM oauth_pending WHERE expires_at <= ?', at);
    },

    /** Number of stored attempts; used by tests and diagnostics. */
    pendingCount(): number {
      const row = oneRow<{ c: number }>(db, 'SELECT COUNT(*) AS c FROM oauth_pending');
      return row?.c ?? 0;
    },

    /* ---- account token metadata ------------------------------------ */

    /** Insert or replace the metadata row for an account. */
    upsertAccount(input: OAuthAccountRow): void {
      db.prepare(
        `INSERT INTO oauth_accounts
           (account_id, provider, expires_at, scope, subject, status, last_error, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?)
         ON CONFLICT(account_id) DO UPDATE SET
           provider   = excluded.provider,
           expires_at = excluded.expires_at,
           scope      = excluded.scope,
           subject    = excluded.subject,
           status     = excluded.status,
           last_error = excluded.last_error,
           updated_at = excluded.updated_at`
      ).run(
        input.accountId,
        input.provider,
        input.expiresAt,
        input.scope,
        input.subject,
        input.status,
        input.lastError,
        input.createdAt,
        input.updatedAt
      );
    },

    getAccount(accountId: number): OAuthAccountRow | null {
      const row = oneRow<OAuthDbRow>(
        db,
        'SELECT * FROM oauth_accounts WHERE account_id = ?',
        accountId
      );
      if (!row) return null;
      return {
        accountId: row.account_id,
        provider: row.provider as OAuthProvider,
        expiresAt: row.expires_at,
        scope: row.scope,
        subject: row.subject,
        status: row.status as OAuthStatus,
        lastError: row.last_error,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    },

    /** Record a refresh outcome without touching token material. */
    setStatus(
      accountId: number,
      status: OAuthStatus,
      lastError: string | null,
      expiresAt?: number
    ): void {
      if (typeof expiresAt === 'number') {
        run(
          db,
          `UPDATE oauth_accounts SET status = ?, last_error = ?, expires_at = ?, updated_at = ?
            WHERE account_id = ?`,
          status,
          lastError,
          expiresAt,
          clock(),
          accountId
        );
        return;
      }
      run(
        db,
        `UPDATE oauth_accounts SET status = ?, last_error = ?, updated_at = ? WHERE account_id = ?`,
        status,
        lastError,
        clock(),
        accountId
      );
    },

    /** Whether an access token needs refreshing before use. */
    needsRefresh(accountId: number, at: number = clock(), skewMs = 60_000): boolean {
      const row = this.getAccount(accountId);
      if (!row) return false;
      // Refresh a minute early so a token cannot expire mid-request.
      return row.expiresAt - skewMs <= at;
    },

    removeForAccount(accountId: number): void {
      run(db, 'DELETE FROM oauth_accounts WHERE account_id = ?', accountId);
    },
  };
}
