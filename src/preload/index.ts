/**
 * Preload bridge.
 *
 * Runs with `sandbox: true` and `contextIsolation: true`, so this script has no
 * Node access beyond the `electron` primitives and cannot be reached from the
 * page's JavaScript context.
 *
 * What it exposes is deliberately tiny:
 *   - `invoke(channel, payload)` — a single typed door to the main process.
 *   - `on(event, listener)`      — subscription to push events.
 *   - `platform`                 — a string, for UI affordances.
 *
 * It is NOT a general `ipcRenderer` passthrough. There is no way to reach a
 * channel the main process does not know about, because the main process keeps
 * the allowlist; there is no way to pass a function, because only
 * structured-cloneable values cross `contextBridge`.
 */

import { contextBridge, ipcRenderer } from 'electron';
import type { Channel, MailEvent, MailEventMap, PhutrueApi, ReqOf, Result, ResOf } from '../shared/ipc.js';

const INVOKE = 'phutrue:invoke';
const EVENT_PREFIX = 'phutrue:event:';

function subscribe<E extends MailEvent>(event: E, listener: (payload: MailEventMap[E]) => void): () => void {
  const channel = EVENT_PREFIX + event;

  // Wrap so the renderer never receives the Electron IpcRendererEvent object,
  // which carries a `sender` handle it must not have.
  const wrapped = (_e: unknown, payload: MailEventMap[E]) => listener(payload);

  ipcRenderer.on(channel, wrapped as never);

  return () => {
    ipcRenderer.removeListener(channel, wrapped as never);
  };
}

const api: PhutrueApi = {
  async invoke<C extends Channel>(channel: C, payload: ReqOf<C>): Promise<Result<ResOf<C>>> {
    // A malformed channel string is rejected in main; this guard just avoids a
    // pointless round trip.
    if (typeof channel !== 'string' || !channel.includes(':')) {
      return { ok: false, code: 'UNKNOWN_CHANNEL', message: 'Unknown request.' };
    }
    return ipcRenderer.invoke(INVOKE, channel, payload) as Promise<Result<ResOf<C>>>;
  },

  on: subscribe,

  platform: process.platform,
};

contextBridge.exposeInMainWorld('phutrue', api);
