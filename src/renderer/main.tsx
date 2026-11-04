/**
 * Renderer entry point.
 *
 * Mounts the application shell. The only thing here beyond mounting is a
 * readiness signal, which exists because of a real failure: the app once showed
 * a window that had loaded successfully but was the wrong document, and the
 * Console stayed completely blank. There was no way to tell "the renderer
 * mounted and is working" from "the renderer never ran" without a person
 * staring at the screen and guessing.
 *
 * The signal is deliberately observable from the main process with nothing but
 * `document.title`, so it needs no new IPC channel and no widened bridge:
 *
 *   - the static title in index.html is "Phutrue";
 *   - this file sets it to "Phutrue — ready" only after React has mounted;
 *   - any later screen failure leaves the title at the static value.
 *
 * That distinction is the whole point. A blank Console plus a title of
 * "Phutrue — ready" means the bundle ran and the fault is in a screen. A title
 * of "Phutrue" means the bundle never executed at all.
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './app/App.js';
import './styles/app.css';
import './components/account.css';

/** Set once React has committed its first render. Read by main via the title. */
export const READY_TITLE = 'Phutrue — ready';

const container = document.getElementById('root');
if (!container) {
  // Without this the page would render nothing and say nothing. Main treats a
  // title of "Phutrue" as "never mounted", so throwing here is consistent.
  throw new Error('Root element missing from index.html');
}

const root = createRoot(container);
root.render(
  <StrictMode>
    <App />
  </StrictMode>
);

/*
 * Announce readiness on the next frame-ish tick.
 *
 * `render` is asynchronous under React 18+, so setting the title immediately
 * after it would race the commit and report readiness before anything is on
 * screen. A microtask after render is not enough either; a timeout of 0 lands
 * after the commit in practice.
 */
setTimeout(() => {
  document.title = READY_TITLE;
}, 0);
