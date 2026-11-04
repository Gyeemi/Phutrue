/**
 * Token exchange and refresh.
 *
 * The only place in M3 that talks to the network. `fetch` is injected so every
 * branch — success, provider error, network failure, malformed JSON, a hostile
 * response of the wrong shape — is testable without a provider account.
 *
 * ## What must never happen
 *
 *   - Token values must never reach a log, an error message, or a `Result`
 *     surfaced to the renderer. This module returns them once, to the caller, in
 *     a struct that the credential store consumes immediately.
 *   - The provider's `error_description` must not be forwarded: it is text from
 *     the network and could contain anything.
 *   - A response of the wrong shape must be rejected rather than trusted, because
 *     a misconfigured endpoint or a proxy could return anything.
 */

import type { OAuthProvider } from '../../shared/models.js';
import { AppError, ErrorCodes } from '../../shared/result.js';
import { normaliseErrorCode, type OAuthErrorCode } from './callback.js';
import { PROVIDERS } from './providers.js';

export interface TokenSet {
  accessToken: string;
  /**
   * Present on first authorisation. Providers may omit it on refresh, in which
   * case the caller must keep the existing one rather than overwriting it with
   * nothing.
   */
  refreshToken: string | null;
  /** Lifetime in seconds as reported by the provider. */
  expiresIn: number | null;
  /** Scopes actually granted, which may be narrower than requested. */
  scope: string | null;
  /** OIDC identity token, when the openid scope was granted. */
  idToken: string | null;
  tokenType: string;
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** Bounded so a hung connection cannot stall the UI indefinitely. */
const REQUEST_TIMEOUT_MS = 30_000;

/** Reject absurdly large responses rather than parsing them. */
const MAX_RESPONSE_BYTES = 64 * 1024;

/**
 * Validate and narrow a token endpoint response.
 *
 * Every field is checked for type and length. A response that fails any check is
 * rejected wholesale: partially trusting a malformed response is how a wrong
 * value becomes a stored credential.
 */
export function parseTokenResponse(body: unknown): TokenSet {
  if (typeof body !== 'object' || body === null) {
    throw new AppError(ErrorCodes.OAUTH_FAILED, 'The provider returned an unreadable token response.');
  }
  const r = body as Record<string, unknown>;

  const accessToken = r['access_token'];
  if (typeof accessToken !== 'string' || accessToken.length === 0 || accessToken.length > 8192) {
    throw new AppError(ErrorCodes.OAUTH_FAILED, 'The provider did not return a usable access token.');
  }

  const tokenType = typeof r['token_type'] === 'string' ? r['token_type'] : 'Bearer';

  const refreshToken =
    typeof r['refresh_token'] === 'string' && r['refresh_token'].length > 0 && r['refresh_token'].length <= 8192
      ? r['refresh_token']
      : null;

  // Providers return `expires_in` as a number or, occasionally, a numeric string.
  let expiresIn: number | null = null;
  const rawExpires = r['expires_in'];
  if (typeof rawExpires === 'number' && Number.isFinite(rawExpires) && rawExpires > 0) {
    expiresIn = rawExpires;
  } else if (typeof rawExpires === 'string' && /^\d+$/.test(rawExpires)) {
    expiresIn = Number(rawExpires);
  }

  const scope = typeof r['scope'] === 'string' && r['scope'].length <= 2048 ? r['scope'] : null;
  const idToken = typeof r['id_token'] === 'string' && r['id_token'].length <= 16_384 ? r['id_token'] : null;

  return { accessToken, refreshToken, expiresIn, scope, idToken, tokenType };
}

/**
 * Classify a non-2xx token response.
 *
 * The body is read only to extract a machine-readable `error` code. Any
 * `error_description` is discarded: it is attacker-influenceable text and must
 * never be shown, logged, or stored.
 */
async function classifyFailure(res: Response): Promise<never> {
  let code: OAuthErrorCode = 'unknown';
  try {
    const text = await res.text();
    if (text.length <= MAX_RESPONSE_BYTES) {
      const body = JSON.parse(text) as Record<string, unknown>;
      code = normaliseErrorCode(typeof body['error'] === 'string' ? body['error'] : null);
    }
  } catch {
    // A body that is not JSON tells us nothing beyond the status code.
  }

  if (res.status === 401 || code === 'invalid_client' || code === 'invalid_grant') {
    throw new AppError(
      ErrorCodes.OAUTH_FAILED,
      code === 'invalid_grant'
        ? 'The sign-in code has expired or was already used. Please start again.'
        : 'The provider rejected Phutrue’s application credentials.'
    );
  }
  if (res.status === 429) {
    throw new AppError(
      ErrorCodes.OAUTH_FAILED,
      'The provider is rate limiting sign-in. Please wait a moment and try again.'
    );
  }
  if (res.status >= 500) {
    throw new AppError(
      ErrorCodes.NETWORK,
      'The provider is temporarily unavailable. Please try again shortly.'
    );
  }
  throw new AppError(ErrorCodes.OAUTH_FAILED, 'The provider rejected the sign-in request.');
}

/** POST a form body and return the parsed JSON, with size and time bounds. */
async function postForm(
  fetchImpl: FetchLike,
  endpoint: string,
  form: Record<string, string>
): Promise<TokenSet> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: new URLSearchParams(form).toString(),
      signal: controller.signal,
    });
  } catch {
    // A network error's message can include the URL; it is not surfaced.
    throw new AppError(ErrorCodes.NETWORK, 'Could not reach the provider to complete sign-in.');
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    await classifyFailure(res);
  }

  const text = await res.text();
  if (text.length > MAX_RESPONSE_BYTES) {
    throw new AppError(ErrorCodes.OAUTH_FAILED, 'The provider returned an oversized response.');
  }

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new AppError(ErrorCodes.OAUTH_FAILED, 'The provider returned an unreadable response.');
  }

  return parseTokenResponse(body);
}

/**
 * Exchange an authorization code for tokens.
 *
 * `code_verifier` is the PKCE secret that makes an intercepted code useless.
 */
export async function exchangeCodeForTokens(params: {
  provider: OAuthProvider;
  clientId: string;
  redirectUri: string;
  code: string;
  codeVerifier: string;
  fetchImpl?: FetchLike;
}): Promise<TokenSet> {
  const fetchImpl = params.fetchImpl ?? (fetch as FetchLike);
  const endpoint = PROVIDERS[params.provider].tokenEndpoint;

  return postForm(fetchImpl, endpoint, {
    grant_type: 'authorization_code',
    code: params.code,
    redirect_uri: params.redirectUri,
    client_id: params.clientId,
    code_verifier: params.codeVerifier,
  });
}

/**
 * Exchange a refresh token for a new access token.
 *
 * `invalid_grant` here means the user revoked access at the provider. That is a
 * terminal condition for the credential, and is reported as such rather than
 * retried, because retrying a revoked grant can lock the application out.
 */
export async function refreshAccessToken(params: {
  provider: OAuthProvider;
  clientId: string;
  refreshToken: string;
  fetchImpl?: FetchLike;
}): Promise<TokenSet> {
  const fetchImpl = params.fetchImpl ?? (fetch as FetchLike);
  const endpoint = PROVIDERS[params.provider].tokenEndpoint;

  return postForm(fetchImpl, endpoint, {
    grant_type: 'refresh_token',
    refresh_token: params.refreshToken,
    client_id: params.clientId,
  });
}
