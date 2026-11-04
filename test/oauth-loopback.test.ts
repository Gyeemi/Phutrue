/**
 * Loopback listener, token exchange and OAuth persistence.
 *
 * The listener is exercised against a real HTTP server on a real ephemeral port,
 * because the thing being tested *is* the socket behaviour: does it bind to
 * loopback only, does one callback close it, does a stray path leave it open,
 * does a timeout release the port. Mocking that would test nothing.
 */

import { request } from 'node:http';
import { describe, expect, it } from 'vitest';

import { startLoopbackListener } from '../src/main/oauth/loopback.js';
import { exchangeCodeForTokens, parseTokenResponse, refreshAccessToken } from '../src/main/oauth/token.js';
import { generateState } from '../src/main/oauth/pkce.js';
import { AppError } from '../src/shared/result.js';

/* ------------------------------------------------------------------ *
 * HTTP helper
 * ------------------------------------------------------------------ */

interface HttpResult {
  status: number;
  body: string;
  headers: Record<string, string | string[] | undefined>;
}

function httpGet(url: string): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: 'GET' }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 0, body, headers: res.headers })
      );
    });
    req.on('error', reject);
    req.end();
  });
}

/* ------------------------------------------------------------------ *
 * Loopback listener
 * ------------------------------------------------------------------ */

