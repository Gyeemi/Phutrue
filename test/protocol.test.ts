/**
 * Path containment for the app:// protocol.
 *
 * This is a real security boundary: `dist/renderer/` sits next to the main
 * bundle, so a traversal bug would hand the renderer the main-process code and,
 * with it, full Node access. These tests exercise the pure resolver directly.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

// The resolver is pure; electron is only pulled in by the module's other
// exports, which need the electron binary that CI does not download.
// Captured so `serveRenderer` can be driven for real rather than only its
// pure helpers being tested.
const captured: { handler?: (req: { url: string }) => Promise<Response> } = {};

vi.mock('electron', () => ({
  protocol: {
    registerSchemesAsPrivileged: () => {},
    handle: (_scheme: string, fn: (req: { url: string }) => Promise<Response>) => {
      captured.handler = fn;
    },
  },
  net: { fetch: async () => new Response('') },
}));

const ROOT = path.resolve('/app/dist/renderer');

const { resolveRendererPath, serveRenderer, contentTypeFor } = await import(
  '../src/main/protocol.js'
);

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

/* ------------------------------------------------------------------ *
 * Content-Type
 *
 * `installCsp` stamps `X-Content-Type-Options: nosniff` on every response. With
 * nosniff in force Chromium refuses a subresource whose MIME type does not match
 * how it is used: a script without a JavaScript type never executes, and a
 * stylesheet without text/css is ignored. Leaving the type to `net.fetch`'s
 * sniffing made both outcomes depend on an implementation detail, which is
 * exactly the kind of fault that only appears on a machine we cannot test.
 * ------------------------------------------------------------------ */

describe('content types are explicit', () => {
  it.each([
    ['app.js', 'text/javascript; charset=utf-8'],
    ['app.mjs', 'text/javascript; charset=utf-8'],
    ['app.css', 'text/css; charset=utf-8'],
    ['index.html', 'text/html; charset=utf-8'],
    ['logo.png', 'image/png'],
    ['icon.ico', 'image/x-icon'],
    ['logo.svg', 'image/svg+xml'],
    ['app.js.map', 'application/json; charset=utf-8'],
  ])('maps %s', (file, expected) => {
    expect(contentTypeFor(file)).toBe(expected);
  });

  it('is case-insensitive about the extension', () => {
    expect(contentTypeFor('APP.JS')).toBe('text/javascript; charset=utf-8');
    expect(contentTypeFor('Logo.PNG')).toBe('image/png');
  });

  it('refuses an unknown extension rather than guessing', () => {
    // A guess could let the file be interpreted as something executable.
    expect(contentTypeFor('payload.exe')).toBeNull();
    expect(contentTypeFor('script.wasm')).toBeNull();
    expect(contentTypeFor('no-extension')).toBeNull();
  });
});

describe('serveRenderer response headers', () => {
  /** Serve a request against a real temp directory. */
  async function serve(dir: string, urlPath: string): Promise<Response> {
    serveRenderer(dir);
    const handler = captured.handler;
    if (!handler) throw new Error('serveRenderer did not register a handler');
    return handler({ url: `app://phutrue${urlPath}` });
  }

  it('serves the entry point as html', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'phutrue-serve-'));
    try {
      writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>x</title>');
      const res = await serve(dir, '/');
      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
      expect(await res.text()).toContain('<title>x</title>');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('serves app.js as a JavaScript type that nosniff will accept', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'phutrue-serve-'));
    try {
      writeFileSync(path.join(dir, 'app.js'), 'console.log(1)');
      const res = await serve(dir, '/app.js');
      expect(res.headers.get('Content-Type')).toBe('text/javascript; charset=utf-8');
      expect(res.headers.get('Content-Length')).toBe('14');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('serves app.css as text/css', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'phutrue-serve-'));
    try {
      writeFileSync(path.join(dir, 'app.css'), 'body{color:red}');
      const res = await serve(dir, '/app.css');
      expect(res.headers.get('Content-Type')).toBe('text/css; charset=utf-8');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('marks responses no-store so a stale bundle cannot survive an update', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'phutrue-serve-'));
    try {
      writeFileSync(path.join(dir, 'app.js'), 'x');
      const res = await serve(dir, '/app.js');
      expect(res.headers.get('Cache-Control')).toBe('no-store');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns 415 for a disallowed type instead of serving it', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'phutrue-serve-'));
    try {
      writeFileSync(path.join(dir, 'evil.exe'), 'MZ');
      const res = await serve(dir, '/evil.exe');
      expect(res.status).toBe(415);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns 404 for a typed file that does not exist', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'phutrue-serve-'));
    try {
      const res = await serve(dir, '/missing.js');
      expect(res.status).toBe(404);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('never serves a file outside the root, even via ..', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'phutrue-serve-'));
    try {
      // The WHATWG URL parser collapses `..` before the handler sees the path,
      // so this arrives as /main/index.js — contained and simply absent. What
      // matters is that nothing outside the root is returned.
      const res = await serve(dir, '/../main/index.js');
      expect([403, 404]).toContain(res.status);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses an encoded traversal that survives URL normalisation', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'phutrue-serve-'));
    try {
      // %2e%2e is decoded by resolveRendererPath, not by the URL parser.
      const res = await serve(dir, '/%2e%2e/main/index.js');
      expect([403, 404]).toContain(res.status);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns 404 for a foreign host', async () => {
    serveRenderer(tmpdir());
    const res = await captured.handler!({ url: 'app://evil/index.html' });
    expect(res.status).toBe(404);
  });
});

