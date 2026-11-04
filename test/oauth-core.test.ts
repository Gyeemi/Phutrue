/**
 * OAuth core: PKCE, state, URL construction and callback parsing.
 *
 * These are the security-critical primitives of M3, so the tests are written as
 * attacks rather than as happy paths: a state that is off by one character, a
 * code without a state, a callback from the wrong path, a provider error whose
 * description carries a payload.
 *
 * Nothing here touches the network or Electron.
 */

import { describe, expect, it } from 'vitest';

import {
  base64UrlEncode,
  codeChallengeS256,
  generateCodeVerifier,
  generateState,
  hashState,
  stateMatches,
  verifierMatchesChallenge,
  type RandomBytes,
} from '../src/main/oauth/pkce.js';
import {
  buildAuthorizationUrl,
  clientIdFor,
  isOAuthProvider,
  PROVIDERS,
} from '../src/main/oauth/providers.js';
import {
  explainCallbackFailure,
  explainProviderError,
  normaliseErrorCode,
  parseCallback,
} from '../src/main/oauth/callback.js';

/* ------------------------------------------------------------------ *
 * Deterministic randomness
 * ------------------------------------------------------------------ */

/** A random source that returns a fixed byte pattern, for exact assertions. */
function fixedRandom(byte = 0): RandomBytes {
  return (size) => Buffer.alloc(size, byte);
}

/** A random source that counts calls, to prove we only consume what we need. */
function countingRandom(byte = 1): { random: RandomBytes; calls: () => number } {
  let n = 0;
  return {
    random: (size) => {
      n++;
      return Buffer.alloc(size, byte);
    },
    calls: () => n,
  };
}

/* ------------------------------------------------------------------ *
 * PKCE
 * ------------------------------------------------------------------ */

describe('base64url', () => {
  it('replaces + and / and strips padding', () => {
    // 0xFB 0xFF encodes to base64 containing + and /.
    const encoded = base64UrlEncode(Buffer.from([0xfb, 0xff, 0xfe]));
    expect(encoded).not.toContain('+');
    expect(encoded).not.toContain('/');
    expect(encoded).not.toContain('=');
  });

  it('round-trips known input', () => {
    // "abc" -> base64 "YWJj", no padding to strip.
    expect(base64UrlEncode(Buffer.from('abc', 'ascii'))).toBe('YWJj');
  });
});

