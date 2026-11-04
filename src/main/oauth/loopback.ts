/**
 * Loopback redirect listener.
 *
 * The system browser is sent to the provider; the provider redirects back to
 * `http://127.0.0.1:<ephemeral>/callback`, and this listener catches that one
 * request. An embedded window is not used, because it is prohibited by the
 * requirement and by both providers' policies.
 *
 * ## Design decisions
 *
 * **Ephemeral port (`port 0`).** A fixed port collides with whatever else the
 * user runs and would make the redirect URI non-deterministic across installs.
 * The kernel assigns one; it is read back and used to build the URI.
 *
 * **Bind to 127.0.0.1, not 0.0.0.0.** Binding to all interfaces would expose the
 * callback to the local network. The redirect is only ever followed by the
 * browser on the same machine.
 *
 * **One request, then close.** The listener accepts exactly one valid callback
 * and shuts down. A second request is refused, which is what makes replay of a
 * captured URL uninteresting even before `state` is considered.
 *
 * **Hard timeout.** If the user closes the browser tab, abandons the consent
 * screen, or the request never arrives, the listener must not hold the port and
 * a pending promise forever.
 *
 * **Everything is bounded.** Request bodies are not read at all (the callback is
 * a GET with query parameters), and the URL length is capped.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { parseCallback, type CallbackResult } from './callback.js';

/** Longest request URL accepted. Provider callbacks are far shorter. */
const MAX_URL_LENGTH = 8192;

export interface LoopbackResult {
  /** The parsed callback, or null when the flow timed out or was aborted. */
  callback: CallbackResult | null;
  /** Why the listener stopped without a callback. */
  stopReason: 'callback' | 'timeout' | 'cancelled' | 'port-error';
}

export interface LoopbackHandle {
  redirectUri: string;
  /** Resolves once a callback arrives, the timeout elapses, or cancel() is called. */
  result: Promise<LoopbackResult>;
  cancel: () => void;
}

/**
 * A single-use HTTP listener on 127.0.0.1.
 *
 * The HTML it returns is deliberately minimal and static: it contains no
 * interpolation of anything from the request, so there is no reflected-content
 * XSS even though the request is untrusted. The page tells the user to return to
 * Phutrue, because the browser tab is a dead end.
 */
export async function startLoopbackListener(opts: {
  timeoutMs: number;
  /** Injected for tests so a fixed port can be used. */
  port?: number;
}): Promise<LoopbackHandle> {
  let server: Server | undefined;
  let settled = false;
  let resolveResult: (r: LoopbackResult) => void = () => {};
  let timer: NodeJS.Timeout | undefined;

  const result = new Promise<LoopbackResult>((resolve) => {
    resolveResult = resolve;
  });

  function finish(outcome: LoopbackResult): void {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    // close() is asynchronous; awaiting it would delay resolution for no gain,
    // and the port is released promptly either way.
    server?.close();
    resolveResult(outcome);
  }

  const PAGE_OK = `<!doctype html><meta charset="utf-8"><title>Phutrue</title>
<body style="font-family:Segoe UI,system-ui,sans-serif;background:#f4f7fb;color:#16233a;display:grid;place-items:center;height:100vh;margin:0">
<div style="text-align:center;max-width:34rem;padding:2rem">
<h1 style="font-size:1.35rem;margin:0 0 .5rem">Returning to Phutrue</h1>
<p style="color:#5a6b82;margin:0">You can close this tab. Phutrue will finish setting up your account.</p>
</div></body>`;

  const PAGE_FAIL = `<!doctype html><meta charset="utf-8"><title>Phutrue</title>
<body style="font-family:Segoe UI,system-ui,sans-serif;background:#f4f7fb;color:#16233a;display:grid;place-items:center;height:100vh;margin:0">
<div style="text-align:center;max-width:34rem;padding:2rem">
<h1 style="font-size:1.35rem;margin:0 0 .5rem">Sign-in could not be completed</h1>
<p style="color:#5a6b82;margin:0">Return to Phutrue and start again.</p>
</div></body>`;

  try {
    server = createServer((req, res) => {
      const url = req.url ?? '';

      // `server.close()` is asynchronous, so a connection already queued can
      // still reach this handler after the flow has settled. Refuse it
      // explicitly rather than serving a second "you're signed in" page for a
      // callback we have already discarded — that page would be a lie.
      if (settled) {
        res.writeHead(410, { 'Content-Type': 'text/plain; charset=utf-8' }).end('This sign-in has already finished.');
        return;
      }

      // Reject oversized URLs before parsing anything.
      if (url.length > MAX_URL_LENGTH) {
        res.writeHead(414, { 'Content-Type': 'text/plain; charset=utf-8' }).end('URI too long');
        return;
      }

      // Only GET is expected; anything else is not a provider redirect.
      if (req.method !== 'GET') {
        res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Method not allowed');
        return;
      }

      const parsed = parseCallback(url);

      // A request to the wrong path is ignored without closing the listener: a
      // browser may probe /favicon.ico, and that must not end the flow.
      if (parsed.kind === 'invalid' && parsed.reason === 'unexpected-path') {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
        return;
      }

      const ok = parsed.kind === 'code';
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        // Nothing here should be cached or framed.
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        'Referrer-Policy': 'no-referrer',
      }).end(ok ? PAGE_OK : PAGE_FAIL);

      finish({ callback: parsed, stopReason: 'callback' });
    });
  } catch {
    return { redirectUri: '', result: Promise.resolve({ callback: null, stopReason: 'port-error' }), cancel: () => {} };
  }

  const listening = new Promise<{ ok: true; port: number } | { ok: false }>((resolve) => {
    server!.once('error', () => resolve({ ok: false }));
    server!.listen(opts.port ?? 0, '127.0.0.1', () => {
      const address = server!.address() as AddressInfo | null;
      if (!address || typeof address === 'string') {
        resolve({ ok: false });
        return;
      }
      resolve({ ok: true, port: address.port });
    });
  });

  const bound = await listening;
  if (!bound.ok) {
    server.close();
    return {
      redirectUri: '',
      result: Promise.resolve({ callback: null, stopReason: 'port-error' }),
      cancel: () => {},
    };
  }

  timer = setTimeout(() => finish({ callback: null, stopReason: 'timeout' }), opts.timeoutMs);
  // Do not keep the process alive purely for this timer.
  timer.unref?.();

  return {
    redirectUri: `http://127.0.0.1:${bound.port}/callback`,
    result,
    cancel: () => finish({ callback: null, stopReason: 'cancelled' }),
  };
}
