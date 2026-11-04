/**
 * Diagnostics helpers shared by both processes.
 *
 * These live in `src/shared` rather than `src/main` on purpose: the renderer must
 * never import main-process code, even something as harmless as a formatter,
 * because that boundary is what keeps `node:sqlite` and `safeStorage` out of the
 * renderer bundle.
 *
 * Everything here is pure — no I/O, no Electron, no secrets.
 */

import type { DiagnosticCheck, DiagnosticsReport } from './models.js';

/** Short label for a check status, used by both the table and the text export. */
export const STATUS_LABEL: Record<DiagnosticCheck['status'], string> = {
  pass: 'PASS',
  fail: 'FAIL',
  skip: 'SKIP',
};

/**
 * Recompute `ok` from a set of checks.
 *
 * Necessary because the renderer merges its own bridge check into the report the
 * main process produced, so the `ok` flag must be derived from the combined list
 * rather than trusted from either half.
 */
export function summarise(
  checks: DiagnosticCheck[],
  platform: string,
  generatedAt: number
): DiagnosticsReport {
  return {
    checks,
    ok: checks.every((c) => c.status !== 'fail'),
    generatedAt,
    platform,
  };
}

/**
 * Render a report as plain text for the clipboard.
 *
 * Mirrors the on-screen table exactly, so a tester cannot accidentally copy more
 * than they can see. That property is the reason this is a shared function with
 * a test rather than an inline string join.
 */
export function reportToText(report: DiagnosticsReport): string {
  const lines = [
    'Phutrue diagnostics',
    `Generated: ${new Date(report.generatedAt).toISOString()}`,
    `Platform: ${report.platform}`,
    `Result: ${report.ok ? 'ALL CHECKS PASSED' : 'FAILURES PRESENT'}`,
    '',
  ];
  for (const c of report.checks) {
    lines.push(`[${STATUS_LABEL[c.status]}] ${c.label} (${c.id}) — ${c.durationMs}ms`);
    if (c.detail) lines.push(`        ${c.detail}`);
  }
  return lines.join('\n');
}

/** Count of failing checks; 0 when everything passed. */
export function failureCount(report: DiagnosticsReport): number {
  return report.checks.filter((c) => c.status === 'fail').length;
}
