/**
 * Typed wrapper around `window.phutrue`.
 *
 * The preload bridge is the only channel to the main process. This module gives
 * it types and a small ergonomic surface, and centralises the "unwrap a Result"
 * pattern so call sites do not each invent their own error handling.
 */

import type { Channel, PhutrueApi, ReqOf, ResOf, Result } from '../shared/ipc.js';

declare global {
  interface Window {
    phutrue?: PhutrueApi;
  }
}

function bridge(): PhutrueApi {
  const api = window.phutrue;
  if (!api) {
    // Reached only if the preload failed to load — the UI must not pretend the
    // app is working when the bridge is missing.
    throw new Error('The application bridge is unavailable.');
  }
  return api;
}

/** True when the preload bridge is present. */
export function isBridgeAvailable(): boolean {
  return typeof window.phutrue !== 'undefined';
}

/**
 * Invoke a channel and throw on failure.
 *
 * Callers that want to render a specific error should use `callResult`.
 */
export async function call<C extends Channel>(channel: C, payload: ReqOf<C>): Promise<ResOf<C>> {
  const res = await callResult(channel, payload);
  if (!res.ok) {
    const err = new Error(res.message) as Error & { code?: string };
    err.code = res.code;
    throw err;
  }
  return res.value;
}

/** Invoke a channel and return the raw Result, for UI that renders failures. */
export async function callResult<C extends Channel>(
  channel: C,
  payload: ReqOf<C>
): Promise<Result<ResOf<C>>> {
  if (!isBridgeAvailable()) {
    return { ok: false, code: 'INTERNAL', message: 'The application bridge is unavailable.' };
  }
  return bridge().invoke(channel, payload);
}

/*
 * NOTE: there is no `onEvent()` helper yet.
 *
 * The contract declares three push events (`sync:progress`, `mail:new`,
 * `account:state`), but nothing in the main process emits one, because there is
 * no sync engine. A subscription helper with no publisher is dead code that
 * suggests a working feature. It will be added with the first emitter in
 * milestone 6, where it can be tested end to end.
 */
