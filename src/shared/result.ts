/**
 * Small shared helpers used by both processes.
 */

/** Stable error codes surfaced to the UI. Never include a secret. */
export const ErrorCodes = {
  INVALID_INPUT: 'INVALID_INPUT',
  UNKNOWN_CHANNEL: 'UNKNOWN_CHANNEL',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  DB_ERROR: 'DB_ERROR',
  SECURE_STORAGE_UNAVAILABLE: 'SECURE_STORAGE_UNAVAILABLE',
  IMAP_AUTH_FAILED: 'IMAP_AUTH_FAILED',
  IMAP_CONNECT_FAILED: 'IMAP_CONNECT_FAILED',
  SMTP_AUTH_FAILED: 'SMTP_AUTH_FAILED',
  SMTP_SEND_FAILED: 'SMTP_SEND_FAILED',
  OAUTH_FAILED: 'OAUTH_FAILED',
  /** The flow needs a client ID that this build was not configured with. */
  OAUTH_NOT_CONFIGURED: 'OAUTH_NOT_CONFIGURED',
  /** The user closed the consent screen, or the browser never returned. */
  OAUTH_CANCELLED: 'OAUTH_CANCELLED',
  NETWORK: 'NETWORK',
  CANCELLED: 'CANCELLED',
  INTERNAL: 'INTERNAL',
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

/**
 * An error that is safe to pass across the IPC boundary.
 *
 * Anything not of this type is converted to a generic INTERNAL error before
 * leaving the main process, so internal messages and stack traces never reach
 * the renderer.
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly safeMessage: string;

  constructor(code: ErrorCode, safeMessage: string, options?: { cause?: unknown }) {
    super(safeMessage, options);
    this.name = 'AppError';
    this.code = code;
    this.safeMessage = safeMessage;
  }
}

/** Clamp a number into an inclusive range. */
export function clamp(n: number, min: number, max: number): number {
  return n < min ? min : n > max ? max : n;
}

/** True when the string looks like a syntactically valid email address. */
export function looksLikeEmail(value: string): boolean {
  // Deliberately simple: full RFC 5322 validation is not useful here and
  // rejects addresses that servers accept. The server is the real validator.
  return /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/.test(value.trim());
}

/**
 * Split a user-entered address field into trimmed, non-empty entries.
 * Accepts comma, semicolon or newline separated input.
 */
export function splitAddresses(value: string | string[]): string[] {
  const raw = Array.isArray(value) ? value : value.split(/[,;\n]/);
  const out: string[] = [];
  for (const part of raw) {
    const t = part.trim();
    if (t) out.push(t);
  }
  return out;
}
