/**
 * Diagnostics logic.
 *
 * Two things are being protected here, in order of importance:
 *
 *  1. **The report never carries a secret.** It is rendered on screen and pasted
 *     into bug reports, so a leak is a real disclosure, not a cosmetic bug. The
 *     tests assert on the serialised report, which is exactly what crosses IPC
 *     and what gets copied to the clipboard.
 *
 *  2. **A failure is reported as a failure.** A diagnostics screen that says
 *     "all good" when DPAPI is broken is worse than no diagnostics screen, so
 *     every degraded path is asserted explicitly.
 */

import { describe, expect, it } from 'vitest';

import {
  formatBytes,
  redactPath,
  runDiagnostics,
  safeErrorKind,
  scrub,
  type DiagnosticsDeps,
} from '../src/main/diagnostics/index.js';
import { reportToText, summarise } from '../src/shared/diagnostics.js';
import type { DiagnosticCheck } from '../src/shared/models.js';

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

/** A dependency bundle where every check should pass. */
function healthyDeps(overrides: Partial<DiagnosticsDeps> = {}): DiagnosticsDeps {
  return {
    databasePath: 'C:\\Users\\alice\\AppData\\Roaming\\Phutrue\\phutrue.db',
    schemaVersion: 1,
    expectedSchemaVersion: 1,
    probeQuery: () => 1,
    integrityCheck: () => ['ok'],
    canWriteDirectory: () => true,
    canWriteFile: () => true,
    databaseSizeBytes: () => 4096,
    secureStorage: () => ({
      available: true,
      roundTrip: true,
      ciphertextDiffers: true,
      reason: null,
    }),
    ...overrides,
  };
}

/** Deterministic clock: each call advances by 1ms. */
function fakeClock(): () => number {
  let t = 1000;
  return () => (t += 1);
}

function byId(checks: DiagnosticCheck[], id: string): DiagnosticCheck {
  const found = checks.find((c) => c.id === id);
  if (!found) throw new Error(`no check ${id}`);
  return found;
}

/* ------------------------------------------------------------------ *
 * Healthy path
 * ------------------------------------------------------------------ */

describe('all checks pass', () => {
  it('reports ok and includes every check', () => {
    const report = runDiagnostics(healthyDeps(), fakeClock());
    expect(report.ok).toBe(true);
    expect(report.checks.map((c) => c.id)).toEqual([
      'database.path',
      'database.writable',
      'database.schema',
      'database.integrity',
      'sqlite.query',
      'storage.encryption',
    ]);
    expect(report.checks.every((c) => c.status === 'pass')).toBe(true);
  });

  it('records a duration for every check', () => {
    const report = runDiagnostics(healthyDeps(), fakeClock());
    expect(report.checks.every((c) => typeof c.durationMs === 'number')).toBe(true);
  });

  it('describes the encryption result without values', () => {
    const report = runDiagnostics(healthyDeps(), fakeClock());
    expect(byId(report.checks, 'storage.encryption').detail).toContain('ciphertext');
  });
});

/* ------------------------------------------------------------------ *
 * Failure paths — each must fail loudly
 * ------------------------------------------------------------------ */

describe('database path and writability', () => {
  it('fails when the directory rejects a write', () => {
    const report = runDiagnostics(healthyDeps({ canWriteDirectory: () => false }), fakeClock());
    expect(report.ok).toBe(false);
    const c = byId(report.checks, 'database.writable');
    expect(c.status).toBe('fail');
    // The guidance must be actionable, not just "it broke".
    expect(c.detail).toMatch(/permissions|antivirus|locking/i);
  });

  it('fails when the file itself is not writable', () => {
    const report = runDiagnostics(healthyDeps({ canWriteFile: () => false }), fakeClock());
    expect(byId(report.checks, 'database.writable').status).toBe('fail');
  });

  it('reports a not-yet-created database without failing', () => {
    const report = runDiagnostics(healthyDeps({ databaseSizeBytes: () => null }), fakeClock());
    expect(byId(report.checks, 'database.writable').status).toBe('pass');
    expect(byId(report.checks, 'database.writable').detail).toContain('not created yet');
  });

  it('fails when the path probe throws', () => {
    const report = runDiagnostics(
      healthyDeps({
        canWriteDirectory: () => {
          throw new Error('EPERM: operation not permitted, open C:\\secret\\path');
        },
      }),
      fakeClock()
    );
    const c = byId(report.checks, 'database.writable');
    expect(c.status).toBe('fail');
    // The thrown message must not become the detail — it quotes a path.
    expect(c.detail).not.toContain('secret');
  });
});

