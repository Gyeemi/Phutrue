/**
 * Window creation and hardening.
 *
 * Every rule in the security requirements is enforced here rather than
 * scattered through feature code, so there is one place to audit.
 */

import { app, BrowserWindow, shell } from 'electron';
import path from 'node:path';

import { APP_ORIGIN } from './protocol.js';

/** Windows taskbar grouping and toast attribution are keyed on this. */
export const APP_USER_MODEL_ID = 'BarailyInovex.Phutrue';

const PRELOAD = path.join(__dirname, '..', 'preload', 'index.js');

/**
 * Locate a file shipped in `extraResources`.
 *
 * Packaged, the app code lives inside `app.asar` while `assets/` is copied
 * beside it under `process.resourcesPath`. In development there is no such
 * directory, so we fall back to the repo layout.
 */
function resourcePath(...segments: string[]): string {
  const packaged = process.resourcesPath;
  if (app.isPackaged && packaged) {
    return path.join(packaged, ...segments);
  }
  return path.join(__dirname, '..', '..', ...segments);
}

/**
 * Origins the app may navigate to inside its own window.
 *
 * Only the app origin. Anything else opens in the user's default browser, which
 * is what an email client should do with a link in a message.
 */
const ALLOWED_ORIGIN = APP_ORIGIN;

/** Schemes we are willing to hand to the OS shell. */
const EXTERNAL_SCHEMES = new Set(['https:', 'http:', 'mailto:']);

function isAllowedNavigation(url: string): boolean {
  try {
    return new URL(url).origin === ALLOWED_ORIGIN;
  } catch {
    return false;
  }
}

/**
 * Open a URL in the system browser, refusing anything that is not http(s) or
 * mailto. This is the only path by which the app talks to the OS about URLs.
 */
export function openExternalSafely(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (!EXTERNAL_SCHEMES.has(parsed.protocol)) return false;
    void shell.openExternal(parsed.toString());
    return true;
  } catch {
    return false;
  }
}

export interface CreateWindowOptions {
  /** Set of window ids considered trusted IPC senders. */
  trusted: Set<number>;
}

/**
 * Create the main application window.
 *
 * Security posture:
 *   contextIsolation  : true   — page JS cannot touch preload internals
 *   sandbox           : true   — renderer has no Node
 *   nodeIntegration   : false  — no `require` in page
 *   webSecurity       : true   — same-origin policy applies (never disabled)
 */
export function createMainWindow(opts: CreateWindowOptions): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: '#f7f9fc',
    icon: resourcePath('assets', 'generated', 'png', 'icon-256.png'),
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      // The renderer never needs a webview.
      webviewTag: false,
      spellcheck: true,
    },
  });

  // Register before any load so the sender is trusted from the first frame.
  // The id is captured now because `win.webContents` throws once the window has
  // been destroyed, and `closed` fires after that.
  const webContentsId = win.webContents.id;
  opts.trusted.add(webContentsId);

  win.once('ready-to-show', () => win.show());
  win.on('closed', () => {
    opts.trusted.delete(webContentsId);
  });

  /* ---- navigation lockdown ------------------------------------- */

  // Block any in-window navigation away from the app origin.
  win.webContents.on('will-navigate', (event, url) => {
    if (!isAllowedNavigation(url)) {
      event.preventDefault();
      openExternalSafely(url);
    }
  });

  // Allow only same-origin in-page redirects.
  win.webContents.on('will-redirect', (event, url) => {
    if (!isAllowedNavigation(url)) {
      event.preventDefault();
    }
  });

  // No popups. Approved links go to the OS browser instead.
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternalSafely(url);
    return { action: 'deny' };
  });

  // Refuse permission requests outright; an email client needs none of them.
  win.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => {
    callback(false);
  });

  // Deny device access as well.
  win.webContents.session.setPermissionCheckHandler(() => false);

  win.loadURL(`${APP_ORIGIN}/index.html`);
  return win;
}

/**
 * Apply a Content-Security-Policy to every response served from the app origin.
 *
 * Served as a header rather than only a <meta> tag so it also covers responses
 * that never reach the document (fonts, images) and cannot be stripped by
 * injected markup.
 */
export function installCsp(ses: Electron.Session): void {
  ses.webRequest.onHeadersReceived((details, callback) => {
    const csp = [
      "default-src 'none'",
      // The bundle is a single script file; no eval, no inline script.
      "script-src 'self'",
      // Styles are a real CSS file; inline style attributes are used sparingly
      // for measurements and are permitted explicitly.
      "style-src 'self' 'unsafe-inline'",
      // Icons are inlined as data: URIs (same trick that fixed the branding
      // screen), plus same-origin files.
      "img-src 'self' data:",
      "font-src 'self'",
      // IPC goes over Electron's own channel, not the network. No fetch needed
      // from the renderer — all network work happens in main.
      "connect-src 'none'",
      "media-src 'none'",
      "object-src 'none'",
      "frame-src 'none'",
      "worker-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
      // `require-trusted-types-for 'script'` is deliberately NOT enabled.
      //
      // Trusted Types enforcement makes every string assignment to innerHTML
      // throw, and React DOM performs such an assignment during its own
      // module-level feature detection. Enabling it would crash the renderer
      // before the first paint.
      //
      // It would also buy almost nothing here: the app's own code contains no
      // HTML sinks at all (verified by grep), and no inline or remote script is
      // permitted by the directives above. Revisit with a real Chromium run
      // once message bodies are rendered, at which point a sanitizer — not
      // Trusted Types — is the load-bearing control.
    ]
      .filter(Boolean)
      .join('; ');

    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp],
        'X-Content-Type-Options': ['nosniff'],
        'Referrer-Policy': ['no-referrer'],
      },
    });
  });
}
