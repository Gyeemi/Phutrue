/**
 * Diagnostics view — a Windows verification aid.
 *
 * ⚠ Development aid, not a product feature. It is reachable from the boot screen
 * by an explicit "Run diagnostics" button, and it exists so a tester on Windows
 * can confirm — inside the real Electron process — that the storage stack works.
 *
 * It renders the report produced by the main process and adds one check of its
 * own: the preload bridge. Testing the bridge from inside the renderer is the
 * only way to prove it, because the main process cannot observe the context
 * boundary from the outside.
 *
 * Safety rules for this view:
 *   - nothing secret is rendered, and the main-process report cannot contain a
 *     secret (see src/main/diagnostics/index.ts);
 *   - the "Copy report" action copies exactly what is on screen, nothing more;
 *   - no `innerHTML`: every value goes through React's text nodes.
 */

import { useCallback, useState } from 'react';

import { failureCount, reportToText, STATUS_LABEL, summarise } from '../../shared/diagnostics.js';
import type { DiagnosticCheck, DiagnosticsReport } from '../../shared/models.js';
import { callResult, isBridgeAvailable } from '../api.js';

import './diagnostics.css';

interface DiagnosticsViewProps {
  onClose: () => void;
}

type RunState =
  | { status: 'idle' }
  | { status: 'running' }
  | { status: 'done'; report: DiagnosticsReport }
  | { status: 'error'; message: string };

/**
 * Check the preload bridge from the renderer side.
 *
 * Three assertions, cheapest first:
 *   1. the bridge object exists at all (preload loaded);
 *   2. it exposes only the three documented members (no leaked IPC surface);
 *   3. a real IPC round trip answers — using an argument-free, side-effect-free
 *      channel, so the probe cannot mutate anything.
 */
async function runBridgeCheck(): Promise<DiagnosticCheck> {
  const started = Date.now();
  const base = { id: 'bridge.ipc', label: 'Preload bridge and IPC' };

  if (!isBridgeAvailable()) {
    return {
      ...base,
      status: 'fail',
      detail: 'window.phutrue is missing — the preload script did not load.',
      durationMs: Date.now() - started,
    };
  }

  const api = window.phutrue;
  const members = Object.keys(api ?? {}).sort();
  const expected = ['invoke', 'on', 'platform'];
  const extra = members.filter((m) => !expected.includes(m));
  if (extra.length > 0) {
    // Surface the count, not the names: a leaked member could be a raw
    // ipcRenderer handle and naming it in a screenshot is unhelpful.
    return {
      ...base,
      status: 'fail',
      detail: `The bridge exposes ${extra.length} undocumented member(s).`,
      durationMs: Date.now() - started,
    };
  }

  const res = await callResult('app:info', undefined);
  if (!res.ok) {
    return {
      ...base,
      status: 'fail',
      detail: `IPC round trip failed: ${res.code}.`,
      durationMs: Date.now() - started,
    };
  }

  return {
    ...base,
    status: 'pass',
    detail: `round trip ok; bridge exposes ${members.join(', ')}`,
    durationMs: Date.now() - started,
  };
}

export function DiagnosticsView({ onClose }: DiagnosticsViewProps): JSX.Element {
  const [state, setState] = useState<RunState>({ status: 'idle' });
  const [copied, setCopied] = useState(false);

  const run = useCallback(async () => {
    setState({ status: 'running' });
    setCopied(false);

    // Bridge first: if the preload failed, the IPC call below cannot work, and a
    // single clear failure is more useful than a confusing cascade.
    const bridgeCheck = await runBridgeCheck();

    const res = await callResult('app:diagnostics', undefined);
    if (!res.ok) {
      // Still show the bridge result: knowing whether the bridge works is the
      // most useful fact when the main process refuses to answer.
      setState({
        status: 'done',
        report: summarise(
          [
            bridgeCheck,
            {
              id: 'main.diagnostics',
              label: 'Main-process diagnostics',
              status: 'fail',
              detail: `could not run: ${res.code}`,
              durationMs: 0,
            },
          ],
          window.phutrue?.platform ?? 'unknown',
          Date.now()
        ),
      });
      return;
    }

    // Merge the two halves, then derive `ok` from the combined set.
    setState({
      status: 'done',
      report: summarise([...res.value.checks, bridgeCheck], res.value.platform, Date.now()),
    });
  }, []);

  const copy = useCallback(async () => {
    if (state.status !== 'done') return;
    // Routed through main: the window denies every permission request, including
    // clipboard-write, so navigator.clipboard is not available by design.
    const res = await callResult('app:copyToClipboard', { text: reportToText(state.report) });
    setCopied(res.ok);
  }, [state]);

  return (
    <section className="diag" aria-labelledby="diag-title">
      <header className="diag__head">
        <div>
          <h2 id="diag-title" className="diag__title">
            Diagnostics
          </h2>
          <p className="diag__subtitle">
            Development aid for Windows verification. Reports storage and IPC health only —
            never credentials, tokens or message content.
          </p>
        </div>
        <button type="button" className="diag__close" onClick={onClose} aria-label="Close diagnostics">
          ✕
        </button>
      </header>

      <div className="diag__actions">
        <button
          type="button"
          className="diag__button diag__button--primary"
          onClick={() => void run()}
          disabled={state.status === 'running'}
        >
          {state.status === 'running' ? 'Running…' : 'Run diagnostics'}
        </button>
        <button
          type="button"
          className="diag__button"
          onClick={() => void copy()}
          disabled={state.status !== 'done'}
        >
          {copied ? 'Copied' : 'Copy report'}
        </button>
      </div>

      {state.status === 'idle' && (
        <p className="diag__hint" role="status">
          Nothing has been run yet.
        </p>
      )}

      {state.status === 'running' && (
        <p className="diag__hint" role="status">
          Checking database, migrations and credential encryption…
        </p>
      )}

      {state.status === 'error' && (
        <p className="diag__hint diag__hint--bad" role="alert">
          {state.message}
        </p>
      )}

      {state.status === 'done' && (
        <>
          <p
            className={
              state.report.ok ? 'diag__summary diag__summary--good' : 'diag__summary diag__summary--bad'
            }
            role="status"
          >
            {state.report.ok
              ? `All ${state.report.checks.length} checks passed.`
              : `${failureCount(state.report)} of ${state.report.checks.length} checks failed.`}
          </p>

          <table className="diag__table">
            <caption className="diag__caption">
              Generated {new Date(state.report.generatedAt).toLocaleString()} on {state.report.platform}
            </caption>
            <thead>
              <tr>
                <th scope="col">Status</th>
                <th scope="col">Check</th>
                <th scope="col">Detail</th>
                <th scope="col">ms</th>
              </tr>
            </thead>
            <tbody>
              {state.report.checks.map((c) => (
                <tr key={c.id} data-status={c.status}>
                  <td>
                    <span className={`diag__badge diag__badge--${c.status}`}>
                      {STATUS_LABEL[c.status]}
                    </span>
                  </td>
                  <th scope="row">
                    {c.label}
                    <code className="diag__id">{c.id}</code>
                  </th>
                  <td className="diag__detail">{c.detail}</td>
                  <td className="diag__ms">{c.durationMs}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}
