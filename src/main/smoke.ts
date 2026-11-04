/**
 * Packaged-app self test.
 *
 * Exists to answer one question that cannot be answered honestly from a Linux
 * sandbox: **does the real application, running in a real Electron process,
 * actually display the account setup screen?**
 *
 * Static analysis, jsdom renders and bundle smoke tests all stop one step short
 * of that. They prove the code is correct; they cannot prove the app runs.
 *
 * ## How it works
 *
 * When `PHUTRUE_SMOKE` is set, the main process — after the window has loaded —
 * inspects the live renderer through `executeJavaScript`, writes a JSON report,
 * and quits with a non-zero code if anything is wrong. That makes the assertion
 * a build failure rather than a screenshot someone has to interpret.
 *
 * ## What it deliberately does not do
 *
 * It never runs unless explicitly requested, so a normal launch is unaffected.
 * It reads only the *rendered text* of the setup screen — no account data, no
 * credentials, no message content, and nothing from the database. The report
 * describes the window, not the user.
 */

import { writeFileSync } from 'node:fs';
import type { BrowserWindow } from 'electron';

import { READY_TITLE } from './windows.js';

/** Text that must be present for the account setup screen to count as shown. */
export const REQUIRED_TEXT = ['Set up your mail', 'Gmail', 'Microsoft'];

export interface SmokeReport {
  /** Whether the whole check passed. */
  ok: boolean;
  /** Final URL of the window's main frame. */
  url: string;
  /** Document title at the time of inspection. */
  title: string;
  /** Whether the renderer reported readiness (React committed). */
  rendererMounted: boolean;
  /** First part of the rendered text, for a human reading a failed report. */
  text: string;
  /** Required phrases that were missing, if any. */
  missing: string[];
  /** Main-frame failures recorded during load. */
  loadFailures: string[];
  /** Electron, Chromium and Node versions actually in use. */
  versions: { electron: string; chrome: string; node: string };
  /**
   * Schema version the running app reached, or null if the database was never
   * consulted. Non-null is the difference between "a window appeared" and "the
   * application can actually work".
   */
  schemaVersion: number | null;
  /**
   * Where an unusable database was moved, or null if recovery did not run.
   * Non-null means the app started by setting a broken file aside.
   */
  quarantined: string | null;
  /**
   * Whether the renderer is genuinely running: app:// origin, React committed,
   * no load failures. Unlike `ok`, this does not depend on which screen is
   * being shown.
   */
  healthy: boolean;
  /**
   * Process exit code the caller should use.
   *
   * Driven by `healthy`, not `ok`. This is the difference between "did the
   * application start?" and "did it show the screen we expected?". A database
   * that already holds an account correctly shows the Accounts screen, so
   * deriving the exit code from `ok` reported a working app as broken - and it
   * did, in CI, before this was separated.
   */
  exitCode: number;
}

/**
 * Evaluate the live renderer and build a report.
 *
 * Separated from the Electron plumbing so the decision logic is testable with a
 * plain stub window.
 */
export async function inspectWindow(
  win: BrowserWindow,
  loadFailures: readonly string[],
  schemaVersion: number | null = null,
  quarantined: string | null = null
): Promise<SmokeReport> {
  const url = win.webContents.getURL();

  let title = '';
  let text = '';
  try {
    title = String(await win.webContents.executeJavaScript('document.title', true));
    text = String(await win.webContents.executeJavaScript('document.body.innerText', true));
  } catch {
    // A renderer that cannot be inspected is itself a failure; the empty values
    // make that visible in the report rather than throwing past it.
  }

  const rendererMounted = title === READY_TITLE;
  const missing = REQUIRED_TEXT.filter((phrase) => !text.includes(phrase));

  /*
   * The URL check is separate from the text check on purpose. A window can show
   * the right words from the wrong document (an error page quoting the app, for
   * instance), and the failure this whole investigation was about was exactly a
   * correct-looking page served from the wrong place.
   */
  const fromAppOrigin = url.startsWith('app://phutrue');

  const healthy = fromAppOrigin && rendererMounted && loadFailures.length === 0;
  const ok = healthy && missing.length === 0;

  return {
    ok,
    url,
    title,
    rendererMounted,
    text: text.slice(0, 600),
    missing,
    loadFailures: [...loadFailures],
    versions: {
      electron: process.versions['electron'] ?? 'unknown',
      chrome: process.versions['chrome'] ?? 'unknown',
      node: process.versions['node'] ?? 'unknown',
    },
    schemaVersion,
    quarantined,
    healthy,
    exitCode: healthy ? 0 : 1,
  };
}

/** Write the report where the caller asked, or next to the executable. */
export function writeReport(report: SmokeReport, outPath: string): void {
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}
