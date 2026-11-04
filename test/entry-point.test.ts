/**
 * Which main-process file Electron actually starts, and what it loads.
 *
 * These tests exist because of a specific, expensive failure: a Windows build
 * showed a centred logo and nothing else, and the DevTools console was blank.
 * The cause was a retired `data:text/html` branding page — not the application
 * renderer — so nothing errored while everything was wrong.
 *
 * The tests below are deliberately about *source and configuration*, because
 * that is where the fault was: the bug was never in the renderer code, it was
 * in which entry point ran at all.
 */

import { describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..');

function read(rel: string): string {
  return readFileSync(path.join(ROOT, rel), 'utf8');
}

const PKG = JSON.parse(read('package.json')) as {
  main: string;
  scripts: Record<string, string>;
};

function collectFiles(dir: string, filter: (name: string) => boolean): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (filter(entry.name)) out.push(full);
    }
  };
  walk(dir);
  return out;
}

/* ------------------------------------------------------------------ *
 * The entry point
 * ------------------------------------------------------------------ */

describe('electron entry point', () => {
  it('points at the built main bundle', () => {
    expect(PKG.main).toBe('dist/main/index.js');
  });

  it('does not point at any legacy file', () => {
    expect(PKG.main).not.toContain('legacy');
    expect(PKG.main).not.toContain('branding');
  });

  it('builds before launching', () => {
    // `electron .` alone runs whatever dist/ happens to contain — including a
    // stale build that predates the current source. Building first is what makes
    // `npm start` reflect the checkout.
    expect(PKG.scripts['start']).toContain('build');
    expect(PKG.scripts['start']).toContain('electron');
  });

  it('builds main from the TypeScript source, not from src/legacy', async () => {
    const buildScript = read('scripts/build.mjs');
    expect(buildScript).toContain("'src/main/index.ts'");
    expect(buildScript).not.toContain('legacy');
  });
});

/* ------------------------------------------------------------------ *
 * The retired branding page
 * ------------------------------------------------------------------ */

describe('the retired branding entry point', () => {
  const LEGACY = path.join(ROOT, 'src', 'legacy', 'branding-main.js');

  it('still exists, so the history is readable', () => {
    expect(existsSync(LEGACY)).toBe(true);
  });

  it('throws on load rather than rendering a convincing wrong page', async () => {
    /*
     * The whole point. A page that renders successfully while being the wrong
     * page is worse than a crash: it looks healthy. Requiring this module to
     * throw means that if anything ever launches it, the failure is immediate
     * and states the cause.
     */
    const { spawnSync } = await import('node:child_process');
    // Executed in a child process: `require('electron')` at module scope would
    // otherwise fail for an unrelated reason and mask the real assertion.
    const result = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(LEGACY)})`], {
      encoding: 'utf8',
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('retired entry point');
    expect(result.stderr).toContain('dist/main/index.js');
  });

  it('no longer contains a data: URL document', () => {
    // If the body is ever restored, the guard above would still throw first;
    // this asserts the misleading page is genuinely gone, not merely unreachable.
    const source = read('src/legacy/branding-main.js');
    const code = source
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('*') && !line.trimStart().startsWith('//'))
      .join('\n');
    expect(code).not.toContain('loadURL');
    expect(code).not.toContain('data:text/html');
  });

  it('is excluded from the packaged app', () => {
    // electron-builder ships `dist/**/*` and package.json only. This asserts the
    // files list has not been widened to include src/.
    const config = read('electron-builder.yml');
    const filesBlock = config.slice(config.indexOf('files:'), config.indexOf('asar:'));
    expect(filesBlock).toContain('dist/**/*');
    expect(filesBlock).not.toMatch(/^\s*-\s*src\//m);
  });
});

/* ------------------------------------------------------------------ *
 * No other loader may exist
 * ------------------------------------------------------------------ */

describe('navigation surface', () => {
  /**
   * Strip comments so prose that *mentions* a loadURL does not count as one.
   * Anchoring on real call expressions rather than substrings avoids the
   * comment-vs-code trap that has produced false findings in this repo before.
   */
  function codeOnly(source: string): string {
    return source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
  }

  it('has exactly one BrowserWindow.loadURL in the main process, and it loads app://', () => {
    const files = collectFiles(path.join(ROOT, 'src', 'main'), (n) => n.endsWith('.ts'));
    const loads: Array<{ file: string; line: string }> = [];

    for (const file of files) {
      const code = codeOnly(readFileSync(file, 'utf8'));
      for (const line of code.split('\n')) {
        if (/\.loadURL\s*\(/.test(line)) loads.push({ file: path.basename(file), line: line.trim() });
      }
    }

    expect(loads).toHaveLength(1);
    expect(loads[0]?.file).toBe('windows.ts');
    expect(loads[0]?.line).toContain('APP_ORIGIN');
  });

  it('never loads a data: or file: document in the main process', () => {
    const files = collectFiles(path.join(ROOT, 'src', 'main'), (n) => n.endsWith('.ts'));
    for (const file of files) {
      const code = codeOnly(readFileSync(file, 'utf8'));
      // `data:` is legitimate inside a page (the inlined logo), so this only
      // rejects it as a navigation target.
      expect(code).not.toMatch(/loadURL\s*\(\s*[`'"]data:/);
      expect(code).not.toMatch(/loadFile\s*\(/);
    }
  });
});

