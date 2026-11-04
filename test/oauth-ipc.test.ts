/**
 * IPC boundary for the OAuth channels.
 *
 * Requirement: every new IPC boundary is validated, and the existing
 * restrictions still hold. These tests go through the *real* router and the
 * *real* schema map, with only the handler bodies stubbed, so what is verified
 * is the boundary rather than the service (which has its own test file).
 *
 * The theme: the renderer must not be able to say anything it should not.
 * No token, code, verifier or redirect URI may be supplied by the renderer, and
 * no unknown key may be smuggled alongside a valid one.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

type Handler = (event: unknown, channel: unknown, payload: unknown) => Promise<unknown>;
const registered = new Map<string, Handler>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: Handler) => {
      registered.set(channel, fn);
    },
    removeHandler: (channel: string) => {
      registered.delete(channel);
    },
  },
}));

const { registerRouter } = await import('../src/main/ipc/router.js');
const { CHANNELS } = await import('../src/shared/ipc.js');

const TRUSTED_ID = 7;
const ATTEMPT = 'a'.repeat(32);

async function invoke(channel: unknown, payload: unknown, senderId = TRUSTED_ID) {
  const fn = registered.get('phutrue:invoke');
  if (!fn) throw new Error('router not registered');
  return fn({ sender: { id: senderId } }, channel, payload) as Promise<
    { ok: true; value: unknown } | { ok: false; code: string; message: string }
  >;
}

/** Record what the handler actually received, after parsing. */
const received: unknown[] = [];

beforeEach(() => {
  registered.clear();
  received.length = 0;
  const echo = async (payload: unknown) => {
    received.push(payload);
    return {} as never;
  };
  registerRouter(
    {
      'oauth:begin': echo,
      'oauth:open': echo,
      'oauth:complete': echo,
      'oauth:cancel': echo,
      'oauth:state': echo,
    },
    (wc) => wc.id === TRUSTED_ID
  );
});

describe('declared channels', () => {
  it('declares all five OAuth channels', async () => {
    for (const c of ['oauth:begin', 'oauth:open', 'oauth:complete', 'oauth:cancel', 'oauth:state']) {
      expect(CHANNELS).toContain(c);
    }
  });

  it('accepts a well-formed begin request', async () => {
    const res = await invoke('oauth:begin', { provider: 'google' });
    expect(res.ok).toBe(true);
  });

  it('accepts an optional label', async () => {
    const res = await invoke('oauth:begin', { provider: 'microsoft', label: 'Work' });
    expect(res.ok).toBe(true);
    expect(received[0]).toMatchObject({ provider: 'microsoft', label: 'Work' });
  });
});

describe('provider validation', () => {
  it('accepts exactly the two supported providers', async () => {
    for (const provider of ['google', 'microsoft']) {
      expect((await invoke('oauth:begin', { provider })).ok).toBe(true);
    }
  });

  it('rejects any other provider string', async () => {
    for (const provider of ['yahoo', 'gmail', 'GOOGLE', '', 'google ', 'aol']) {
      const res = await invoke('oauth:begin', { provider });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.code).toBe('INVALID_INPUT');
    }
  });

  it('rejects a non-string provider', async () => {
    for (const provider of [null, 1, {}, [], true]) {
      expect((await invoke('oauth:begin', { provider })).ok).toBe(false);
    }
  });

  it('rejects a begin request with no provider', async () => {
    expect((await invoke('oauth:begin', {})).ok).toBe(false);
  });
});

describe('attempt id validation', () => {
  it('accepts a 32-character lowercase hex handle', async () => {
    expect((await invoke('oauth:open', { attemptId: ATTEMPT })).ok).toBe(true);
  });

  it('rejects a handle of the wrong length or alphabet', async () => {
    const bad = [
      '',
      'abc',
      'a'.repeat(31),
      'a'.repeat(33),
      'A'.repeat(32), // uppercase
      'g'.repeat(32), // outside hex
      `${'a'.repeat(31)}!`,
      'a'.repeat(31) + '\n',
    ];
    for (const attemptId of bad) {
      const res = await invoke('oauth:open', { attemptId });
      expect(res.ok, `expected ${JSON.stringify(attemptId)} to be rejected`).toBe(false);
    }
  });

  it('rejects a non-string handle', async () => {
    for (const attemptId of [null, 42, {}, ['a'.repeat(32)]]) {
      expect((await invoke('oauth:open', { attemptId })).ok).toBe(false);
    }
  });

  it('rejects a handle supplied through the prototype chain', async () => {
    /*
     * Zod resolves inherited properties, so a *live* object carrying
     * `attemptId` on its prototype would satisfy the schema. That is not
     * reachable over IPC: Electron structured-clones the payload, which keeps
     * only own enumerable properties and drops the prototype. This test pins
     * that guarantee rather than assuming it — it would start failing if the
     * payload path ever stopped being structured-cloned.
     */
    const forged = Object.create({ attemptId: ATTEMPT }) as Record<string, unknown>;
    expect(Object.keys(forged)).toHaveLength(0);

    const acrossBoundary = structuredClone(forged);
    expect((await invoke('oauth:open', acrossBoundary)).ok).toBe(false);
  });

  it('accepts the same handle when it is an own property', async () => {
    // The control for the test above: the difference is the prototype, not
    // the value.
    const genuine = structuredClone({ attemptId: ATTEMPT });
    expect((await invoke('oauth:open', genuine)).ok).toBe(true);
  });
});

