/**
 * The sign-in state machine.
 *
 * These tests are about ordering and refusal: which transitions are legal, that
 * exactly one attempt can be in flight, and that a late promise from a dead
 * attempt cannot revive it. All decidable without a DOM.
 */

import { describe, expect, it } from 'vitest';

import {
  initialState,
  isBusy,
  isTerminal,
  providerName,
  providerCompany,
  providerOf,
  reduce,
  type SignInState,
} from '../src/renderer/app/signin-machine.js';

/** Drive the machine through a list of actions. */
function run(actions: Parameters<typeof reduce>[1][]): SignInState {
  return actions.reduce(reduce, initialState());
}

const BEGIN_GOOGLE = { type: 'begin', provider: 'google' } as const;
const OPENED = { type: 'opened', attemptId: 'a'.repeat(32) } as const;

describe('happy path', () => {
  it('walks idle → starting → waiting → success', () => {
    expect(run([BEGIN_GOOGLE]).kind).toBe('starting');

    const waiting = run([BEGIN_GOOGLE, OPENED]);
    expect(waiting.kind).toBe('waiting');

    const done = run([BEGIN_GOOGLE, OPENED, { type: 'succeeded', email: 'a@b.co', label: 'Work' }]);
    expect(done).toEqual({ kind: 'success', provider: 'google', email: 'a@b.co', label: 'Work' });
  });

  it('stays waiting for the whole browser round-trip', () => {
    /*
     * Regression test for a real bug: an earlier version dispatched a
     * "completing" state *before* awaiting `oauth:complete`, which is the call
     * that waits for the browser. The panel therefore read "Completing
     * sign-in…" for the entire time the user was in the browser, and the
     * waiting state — the one that offers Cancel — never appeared at all.
     */
    const state = run([BEGIN_GOOGLE, OPENED]);
    expect(state.kind).toBe('waiting');
    expect(isBusy(state)).toBe(true);

    // There is no state between `waiting` and the result, because the renderer
    // learns nothing in between.
    expect(Object.keys(state)).toEqual(['kind', 'provider', 'attemptId']);
  });

  it('carries the provider through every state', () => {
    const started = run([{ type: 'begin', provider: 'microsoft' }]);
    expect(providerOf(started)).toBe('microsoft');
  });

  it('accepts success that arrives before the attempt was reported open', () => {
    // A very fast browser round-trip can beat the reply to `oauth:begin`.
    // Refusing this would strand the panel in `starting` with a real account
    // already created.
    const done = run([BEGIN_GOOGLE, { type: 'succeeded', email: 'a@b.co', label: '' }]);
    expect(done.kind).toBe('success');
  });
});

describe('single flight', () => {
  it('ignores a second begin while starting', () => {
    const state = run([BEGIN_GOOGLE, { type: 'begin', provider: 'microsoft' }]);
    expect(state).toEqual({ kind: 'starting', provider: 'google' });
  });

  it('ignores a second begin while waiting', () => {
    const state = run([BEGIN_GOOGLE, OPENED, { type: 'begin', provider: 'microsoft' }]);
    expect(state.kind).toBe('waiting');
    expect(providerOf(state)).toBe('google');
  });

  it('refuses a second begin while waiting', () => {
    // Already covered above, and kept separate: this is the single-flight rule,
    // which is the reason concurrent attempts cannot open two loopback ports.
    const state = run([BEGIN_GOOGLE, OPENED, BEGIN_GOOGLE]);
    expect(state.kind).toBe('waiting');
    expect(state.kind === 'waiting' ? state.attemptId : '').toBe('a'.repeat(32));
  });

  it('allows a new begin after the previous attempt ended', () => {
    const state = run([BEGIN_GOOGLE, OPENED, { type: 'cancelled' }, { type: 'begin', provider: 'microsoft' }]);
    expect(state).toEqual({ kind: 'starting', provider: 'microsoft' });
  });

  it('reports busy only while an attempt occupies resources', () => {
    expect(isBusy(initialState())).toBe(false);
    expect(isBusy(run([BEGIN_GOOGLE]))).toBe(true);
    expect(isBusy(run([BEGIN_GOOGLE, OPENED]))).toBe(true);
    expect(isBusy(run([BEGIN_GOOGLE, OPENED, { type: 'cancelled' }]))).toBe(false);
  });
});

