// @vitest-environment jsdom
/**
 * The diagnostics view.
 *
 * The main-process checks are covered in `diagnostics.test.ts`. What matters
 * here is the half that only the renderer can prove — that the preload bridge is
 * present, expose nothing undocumented, and actually answers — plus the promise
 * that this screen never shows a secret and never uses the clipboard API it is
 * denied.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DiagnosticCheck } from '../src/shared/models.js';

vi.mock('../src/renderer/styles/app.css', () => ({}));
vi.mock('../src/renderer/components/boot.css', () => ({}));
vi.mock('../src/renderer/components/diagnostics.css', () => ({}));

const { DiagnosticsView } = await import('../src/renderer/components/DiagnosticsView.js');

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const MAIN_CHECKS: DiagnosticCheck[] = [
  { id: 'database.path', label: 'Database file location', status: 'pass', detail: 'C:\\Users\\<user>\\phutrue.db', durationMs: 1 },
  { id: 'sqlite.query', label: 'node:sqlite query', status: 'pass', detail: 'SELECT 1 returned 1', durationMs: 0 },
];

let container: HTMLDivElement;
let root: Root | undefined;

function setBridge(api: unknown) {
  Object.defineProperty(window, 'phutrue', { value: api, configurable: true, writable: true });
}

interface BridgeOptions {
  members?: string[];
  infoOk?: boolean;
  diagnosticsOk?: boolean;
  copyOk?: boolean;
  mainChecks?: DiagnosticCheck[];
}

/** Build a bridge double and record what the view called. */
function makeBridge(opts: BridgeOptions = {}) {
  const calls: string[] = [];
  const api: Record<string, unknown> = {
    platform: 'win32',
    invoke: async (channel: string, payload: unknown) => {
      calls.push(channel);
      if (channel === 'app:info') {
        return opts.infoOk === false
          ? { ok: false, code: 'FORBIDDEN', message: 'Request from an untrusted frame.' }
          : { ok: true, value: { version: '0.1.0' } };
      }
      if (channel === 'app:diagnostics') {
        return opts.diagnosticsOk === false
          ? { ok: false, code: 'INTERNAL', message: 'An internal error occurred.' }
          : {
              ok: true,
              value: {
                checks: opts.mainChecks ?? MAIN_CHECKS,
                ok: true,
                generatedAt: 1,
                platform: 'win32',
              },
            };
      }
      if (channel === 'app:copyToClipboard') {
        void payload;
        return opts.copyOk === false
          ? { ok: false, code: 'INTERNAL', message: 'no' }
          : { ok: true, value: undefined };
      }
      return { ok: false, code: 'UNKNOWN_CHANNEL', message: 'no' };
    },
    on: () => () => {},
  };

  // Trim the surface to what the test wants the renderer to see, and add any
  // extras the test asked for (so a leaked member can be simulated).
  if (opts.members) {
    for (const key of Object.keys(api)) {
      if (!opts.members.includes(key)) delete api[key];
    }
    for (const key of opts.members) {
      if (!(key in api)) api[key] = 'leaked';
    }
  }
  return { api, calls };
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
  vi.restoreAllMocks();
});

async function renderAndRun() {
  await act(async () => {
    root!.render(<DiagnosticsView onClose={() => {}} />);
  });
  const button = [...container.querySelectorAll('button')].find((b) =>
    (b.textContent ?? '').includes('Run diagnostics')
  );
  expect(button).toBeDefined();
  await act(async () => {
    button!.click();
  });
  await act(async () => {
    await Promise.resolve();
  });
  await act(async () => {
    await Promise.resolve();
  });
}

function statusOf(id: string): string | undefined {
  const row = container.querySelector(`tr[data-status] th code.diag__id`);
  void row;
  for (const code of container.querySelectorAll('code.diag__id')) {
    if (code.textContent === id) {
      const tr = code.closest('tr');
      return tr?.getAttribute('data-status') ?? undefined;
    }
  }
  return undefined;
}

