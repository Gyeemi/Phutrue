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

import { protocol, net } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

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

    return net.fetch(pathToFileURL(resolved.file).toString());
  });
}