/* ------------------------------------------------------------------ *
 * Startup diagnostics exist and stay secret-free
 * ------------------------------------------------------------------ */

describe('startup diagnostics', () => {
  it('registers a did-fail-load handler for the main frame', () => {
    // Its absence is why the blank console gave no clue. Without this, a failed
    // document load is silent.
    const windows = read('src/main/windows.ts');
    expect(windows).toContain("'did-fail-load'");
    expect(windows).toContain('isMainFrame');
  });

  it('logs the loaded URL and warns when it is not the app origin', () => {
    const windows = read('src/main/windows.ts');
    expect(windows).toContain("'did-finish-load'");
    expect(windows).toContain('describeUrl');
    expect(windows).toMatch(/is not from|not from \$\{APP_ORIGIN\}/);
  });

  it('reports preload failures and renderer crashes', () => {
    const windows = read('src/main/windows.ts');
    expect(windows).toContain("'preload-error'");
    expect(windows).toContain("'render-process-gone'");
  });

  it('summarises a data: URL instead of logging its contents', async () => {
    /*
     * A data: URL contains a whole document. Logging it verbatim would flood the
     * console and could echo page content — which for a future mail screen could
     * include message text. Only the media type and a byte count are printed.
     *
     * Asserted against the function's behaviour rather than its source text: a
     * regex over the implementation is easy to write in a way that passes for
     * the wrong reason.
     */
    vi.resetModules();
    vi.doMock('electron', () => ({
      app: { isPackaged: false },
      BrowserWindow: class {},
      shell: { openExternal: async () => {} },
    }));
    const { describeUrl } = await import('../src/main/windows.js');

    const long = 'data:text/html;charset=utf-8,' + 'x'.repeat(5000);
    const summary = describeUrl(long);

    expect(summary).toContain('text/html');
    expect(summary).toContain('bytes');
    // The document itself must not appear, however long it is.
    expect(summary.length).toBeLessThan(60);
    expect(summary).not.toContain('xxxx');
  });

  it('passes ordinary URLs through unchanged', async () => {
    vi.resetModules();
    vi.doMock('electron', () => ({
      app: { isPackaged: false },
      BrowserWindow: class {},
      shell: { openExternal: async () => {} },
    }));
    const { describeUrl } = await import('../src/main/windows.js');

    // A normal URL is short and carries no page content, so it is the most
    // useful thing to print verbatim.
    expect(describeUrl('app://phutrue/index.html')).toBe('app://phutrue/index.html');
  });

  it('does not log any token-shaped identifier', () => {
    const windows = read('src/main/windows.ts');
    const logging = windows
      .split('\n')
      .filter((line) => line.includes('startLog') || line.includes('debugLog'))
      .join('\n');
    for (const forbidden of ['password', 'token', 'secret', 'credential', 'accessToken']) {
      expect(logging.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });
});

/* ------------------------------------------------------------------ *
 * Renderer readiness signal
 * ------------------------------------------------------------------ */

describe('renderer readiness signal', () => {
  it('uses the same title string as the main process expects', () => {
    /*
     * The renderer cannot import from src/main and main cannot import from the
     * renderer, so the literal is duplicated. Duplicated literals drift silently
     * and would turn the readiness check into a permanent false negative, so
     * they are compared here.
     */
    const mainSource = read('src/main/windows.ts');
    const rendererSource = read('src/renderer/main.tsx');

    const mainLiteral = /export const READY_TITLE = '([^']+)'/.exec(mainSource)?.[1];
    const rendererLiteral = /export const READY_TITLE = '([^']+)'/.exec(rendererSource)?.[1];

    expect(mainLiteral).toBeTruthy();
    expect(rendererLiteral).toBeTruthy();
    expect(rendererLiteral).toBe(mainLiteral);
  });

  it('starts from a different static title, so "not mounted" is distinguishable', () => {
    const html = read('src/renderer/index.html');
    const renderer = read('src/renderer/main.tsx');
    const staticTitle = /<title>([^<]+)<\/title>/.exec(html)?.[1];
    const readyTitle = /export const READY_TITLE = '([^']+)'/.exec(renderer)?.[1];

    expect(staticTitle).toBeTruthy();
    expect(staticTitle).not.toBe(readyTitle);
  });

  it('sets the title only after rendering', () => {
    const renderer = read('src/renderer/main.tsx');
    const renderIndex = renderer.indexOf('.render(');
    const titleIndex = renderer.indexOf('document.title = READY_TITLE');

    expect(renderIndex).toBeGreaterThan(-1);
    expect(titleIndex).toBeGreaterThan(renderIndex);
  });
});

