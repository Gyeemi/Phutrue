/**
 * Account setup screen.
 *
 * The application's first real screen. It owns the calls and hands pure state to
 * the presentational components, which keeps the components testable without a
 * bridge and keeps every `oauth:*` invocation in one place.
 *
 * ## Rules this file is written against
 *
 * - `callResult`, not `call`, for anything whose failure is shown to the user.
 *   The router returns a safe message; throwing and catching it loses the code.
 * - No token is ever requested or stored here. The channels cannot return one.
 * - The renderer never navigates. `oauth:open` asks the main process to call
 *   `shell.openExternal`.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { Account, OAuthAccountState, OAuthProvider } from '../../shared/models.js';
import { callResult } from '../api.js';
import {
  initialState,
  isBusy,
  providerCompany,
  reduce,
  type SignInState,
} from '../app/signin-machine.js';
import { AccountList } from './AccountList.js';
import { SignInPanel } from './SignInPanel.js';

interface AccountScreenProps {
  /** Called when an account is connected or removed, so the shell can refresh. */
  onAccountsChanged?: (accounts: Account[]) => void;
  /** Injected in tests to avoid a real bridge. Defaults to the real one. */
  ready?: boolean;
}

/**
 * Turn a failed Result into a message worth showing.
 *
 * The router's messages are written for users, so they are used as-is. The code
 * is kept so the UI can distinguish "not configured in this build" — which the
 * user cannot fix by retrying — from a genuine attempt failure.
 */
function messageFor(code: string, message: string): { message: string; code: string } {
  if (code === 'OAUTH_NOT_CONFIGURED') {
    return {
      code,
      message:
        'Sign-in is not set up in this build. Ask whoever built Phutrue to set the provider client ID.',
    };
  }
  return { code, message };
}

