/**
 * Typed, validated IPC router.
 *
 * Responsibilities, in order:
 *   1. Reject a channel that is not on the allowlist.
 *   2. Reject a sender that is not one of our own windows.
 *   3. Validate the payload against the channel's zod schema.
 *   4. Run the handler.
 *   5. Convert the outcome to a Result — never throw across the boundary.
 *
 * Everything a handler receives has already passed 1–3.
 */

import { ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron';
import type { ZodType } from 'zod';

import { CHANNELS, type Channel, type ResOf, type Result } from '../../shared/ipc.js';
import { AppError, ErrorCodes } from '../../shared/result.js';
import { SCHEMAS } from './schemas.js';

export type Handler<C extends Channel> = (
  payload: unknown,
  context: { sender: WebContents }
) => Promise<ResOf<C>> | ResOf<C>;

type HandlerMap = { [C in Channel]?: Handler<C> };

const ALLOWED = new Set<string>(CHANNELS);

/**
 * Bind every channel to a handler and install the single ipcMain listener.
 *
 * One listener (rather than one per channel) means there is exactly one place
 * where authorization and validation happen, so a channel cannot accidentally
 * be registered without them.
 */
export function registerRouter(handlers: HandlerMap, isTrustedSender: (wc: WebContents) => boolean) {
  ipcMain.handle('phutrue:invoke', async (event: IpcMainInvokeEvent, channel: unknown, payload: unknown): Promise<Result<unknown>> => {
    // Captured before validation so the catch block can name the channel
    // without trusting its contents. Clamped: a hostile renderer could send a
    // huge string, and we only ever log it.
    const label = typeof channel === 'string' ? channel.slice(0, 64) : '(invalid)';
    try {
      /* 1. Channel allowlist ------------------------------------- */
      if (typeof channel !== 'string' || !ALLOWED.has(channel)) {
        return {
          ok: false,
          code: ErrorCodes.UNKNOWN_CHANNEL,
          message: 'Unknown request.',
        };
      }
      const ch = channel as Channel;

      /* 2. Sender authorization ---------------------------------- */
      if (!isTrustedSender(event.sender)) {
        return {
          ok: false,
          code: ErrorCodes.FORBIDDEN,
          message: 'Request from an untrusted frame.',
        };
      }

      /* 3. Payload validation ------------------------------------ */
      const schema = SCHEMAS[ch] as ZodType | undefined;
      let parsed: unknown = undefined;

      if (schema) {
        const result = schema.safeParse(payload);
        if (!result.success) {
          return {
            ok: false,
            code: ErrorCodes.INVALID_INPUT,
            // Report which fields failed, never the values: a value could be a
            // password. Paths only.
            message:
              'Invalid request: ' +
              result.error.issues
                .map((i) => i.path.join('.') || i.code)
                .join(', '),
          };
        }
        parsed = result.data;
      } else if (payload !== undefined && payload !== null) {
        // A channel that takes no arguments must not be sent any.
        return {
          ok: false,
          code: ErrorCodes.INVALID_INPUT,
          message: 'Invalid request: this endpoint takes no arguments.',
        };
      }

      /* 4. Dispatch ---------------------------------------------- */
      const handler = handlers[ch] as Handler<Channel> | undefined;
      if (!handler) {
        // Declared in the contract but not yet wired up. Explicit, not a crash.
        return {
          ok: false,
          code: ErrorCodes.INTERNAL,
          message: 'This feature is not available in this build.',
        };
      }

      const value = await handler(parsed, { sender: event.sender });
      return { ok: true, value };

    } catch (err) {
      /* 5. Never leak internals ---------------------------------- */
      if (err instanceof AppError) {
        return { ok: false, code: err.code, message: err.safeMessage };
      }
      logUnhandled(label, err);
      return {
        ok: false,
        code: ErrorCodes.INTERNAL,
        message: 'An internal error occurred.',
      };
    }
  });
}

/** Remove the listener. Used by tests and on app shutdown. */
export function unregisterRouter() {
  ipcMain.removeHandler('phutrue:invoke');
}

/**
 * Log a failed request without leaking anything sensitive.
 *
 * Error *messages* are not safe by default: an SMTP rejection can quote the
 * recipient, a SQLite error can quote the offending SQL, and a parser error can
 * quote a slice of the message body. So by default only the channel name and a
 * low-cardinality error class are recorded.
 *
 * Full detail (message + stack) is emitted only when PHUTRUE_DEBUG=1, which is
 * for local development and never set in a packaged build.
 */
function logUnhandled(channel: string, err: unknown): void {
  const kind =
    err instanceof Error
      ? (err.name || 'Error')
      : typeof err;
  if (process.env['PHUTRUE_DEBUG'] === '1') {
    console.error(`[ipc] ${channel} failed:`, err);
    return;
  }
  console.error(`[ipc] ${channel} failed (${kind})`);
}
