// @vitest-environment jsdom
/**
 * The shell must render real content in every state.
 *
 * This is the regression test for the blank-screen class of bug: it asserts that
 * the document body has meaningful text, that the bridge is used rather than
 * assumed, and that a failure is reported to the user instead of rendering
 * nothing. It also pins the branding (logo + "by Baraily Inovex").
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppInfo, Settings } from '../src/shared/models.js';

// The real CSS and the PNG import are build-time concerns; stub them.
vi.mock('../src/renderer/styles/app.css', () => ({}));
vi.mock('../src/renderer/components/boot.css', () => ({}));
vi.mock('../src/renderer/components/diagnostics.css', () => ({}));
vi.mock('../assets/generated/png/icon-128.png', () => ({
  default: 'data:image/png;base64,iVBORw0KGgo=',
}));

const { App } = await import('../src/renderer/app/App.js');

const INFO: AppInfo = {
  version: '0.1.0',
  electron: '45.2.1',
  chrome: '156.0.8078.75',
  node: '24.22.1',
  platform: 'win32',
  secureStorageAvailable: true,
  secureStorageReason: null,
  buildStamp: 'abc123def456',
  rendererPath: 'C:\\app\\dist\\renderer',
};

const SETTINGS: Settings = {
  theme: 'system',
  density: 'comfortable',
  notifications: true,
  blockRemoteContent: true,
  messagesPerPage: 50,
};

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root | undefined;

function setBridge(api: unknown) {
  Object.defineProperty(window, 'phutrue', { value: api, configurable: true, writable: true });
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.replaceChildren(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  Reflect.deleteProperty(window as unknown as Record<string, unknown>, 'phutrue');
  document.documentElement.removeAttribute('data-theme');
  vi.restoreAllMocks();
});

async function render() {
  await act(async () => {
    root!.render(<App />);
  });
  // Let the effect's promise chain settle.
  await act(async () => { await Promise.resolve(); });
  await act(async () => { await Promise.resolve(); });
}

function findButton(text: string): HTMLButtonElement | undefined {
  return [...container.querySelectorAll('button')].find((b) => (b.textContent ?? '').includes(text));
}

/**
 * Reach the boot screen.
 *
 * Since M3 the app opens on account setup, and the environment details plus the
 * diagnostics view live behind "About & diagnostics". The assertions below are
 * unchanged; only the route to the screen is.
 */
async function openAbout() {
  const button = findButton('About & diagnostics');
  if (!button) throw new Error('About control not found');
  await act(async () => {
    button.click();
  });
  await act(async () => { await Promise.resolve(); });
}

/** Render and navigate to the boot screen. */
async function renderAbout() {
  await render();
  await openAbout();
}

describe('successful boot', () => {
  beforeEach(() => {
    setBridge({
      platform: 'win32',
      invoke: async (channel: string) => {
        if (channel === 'app:info') return { ok: true, value: INFO };
        if (channel === 'settings:get') return { ok: true, value: SETTINGS };
        if (channel === 'accounts:list') return { ok: true, value: [] };
        return { ok: false, code: 'UNKNOWN_CHANNEL', message: 'no' };
      },
      on: () => () => {},
    });
  });

  it('renders the branding', async () => {
    await render();
    const text = document.body.textContent ?? '';
    expect(text).toContain('Phutrue');
    expect(text).toContain('by Baraily Inovex');
  });

  it('renders the logo with an inlined data URI', async () => {
    await renderAbout();
    const img = container.querySelector('img.boot__logo');
    expect(img).not.toBeNull();
    expect(img?.getAttribute('src')).toMatch(/^data:image\/png;base64,/);
    // Decorative, so screen readers skip it and the wordmark carries the name.
    expect(img?.getAttribute('alt')).toBe('');
  });

  it('shows values read from the main process, not hardcoded ones', async () => {
    await renderAbout();
    const text = document.body.textContent ?? '';
    expect(text).toContain('0.1.0');
    expect(text).toContain('45.2.1');
    expect(text).toContain('156.0.8078.75');
    expect(text).toContain('available');
  });

  it('is not blank', async () => {
    await render();
    expect((document.body.textContent ?? '').trim().length).toBeGreaterThan(20);
  });

  it('shows the build stamp, so a tester can tell a stale install from a fault', async () => {
    await renderAbout();
    const text = document.body.textContent ?? '';
    expect(text).toContain('abc123def456');
    expect(text).toContain('Build');
  });
});

