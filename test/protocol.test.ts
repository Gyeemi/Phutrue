/**
 * Path containment for the app:// protocol.
 *
 * This is a real security boundary: `dist/renderer/` sits next to the main
 * bundle, so a traversal bug would hand the renderer the main-process code and,
 * with it, full Node access. These tests exercise the pure resolver directly.
 */

import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

// The resolver is pure; electron is only pulled in by the module's other
// exports, which need the electron binary that CI does not download.
vi.mock('electron', () => ({
  protocol: { registerSchemesAsPrivileged: () => {}, handle: () => {} },
  net: { fetch: async () => new Response('') },
}));

const ROOT = path.resolve('/app/dist/renderer');

const { resolveRendererPath } = await import('../src/main/protocol.js');

function resolve(p: string) {
  return resolveRendererPath(ROOT, p);
}

describe('benign requests', () => {
  it('serves index.html for the root', () => {
    const r = resolve('/');
    expect(r).toEqual({ ok: true, file: path.join(ROOT, 'index.html') });
  });

  it('serves a sibling asset', () => {
    const r = resolve('/app.js');
    expect(r).toEqual({ ok: true, file: path.join(ROOT, 'app.js') });
  });

  it('serves a nested asset', () => {
    const r = resolve('/assets/icon.png');
    expect(r).toEqual({ ok: true, file: path.join(ROOT, 'assets', 'icon.png') });
  });

  it('decodes an encoded filename', () => {
    const r = resolve('/caf%C3%A9.css');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.file.endsWith('café.css')).toBe(true);
  });
});

describe('traversal is refused', () => {
  const attacks = [
    '/../main/index.js',
    '/../../package.json',
    '/../renderer/../../main/index.js',
    '/assets/../../main/index.js',
    '/..%2fmain%2findex.js',
    '/%2e%2e/%2e%2e/package.json',
    '/....//main/index.js',
  ];

  for (const attack of attacks) {
    it(`refuses ${attack}`, () => {
      const r = resolve(attack);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.status).toBe(403);
    });
  }

  // Windows silently strips trailing dots and spaces from path components, so
  // these pass a naive containment check but reach the parent directory.
  const windowsAttacks = [
    '/.. /main/index.js',
    '/../ /main/index.js',
    '/.../main/index.js',
    '/..%20/main/index.js',
    '/app.js::$DATA',
    '/C:/Windows/System32/config/SAM',
    '/app.js.',
  ];

  for (const attack of windowsAttacks) {
    it(`refuses Windows-specific ${attack}`, () => {
      const r = resolve(attack);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.status).toBe(403);
    });
  }

  it('refuses an absolute path that escapes the root', () => {
    // path.join(ROOT, '/etc/passwd') stays under ROOT on POSIX because join
    // treats it as relative — assert the outcome is contained either way.
    const r = resolve('/etc/passwd');
    if (r.ok) expect(r.file.startsWith(ROOT + path.sep)).toBe(true);
  });

  it('never returns the root directory itself', () => {
    const r = resolveRendererPath(ROOT, '/subdir/..');
    if (r.ok) expect(r.file).not.toBe(ROOT);
  });
});

describe('malformed input', () => {
  it('rejects a malformed percent-escape', () => {
    expect(resolve('/%E0%A4%A')).toEqual({ ok: false, status: 404 });
  });

  it('rejects a NUL byte', () => {
    expect(resolve('/app.js%00.png')).toEqual({ ok: false, status: 404 });
  });

  it('treats an empty path as the document root', () => {
    const r = resolve('');
    expect(r).toEqual({ ok: true, file: path.join(ROOT, 'index.html') });
  });
});

describe('root normalisation', () => {
  it('rejects a root with a trailing separator leaking into the prefix check', () => {
    // A root already ending in a separator must not produce a doubled prefix
    // that would make `..` containments pass.
    const withSep = ROOT + path.sep;
    const r = resolveRendererPath(withSep, '/app.js');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.file).toBe(path.join(ROOT, 'app.js'));
  });
});
