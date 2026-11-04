/**
 * In-app diagnostics.
 *
 * This is a **Windows verification aid**, not a feature. Its job is to let a
 * tester run the four checks that cannot be proven anywhere except inside a real
 * Electron process on Windows, and to do so without ever showing a secret.
 *
 * The four checks, in dependency order:
 *
 *   1. database path  — where the file lives, and whether the directory and file
 *                       are actually writable (not just "exists").
 *   2. migrations     — the schema reached the version the code expects, and the
 *                       integrity check passes.
 *   3. node:sqlite    — a real query against a real table returns a value shaped
 *                       the way the repositories expect.
 *   4. safeStorage    — whether OS credential encryption is genuinely available,
 *                       including a ciphertext round-trip, plus a proof that the
 *                       stored form is NOT the plaintext.
 *
 * A fifth check — "is the preload bridge present and does IPC respond?" — cannot
 * live here: by construction the main process cannot observe the preload
 * boundary from the outside. It is performed by the renderer and merged into the
 * report; see `src/renderer/components/DiagnosticsView.tsx`.
 *
 * Why dependency injection: `node:sqlite`, `safeStorage` and the filesystem are
 * all supplied by the caller, so the trigger logic and every redaction rule can
 * be tested under plain Node, where none of them exist. The Electron-specific
 * wiring lives in `src/main/index.ts`.
 *
 * ## What must never appear in the report
 *
 * The report is rendered on screen and pasted into bug reports, so it is treated
 * as public. In particular the credential check stores a random canary, proves
 * the ciphertext differs from it, and then **deletes it** — the canary and the
 * ciphertext never reach the report. Errors are reduced to a category, because
 * a raw SQLite or DPAPI message can quote a path or a payload.
 */

import { summarise } from '../../shared/diagnostics.js';
import type { DiagnosticCheck, DiagnosticsReport } from '../../shared/models.js';

export interface DiagnosticsDeps {
  /** Absolute path of the database file, for display and writability testing. */
  databasePath: string;
  /** Current schema version reported by the open database. */
  schemaVersion: number;
  /** The version this build requires; a mismatch is a failure. */
  expectedSchemaVersion: number;
  /**
   * Run `SELECT 1` (or equivalent) and return the value.
   * Supplied by the caller so this module owns no SQL execution of its own.
   */
  probeQuery: () => number;
  /** SQLite `PRAGMA quick_check` result; must be `['ok']`. */
  integrityCheck: () => string[];
  /** Filesystem probes, injected so tests can simulate a read-only profile. */
  canWriteDirectory: () => boolean;
  canWriteFile: () => boolean;
  /** Size of the database file in bytes, or null when it does not exist yet. */
  databaseSizeBytes: () => number | null;
  /**
   * Whether `safeStorage.isEncryptionAvailable()` is true, and whether a
   * round-trip through encrypt/decrypt succeeded.
   *
   * `roundTrip: null` means it was not attempted (encryption unavailable).
   */
  secureStorage: () => {
    available: boolean;
    roundTrip: boolean | null;
    /** True when ciphertext differed from plaintext. */
    ciphertextDiffers: boolean | null;
    /** Why it is unavailable, already reduced to a safe string. */
    reason: string | null;
  };
  /**
   * Literal substrings that must never appear in any detail.
   *
   * Defence in depth alongside `redactPath`. Path redaction is pattern-based and
   * therefore fallible: a profile on a UNC share, a custom `%APPDATA%`, or a
   * relocated user-data directory could carry the account name in a shape the
   * pattern does not recognise. The caller supplies the actual Windows user name
   * here, and every detail is scrubbed against it as a final step.
   */
  redactValues?: string[];
  /**
   * Facts about the renderer bundle this process is serving.
   *
   * Optional: a sandbox test or a future headless mode may not have a renderer
   * directory to inspect. When absent the check reports `skip` rather than
   * pretending to have verified something.
   */
  build?: {
    /** Absolute path of dist/renderer. */
    rendererPath: string;
    /** Stamp baked into this bundle at build time. */
    stamp: string;
    /** File names the renderer needs, in load order. */
    expectedFiles: readonly string[];
    /** Size in bytes of a file in the renderer directory, or null if missing. */
    fileSize: (name: string) => number | null;
  };
}

