/**
 * Provider definitions: endpoints, scopes and the authorisation URL.
 *
 * Data only, no I/O, so the URL construction is testable without a network.
 *
 * ## Client IDs
 *
 * A client ID is a *public* identifier, not a secret — but it is still
 * configuration, not source. It is read from the environment so that no value
 * ships in the repository and no contributor's registration leaks into a build:
 *
 *   PHUTRUE_GOOGLE_CLIENT_ID
 *   PHUTRUE_MICROSOFT_CLIENT_ID
 *
 * When unset, the flow refuses to start with an actionable message. It never
 * falls back to a placeholder, because a placeholder would produce a confusing
 * provider-side error instead of a clear one.
 *
 * ## What is NOT here
 *
 * No client secret. Both providers support the authorisation-code flow with PKCE
 * for native/desktop clients, where the client is public and holds no secret.
 * Shipping a secret in a desktop binary would be security theatre: anyone can
 * extract it. PKCE plus a loopback redirect is the correct model for this class
 * of application, and it is what both providers document for native apps.
 */

import type { OAuthProvider } from '../../shared/models.js';

export interface ProviderConfig {
  id: OAuthProvider;
  /** Human-readable name for the UI. */
  displayName: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  /** Scopes requested. IMAP/SMTP access, offline refresh, and identity. */
  scopes: readonly string[];
  /** Environment variable that supplies the public client ID. */
  clientIdEnvVar: string;
  /** Provider-specific parameters required to receive a refresh token. */
  extraAuthParams?: Readonly<Record<string, string>>;
}

export const PROVIDERS: Readonly<Record<OAuthProvider, ProviderConfig>> = {
  google: {
    id: 'google',
    displayName: 'Google',
    authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenEndpoint: 'https://oauth2.googleapis.com/token',
    /*
     * `https://mail.google.com/` is the full IMAP/SMTP scope, and it is
     * restricted: Google requires the app to be verified before it can be
     * requested by non-test users. `openid email profile` gives identity so the
     * account's address can be read without asking the user to type it.
     *
     * A narrower scope would look less alarming on the consent screen but would
     * not permit mail access, which is the entire point of the account.
     */
    scopes: [
      'openid',
      'email',
      'profile',
      'https://mail.google.com/',
    ],
    clientIdEnvVar: 'PHUTRUE_GOOGLE_CLIENT_ID',
    // Without these Google returns an access token but no refresh token, which
    // would silently break background sync after the first hour.
    extraAuthParams: { access_type: 'offline', prompt: 'consent' },
  },
  microsoft: {
    id: 'microsoft',
    displayName: 'Microsoft',
    // `common` accepts both work/school accounts and personal accounts.
    authorizationEndpoint: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    tokenEndpoint: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    scopes: [
      'offline_access',
      'openid',
      'email',
      'profile',
      // IMAP and SMTP are separate delegated scopes in Microsoft Graph's model.
      'https://outlook.office.com/IMAP.AccessAsUser.All',
      'https://outlook.office.com/SMTP.Send',
    ],
    clientIdEnvVar: 'PHUTRUE_MICROSOFT_CLIENT_ID',
  },
};

/** True when the provider is one we implement. */
export function isOAuthProvider(value: unknown): value is OAuthProvider {
  return value === 'google' || value === 'microsoft';
}

/**
 * Read the configured client ID for a provider.
 *
 * Returns null when unset or blank. Blank matters: an empty environment variable
 * is "not configured", not "configured with an empty value".
 */
export function clientIdFor(
  provider: OAuthProvider,
  env: NodeJS.ProcessEnv = process.env
): string | null {
  const raw = env[PROVIDERS[provider].clientIdEnvVar];
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export interface AuthorizationUrlParams {
  provider: OAuthProvider;
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  /** Overridable for tests; defaults to the provider's configured scopes. */
  scopes?: readonly string[];
}

/**
 * Build the authorisation URL the user's browser is sent to.
 *
 * Uses `URL`/`URLSearchParams` rather than string concatenation so that every
 * value is percent-encoded correctly — a `redirect_uri` containing `:` and `/`
 * is the classic case where hand-built URLs break.
 */
export function buildAuthorizationUrl(params: AuthorizationUrlParams): string {
  const config = PROVIDERS[params.provider];
  const url = new URL(config.authorizationEndpoint);

  const scopes = params.scopes ?? config.scopes;

  url.searchParams.set('client_id', params.clientId);
  url.searchParams.set('redirect_uri', params.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', scopes.join(' '));
  url.searchParams.set('state', params.state);
  url.searchParams.set('code_challenge', params.codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');

  for (const [key, value] of Object.entries(config.extraAuthParams ?? {})) {
    url.searchParams.set(key, value);
  }

  return url.toString();
}
