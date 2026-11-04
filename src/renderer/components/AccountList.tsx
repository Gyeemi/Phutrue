/**
 * Connected accounts.
 *
 * Shows what the user needs to answer "is this account working?": the address,
 * the provider, and a status that reflects the *credential*, not a guess.
 *
 * Removal is confirmed inline rather than with `window.confirm`. Two reasons: a
 * modal blocks the whole window and cannot be styled or made accessible without
 * more machinery than this needs, and `confirm()` is unavailable in some
 * sandboxed contexts. Inline confirmation also keeps the button the user pressed
 * on screen, which is where their attention already is.
 */

import { useState } from 'react';

import type { Account, OAuthAccountState, OAuthProvider } from '../../shared/models.js';
import { providerName } from '../app/signin-machine.js';

interface AccountListProps {
  accounts: Account[];
  /** Credential state per account id. Missing means not yet loaded. */
  states: Record<number, OAuthAccountState>;
  loading: boolean;
  /** Account id currently being removed, if any. */
  removingId: number | null;
  onRemove: (account: Account) => void;
  /** Re-read the credential state, e.g. after a reconnect. */
  onRefreshState: (account: Account) => void;
}

/**
 * Turn a credential state into a badge.
 *
 * `expired` is deliberately not an error: the refresh token is still good and
 * the next operation renews the access token. Showing it in red would teach the
 * user to fear a normal condition. `revoked` is the one that needs action.
 */
function badge(state: OAuthAccountState | undefined): {
  tone: 'ok' | 'warn' | 'bad' | 'muted';
  label: string;
  hint: string | null;
} {
  if (!state) return { tone: 'muted', label: 'Checking…', hint: null };

  switch (state.status) {
    case 'connected':
      if (!state.hasAccessToken) {
        return {
          tone: 'warn',
          label: 'Renewing',
          hint: 'The access token has expired and will be renewed on the next operation.',
        };
      }
      return { tone: 'ok', label: 'Connected', hint: null };

    case 'expired':
      return {
        tone: 'warn',
        label: 'Expired',
        hint: 'Access has expired. It renews automatically the next time the account is used.',
      };

    case 'revoked':
      return {
        tone: 'bad',
        label: 'Reconnect needed',
        hint:
          state.lastError ??
          'Access was withdrawn at the provider. Remove the account and sign in again to restore it.',
      };

    case 'error':
      return {
        tone: 'bad',
        label: 'Problem',
        hint: state.lastError ?? 'The account could not be used. Try again, or sign in again.',
      };
  }
}

function ProviderBadge({ provider }: { provider: OAuthProvider | null }): JSX.Element {
  if (!provider) {
    // A password account (a later milestone). Named honestly rather than shown
    // with a wrong provider mark.
    return <span className="acct__provider acct__provider--other">Password</span>;
  }
  return <span className={`acct__provider acct__provider--${provider}`}>{providerName(provider)}</span>;
}

export function AccountList({
  accounts,
  states,
  loading,
  removingId,
  onRemove,
  onRefreshState,
}: AccountListProps): JSX.Element {
  const [confirmingId, setConfirmingId] = useState<number | null>(null);

  if (loading) {
    return (
      <div className="accts" aria-busy="true">
        <p className="accts__empty" role="status">
          Loading accounts…
        </p>
      </div>
    );
  }

  if (accounts.length === 0) {
    return (
      <div className="accts">
        <p className="accts__empty">
          No accounts yet. Choose a provider above to connect your first mailbox.
        </p>
      </div>
    );
  }

  return (
    <div className="accts">
      <ul className="accts__list">
        {accounts.map((account) => {
          const state = states[account.id];
          const b = badge(state);
          const isConfirming = confirmingId === account.id;
          const isRemoving = removingId === account.id;

          return (
            <li className="acct" key={account.id}>
              <div className="acct__main">
                <div className="acct__identity">
                  <span className="acct__label">{account.label || account.email}</span>
                  <span className="acct__email">{account.email}</span>
                </div>

                <div className="acct__meta">
                  <ProviderBadge provider={account.oauthProvider} />
                  <span className={`acct__status acct__status--${b.tone}`}>
                    <span className="acct__dot" aria-hidden="true" />
                    {b.label}
                  </span>
                </div>
              </div>

              {b.hint && (
                <p className={`acct__hint acct__hint--${b.tone}`} role={b.tone === 'bad' ? 'alert' : undefined}>
                  {b.hint}
                </p>
              )}

              <div className="acct__actions">
                {account.oauthProvider && (
                  <button
                    type="button"
                    className="btn btn--quiet btn--small"
                    onClick={() => onRefreshState(account)}
                    aria-label={`Check the connection for ${account.email}`}
                  >
                    Check connection
                  </button>
                )}

                {!isConfirming && (
                  <button
                    type="button"
                    className="btn btn--danger-quiet btn--small"
                    disabled={isRemoving}
                    onClick={() => setConfirmingId(account.id)}
                    aria-label={`Remove ${account.email}`}
                  >
                    {isRemoving ? 'Removing…' : 'Remove'}
                  </button>
                )}
              </div>

              {isConfirming && (
                <div className="acct__confirm" role="group" aria-label={`Confirm removal of ${account.email}`}>
                  <p className="acct__confirm-text">
                    Remove <strong>{account.email}</strong>? Phutrue will delete the stored
                    credential. You can add it again later.
                  </p>
                  <div className="acct__confirm-actions">
                    <button
                      type="button"
                      className="btn btn--danger btn--small"
                      disabled={isRemoving}
                      onClick={() => {
                        onRemove(account);
                        setConfirmingId(null);
                      }}
                    >
                      {isRemoving ? 'Removing…' : 'Remove account'}
                    </button>
                    <button
                      type="button"
                      className="btn btn--quiet btn--small"
                      disabled={isRemoving}
                      onClick={() => setConfirmingId(null)}
                    >
                      Keep account
                    </button>
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>

      <p className="accts__note">
        Sign-in credentials are encrypted with your operating system&apos;s key store and never
        leave this machine.
      </p>
    </div>
  );
}

export { badge as statusBadge };