describe('schema and integrity', () => {
  it('fails on a schema version mismatch', () => {
    const report = runDiagnostics(healthyDeps({ schemaVersion: 0 }), fakeClock());
    const c = byId(report.checks, 'database.schema');
    expect(c.status).toBe('fail');
    expect(c.detail).toContain('v0');
    expect(c.detail).toContain('v1');
  });

  it('fails when quick_check reports problems', () => {
    const report = runDiagnostics(
      healthyDeps({ integrityCheck: () => ['row 3 missing from index idx_messages_date'] }),
      fakeClock()
    );
    const c = byId(report.checks, 'database.integrity');
    expect(c.status).toBe('fail');
    // The raw SQLite text is summarised, not echoed.
    expect(c.detail).not.toContain('idx_messages_date');
  });

  it('fails when quick_check returns nothing at all', () => {
    const report = runDiagnostics(healthyDeps({ integrityCheck: () => [] }), fakeClock());
    expect(byId(report.checks, 'database.integrity').status).toBe('fail');
  });
});

describe('node:sqlite probe', () => {
  it('fails when the probe returns the wrong value', () => {
    const report = runDiagnostics(healthyDeps({ probeQuery: () => 0 }), fakeClock());
    const c = byId(report.checks, 'sqlite.query');
    expect(c.status).toBe('fail');
    expect(c.detail).toContain('expected 1');
  });

  it('fails when the probe throws, without leaking the message', () => {
    const report = runDiagnostics(
      healthyDeps({
        probeQuery: () => {
          throw new TypeError('no such table: secrets; SELECT * FROM secrets WHERE ref = ?');
        },
      }),
      fakeClock()
    );
    const c = byId(report.checks, 'sqlite.query');
    expect(c.status).toBe('fail');
    expect(c.detail).toContain('TypeError');
    expect(c.detail).not.toContain('secrets');
    expect(c.detail).not.toContain('SELECT');
  });
});

describe('credential encryption', () => {
  it('fails when encryption is unavailable, and says why', () => {
    const report = runDiagnostics(
      healthyDeps({
        secureStorage: () => ({
          available: false,
          roundTrip: null,
          ciphertextDiffers: null,
          reason: 'Windows DPAPI reported no usable encryption for this user.',
        }),
      }),
      fakeClock()
    );
    const c = byId(report.checks, 'storage.encryption');
    expect(c.status).toBe('fail');
    expect(c.detail).toContain('DPAPI');
    // The crucial promise: no plaintext fallback.
    expect(c.detail).toContain('no plaintext fallback');
  });

  it('fails when the round trip did not return the original', () => {
    const report = runDiagnostics(
      healthyDeps({
        secureStorage: () => ({
          available: true,
          roundTrip: false,
          ciphertextDiffers: true,
          reason: null,
        }),
      }),
      fakeClock()
    );
    expect(byId(report.checks, 'storage.encryption').status).toBe('fail');
  });

  it('fails when the ciphertext equals the plaintext (silent fallback)', () => {
    const report = runDiagnostics(
      healthyDeps({
        secureStorage: () => ({
          available: true,
          roundTrip: true,
          ciphertextDiffers: false,
          reason: null,
        }),
      }),
      fakeClock()
    );
    const c = byId(report.checks, 'storage.encryption');
    expect(c.status).toBe('fail');
    expect(c.detail).toContain('identical to the plaintext');
  });

  it('fails when encryption throws, without leaking the message', () => {
    const report = runDiagnostics(
      healthyDeps({
        secureStorage: () => {
          throw new Error('DPAPI failed for blob AQAAANCMnd8BFdERjHoAwE/Cl+sBAAAA');
        },
      }),
      fakeClock()
    );
    const c = byId(report.checks, 'storage.encryption');
    expect(c.status).toBe('fail');
    expect(c.detail).not.toContain('AQAAANCMnd8BFdERjHoAwE');
  });
});

/* ------------------------------------------------------------------ *
 * Secret hygiene — the load-bearing tests
 * ------------------------------------------------------------------ */

