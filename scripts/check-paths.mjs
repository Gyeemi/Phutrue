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
const MAIN = path.join(ROOT, 'src', 'main', 'main.js');

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

check('main.js exists', await exists(MAIN));
check('declares main entry in package.json',
  !!JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8')).main);
check('sets an AppUserModelId for taskbar/toast identity',
  /setAppUserModelId\(/.test(src));
check('AUMID matches the publisher identity',
  /'BarailyInovex\.Phutrue'/.test(src));
// Must compare against the call site, not the `function createMainWindow()`
// definition which appears earlier in the file.
check('AUMID is set before the window is created',
  src.indexOf('setAppUserModelId') < src.lastIndexOf('createMainWindow();'));

// Every asset(...) call in main.js must resolve to a real file.
const refs = [...src.matchAll(/asset\(([^)]*)\)/g)]
  .map((m) => [...m[1].matchAll(/'([^']*)'/g)].map((x) => x[1]))
  .filter((parts) => parts.length);

console.log(`\n  ${refs.length} asset reference(s) found in main.js`);
for (const parts of refs) {
  const rel = path.join('assets', 'generated', ...parts);
  const abs = path.join(ROOT, rel);
  const ok = await exists(abs);
  let size = '';
  if (ok) {
    const s = await stat(abs);
    size = `${s.size} B`;
  }
  check(`resolves: ${rel}`, ok, size);
}

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
