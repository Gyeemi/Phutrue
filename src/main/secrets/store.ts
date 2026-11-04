/**
 * Secret storage.
 *
 * On Windows, `safeStorage.encryptString()` uses DPAPI, which binds the
 * ciphertext to the logged-in Windows user on that machine. We store only the
 * opaque ciphertext in SQLite.
 *
 * If encryption is unavailable (some Linux setups without a keyring), we do NOT
 * fall back to plaintext. Phutrue refuses to persist the secret and reports the
 * condition, because silently writing credentials in clear is worse than
 * requiring the user to re-enter a password.
 */

import { safeStorage } from 'electron';
import type { DatabaseSync } from 'node:sqlite';

import { AppError, ErrorCodes } from '../../shared/result.js';
import { now } from '../db/database.js';

export interface SecretStore {
  available(): boolean;
  /** Why storage is unavailable, if it is. */
  reason(): string | null;
  put(ref: string, plaintext: string): void;
  get(ref: string): string | null;
  delete(ref: string): void;
  has(ref: string): boolean;
}

export function createSecretStore(db: DatabaseSync): SecretStore {
  let cachedAvailable: boolean | null = null;
  let cachedReason: string | null = null;

  function probe(): { ok: boolean; reason: string | null } {
    if (cachedAvailable !== null) {
      return { ok: cachedAvailable, reason: cachedReason };
    }
    try {
      if (!safeStorage.isEncryptionAvailable()) {
        cachedAvailable = false;
        cachedReason =
          'Operating-system credential encryption is not available. Passwords cannot be stored securely.';
        return { ok: false, reason: cachedReason };
      }
      // Round-trip a canary so we fail here rather than at first use.
      const canary = 'phutrue-canary';
      const back = safeStorage.decryptString(safeStorage.encryptString(canary));
      if (back !== canary) {
        cachedAvailable = false;
        cachedReason = 'Credential encryption round-trip failed.';
        return { ok: false, reason: cachedReason };
      }
      cachedAvailable = true;
      cachedReason = null;
      return { ok: true, reason: null };
    } catch (err) {
      cachedAvailable = false;
      cachedReason = `Credential encryption unavailable: ${err instanceof Error ? err.message : 'unknown error'}`;
      return { ok: false, reason: cachedReason };
    }
  }

  return {
    available: () => probe().ok,
    reason: () => probe().reason,

    put(ref, plaintext) {
      if (!probe().ok) {
        throw new AppError(
          ErrorCodes.SECURE_STORAGE_UNAVAILABLE,
          cachedReason ?? 'Secure storage is unavailable.'
        );
      }
      const ciphertext = safeStorage.encryptString(plaintext);
      db.prepare(
        `INSERT INTO secrets (ref, ciphertext, updated_at) VALUES (?,?,?)
         ON CONFLICT(ref) DO UPDATE SET ciphertext = excluded.ciphertext, updated_at = excluded.updated_at`
      ).run(ref, ciphertext, now());
    },

    get(ref) {
      const row = db.prepare('SELECT ciphertext FROM secrets WHERE ref = ?').get(ref) as
        | { ciphertext: Uint8Array }
        | undefined;
      if (!row) return null;
      if (!probe().ok) {
        throw new AppError(
          ErrorCodes.SECURE_STORAGE_UNAVAILABLE,
          cachedReason ?? 'Secure storage is unavailable.'
        );
      }
      try {
        return safeStorage.decryptString(Buffer.from(row.ciphertext));
      } catch {
        // A DPAPI blob from another Windows user or machine cannot be read.
        // That is expected after a profile move; treat it as "no secret".
        return null;
      }
    },

    delete(ref) {
      db.prepare('DELETE FROM secrets WHERE ref = ?').run(ref);
    },

    has(ref) {
      const row = db.prepare('SELECT 1 AS x FROM secrets WHERE ref = ?').get(ref);
      return row !== undefined;
    },
  };
}

/** Stable reference key for an account's credential. */
export function credentialRef(accountId: number): string {
  return `account:${accountId}:secret`;
}

// NOTE: there is deliberately no `refreshTokenRef()` yet. OAuth is not
// implemented, and shipping an unused key generator would invite the assumption
// that it is. Add it together with the OAuth flow in milestone 3, next to the
// code that consumes it.
