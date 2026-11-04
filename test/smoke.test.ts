/**
 * The packaged-app self test's decision logic.
 *
 * `inspectWindow` is what decides whether a real Electron window counts as
 * showing the account setup screen. Its correctness matters more than most
 * tests here: it is the only automated claim this project can make about the
 * *installed application*, and a bug that made it pass vacuously would turn the
 * Windows check into a rubber stamp.
 *
 * A stub window is used, so this verifies the decision, not Electron itself.
 * The Electron half runs in CI on windows-latest.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { isPackaged: false },
  BrowserWindow: class {},
  shell: { openExternal: async () => {} },
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return { ...actual, writeFileSync: vi.fn() };
});

const { inspectWindow, REQUIRED_TEXT } = await import('../src/main/smoke.js');
const { READY_TITLE } = await import('../src/main/windows.js');

interface StubOptions {
  url?: string;
  title?: string;
  text?: string;
  throwOnEval?: boolean;
}

function stubWindow({ url = 'app://phutrue/index.html', title = READY_TITLE, text = '', throwOnEval }: StubOptions = {}) {
  const fullText =
    text ||
    'Set up your mail Connect a Gmail or Microsoft account to begin. Gmail Sign in Microsoft Sign in';
  return {
    webContents: {
      getURL: () => url,
      executeJavaScript: async (script: string) => {
        if (throwOnEval) throw new Error('renderer gone');
        return script === 'document.title' ? title : fullText;
      },
    },
  } as unknown as Parameters<typeof inspectWindow>[0];
}

describe('inspectWindow — the passing case', () => {
  it('passes when the app origin loads, React mounted, and the screen text is present', async () => {
    const report = await inspectWindow(stubWindow(), []);
    expect(report.ok).toBe(true);
    expect(report.exitCode).toBe(0);
    expect(report.missing).toEqual([]);
  });

  it('reports the real Electron versions, not placeholders', async () => {
    const report = await inspectWindow(stubWindow(), []);
    expect(report.versions.electron).toBe(process.versions['electron'] ?? 'unknown');
    expect(Object.keys(report.versions).sort()).toEqual(['chrome', 'electron', 'node']);
  });
});

describe('inspectWindow — the failures it must catch', () => {
  it('fails when the document is not from the app origin', async () => {
    // The exact shape of the original bug: a page that renders fine but is not
    // the application.
    const report = await inspectWindow(stubWindow({ url: 'data:text/html,hello' }), []);
    expect(report.ok).toBe(false);
    expect(report.exitCode).toBe(1);
    expect(report.url).toContain('data:');
  });

  it('fails when React never mounted', async () => {
    // Title still at the static value means the bundle did not execute.
    const report = await inspectWindow(stubWindow({ title: 'Phutrue' }), []);
    expect(report.ok).toBe(false);
    expect(report.rendererMounted).toBe(false);
  });

  it('fails when the setup screen text is absent', async () => {
    // A window showing only the logo and wordmark — the reported symptom.
    const report = await inspectWindow(stubWindow({ text: 'Phutrue by Baraily Inovex' }), []);
    expect(report.ok).toBe(false);
    expect(report.missing).toEqual(expect.arrayContaining(['Set up your mail']));
  });

  it('fails when only some of the required text is present', async () => {
    const report = await inspectWindow(stubWindow({ text: 'Set up your mail Gmail' }), []);
    expect(report.ok).toBe(false);
    expect(report.missing).toContain('Microsoft');
  });

  it('fails when the main frame recorded a load failure', async () => {
    const report = await inspectWindow(stubWindow(), ['app://phutrue/index.html (-6 ERR_FILE_NOT_FOUND)']);
    expect(report.ok).toBe(false);
    expect(report.loadFailures).toHaveLength(1);
  });

  it('fails rather than throwing when the renderer cannot be inspected', async () => {
    const report = await inspectWindow(stubWindow({ throwOnEval: true }), []);
    expect(report.ok).toBe(false);
    expect(report.title).toBe('');
  });

  it('truncates the captured text so a report cannot grow unbounded', async () => {
    const report = await inspectWindow(stubWindow({ text: 'Set up your mail Gmail Microsoft ' + 'x'.repeat(5000) }), []);
    expect(report.text.length).toBeLessThanOrEqual(600);
  });
});

describe('required text', () => {
  it('names the screen and both providers', () => {
    // Pinned: weakening this list would weaken the only check the project makes
    // about the installed application.
    expect(REQUIRED_TEXT).toEqual(['Set up your mail', 'Gmail', 'Microsoft']);
  });
});

describe('recovery is reported, not hidden', () => {
  it('records where an unusable database was moved', async () => {
    const win = stubWindow();
    const report = await inspectWindow(
      win,
      [],
      2,
      'C:\\Users\\me\\AppData\\Roaming\\Phutrue\\phutrue.db.unusable-2026-11-04'
    );
    expect(report.quarantined).toContain('unusable');
  });

  it('leaves it null on a normal start', async () => {
    const win = stubWindow();
    const report = await inspectWindow(win, [], 2, null);
    expect(report.quarantined).toBeNull();
  });
});

describe('healthy is not the same as showing the setup screen', () => {
  it('is healthy on the Accounts screen, without the setup phrases', async () => {
    // Once an account exists the app shows "Accounts", not "Set up your mail".
    // A check that demanded the setup text would call a working app broken -
    // which is exactly what the half-migrated test did when it was first run.
    const win = stubWindow({ text: 'Accounts Existing existing@example.com Add account' });
    const report = await inspectWindow(win, [], 2, null);

    expect(report.healthy).toBe(true);
    expect(report.ok).toBe(false);
    expect(report.missing.length).toBeGreaterThan(0);
  });

  it('is not healthy when the renderer never mounted', async () => {
    const win = stubWindow({ title: 'Phutrue', text: 'Set up your mail Gmail Microsoft' });
    const report = await inspectWindow(win, [], 2, null);
    expect(report.healthy).toBe(false);
  });

  it('is not healthy when a main-frame load failed', async () => {
    const win = stubWindow();
    const report = await inspectWindow(win, ['ERR_FAILED app://phutrue/index.html'], 2, null);
    expect(report.healthy).toBe(false);
  });
});
