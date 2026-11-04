/**
 * Custom `app://` protocol for the renderer.
 *
 * Why not `file://` or a `data:` URL:
 *   - A `data:` document cannot load `file://` subresources (this already caused
 *     a real bug in the branding screen), and has an opaque origin, which makes
 *     a meaningful CSP impossible.
 *   - `file://` has a unique opaque origin per path in Chromium, breaks module
 *     and fetch semantics, and is widely blocked.
 *
 * `app://` gives the renderer a normal, stable, secure origin so the CSP is
 * enforceable and same-origin rules behave predictably.
 */

import { protocol } from 'electron';
import { readFileSync } from 'node:fs';
import path from 'node:path';

export const APP_SCHEME = 'app';
export const APP_HOST = 'phutrue';
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;

/**
 * Must be called before `app.whenReady()`.
 *
 * Marking the scheme standard + secure is what allows it to be treated as a
 * normal origin for CSP, and what lets the renderer use paths relative to it.
 */
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: false,
        stream: false,
      },
    },
  ]);
}

/**
 * Serve files from the built renderer directory.
 *
 * Path traversal is rejected explicitly: a request for `app://phutrue/../main/index.js`
 * must not escape the renderer root, which would hand the page the main bundle.
 *
 * @param root Absolute path to dist/renderer
 */
export type RendererPathResult =
  | { ok: true; file: string }
  | { ok: false; status: 403 | 404 };

/**
 * Map a request path onto a file inside the renderer root.
 *
 * Pure and exported so the traversal rules can be tested directly rather than
 * through a running Electron protocol handler.
 *
 * Rejects, in order: a malformed percent-encoding, a NUL byte, and any path
 * that normalises outside the root.
 */
export function resolveRendererPath(root: string, rawPathname: string): RendererPathResult {
  let requested: string;
  try {
    requested = decodeURIComponent(rawPathname);
  } catch {
    // Malformed escape sequence (e.g. "%E0%A4%A"). Not a file we could serve.
    return { ok: false, status: 404 };
  }

  // A NUL byte would truncate the path in the filesystem layer.
  if (requested.includes('\0')) return { ok: false, status: 404 };

  // Windows-specific hazards, checked before any normalisation.
  //
  // The Win32 layer silently strips trailing dots and spaces from a path
  // component, so `renderer/.. /main/index.js` passes a naive prefix check but
  // opens the parent directory once Windows interprets `.. ` as `..`. Likewise
  // `...` collapses towards `..`, and a colon introduces an alternate data
  // stream. None of these can name a legitimate asset, so all are refused.
  for (const segment of requested.split(/[\\/]+/)) {
    if (segment === '') continue;
    if (/^[. ]+$/.test(segment)) return { ok: false, status: 403 }; // ".", "..", "...", ".. "
    if (/[. ]$/.test(segment)) return { ok: false, status: 403 };   // trailing dot or space
    if (segment.includes(':')) return { ok: false, status: 403 };   // ADS / drive letter
  }

  const relative = requested === '/' || requested === '' ? 'index.html' : requested;
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;

  // `path.join` normalises, so ".." segments are already collapsed here; the
  // prefix test is what actually decides containment.
  const resolved = path.join(root, relative);

  if (resolved === root || !resolved.startsWith(rootWithSep)) {
    return { ok: false, status: 403 };
  }
  return { ok: true, file: resolved };
}

/**
 * Content-Type for every file the renderer can request.
 *
 * This is **not** cosmetic. `installCsp` stamps `X-Content-Type-Options: nosniff`
 * on every response, and nosniff makes Chromium refuse a subresource whose type
 * does not match what it is used as:
 *
 *   - a `<script src>` whose Content-Type is not a JavaScript type is blocked
 *     outright, so `app.js` never executes and `#root` stays empty;
 *   - a `<link rel=stylesheet>` whose Content-Type is not `text/css` is blocked
 *     too, so an unstyled document renders.
 *
 * Relying on `net.fetch(file://...)`'s sniffing put both of those behind an
 * implementation detail. Setting the type explicitly makes the outcome
 * deterministic, which matters most where it cannot be observed here — a
 * packaged build on Windows.
 *
 * The map is an allowlist: a file type not listed is refused rather than served
 * with a guessed type, so an unexpected asset cannot become a script.
 */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

/** Content-Type for a resolved path, or null when the extension is not allowed. */
export function contentTypeFor(file: string): string | null {
  return CONTENT_TYPES[path.extname(file).toLowerCase()] ?? null;
}

export function serveRenderer(root: string): void {
  protocol.handle(APP_SCHEME, (request) => {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return new Response('Not found', { status: 404 });
    }

    if (url.host !== APP_HOST) {
      return new Response('Not found', { status: 404 });
    }

    const resolved = resolveRendererPath(root, url.pathname);
    if (!resolved.ok) {
      return new Response(resolved.status === 403 ? 'Forbidden' : 'Not found', {
        status: resolved.status,
      });
    }

    const contentType = contentTypeFor(resolved.file);
    if (!contentType) {
      // Not a type we are willing to serve. Refusing is safer than guessing:
      // with nosniff in force, a wrong guess either breaks the page or, worse,
      // lets a file be interpreted as something executable.
      return new Response('Unsupported media type', { status: 415 });
    }

    // Always return a fresh Response with an explicit Content-Type. The file is
    // read here rather than proxied through net.fetch so the type can never be
    // left to inference.
    let bytes: Buffer;
    try {
      bytes = readFileSync(resolved.file);
    } catch {
      return new Response('Not found', { status: 404 });
    }

    // Copy into a plain Uint8Array: a Node Buffer is not a valid BodyInit under
    // the DOM typings, and this also detaches the response from the Buffer pool.
    const body = new Uint8Array(bytes);

    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Content-Length': String(bytes.byteLength),
        // The renderer is served from a stable origin and never cached across
        // builds; a stale script after an update is a blank-screen risk.
        'Cache-Control': 'no-store',
      },
    });
  });
}