/* ------------------------------------------------------------------ *
 * Stating which renderer is served
 *
 * A stale renderer caused a long false trail: the window showed a frame the
 * current source provably cannot produce, but nothing at runtime said which
 * files were on disk. These assertions keep that answer available.
 * ------------------------------------------------------------------ */

describe('startup reports the served renderer', () => {
  it('logs the renderer directory and the size of every file it needs', () => {
    const index = read('src/main/index.ts');
    expect(index).toContain('logRendererFacts');
    expect(index).toContain('statSync');
    // The three files whose absence or staleness produces a wrong window.
    expect(index).toContain("['index.html', 'app.js', 'app.css']");
  });

  it('reports a missing file explicitly instead of skipping it', () => {
    const index = read('src/main/index.ts');
    expect(index).toContain('MISSING');
  });

  it('logs sizes only, never file contents', () => {
    const index = read('src/main/index.ts');
    const fn = index.slice(index.indexOf('function logRendererFacts'));
    const body = fn.slice(0, fn.indexOf('\n}\n') + 2);

    expect(body).toContain('statSync');
    // Reading contents would be pointless here and risks echoing a bundle into a
    // log a user might paste publicly.
    expect(body).not.toContain('readFileSync');
    expect(body).not.toContain('readFile');
  });

  it('prints the build stamp alongside the sizes', () => {
    const index = read('src/main/index.ts');
    const fn = index.slice(index.indexOf('function logRendererFacts'));
    const body = fn.slice(0, fn.indexOf('\n}\n') + 2);
    expect(body).toContain('__BUILD_STAMP__');
  });
});

/* ------------------------------------------------------------------ *
 * Packaging never publishes
 *
 * electron-builder enables implicit publishing when it detects CI. That is a
 * standing requirement in this project - nothing may be published without
 * approval - and it also broke a build: the installer was created and then the
 * run failed while trying to create a GitHub release with no token.
 * ------------------------------------------------------------------ */

describe('the dist script cannot publish', () => {
  it('passes --publish never', () => {
    expect(PKG.scripts['dist']).toContain('--publish never');
  });

  it('builds a 64-bit Windows target', () => {
    expect(PKG.scripts['dist']).toContain('--win');
    expect(PKG.scripts['dist']).toContain('--x64');
  });

  it('checks assets and builds before packaging', () => {
    const dist = PKG.scripts['dist'] ?? '';
    expect(dist.indexOf('assets:check')).toBeLessThan(dist.indexOf('electron-builder'));
    expect(dist.indexOf('build')).toBeLessThan(dist.indexOf('electron-builder'));
  });
});

/* ------------------------------------------------------------------ *
 * The installer must be deliverable
 *
 * GitHub rejects any file over 100 MB. With the default compression the NSIS
 * installer was ~120 MB, so it built, verified and then could not be handed
 * over - it was rejected by the remote during push. That is a delivery failure,
 * not a build failure, and it deserves a test.
 * ------------------------------------------------------------------ */

describe('installer configuration', () => {
  it('uses maximum compression, to stay under the 100 MB file limit', () => {
    const config = read('electron-builder.yml');
    expect(config).toMatch(/^compression:\s*maximum$/m);
  });

  it('names the artifact with its version and architecture', () => {
    // A self-describing filename prevents a user installing a stale download.
    const config = read('electron-builder.yml');
    const line = /^artifactName:\s*(.+)$/m.exec(config)?.[1] ?? '';
    expect(line).toContain('${version}');
    expect(line).toContain('x64');
    expect(line).toContain('.${ext}');
  });
});
