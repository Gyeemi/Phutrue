/**
 * PKCE (Proof Key for Code Exchange, RFC 7636) and `state` generation.
 *
 * Why PKCE is mandatory here, not optional:
 *
 * Phutrue uses a loopback redirect (`http://127.0.0.1:<port>`), because an
 * embedded login window is prohibited and a custom URI scheme is hijackable by
 * any other local application that claims it. But a loopback redirect is
 * reachable by *any* process on the machine, so an intercepted authorization
 * code is a realistic threat. PKCE is what makes an intercepted code useless:
 * the code is only exchangeable by whoever can produce the matching verifier,
 * which never leaves this process.
 *
 * `state` defends a different attack: a forged callback that tricks the app into
 * completing a flow the user did not start. It is compared in constant time and
 * is single-use.
 *
 * Everything in this module is pure and takes its randomness as a parameter, so
 * the behaviour is exactly testable. There is no `Math.random` anywhere.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** Source of cryptographic randomness, injected for tests. */
export type RandomBytes = (size: number) => Buffer;

export const defaultRandomBytes: RandomBytes = (size) => randomBytes(size);

/**
 * base64url without padding, per RFC 7636 §A.
 *
 * `base64url` is not a Node Buffer encoding alias, so the transformation is done
 * explicitly rather than relying on a version-dependent encoding name.
 */
export function base64UrlEncode(buf: Buffer): string {
  return buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * A code verifier: 32 random bytes, base64url encoded.
 *
 * 32 bytes gives 43 characters, satisfying RFC 7636's 43–128 character range
 * with 256 bits of entropy. The RFC's minimum is 32 characters; using the full
 * 256 bits avoids relying on that floor.
 */
export function generateCodeVerifier(random: RandomBytes = defaultRandomBytes): string {
  return base64UrlEncode(random(32));
}

/** S256 challenge: base64url(SHA-256(verifier)). */
export function codeChallengeS256(verifier: string): string {
  return base64UrlEncode(createHash('sha256').update(verifier, 'ascii').digest());
}

/**
 * A `state` value: 32 random bytes base64url encoded.
 *
 * Long enough that guessing is infeasible, and URL-safe so it survives the round
 * trip through the browser untouched.
 */
export function generateState(random: RandomBytes = defaultRandomBytes): string {
  return base64UrlEncode(random(32));
}

/**
 * Hash a `state` for storage.
 *
 * The raw state travels through the user's browser and appears in provider logs,
 * so it is not stored. Storing SHA-256(state) means a leaked database cannot be
 * used to forge a callback.
 */
export function hashState(state: string): string {
  return createHash('sha256').update(state, 'utf8').digest('hex');
}

/**
 * Constant-time comparison of two `state` strings.
 *
 * A timing-variable comparison would leak, byte by byte, how much of a guessed
 * state was correct. `timingSafeEqual` throws on length mismatch, so the length
 * check is explicit — and length is not secret, since every state is 43 chars.
 */
export function stateMatches(expected: string, received: string): boolean {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(received, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Verify a verifier/challenge pair. Used by tests and by callback sanity checks. */
export function verifierMatchesChallenge(verifier: string, challenge: string): boolean {
  return stateMatches(codeChallengeS256(verifier), challenge);
}
