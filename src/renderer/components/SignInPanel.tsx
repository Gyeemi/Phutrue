/**
 * The sign-in panel.
 *
 * One panel that changes shape with the state machine, rather than four
 * screens. The reason is the waiting state: it is not a page transition, it is
 * the same place while the user is in another application, and a tester who
 * alt-tabs back needs to recognise where they are.
 *
 * What this component must never do:
 *   - open a window itself. The main process calls `shell.openExternal`; the
 *     renderer's `oauth:open` invokes that, it does not navigate.
 *   - display, log or hold a token. Nothing on these channels carries one.
 */

import { useEffect, useRef } from 'react';

import type { OAuthProvider } from '../../shared/models.js';
import type { SignInState } from '../app/signin-machine.js';
import { isBusy, providerCompany, providerName } from '../app/signin-machine.js';
import { ProviderCard } from './ProviderCard.js';

interface SignInPanelProps {
  state: SignInState;
  /** True when the app has a working bridge and can start a sign-in at all. */
  ready: boolean;
  onSelect: (provider: OAuthProvider) => void;
  onCancel: () => void;
  onDismiss: () => void;
  onRetry: () => void;
}

const DESCRIPTIONS: Record<OAuthProvider, string> = {
  google:
    'Sign in with a Google account to read and send Gmail. Phutrue asks for mail access only, and never sees your password.',
  microsoft:
    'Sign in with a Microsoft account for Outlook and Microsoft 365. Works with personal and work accounts.',
};

/**
 * Live region text.
 *
 * A screen reader hears the state change without the user having to find the
 * panel again. `polite` because the waiting state is not urgent, and an
 * `assertive` announcement would interrupt whatever is being read.
 */
function statusText(state: SignInState): string {
  switch (state.kind) {
    case 'idle':
      return '';
    case 'starting':
      return `Opening ${providerCompany(state.provider)} sign-in…`;
    case 'waiting':
      return `Waiting for you to finish signing in with ${providerCompany(state.provider)} in your browser.`;
    case 'success':
      return `Signed in as ${state.email}.`;
    case 'cancelled':
      return 'Sign-in cancelled.';
    case 'error':
      return 'Sign-in failed.';
  }
}

export function SignInPanel({
  state,
  ready,
  onSelect,
  onCancel,
  onDismiss,
  onRetry,
}: SignInPanelProps): JSX.Element {
  const busy = isBusy(state);
  const headingRef = useRef<HTMLHeadingElement>(null);

  /*
   * Move focus to the panel heading when a result appears, so a keyboard or
   * screen-reader user lands on the outcome instead of on a button that has
   * just been removed from under them.
   */
  useEffect(() => {
    if (state.kind === 'success' || state.kind === 'cancelled' || state.kind === 'error') {
      headingRef.current?.focus();
    }
  }, [state.kind]);

  return (
    <section className="signin" aria-labelledby="signin-title">
      <header className="signin__head">
        <h2 className="signin__title" id="signin-title" ref={headingRef} tabIndex={-1}>
          Add an account
        </h2>
        <p className="signin__subtitle">
          Phutrue signs in through your browser. Your password is typed only on the
          provider&apos;s own page, never into this app.
        </p>
      </header>

      {/* Announced on every change; also the visible status line. */}
      <p className="signin__status" role="status" aria-live="polite">
        {statusText(state)}
      </p>

      {state.kind === 'idle' && (
        <div className="signin__providers">
          <ProviderCard
            provider="google"
            title="Gmail"
            description={DESCRIPTIONS.google}
            disabled={!ready || busy}
            active={false}
            onSelect={onSelect}
          />
          <ProviderCard
            provider="microsoft"
            title="Microsoft"
            description={DESCRIPTIONS.microsoft}
            disabled={!ready || busy}
            active={false}
            onSelect={onSelect}
          />
        </div>
      )}

      {state.kind === 'starting' && (
        <div className="signin__progress" aria-busy="true">
          <span className="spinner" aria-hidden="true" />
          <p className="signin__progress-text">Opening your browser…</p>
        </div>
      )}

      {state.kind === 'waiting' && (
        <div className="signin__waiting" aria-busy="true">
          <span className="spinner" aria-hidden="true" />
          <h3 className="signin__waiting-title">Finish signing in your browser</h3>
          <p className="signin__waiting-text">
            A {providerCompany(state.provider)} page has opened in your default browser. Complete
            the sign-in there and you will be returned here automatically.
          </p>
          <p className="signin__waiting-hint">
            Nothing opened? Check for a new browser tab or window, or a browser that is
            waiting behind this one.
          </p>
          <button type="button" className="btn btn--quiet" onClick={onCancel}>
            Cancel sign-in
          </button>
        </div>
      )}

      {state.kind === 'success' && (
        <div className="signin__result signin__result--success" role="status">
          <h3 className="signin__result-title">Connected</h3>
          <p className="signin__result-text">
            {state.label || state.email} is ready. Messages will appear once syncing is enabled.
          </p>
          <button type="button" className="btn btn--primary" onClick={onDismiss}>
            Done
          </button>
        </div>
      )}

      {state.kind === 'cancelled' && (
        <div className="signin__result" role="status">
          <h3 className="signin__result-title">Sign-in cancelled</h3>
          <p className="signin__result-text">
            No account was added. You can try again whenever you are ready.
          </p>
          <div className="signin__actions">
            <button type="button" className="btn btn--primary" onClick={onRetry}>
              Try again
            </button>
            <button type="button" className="btn btn--quiet" onClick={onDismiss}>
              Dismiss
            </button>
          </div>
        </div>
      )}

      {state.kind === 'error' && (
        <div className="signin__result signin__result--error" role="alert">
          <h3 className="signin__result-title">Sign-in did not complete</h3>
          {/*
            The message comes from the main process, which already reduced it to
            a safe, user-facing sentence. The code is shown small and secondary:
            useful when reporting a problem, harmless to display.
          */}
          <p className="signin__result-text">{state.message}</p>
          <p className="signin__result-code">
            {providerName(state.provider)} · {state.code}
          </p>
          <div className="signin__actions">
            <button type="button" className="btn btn--primary" onClick={onRetry}>
              Try again
            </button>
            <button type="button" className="btn btn--quiet" onClick={onDismiss}>
              Dismiss
            </button>
          </div>
        </div>
      )}

      {!ready && (
        <p className="signin__blocked" role="alert">
          Sign-in is unavailable because the application bridge did not load. Restart Phutrue.
        </p>
      )}
    </section>
  );
}
