/**
 * Phutrue — Electron main process.
 *
 * Scope note: this file exists to prove the branding integration is wired
 * correctly (window icon, taskbar identity, tray icon, notification icon).
 * Mail, account, database and UI functionality are deliberately NOT
 * implemented yet — that is a later phase.
 */

'use strict';

const { app, BrowserWindow, Tray, Menu, nativeImage, Notification } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

/**
 * Windows taskbar grouping and toast attribution are keyed on this string.
 * It must be stable across releases, and match the identity the installer
 * registers, or notifications will show the wrong app name and the taskbar
 * will create duplicate buttons.
 */
const APP_USER_MODEL_ID = 'BarailyInovex.Phutrue';

/**
 * Resolve a generated asset.
 *
 * Packaged: assets ship via electron-builder's extraResources, so they sit at
 *           <resources>/assets/generated/...
 * Dev:      they are read straight out of the working tree at the app root.
 */
function asset(...parts) {
  const base = app.isPackaged
    ? process.resourcesPath
    : app.getAppPath();
  return path.join(base, 'assets', 'generated', ...parts);
}

const ICONS = {
  /** Multi-resolution .ico — installer, shortcuts, Add/Remove Programs. */
  app: () => asset('icon.ico'),
  /** 256px PNG — best compromise for the window frame and Alt-Tab. */
  window: () => asset('png', 'icon-256.png'),
  /**
   * Tray icons must be small and must carry real alpha, or Windows paints a
   * black box behind the artwork. 32px covers 200% scaling, where the shell
   * asks for a 32px bitmap for a 16px slot.
   */
  tray: () => asset('png', 'icon-32.png'),
  /** Toast images are rendered at up to 64px on modern Windows. */
  notification: () => asset('png', 'icon-256.png'),
  /**
   * The branding screen is a `data:` document, and a `data:` document is not
   * permitted to load `file://` subresources - Chromium blocks them with
   * "Not allowed to load local resource" and the <img> falls back to the
   * broken-image placeholder. Inlining the PNG as a `data:` URI keeps the
   * request same-scheme, so no security setting needs relaxing.
   *
   * 128px is used rather than 256px because the image is displayed in a
   * 128x128 slot: it is pixel-exact at that size and the base64 payload is
   * roughly a third of the 256px one.
   */
  brandingScreen: () => asset('png', 'icon-128.png'),
};

/**
 * Read the branding-screen icon and return it as a `data:image/png;base64,`
 * URI. Returns null if the file cannot be read, so a missing icon degrades to
 * the text-only screen instead of taking the window down.
 */
function brandingIconDataUri() {
  try {
    return 'data:image/png;base64,' +
      fs.readFileSync(ICONS.brandingScreen()).toString('base64');
  } catch (err) {
    console.error('[phutrue] branding icon unavailable:', err.message);
    return null;
  }
}

let mainWindow = null;
let tray = null;

/** Set while quitting so the window's close handler stops hiding to tray. */
let isQuitting = false;

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 880,
    minHeight: 600,
    show: false,
    backgroundColor: '#ffffff',
    // The .ico carries every size, so Windows picks a sharp one for the
    // window frame and the Alt-Tab switcher at any DPI.
    icon: ICONS.window(),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Branding placeholder only. The real UI arrives in a later phase.
  // Same-origin `data:` icon: a `file://` src here would be blocked by
  // Chromium's local-resource policy (see brandingIconDataUri above).
  const brandingIcon = brandingIconDataUri();
  mainWindow.loadURL(
    'data:text/html;charset=utf-8,' +
      encodeURIComponent(
        '<!doctype html><meta charset="utf-8">' +
          '<title>Phutrue</title>' +
          '<body style="font-family:Segoe UI,system-ui,sans-serif;display:grid;' +
          'place-items:center;height:100vh;margin:0;color:#0b1f3a">' +
          '<div style="text-align:center">' +
          (brandingIcon
            ? '<img src="' + brandingIcon + '" width="128" height="128" alt="">'
            : '') +
          '<h1 style="font-weight:600;margin:.4em 0 .1em">Phutrue</h1>' +
          '<p style="margin:0;color:#5a6b82">by Baraily Inovex</p>' +
          '</div></body>'
      )
  );

  mainWindow.once('ready-to-show', () => mainWindow.show());

  // Closing the window hides to the tray rather than quitting, which is what
  // makes the "minimised" notification state reachable at all.
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

function createTray() {
  // Tray icons must be small and must have real alpha, or Windows draws a
  // black box around the artwork on the taskbar.
  tray = new Tray(nativeImage.createFromPath(ICONS.tray()));
  tray.setToolTip('Phutrue — Baraily Inovex');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open Phutrue', click: () => mainWindow?.show() },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          isQuitting = true;
          app.quit();
        },
      },
    ])
  );
  tray.on('click', () => mainWindow?.show());
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    // Must be set before any window or notification is created.
    app.setAppUserModelId(APP_USER_MODEL_ID);

    createMainWindow();
    createTray();

    // Proves the notification icon path resolves. The real update-notification
    // pipeline is a later phase.
    if (process.env.PHUTRUE_DEMO_NOTIFICATION === '1') {
      new Notification({
        title: 'Phutrue',
        body: 'Branding assets loaded successfully.',
        icon: ICONS.notification(),
      }).show();
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
    });
  });

  app.on('before-quit', () => { isQuitting = true; });

  app.on('window-all-closed', () => {
    // Stay resident in the tray on Windows; quit everywhere else.
    if (process.platform !== 'win32') app.quit();
  });
}
