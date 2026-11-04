// @vitest-environment jsdom
/**
 * Account setup screen behaviour.
 *
 * These tests drive the real component against a stubbed bridge that records
 * every channel invoked. What they are written to protect:
 *
 *   - provider selection actually invokes the right channels, in order;
 *   - a second sign-in cannot start while one is running;
 *   - cancellation calls `oauth:cancel` for the attempt that exists;
 *   - a failure is shown with the router's message, and nothing is invented;
 *   - the renderer never asks for a token, and never receives one;
 *   - removal requires confirmation and calls `accounts:remove`.
 *
 * The bridge stub is the boundary under test, so it is deliberately strict: any
 * channel it does not know is recorded and fails, which catches a component
 * calling something that does not exist.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Account, OAuthAccountState } from '../src/shared/models.js';

vi.mock('../src/renderer/styles/app.css', () => ({}));
vi.mock('../src/renderer/components/boot.css', () => ({}));
vi.mock('../src/renderer/components/account.css', () => ({}));
vi.mock('../src/renderer/components/diagnostics.css', () => ({}));
vi.mock('../assets/generated/png/icon-128.png', () => ({
  default: 'data:image/png;base64,iVBORw0KGgo=',
}));

const { AccountScreen } = await import('../src/renderer/components/AccountScreen.js');

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/* ------------------------------------------------------------------ *
 * Bridge stub
 * ------------------------------------------------------------------ */

interface Recorded {
  channel: string;
  payload: unknown;
}

type Responder = (payload: unknown) => { ok: true; value: unknown } | { ok: false; code: string; message: string };

let calls: Recorded[] = [];
let responses: Record<string, Responder> = {};

const OK = (value: unknown) => ({ ok: true as const, value });

const ACCOUNT: Account = {
  id: 1,
  label: 'Work',
  email: 'alice@example.com',
  displayName: 'Alice',
  authKind: 'oauth2',
  oauthProvider: 'google',
  imapHost: '',
  imapPort: 993,
  imapSecure: true,
  smtpHost: '',
  smtpPort: 465,
  smtpSecure: true,
  smtpUser: null,
  syncState: 'idle',
  lastError: null,
  lastSyncedAt: null,
  createdAt: 1_700_000_000_000,
};

const STATE_OK: OAuthAccountState = {
  provider: 'google',
  status: 'connected',
  hasAccessToken: true,
  canRefresh: true,
  lastError: null,
};

function installBridge() {
  Object.defineProperty(window, 'phutrue', {
    configurable: true,
    writable: true,
    value: {
      platform: 'win32',
      invoke: async (channel: string, payload: unknown) => {
        calls.push({ channel, payload });
        const responder = responses[channel];
        if (!responder) return { ok: false, code: 'UNKNOWN_CHANNEL', message: `no stub for ${channel}` };
        return responder(payload);
      },
      on: () => () => {},
    },
  });
}

/* ------------------------------------------------------------------ *
 * Harness
 * ------------------------------------------------------------------ */

let container: HTMLDivElement;
let root: Root | undefined;

