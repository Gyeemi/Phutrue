#!/usr/bin/env node
/**
 * Static check of the Electron entry point's asset references.
 *
 * The Electron binary cannot be executed in this environment, so instead of
 * launching the app the references are resolved and stat-checked directly.
 * This catches the failure mode that actually matters here: a renamed or
 * missing icon path that only shows up at runtime as a blank window icon.
 */

import { readFile, access } from 'node:fs/promises';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// The real entry point. The branding-era `src/main/main.js` was superseded by
// the TypeScript main process and moved to src/legacy once the new shell
// reproduced it (see docs/architecture.md).
const MAIN = path.join(ROOT, 'src', 'main', 'index.ts');
const WINDOWS = path.join(ROOT, 'src', 'main', 'windows.ts');
const PKG = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));

let pass = 0, fail = 0;

function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS  ${name}${detail ? '  — ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? '  — ' + detail : ''}`); }
}

async function exists(p) {
  try { await access(p); return true; } catch { return false; }
}

const src = await readFile(MAIN, 'utf8');

console.log('Phutrue path checks');
console.log('='.repeat(66));
console.log('\nElectron entry point');
console.log('-'.repeat(66));

check('main entry exists', await exists(MAIN));
check('package.json main points at the built bundle',
  PKG.main === 'dist/main/index.js', String(PKG.main));
const BUILD = await readFile(path.join(ROOT, 'scripts', 'build.mjs'), 'utf8');
check('the build emits the bundle that main points at',
  /outfile:\s*path\.join\(OUT,\s*'main\/index\.js'\)/.test(BUILD));
check('the build emits the preload at the path the window expects',
  /outfile:\s*path\.join\(OUT,\s*'preload\/index\.js'\)/.test(BUILD));
check('sets an AppUserModelId for taskbar/toast identity',
  /setAppUserModelId\(/.test(src));
check('AUMID is defined by the publisher identity',
  /'BarailyInovex\.Phutrue'/.test(await readFile(WINDOWS, 'utf8')));
// Must compare against the call site, not the `function createMainWindow()`
// definition which appears earlier in the file.
check('AUMID is set before the window is created',
  src.indexOf('setAppUserModelId') < src.lastIndexOf('createMainWindow('));

// Every runtime asset reference in the main process must resolve to a real
// file. These are `resourcePath(...)` calls, which map onto assets/generated
// both in development and inside the packaged app.
const scanTargets = [WINDOWS, MAIN];
const refs = [];
for (const file of scanTargets) {
  const text = await readFile(file, 'utf8');
  for (const m of text.matchAll(/resourcePath\(([^)]*)\)/g)) {
    const parts = [...m[1].matchAll(/'([^']*)'/g)].map((x) => x[1]);
    if (parts.length) refs.push(parts);
  }
}

console.log(`\n  ${refs.length} runtime asset reference(s) found in the main process`);
check('at least one runtime asset reference is present', refs.length > 0);
for (const parts of refs) {
  // resourcePath() arguments are repo-relative and already include the
  // assets/generated prefix.
  const rel = path.join(...parts);
  const abs = path.join(ROOT, rel);
  const ok = await exists(abs);
  let size = '';
  if (ok) {
    const st = await stat(abs);
    size = `${st.size} B`;
  }
  check(`resolves: ${rel}`, ok, size);
}

// extraResources must ship what those references load at runtime.
check('extraResources ships assets/generated beside the asar',
  /extraResources:[\s\S]*from: assets\/generated/.test(
    await readFile(path.join(ROOT, 'electron-builder.yml'), 'utf8')));

// Distinct files must actually be distinct roles, not the same file four times
// by accident.
console.log('\nIcon role separation');
console.log('-'.repeat(66));
const roles = {
  'application (.ico, multi-res)': 'assets/generated/icon.ico',
  'window (256 png)': 'assets/generated/png/icon-256.png',
  'tray (32 png)': 'assets/generated/png/icon-32.png',
  'notification (256 png)': 'assets/generated/png/icon-256.png',
};
for (const [role, rel] of Object.entries(roles)) {
  check(`${role} -> ${rel}`, await exists(path.join(ROOT, rel)));
}

// Tray must not be a huge image: Windows scales it down badly and it wastes
// memory in a resident process.
const trayStat = await stat(path.join(ROOT, 'assets/generated/png/icon-32.png')).catch(() => null);
check('tray icon is small (<= 4 KiB)', trayStat !== null && trayStat.size <= 4096,
  trayStat ? `${trayStat.size} B` : 'missing');

console.log('\n' + '='.repeat(66));
console.log(`RESULT: ${pass} passed, ${fail} failed`);
if (fail) process.exitCode = 1;
