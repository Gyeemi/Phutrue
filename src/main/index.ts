/**
 * Phutrue — main process entry point.
 *
 * Startup order matters and is deliberate:
 *   1. Register the privileged app:// scheme  (must precede app ready)
 *   2. Enforce a single instance
 *   3. On ready: open the database, run migrations, build services
 *   4. Serve the renderer, install the CSP, register the IPC router
 *   5. Create the window
 *
 * Any failure before the window opens is fatal and reported to the user rather
 * than leaving a blank screen.
 */

import { app, BrowserWindow, clipboard, dialog, Menu, session, shell } from 'electron';
import path from 'node:path';
import { statSync } from 'node:fs';

import type { AppInfo } from '../shared/models.js';
import { AppError } from '../shared/result.js';
import { openDatabase, type Db } from './db/database.js';
import { electronDeps } from './diagnostics/electron.js';
import { runDiagnostics } from './diagnostics/index.js';
import { createAccountRepo } from './db/repos/accounts.js';
import { createDraftRepo } from './db/repos/drafts.js';
import { createFolderRepo } from './db/repos/folders.js';
import { createMessageRepo } from './db/repos/messages.js';
import { createSettingsRepo } from './db/repos/settings.js';
import { createAccountService } from './oauth/account-service.js';
import { registerRouter, unregisterRouter } from './ipc/router.js';
import { registerAppScheme, serveRenderer } from './protocol.js';
import { createSecretStore, type SecretStore } from './secrets/store.js';
import { APP_USER_MODEL_ID, createMainWindow, installCsp } from './windows.js';

/* ------------------------------------------------------------------ *
 * Paths
 * ------------------------------------------------------------------ */

/**
 * The build output lives at `dist/` inside the app root in both cases: the repo
 * when unpackaged, the asar archive alone when packaged. `app.getAppPath()`
 * resolves to whichever applies, so no branch is needed.
 */
const RENDERER_DIR = path.join(app.getAppPath(), 'dist', 'renderer');

/** User data lives in %APPDATA%\Phutrue and is never inside the install dir. */
function databasePath(): string {
  return path.join(app.getPath('userData'), 'phutrue.db');
}

/* ------------------------------------------------------------------ *
 * Services
 * ------------------------------------------------------------------ */

interface Services {
  db: Db;
  /** Absolute path to the SQLite file, needed by the diagnostics screen. */
  databasePath: string;
  accounts: ReturnType<typeof createAccountRepo>;
  folders: ReturnType<typeof createFolderRepo>;
  messages: ReturnType<typeof createMessageRepo>;
  drafts: ReturnType<typeof createDraftRepo>;
  settings: ReturnType<typeof createSettingsRepo>;
  secrets: SecretStore;
  oauth: ReturnType<typeof createAccountService>;
}

let services: Services | null = null;

function buildServices(): Services {
  const file = databasePath();
  const db = openDatabase(file);
  const secrets = createSecretStore(db);
  return {
    db,
    databasePath: file,
    accounts: createAccountRepo(db),
    folders: createFolderRepo(db),
    messages: createMessageRepo(db),
    drafts: createDraftRepo(db),
    settings: createSettingsRepo(db),
    secrets,
    // One instance for the whole session: it owns the in-flight sign-in map, so
    // a second instance would hold half the pending attempts.
    oauth: createAccountService({
      db,
      secrets,
      // The system default browser, never an embedded window.
      openExternal: (url) => {
        void shell.openExternal(url);
      },
    }),
  };
}

/**
 * Print the renderer files this process is about to serve.
 *
 * Sizes only. A build of the account-setup UI produces an `app.js` around 250 KB;
 * a branding-era build is far smaller. If a user reports a logo-only window,
 * this line and `dist/build-stamp.json` together answer "is the installed
 * renderer the one that was just built?" without needing to reproduce anything.
 */
function logRendererFacts(rendererDir: string): void {
  const files = ['index.html', 'app.js', 'app.css'];
  const parts: string[] = [];

  for (const name of files) {
    try {
      const bytes = statSync(path.join(rendererDir, name)).size;
      parts.push(`${name} ${bytes} B`);
    } catch {
      parts.push(`${name} MISSING`);
    }
  }

  const stamp = typeof __BUILD_STAMP__ === 'string' ? __BUILD_STAMP__ : 'dev';
  console.log(`[startup] renderer at ${rendererDir}`);
  console.log(`[startup] serving ${parts.join(', ')} (build ${stamp})`);
}

function appInfo(s: Services): AppInfo {
  return {
    version: app.getVersion(),
    buildStamp: typeof __BUILD_STAMP__ === 'string' ? __BUILD_STAMP__ : 'dev',
    rendererPath: RENDERER_DIR,
    electron: process.versions['electron'] ?? 'unknown',
    chrome: process.versions['chrome'] ?? 'unknown',
    node: process.versions['node'] ?? 'unknown',
    platform: process.platform,
    secureStorageAvailable: s.secrets.available(),
    secureStorageReason: s.secrets.reason(),
  };
}

/* ------------------------------------------------------------------ *
 * Bootstrap
 * ------------------------------------------------------------------ */

// Step 1 — must run before `app.whenReady()`.
registerAppScheme();

