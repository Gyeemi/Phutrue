/**
 * Router behaviour: authorization, allowlisting, validation and error hygiene.
 *
 * `electron` is mocked because the router only needs `ipcMain.handle` and
 * `WebContents.id`. The logic under test — allowlist, sender check, schema
 * parsing, error conversion — is the real implementation.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

/* ------------------------------------------------------------------ *
 * Minimal electron mock
 * ------------------------------------------------------------------ */

type Handler = (event: unknown, channel: unknown, payload: unknown) => Promise<unknown>;

const registered = new Map<string, Handler>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: Handler) => { registered.set(channel, fn); },
    removeHandler: (channel: string) => { registered.delete(channel); },
  },
}));

const { registerRouter, unregisterRouter } = await import('../src/main/ipc/router.js');

const TRUSTED_ID = 7;

function sender(id: number) {
  return { id } as unknown as Electron.WebContents;
}

async function invoke(channel: unknown, payload: unknown, senderId = TRUSTED_ID) {
  const fn = registered.get('phutrue:invoke');
  if (!fn) throw new Error('router not registered');
  return fn({ sender: sender(senderId) }, channel, payload) as Promise<
    { ok: true; value: unknown } | { ok: false; code: string; message: string }
  >;
}

beforeEach(() => {
  registered.clear();
  registerRouter(
    {
      'app:info': async () => ({ version: '1.0.0' }) as never,
      'settings:get': async () => ({ theme: 'system' }) as never,
      'settings:update': async (payload) => payload as never,
      'accounts:list': async () => [] as never,
      // A handler that throws a generic error — must not leak its message.
      'drafts:list': async () => { throw new Error('secret internal detail'); },
      // A handler that throws a typed AppError — its safe message is surfaced.
      'drafts:delete': async () => {
        const { AppError } = await import('../src/shared/result.js');
        throw new AppError('NOT_FOUND', 'Draft not found.');
      },
    },
    (wc) => wc.id === TRUSTED_ID
  );
});

describe('channel allowlist', () => {
  it('rejects an unknown channel', async () => {
    const res = await invoke('evil:channel', {});
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('UNKNOWN_CHANNEL');
  });

  it('rejects a non-string channel', async () => {
    for (const bad of [null, 42, {}, ['a']]) {
      const res = await invoke(bad, {});
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.code).toBe('UNKNOWN_CHANNEL');
    }
  });

  it('rejects prototype-ish channel names', async () => {
    for (const bad of ['__proto__', 'constructor', 'toString']) {
      const res = await invoke(bad, {});
      expect(res.ok).toBe(false);
    }
  });

  it('accepts a declared channel', async () => {
    const res = await invoke('app:info', undefined);
    expect(res.ok).toBe(true);
  });
});

describe('sender authorization', () => {
  it('rejects a sender that is not a trusted window', async () => {
    const res = await invoke('app:info', undefined, 999);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('FORBIDDEN');
  });

  it('does not run the handler for an untrusted sender', async () => {
    const spy = vi.fn(async () => ({}) as never);
    registered.clear();
    registerRouter({ 'app:info': spy }, () => false);

    const res = await invoke('app:info', undefined);
    expect(res.ok).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('payload validation', () => {
  it('rejects a payload for a channel that takes none', async () => {
    const res = await invoke('app:info', { sneaky: true });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('INVALID_INPUT');
  });

  it('accepts undefined for an argument-free channel', async () => {
    expect((await invoke('accounts:list', undefined)).ok).toBe(true);
    expect((await invoke('accounts:list', null)).ok).toBe(true);
  });

  it('rejects a malformed settings patch', async () => {
    const res = await invoke('settings:update', { theme: 'neon' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('INVALID_INPUT');
  });

  it('accepts a valid settings patch and passes the parsed value through', async () => {
    const res = await invoke('settings:update', { theme: 'dark' });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toEqual({ theme: 'dark' });
  });

  it('reports failing field paths without echoing values', async () => {
    // The password must not appear in the rejection message.
    const res = await invoke('accounts:create', { label: 'x', email: 'y', password: 'hunter2' });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.message).not.toContain('hunter2');
      expect(res.message).toContain('imapHost');
    }
  });
});

describe('error hygiene', () => {
  it('converts a generic throw into INTERNAL without leaking the message', async () => {
    const res = await invoke('drafts:list', { accountId: 1 });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe('INTERNAL');
      expect(res.message).not.toContain('secret internal detail');
    }
  });

  it('surfaces an AppError with its safe code and message', async () => {
    const res = await invoke('drafts:delete', { id: 5 });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe('NOT_FOUND');
      expect(res.message).toBe('Draft not found.');
    }
  });

  it('never throws across the boundary', async () => {
    // Even a handler that throws synchronously must produce a Result.
    registered.clear();
    registerRouter(
      { 'app:info': (() => { throw new Error('sync boom'); }) as never },
      () => true
    );
    await expect(invoke('app:info', undefined)).resolves.toMatchObject({ ok: false });
  });
});

describe('logging hygiene', () => {
  it('does not write the error message to the console by default', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await invoke('drafts:list', { accountId: 1 });
      const written = spy.mock.calls.flat().join(' ');
      // The channel name may appear; the error text must not.
      expect(written).toContain('drafts:list');
      expect(written).not.toContain('secret internal detail');
    } finally {
      spy.mockRestore();
    }
  });
});

describe('lifecycle', () => {
  it('unregisterRouter removes the handler', async () => {
    unregisterRouter();
    expect(registered.size).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * Unimplemented channels
 *
 * Twenty of the 26 declared channels have no handler yet. Each must fail with an
 * explicit, recognisable error — never a silent success and never a crash — so
 * that no future UI can mistake "not built" for "worked".
 * ------------------------------------------------------------------ */

describe('declared but unimplemented channels', () => {
  it('returns an explicit not-available error, not a success', async () => {
    // A handler map that deliberately omits the mail channels.
    registered.clear();
    registerRouter({ 'app:info': async () => ({}) as never }, () => true);

    const cases: Array<[string, unknown]> = [
      ['accounts:list', undefined],
      ['messages:get', { id: 1 }],
      ['folders:sync', { accountId: 1 }],
      ['sync:start', { accountId: 1 }],
      ['drafts:delete', { id: 1 }],
    ];

    for (const [channel, payload] of cases) {
      const res = await invoke(channel, payload);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.code).toBe('INTERNAL');
        expect(res.message).toBe('This feature is not available in this build.');
      }
    }
  });

  it('validates the payload before reporting the channel as unimplemented', async () => {
    // Ordering matters: a malformed request must be rejected as INVALID_INPUT
    // even when the handler is missing, so validation cannot be bypassed by
    // targeting an unimplemented channel.
    registered.clear();
    registerRouter({}, () => true);

    const res = await invoke('messages:get', { id: 'not-a-number' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('INVALID_INPUT');
  });
});