describe('cancellation', () => {
  it('cancels from starting and waiting', () => {
    for (const path of [[BEGIN_GOOGLE], [BEGIN_GOOGLE, OPENED]] as const) {
      const state = run([...path, { type: 'cancelled' }]);
      expect(state.kind).toBe('cancelled');
    }
  });

  it('ignores cancelled when nothing is running', () => {
    expect(run([{ type: 'cancelled' }]).kind).toBe('idle');
  });

  it('keeps the provider so the user can retry the same one', () => {
    const state = run([{ type: 'begin', provider: 'microsoft' }, { type: 'cancelled' }]);
    expect(providerOf(state)).toBe('microsoft');
  });

  it('is a terminal state that allows a retry', () => {
    const state = run([BEGIN_GOOGLE, OPENED, { type: 'cancelled' }]);
    expect(isTerminal(state)).toBe(true);
    expect(run([BEGIN_GOOGLE, { type: 'cancelled' }, BEGIN_GOOGLE]).kind).toBe('starting');
  });
});

describe('failures', () => {
  it('records the message and code', () => {
    const state = run([
      BEGIN_GOOGLE,
      OPENED,
      { type: 'failed', message: 'Something went wrong.', code: 'OAUTH_FAILED' },
    ]);
    expect(state).toEqual({
      kind: 'error',
      provider: 'google',
      message: 'Something went wrong.',
      code: 'OAUTH_FAILED',
    });
  });

  it('is terminal', () => {
    expect(isTerminal(run([BEGIN_GOOGLE, { type: 'failed', message: 'x', code: 'y' }]))).toBe(true);
  });

  it('ignores a failure that arrives after the attempt already ended', () => {
    // The dangerous case: the user cancelled, the main process then reports the
    // cancellation as an error. Showing an error would suggest their cancel
    // failed.
    const state = run([
      BEGIN_GOOGLE,
      OPENED,
      { type: 'cancelled' },
      { type: 'failed', message: 'late', code: 'OAUTH_CANCELLED' },
    ]);
    expect(state.kind).toBe('cancelled');
  });
});

describe('late and stale events', () => {
  it('drops an opened event for an attempt that is not starting', () => {
    // A slow `oauth:begin` resolving after the user cancelled must not put the
    // panel back into `waiting`.
    const state = run([BEGIN_GOOGLE, { type: 'cancelled' }, OPENED]);
    expect(state.kind).toBe('cancelled');
  });

  it('drops success after a cancellation', () => {
    const state = run([BEGIN_GOOGLE, OPENED, { type: 'cancelled' }, { type: 'succeeded', email: 'a@b.co', label: '' }]);
    expect(state.kind).toBe('cancelled');
  });

  it('returns to idle on reset from any state', () => {
    const states: SignInState[] = [
      run([BEGIN_GOOGLE]),
      run([BEGIN_GOOGLE, OPENED]),
      run([BEGIN_GOOGLE, { type: 'failed', message: 'x', code: 'y' }]),
    ];
    for (const state of states) {
      expect(reduce(state, { type: 'reset' })).toEqual({ kind: 'idle' });
    }
  });
});

describe('provider labels', () => {
  it('names the products', () => {
    expect(providerName('google')).toBe('Gmail');
    expect(providerName('microsoft')).toBe('Microsoft');
  });

  it('names the companies', () => {
    expect(providerCompany('google')).toBe('Google');
    expect(providerCompany('microsoft')).toBe('Microsoft');
  });
});