export function AccountScreen({ onAccountsChanged, ready = true }: AccountScreenProps): JSX.Element {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [states, setStates] = useState<Record<number, OAuthAccountState>>({});
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [signIn, setSignIn] = useState<SignInState>(initialState);
  const [removingId, setRemovingId] = useState<number | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);

  /*
   * Tracks whether the component is still mounted.
   *
   * `oauth:complete` can take minutes to settle; a setState after unmount warns
   * in React and, worse, a late result would write to a torn-down tree.
   */
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  /** Read the credential state for one account without failing the whole list. */
  const loadState = useCallback(async (account: Account) => {
    if (!account.oauthProvider) return;
    const res = await callResult('oauth:state', { accountId: account.id });
    if (!alive.current) return;
    if (res.ok) {
      setStates((prev) => ({ ...prev, [account.id]: res.value }));
    }
    // A failure here leaves the badge as "Checking…" rather than inventing a
    // status. It is a read-only convenience, not the source of truth.
  }, []);

  const loadAccounts = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    const res = await callResult('accounts:list', undefined);
    if (!alive.current) return;

    if (!res.ok) {
      setLoadError(res.message);
      setLoading(false);
      return;
    }

    setAccounts(res.value);
    setLoading(false);
    for (const account of res.value) void loadState(account);
  }, [loadState]);

  useEffect(() => {
    void loadAccounts();
  }, [loadAccounts]);

  /**
   * Start a sign-in: begin, open the browser, then await completion.
   *
   * Three channels in sequence, each of which can fail independently, and each
   * failure has a different meaning:
   *   - `begin`   failing means nothing opened; tell the user why.
   *   - `open`    failing means the browser refused to launch.
   *   - `complete` failing means the attempt ended badly, or was cancelled.
   */
  const startSignIn = useCallback(
    async (provider: OAuthProvider) => {
      setSignIn(reduce(initialState(), { type: 'begin', provider }));

      const begun = await callResult('oauth:begin', { provider });
      if (!alive.current) return;

      if (!begun.ok) {
        const m = messageFor(begun.code, begun.message);
        setSignIn((s) => reduce(s, { type: 'failed', ...m }));
        return;
      }

      const { attemptId } = begun.value;
      setSignIn((s) => reduce(s, { type: 'opened', attemptId }));

      const opened = await callResult('oauth:open', { attemptId });
      if (!alive.current) return;

      if (!opened.ok) {
        const m = messageFor(opened.code, opened.message);
        setSignIn((s) => reduce(s, { type: 'failed', ...m }));
        // The attempt holds a port and a pending row; release both.
        void callResult('oauth:cancel', { attemptId });
        return;
      }

      /*
       * `oauth:complete` does not resolve until the callback arrives, so this
       * await *is* the waiting period. The state stays `waiting` throughout: the
       * renderer is told nothing between the callback and the created account,
       * and inventing a "finishing" label would misdescribe the wait.
       */
      const done = await callResult('oauth:complete', { attemptId });
      if (!alive.current) return;

      if (!done.ok) {
        /*
         * A cancellation is an expected outcome, not a failure. The main process
         * reports it as OAUTH_CANCELLED, and it gets its own state so the UI does
         * not imply something went wrong.
         */
        if (done.code === 'OAUTH_CANCELLED') {
          setSignIn((s) => reduce(s, { type: 'cancelled' }));
          return;
        }
        const m = messageFor(done.code, done.message);
        setSignIn((s) => reduce(s, { type: 'failed', ...m }));
        return;
      }

      const account = done.value;
      setSignIn((s) => reduce(s, { type: 'succeeded', email: account.email, label: account.label }));
      setAccounts((prev) => {
        const next = prev.some((a) => a.id === account.id) ? prev : [...prev, account];
        onAccountsChanged?.(next);
        return next;
      });
      void loadState(account);
    },
    [loadState, onAccountsChanged]
  );

  const cancelSignIn = useCallback(() => {
    setSignIn((s) => {
      // Only an attempt with an id has something to release in the main process.
      if (s.kind === 'waiting') {
        void callResult('oauth:cancel', { attemptId: s.attemptId });
      }
      return reduce(s, { type: 'cancelled' });
    });
  }, []);

  const removeAccount = useCallback(
    async (account: Account) => {
      setRemovingId(account.id);
      setRemoveError(null);

      const res = await callResult('accounts:remove', { id: account.id });
      if (!alive.current) return;
      setRemovingId(null);

      if (!res.ok) {
        setRemoveError(res.message);
        return;
      }

      setAccounts((prev) => {
        const next = prev.filter((a) => a.id !== account.id);
        onAccountsChanged?.(next);
        return next;
      });
      setStates((prev) => {
        const next = { ...prev };
        delete next[account.id];
        return next;
      });
    },
    [onAccountsChanged]
  );

  const busy = isBusy(signIn);

  // The panel is the primary surface until an account exists, after which it
  // moves below the list: a returning user came to see their accounts.
  const panelFirst = accounts.length === 0;

  const panel = useMemo(
    () => (
      <SignInPanel
        state={signIn}
        ready={ready}
        onSelect={(provider) => void startSignIn(provider)}
        onCancel={cancelSignIn}
        onDismiss={() => setSignIn(initialState())}
        onRetry={() => {
          const provider = signIn.kind === 'idle' ? 'google' : signIn.provider;
          void startSignIn(provider);
        }}
      />
    ),
    [signIn, ready, startSignIn, cancelSignIn]
  );

  const list = (
    <>
      {removeError && (
        <p className="accts__error" role="alert">
          {removeError}
        </p>
      )}
      <AccountList
        accounts={accounts}
        states={states}
        loading={loading}
        removingId={removingId}
        onRemove={(account) => void removeAccount(account)}
        onRefreshState={(account) => void loadState(account)}
      />
    </>
  );

  return (
    <div className="setup">
      <header className="setup__head">
        <div>
          <h1 className="setup__title">{accounts.length > 0 ? 'Accounts' : 'Set up your mail'}</h1>
          <p className="setup__subtitle">
            {accounts.length > 0
              ? 'Manage the mailboxes connected to Phutrue.'
              : `Connect a ${providerCompany('google')} or ${providerCompany('microsoft')} account to begin.`}
          </p>
        </div>
      </header>

      {loadError && (
        <div className="setup__error" role="alert">
          <p>{loadError}</p>
          <button type="button" className="btn btn--quiet" onClick={() => void loadAccounts()}>
            Try again
          </button>
        </div>
      )}

      {panelFirst ? (
        <>
          {panel}
          {!loading && accounts.length === 0 && !loadError && (
            <p className="setup__footnote">Nothing is shared with Baraily Inovex. Mail stays on your machine.</p>
          )}
        </>
      ) : (
        <>
          {list}
          {/* A second sign-in is allowed, but the panel collapses out of the way. */}
          {busy || signIn.kind !== 'idle' ? panel : <AddAnother onSelect={(p) => void startSignIn(p)} />}
        </>
      )}
    </div>
  );
}

/** The compact "add another" control shown once at least one account exists. */
function AddAnother({ onSelect }: { onSelect: (provider: OAuthProvider) => void }): JSX.Element {
  return (
    <div className="add-another">
      <h2 className="add-another__title">Add another account</h2>
      <div className="add-another__buttons">
        <button type="button" className="btn btn--quiet" onClick={() => onSelect('google')}>
          Add Gmail account
        </button>
        <button type="button" className="btn btn--quiet" onClick={() => onSelect('microsoft')}>
          Add Microsoft account
        </button>
      </div>
    </div>
  );
}