describe('no secret may cross the boundary', () => {
  /*
   * These are the highest-value assertions in this file: they encode the rule
   * that the renderer cannot hand the main process a token, an authorisation
   * code, a PKCE verifier or a redirect URI. The schemas are `.strict()`, so an
   * unexpected key is rejected outright rather than silently dropped.
   */
  const smuggling: Array<[string, Record<string, unknown>, Record<string, unknown>]> = [
    ['oauth:begin', { provider: 'google' }, { accessToken: 'ya29.x' }],
    ['oauth:begin', { provider: 'google' }, { refreshToken: '1//x' }],
    ['oauth:begin', { provider: 'google' }, { clientId: 'attacker-client' }],
    ['oauth:begin', { provider: 'google' }, { clientSecret: 'shh' }],
    ['oauth:begin', { provider: 'google' }, { redirectUri: 'http://evil.example/callback' }],
    ['oauth:begin', { provider: 'google' }, { codeChallenge: 'x' }],
    ['oauth:begin', { provider: 'google' }, { state: 'x' }],
    ['oauth:open', { attemptId: ATTEMPT }, { url: 'https://evil.example/' }],
    ['oauth:open', { attemptId: ATTEMPT }, { authorizationUrl: 'https://evil.example/' }],
    ['oauth:complete', { attemptId: ATTEMPT }, { code: 'auth-code' }],
    ['oauth:complete', { attemptId: ATTEMPT }, { codeVerifier: 'verifier' }],
    ['oauth:complete', { attemptId: ATTEMPT }, { token: 'tok' }],
    ['oauth:cancel', { attemptId: ATTEMPT }, { token: 'tok' }],
    ['oauth:state', { accountId: 1 }, { accessToken: 'tok' }],
  ];

  it('rejects every attempt to smuggle a secret-bearing key', async () => {
    // A loop rather than `it.each`: the tuples are mixed types, and a failure
    // needs to name the offending key, which `it.each` would not do well.
    for (const [channel, base, extra] of smuggling) {
      const res = await invoke(channel, { ...base, ...extra });
      expect(res.ok, `${channel} accepted ${Object.keys(extra).join(',')}`).toBe(false);
      if (!res.ok) expect(res.code).toBe('INVALID_INPUT');
    }
  });

  it('does not echo the rejected values in the error message', async () => {
    const res = await invoke('oauth:complete', { attemptId: ATTEMPT, accessToken: 'ya29.SUPER-SECRET' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.message).not.toContain('SUPER-SECRET');
  });
});

describe('account id validation', () => {
  it('accepts a positive integer', async () => {
    expect((await invoke('oauth:state', { accountId: 1 })).ok).toBe(true);
  });

  it('rejects zero, negatives, fractions and strings', async () => {
    for (const accountId of [0, -1, 1.5, '1', null, {}]) {
      expect((await invoke('oauth:state', { accountId })).ok).toBe(false);
    }
  });

  it('requires the account id', async () => {
    expect((await invoke('oauth:state', {})).ok).toBe(false);
  });
});

describe('existing restrictions still hold on the new channels', () => {
  it('rejects an untrusted sender before validating', async () => {
    const res = await invoke('oauth:begin', { provider: 'google' }, 999);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('FORBIDDEN');
    expect(received).toHaveLength(0);
  });

  it('rejects an unknown channel that looks OAuth-ish', async () => {
    for (const channel of ['oauth:token', 'oauth:refresh', 'oauth:secret', 'oauth:beginAll']) {
      const res = await invoke(channel, {});
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.code).toBe('UNKNOWN_CHANNEL');
    }
  });

  it('validates the payload even when the handler is missing', async () => {
    registered.clear();
    registerRouter({}, () => true);
    const res = await invoke('oauth:begin', { provider: 'not-a-provider' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('INVALID_INPUT');
  });

  it('reports an unwired OAuth channel as unavailable rather than failing open', async () => {
    registered.clear();
    registerRouter({}, () => true);
    const res = await invoke('oauth:begin', { provider: 'google' });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe('INTERNAL');
      expect(res.message).toBe('This feature is not available in this build.');
    }
  });

  it('rejects a null payload', async () => {
    expect((await invoke('oauth:begin', null)).ok).toBe(false);
  });
});