describe('the report never carries a secret', () => {
  /** Values that must never appear anywhere in a report. */
  const SENTINELS = [
    'hunter2',
    'correct-horse-battery-staple',
    'ya29.a0AfH6SMBx-oauth-access-token',
    '1//0gL7-refresh-token',
    '-----BEGIN PRIVATE KEY-----',
  ];

  it('does not contain any sentinel even when every probe throws with it', () => {
    // Worst case: a buggy dependency throws an error whose message *is* a
    // credential. Every check must still swallow it.
    const leaky = (sentinel: string) => () => {
      throw new Error(`failed for value ${sentinel}`);
    };

    const deps = healthyDeps({
      canWriteDirectory: leaky(SENTINELS[0]!),
      canWriteFile: leaky(SENTINELS[1]!),
      integrityCheck: leaky(SENTINELS[2]!),
      probeQuery: leaky(SENTINELS[3]!),
      secureStorage: leaky(SENTINELS[4]!),
      databaseSizeBytes: leaky(SENTINELS[0]!),
    });

    const serialised = JSON.stringify(runDiagnostics(deps, fakeClock()));
    for (const sentinel of SENTINELS) {
      expect(serialised).not.toContain(sentinel);
    }
  });

  it('keeps secrets out of the clipboard text export', () => {
    const deps = healthyDeps({
      probeQuery: () => {
        throw new Error('token=1//0gL7-refresh-token');
      },
    });
    const text = reportToText(runDiagnostics(deps, fakeClock()));
    expect(text).not.toContain('1//0gL7-refresh-token');
  });

  it('contains no field shaped like a credential', () => {
    const report = runDiagnostics(healthyDeps(), fakeClock());
    const keys = new Set<string>();
    const walk = (v: unknown): void => {
      if (v && typeof v === 'object') {
        for (const [k, child] of Object.entries(v as Record<string, unknown>)) {
          keys.add(k.toLowerCase());
          walk(child);
        }
      }
    };
    walk(report);
    for (const forbidden of ['password', 'token', 'secret', 'ciphertext', 'credential']) {
      expect(keys.has(forbidden)).toBe(false);
    }
  });
});

/* ------------------------------------------------------------------ *
 * Redaction helpers
 * ------------------------------------------------------------------ */

describe('redactPath', () => {
  it('hides a Windows user name', () => {
    const out = redactPath('C:\\Users\\alice\\AppData\\Roaming\\Phutrue\\phutrue.db');
    expect(out).toBe('C:\\Users\\<user>\\AppData\\Roaming\\Phutrue\\phutrue.db');
    expect(out).not.toContain('alice');
  });

  it('hides a Unix user name', () => {
    const out = redactPath('/home/bob/.config/Phutrue/phutrue.db');
    expect(out).not.toContain('bob');
    expect(out).toContain('<user>');
  });

  it('leaves a path with no user component alone', () => {
    expect(redactPath('C:\\ProgramData\\Phutrue\\phutrue.db')).toBe(
      'C:\\ProgramData\\Phutrue\\phutrue.db'
    );
  });
});

describe('formatBytes', () => {
  it.each([
    [null, 'not created yet'],
    [512, '512 B'],
    [4096, '4.0 KB'],
    [5 * 1024 * 1024, '5.0 MB'],
  ])('formats %s', (input, expected) => {
    expect(formatBytes(input as number | null)).toBe(expected);
  });
});

describe('safeErrorKind', () => {
  it('reduces an error to its class', () => {
    expect(safeErrorKind(new TypeError('boom'))).toBe('TypeError');
  });

  it('strips characters that could carry a payload', () => {
    const err = new Error('x');
    err.name = 'bad name: with / payload';
    expect(safeErrorKind(err)).toBe('badnamewithpayload');
  });

  it('handles a non-Error throw', () => {
    expect(safeErrorKind('a string')).toBe('string');
    expect(safeErrorKind(undefined)).toBe('undefined');
  });

  it('is bounded in length', () => {
    const err = new Error('x');
    err.name = 'A'.repeat(500);
    expect(safeErrorKind(err).length).toBeLessThanOrEqual(40);
  });
});

/* ------------------------------------------------------------------ *
 * Report assembly
 * ------------------------------------------------------------------ */

describe('summarise', () => {
  const pass: DiagnosticCheck = { id: 'a', label: 'A', status: 'pass', detail: '', durationMs: 1 };
  const fail: DiagnosticCheck = { id: 'b', label: 'B', status: 'fail', detail: 'x', durationMs: 1 };
  const skip: DiagnosticCheck = { id: 'c', label: 'C', status: 'skip', detail: '', durationMs: 0 };

  it('is ok when nothing failed', () => {
    expect(summarise([pass, skip], 'win32', 1).ok).toBe(true);
  });

  it('is not ok when anything failed', () => {
    expect(summarise([pass, fail], 'win32', 1).ok).toBe(false);
  });

  it('is ok for an empty list', () => {
    // Vacuously true; the caller always supplies at least the bridge check.
    expect(summarise([], 'win32', 1).ok).toBe(true);
  });
});

describe('reportToText', () => {
  it('states the overall result and lists every check', () => {
    const report = summarise(
      [{ id: 'a', label: 'Alpha', status: 'pass', detail: 'fine', durationMs: 3 }],
      'win32',
      0
    );
    const text = reportToText(report);
    expect(text).toContain('ALL CHECKS PASSED');
    expect(text).toContain('[PASS] Alpha (a)');
    expect(text).toContain('fine');
  });

  it('announces failures', () => {
    const report = summarise(
      [{ id: 'b', label: 'Beta', status: 'fail', detail: 'broke', durationMs: 1 }],
      'win32',
      0
    );
    expect(reportToText(report)).toContain('FAILURES PRESENT');
  });

  it('omits the detail line when the detail is empty', () => {
    const report = summarise(
      [{ id: 'a', label: 'Alpha', status: 'pass', detail: '', durationMs: 1 }],
      'win32',
      0
    );
    expect(reportToText(report).split('\n')).toHaveLength(6); // 5 header + 1 row
  });
});