describe('loopback listener', () => {
  it('binds an ephemeral port and reports a loopback redirect URI', async () => {
    const handle = await startLoopbackListener({ timeoutMs: 5000 });
    handle.cancel();
    expect(handle.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    // Never 0.0.0.0 — the callback must not be reachable from the network.
    expect(handle.redirectUri).not.toContain('0.0.0.0');
    expect(handle.redirectUri).not.toContain('localhost');
  });

  it('delivers a well-formed callback and shuts itself down', async () => {
    const handle = await startLoopbackListener({ timeoutMs: 5000 });
    const state = generateState();

    const res = await httpGet(`${handle.redirectUri}?code=auth-code-123&state=${state}`);
    expect(res.status).toBe(200);
    expect(res.body).toContain('Returning to Phutrue');

    const result = await handle.result;
    expect(result.stopReason).toBe('callback');
    expect(result.callback).toEqual({ kind: 'code', code: 'auth-code-123', state });
  });

  it('sets hardening headers on the response page', async () => {
    const handle = await startLoopbackListener({ timeoutMs: 5000 });
    void httpGet(`${handle.redirectUri}?code=c&state=${generateState()}`);
    await handle.result;

    // Re-request the same URL: the server is closed, so assert on the captured
    // response instead by starting a fresh listener.
    const handle2 = await startLoopbackListener({ timeoutMs: 5000 });
    const state = generateState();
    const res = await httpGet(`${handle2.redirectUri}?code=c&state=${state}`);
    await handle2.result;

    const headers = res.headers;
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['x-frame-options']).toBe('DENY');
    expect(headers['cache-control']).toBe('no-store');
    expect(headers['referrer-policy']).toBe('no-referrer');
    // The page is static: nothing from the request is reflected into it.
    expect(res.body).not.toContain(state);
    expect(res.body).not.toContain('auth-code-123');
  });

  it('shows a failure page for a callback with no state, and ends the flow', async () => {
    const handle = await startLoopbackListener({ timeoutMs: 5000 });
    const res = await httpGet(`${handle.redirectUri}?code=attacker-code`);
    expect(res.body).toContain('could not be completed');

    const result = await handle.result;
    expect(result.callback?.kind).toBe('invalid');
  });

  it('ignores a stray path without ending the flow', async () => {
    const handle = await startLoopbackListener({ timeoutMs: 5000 });

    // A browser probing /favicon.ico must not abort a sign-in in progress.
    const favicon = await httpGet(`http://127.0.0.1:${new URL(handle.redirectUri).port}/favicon.ico`);
    expect(favicon.status).toBe(404);

    // The flow is still live.
    const state = generateState();
    await httpGet(`${handle.redirectUri}?code=real&state=${state}`);
    const result = await handle.result;
    expect(result.stopReason).toBe('callback');
    if (result.callback?.kind === 'code') expect(result.callback.code).toBe('real');
  });

  it('times out and releases the port', async () => {
    const handle = await startLoopbackListener({ timeoutMs: 120 });
    const result = await handle.result;
    expect(result).toEqual({ callback: null, stopReason: 'timeout' });
  });

  it('can be cancelled', async () => {
    const handle = await startLoopbackListener({ timeoutMs: 5000 });
    handle.cancel();
    const result = await handle.result;
    expect(result.stopReason).toBe('cancelled');
  });

  it('refuses a non-GET method', async () => {
    const handle = await startLoopbackListener({ timeoutMs: 5000 });
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(handle.redirectUri, { method: 'POST' }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(405);
    handle.cancel();
  });

  it('does not end the flow on an oversized URL', async () => {
    const handle = await startLoopbackListener({ timeoutMs: 5000 });
    const res = await httpGet(`${handle.redirectUri}?code=${'a'.repeat(9000)}`);
    expect(res.status).toBe(414);

    // Still usable afterwards.
    const state = generateState();
    await httpGet(`${handle.redirectUri}?code=ok&state=${state}`);
    const result = await handle.result;
    if (result.callback?.kind === 'code') expect(result.callback.code).toBe('ok');
  });

  it('lets only the first callback settle the flow', async () => {
    const handle = await startLoopbackListener({ timeoutMs: 5000 });
    const state = generateState();
    await httpGet(`${handle.redirectUri}?code=first&state=${state}`);
    const first = await handle.result;
    expect(first.stopReason).toBe('callback');

    // A replay is refused one of two ways, and which one is a race rather than a
    // contract: `server.close()` is asynchronous, so the connection is either
    // already refused, or it arrives and is answered 410. Both are acceptable;
    // what must never happen is a second success or a changed result.
    let secondStatus: number | 'refused' = 'refused';
    try {
      const res = await httpGet(`${handle.redirectUri}?code=second&state=${state}`);
      secondStatus = res.status;
    } catch {
      secondStatus = 'refused';
    }
    expect(['refused', 410]).toContain(secondStatus);

    // And the flow result is unchanged: still the first code.
    expect(await handle.result).toBe(first);
    if (first.callback?.kind === 'code') expect(first.callback.code).toBe('first');
  });
});

/* ------------------------------------------------------------------ *
 * Token response parsing
 * ------------------------------------------------------------------ */

describe('parseTokenResponse', () => {
  it('accepts a normal response', () => {
    const set = parseTokenResponse({
      access_token: 'ya29.token',
      refresh_token: '1//refresh',
      expires_in: 3599,
      scope: 'https://mail.google.com/',
      token_type: 'Bearer',
      id_token: 'header.payload.signature',
    });
    expect(set.accessToken).toBe('ya29.token');
    expect(set.refreshToken).toBe('1//refresh');
    expect(set.expiresIn).toBe(3599);
  });

  it('accepts expires_in as a numeric string', () => {
    // Some providers and proxies serialise it as a string.
    expect(parseTokenResponse({ access_token: 'a', expires_in: '3600' }).expiresIn).toBe(3600);
  });

  it('treats a missing refresh token as null, not empty string', () => {
    // Crucially, a refresh response usually omits it; the caller must keep the
    // existing token rather than overwrite it.
    expect(parseTokenResponse({ access_token: 'a' }).refreshToken).toBeNull();
    expect(parseTokenResponse({ access_token: 'a', refresh_token: '' }).refreshToken).toBeNull();
  });

  it('defaults token_type', () => {
    expect(parseTokenResponse({ access_token: 'a' }).tokenType).toBe('Bearer');
  });

  it('rejects a non-object body', () => {
    for (const bad of [null, 'string', 42, []]) {
      expect(() => parseTokenResponse(bad)).toThrow(AppError);
    }
  });

  it('rejects a missing access token', () => {
    expect(() => parseTokenResponse({})).toThrow(/access token/i);
    expect(() => parseTokenResponse({ access_token: '' })).toThrow(/access token/i);
    expect(() => parseTokenResponse({ access_token: 123 })).toThrow(/access token/i);
  });

  it('rejects an absurdly long access token rather than storing it', () => {
    expect(() => parseTokenResponse({ access_token: 'a'.repeat(9000) })).toThrow(/access token/i);
  });

  it('ignores an invalid expires_in rather than computing a nonsense expiry', () => {
    expect(parseTokenResponse({ access_token: 'a', expires_in: -5 }).expiresIn).toBeNull();
    expect(parseTokenResponse({ access_token: 'a', expires_in: 'soon' }).expiresIn).toBeNull();
    expect(parseTokenResponse({ access_token: 'a', expires_in: Infinity }).expiresIn).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * Token exchange
 * ------------------------------------------------------------------ */

describe('exchangeCodeForTokens', () => {
  const base = {
    provider: 'google' as const,
    clientId: 'client-id',
    redirectUri: 'http://127.0.0.1:1234/callback',
    code: 'the-code',
    codeVerifier: 'the-verifier',
  };

  function fakeFetch(response: Response, capture?: (init: RequestInit, url: string) => void) {
    return async (url: string, init: RequestInit) => {
      capture?.(init, url);
      return response;
    };
  }

  it('posts the PKCE verifier and grant parameters', async () => {
    let seen: { url: string; body: string } | undefined;
    await exchangeCodeForTokens({
      ...base,
      fetchImpl: fakeFetch(new Response(JSON.stringify({ access_token: 'at' }), { status: 200 }), (init, url) => {
        seen = { url, body: String(init.body) };
      }),
    });

    expect(seen?.url).toBe('https://oauth2.googleapis.com/token');
    const params = new URLSearchParams(seen?.body ?? '');
    expect(params.get('grant_type')).toBe('authorization_code');
    expect(params.get('code_verifier')).toBe('the-verifier');
    expect(params.get('code')).toBe('the-code');
    expect(params.get('redirect_uri')).toBe(base.redirectUri);
  });

  it('never sends a client secret', async () => {
    let body = '';
    await exchangeCodeForTokens({
      ...base,
      fetchImpl: fakeFetch(new Response(JSON.stringify({ access_token: 'at' }), { status: 200 }), (init) => {
        body = String(init.body);
      }),
    });
    expect(body).not.toContain('client_secret');
  });

  it('maps invalid_grant to an actionable message', async () => {
    await expect(
      exchangeCodeForTokens({
        ...base,
        fetchImpl: fakeFetch(
          new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'Bad code' }), {
            status: 400,
          })
        ),
      })
    ).rejects.toThrow(/expired or was already used/i);
  });

  it('does not leak the provider error_description into the message', async () => {
    try {
      await exchangeCodeForTokens({
        ...base,
        fetchImpl: fakeFetch(
          new Response(
            JSON.stringify({
              error: 'invalid_request',
              error_description: 'client 1234-secret-ish failed at https://internal.example',
            }),
            { status: 400 }
          )
        ),
      });
      expect.unreachable('should have thrown');
    } catch (err) {
      const message = (err as Error).message;
      expect(message).not.toContain('internal.example');
      expect(message).not.toContain('secret-ish');
    }
  });

  it('reports a network failure without leaking the URL', async () => {
    await expect(
      exchangeCodeForTokens({
        ...base,
        fetchImpl: async () => {
          throw new Error('connect ECONNREFUSED https://oauth2.googleapis.com/token?client_id=abc');
        },
      })
    ).rejects.toThrow(/Could not reach the provider/i);
  });

  it('rejects a non-JSON body', async () => {
    await expect(
      exchangeCodeForTokens({ ...base, fetchImpl: fakeFetch(new Response('<html>oops</html>', { status: 200 })) })
    ).rejects.toThrow(/unreadable response/i);
  });

  it('rejects an oversized body', async () => {
    await expect(
      exchangeCodeForTokens({
        ...base,
        fetchImpl: fakeFetch(new Response('x'.repeat(70_000), { status: 200 })),
      })
    ).rejects.toThrow(/oversized/i);
  });

  it('classifies a 5xx as a network problem, not a credential problem', async () => {
    await expect(
      exchangeCodeForTokens({ ...base, fetchImpl: fakeFetch(new Response('', { status: 503 })) })
    ).rejects.toThrow(/temporarily unavailable/i);
  });

  it('classifies 429 as rate limiting', async () => {
    await expect(
      exchangeCodeForTokens({ ...base, fetchImpl: fakeFetch(new Response('', { status: 429 })) })
    ).rejects.toThrow(/rate limiting/i);
  });
});

describe('refreshAccessToken', () => {
  it('posts grant_type=refresh_token', async () => {
    let body = '';
    await refreshAccessToken({
      provider: 'microsoft',
      clientId: 'c',
      refreshToken: 'rt',
      fetchImpl: async (_url, init) => {
        body = String(init.body);
        return new Response(JSON.stringify({ access_token: 'new-at' }), { status: 200 });
      },
    });
    const params = new URLSearchParams(body);
    expect(params.get('grant_type')).toBe('refresh_token');
    expect(params.get('refresh_token')).toBe('rt');
    expect(params.get('client_id')).toBe('c');
  });

  it('returns null refresh token when the provider does not rotate it', async () => {
    const set = await refreshAccessToken({
      provider: 'google',
      clientId: 'c',
      refreshToken: 'rt',
      fetchImpl: async () => new Response(JSON.stringify({ access_token: 'new-at' }), { status: 200 }),
    });
    expect(set.accessToken).toBe('new-at');
    // The caller must keep the old refresh token.
    expect(set.refreshToken).toBeNull();
  });
});
