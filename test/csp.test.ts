/**
 * CSP and renderer-loading assumptions.
 *
 * A CSP is easy to get subtly wrong in a way that only shows up as a blank or
 * unstyled window inside Electron — which this environment cannot render. These
 * tests close as much of that gap as is possible without a browser:
 *
 *  - every directive is parsed out of `windows.ts` and matched against the
 *    resources the built renderer actually requests;
 *  - the double CSP (header + meta) is checked for agreement, because the
 *    intersection of two policies applies and a stricter meta tag silently wins;
 *  - the html the build emits is checked for absolute URLs, which would break
 *    under a custom `app://` origin.
 *
 * What this cannot prove: that Chromium accepts the policy. That needs the app.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: { isPackaged: false },
  protocol: { registerSchemesAsPrivileged: () => {}, handle: () => {} },
  net: { fetch: async () => new Response('') },
  BrowserWindow: class {},
  shell: { openExternal: async () => {} },
}));

const ROOT = path.resolve(__dirname, '..');
const WINDOWS_SRC = readFileSync(path.join(ROOT, 'src/main/windows.ts'), 'utf8');
const PROTOCOL_SRC = readFileSync(path.join(ROOT, 'src/main/protocol.ts'), 'utf8');
const HTML_SRC = readFileSync(path.join(ROOT, 'src/renderer/index.html'), 'utf8');
const PKG = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
  main: string;
};

/** Pull the CSP array out of `installCsp` and turn it into a directive map. */
function headerCsp(): Map<string, string[]> {
  // Each directive is a quoted string literal in the array; `devMode ? … : …`
  // is gone, so this is a flat scan.
  const start = WINDOWS_SRC.indexOf('const csp = [');
  const end = WINDOWS_SRC.indexOf('.join(', start);
  expect(start).toBeGreaterThan(-1);
  const block = WINDOWS_SRC.slice(start, end);

  const directives = [...block.matchAll(/"([a-z-]+(?: [^"]*)?)"/g)]
    .map((m) => m[1] ?? '')
    .filter((d) => d.includes(' ') || d.includes("'") || d.length > 0);

  const map = new Map<string, string[]>();
  for (const d of directives) {
    // Skip the header names and values that also appear in this block.
    if (!/^[a-z-]+ /.test(d)) continue;
    const [name, ...values] = d.split(/\s+/);
    if (!name) continue;
    map.set(name, values);
  }
  return map;
}

/** Parse the `<meta http-equiv>` policy. */
function metaCsp(): Map<string, string[]> {
  const match = /http-equiv="Content-Security-Policy"\s*\n?\s*content="([^"]+)"/.exec(HTML_SRC);
  expect(match).not.toBeNull();
  const map = new Map<string, string[]>();
  for (const directive of (match?.[1] ?? '').split(';')) {
    const parts = directive.trim().split(/\s+/).filter(Boolean);
    const name = parts.shift();
    if (name) map.set(name, parts);
  }
  return map;
}

const header = headerCsp();
const meta = metaCsp();

describe('every policy is restrictive where it matters', () => {
  it.each([
    ['default-src', "'none'"],
    ['script-src', "'self'"],
    ['object-src', "'none'"],
    ['frame-src', "'none'"],
    ['base-uri', "'none'"],
    ['form-action', "'none'"],
    ['frame-ancestors', "'none'"],
  ])('header sets %s to %s', (directive, expected) => {
    expect(header.get(directive)).toEqual([expected]);
  });

  it('never allows unsafe-inline or unsafe-eval for scripts', () => {
    const script = header.get('script-src') ?? [];
    expect(script).not.toContain("'unsafe-inline'");
    expect(script).not.toContain("'unsafe-eval'");
    expect(script).not.toContain('*');
  });

  it('never allows a remote script origin', () => {
    const script = header.get('script-src') ?? [];
    for (const source of script) {
      expect(source).not.toMatch(/^https?:/);
    }
  });

  it('blocks all network egress from the renderer', () => {
    // All network work happens in main, so the renderer needs no fetch at all.
    expect(header.get('connect-src')).toEqual(["'none'"]);
    expect(header.get('media-src')).toEqual(["'none'"]);
    expect(header.get('worker-src')).toEqual(["'none'"]);
  });

  it('does not enable Trusted Types (it would crash React — see windows.ts)', () => {
    expect(header.has('require-trusted-types-for')).toBe(false);
  });
});

