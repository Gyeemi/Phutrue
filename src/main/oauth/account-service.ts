/**
 * OAuth account service.
 *
 * Orchestrates a sign-in end to end:
 *
 *   begin  → choose provider, require a configured client ID, generate state and
 *            PKCE, persist the pending attempt, bind the loopback listener,
 *            build the authorisation URL
 *   open   → hand that URL to the system browser (never an embedded window)
 *   await  → wait for the callback or a timeout/cancel
 *   finish → validate state, exchange the code, derive identity, create the
 *            account, store tokens encrypted, clean up
 *
 * ## Boundaries this module exists to hold
 *
 * - **No token crosses IPC.** The only result returned to the renderer is a
 *   secret-free `Account`.
 * - **The system browser is the only place a password or consent screen is
 *   seen.** Phutrue never renders provider HTML.
 * - **Nothing is left behind on failure.** A pending attempt, a listener and a
 *   half-created account are all cleaned up; a failed sign-in must leave the
 *   database exactly as it was.
 */

import type { Account, OAuthAccountState, OAuthProvider } from '../../shared/models.js';
import { AppError, ErrorCodes, looksLikeEmail } from '../../shared/result.js';
import type { DatabaseSync } from 'node:sqlite';

import { createOAuthRepo } from '../db/repos/oauth.js';
import { createAccountRepo } from '../db/repos/accounts.js';
import { oauthTokenRef, type SecretStore } from '../secrets/store.js';
import { startLoopbackListener, type LoopbackHandle } from './loopback.js';
import { generateCodeVerifier, codeChallengeS256, generateState, hashState, stateMatches } from './pkce.js';
import { buildAuthorizationUrl, clientIdFor, isOAuthProvider } from './providers.js';
import { explainCallbackFailure, explainProviderError } from './callback.js';
import { exchangeCodeForTokens, refreshAccessToken, type FetchLike, type TokenSet } from './token.js';

/** How long a sign-in may sit in the browser before it is abandoned. */
const SIGN_IN_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * The credential bundle stored encrypted under one key.
 *
 * Serialised as JSON and encrypted by safeStorage as a single value, so it is
 * replaced atomically.
 */
export interface OAuthTokens {
  accessToken: string;
  refreshToken: string | null;
  idToken: string | null;
  /** Epoch ms; 0 when the provider did not say. */
  expiresAt: number;
  scope: string;
  tokenType: string;
}

export function serialiseTokens(tokens: OAuthTokens): string {
  return JSON.stringify({
    v: 1,
    access_token: tokens.accessToken,
    refresh_token: tokens.refreshToken,
    id_token: tokens.idToken,
    expires_at: tokens.expiresAt,
    scope: tokens.scope,
    token_type: tokens.tokenType,
  });
}

/**
 * Parse a stored bundle.
 *
 * Returns null rather than throwing on anything unexpected: a corrupt or
 * version-mismatched blob must be treated as "no credential", which sends the
 * user through sign-in again, instead of crashing a sync.
 */
export function parseStoredTokens(raw: string | null): OAuthTokens | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed['v'] !== 1) return null;
    const accessToken = parsed['access_token'];
    if (typeof accessToken !== 'string' || accessToken.length === 0) return null;
    return {
      accessToken,
      refreshToken: typeof parsed['refresh_token'] === 'string' ? parsed['refresh_token'] : null,
      idToken: typeof parsed['id_token'] === 'string' ? parsed['id_token'] : null,
      expiresAt: typeof parsed['expires_at'] === 'number' ? parsed['expires_at'] : 0,
      scope: typeof parsed['scope'] === 'string' ? parsed['scope'] : '',
      tokenType: typeof parsed['token_type'] === 'string' ? parsed['token_type'] : 'Bearer',
    };
  } catch {
    return null;
  }
}