describe('healthy run', () => {
  it('renders a row per check plus the bridge check', async () => {
    const { api } = makeBridge();
    setBridge(api);
    await renderAndRun();

    const ids = [...container.querySelectorAll('code.diag__id')].map((c) => c.textContent);
    expect(ids).toContain('database.path');
    expect(ids).toContain('sqlite.query');
    expect(ids).toContain('bridge.ipc');
  });

  it('reports success when everything passes', async () => {
    const { api } = makeBridge();
    setBridge(api);
    await renderAndRun();
    expect(container.textContent).toContain('All 3 checks passed.');
  });

  it('describes the bridge surface it verified', async () => {
    const { api } = makeBridge();
    setBridge(api);
    await renderAndRun();
    expect(statusOf('bridge.ipc')).toBe('pass');
    expect(container.textContent).toContain('invoke, on, platform');
  });

  it('asks main for diagnostics and for a bridge round trip', async () => {
    const { api, calls } = makeBridge();
    setBridge(api);
    await renderAndRun();
    expect(calls).toContain('app:diagnostics');
    expect(calls).toContain('app:info');
  });
});

describe('bridge failures', () => {
  it('fails clearly when the preload did not load', async () => {
    await renderAndRun(); // no bridge installed at all
    expect(statusOf('bridge.ipc')).toBe('fail');
    expect(container.textContent).toContain('preload script did not load');
  });

  it('fails when the bridge exposes an undocumented member', async () => {
    const { api } = makeBridge({ members: ['invoke', 'on', 'platform', 'ipcRenderer'] });
    setBridge(api);
    await renderAndRun();
    expect(statusOf('bridge.ipc')).toBe('fail');
    // The count is reported, not the leaked name.
    expect(container.textContent).toContain('1 undocumented member');
    expect(container.textContent).not.toContain('ipcRenderer');
  });

  it('fails when IPC refuses the round trip', async () => {
    const { api } = makeBridge({ infoOk: false });
    setBridge(api);
    await renderAndRun();
    expect(statusOf('bridge.ipc')).toBe('fail');
    expect(container.textContent).toContain('IPC round trip failed: FORBIDDEN');
  });

  it('still shows the bridge result when main diagnostics fail', async () => {
    const { api } = makeBridge({ diagnosticsOk: false });
    setBridge(api);
    await renderAndRun();
    expect(statusOf('bridge.ipc')).toBe('pass');
    expect(statusOf('main.diagnostics')).toBe('fail');
    expect(container.textContent).toContain('could not run: INTERNAL');
  });
});

describe('secret hygiene', () => {
  it('does not render arbitrary text from a check detail', async () => {
    // React escapes by construction; this asserts the view has no HTML sink.
    const { api } = makeBridge({
      mainChecks: [
        {
          id: 'x',
          label: 'X',
          status: 'pass',
          detail: '<img src=x onerror=alert(1)>',
          durationMs: 0,
        },
      ],
    });
    setBridge(api);
    await renderAndRun();
    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>');
  });
});

describe('clipboard', () => {
  it('copies through main, never through navigator.clipboard', async () => {
    const { api, calls } = makeBridge();
    setBridge(api);

    // navigator.clipboard is denied by the window's permission handlers, so a
    // call to it would fail in the real app. Prove the view does not try.
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });

    await renderAndRun();

    const copyButton = [...container.querySelectorAll('button')].find((b) =>
      (b.textContent ?? '').includes('Copy report')
    );
    expect(copyButton).toBeDefined();
    await act(async () => {
      copyButton!.click();
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(calls).toContain('app:copyToClipboard');
    expect(writeText).not.toHaveBeenCalled();
  });

  it('disables the copy button until a report exists', async () => {
    const { api } = makeBridge();
    setBridge(api);
    await act(async () => {
      root!.render(<DiagnosticsView onClose={() => {}} />);
    });
    const copyButton = [...container.querySelectorAll('button')].find((b) =>
      (b.textContent ?? '').includes('Copy report')
    );
    expect((copyButton as HTMLButtonElement).disabled).toBe(true);
  });
});