describe('the policy permits what the renderer actually loads', () => {
  it('allows same-origin scripts', () => {
    // dist/renderer/index.html loads app.js as a same-origin relative path.
    expect(header.get('script-src')).toContain("'self'");
  });

  it('allows same-origin stylesheets', () => {
    expect(header.get('style-src')).toContain("'self'");
  });

  it('allows inline styles for measured layout and color-mix()', () => {
    // React sets a handful of style attributes; no style *blocks* are inlined.
    expect(header.get('style-src')).toContain("'unsafe-inline'");
  });

  it('allows data: images, because the logo is inlined as a data URI', () => {
    const img = header.get('img-src') ?? [];
    expect(img).toContain('data:');
    expect(img).toContain("'self'");
  });

  it('does not allow fonts from the network', () => {
    expect(header.get('font-src')).toEqual(["'self'"]);
  });
});

describe('header and meta policies agree', () => {
  it('declares the same directive names', () => {
    const headerNames = [...header.keys()].sort();
    const metaNames = [...meta.keys()].sort();
    // `frame-ancestors` is ignored in a <meta> tag per spec, so it is the one
    // directive the header may carry alone.
    expect(metaNames).toEqual(headerNames.filter((n) => n !== 'frame-ancestors'));
  });

  it.each([
    'default-src',
    'script-src',
    'object-src',
    'frame-src',
    'base-uri',
    'form-action',
    'connect-src',
  ])('agrees on the sources for %s', (directive) => {
    // Two policies intersect, so a divergence silently tightens the effective
    // policy and can break loading without an obvious cause.
    expect([...(meta.get(directive) ?? [])].sort()).toEqual(
      [...(header.get(directive) ?? [])].sort()
    );
  });
});

describe('renderer loads from a custom origin, not file:// or data:', () => {
  it('the html uses only relative subresource paths', () => {
    const srcs = [...HTML_SRC.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1] ?? '');
    expect(srcs.length).toBeGreaterThan(0);
    for (const src of srcs) {
      expect(src).not.toMatch(/^[a-z]+:/i); // no scheme at all
      expect(src).not.toMatch(/^\//); // no absolute path either
    }
  });

  it('the window loads the app:// origin, not a file path', () => {
    expect(WINDOWS_SRC).toContain('win.loadURL(`${APP_ORIGIN}/index.html`)');
    expect(WINDOWS_SRC).not.toContain('loadFile(');
  });

  it('the scheme is registered as standard and secure before app ready', () => {
    // `standard` gives a real origin (needed for a meaningful CSP);
    // `secure` keeps it out of the mixed-content / non-secure bucket.
    expect(PROTOCOL_SRC).toMatch(/standard:\s*true/);
    expect(PROTOCOL_SRC).toMatch(/secure:\s*true/);
    const index = readFileSync(path.join(ROOT, 'src/main/index.ts'), 'utf8');
    // Anchor on the real invocation, not the doc comment that names it.
    const registerAt = index.indexOf('\nregisterAppScheme();');
    const readyAt = index.indexOf('app.whenReady().then(');
    expect(registerAt).toBeGreaterThan(-1);
    expect(readyAt).toBeGreaterThan(-1);
    expect(registerAt).toBeLessThan(readyAt);
  });

  it('does not serve the renderer over file:// or an inline data: document', () => {
    // Both caused real bugs: a data: document cannot load file:// subresources.
    const index = readFileSync(path.join(ROOT, 'src/main/index.ts'), 'utf8');
    expect(index).not.toContain('data:text/html');
    expect(index).not.toContain('protocol.handle(\'file\'');
  });

  it('package.json points main at the built bundle the renderer is built beside', () => {
    expect(PKG.main).toBe('dist/main/index.js');
  });
});

describe('the diagnostics screen does not weaken the policy', () => {
  it('introduces no inline script or style block', () => {
    expect(HTML_SRC).not.toMatch(/<script(?![^>]*src=)/);
    expect(HTML_SRC).not.toMatch(/<style/);
  });

  it('uses no eval-like construct in the renderer sources', () => {
    // The bundler output is checked separately by the build smoke test.
    const files = [
      'src/renderer/app/App.tsx',
      'src/renderer/components/BootScreen.tsx',
      'src/renderer/components/DiagnosticsView.tsx',
      'src/renderer/api.ts',
    ];
    for (const f of files) {
      const src = readFileSync(path.join(ROOT, f), 'utf8');
      expect(src).not.toMatch(/\beval\s*\(/);
      expect(src).not.toMatch(/new Function\s*\(/);
      expect(src).not.toMatch(/dangerouslySetInnerHTML/);
    }
  });
});
