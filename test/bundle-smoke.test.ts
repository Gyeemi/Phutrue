// @vitest-environment jsdom
/**
 * Built-artifact smoke test.
 *
 * Every other renderer test imports the *source*, which webpack-free bundling
 * rewrites. That left a real gap: a fault in how esbuild emits the bundle, or in
 * how the app:// handler types its responses, would pass the whole suite and
 * only appear on a real machine.
 *
 * This test runs the actual `dist/renderer/app.js` that ships, inside a real
 * DOM, against a stubbed IPC bridge, and asserts the complete boot screen is
 * produced — not merely that a logo element exists.
 *
 * It requires `npm run build` to have run first. When dist/ is absent the test
 * skips loudly rather than passing silently, because a silent skip is exactly
 * how this class of bug survived before.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist', 'renderer');

interface Harness {
  cleanup: () => void;
}

let harness: Harness | undefined;

function bridge(info: unknown, settings: unknown) {
  return {
    platform: 'win32',
    invoke: async (channel: string) => {
      if (channel === 'app:info') return { ok: true, value: info };
      if (channel === 'settings:get') return { ok: true, value: settings };
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
  };
}

/**
 * Execute the shipped bundle in the current jsdom document.
 *
 * Evaluated with `new Function` rather than injected as a <script> element.
 * jsdom runs script *elements* in a separate realm, so `window.phutrue` set by
 * the test was invisible to the bundle and every run took the
 * "bridge is unavailable" branch — a harness artifact that would have made this
 * test assert the wrong thing. `new Function` shares this test's realm, so the
 * stubbed bridge is visible exactly as the real preload's would be.
 *
 * The bundle is an IIFE that mounts into #root.
 */
function runBundle(info: unknown, settings: unknown): { errors: string[] } {
  const errors: string[] = [];
  const onError = (e: ErrorEvent) => errors.push(e.message);
  window.addEventListener('error', onError);

  (window as unknown as Record<string, unknown>)['phutrue'] = bridge(info, settings);

  const code = readFileSync(path.join(DIST, 'app.js'), 'utf8');
  // eslint-disable-next-line no-new-func
  new Function(code)();

  harness = {
    cleanup: () => {
      window.removeEventListener('error', onError);
    },
  };
  return { errors };
}

/** Give React's effect chain a few macrotasks to settle. */
async function settle(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
}

const INFO = {
  version: '0.1.0',
  electron: '45.2.1',
  chrome: '156.0.8078.75',
  node: '24.22.1',
  platform: 'win32',
  secureStorageAvailable: true,
  secureStorageReason: null,
};

const SETTINGS = {
  theme: 'system',
  syncIntervalSeconds: 300,
  loadRemoteImages: false,
  notificationsEnabled: true,
  pageSize: 50,
};

const built = existsSync(path.join(DIST, 'app.js')) && existsSync(path.join(DIST, 'index.html'));

beforeEach(() => {
  document.head.querySelectorAll('script').forEach((s) => s.remove());
  document.body.replaceChildren();
  const root = document.createElement('div');
  root.id = 'root';
  document.body.appendChild(root);
});

afterEach(() => {
  harness?.cleanup();
  harness = undefined;
  Reflect.deleteProperty(window as unknown as Record<string, unknown>, 'phutrue');
});

describe.skipIf(!built)('the shipped bundle renders the whole boot screen', () => {
  it('mounts content rather than leaving #root empty', async () => {
    const { errors } = runBundle(INFO, SETTINGS);
    await settle();

    const root = document.getElementById('root');
    expect(root).not.toBeNull();
    // The specific failure this guards: #root present but empty.
    expect((root?.innerHTML.length ?? 0)).toBeGreaterThan(500);
    expect(errors).toEqual([]);
  });

  it('renders the branding, not just the logo', async () => {
    runBundle(INFO, SETTINGS);
    await settle();

    const text = document.body.textContent ?? '';
    expect(text).toContain('Phutrue');
    expect(text).toContain('by Baraily Inovex');
  });

  it('renders the environment facts read over IPC', async () => {
    runBundle(INFO, SETTINGS);
    await settle();

    const text = document.body.textContent ?? '';
    expect(text).toContain('0.1.0');
    expect(text).toContain('45.2.1');
    expect(text).toContain('156.0.8078.75');
    expect(text).toContain('available');
  });

  it('renders the Run diagnostics control', async () => {
    runBundle(INFO, SETTINGS);
    await settle();

    const button = [...document.querySelectorAll('button')].find((b) =>
      (b.textContent ?? '').includes('Run diagnostics')
    );
    expect(button).toBeDefined();
  });

  it('opens the diagnostics view when the bundled button is clicked', async () => {
    runBundle(INFO, SETTINGS);
    await settle();

    const button = [...document.querySelectorAll('button')].find((b) =>
      (b.textContent ?? '').includes('Run diagnostics')
    ) as HTMLButtonElement | undefined;
    expect(button).toBeDefined();

    button?.click();
    await settle();

    expect(document.querySelector('#diag-title')).not.toBeNull();
    expect(document.body.textContent).toContain('Development aid for Windows verification');
  });

  it('inlines the logo as a data URI, so no network or disk fetch is needed', async () => {
    runBundle(INFO, SETTINGS);
    await settle();

    const img = document.querySelector('img.boot__logo') as HTMLImageElement | null;
    expect(img).not.toBeNull();
    expect(img?.getAttribute('src')).toMatch(/^data:image\/png;base64,/);
  });

  it('reports a missing bridge instead of rendering an empty shell', async () => {
    // No bridge at all: the preload failed to load. This is the one path that
    // must never produce a blank window.
    const code = readFileSync(path.join(DIST, 'app.js'), 'utf8');
    // eslint-disable-next-line no-new-func
    new Function(code)();
    await settle();

    expect(document.body.textContent).toContain('bridge is unavailable');
    expect(document.querySelector('[role="alert"]')).not.toBeNull();
  });
});

describe('the bundle smoke test is actually running', () => {
  it('has a built bundle available', () => {
    // Deliberately explicit: if dist/ is missing, say so rather than skipping
    // quietly. Run `npm run build` before the suite.
    expect(built).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * Stylesheet and script MIME types
 *
 * Paired with the nosniff header, a wrong type stops app.js running or app.css
 * applying at all. Asserted against the real handler in protocol.test.ts; here
 * the shipped files are checked to exist so that handler has something to serve.
 * ------------------------------------------------------------------ */

describe.skipIf(!built)('shipped files the handler must type correctly', () => {
  it('index.html references only relative assets', () => {
    const html = readFileSync(path.join(DIST, 'index.html'), 'utf8');
    expect(html).toMatch(/<script src="app\.js">/);
    expect(html).toMatch(/<link rel="stylesheet" href="app\.css"/);
  });

  it('app.js is non-empty and looks like a script', () => {
    const js = readFileSync(path.join(DIST, 'app.js'), 'utf8');
    expect(js.length).toBeGreaterThan(10_000);
    expect(js).not.toMatch(/^\s*</); // not accidentally an html error page
  });
});