/* ------------------------------------------------------------------ *
 * Contract guards
 * ------------------------------------------------------------------ */

describe('diagnostics must stay frictionless', () => {
  it('is a no-argument channel, so it cannot be abused to probe other data', async () => {
    const { SCHEMAS } = await import('../src/main/ipc/schemas.js');
    expect(SCHEMAS['app:diagnostics']).toBeUndefined();
  });

  it('is declared in the runtime allowlist', async () => {
    const { CHANNELS } = await import('../src/shared/ipc.js');
    expect(CHANNELS).toContain('app:diagnostics');
  });

  /**
   * The tester-facing checklist states how many checks to expect. That sentence
   * drifted once already (it said 6 while 7 were listed), so it is pinned here:
   * 6 from the main process + 1 from the renderer (`bridge.ipc`).
   */
  it('produces the number of checks the Windows checklist promises', async () => {
    const { readFileSync } = await import('node:fs');
    const path = await import('node:path');
    const doc = readFileSync(
      path.resolve(__dirname, '..', 'docs', 'windows-verification.md'),
      'utf8'
    );

    const report = runDiagnostics(healthyDeps(), fakeClock());
    const MAIN_CHECKS = report.checks.length; // 6
    const RENDERER_CHECKS = 1; // bridge.ipc
    const total = MAIN_CHECKS + RENDERER_CHECKS;

    expect(MAIN_CHECKS).toBe(6);
    expect(doc).toContain(`all ${total} checks PASS`);
    expect(doc).toContain(`All ${total} checks must pass`);

    // And the table must document every id the app can emit.
    for (const check of report.checks) {
      expect(doc).toContain(check.id);
    }
    expect(doc).toContain('bridge.ipc');
  });
});

/* ------------------------------------------------------------------ *
 * Literal scrubbing
 *
 * Pattern-based path redaction is fallible: a UNC profile path or a relocated
 * %APPDATA% can carry the account name in a shape it does not recognise. These
 * tests cover the value-based backstop.
 * ------------------------------------------------------------------ */

describe('scrub', () => {
  it('removes every occurrence of a literal', () => {
    expect(scrub('C:\\x\\alice\\y and alice again', ['alice'])).toBe(
      'C:\\x\\<redacted>\\y and <redacted> again'
    );
  });

  it('is case-insensitive', () => {
    expect(scrub('Alice and ALICE', ['alice'])).toBe('<redacted> and <redacted>');
  });

  it('ignores literals too short to be meaningful', () => {
    // A one-letter user name must not mangle ordinary words.
    expect(scrub('a cat sat', ['a'])).toBe('a cat sat');
  });

  it('treats regex metacharacters literally', () => {
    expect(() => scrub('x a.b(c y', ['a.b(c'])).not.toThrow();
    expect(scrub('x a.b(c y', ['a.b(c'])).toBe('x <redacted> y');
  });

  it('is a no-op with no values', () => {
    expect(scrub('unchanged', [])).toBe('unchanged');
  });
});

describe('the report scrubs the account name even when the path pattern misses', () => {
  // A UNC path is a realistic Windows configuration (roaming profile on a share)
  // and `redactPath` does not recognise it.
  const UNC = '\\\\fileserver\\profiles\\alice$\\AppData\\Roaming\\Phutrue\\phutrue.db';

  it('redactPath alone would leak the name', () => {
    expect(redactPath(UNC)).toContain('alice');
  });

  it('the full report does not', () => {
    const report = runDiagnostics(
      healthyDeps({ databasePath: UNC, redactValues: ['alice'] }),
      fakeClock()
    );
    expect(JSON.stringify(report)).not.toContain('alice');
  });

  it('scrubs details produced by every check', () => {
    const report = runDiagnostics(
      healthyDeps({
        databasePath: 'C:\\Users\\alice\\phutrue.db',
        redactValues: ['alice'],
        // Force a failure whose detail would otherwise quote a literal.
        probeQuery: () => 0,
      }),
      fakeClock()
    );
    expect(JSON.stringify(report)).not.toContain('alice');
  });

  it('keeps the report readable rather than blanking it', () => {
    const report = runDiagnostics(
      healthyDeps({ databasePath: 'C:\\Users\\alice\\phutrue.db', redactValues: ['alice'] }),
      fakeClock()
    );
    const pathCheck = byId(report.checks, 'database.path');
    expect(pathCheck.status).toBe('pass');
    expect(pathCheck.detail).toContain('phutrue.db');
  });
});

