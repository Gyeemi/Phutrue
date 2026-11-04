/**
 * Parsing and validation of the OAuth redirect back to the loopback listener.
 *
 * This is the most security-sensitive parsing in the app: the bytes it handles
 * arrive from a browser, so they may come from an attacker who guessed the port.
 * The rules are therefore deny-by-default.
 *
 * What the callback can contain:
 *   ?code=...&state=...            the success case
 *   ?error=access_denied&state=...  the user declined
 *   ?error=...&error_description=...  any other failure
 *
 * What must never happen:
 *   - a callback with no `state` is accepted (nothing to match it against);
 *   - a `state` that does not match the pending attempt is accepted;
 *   - a replayed callback is accepted;
 *   - an `error_description` from the provider is rendered to the user verbatim
 *     (it is attacker-influenced text; it is mapped, not echoed).
 */

export type CallbackResult =
  | { kind: 'code'; code: string; state: string }
  | { kind: 'error'; error: string; state: string | null }
  | { kind: 'invalid'; reason: string };

/**
 * Provider error codes reduced to a stable, safe category.
 *
 * The provider's `error_description` is deliberately NOT used: it is
 * attacker-influenceable text and could contain anything, including something
 * shaped like a credential prompt. A mapped code is safe to display and to log.
 */
export type OAuthErrorCode =
  | 'access_denied'
  | 'invalid_request'
  | 'invalid_client'
  | 'invalid_grant'
  | 'unauthorized_client'
  | 'unsupported_response_type'
  | 'invalid_scope'
  | 'server_error'
  | 'temporarily_unavailable'
  | 'unknown';

const KNOWN_ERRORS: readonly OAuthErrorCode[] = [
  'access_denied',
  'invalid_request',
  'invalid_client',
  'invalid_grant',
  'unauthorized_client',
  'unsupported_response_type',
  'invalid_scope',
  'server_error',
  'temporarily_unavailable',
];

export function normaliseErrorCode(raw: string | null): OAuthErrorCode {
  if (!raw) return 'unknown';
  return (KNOWN_ERRORS as readonly string[]).includes(raw) ? (raw as OAuthErrorCode) : 'unknown';
}

/**
 * A plausible authorization code.
 *
 * Bounded and character-restricted before it is ever used in a request. Provider
 * codes are opaque but always URL-safe; anything else is a sign the request did
 * not come from a provider, so it is refused rather than forwarded.
 */
const CODE_RE = /^[A-Za-z0-9._~+/=-]{1,4096}$/;

/**
 * A plausible `state`: base64url, 43 characters for our generator, but the check
 * is a range so a future change to the generator does not silently break it.
 */
const STATE_RE = /^[A-Za-z0-9_-]{16,256}$/;

/**
 * Parse the query string of an incoming callback.
 *
 * @param rawUrl The full request URL, e.g. `/callback?code=...&state=...`
 */
export function parseCallback(rawUrl: string): CallbackResult {
  let url: URL;
  try {
    // A fixed base: only the path and query are used.
    url = new URL(rawUrl, 'http://127.0.0.1');
  } catch {
    return { kind: 'invalid', reason: 'malformed-url' };
  }

  if (url.pathname !== '/callback') {
    return { kind: 'invalid', reason: 'unexpected-path' };
  }

  const params = url.searchParams;
  const state = params.get('state');
  const error = params.get('error');
  const code = params.get('code');

  if (error !== null) {
    // An error callback may or may not carry state. It is reported either way,
    // but a state that is present and invalid is caught by the caller.
    return {
      kind: 'error',
      error: normaliseErrorCode(error),
      state: state !== null && STATE_RE.test(state) ? state : null,
    };
  }

  // Success requires BOTH parts. A code without state cannot be matched to a
  // pending attempt, and accepting it would let a stranger on the loopback port
  // inject their own authorization code.
  if (state === null || !STATE_RE.test(state)) {
    return { kind: 'invalid', reason: 'missing-or-malformed-state' };
  }
  if (code === null || !CODE_RE.test(code)) {
    return { kind: 'invalid', reason: 'missing-or-malformed-code' };
  }

  return { kind: 'code', code, state };
}

/**
 * Why a callback was refused, as safe user-facing text.
 *
 * Deliberately vague about *which* check failed in a way that is useful to the
 * user but not to someone probing the listener, while still being specific
 * enough to act on.
 */
export function explainCallbackFailure(reason: string): string {
  switch (reason) {
    case 'missing-or-malformed-state':
      return 'The sign-in response did not include a valid security token, so it was rejected. Please start again.';
    case 'missing-or-malformed-code':
      return 'The sign-in response did not include a valid authorization code. Please start again.';
    case 'unexpected-path':
      return 'An unexpected request reached the sign-in listener.';
    default:
      return 'The sign-in response could not be read. Please start again.';
  }
}

/** User-facing text for a provider error. Never echoes the provider's wording. */
export function explainProviderError(code: OAuthErrorCode): string {
  switch (code) {
    case 'access_denied':
      return 'Sign-in was cancelled, or permission was not granted. Phutrue needs mail access to manage your account.';
    case 'invalid_client':
      return 'This build is not registered with the provider. The application client ID is missing or was rejected.';
    case 'invalid_scope':
      return 'The provider refused the requested mail permissions for this application.';
    case 'invalid_grant':
      return 'The authorization code was not accepted. Please start the sign-in again.';
    case 'unauthorized_client':
      return 'This application is not authorised for the selected account type.';
    case 'temporarily_unavailable':
    case 'server_error':
      return 'The provider is temporarily unavailable. Please try again in a moment.';
    default:
      return 'Sign-in failed at the provider. Please try again.';
  }
}