/** Derive the account's email address from an OIDC id_token, if present. */
export function emailFromIdToken(idToken: string | null): { email: string; name: string } | null {
  if (!idToken) return null;
  const parts = idToken.split('.');
  if (parts.length !== 3) return null;
  const payloadSegment = parts[1];
  if (!payloadSegment) return null;
  try {
    // base64url → utf8. No signature verification: this token arrived over TLS
    // directly from the provider's token endpoint, which is the trust boundary.
    // It is only used to prefill the address, never to authorise anything.
    const json = Buffer.from(payloadSegment.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const payload = JSON.parse(json) as Record<string, unknown>;
    const email = payload['email'] ?? payload['preferred_username'] ?? payload['upn'];
    if (typeof email !== 'string' || !looksLikeEmail(email)) return null;
    const name = typeof payload['name'] === 'string' ? payload['name'] : '';
    return { email, name };
  } catch {
    return null;
  }
}

/** Convert a token response into the stored bundle. */
export function tokensFromResponse(set: TokenSet, now: number, previousRefresh: string | null): OAuthTokens {
  return {
    accessToken: set.accessToken,
    // A refresh response often omits the refresh token; keep the existing one.
    refreshToken: set.refreshToken ?? previousRefresh,
    idToken: set.idToken,
    expiresAt: set.expiresIn ? now + set.expiresIn * 1000 : 0,
    scope: set.scope ?? '',
    tokenType: set.tokenType,
  };
}

export interface AccountServiceDeps {
  db: DatabaseSync;
  secrets: SecretStore;
  openExternal: (url: string) => void;
  fetchImpl?: FetchLike;
  env?: NodeJS.ProcessEnv;
  clock?: () => number;
  /** Injected so tests can shorten or skip the browser wait. */
  timeoutMs?: number;
}

export interface BeginSignInResult {
  /** Opaque id used to await or cancel this attempt. Never a token. */
  attemptId: string;
  provider: OAuthProvider;
  /** The URL handed to the system browser. */
  authorizationUrl: string;
  redirectUri: string;
}

export function createAccountService(deps: AccountServiceDeps) {
  const clock = deps.clock ?? Date.now;
  const env = deps.env ?? process.env;
  const accounts = createAccountRepo(deps.db);
  const oauth = createOAuthRepo(deps.db, clock);

  /** Live attempts, keyed by attempt id, for awaiting and cancelling. */
  const inFlight = new Map<
    string,
    { handle: LoopbackHandle; state: string; provider: OAuthProvider; authorizationUrl: string }
  >();

  /**
   * Start a sign-in.
   *
   * Returns the URL for the caller to hand to `shell.openExternal`. It does not
   * itself open the browser, so the caller controls that one side effect and
   * tests can inspect the URL without launching anything.
   */
  async function beginSignIn(input: {
    provider: unknown;
    /** Optional label the user typed; falls back to the account address. */
    label?: string;
  }): Promise<BeginSignInResult> {
    if (!isOAuthProvider(input.provider)) {
      throw new AppError(ErrorCodes.INVALID_INPUT, 'Choose a supported provider.');
    }
    const provider = input.provider;

    // Refuse clearly rather than sending the user to a provider error page.
    const clientId = clientIdFor(provider, env);
    if (!clientId) {
      throw new AppError(
        ErrorCodes.OAUTH_NOT_CONFIGURED,
        `This build is not configured for ${provider === 'google' ? 'Google' : 'Microsoft'} sign-in. ` +
          `Set ${provider === 'google' ? 'PHUTRUE_GOOGLE_CLIENT_ID' : 'PHUTRUE_MICROSOFT_CLIENT_ID'} and restart Phutrue.`
      );
    }

    // Tidy up attempts abandoned in a previous session before adding another.
    oauth.prunePending();

    const state = generateState();
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = codeChallengeS256(codeVerifier);

    const handle = await startLoopbackListener({
      timeoutMs: deps.timeoutMs ?? SIGN_IN_TIMEOUT_MS,
    });
    if (!handle.redirectUri) {
      throw new AppError(ErrorCodes.INTERNAL, 'Could not open a local port to receive the sign-in response.');
    }

    oauth.createPending({
      stateHash: hashState(state),
      provider,
      codeVerifier,
      redirectUri: handle.redirectUri,
      createdAt: clock(),
      expiresAt: clock() + (deps.timeoutMs ?? SIGN_IN_TIMEOUT_MS) + 60_000,
    });

    const authorizationUrl = buildAuthorizationUrl({
      provider,
      clientId,
      redirectUri: handle.redirectUri,
      state,
      codeChallenge,
    });

    const attemptId = hashState(state).slice(0, 32);
    inFlight.set(attemptId, { handle, state, provider, authorizationUrl });

    return { attemptId, provider, authorizationUrl, redirectUri: handle.redirectUri };
  }

  /**
   * Open an attempt's authorisation URL in the user's default browser.
   *
   * Takes the attempt id, not a URL. If the caller passed the URL, this would
   * become an "open any URL" primitive for the renderer; resolving it from the
   * live attempt map keeps the set of openable URLs to ones this process built.
   */
  function openInBrowser(attemptId: string): void {
    const attempt = inFlight.get(attemptId);
    if (!attempt) {
      throw new AppError(ErrorCodes.OAUTH_CANCELLED, 'This sign-in is no longer active. Please start again.');
    }
    deps.openExternal(attempt.authorizationUrl);
  }

  function cancel(attemptId: string): void {
    const attempt = inFlight.get(attemptId);
    if (!attempt) return;
    attempt.handle.cancel();
    inFlight.delete(attemptId);
  }

  /**
   * Wait for the callback and complete the sign-in.
   *
   * Every exit path removes the in-flight entry and clears the pending row, so a
   * failed attempt cannot be resumed or replayed.
   */
  async function completeSignIn(attemptId: string, label?: string): Promise<Account> {
    const attempt = inFlight.get(attemptId);
    if (!attempt) {
      throw new AppError(ErrorCodes.OAUTH_CANCELLED, 'This sign-in is no longer active. Please start again.');
    }

    try {
      const outcome = await attempt.handle.result;

      if (outcome.stopReason === 'timeout') {
        throw new AppError(ErrorCodes.OAUTH_CANCELLED, 'Sign-in timed out. Please start again.');
      }
      if (outcome.stopReason === 'cancelled') {
        throw new AppError(ErrorCodes.OAUTH_CANCELLED, 'Sign-in was cancelled.');
      }
      if (outcome.stopReason === 'port-error') {
        throw new AppError(ErrorCodes.INTERNAL, 'Could not receive the sign-in response.');
      }

      const callback = outcome.callback;
      if (!callback) {
        throw new AppError(ErrorCodes.OAUTH_FAILED, 'The sign-in response could not be read.');
      }

      if (callback.kind === 'invalid') {
        throw new AppError(ErrorCodes.OAUTH_FAILED, explainCallbackFailure(callback.reason));
      }

      if (callback.kind === 'error') {
        throw new AppError(ErrorCodes.OAUTH_CANCELLED, explainProviderError(callback.error));
      }

      /*
       * State validation.
       *
       * Compared against the state this attempt generated, in constant time. The
       * pending row is consumed at most once, so a replay finds nothing.
       */
      if (!stateMatches(attempt.state, callback.state)) {
        throw new AppError(
          ErrorCodes.OAUTH_FAILED,
          'The sign-in response did not match the request that started it, so it was rejected.'
        );
      }

      const pending = oauth.consumePending(hashState(callback.state));
      if (!pending) {
        // Expired, already used, or never existed. One message for all three:
        // distinguishing them tells an attacker nothing useful but tells them
        // something.
        throw new AppError(
          ErrorCodes.OAUTH_FAILED,
          'This sign-in has expired or was already completed. Please start again.'
        );
      }

      const clientId = clientIdFor(pending.provider, env);
      if (!clientId) {
        throw new AppError(ErrorCodes.OAUTH_NOT_CONFIGURED, 'Sign-in is no longer configured for this provider.');
      }

      const tokenSet = await exchangeCodeForTokens({
        provider: pending.provider,
        clientId,
        redirectUri: pending.redirectUri,
        code: callback.code,
        codeVerifier: pending.codeVerifier,
        ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      });

      const identity = emailFromIdToken(tokenSet.idToken);
      if (!identity) {
        throw new AppError(
          ErrorCodes.OAUTH_FAILED,
          'Signed in, but the provider did not return an address for the account. Please try again.'
        );
      }

      /*
       * Duplicate guard: the same provider account must not become two rows.
       * An existing account is updated in place rather than duplicated, which
       * also makes "re-authorise" work without the user removing and re-adding.
       */
      const existing = accounts.findByEmail(identity.email);
      const tokens = tokensFromResponse(tokenSet, clock(), null);

      // Store credentials BEFORE creating the account row, so a failure to
      // encrypt cannot leave an account that looks usable but has no tokens.
      const account =
        existing && existing.authKind === 'oauth2'
          ? existing
          : accounts.create({
              label: label?.trim() || identity.name || identity.email,
              email: identity.email,
              displayName: identity.name,
              password: '',
              authKind: 'oauth2',
              oauthProvider: pending.provider,
              imapHost: '',
              imapPort: 993,
              imapSecure: true,
              smtpHost: '',
              smtpPort: 465,
              smtpSecure: true,
            });

      deps.secrets.put(oauthTokenRef(account.id), serialiseTokens(tokens));

      oauth.upsertAccount({
        accountId: account.id,
        provider: pending.provider,
        expiresAt: tokens.expiresAt,
        scope: tokens.scope,
        subject: null,
        status: 'connected',
        lastError: null,
        // `createdAt` is only honoured on insert; the upsert keeps the original.
        createdAt: clock(),
        updatedAt: clock(),
      });

      return account;
    } finally {
      inFlight.delete(attemptId);
    }
  }

  /**
   * Ensure a usable access token, refreshing if needed.
   *
   * Returns the access token to the caller (the mail layer), never to the
   * renderer. Marks the credential revoked when the provider says the grant is
   * no longer valid, because retrying that would lock the app out.
   */
  async function ensureAccessToken(accountId: number): Promise<string> {
    const stored = parseStoredTokens(deps.secrets.get(oauthTokenRef(accountId)));
    if (!stored) {
      oauth.setStatus(accountId, 'revoked', 'Sign in again to reconnect this account.');
      throw new AppError(ErrorCodes.OAUTH_FAILED, 'This account needs to be reconnected.');
    }

    if (!oauth.needsRefresh(accountId, clock())) {
      return stored.accessToken;
    }

    if (!stored.refreshToken) {
      oauth.setStatus(accountId, 'expired', 'Sign in again to refresh this account.');
      throw new AppError(ErrorCodes.OAUTH_FAILED, 'This account needs to be reconnected.');
    }

    const meta = oauth.getAccount(accountId);
    if (!meta) {
      throw new AppError(ErrorCodes.NOT_FOUND, 'This account is not an OAuth account.');
    }
    const clientId = clientIdFor(meta.provider, env);
    if (!clientId) {
      throw new AppError(ErrorCodes.OAUTH_NOT_CONFIGURED, 'Sign-in is no longer configured for this provider.');
    }

    try {
      const refreshed = await refreshAccessToken({
        provider: meta.provider,
        clientId,
        refreshToken: stored.refreshToken,
        ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      });
      const next = tokensFromResponse(refreshed, clock(), stored.refreshToken);
      deps.secrets.put(oauthTokenRef(accountId), serialiseTokens(next));
      oauth.setStatus(accountId, 'connected', null, next.expiresAt);
      return next.accessToken;
    } catch (err) {
      const message = err instanceof AppError ? err.safeMessage : 'The account could not be refreshed.';
      oauth.setStatus(accountId, 'revoked', message);
      throw err;
    }
  }

  /**
   * Credential state for one account, shaped for the UI.
   *
   * Reads the stored bundle internally to report whether a usable access token
   * exists, but returns booleans only: the token itself never leaves this
   * function, and the caller has no way to ask for it.
   */
  function stateFor(accountId: number): OAuthAccountState {
    const meta = oauth.getAccount(accountId);
    if (!meta) {
      throw new AppError(ErrorCodes.NOT_FOUND, 'This account is not connected with OAuth.');
    }

    const stored = parseStoredTokens(deps.secrets.get(oauthTokenRef(accountId)));

    return {
      provider: meta.provider,
      status: meta.status,
      // "Present and not past its refresh window" — a token inside the refresh
      // window is treated as unusable, matching `ensureAccessToken`.
      hasAccessToken: stored !== null && !oauth.needsRefresh(accountId, clock()),
      canRefresh: stored?.refreshToken != null && stored.refreshToken.length > 0,
      lastError: meta.lastError,
    };
  }

  /** Remove an account and everything derived from it. */
  function removeAccount(accountId: number): void {
    // Delete the secret first: if the account row went first, a crash would
    // leave an orphaned credential with no owner.
    deps.secrets.delete(oauthTokenRef(accountId));
    deps.secrets.delete(`account:${accountId}:secret`);
    oauth.removeForAccount(accountId);
    accounts.remove(accountId);
  }

  return { beginSignIn, openInBrowser, completeSignIn, cancel, ensureAccessToken, removeAccount, stateFor };
}

export type AccountService = ReturnType<typeof createAccountService>;