describe('degraded states', () => {
  it('reports a missing bridge instead of rendering nothing', async () => {
    await render();
    expect(document.body.textContent).toContain('bridge is unavailable');
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
  });

  it('reports an IPC failure as an alert', async () => {
    setBridge({
      platform: 'win32',
      invoke: async () => ({ ok: false, code: 'INTERNAL', message: 'Database is locked.' }),
      on: () => () => {},
    });
    await render();
    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('Database is locked.');
  });

  it('reports a bridge read that throws, instead of hanging on the boot screen', async () => {
    /*
     * Regression test for the shape of the blank-window report.
     *
     * `callResult` returns a Result for handled failures, but the bridge call
     * itself can reject — a half-loaded preload, a failed IPC send. There was no
     * catch, so the rejection left the shell on the loading screen forever: a
     * window with the logo and the word "Starting…" and nothing else, which a
     * user cannot distinguish from a freeze.
     */
    setBridge({
      platform: 'win32',
      invoke: async () => {
        throw new Error('IPC send failed');
      },
      on: () => () => {},
    });
    await render();

    const alert = container.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert?.textContent).toContain('could not start');
    // And critically: not still stuck on the loading state.
    expect(document.body.textContent).not.toContain('Starting…');
  });

  it('warns when secure storage is unavailable', async () => {
    setBridge({
      platform: 'win32',
      invoke: async (channel: string) => {
        if (channel === 'app:info') {
          return {
            ok: true,
            value: {
              ...INFO,
              secureStorageAvailable: false,
              secureStorageReason: 'Windows DPAPI is not available.',
            },
          };
        }
        if (channel === 'accounts:list') return { ok: true, value: [] };
        return { ok: true, value: SETTINGS };
      },
      on: () => () => {},
    });
    await renderAbout();
    const text = document.body.textContent ?? '';
    expect(text).toContain('unavailable');
    expect(text).toContain('Windows DPAPI is not available.');
  });
});

describe('theme', () => {
  async function renderWithTheme(theme: Settings['theme']) {
    setBridge({
      platform: 'win32',
      invoke: async (channel: string) => {
        if (channel === 'app:info') return { ok: true, value: INFO };
        if (channel === 'accounts:list') return { ok: true, value: [] };
        return { ok: true, value: { ...SETTINGS, theme } };
      },
      on: () => () => {},
    });
    await render();
  }

  it('pins data-theme when the user chose a theme', async () => {
    await renderWithTheme('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('leaves the attribute unset when following the system', async () => {
    await renderWithTheme('system');
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * Diagnostics reachability
 *
 * Item 6 of the pre-commit review: the diagnostics screen must be reachable
 * from the boot screen by an actual click, not merely by existing as a
 * component that nothing renders.
 * ------------------------------------------------------------------ */

describe('diagnostics is reachable from the boot screen', () => {
  function installWorkingBridge() {
    setBridge({
      platform: 'win32',
      invoke: async (channel: string) => {
        if (channel === 'app:info') return { ok: true, value: INFO };
        if (channel === 'settings:get') return { ok: true, value: SETTINGS };
        if (channel === 'accounts:list') return { ok: true, value: [] };
        if (channel === 'app:diagnostics') {
          return {
            ok: true,
            value: {
              checks: [
                {
                  id: 'sqlite.query',
                  label: 'node:sqlite query',
                  status: 'pass',
                  detail: 'SELECT 1 returned 1',
                  durationMs: 0,
                },
              ],
              ok: true,
              generatedAt: 1,
              platform: 'win32',
            },
          };
        }
        if (channel === 'app:copyToClipboard') return { ok: true, value: undefined };
        return { ok: false, code: 'UNKNOWN_CHANNEL', message: 'no' };
      },
      on: () => () => {},
    });
  }

  it('renders a "Run diagnostics" button on the ready boot screen', async () => {
    installWorkingBridge();
    await renderAbout();
    expect(findButton('Run diagnostics')).toBeDefined();
  });

  it('opens the diagnostics view when clicked', async () => {
    installWorkingBridge();
    await renderAbout();

    const button = findButton('Run diagnostics');
    expect(button).toBeDefined();
    await act(async () => {
      button!.click();
    });

    // The diagnostics heading replaces the boot card.
    expect(container.querySelector('#diag-title')).not.toBeNull();
    expect(container.textContent).toContain('Development aid for Windows verification');
    // And the boot facts are gone, so the two screens never overlap.
    expect(container.querySelector('.boot__card')).toBeNull();
  });

  it('can be dismissed back to the boot screen', async () => {
    installWorkingBridge();
    await renderAbout();

    await act(async () => {
      findButton('Run diagnostics')!.click();
    });
    expect(container.querySelector('#diag-title')).not.toBeNull();

    const close = container.querySelector<HTMLButtonElement>('button.diag__close');
    expect(close).not.toBeNull();
    await act(async () => {
      close!.click();
    });

    expect(container.querySelector('#diag-title')).toBeNull();
    expect(container.querySelector('.boot__card')).not.toBeNull();
    expect(document.body.textContent).toContain('by Baraily Inovex');
  });

  it('runs the checks through the real IPC bridge when opened', async () => {
    const invoked: string[] = [];
    setBridge({
      platform: 'win32',
      invoke: async (channel: string) => {
        invoked.push(channel);
        if (channel === 'app:info') return { ok: true, value: INFO };
        if (channel === 'settings:get') return { ok: true, value: SETTINGS };
        if (channel === 'accounts:list') return { ok: true, value: [] };
        if (channel === 'app:diagnostics') {
          return {
            ok: true,
            value: { checks: [], ok: true, generatedAt: 1, platform: 'win32' },
          };
        }
        return { ok: true, value: undefined };
      },
      on: () => () => {},
    });
    await renderAbout();

    await act(async () => {
      findButton('Run diagnostics')!.click();
    });
    await act(async () => {
      findButton('Run diagnostics')!.click();
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(invoked).toContain('app:diagnostics');
  });
});

