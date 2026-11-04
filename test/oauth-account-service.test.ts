/**
 * The OAuth account service, end to end without a provider.
 *
 * Every external effect is injected: the browser (`openExternal`), the network
 * (`fetchImpl`), the clock, and the tokens come from a fake token endpoint. The
 * loopback listener is real, so the callback path is genuinely exercised — the
 * test plays the part of the provider's redirect.
 *
 * What these tests are really protecting:
 *   - state validation actually rejects a forged callback;
 *   - a replay is rejected;
 *   - a failure leaves no account, no secret and no pending row behind;
 *   - no token ever appears in a returned value or an error message.
 */

import { describe, expect, it, vi } from 'vitest';

// `secrets/store.ts` imports `electron` for safeStorage at module load, and the
// Electron binary cannot be installed in this environment. The store under test
// here is a fake anyway; real safeStorage is exercised only on a real machine.
vi.mock('electron', () => ({
  safeStorage: { isEncryptionAvailable: () => true, encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString() },
}));
import type { DatabaseSync } from 'node:sqlite';
import { request } from 'node:http';

import { openDatabase } from '../src/main/db/database.js';
import { createAccountRepo } from '../src/main/db/repos/accounts.js';
import { createOAuthRepo } from '../src/main/db/repos/oauth.js';
import { createAccountService } from '../src/main/oauth/account-service.js';
import {
  serialiseTokens,
  parseStoredTokens,
  emailFromIdToken,
  tokensFromResponse,
} from '../src/main/oauth/account-service.js';
import { oauthTokenRef } from '../src/main/secrets/store.js';
import { AppError } from '../src/shared/result.js';
import type { SecretStore } from '../src/main/secrets/store.js';

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

const ENV = {
  PHUTRUE_GOOGLE_CLIENT_ID: 'test-google-client-id.apps.googleusercontent.com',
  PHUTRUE_MICROSOFT_CLIENT_ID: 'test-microsoft-client-id',
} as NodeJS.ProcessEnv;

