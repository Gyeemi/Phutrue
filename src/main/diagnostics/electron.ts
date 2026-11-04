/**
 * Electron-specific wiring for the diagnostics report.
 *
 * Everything here touches a real subsystem (`node:fs`, `node:sqlite`,
 * `safeStorage`), which is exactly why it is kept apart from the pure logic in
 * `./index.ts`. This file cannot be unit-tested in this environment; the logic
 * it feeds can.
 */

import { randomBytes } from 'node:crypto';
import { userInfo } from 'node:os';
import { accessSync, constants, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { safeStorage } from 'electron';
import type { DatabaseSync } from 'node:sqlite';

import { oneRow } from '../db/database.js';
import { MIGRATIONS } from '../db/migrations/index.js';
import type { DiagnosticsDeps } from './index.js';

/** The schema version this build was compiled against. */
export function expectedSchemaVersion(): number {
  return MIGRATIONS.reduce((max, m) => Math.max(max, m.version), 0);
}

/** Read the version recorded in the database, tolerating a fresh file. */
export function readSchemaVersion(db: DatabaseSync): number {
  const row = oneRow<{ version: number }>(db, 'SELECT version FROM schema_version LIMIT 1');
  return row?.version ?? 0;
}

/**
 * `PRAGMA quick_check` — same coverage as `integrity_check` for our purposes but
 * much faster on a large mailbox. Returns one row when healthy.
 */
export function integrityRows(db: DatabaseSync): string[] {
  const rows = db.prepare('PRAGMA quick_check').all() as Array<Record<string, unknown>>;
  return rows.map((r) => String(r['quick_check'] ?? r['integrity_check'] ?? ''));
}

/**
 * Prove the directory and the file are writable, not merely present.
 *
 * An `accessSync(W_OK)` call is not enough: on Windows an antivirus or a roaming
 * profile can deny the actual write while reporting the ACL as writable. So we
 * perform a real write and clean up after ourselves.
 *
 * The probe file deliberately has a distinctive, greppable name so a leftover is
 * obvious, and it is removed in a `finally`.
 */
export function probeWritable(dir: string): boolean {
  const probe = path.join(dir, `.phutrue-write-probe-${process.pid}`);
  try {
    writeFileSync(probe, 'ok', { flag: 'w' });
    return true;
  } catch {
    return false;
  } finally {
    try {
      rmSync(probe, { force: true });
    } catch {
      /* best effort */
    }
  }
}

/** Whether the database file itself can be opened for writing. */
export function databaseFileWritable(file: string): boolean {
  try {
    statSync(file);
  } catch {
    // Not created yet; the directory probe covers this case.
    return true;
  }
  try {
    accessSync(file, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** File size, or null when the file does not exist yet. */
export function fileSize(file: string): number | null {
  try {
    return statSync(file).size;
  } catch {
    return null;
  }
}

/**
 * Verify credential encryption with a throwaway canary.
 *
 * The canary is 32 random bytes, hex-encoded, so it is worthless if it ever
 * leaks. Two things are proven:
 *
 *   - a round-trip returns the original value (encryption is functional), and
 *   - the ciphertext differs from the plaintext (it is really encrypted, not a
 *     silent plaintext fallback).
 *
 * Nothing derived from the canary is returned or stored. The buffers are zeroed
 * before returning.
 */
export interface SecureStorageProbe {
  available: boolean;
  roundTrip: boolean | null;
  ciphertextDiffers: boolean | null;
  reason: string | null;
}

export function probeSecureStorage(): SecureStorageProbe {
  let available = false;
  try {
    available = safeStorage.isEncryptionAvailable();
  } catch {
    return {
      available: false,
      roundTrip: null,
      ciphertextDiffers: null,
      reason: 'The credential-encryption API could not be queried.',
    };
  }

  if (!available) {
    return {
      available: false,
      roundTrip: null,
      ciphertextDiffers: null,
      reason:
        process.platform === 'win32'
          ? 'Windows DPAPI reported no usable encryption for this user.'
          : 'This platform has no OS credential store available for this user.',
    };
  }

  let plain = '';
  try {
    plain = randomBytes(32).toString('hex');
    const ciphertext = safeStorage.encryptString(plain);

    // Compare as bytes, not as a decoded string: the point is that the stored
    // form is not the plaintext.
    const differs = !Buffer.from(ciphertext).equals(Buffer.from(plain, 'utf8'));

    const back = safeStorage.decryptString(ciphertext);
    const roundTrip = back === plain;

    return { available: true, roundTrip, ciphertextDiffers: differs, reason: null };
  } catch {
    // Never surface the thrown message: it can contain the ciphertext.
    return {
      available: true,
      roundTrip: false,
      ciphertextDiffers: null,
      reason: 'Encryption is available but the round-trip failed.',
    };
  } finally {
    // Drop the only copy of the plaintext canary.
    plain = '';
  }
}

/** Assemble the dependency bundle for one run. */
/**
 * @param rendererPath Absolute path of the served renderer directory, or null
 *   when this process has none (tests, headless use).
 * @param buildStamp The stamp baked into this bundle by scripts/build.mjs.
 */
export function electronDeps(
  db: DatabaseSync,
  databasePath: string,
  rendererPath: string | null = null,
  buildStamp = 'dev'
): DiagnosticsDeps {
  const deps: DiagnosticsDeps = {
    databasePath,
    schemaVersion: readSchemaVersion(db),
    expectedSchemaVersion: expectedSchemaVersion(),
    probeQuery: () => {
      const row = oneRow<{ one: number }>(db, 'SELECT 1 AS one');
      return Number(row?.one ?? -1);
    },
    integrityCheck: () => integrityRows(db),
    canWriteDirectory: () => probeWritable(path.dirname(databasePath)),
    canWriteFile: () => databaseFileWritable(databasePath),
    databaseSizeBytes: () => fileSize(databasePath),
    secureStorage: probeSecureStorage,
    // The user name can leak through a path shape `redactPath` does not
    // recognise (UNC, relocated profile). Scrubbing the literal closes that.
    redactValues: accountNameLiterals(),
  };

  if (rendererPath) {
    // The three files the document cannot boot without. `app.js` supplies the
    // interface, `app.css` its appearance; index.html is the document itself.
    deps.build = {
      rendererPath,
      stamp: buildStamp,
      expectedFiles: ['index.html', 'app.js', 'app.css'],
      fileSize: (name) => fileSize(path.join(rendererPath, name)),
    };
  }

  return deps;
}

/**
 * Literals that must never appear in a report.
 *
 * `userInfo().username` is the Windows account name in the common case. The
 * environment variable is included because a domain account is sometimes written
 * as `DOMAIN\user` in one place and `user` in another.
 */
export function accountNameLiterals(): string[] {
  const values: string[] = [];
  try {
    const { username } = userInfo();
    if (username) values.push(username);
  } catch {
    /* not fatal — the pattern-based redaction still applies */
  }
  for (const key of ['USERNAME', 'USER']) {
    const v = process.env[key];
    if (v) values.push(v);
  }
  // Deduplicate; `scrub` ignores anything shorter than 3 characters.
  return [...new Set(values)];
}
