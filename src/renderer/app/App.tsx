/**
 * Application shell.
 *
 * Responsibilities, in order:
 *   1. establish that the bridge exists and read the facts the UI needs;
 *   2. apply the persisted theme;
 *   3. show the boot screen while that happens, and a specific error if it
 *      cannot, because a blank window is indistinguishable from a crash;
 *   4. hand off to the account setup screen.
 *
 * The shell owns no feature logic. Everything below it talks to `api.ts`.
 */

import { useEffect, useState } from 'react';

import type { AppInfo, Settings } from '../../shared/models.js';
import { callResult, isBridgeAvailable } from '../api.js';
import { AccountScreen } from '../components/AccountScreen.js';
import { BootScreen } from '../components/BootScreen.js';

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; info: AppInfo; settings: Settings }
  | { status: 'error'; message: string };

export function App(): JSX.Element {
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [showBootDetails, setShowBootDetails] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      if (!isBridgeAvailable()) {
        if (!cancelled) {
          setState({ status: 'error', message: 'The application bridge is unavailable.' });
        }
        return;
      }

      /*
       * Both reads are independent, so they are awaited together. `callResult` is
       * used rather than `call` because the two failures need different words:
       * a missing settings row is recoverable and should not block the app, while
       * a failure to read app information means the main process is unhealthy.
       */
      const [info, settings] = await Promise.all([
        callResult('app:info', undefined),
        callResult('settings:get', undefined),
      ]);
      if (cancelled) return;

      if (!info.ok) {
        setState({ status: 'error', message: info.message });
        return;
      }

      // Settings failure is not fatal: the app works with defaults.
      const resolved: Settings = settings.ok
        ? settings.value
        : {
            theme: 'system',
            syncIntervalSeconds: 300,
            loadRemoteImages: false,
            notificationsEnabled: true,
            pageSize: 50,
          };

      setState({ status: 'ready', info: info.value, settings: resolved });
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  // Apply the persisted theme to the document so the tokens resolve correctly.
  useEffect(() => {
    if (state.status !== 'ready') return;
    const { theme } = state.settings;
    if (theme === 'system') {
      document.documentElement.removeAttribute('data-theme');
    } else {
      document.documentElement.setAttribute('data-theme', theme);
    }
  }, [state]);

  if (state.status === 'loading') {
    return <BootScreen variant="loading" />;
  }

  if (state.status === 'error') {
    return <BootScreen variant="error" message={state.message} />;
  }

  /*
   * The boot screen is still reachable: it is the only place that reports the
   * real environment facts and hosts the diagnostics view, which is how a
   * Windows tester confirms the storage stack. Hiding it entirely would remove
   * that.
   */
  if (showBootDetails) {
    return (
      <BootScreen
        variant="ready"
        info={state.info}
        settings={state.settings}
        onClose={() => setShowBootDetails(false)}
      />
    );
  }

  return (
    <div className="shell">
      <header className="shell__bar">
        <span className="shell__brand">Phutrue</span>
        <span className="shell__by">by Baraily Inovex</span>
        <span className="shell__spacer" />
        <button
          type="button"
          className="shell__link"
          onClick={() => setShowBootDetails(true)}
          title="Environment details and diagnostics"
        >
          About &amp; diagnostics
        </button>
      </header>

      <main className="shell__main">
        <AccountScreen ready={isBridgeAvailable()} />
      </main>
    </div>
  );
}