/** Monotonic-ish clock, injected so durations are deterministic in tests. */
export type Clock = () => number;

/**
 * Reduce an unknown thrown value to a short, safe category.
 *
 * The message itself is discarded: a `node:sqlite` error can quote the failing
 * SQL and its bound parameters, and a `safeStorage` error can quote the
 * ciphertext. Only the error's class is retained, which is enough to triage.
 */
export function safeErrorKind(err: unknown): string {
  if (err instanceof Error) {
    const name = err.name || 'Error';
    // Keep it short and alphanumeric-ish so it cannot smuggle a payload.
    return name.replace(/[^A-Za-z0-9_]/g, '').slice(0, 40) || 'Error';
  }
  return typeof err;
}

/**
 * Redact an absolute path for display.
 *
 * Showing the full path is useful for Support, but it contains the Windows
 * username. The user-profile prefix is collapsed so the path remains
 * recognisable without disclosing an account name.
 */
export function redactPath(file: string): string {
  return file
    .replace(/\\(?:Users|Documents and Settings)\\[^\\]+/i, '\\Users\\<user>')
    .replace(/\/(?:home|Users)\/[^/]+/, '/home/<user>');
}

/**
 * Remove every occurrence of each sensitive literal from `text`.
 *
 * Only values long enough to be meaningful are replaced, so a one-character user
 * name cannot mangle ordinary words.
 */
export function scrub(text: string, values: readonly string[]): string {
  let out = text;
  for (const value of values) {
    if (value.length < 3) continue;
    // Escape regex metacharacters so a name like "a.b(c" cannot break the match.
    const pattern = new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    out = out.replace(pattern, '<redacted>');
  }
  return out;
}

