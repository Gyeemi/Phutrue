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
import { rmSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'dist');
const watch = process.argv.includes('--watch');
const dev = watch || process.argv.includes('--dev');

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
}

run().catch((err) => {
  console.error('[build] failed:', err);
  process.exitCode = 1;
});
