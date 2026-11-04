/**
 * Boot screen.
 *
 * Milestone 1's only screen. It is not a mock: every value shown is read from
 * the main process over the real IPC bridge, so if it renders, the whole stack
 * (protocol → CSP → preload → router → validation → handler) is working.
 *
 * The branding — logo, wordmark colours, typography — follows the official
 * identity in docs/branding.md.
 */

import { useState } from 'react';

import type { AppInfo, Settings } from '../../shared/models.js';
import { DiagnosticsView } from './DiagnosticsView.js';

// esbuild's `dataurl` loader inlines the PNG as a data: URI at build time. That
// keeps the image inside the bundle and satisfies the `img-src 'self' data:`
// CSP without loosening the policy or reading from disk at runtime.
import logoUrl from '../../../assets/generated/png/icon-128.png';

import './boot.css';

interface BootScreenProps {
  variant: 'loading' | 'ready' | 'error';
  message?: string;
  info?: AppInfo;
  settings?: Settings;
  /** Shown as a "Back" control when the screen is reached from the app shell. */
  onClose?: () => void;
}

export function BootScreen({ variant, message, info, settings, onClose }: BootScreenProps): JSX.Element {
  const [showDiagnostics, setShowDiagnostics] = useState(false);

  // The diagnostics screen replaces the card rather than overlaying it, so there
  // is no modal focus trap to get wrong in a development-only view.
  if (showDiagnostics) {
    return (
      <div className="boot">
        <DiagnosticsView onClose={() => setShowDiagnostics(false)} />
      </div>
    );
  }

  return (
    <div className="boot">
      <div className="boot__card">
        {onClose && (
          <button type="button" className="boot__back" onClick={onClose}>
            Back to accounts
          </button>
        )}
        <img className="boot__logo" src={logoUrl} width={96} height={96} alt="" aria-hidden="true" />

        <h1 className="boot__title">Phutrue</h1>
        <p className="boot__by">by Baraily Inovex</p>

        {variant === 'loading' && (
          <p className="boot__status" role="status">
            Starting…
          </p>
        )}

        {variant === 'error' && (
          <div className="boot__status boot__status--error" role="alert">
            {message}
          </div>
        )}

        {variant === 'ready' && info && (
          <>
            <dl className="boot__facts">
              <div>
                <dt>Version</dt>
                <dd>{info.version}</dd>
              </div>
              <div>
                <dt>Electron</dt>
                <dd>{info.electron}</dd>
              </div>
              <div>
                <dt>Chromium</dt>
                <dd>{info.chrome}</dd>
              </div>
              <div>
                <dt>Node</dt>
                <dd>{info.node}</dd>
              </div>
              <div>
                <dt>Build</dt>
                {/*
                  The stamp identifies exactly which renderer files this window
                  loaded. It is the first thing to check when the window looks
                  wrong: a value that does not match dist/build-stamp.json means
                  a stale install rather than a rendering fault.
                */}
                <dd className="boot__mono">{info.buildStamp}</dd>
              </div>
              <div>
                <dt>Secure storage</dt>
                <dd className={info.secureStorageAvailable ? 'is-ok' : 'is-warn'}>
                  {info.secureStorageAvailable ? 'available' : 'unavailable'}
                </dd>
              </div>
              {settings && (
                <div>
                  <dt>Theme</dt>
                  <dd>{settings.theme}</dd>
                </div>
              )}
            </dl>

            {!info.secureStorageAvailable && info.secureStorageReason && (
              <p className="boot__warn" role="alert">
                {info.secureStorageReason} Passwords will not be saved until this is resolved.
              </p>
            )}

            <p className="boot__next">
              Shell, secure IPC and storage are wired. Account setup is available; mail
              synchronisation arrives in a later milestone.
            </p>

            {/*
              Development aid: lets a Windows tester confirm the storage stack from
              inside the real app. Never touches, displays or logs a credential.
            */}
            <div className="boot__tools">
              <button
                type="button"
                className="boot__tool-button"
                onClick={() => setShowDiagnostics(true)}
              >
                Run diagnostics
              </button>
              <span className="boot__tool-note">Windows verification aid</span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