// Step 2 — a second launch focuses the existing window instead of opening a
// second copy that would contend for the SQLite file.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  const trustedWindowIds = new Set<number>();
  let mainWindow: BrowserWindow | null = null;

  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    app.setAppUserModelId(APP_USER_MODEL_ID);

    try {
      services = buildServices();
    } catch (err) {
      const detail =
        err instanceof AppError ? err.safeMessage : err instanceof Error ? err.message : String(err);
      dialog.showErrorBox(
        'Phutrue could not start',
        `The local database could not be opened.\n\n${detail}\n\nLocation: ${databasePath()}`
      );
      app.quit();
      return;
    }

    const svc = services;

    /*
     * Remove Electron's default application menu.
     *
     * Left in place it draws a File/Edit/View/Window menu bar across the top of
     * every window. None of its items do anything useful here — the default
     * "Reload" and "Toggle Developer Tools" are the only ones with an effect,
     * and both are reachable with a keyboard shortcut — but it makes the app
     * look like an unfinished shell and steals vertical space from the account
     * screen.
     *
     * Removed rather than hidden: `autoHideMenuBar` still reveals it on Alt, and
     * a menu that is invisible until a keypress is a worse surprise than no
     * menu at all.
     */
    Menu.setApplicationMenu(null);

    /*
     * State which renderer is about to be served, in bytes.
     *
     * This is the single most useful line in a support report, and it exists
     * because a stale renderer caused a long false trail. The window showed a
     * logo and nothing else; the source could be shown not to produce that
     * frame, but nothing at runtime said which files were actually on disk. A
     * stale `app.js` is indistinguishable from a broken one by looking at it —
     * but the byte counts differ obviously between builds.
     *
     * `logRendererFacts` prints sizes, never contents, and never a path outside
     * the install directory.
     */
    logRendererFacts(RENDERER_DIR);

    // Serve the renderer and lock down the session.
    serveRenderer(RENDERER_DIR);
    installCsp(session.defaultSession);

    // Step 4 — one router for every channel.
    registerRouter(
      {
        'app:info': async () => appInfo(svc),

        // The Windows self-test. Read-only apart from a throwaway write probe
        // and an encrypt/decrypt round-trip; it never returns a secret.
        'app:diagnostics': async () =>
          runDiagnostics(
            electronDeps(
              svc.db,
              svc.databasePath,
              RENDERER_DIR,
              typeof __BUILD_STAMP__ === 'string' ? __BUILD_STAMP__ : 'dev'
            )
          ),

        // See the contract for why the renderer cannot use navigator.clipboard.
        'app:copyToClipboard': async (payload) => {
          // The router has already validated and narrowed this to `{ text }`.
          const { text } = payload as { text: string };
          clipboard.writeText(text);
        },

        'settings:get': async () => svc.settings.get(),
        'settings:update': async (payload) =>
          svc.settings.update(payload as Parameters<typeof svc.settings.update>[0]),

        'accounts:list': async () => svc.accounts.list(),

        /**
         * Remove an account and everything derived from it.
         *
         * The credential is deleted before the row: the row cascades to
         * folders, messages and drafts, so deleting it first and then failing
         * to reach the secret store would leave an unreachable encrypted secret
         * with no account to attribute it to.
         *
         * `repo.remove` throws NOT_FOUND for an unknown id, which the router
         * converts to a typed error rather than reporting a silent success.
         */
        'accounts:remove': async (payload) => {
          const { id } = payload as { id: number };
          svc.oauth.removeAccount(id);
        },

        /* --- OAuth 2.0 --------------------------------------------- *
         * The renderer never sees a token, code or verifier on any of
         * these channels. `begin` returns the authorisation URL only so
         * the UI can name the provider it is waiting on; `open` is what
         * actually launches the system browser, and it happens in main.
         * ----------------------------------------------------------- */
        'oauth:begin': async (payload) => svc.oauth.beginSignIn(payload as { provider: 'google' | 'microsoft'; label?: string }),
        'oauth:open': async (payload) => {
          const { attemptId } = payload as { attemptId: string };
          // Resolved from the live attempt, not from a renderer-supplied URL: a
          // renderer-supplied URL would make this an "open anything" primitive.
          svc.oauth.openInBrowser(attemptId);
        },
        'oauth:complete': async (payload) => {
          const { attemptId, label } = payload as { attemptId: string; label?: string };
          return svc.oauth.completeSignIn(attemptId, label);
        },
        'oauth:cancel': async (payload) => {
          const { attemptId } = payload as { attemptId: string };
          svc.oauth.cancel(attemptId);
        },
        'oauth:state': async (payload) => {
          const { accountId } = payload as { accountId: number };
          return svc.oauth.stateFor(accountId);
        },

        // Remaining handlers arrive with milestones 3–6. A channel declared in
        // the contract but left unwired returns an explicit "not available"
        // from the router rather than silently pretending to work.
      },
      // A sender is trusted only if it is one of our own windows.
      (wc) => trustedWindowIds.has(wc.id)
    );

    // Step 5 — window.
    mainWindow = createMainWindow({ trusted: trustedWindowIds });
    mainWindow.on('closed', () => { mainWindow = null; });

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        mainWindow = createMainWindow({ trusted: trustedWindowIds });
        mainWindow.on('closed', () => { mainWindow = null; });
      }
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => {
    unregisterRouter();
    if (services) {
      try { services.db.close(); } catch { /* already closed */ }
      services = null;
    }
  });
}

/* ------------------------------------------------------------------ *
 * Defence in depth
 * ------------------------------------------------------------------ */

app.on('web-contents-created', (_event, contents) => {
  // The app never embeds a <webview>. Refuse any attempt to attach one, which
  // is a classic escape hatch around a hardened BrowserWindow.
  contents.on('will-attach-webview', (event) => event.preventDefault());

  // Belt and braces: `setWindowOpenHandler` is also installed per window in
  // windows.ts, but every web contents in the process is covered here.
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
});