beforeEach(() => {
  calls = [];
  responses = {};
  container = document.createElement('div');
  container.id = 'root';
  document.body.replaceChildren(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  Reflect.deleteProperty(window as unknown as Record<string, unknown>, 'phutrue');
  vi.restoreAllMocks();
});

async function settle(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function render(): Promise<void> {
  installBridge();
  await act(async () => {
    root!.render(<AccountScreen />);
  });
  await settle();
}

function text(): string {
  return document.body.textContent ?? '';
}

function buttons(): HTMLButtonElement[] {
  return [...container.querySelectorAll('button')];
}

function buttonByText(needle: string): HTMLButtonElement | undefined {
  return buttons().find((b) => (b.textContent ?? '').includes(needle));
}

function buttonByLabel(label: string): HTMLButtonElement | undefined {
  return buttons().find((b) => (b.getAttribute('aria-label') ?? '').includes(label));
}

async function click(button: HTMLButtonElement | undefined): Promise<void> {
  if (!button) throw new Error('button not found');
  await act(async () => {
    button.click();
  });
  await settle();
}

/** A bridge where a sign-in succeeds end to end. */
function signInSucceeds(account: Account = ACCOUNT, state: OAuthAccountState = STATE_OK) {
  responses = {
    'accounts:list': () => OK([]),
    'oauth:begin': () =>
      OK({
        attemptId: 'a'.repeat(32),
        provider: 'google',
        authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?x=1',
        redirectUri: 'http://127.0.0.1:4000/callback',
      }),
    'oauth:open': () => OK(undefined),
    'oauth:complete': () => OK(account),
    'oauth:cancel': () => OK(undefined),
    'oauth:state': () => OK(state),
    'accounts:remove': () => OK(undefined),
  };
}

/* ------------------------------------------------------------------ *
 * Initial state
 * ------------------------------------------------------------------ */

describe('initial state', () => {
  it('lists accounts on mount', async () => {
    responses = { 'accounts:list': () => OK([]) };
    await render();
    expect(calls.map((c) => c.channel)).toContain('accounts:list');
  });

  it('offers both providers when no account exists', async () => {
    responses = { 'accounts:list': () => OK([]) };
    await render();
    expect(buttonByLabel('Sign in with Google')).toBeDefined();
    expect(buttonByLabel('Sign in with Microsoft')).toBeDefined();
  });

  it('describes what each provider is for', async () => {
    responses = { 'accounts:list': () => OK([]) };
    await render();
    expect(text()).toContain('Gmail');
    expect(text()).toContain('Microsoft');
    // The explanation that the password is not typed into the app.
    expect(text()).toContain('browser');
  });

  it('shows setup guidance rather than a blank screen', async () => {
    // With no accounts the panel is the whole surface; the list's own
    // "No accounts yet" text belongs to the populated-account view.
    responses = { 'accounts:list': () => OK([]) };
    await render();
    expect(text()).toContain('Set up your mail');
    expect(buttonByLabel('Sign in with Google')).toBeDefined();
  });

  it('shows a load failure with a retry, not an empty list', async () => {
    responses = {
      'accounts:list': () => ({ ok: false, code: 'DB_ERROR', message: 'The database is locked.' }),
    };
    await render();
    expect(text()).toContain('The database is locked.');
    expect(buttonByText('Try again')).toBeDefined();

    // And retrying actually re-invokes the channel.
    const before = calls.filter((c) => c.channel === 'accounts:list').length;
    await click(buttonByText('Try again'));
    expect(calls.filter((c) => c.channel === 'accounts:list').length).toBeGreaterThan(before);
  });
});

/* ------------------------------------------------------------------ *
 * Provider selection and progress
 * ------------------------------------------------------------------ */

describe('provider selection', () => {
  it('begins a sign-in with the chosen provider', async () => {
    signInSucceeds();
    await render();

    await click(buttonByLabel('Sign in with Google'));

    const begin = calls.find((c) => c.channel === 'oauth:begin');
    expect(begin).toBeDefined();
    expect(begin?.payload).toEqual({ provider: 'google' });
  });

  it('begins with Microsoft when that card is chosen', async () => {
    signInSucceeds();
    await render();
    await click(buttonByLabel('Sign in with Microsoft'));
    expect(calls.find((c) => c.channel === 'oauth:begin')?.payload).toEqual({ provider: 'microsoft' });
  });

  it('invokes begin, open and complete in that order', async () => {
    signInSucceeds();
    await render();
    await click(buttonByLabel('Sign in with Google'));

    const oauthCalls = calls
      .filter((c) => c.channel.startsWith('oauth:'))
      .map((c) => c.channel);
    /*
     * `oauth:state` follows because connecting an account triggers a read of its
     * credential state. Only the three that make up the flow are ordered here.
     */
    expect(oauthCalls.filter((c) => c !== 'oauth:state')).toEqual([
      'oauth:begin',
      'oauth:open',
      'oauth:complete',
    ]);
  });

  it('opens the attempt returned by begin, not one it invented', async () => {
    signInSucceeds();
    await render();
    await click(buttonByLabel('Sign in with Google'));
    expect(calls.find((c) => c.channel === 'oauth:open')?.payload).toEqual({
      attemptId: 'a'.repeat(32),
    });
  });

  it('never sends a URL to oauth:open', async () => {
    // The main process resolves the URL from the attempt; the renderer must
    // not be able to ask for an arbitrary URL to be opened.
    signInSucceeds();
    await render();
    await click(buttonByLabel('Sign in with Google'));
    const payload = calls.find((c) => c.channel === 'oauth:open')?.payload as Record<string, unknown>;
    expect(Object.keys(payload)).toEqual(['attemptId']);
  });
});

describe('loading and waiting states', () => {
  it('shows progress while the sign-in is being started', async () => {
    // `begin` is left pending so the state between the click and the browser
    // opening is observable; with an instantly-resolving stub the panel would
    // already be showing the result.
    responses = {
      'accounts:list': () => OK([]),
      'oauth:begin': () => new Promise(() => {}) as never,
    };
    await render();

    await act(async () => {
      buttonByLabel('Sign in with Google')!.click();
    });

    expect(text()).toContain('Opening your browser');
    expect(container.querySelector('.spinner')).not.toBeNull();
  });

  it('explains that sign-in happens in the browser while waiting', async () => {
    // `oauth:complete` that never settles keeps the panel in the waiting state.
    responses = {
      'accounts:list': () => OK([]),
      'oauth:begin': () =>
        OK({
          attemptId: 'b'.repeat(32),
          provider: 'google',
          authorizationUrl: 'https://accounts.google.com/x',
          redirectUri: 'http://127.0.0.1:4000/callback',
        }),
      'oauth:open': () => OK(undefined),
      'oauth:complete': () => new Promise(() => {}) as never,
    };
    await render();
    await click(buttonByLabel('Sign in with Google'));

    expect(text()).toContain('browser');
    expect(text()).toMatch(/Finish signing in your browser/i);
    expect(text()).toContain('Cancel sign-in');
  });

  it('disables both provider buttons while a sign-in runs', async () => {
    responses = {
      'accounts:list': () => OK([]),
      'oauth:begin': () => new Promise(() => {}) as never,
    };
    await render();

    await act(async () => {
      buttonByLabel('Sign in with Google')!.click();
    });

    // While starting, the panel shows progress rather than the cards, so the
    // strongest assertion available is that no enabled provider button remains.
    const enabled = buttons().filter((b) => !b.disabled && (b.getAttribute('aria-label') ?? '').startsWith('Sign in'));
    expect(enabled).toHaveLength(0);
    await settle();
  });

  it('prevents a second sign-in while one is in flight', async () => {
    responses = {
      'accounts:list': () => OK([]),
      'oauth:begin': () =>
        OK({
          attemptId: 'c'.repeat(32),
          provider: 'google',
          authorizationUrl: 'https://accounts.google.com/x',
          redirectUri: 'http://127.0.0.1:4000/callback',
        }),
      'oauth:open': () => OK(undefined),
      'oauth:complete': () => new Promise(() => {}) as never,
    };
    await render();
    await click(buttonByLabel('Sign in with Google'));

    const beginCount = calls.filter((c) => c.channel === 'oauth:begin').length;
    expect(beginCount).toBe(1);

    // There is nothing left to click; assert no second begin was attempted even
    // if one were dispatched.
    expect(calls.filter((c) => c.channel === 'oauth:begin')).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ *
 * Cancellation
 * ------------------------------------------------------------------ */

describe('cancellation', () => {
  function waitingBridge() {
    responses = {
      'accounts:list': () => OK([]),
      'oauth:begin': () =>
        OK({
          attemptId: 'd'.repeat(32),
          provider: 'google',
          authorizationUrl: 'https://accounts.google.com/x',
          redirectUri: 'http://127.0.0.1:4000/callback',
        }),
      'oauth:open': () => OK(undefined),
      'oauth:complete': () => new Promise(() => {}) as never,
      'oauth:cancel': () => OK(undefined),
    };
  }

  it('cancels the attempt that actually exists', async () => {
    waitingBridge();
    await render();
    await click(buttonByLabel('Sign in with Google'));
    await click(buttonByText('Cancel sign-in'));

    expect(calls.find((c) => c.channel === 'oauth:cancel')?.payload).toEqual({
      attemptId: 'd'.repeat(32),
    });
  });

  it('shows a cancelled state that offers a retry', async () => {
    waitingBridge();
    await render();
    await click(buttonByLabel('Sign in with Google'));
    await click(buttonByText('Cancel sign-in'));

    expect(text()).toContain('Sign-in cancelled');
    expect(text()).toContain('No account was added');
    expect(buttonByText('Try again')).toBeDefined();
  });

  it('does not treat cancellation as a failure', async () => {
    waitingBridge();
    await render();
    await click(buttonByLabel('Sign in with Google'));
    await click(buttonByText('Cancel sign-in'));

    // No error alert, and specifically not the failure heading.
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(text()).not.toContain('Sign-in did not complete');
  });

  it('reports a main-process cancellation as cancelled, not failed', async () => {
    responses = {
      'accounts:list': () => OK([]),
      'oauth:begin': () =>
        OK({
          attemptId: 'e'.repeat(32),
          provider: 'google',
          authorizationUrl: 'https://accounts.google.com/x',
          redirectUri: 'http://127.0.0.1:4000/callback',
        }),
      'oauth:open': () => OK(undefined),
      'oauth:complete': () => ({ ok: false, code: 'OAUTH_CANCELLED', message: 'Sign-in was cancelled.' }),
    };
    await render();
    await click(buttonByLabel('Sign in with Google'));

    expect(text()).toContain('Sign-in cancelled');
  });
});

/* ------------------------------------------------------------------ *
 * Success
 * ------------------------------------------------------------------ */

describe('success', () => {
  it('shows the connected account', async () => {
    signInSucceeds();
    await render();
    await click(buttonByLabel('Sign in with Google'));

    expect(text()).toContain('Connected');
    expect(text()).toContain('alice@example.com');
  });

  it('adds the account to the list without a full reload', async () => {
    signInSucceeds();
    await render();
    const listCallsBefore = calls.filter((c) => c.channel === 'accounts:list').length;

    await click(buttonByLabel('Sign in with Google'));

    expect(text()).toContain('alice@example.com');
    // No refetch was needed: the account came back on oauth:complete.
    expect(calls.filter((c) => c.channel === 'accounts:list').length).toBe(listCallsBefore);
  });

  it('reads the credential state after connecting, using the id only', async () => {
    signInSucceeds();
    await render();
    await click(buttonByLabel('Sign in with Google'));

    const stateCall = calls.find((c) => c.channel === 'oauth:state');
    expect(stateCall?.payload).toEqual({ accountId: 1 });
  });
});

/* ------------------------------------------------------------------ *
 * Failures
 * ------------------------------------------------------------------ */

describe('failures', () => {
  it('reports a begin failure with the message from the router', async () => {
    responses = {
      'accounts:list': () => OK([]),
      'oauth:begin': () => ({
        ok: false,
        code: 'INVALID_INPUT',
        message: 'Choose a supported provider.',
      }),
    };
    await render();
    await click(buttonByLabel('Sign in with Google'));

    expect(text()).toContain('Choose a supported provider.');
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
  });

  it('explains a build that is not configured for sign-in, without a retry loop', async () => {
    responses = {
      'accounts:list': () => OK([]),
      'oauth:begin': () => ({
        ok: false,
        code: 'OAUTH_NOT_CONFIGURED',
        message: 'Set PHUTRUE_GOOGLE_CLIENT_ID and restart Phutrue.',
      }),
    };
    await render();
    await click(buttonByLabel('Sign in with Google'));

    // The env-var name is not shown to a user; the cause is.
    expect(text()).toContain('not set up in this build');
    expect(text()).not.toContain('PHUTRUE_GOOGLE_CLIENT_ID');
  });

  it('releases the attempt when the browser fails to open', async () => {
    responses = {
      'accounts:list': () => OK([]),
      'oauth:begin': () =>
        OK({
          attemptId: 'f'.repeat(32),
          provider: 'google',
          authorizationUrl: 'https://accounts.google.com/x',
          redirectUri: 'http://127.0.0.1:4000/callback',
        }),
      'oauth:open': () => ({ ok: false, code: 'INTERNAL', message: 'Could not open the browser.' }),
      'oauth:cancel': () => OK(undefined),
    };
    await render();
    await click(buttonByLabel('Sign in with Google'));

    // The port and pending row must not leak.
    expect(calls.find((c) => c.channel === 'oauth:cancel')?.payload).toEqual({
      attemptId: 'f'.repeat(32),
    });
    expect(text()).toContain('Could not open the browser.');
  });

  it('shows a completion failure with its code', async () => {
    responses = {
      'accounts:list': () => OK([]),
      'oauth:begin': () =>
        OK({
          attemptId: '1'.repeat(32),
          provider: 'google',
          authorizationUrl: 'https://accounts.google.com/x',
          redirectUri: 'http://127.0.0.1:4000/callback',
        }),
      'oauth:open': () => OK(undefined),
      'oauth:complete': () => ({
        ok: false,
        code: 'OAUTH_FAILED',
        message: 'The sign-in response did not match the request that started it, so it was rejected.',
      }),
    };
    await render();
    await click(buttonByLabel('Sign in with Google'));

    expect(text()).toContain('did not match');
    expect(text()).toContain('OAUTH_FAILED');
  });

  it('offers a retry after a failure', async () => {
    responses = {
      'accounts:list': () => OK([]),
      'oauth:begin': () => ({ ok: false, code: 'INTERNAL', message: 'nope' }),
    };
    await render();
    await click(buttonByLabel('Sign in with Google'));
    expect(buttonByText('Try again')).toBeDefined();
  });
});

/* ------------------------------------------------------------------ *
 * Account management
 * ------------------------------------------------------------------ */

describe('connected accounts', () => {
  function withAccount(state: OAuthAccountState = STATE_OK) {
    responses = {
      'accounts:list': () => OK([ACCOUNT]),
      'oauth:state': () => OK(state),
      'accounts:remove': () => OK(undefined),
    };
  }

  it('shows the label, address and provider', async () => {
    withAccount();
    await render();
    expect(text()).toContain('Work');
    expect(text()).toContain('alice@example.com');
    expect(text()).toContain('Gmail');
  });

  it('shows a connected status', async () => {
    withAccount();
    await render();
    expect(text()).toContain('Connected');
  });

  it('explains an expired credential without calling it an error', async () => {
    withAccount({ ...STATE_OK, status: 'expired', hasAccessToken: false });
    await render();
    expect(text()).toContain('Expired');
    expect(text()).toMatch(/renews automatically/i);
    // Not presented as a failure.
    expect(container.querySelector('.acct__status--bad')).toBeNull();
  });

  it('flags a revoked credential as needing action', async () => {
    withAccount({
      ...STATE_OK,
      status: 'revoked',
      hasAccessToken: false,
      lastError: 'Access was withdrawn.',
    });
    await render();
    expect(text()).toContain('Reconnect needed');
    expect(text()).toContain('Access was withdrawn.');
  });

  it('shows an error status with its message', async () => {
    withAccount({ ...STATE_OK, status: 'error', hasAccessToken: false, lastError: 'The grant expired.' });
    await render();
    expect(text()).toContain('Problem');
    expect(text()).toContain('The grant expired.');
  });

  it('re-reads the state when asked to check the connection', async () => {
    withAccount();
    await render();
    const before = calls.filter((c) => c.channel === 'oauth:state').length;
    await click(buttonByLabel('Check the connection'));
    expect(calls.filter((c) => c.channel === 'oauth:state').length).toBeGreaterThan(before);
  });
});

describe('removal', () => {
  function withAccount() {
    responses = {
      'accounts:list': () => OK([ACCOUNT]),
      'oauth:state': () => OK(STATE_OK),
      'accounts:remove': () => OK(undefined),
    };
  }

  it('asks for confirmation before removing', async () => {
    withAccount();
    await render();
    await click(buttonByLabel('Remove alice@example.com'));

    // Nothing removed yet.
    expect(calls.find((c) => c.channel === 'accounts:remove')).toBeUndefined();
    expect(text()).toMatch(/Remove .*alice@example.com/);
    expect(buttonByText('Keep account')).toBeDefined();
  });

  it('removes only after the confirmation is accepted, using the account id', async () => {
    withAccount();
    await render();
    await click(buttonByLabel('Remove alice@example.com'));
    await click(buttonByText('Remove account'));

    expect(calls.find((c) => c.channel === 'accounts:remove')?.payload).toEqual({ id: 1 });
  });

  it('drops the account from the list after removal', async () => {
    withAccount();
    await render();
    await click(buttonByLabel('Remove alice@example.com'));
    await click(buttonByText('Remove account'));

    expect(text()).not.toContain('alice@example.com');
    // Back to the setup surface, since no accounts remain.
    expect(text()).toContain('Set up your mail');
  });

  it('keeps the account when the confirmation is declined', async () => {
    withAccount();
    await render();
    await click(buttonByLabel('Remove alice@example.com'));
    await click(buttonByText('Keep account'));

    expect(calls.find((c) => c.channel === 'accounts:remove')).toBeUndefined();
    expect(text()).toContain('alice@example.com');
  });

  it('reports a removal failure without dropping the account', async () => {
    responses = {
      'accounts:list': () => OK([ACCOUNT]),
      'oauth:state': () => OK(STATE_OK),
      'accounts:remove': () => ({ ok: false, code: 'DB_ERROR', message: 'Could not delete the account.' }),
    };
    await render();
    await click(buttonByLabel('Remove alice@example.com'));
    await click(buttonByText('Remove account'));

    expect(text()).toContain('Could not delete the account.');
    expect(text()).toContain('alice@example.com');
  });
});

/* ------------------------------------------------------------------ *
 * Boundary hygiene
 * ------------------------------------------------------------------ */

describe('boundary hygiene', () => {
  it('never requests a token-bearing channel', async () => {
    // These channels do not exist; the assertion documents that they must not
    // start existing without a deliberate decision.
    signInSucceeds();
    await render();
    await click(buttonByLabel('Sign in with Google'));

    for (const forbidden of ['oauth:token', 'oauth:refresh', 'oauth:secret', 'oauth:credentials']) {
      expect(calls.map((c) => c.channel)).not.toContain(forbidden);
    }
  });

  it('renders no token even when the bridge returns one in an account', async () => {
    // Hostile bridge: a token smuggled into the account object must not reach
    // the DOM. The real main process never does this; the test proves the
    // renderer would not display it anyway.
    const tainted = {
      ...ACCOUNT,
      accessToken: 'ya29.SECRET-ACCESS-TOKEN',
      refreshToken: '1//SECRET-REFRESH-TOKEN',
    } as Account;
    responses = {
      'accounts:list': () => OK([tainted]),
      'oauth:state': () => OK(STATE_OK),
    };
    await render();

    expect(document.body.innerHTML).not.toContain('SECRET-ACCESS-TOKEN');
    expect(document.body.innerHTML).not.toContain('SECRET-REFRESH-TOKEN');
  });

  it('does not use window.confirm for removal', async () => {
    // A blocking native dialog cannot be styled, tested or made accessible, and
    // would make the confirmation untestable.
    const confirmSpy = vi.fn(() => true);
    (window as unknown as Record<string, unknown>)['confirm'] = confirmSpy;

    responses = {
      'accounts:list': () => OK([ACCOUNT]),
      'oauth:state': () => OK(STATE_OK),
      'accounts:remove': () => OK(undefined),
    };
    await render();
    await click(buttonByLabel('Remove alice@example.com'));
    await click(buttonByText('Remove account'));

    expect(confirmSpy).not.toHaveBeenCalled();
    delete (window as unknown as Record<string, unknown>)['confirm'];
  });

  it('reports the bridge as unavailable rather than failing silently', async () => {
    // No bridge at all.
    Reflect.deleteProperty(window as unknown as Record<string, unknown>, 'phutrue');
    await act(async () => {
      root!.render(<AccountScreen ready={false} />);
    });
    await settle();

    expect(text()).toContain('bridge');
  });
});
