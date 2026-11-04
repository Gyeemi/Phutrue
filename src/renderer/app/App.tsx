/**
 * Application shell.
 *
 * Milestone 1 scope: prove the pipeline end to end — app:// protocol, IPC bridge,
 * CSP, theme tokens, and a real read of main-process state. The feature surface
 * (accounts, mail, composer) is layered on in later milestones.
 */

import { useEffect, useState } from 'react';

import type { AppInfo, Settings } from '../../shared/models.js';
import { call, isBridgeAvailable } from '../api.js';
import { BootScreen } from '../components/BootScreen.js';

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; info: AppInfo; settings: Settings }
  | { status: 'error'; message: string };

export function App(): JSX.Element {
  const [state, setState] = useState<LoadState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;

    async function load() {
      if (!isBridgeAvailable()) {
        if (!cancelled) {
          setState({ status: 'error', message: 'The application bridge is unavailable.' });
        }
        return;
      }
      try {
        const [info, settings] = await Promise.all([
          call('app:info', undefined),
          call('settings:get', undefined),
        ]);
        if (!cancelled) setState({ status: 'ready', info, settings });
      } catch (err) {
        if (!cancelled) {
          setState({
            status: 'error',
            message: err instanceof Error ? err.message : 'Failed to start.',
          });
        }
      }
    }

    void load();
    return () => { cancelled = true; };
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
  return <BootScreen variant="ready" info={state.info} settings={state.settings} />;
}
