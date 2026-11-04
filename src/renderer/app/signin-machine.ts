/**
 * Sign-in state machine.
 *
 * Kept separate from the React components for one reason: the ordering rules
 * here are the part that can be wrong in a way tests catch. Which state follows
 * which, what cancels what, and what may not be started while something is
 * already running are all decidable without a DOM.
 *
 * ## The rule this exists to enforce
 *
 * Exactly one sign-in may be in flight at a time. The account service holds a
 * loopback port and a pending row per attempt; two concurrent attempts would
 * open two ports, write two pending rows, and leave the UI unable to say which
 * one the browser is completing. The renderer therefore refuses to start a
 * second attempt, and the service is not asked to arbitrate.
 */

import type { OAuthProvider } from '../../shared/models.js';

/**
 * Every state the sign-in panel can be in.
 *
 * `waiting` is the only state in which the app is waiting on something the user
 * does in another application, so it is the only state that offers cancellation
 * prominently.
 */
export type SignInState =
  | { kind: 'idle' }
  | { kind: 'starting'; provider: OAuthProvider }
  /**
   * A browser window is open; we hold the loopback port and an attempt id.
   *
   * This state covers the whole time the user is in the browser, *and* the token
   * exchange that follows it. There is deliberately no separate "finishing"
   * state: the renderer learns nothing between the callback arriving and the
   * account being created — both happen inside one `oauth:complete` call — so a
   * distinct state would be a label with no observable transition behind it.
   */
  | { kind: 'waiting'; provider: OAuthProvider; attemptId: string }
  | { kind: 'success'; provider: OAuthProvider; email: string; label: string }
  | { kind: 'cancelled'; provider: OAuthProvider }
  | { kind: 'error'; provider: OAuthProvider; message: string; code: string };

export type SignInAction =
  | { type: 'begin'; provider: OAuthProvider }
  | { type: 'opened'; attemptId: string }
  | { type: 'succeeded'; email: string; label: string }
  | { type: 'cancelled' }
  | { type: 'failed'; message: string; code: string }
  | { type: 'reset' };

/** True while a sign-in is occupying resources and must not be duplicated. */
export function isBusy(state: SignInState): boolean {
  return state.kind === 'starting' || state.kind === 'waiting';
}

/** True when the panel should show a dismissible result rather than a form. */
export function isTerminal(state: SignInState): boolean {
  return state.kind === 'success' || state.kind === 'cancelled' || state.kind === 'error';
}

export function initialState(): SignInState {
  return { kind: 'idle' };
}

/** Provider of a state, or null in `idle`. Used to keep the UI's context. */
export function providerOf(state: SignInState): OAuthProvider | null {
  if (state.kind === 'idle') return null;
  return state.provider;
}

/**
 * Apply an action.
 *
 * Illegal transitions return the current state unchanged rather than throwing.
 * A late response from a cancelled attempt is a normal event — the promise for
 * `oauth:complete` can settle after the user pressed Cancel — and it must not
 * resurrect a dead attempt or crash the panel.
 */
export function reduce(state: SignInState, action: SignInAction): SignInState {
  switch (action.type) {
    case 'begin': {
      // The single-flight rule. Starting while busy is ignored, not queued:
      // queueing would mean the user's second click signs them in twice as
      // soon as the first finished.
      if (isBusy(state)) return state;
      return { kind: 'starting', provider: action.provider };
    }

    case 'opened': {
      // Only meaningful from `starting`. An `opened` for a stale attempt is
      // dropped, which is what stops a slow `oauth:begin` from hijacking a
      // newer attempt.
      if (state.kind !== 'starting') return state;
      return { kind: 'waiting', provider: state.provider, attemptId: action.attemptId };
    }

    case 'succeeded': {
      /*
       * Accepted from `starting` as well as `finishing`: the callback can arrive
       * before the renderer has been told the attempt opened, if the browser
       * returned very quickly. Refusing it would strand the panel in `starting`
       * while the account exists.
       */
      if (state.kind !== 'waiting' && state.kind !== 'starting') {
        return state;
      }
      return {
        kind: 'success',
        provider: state.provider,
        email: action.email,
        label: action.label,
      };
    }

    case 'cancelled': {
      // Narrowing on the busy kinds is what proves `provider` exists.
      if (state.kind !== 'starting' && state.kind !== 'waiting') return state;
      return { kind: 'cancelled', provider: state.provider };
    }

    case 'failed': {
      if (state.kind !== 'starting' && state.kind !== 'waiting') return state;
      return { kind: 'error', provider: state.provider, message: action.message, code: action.code };
    }

    case 'reset':
      return initialState();

    default:
      return state;
  }
}

/** Display name for a provider. One place, so the UI cannot drift. */
export function providerName(provider: OAuthProvider): string {
  return provider === 'google' ? 'Gmail' : 'Microsoft';
}

/** The provider's own name, for sentences where the product is meant. */
export function providerCompany(provider: OAuthProvider): string {
  return provider === 'google' ? 'Google' : 'Microsoft';
}