/** Format a byte count compactly, for the database-size line. */
export function formatBytes(bytes: number | null): string {
  if (bytes === null) return 'not created yet';
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

/** Run one check, capturing duration and converting a throw into a failure. */
function runCheck(
  id: string,
  label: string,
  clock: Clock,
  body: () => { status: DiagnosticCheck['status']; detail: string }
): DiagnosticCheck {
  const started = clock();
  try {
    const result = body();
    return { id, label, status: result.status, detail: result.detail, durationMs: clock() - started };
  } catch (err) {
    return {
      id,
      label,
      status: 'fail',
      detail: `threw ${safeErrorKind(err)}`,
      durationMs: clock() - started,
    };
  }
}

/**
 * Produce the full report.
 *
 * Checks are independent: one failing never prevents the others from running, so
 * a tester sees every problem in one pass instead of fixing them one at a time.
 */
export function runDiagnostics(deps: DiagnosticsDeps, clock: Clock = Date.now): DiagnosticsReport {
  const checks: DiagnosticCheck[] = [];

  /* 1. Database path and writability ------------------------------- */
  checks.push(
    runCheck('database.path', 'Database file location', clock, () => {
      const shown = redactPath(deps.databasePath);
      return { status: 'pass', detail: shown };
    })
  );

  checks.push(
    runCheck('database.writable', 'Database directory is writable', clock, () => {
      if (!deps.canWriteDirectory() || !deps.canWriteFile()) {
        return {
          status: 'fail',
          detail:
            'The user-data folder rejected a write. Check folder permissions, or whether an antivirus or backup agent is locking the file.',
        };
      }
      return {
        status: 'pass',
        detail: `wrote and removed a probe file; database is ${formatBytes(deps.databaseSizeBytes())}`,
      };
    })
  );

  /* 2. Migrations and integrity ----------------------------------- */
  checks.push(
    runCheck('database.schema', 'Schema version', clock, () => {
      const { schemaVersion, expectedSchemaVersion } = deps;
      if (schemaVersion !== expectedSchemaVersion) {
        return {
          status: 'fail',
          detail: `schema v${schemaVersion}, expected v${expectedSchemaVersion} — the database predates or postdates this build`,
        };
      }
      return { status: 'pass', detail: `v${schemaVersion}` };
    })
  );

  checks.push(
    runCheck('database.integrity', 'Database integrity', clock, () => {
      const result = deps.integrityCheck();
      const ok = result.length === 1 && result[0] === 'ok';
      return {
        status: ok ? 'pass' : 'fail',
        detail: ok ? 'quick_check: ok' : `quick_check reported ${result.length} row(s) of problems`,
      };
    })
  );

  /* 3. node:sqlite can actually execute a query -------------------- */
  checks.push(
    runCheck('sqlite.query', 'node:sqlite query', clock, () => {
      const value = deps.probeQuery();
      if (value !== 1) {
        return { status: 'fail', detail: `probe returned ${String(value)}, expected 1` };
      }
      return { status: 'pass', detail: 'SELECT 1 returned 1' };
    })
  );

  /* 4. Credential encryption -------------------------------------- */
  checks.push(
    runCheck('storage.encryption', 'Credential encryption (DPAPI)', clock, () => {
      const s = deps.secureStorage();

      if (!s.available) {
        return {
          status: 'fail',
          detail: s.reason
            ? `${s.reason} Passwords will not be saved; no plaintext fallback is used.`
            : 'OS credential encryption reports unavailable. Passwords will not be saved.',
        };
      }

      if (s.roundTrip !== true) {
        return {
          status: 'fail',
          detail: 'Encryption is available but an encrypt/decrypt round-trip did not return the original value.',
        };
      }

      if (s.ciphertextDiffers !== true) {
        // This would mean the "encryption" returned the input unchanged, i.e. a
        // silent plaintext fallback. Treat it as a hard failure.
        return {
          status: 'fail',
          detail: 'Round-trip succeeded but the stored bytes were identical to the plaintext — refusing to store credentials.',
        };
      }

      return { status: 'pass', detail: 'round-trip ok; stored form is ciphertext' };
    })
  );

  /* 8. Build integrity --------------------------------------------- *
   * A running window can only display a bundle that exists, is non-empty, and
   * was produced by the build the main process belongs to. A stale installed
   * copy, a partial extraction, or a truncated write all show up here rather
   * than as a mysterious blank screen.
   * ----------------------------------------------------------------- */
  if (deps.build) {
    const build = deps.build;
    checks.push(
      runCheck('build.integrity', 'Renderer bundle integrity', clock, () => {
        const missing: string[] = [];
        const empty: string[] = [];

        for (const name of build.expectedFiles) {
          const size = build.fileSize(name);
          if (size === null) missing.push(name);
          else if (size === 0) empty.push(name);
        }

        if (missing.length > 0) {
          return {
            status: 'fail',
            detail: `missing from ${redactPath(build.rendererPath)}: ${missing.join(', ')} — the window will be blank or unstyled`,
          };
        }
        if (empty.length > 0) {
          return { status: 'fail', detail: `empty file(s): ${empty.join(', ')}` };
        }

        return { status: 'pass', detail: `stamp ${build.stamp}; ${build.expectedFiles.length} files present` };
      })
    );
  } else {
    checks.push(
      runCheck('build.integrity', 'Renderer bundle integrity', clock, () => ({
        status: 'skip',
        detail: 'not inspected in this process',
      }))
    );
  }

  // Final pass: scrub every detail against the caller's forbidden literals. The
  // report is public by design, so this runs on the finished checks rather than
  // relying on each detail string being written carefully.
  const safeValues = deps.redactValues ?? [];
  const scrubbed: DiagnosticCheck[] = checks.map((c) => ({
    ...c,
    detail: scrub(c.detail, safeValues),
  }));

  return summarise(scrubbed, process.platform, clock());
}
