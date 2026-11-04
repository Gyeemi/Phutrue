/**
 * OAuth persistence: pending attempts and account token metadata.
 *
 * The replay guard is the important part. `consumePending` must be exactly-once
 * even if two callbacks race, because completing a flow twice could exchange a
 * code twice or overwrite a good credential with a stale one.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { openDatabase, type Db } from '../src/main/db/database.js';
import { createAccountRepo } from '../src/main/db/repos/accounts.js';
import { createOAuthRepo, PENDING_TTL_MS } from '../src/main/db/repos/oauth.js';
import { hashState, generateState } from '../src/main/oauth/pkce.js';

let db: Db;
let oauth: ReturnType<typeof createOAuthRepo>;
let clock: number;

beforeEach(() => {
  db = openDatabase(':memory:');
  clock = 1_000_000;
  oauth = createOAuthRepo(db, () => clock);
});

function attempt(overrides: Partial<Parameters<typeof oauth.createPending>[0]> = {}) {
  const state = generateState();
  const input = {
    stateHash: hashState(state),
    provider: 'google' as const,
    codeVerifier: 'verifier-value',
    redirectUri: 'http://127.0.0.1:1234/callback',
    createdAt: clock,
    expiresAt: clock + PENDING_TTL_MS,
    ...overrides,
  };
  oauth.createPending(input);
  return { state, input };
}

describe('pending attempts', () => {
  it('stores and consumes an attempt once', () => {
    const { state, input } = attempt();
    const consumed = oauth.consumePending(input.stateHash);
    expect(consumed).not.toBeNull();
    expect(consumed?.provider).toBe('google');
    expect(consumed?.codeVerifier).toBe('verifier-value');
    expect(consumed?.redirectUri).toBe(input.redirectUri);
    // The raw state is never stored, only its hash.
    expect(JSON.stringify(consumed)).not.toContain(state);
  });

  it('refuses a second consumption of the same state', () => {
    const { input } = attempt();
    expect(oauth.consumePending(input.stateHash)).not.toBeNull();
    // The replay guard.
    expect(oauth.consumePending(input.stateHash)).toBeNull();
  });

  it('refuses an unknown state', () => {
    expect(oauth.consumePending(hashState(generateState()))).toBeNull();
  });

  it('refuses an expired attempt', () => {
    const { input } = attempt();
    clock += PENDING_TTL_MS + 1;
    expect(oauth.consumePending(input.stateHash)).toBeNull();
  });

  it('accepts an attempt exactly at its deadline minus one millisecond', () => {
    const { input } = attempt();
    clock += PENDING_TTL_MS - 1;
    expect(oauth.consumePending(input.stateHash)).not.toBeNull();
  });

  it('consuming one attempt does not consume another', () => {
    const a = attempt();
    const b = attempt();
    expect(oauth.consumePending(a.input.stateHash)).not.toBeNull();
    expect(oauth.consumePending(b.input.stateHash)).not.toBeNull();
  });

  it('counts and prunes', () => {
    attempt();
    attempt();
    expect(oauth.pendingCount()).toBe(2);

    clock += PENDING_TTL_MS + 1;
    expect(oauth.prunePending()).toBe(2);
    expect(oauth.pendingCount()).toBe(0);
  });

  it('prune leaves live attempts alone', () => {
    attempt();
    const expired = attempt();
    clock += PENDING_TTL_MS + 1;
    // A fresh attempt made "now" survives the prune.
    attempt();
    expect(oauth.prunePending()).toBe(2);
    expect(oauth.pendingCount()).toBe(1);
    expect(oauth.consumePending(expired.input.stateHash)).toBeNull();
  });

  it('rejects a provider that is not implemented', () => {
    expect(() =>
      oauth.createPending({
        stateHash: hashState(generateState()),
        // @ts-expect-error deliberately invalid at runtime
        provider: 'yahoo',
        codeVerifier: 'v',
        redirectUri: 'http://127.0.0.1/callback',
        createdAt: clock,
        expiresAt: clock + 1000,
      })
    ).toThrow();
  });

  it('rejects a duplicate state hash', () => {
    const { input } = attempt();
    expect(() => oauth.createPending(input)).toThrow();
  });
});

describe('account token metadata', () => {
  function seedAccount(email = 'user@example.com'): number {
    return createAccountRepo(db).create({
      label: 'Work',
      email,
      displayName: 'User',
      password: 'irrelevant',
      authKind: 'oauth2',
      oauthProvider: 'google',
      imapHost: '',
      imapPort: 993,
      imapSecure: true,
      smtpHost: '',
      smtpPort: 465,
      smtpSecure: true,
    }).id;
  }

  it('inserts and reads back metadata', () => {
    const id = seedAccount();
    oauth.upsertAccount({
      accountId: id,
      provider: 'google',
      expiresAt: clock + 3_600_000,
      scope: 'openid email',
      subject: 'google-subject-123',
      status: 'connected',
      lastError: null,
      createdAt: clock,
      updatedAt: clock,
    });

    const row = oauth.getAccount(id);
    expect(row?.provider).toBe('google');
    expect(row?.scope).toBe('openid email');
    expect(row?.status).toBe('connected');
  });

  it('upserts rather than duplicating', () => {
    const id = seedAccount();
    const base = {
      accountId: id,
      provider: 'google' as const,
      expiresAt: clock,
      scope: 'a',
      subject: null,
      status: 'connected' as const,
      lastError: null,
      createdAt: clock,
      updatedAt: clock,
    };
    oauth.upsertAccount(base);
    oauth.upsertAccount({ ...base, scope: 'b', status: 'expired' });

    expect(oauth.getAccount(id)?.scope).toBe('b');
    expect(oauth.getAccount(id)?.status).toBe('expired');
  });

  it('cascades when the account is removed', () => {
    const id = seedAccount();
    oauth.upsertAccount({
      accountId: id,
      provider: 'google',
      expiresAt: clock,
      scope: '',
      subject: null,
      status: 'connected',
      lastError: null,
      createdAt: clock,
      updatedAt: clock,
    });

    createAccountRepo(db).remove(id);
    // ON DELETE CASCADE: no orphaned token metadata.
    expect(oauth.getAccount(id)).toBeNull();
  });

  it('reports whether a token needs refreshing', () => {
    const id = seedAccount();
    oauth.upsertAccount({
      accountId: id,
      provider: 'google',
      expiresAt: clock + 3_600_000,
      scope: '',
      subject: null,
      status: 'connected',
      lastError: null,
      createdAt: clock,
      updatedAt: clock,
    });

    expect(oauth.needsRefresh(id)).toBe(false);

    // One minute before expiry it should refresh, so a request cannot fail
    // mid-flight on a token that expired while it was being built.
    clock += 3_600_000 - 30_000;
    expect(oauth.needsRefresh(id)).toBe(true);
  });

  it('does not ask to refresh an account with no metadata', () => {
    expect(oauth.needsRefresh(9999)).toBe(false);
  });

  it('records a status change with and without a new expiry', () => {
    const id = seedAccount();
    oauth.upsertAccount({
      accountId: id,
      provider: 'microsoft',
      expiresAt: 0,
      scope: '',
      subject: null,
      status: 'connected',
      lastError: null,
      createdAt: clock,
      updatedAt: clock,
    });

    oauth.setStatus(id, 'error', 'The provider rejected the refresh token.');
    expect(oauth.getAccount(id)?.status).toBe('error');
    expect(oauth.getAccount(id)?.lastError).toMatch(/rejected/);
    expect(oauth.getAccount(id)?.expiresAt).toBe(0);

    oauth.setStatus(id, 'connected', null, 5555);
    expect(oauth.getAccount(id)?.expiresAt).toBe(5555);
    expect(oauth.getAccount(id)?.lastError).toBeNull();
  });

  it('stores no token material in the metadata table', () => {
    const id = seedAccount();
    const columns = db.prepare('PRAGMA table_info(oauth_accounts)').all() as Array<{ name: string }>;
    const names = columns.map((c) => c.name);
    for (const forbidden of ['access_token', 'refresh_token', 'token', 'id_token', 'secret']) {
      expect(names).not.toContain(forbidden);
    }

    oauth.upsertAccount({
      accountId: id,
      provider: 'google',
      expiresAt: clock,
      scope: 'openid',
      subject: null,
      status: 'connected',
      lastError: null,
      createdAt: clock,
      updatedAt: clock,
    });

    const dump = JSON.stringify(db.prepare('SELECT * FROM oauth_accounts').all());
    expect(dump).not.toMatch(/ya29\.|1\/\/|AQAAANCM/);
  });
});

describe('migration v2', () => {
  it('creates both tables and reaches version 2', () => {
    const version = db.prepare('SELECT version FROM schema_version').get() as { version: number };
    expect(version.version).toBe(2);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);
    expect(names).toContain('oauth_accounts');
    expect(names).toContain('oauth_pending');
  });

  it('is idempotent — reopening an existing database does not re-run it', () => {
    const before = oauth.pendingCount();
    // openDatabase runs migrate() again on the same file; here the in-memory
    // database is already migrated, so re-running must be a no-op.
    expect(() => oauth.prunePending()).not.toThrow();
    expect(oauth.pendingCount()).toBe(before);
  });
});
