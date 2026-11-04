/**
 * Provider cards.
 *
 * Two fixed choices rather than a dropdown: there are exactly two, the choice is
 * consequential, and each needs a sentence of explanation that a select element
 * cannot show.
 *
 * The buttons are the only way to start sign-in, and both are disabled while any
 * attempt is running — the state machine also refuses the transition, but a
 * disabled control is what tells the user why nothing happened.
 */

import type { OAuthProvider } from '../../shared/models.js';
import { providerCompany } from '../app/signin-machine.js';

interface ProviderCardProps {
  provider: OAuthProvider;
  title: string;
  description: string;
  /** Disabled while a sign-in is in flight. */
  disabled: boolean;
  /** True when this provider is the one currently being signed into. */
  active: boolean;
  onSelect: (provider: OAuthProvider) => void;
}

/**
 * Provider marks.
 *
 * Drawn as plain CSS shapes from brand-adjacent colours rather than importing
 * Google's or Microsoft's logo files: those are trademarked, and shipping them
 * would need the providers' brand guidelines followed exactly. A neutral mark
 * beside the provider's name is enough to distinguish the two cards.
 */
function ProviderMark({ provider }: { provider: OAuthProvider }): JSX.Element {
  return (
    <span className={`provider__mark provider__mark--${provider}`} aria-hidden="true">
      {provider === 'google' ? (
        <>
          <span className="provider__mark-dot provider__mark-dot--blue" />
          <span className="provider__mark-dot provider__mark-dot--red" />
          <span className="provider__mark-dot provider__mark-dot--yellow" />
          <span className="provider__mark-dot provider__mark-dot--green" />
        </>
      ) : (
        <>
          <span className="provider__mark-square provider__mark-square--red" />
          <span className="provider__mark-square provider__mark-square--green" />
          <span className="provider__mark-square provider__mark-square--blue" />
          <span className="provider__mark-square provider__mark-square--yellow" />
        </>
      )}
    </span>
  );
}

export function ProviderCard({
  provider,
  title,
  description,
  disabled,
  active,
  onSelect,
}: ProviderCardProps): JSX.Element {
  return (
    <div className={`provider provider--${provider}${active ? ' is-active' : ''}`}>
      <ProviderMark provider={provider} />
      <div className="provider__body">
        <h3 className="provider__title">{title}</h3>
        <p className="provider__desc">{description}</p>
      </div>
      <button
        type="button"
        className="btn btn--primary provider__button"
        disabled={disabled}
        // The accessible name distinguishes the two buttons, which would
        // otherwise both read "Sign in".
        aria-label={`Sign in with ${providerCompany(provider)}`}
        onClick={() => onSelect(provider)}
      >
        {active ? 'Signing in…' : 'Sign in'}
      </button>
    </div>
  );
}