describe('code verifier', () => {
  it('is 43 characters for 32 random bytes', () => {
    // RFC 7636 requires 43-128 characters.
    const v = generateCodeVerifier(fixedRandom(0));
    expect(v).toHaveLength(43);
  });

  it('is URL-safe', () => {
    const v = generateCodeVerifier();
    expect(v).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('uses the injected random source exactly once', () => {
    const { random, calls } = countingRandom();
    generateCodeVerifier(random);
    expect(calls()).toBe(1);
  });

  it('produces different values across calls', () => {
    // Real randomness, not the fixed source: collisions would be catastrophic.
    const a = generateCodeVerifier();
    const b = generateCodeVerifier();
    expect(a).not.toBe(b);
  });
});

describe('S256 challenge', () => {
  it('matches the RFC 7636 published test vector', () => {
    // RFC 7636 Appendix B.
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    expect(codeChallengeS256(verifier)).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  it('is deterministic', () => {
    const v = 'a-fixed-verifier-value-for-testing-1234567890';
    expect(codeChallengeS256(v)).toBe(codeChallengeS256(v));
  });

  it('changes when the verifier changes by one character', () => {
    const a = codeChallengeS256('verifier-a');
    const b = codeChallengeS256('verifier-b');
    expect(a).not.toBe(b);
  });

  it('is URL-safe', () => {
    expect(codeChallengeS256(generateCodeVerifier())).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe('verifierMatchesChallenge', () => {
  it('accepts a genuine pair', () => {
    const v = generateCodeVerifier();
    expect(verifierMatchesChallenge(v, codeChallengeS256(v))).toBe(true);
  });

  it('rejects a mismatched pair', () => {
    const v = generateCodeVerifier();
    const other = generateCodeVerifier();
    expect(verifierMatchesChallenge(other, codeChallengeS256(v))).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * state
 * ------------------------------------------------------------------ */

describe('state generation', () => {
  it('is 43 characters', () => {
    expect(generateState(fixedRandom(0))).toHaveLength(43);
  });

  it('is URL-safe', () => {
    expect(generateState()).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('is unique across calls', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) seen.add(generateState());
    expect(seen.size).toBe(200);
  });
});

describe('state comparison', () => {
  it('accepts an identical state', () => {
    const s = generateState();
    expect(stateMatches(s, s)).toBe(true);
  });

  it('rejects a one-character difference', () => {
    const s = generateState();
    const tampered = s.slice(0, -1) + (s.endsWith('A') ? 'B' : 'A');
    expect(stateMatches(s, tampered)).toBe(false);
  });

  it('rejects a prefix', () => {
    const s = generateState();
    expect(stateMatches(s, s.slice(0, 10))).toBe(false);
  });

  it('rejects empty against a real state', () => {
    expect(stateMatches(generateState(), '')).toBe(false);
  });

  it('is length-safe (does not throw on a length mismatch)', () => {
    // timingSafeEqual throws on differing lengths; ours must not.
    expect(() => stateMatches('short', 'a-much-longer-value')).not.toThrow();
  });
});

describe('state hashing', () => {
  it('is a stable 64-character hex digest', () => {
    const h = hashState('some-state');
    expect(h).toMatch(/^[a-f0-9]{64}$/);
    expect(hashState('some-state')).toBe(h);
  });

  it('differs for different states', () => {
    expect(hashState('a')).not.toBe(hashState('b'));
  });

  it('does not contain the raw state, so a leaked row cannot forge a callback', () => {
    const state = generateState();
    expect(hashState(state)).not.toContain(state);
  });
});

/* ------------------------------------------------------------------ *
 * Provider configuration
 * ------------------------------------------------------------------ */

describe('providers', () => {
  it('defines both providers with https endpoints', () => {
    for (const p of ['google', 'microsoft'] as const) {
      const config = PROVIDERS[p];
      expect(config.authorizationEndpoint).toMatch(/^https:\/\//);
      expect(config.tokenEndpoint).toMatch(/^https:\/\//);
      expect(config.scopes.length).toBeGreaterThan(0);
    }
  });

  it('requests offline access so refresh tokens are issued', () => {
    // Google needs an explicit parameter; Microsoft uses the offline_access scope.
    expect(PROVIDERS.google.extraAuthParams?.access_type).toBe('offline');
    expect(PROVIDERS.microsoft.scopes).toContain('offline_access');
  });

  it('recognises only implemented providers', () => {
    expect(isOAuthProvider('google')).toBe(true);
    expect(isOAuthProvider('microsoft')).toBe(true);
    expect(isOAuthProvider('yahoo')).toBe(false);
    expect(isOAuthProvider('gmail')).toBe(false);
    expect(isOAuthProvider(null)).toBe(false);
  });

  it('contains no client secret anywhere in the configuration', () => {
    // A desktop binary cannot keep a secret, and shipping one would be theatre.
    const serialised = JSON.stringify(PROVIDERS);
    expect(serialised).not.toMatch(/client_?secret/i);
  });
});

describe('client ID resolution', () => {
  it('returns null when the environment variable is absent', () => {
    expect(clientIdFor('google', {})).toBeNull();
  });

  it('returns null for a blank value, not an empty string', () => {
    // An empty variable is "not configured", and must not silently produce a
    // request with client_id=.
    expect(clientIdFor('google', { PHUTRUE_GOOGLE_CLIENT_ID: '   ' })).toBeNull();
  });

  it('trims a configured value', () => {
    expect(clientIdFor('google', { PHUTRUE_GOOGLE_CLIENT_ID: '  abc.apps.googleusercontent.com \n' }))
      .toBe('abc.apps.googleusercontent.com');
  });

  it('reads each provider from its own variable', () => {
    const env = {
      PHUTRUE_GOOGLE_CLIENT_ID: 'g-id',
      PHUTRUE_MICROSOFT_CLIENT_ID: 'm-id',
    };
    expect(clientIdFor('google', env)).toBe('g-id');
    expect(clientIdFor('microsoft', env)).toBe('m-id');
  });

  it('does not cross providers', () => {
    expect(clientIdFor('microsoft', { PHUTRUE_GOOGLE_CLIENT_ID: 'g' })).toBeNull();
  });
});

/* ------------------------------------------------------------------ *
 * Authorization URL
 * ------------------------------------------------------------------ */

describe('buildAuthorizationUrl', () => {
  const base = {
    provider: 'google' as const,
    clientId: 'test-client-id.apps.googleusercontent.com',
    redirectUri: 'http://127.0.0.1:49152/callback',
    state: 'a-state-value-that-is-long-enough',
    codeChallenge: 'a-challenge-value',
  };

  it('targets the provider authorisation endpoint', () => {
    const url = new URL(buildAuthorizationUrl(base));
    expect(url.origin).toBe('https://accounts.google.com');
    expect(url.pathname).toBe('/o/oauth2/v2/auth');
  });

  it('sets the required parameters', () => {
    const url = new URL(buildAuthorizationUrl(base));
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe(base.clientId);
    expect(url.searchParams.get('state')).toBe(base.state);
    expect(url.searchParams.get('code_challenge')).toBe(base.codeChallenge);
  });

  it('uses S256, never plain', () => {
    const url = new URL(buildAuthorizationUrl(base));
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  });

  it('encodes the redirect_uri so the loopback address survives intact', () => {
    const url = new URL(buildAuthorizationUrl(base));
    // Decoded comparison: the point is that the value round-trips exactly.
    expect(url.searchParams.get('redirect_uri')).toBe(base.redirectUri);
    expect(buildAuthorizationUrl(base)).toContain('redirect_uri=http%3A%2F%2F127.0.0.1%3A49152');
  });

  it('joins scopes with spaces per the spec', () => {
    const url = new URL(buildAuthorizationUrl(base));
    const scope = url.searchParams.get('scope') ?? '';
    expect(scope.split(' ').length).toBe(PROVIDERS.google.scopes.length);
    expect(scope).toContain('https://mail.google.com/');
  });

  it('adds Google offline-access parameters', () => {
    const url = new URL(buildAuthorizationUrl(base));
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
  });

  it('does not add Google-only parameters to Microsoft', () => {
    const url = new URL(buildAuthorizationUrl({ ...base, provider: 'microsoft' }));
    expect(url.searchParams.get('access_type')).toBeNull();
    expect(url.searchParams.get('prompt')).toBeNull();
  });

  it('targets Microsoft and requests offline_access', () => {
    const url = new URL(buildAuthorizationUrl({ ...base, provider: 'microsoft' }));
    expect(url.origin).toBe('https://login.microsoftonline.com');
    expect(url.searchParams.get('scope')).toContain('offline_access');
  });

  it('never contains a client_secret', () => {
    for (const provider of ['google', 'microsoft'] as const) {
      expect(buildAuthorizationUrl({ ...base, provider })).not.toMatch(/client_secret/i);
    }
  });
});

/* ------------------------------------------------------------------ *
 * Callback parsing
 * ------------------------------------------------------------------ */

describe('parseCallback — success', () => {
  const state = generateState();

  it('extracts code and state from a well-formed callback', () => {
    const r = parseCallback(`/callback?code=4/abc-DEF_ghi&state=${state}`);
    expect(r).toEqual({ kind: 'code', code: '4/abc-DEF_ghi', state });
  });

  it('tolerates extra parameters the provider adds', () => {
    // Google appends `authuser`, Microsoft appends `session_state`.
    const r = parseCallback(`/callback?code=xyz123&state=${state}&authuser=0&session_state=abc`);
    expect(r.kind).toBe('code');
    if (r.kind === 'code') expect(r.code).toBe('xyz123');
  });

  it('decodes a percent-encoded code', () => {
    const r = parseCallback(`/callback?code=${encodeURIComponent('4/abc+def')}&state=${state}`);
    expect(r.kind).toBe('code');
    if (r.kind === 'code') expect(r.code).toBe('4/abc+def');
  });
});

describe('parseCallback — attacks', () => {
  const state = generateState();

  it('rejects a callback with no state', () => {
    // Without state there is nothing to match, so a stranger on the port could
    // otherwise inject their own code.
    const r = parseCallback('/callback?code=attacker-code');
    expect(r).toEqual({ kind: 'invalid', reason: 'missing-or-malformed-state' });
  });

  it('rejects a state that is too short to be ours', () => {
    const r = parseCallback('/callback?code=abc&state=short');
    expect(r.kind).toBe('invalid');
  });

  it('rejects a state containing characters we never generate', () => {
    const r = parseCallback(`/callback?code=abc&state=${state.slice(0, 40)}%3Cscript%3E`);
    expect(r.kind).toBe('invalid');
  });

  it('rejects a callback with no code', () => {
    const r = parseCallback(`/callback?state=${state}`);
    expect(r).toEqual({ kind: 'invalid', reason: 'missing-or-malformed-code' });
  });

  it('rejects a code containing characters a provider never emits', () => {
    const r = parseCallback(`/callback?code=${encodeURIComponent('<script>alert(1)</script>')}&state=${state}`);
    expect(r.kind).toBe('invalid');
  });

  it('rejects an over-long code rather than forwarding it', () => {
    const r = parseCallback(`/callback?code=${'a'.repeat(5000)}&state=${state}`);
    expect(r.kind).toBe('invalid');
  });

  it('rejects a request to any other path', () => {
    // The listener should only ever complete a callback at /callback.
    for (const p of ['/', '/favicon.ico', '/callback/extra', '/admin']) {
      const r = parseCallback(`${p}?code=abc&state=${state}`);
      expect(r).toEqual({ kind: 'invalid', reason: 'unexpected-path' });
    }
  });

  it('rejects a malformed URL without throwing', () => {
    expect(() => parseCallback('http://')).not.toThrow();
    expect(parseCallback('http://').kind).toBe('invalid');
  });
});

describe('parseCallback — provider errors', () => {
  const state = generateState();

  it('reports access_denied with its state', () => {
    const r = parseCallback(`/callback?error=access_denied&state=${state}`);
    expect(r).toEqual({ kind: 'error', error: 'access_denied', state });
  });

  it('maps an unknown error code to unknown rather than echoing it', () => {
    const r = parseCallback(`/callback?error=<script>&state=${state}`);
    expect(r.kind).toBe('error');
    if (r.kind === 'error') expect(r.error).toBe('unknown');
  });

  it('never carries the provider error_description into the result', () => {
    // error_description is attacker-influenceable text.
    const payload = encodeURIComponent('Your password is required at http://evil.example');
    const r = parseCallback(`/callback?error=invalid_request&error_description=${payload}&state=${state}`);
    expect(JSON.stringify(r)).not.toContain('evil.example');
    expect(JSON.stringify(r)).not.toContain('password');
  });

  it('reports an error without state, with state null', () => {
    const r = parseCallback('/callback?error=access_denied');
    expect(r).toEqual({ kind: 'error', error: 'access_denied', state: null });
  });

  it('nulls a malformed state on an error callback', () => {
    const r = parseCallback('/callback?error=access_denied&state=<bad>');
    expect(r).toEqual({ kind: 'error', error: 'access_denied', state: null });
  });
});

describe('error normalisation', () => {
  it('keeps known codes', () => {
    expect(normaliseErrorCode('access_denied')).toBe('access_denied');
    expect(normaliseErrorCode('invalid_grant')).toBe('invalid_grant');
  });

  it('maps anything else to unknown', () => {
    expect(normaliseErrorCode('something_new')).toBe('unknown');
    expect(normaliseErrorCode(null)).toBe('unknown');
    expect(normaliseErrorCode('')).toBe('unknown');
  });
});

describe('user-facing explanations', () => {
  it('explains every callback failure without echoing internals', () => {
    for (const reason of ['missing-or-malformed-state', 'missing-or-malformed-code', 'unexpected-path', 'other']) {
      const text = explainCallbackFailure(reason);
      expect(text.length).toBeGreaterThan(20);
      expect(text).not.toMatch(/undefined|\[object/);
    }
  });

  it('explains cancellation distinctly, because it is not an error', () => {
    expect(explainProviderError('access_denied')).toMatch(/cancelled/i);
  });

  it('explains a missing client ID in terms the user can act on', () => {
    expect(explainProviderError('invalid_client')).toMatch(/client ID/i);
  });

  it('has an explanation for every known code', () => {
    for (const code of [
      'access_denied',
      'invalid_request',
      'invalid_client',
      'invalid_grant',
      'unauthorized_client',
      'unsupported_response_type',
      'invalid_scope',
      'server_error',
      'temporarily_unavailable',
      'unknown',
    ] as const) {
      expect(explainProviderError(code).length).toBeGreaterThan(10);
    }
  });
});
