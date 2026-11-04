#!/usr/bin/env node
/**
 * Build main, preload and renderer with esbuild.
 *
 *   node scripts/build.mjs            production build
 *   node scripts/build.mjs --watch    rebuild on change
 *
 * Design notes:
 *  - One bundler for all three targets, no dev server, no second origin. The
 *    renderer always loads from `app://` in production so the CSP under test is
 *    the CSP that ships.
 *  - Main and preload target the Node/Electron version Electron 45 embeds, so
 *    `node:sqlite` and other built-ins resolve as external.
 *  - The renderer is React; JSX is transformed by esbuild's automatic runtime.
 */

import { build, context } from 'esbuild';
import { rmSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'dist');
const watch = process.argv.includes('--watch');
const dev = watch || process.argv.includes('--dev');

/**
 * A stamp identifying exactly which files this build produced.
 *
 * Why this exists: a Linux sandbox cannot run the Electron binary, so every
 * claim about what a packaged Windows build *displays* is unverifiable here. The
 * most expensive failure mode is a tester looking at a stale or partially copied
 * bundle and reporting the wrong problem, so the running window must be able to
 * state which bytes it is showing.
 *
 * The stamp is the first 12 hex characters of a SHA-256 over the emitted files
 * in a fixed order. It depends only on build output, so two builds of the same
 * source agree, and any difference — a missing `app.css`, a truncated `app.js`,
 * a stale copy in an installed tree — changes it.
 */
function buildStamp(files) {
  const hash = createHash('sha256');
  for (const [name, bytes] of files) {
    hash.update(name);
    hash.update('\0');
    hash.update(bytes);
    hash.update('\0');
  }
  return hash.digest('hex').slice(0, 12);
}

/** Electron 45.2.1 → Node 24.22.1, Chromium 156. */
const NODE_TARGET = 'node24';
const CHROME_TARGET = 'chrome156';

/** Mark every Electron built-in and Node built-in as external. */
const nodeExternals = [
  'electron',
  'node:*',
  // Native/runtime-only deps that must not be bundled into the main process
  // because they resolve files relative to their own package directory.
  'imapflow',
  'nodemailer',
  'mailparser',
  'sanitize-html',
];

/** Shared options. */
const common = {
  bundle: true,
  sourcemap: dev ? 'inline' : true,
  minify: !dev,
  logLevel: 'info',
  define: {
    'process.env.NODE_ENV': JSON.stringify(dev ? 'development' : 'production'),
  },
};

const targets = [
  {
    name: 'main',
    options: {
      ...common,
      entryPoints: [path.join(ROOT, 'src/main/index.ts')],
      outfile: path.join(OUT, 'main/index.js'),
      platform: 'node',
      format: 'cjs',
      target: NODE_TARGET,
      external: nodeExternals,
    },
  },
  {
    name: 'preload',
    options: {
      ...common,
      entryPoints: [path.join(ROOT, 'src/preload/index.ts')],
      outfile: path.join(OUT, 'preload/index.js'),
      platform: 'node',
      format: 'cjs',
      target: NODE_TARGET,
      // The preload runs sandboxed; only `electron` is available to it.
      external: ['electron'],
    },
  },
  {
    name: 'renderer',
    options: {
      ...common,
      entryPoints: [path.join(ROOT, 'src/renderer/main.tsx')],
      outfile: path.join(OUT, 'renderer/app.js'),
      platform: 'browser',
      format: 'iife',
      target: CHROME_TARGET,
      jsx: 'automatic',
      loader: { '.png': 'dataurl', '.svg': 'dataurl', '.css': 'css' },
    },
  },
];

async function run() {
  if (!watch) rmSync(OUT, { recursive: true, force: true });
  mkdirSync(path.join(OUT, 'renderer'), { recursive: true });

  for (const t of targets) {
    if (watch) {
      const ctx = await context(t.options);
      await ctx.watch();
      console.log(`[build] watching ${t.name}`);
    } else {
      await build(t.options);
      console.log(`[build] ${t.name} → ${path.relative(ROOT, t.options.outfile)}`);
    }
  }

  // index.html is copied verbatim; it is small and must stay readable so the
  // CSP can be reviewed.
  const { copyFileSync, existsSync } = await import('node:fs');
  const htmlSrc = path.join(ROOT, 'src/renderer/index.html');
  if (existsSync(htmlSrc)) {
    copyFileSync(htmlSrc, path.join(OUT, 'renderer/index.html'));
    console.log('[build] renderer/index.html');
  }

  if (watch) {
    // A hash of files that are still being rewritten on every keystroke would
    // be noise, and it would require a circular rebuild of main. Development
    // builds report the stamp as "dev" instead.
    console.log('[build] renderer stamp: dev (watch mode)');
    return;
  }

  /*
   * Stamp the build, then rebuild the main process so it carries the value.
   *
   * Order matters: the stamp covers the renderer files, so those must be final.
   * Main is rebuilt rather than patched so the value is baked in exactly as
   * esbuild would bake any other constant — there is no runtime file read, and
   * therefore no way for a packaged app to read a stale stamp file from the
   * wrong directory.
   */
  const rendererFiles = ['app.js', 'app.css', 'index.html']
    .map((name) => path.join(OUT, 'renderer', name))
    .filter((file) => existsSync(file))
    .map((file) => [path.basename(file), readFileSync(file)]);

  const stamp = buildStamp(rendererFiles);
  writeFileSync(
    path.join(OUT, 'build-stamp.json'),
    JSON.stringify({ stamp, files: rendererFiles.map(([n, b]) => ({ name: n, bytes: b.length })) }, null, 2) + '\n'
  );
  console.log(`[build] stamp ${stamp}`);

  const mainOptions = {
    ...targets[0].options,
    define: { ...targets[0].options.define, __BUILD_STAMP__: JSON.stringify(stamp) },
  };
  await build(mainOptions);
  console.log('[build] main (stamped)');
}

run().catch((err) => {
  console.error('[build] failed:', err);
  process.exitCode = 1;
});