/** A base64url JWT body with no real signature. */
function fakeIdToken(claims: Record<string, unknown>): string {
  const enc = (o: unknown) =>
    Buffer.from(JSON.stringify(o)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${enc({ alg: 'RS256' })}.${enc(claims)}.not-a-real-signature`;
}

/**
 * An in-memory SecretStore that records what was written.
 *
 * Deliberately stores plaintext, because the point of these tests is the
 * service's behaviour; the encryption itself is safeStorage's, tested separately
 * and only verifiable on Windows. `written` lets a test assert that what the
 * service handed over was the JSON bundle and nothing else.
 */
function fakeSecrets(): SecretStore & { written: Map<string, string>; deleted: string[] } {
  const map = new Map<string, string>();
  const deleted: string[] = [];
  return {
    written: map,
    deleted,
    available: () => true,
    reason: () => null,
    put: (ref, value) => void map.set(ref, value),
    get: (ref) => map.get(ref) ?? null,
    delete: (ref) => {
      deleted.push(ref);
      map.delete(ref);
    },
    has: (ref) => map.has(ref),
  };
}

/** A token endpoint that returns a fixed success response. */
function successFetch(claims: Record<string, unknown> = { email: 'user@example.com', name: 'Test User' }) {
  const calls: Array<Record<string, string>> = [];
  return {
    calls,
    fetchImpl: async (_url: string, init: RequestInit) => {
      calls.push(Object.fromEntries(new URLSearchParams(String(init.body))));
      return new Response(
        JSON.stringify({
          access_token: 'ya29.SECRET-ACCESS-TOKEN',
          refresh_token: '1//SECRET-REFRESH-TOKEN',
          expires_in: 3600,
          scope: 'openid email',
          token_type: 'Bearer',
          id_token: fakeIdToken(claims),
        }),
        { status: 200 }
      );
    },
  };
}

/** Play the provider: hit the listener with a callback. */
function deliverCallback(redirectUri: string, query: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(`${redirectUri}?${query}`, { method: 'GET' }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode ?? 0));
    });
    req.on('error', reject);
    req.end();
  });
}

interface Harness {
  db: DatabaseSync;
  secrets: ReturnType<typeof fakeSecrets>;
  service: ReturnType<typeof createAccountService>;
  opened: string[];
  clock: () => number;
  setClock: (v: number) => void;
}

function harness(opts: { fetchImpl?: (u: string, i: RequestInit) => Promise<Response>; env?: NodeJS.ProcessEnv } = {}): Harness {
  const db = openDatabase(':memory:');
  const secrets = fakeSecrets();
  const opened: string[] = [];
  let now = 1_700_000_000_000;

  const service = createAccountService({
    db,
    secrets,
    env: opts.env ?? ENV,
    openExternal: (url) => void opened.push(url),
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    clock: () => now,
    timeoutMs: 3000,
  });

  return {
    db,
    secrets,
    service,
    opened,
    clock: () => now,
    setClock: (v) => {
      now = v;
    },
  };
}

/**
 * Begin a sign-in and hand the browser URL to the test.
 *
 * The state the service generated is only visible in the authorisation URL,
 * which is exactly where an attacker would get it from too.
 */
async function begin(h: Harness, provider: 'google' | 'microsoft' = 'google') {
  const started = await h.service.beginSignIn({ provider });
  const url = new URL(started.authorizationUrl);
  return {
    ...started,
    state: url.searchParams.get('state') ?? '',
    challenge: url.searchParams.get('code_challenge') ?? '',
    clientId: url.searchParams.get('client_id') ?? '',
  };
}

/* ------------------------------------------------------------------ *
 * Configuration
 * ------------------------------------------------------------------ */

describe('provider configuration', () => {
  it('refuses to start without a client ID, naming the variable to set', async () => {
    const h = harness({ env: {} });
    await expect(h.service.beginSignIn({ provider: 'google' })).rejects.toThrow(/PHUTRUE_GOOGLE_CLIENT_ID/);
  });

  it('fails with OAUTH_NOT_CONFIGURED rather than a generic error', async () => {
    const h = harness({ env: {} });
    try {
      await h.service.beginSignIn({ provider: 'microsoft' });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).code).toBe('OAUTH_NOT_CONFIGURED');
    }
  });

  it('rejects an unsupported provider', async () => {
    const h = harness();
    await expect(h.service.beginSignIn({ provider: 'yahoo' })).rejects.toThrow(/supported provider/i);
  });

  it('does not open a listener when configuration is missing', async () => {
    const h = harness({ env: {} });
    await expect(h.service.beginSignIn({ provider: 'google' })).rejects.toThrow();
    // No pending attempt should have been persisted either.
    expect(createOAuthRepo(h.db).pendingCount()).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * Beginning a flow
 * ------------------------------------------------------------------ */

describe('beginSignIn', () => {
  it('returns an authorisation URL using the configured client ID', async () => {
    const h = harness();
    const begun = await begin(h);
    expect(begun.authorizationUrl).toContain('accounts.google.com');
    expect(begun.clientId).toBe(ENV['PHUTRUE_GOOGLE_CLIENT_ID']);
    h.service.cancel(begun.attemptId);
  });

  it('uses S256 and a 43-character challenge', async () => {
    const h = harness();
    const begun = await begin(h);
    const url = new URL(begun.authorizationUrl);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(begun.challenge).toHaveLength(43);
    h.service.cancel(begun.attemptId);
  });

  it('persists exactly one pending attempt, storing a hash rather than the state', async () => {
    const h = harness();
    const begun = await begin(h);
    expect(createOAuthRepo(h.db).pendingCount()).toBe(1);

    const row = h.db.prepare('SELECT * FROM oauth_pending').get() as Record<string, unknown>;
    // The raw state travels through the browser, so it must not be in the row.
    expect(JSON.stringify(row)).not.toContain(begun.state);
    h.service.cancel(begun.attemptId);
  });

  it('gives each attempt a distinct state and challenge', async () => {
    const h = harness();
    const a = await begin(h);
    const b = await begin(h);
    expect(a.state).not.toBe(b.state);
    expect(a.challenge).not.toBe(b.challenge);
    h.service.cancel(a.attemptId);
    h.service.cancel(b.attemptId);
  });

  it('does not open the browser itself', async () => {
    // Opening is a separate, explicit step so the caller controls the one
    // side effect and tests can inspect the URL first.
    const h = harness();
    const begun = await begin(h);
    expect(h.opened).toEqual([]);
    h.service.openInBrowser(begun.attemptId);
    expect(h.opened).toHaveLength(1);
    expect(h.opened[0]).toBe(begun.authorizationUrl);
    h.service.cancel(begun.attemptId);
  });

  it('prunes abandoned attempts from a previous session', async () => {
    const h = harness();
    const repo = createOAuthRepo(h.db, h.clock);
    repo.createPending({
      stateHash: 'a'.repeat(64),
      provider: 'google',
      codeVerifier: 'v',
      redirectUri: 'http://127.0.0.1:1/callback',
      createdAt: 0,
      expiresAt: 1, // long expired
    });

    const begun = await begin(h);
    // The stale row is gone; only the new attempt remains.
    expect(repo.pendingCount()).toBe(1);
    h.service.cancel(begun.attemptId);
  });
});

/* ------------------------------------------------------------------ *
 * Completing a flow
 * ------------------------------------------------------------------ */

describe('completeSignIn — success', () => {
  it('creates an account and stores tokens encrypted', async () => {
    const { fetchImpl } = successFetch();
    const h = harness({ fetchImpl });
    const begun = await begin(h);

    const completion = h.service.completeSignIn(begun.attemptId);
    await deliverCallback(begun.redirectUri, `code=auth-code&state=${begun.state}`);
    const account = await completion;

    expect(account.email).toBe('user@example.com');
    expect(account.authKind).toBe('oauth2');
    expect(account.oauthProvider).toBe('google');

    // Credentials reached the secret store...
    const stored = h.secrets.written.get(oauthTokenRef(account.id));
    expect(stored).toBeDefined();
    expect(parseStoredTokens(stored ?? null)?.accessToken).toBe('ya29.SECRET-ACCESS-TOKEN');
  });

  it('returns an account object containing no token', async () => {
    const { fetchImpl } = successFetch();
    const h = harness({ fetchImpl });
    const begun = await begin(h);
    const completion = h.service.completeSignIn(begun.attemptId);
    await deliverCallback(begun.redirectUri, `code=c&state=${begun.state}`);
    const account = await completion;

    const serialised = JSON.stringify(account);
    expect(serialised).not.toContain('SECRET-ACCESS-TOKEN');
    expect(serialised).not.toContain('SECRET-REFRESH-TOKEN');
    expect(Object.keys(account)).not.toContain('accessToken');
    expect(Object.keys(account)).not.toContain('refreshToken');
  });

  it('exchanges the code with the matching PKCE verifier', async () => {
    const { fetchImpl, calls } = successFetch();
    const h = harness({ fetchImpl });
    const begun = await begin(h);
    const completion = h.service.completeSignIn(begun.attemptId);
    await deliverCallback(begun.redirectUri, `code=the-code&state=${begun.state}`);
    await completion;

    expect(calls).toHaveLength(1);
    expect(calls[0]?.['grant_type']).toBe('authorization_code');
    expect(calls[0]?.['code']).toBe('the-code');
    expect(calls[0]?.['code_verifier']).toBeTruthy();
    // The redirect_uri must be exactly what was used for authorisation.
    expect(calls[0]?.['redirect_uri']).toBe(begun.redirectUri);
  });

  it('burns the pending attempt so it cannot be used twice', async () => {
    const { fetchImpl } = successFetch();
    const h = harness({ fetchImpl });
    const begun = await begin(h);
    const completion = h.service.completeSignIn(begun.attemptId);
    await deliverCallback(begun.redirectUri, `code=c&state=${begun.state}`);
    await completion;

    // The row is retained but marked consumed: deleting it would lose the
    // record that this state was already spent, which is what stops a replay.
    const row = h.db.prepare('SELECT consumed_at FROM oauth_pending').get() as { consumed_at: number | null };
    expect(row.consumed_at).not.toBeNull();

    // A second consumption of the same state returns nothing.
    const { hashState } = await import('../src/main/oauth/pkce.js');
    expect(createOAuthRepo(h.db, h.clock).consumePending(hashState(begun.state))).toBeNull();
  });

  it('records token metadata without token material', async () => {
    const { fetchImpl } = successFetch();
    const h = harness({ fetchImpl });
    const begun = await begin(h);
    const completion = h.service.completeSignIn(begun.attemptId);
    await deliverCallback(begun.redirectUri, `code=c&state=${begun.state}`);
    const account = await completion;

    const meta = createOAuthRepo(h.db).getAccount(account.id);
    expect(meta?.status).toBe('connected');
    expect(meta?.expiresAt).toBeGreaterThan(h.clock());
    const dump = JSON.stringify(h.db.prepare('SELECT * FROM oauth_accounts').all());
    expect(dump).not.toContain('SECRET-ACCESS-TOKEN');
  });

  it('uses the supplied label', async () => {
    const { fetchImpl } = successFetch();
    const h = harness({ fetchImpl });
    const begun = await begin(h);
    const completion = h.service.completeSignIn(begun.attemptId, 'Personal mail');
    await deliverCallback(begun.redirectUri, `code=c&state=${begun.state}`);
    const account = await completion;
    expect(account.label).toBe('Personal mail');
  });

  it('does not create a duplicate account for the same address', async () => {
    const { fetchImpl } = successFetch();
    const h = harness({ fetchImpl });

    for (let i = 0; i < 2; i++) {
      const begun = await begin(h);
      const completion = h.service.completeSignIn(begun.attemptId);
      await deliverCallback(begun.redirectUri, `code=c${i}&state=${begun.state}`);
      await completion;
    }

    expect(createAccountRepo(h.db).list()).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ *
 * State validation — the core defence
 * ------------------------------------------------------------------ */

describe('completeSignIn — forged callbacks', () => {
  it('rejects a callback whose state does not match', async () => {
    const { fetchImpl } = successFetch();
    const h = harness({ fetchImpl });
    const begun = await begin(h);

    const completion = h.service.completeSignIn(begun.attemptId);
    // A plausible but wrong state: right shape, wrong value.
    const forged = `${begun.state.slice(0, -1)}${begun.state.endsWith('A') ? 'B' : 'A'}`;
    await deliverCallback(begun.redirectUri, `code=attacker&state=${forged}`);

    await expect(completion).rejects.toThrow(/did not match/i);
  });

  it('creates no account and stores no token when the state is wrong', async () => {
    const { fetchImpl, calls } = successFetch();
    const h = harness({ fetchImpl });
    const begun = await begin(h);

    const completion = h.service.completeSignIn(begun.attemptId);
    await deliverCallback(begun.redirectUri, `code=attacker&state=${'z'.repeat(43)}`);
    await expect(completion).rejects.toThrow();

    // The code was never exchanged, no account exists, no secret was written.
    expect(calls).toHaveLength(0);
    expect(createAccountRepo(h.db).list()).toHaveLength(0);
    expect(h.secrets.written.size).toBe(0);
  });

  it('rejects a second, replayed callback for the same attempt', async () => {
    const { fetchImpl } = successFetch();
    const h = harness({ fetchImpl });
    const begun = await begin(h);

    const completion = h.service.completeSignIn(begun.attemptId);
    await deliverCallback(begun.redirectUri, `code=c&state=${begun.state}`);
    await completion;

    // The attempt is gone from the in-flight map.
    await expect(h.service.completeSignIn(begun.attemptId)).rejects.toThrow(/no longer active/i);
  });

  it('rejects an attempt id that was never issued', async () => {
    const h = harness();
    await expect(h.service.completeSignIn('a'.repeat(32))).rejects.toThrow(/no longer active/i);
  });

  it('rejects a callback with no state at all', async () => {
    const { fetchImpl } = successFetch();
    const h = harness({ fetchImpl });
    const begun = await begin(h);

    const completion = h.service.completeSignIn(begun.attemptId);
    await deliverCallback(begun.redirectUri, 'code=orphan-code');
    await expect(completion).rejects.toThrow();
  });
});

/* ------------------------------------------------------------------ *
 * Provider errors and abandonment
 * ------------------------------------------------------------------ */

describe('completeSignIn — failures', () => {
  it('reports a user cancellation distinctly', async () => {
    const h = harness();
    const begun = await begin(h);
    const completion = h.service.completeSignIn(begun.attemptId);
    await deliverCallback(begun.redirectUri, `error=access_denied&state=${begun.state}`);

    try {
      await completion;
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as AppError).code).toBe('OAUTH_CANCELLED');
      expect((err as AppError).safeMessage).toMatch(/cancelled/i);
    }
  });

  it('leaves nothing behind after a cancellation', async () => {
    const h = harness();
    const begun = await begin(h);
    const completion = h.service.completeSignIn(begun.attemptId);
    await deliverCallback(begun.redirectUri, `error=access_denied&state=${begun.state}`);
    await expect(completion).rejects.toThrow();

    expect(createAccountRepo(h.db).list()).toHaveLength(0);
    expect(h.secrets.written.size).toBe(0);
  });

  it('reports a token-exchange failure without leaking the provider message', async () => {
    const h = harness({
      fetchImpl: async () =>
        new Response(
          JSON.stringify({ error: 'invalid_grant', error_description: 'bad code at https://internal.example' }),
          { status: 400 }
        ),
    });
    const begun = await begin(h);
    const completion = h.service.completeSignIn(begun.attemptId);
    await deliverCallback(begun.redirectUri, `code=c&state=${begun.state}`);

    try {
      await completion;
      expect.unreachable('should have thrown');
    } catch (err) {
      const message = (err as Error).message;
      expect(message).not.toContain('internal.example');
      expect(message).not.toContain('bad code');
    }
  });

  it('does not create an account when the token exchange fails', async () => {
    const h = harness({ fetchImpl: async () => new Response('', { status: 500 }) });
    const begun = await begin(h);
    const completion = h.service.completeSignIn(begun.attemptId);
    await deliverCallback(begun.redirectUri, `code=c&state=${begun.state}`);
    await expect(completion).rejects.toThrow();
    expect(createAccountRepo(h.db).list()).toHaveLength(0);
  });

  it('rejects a token response with no identity, rather than creating a nameless account', async () => {
    const h = harness({ fetchImpl: successFetch({}).fetchImpl });
    const begun = await begin(h);
    const completion = h.service.completeSignIn(begun.attemptId);
    await deliverCallback(begun.redirectUri, `code=c&state=${begun.state}`);
    await expect(completion).rejects.toThrow(/address/i);
    expect(createAccountRepo(h.db).list()).toHaveLength(0);
  });

  it('can be cancelled by the caller', async () => {
    const h = harness();
    const begun = await begin(h);
    const completion = h.service.completeSignIn(begun.attemptId);
    h.service.cancel(begun.attemptId);
    await expect(completion).rejects.toThrow(/cancelled/i);
  });

  it('times out and reports it', async () => {
    const db = openDatabase(':memory:');
    const service = createAccountService({
      db,
      secrets: fakeSecrets(),
      env: ENV,
      openExternal: () => {},
      clock: Date.now,
      timeoutMs: 80,
    });
    const started = await service.beginSignIn({ provider: 'google' });
    await expect(service.completeSignIn(started.attemptId)).rejects.toThrow(/timed out/i);
  });
});

/* ------------------------------------------------------------------ *
 * Token refresh
 * ------------------------------------------------------------------ */

describe('ensureAccessToken', () => {
  /** Complete a sign-in, returning the created account id. */
  async function signedIn(opts: { expiresIn?: number } = {}) {
    const fetchImpl = async (_u: string, init: RequestInit) => {
      const body = Object.fromEntries(new URLSearchParams(String(init.body)));
      if (body['grant_type'] === 'refresh_token') {
        return new Response(
          JSON.stringify({ access_token: 'ya29.REFRESHED', expires_in: 3600, token_type: 'Bearer' }),
          { status: 200 }
        );
      }
      return new Response(
        JSON.stringify({
          access_token: 'ya29.ORIGINAL',
          refresh_token: '1//REFRESH',
          expires_in: opts.expiresIn ?? 3600,
          scope: 'openid',
          token_type: 'Bearer',
          id_token: fakeIdToken({ email: 'refresh@example.com', name: 'R' }),
        }),
        { status: 200 }
      );
    };

    const h = harness({ fetchImpl });
    const begun = await begin(h);
    const completion = h.service.completeSignIn(begun.attemptId);
    await deliverCallback(begun.redirectUri, `code=c&state=${begun.state}`);
    const account = await completion;
    return { h, account };
  }

  it('returns the current token when it is still valid', async () => {
    const { h, account } = await signedIn();
    await expect(h.service.ensureAccessToken(account.id)).resolves.toBe('ya29.ORIGINAL');
  });

  it('refreshes once the token is inside the refresh window, keeping the refresh token', async () => {
    const { h, account } = await signedIn();
    // Jump to 30 seconds before expiry: inside the 60s skew.
    h.setClock(h.clock() + 3600_000 - 30_000);

    const token = await h.service.ensureAccessToken(account.id);
    expect(token).toBe('ya29.REFRESHED');

    // The provider did not rotate the refresh token, so the original must survive.
    const stored = parseStoredTokens(h.secrets.get(oauthTokenRef(account.id)));
    expect(stored?.refreshToken).toBe('1//REFRESH');
  });

  it('marks the account revoked when the provider rejects the refresh', async () => {
    const h = harness({
      fetchImpl: async (_u, init) => {
        const body = Object.fromEntries(new URLSearchParams(String(init.body)));
        if (body['grant_type'] === 'refresh_token') {
          return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 });
        }
        return new Response(
          JSON.stringify({
            access_token: 'a',
            refresh_token: 'r',
            expires_in: 1,
            token_type: 'Bearer',
            id_token: fakeIdToken({ email: 'revoked@example.com' }),
          }),
          { status: 200 }
        );
      },
    });

    const begun = await begin(h);
    const completion = h.service.completeSignIn(begun.attemptId);
    await deliverCallback(begun.redirectUri, `code=c&state=${begun.state}`);
    const account = await completion;

    h.setClock(h.clock() + 60_000);
    await expect(h.service.ensureAccessToken(account.id)).rejects.toThrow();

    const meta = createOAuthRepo(h.db).getAccount(account.id);
    expect(meta?.status).toBe('revoked');
    expect(meta?.lastError).toBeTruthy();
  });

  it('refuses an account with no stored credential', async () => {
    const h = harness();
    const account = createAccountRepo(h.db).create({
      label: 'x',
      email: 'x@example.com',
      displayName: '',
      password: '',
      authKind: 'oauth2',
      oauthProvider: 'google',
      imapHost: '',
      imapPort: 993,
      imapSecure: true,
      smtpHost: '',
      smtpPort: 465,
      smtpSecure: true,
    });
    await expect(h.service.ensureAccessToken(account.id)).rejects.toThrow(/reconnect/i);
  });
});

/* ------------------------------------------------------------------ *
 * Removal
 * ------------------------------------------------------------------ */

describe('removeAccount', () => {
  it('deletes the stored credential and the account', async () => {
    const { fetchImpl } = successFetch();
    const h = harness({ fetchImpl });
    const begun = await begin(h);
    const completion = h.service.completeSignIn(begun.attemptId);
    await deliverCallback(begun.redirectUri, `code=c&state=${begun.state}`);
    const account = await completion;

    expect(h.secrets.has(oauthTokenRef(account.id))).toBe(true);

    h.service.removeAccount(account.id);

    expect(h.secrets.has(oauthTokenRef(account.id))).toBe(false);
    expect(createAccountRepo(h.db).list()).toHaveLength(0);
    // Token metadata cascades with the account row.
    expect(createOAuthRepo(h.db).getAccount(account.id)).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * Credential serialisation
 * ------------------------------------------------------------------ */

describe('token serialisation', () => {
  it('round-trips a bundle', () => {
    const tokens = {
      accessToken: 'at',
      refreshToken: 'rt',
      idToken: 'id',
      expiresAt: 123,
      scope: 'openid',
      tokenType: 'Bearer',
    };
    expect(parseStoredTokens(serialiseTokens(tokens))).toEqual(tokens);
  });

  it('treats a corrupt blob as no credential rather than throwing', () => {
    // A crash during sync is worse than asking the user to sign in again.
    for (const bad of ['not json', '{}', '{"v":2,"access_token":"x"}', '{"v":1}', 'null', '']) {
      expect(() => parseStoredTokens(bad)).not.toThrow();
      expect(parseStoredTokens(bad)).toBeNull();
    }
  });

  it('keeps the previous refresh token when a refresh response omits it', () => {
    const tokens = tokensFromResponse(
      { accessToken: 'new', refreshToken: null, expiresIn: 60, scope: null, idToken: null, tokenType: 'Bearer' },
      1000,
      'existing-refresh'
    );
    expect(tokens.refreshToken).toBe('existing-refresh');
    expect(tokens.expiresAt).toBe(61_000);
  });

  it('records expiry 0 when the provider did not say', () => {
    const tokens = tokensFromResponse(
      { accessToken: 'a', refreshToken: null, expiresIn: null, scope: null, idToken: null, tokenType: 'Bearer' },
      1000,
      null
    );
    expect(tokens.expiresAt).toBe(0);
  });
});

describe('emailFromIdToken', () => {
  it('reads a well-formed claim', () => {
    expect(emailFromIdToken(fakeIdToken({ email: 'a@b.co', name: 'A' }))).toEqual({
      email: 'a@b.co',
      name: 'A',
    });
  });

  it('falls back to preferred_username and upn', () => {
    expect(emailFromIdToken(fakeIdToken({ preferred_username: 'u@t.co' }))?.email).toBe('u@t.co');
    expect(emailFromIdToken(fakeIdToken({ upn: 'v@t.co' }))?.email).toBe('v@t.co');
  });

  it('returns null for a malformed token rather than throwing', () => {
    for (const bad of [null, '', 'a.b', 'not-a-jwt', 'a.!!!.c']) {
      expect(() => emailFromIdToken(bad)).not.toThrow();
      expect(emailFromIdToken(bad)).toBeNull();
    }
  });

  it('rejects a claim that is not an address', () => {
    expect(emailFromIdToken(fakeIdToken({ email: 'not-an-address' }))).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * State reporting for the UI
 * ------------------------------------------------------------------ */

describe('stateFor', () => {
  async function signedIn() {
    const { fetchImpl } = successFetch();
    const h = harness({ fetchImpl });
    const begun = await begin(h);
    const completion = h.service.completeSignIn(begun.attemptId);
    await deliverCallback(begun.redirectUri, `code=c&state=${begun.state}`);
    const account = await completion;
    return { h, account };
  }

  it('reports a connected account without disclosing the token', async () => {
    const { h, account } = await signedIn();
    const state = h.service.stateFor(account.id);

    expect(state.status).toBe('connected');
    expect(state.provider).toBe('google');
    expect(state.hasAccessToken).toBe(true);
    expect(state.canRefresh).toBe(true);

    const serialised = JSON.stringify(state);
    expect(serialised).not.toContain('SECRET-ACCESS-TOKEN');
    expect(serialised).not.toContain('SECRET-REFRESH-TOKEN');
  });

  it('reports hasAccessToken false once inside the refresh window', async () => {
    const { h, account } = await signedIn();
    h.setClock(h.clock() + 3600_000 - 30_000);
    expect(h.service.stateFor(account.id).hasAccessToken).toBe(false);
  });

  it('reports canRefresh false when no refresh token was issued', async () => {
    // Some providers omit the refresh token on repeat consent.
    const h = harness({
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            access_token: 'a',
            expires_in: 3600,
            token_type: 'Bearer',
            id_token: fakeIdToken({ email: 'noref@example.com' }),
          }),
          { status: 200 }
        ),
    });
    const begun = await begin(h);
    const completion = h.service.completeSignIn(begun.attemptId);
    await deliverCallback(begun.redirectUri, `code=c&state=${begun.state}`);
    const account = await completion;

    expect(h.service.stateFor(account.id).canRefresh).toBe(false);
  });

  it('throws NOT_FOUND for a non-OAuth account', async () => {
    const h = harness();
    const account = createAccountRepo(h.db).create({
      label: 'imap',
      email: 'imap@example.com',
      displayName: '',
      password: 'pw',
      authKind: 'password',
      oauthProvider: null,
      imapHost: 'imap.example.com',
      imapPort: 993,
      imapSecure: true,
      smtpHost: 'smtp.example.com',
      smtpPort: 465,
      smtpSecure: true,
    });
    expect(() => h.service.stateFor(account.id)).toThrow(/not connected with OAuth/i);
  });
});
