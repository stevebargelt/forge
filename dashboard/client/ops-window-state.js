// FG-836: the Ops runtime panel's window, as state and as a read.
//
// The window is carried in `#ops?window=<w>` (the route table's params/paramValues, the
// FG-828/FG-832 pattern) so a reload restores it; the default (7d) is omitted from the
// canonical hash and an unknown value falls back to it silently.
//
// A read is tracked per metric as `{ data, window, error, pending }`: `window` is the
// window the data on screen came from — never the one the operator asked for — so a
// view waiting on (or failed at) a new window can only ever label itself honestly.
// Changing the window keeps the previous data visible while the new read is in flight;
// a newer read aborts the older one, and a read past the client budget is aborted and
// reported as such. Only a scope change drops the data (FG-699).
//
// The Ops summary's own window (`#ops?since=<w>`, the `since` for GET /api/ops) is the
// same shape: 7d omitted, an unknown value falling back silently, read through its own
// reader. Each control's hash keeps the other's value, so the two round-trip together.

import { hashFor, ROUTES } from "./view-routing.js";
import { formatDuration } from "./format.js";

export const RUNTIME_WINDOW_DEFAULT = "7d";
export const RUNTIME_WINDOWS = Object.freeze(["1d", "7d", "30d", "90d", "all"]);
export const OPS_FETCH_BUDGET_MS = 10_000;

export const OPS_SINCE_DEFAULT = "7d";
export const OPS_SINCES = Object.freeze(["7d", "30d", "all"]);

export function runtimeWindowState(params) {
  return ROUTES.ops.paramValues.window.includes(params?.window) ? params.window : RUNTIME_WINDOW_DEFAULT;
}

export function opsSinceState(params) {
  return ROUTES.ops.paramValues.since.includes(params?.since) ? params.since : OPS_SINCE_DEFAULT;
}

/** The hash a runtime window button writes, keeping the scope and the summary's since; defaults are omitted. */
export function runtimeWindowHash(scope, window, since = OPS_SINCE_DEFAULT) {
  return hashFor({ view: "ops", scope, params: { since, window } });
}

/** The hash a summary window button writes, keeping the scope and the runtime window. */
export function opsSinceHash(scope, since, window = RUNTIME_WINDOW_DEFAULT) {
  return hashFor({ view: "ops", scope, params: { since, window } });
}

export const EMPTY_WINDOW_LOAD = Object.freeze({ data: null, window: null, error: null, pending: null });

/** A read for `window` starts. An error about another window is not this read's to show. */
export function beginWindowRead(load, window) {
  return { ...load, pending: window, error: load.error?.window === window ? load.error : null };
}

export function settleWindowRead(window, data) {
  return { data, window, error: null, pending: null };
}

/** A failed read keeps the data it failed to replace, and says which window failed. */
export function failWindowRead(load, window, reason) {
  return { ...load, error: { window, reason }, pending: null };
}

/**
 * What the panel says about a load, for the window the operator asked for:
 * `loading` only while a read for a window other than the one on screen is in flight
 * (a background refresh of the same window is silent), `showing` the data's own window.
 */
export function windowLoadView(load, requested) {
  const loading = load.pending !== null && (load.data === null || load.pending !== load.window);
  return {
    loading,
    loadingWindow: loading ? load.pending : null,
    showing: load.data !== null ? load.window : null,
    pressed: load.data !== null ? load.window : requested,
  };
}

/**
 * One metric's reader. `read(url, window)` aborts whatever this reader still has in
 * flight, starts the new read under the client budget, and reports every state change
 * through `onUpdate`. A superseded or reset read never writes.
 */
export function createWindowedReader({ label, onUpdate, fetchImpl = (...a) => fetch(...a), budgetMs = OPS_FETCH_BUDGET_MS, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let load = EMPTY_WINDOW_LOAD;
  let current = null;
  const publish = (next) => {
    load = next;
    onUpdate(next);
  };
  const cancel = () => {
    current?.controller.abort();
    current = null;
  };
  return {
    get load() { return load; },
    read(url, window) {
      cancel();
      const token = { controller: new AbortController(), timedOut: false };
      current = token;
      const timer = setTimer(() => {
        token.timedOut = true;
        token.controller.abort();
      }, budgetMs);
      publish(beginWindowRead(load, window));
      return (async () => {
        try {
          const res = await fetchImpl(url, { signal: token.controller.signal });
          const body = res.ok ? await res.json() : null;
          if (current !== token) return;
          publish(res.ok ? settleWindowRead(window, body) : failWindowRead(load, window, `${label} unavailable — HTTP ${res.status}`));
        } catch (e) {
          if (current !== token) return;
          const reason = token.timedOut
            ? `${label} for ${window} did not answer within ${formatDuration(budgetMs)} — the read was cancelled`
            : `${label} unavailable — ${e instanceof Error ? e.message : String(e)}`;
          publish(failWindowRead(load, window, reason));
        } finally {
          clearTimer(timer);
          if (current === token) current = null;
        }
      })();
    },
    reset() {
      cancel();
      publish(EMPTY_WINDOW_LOAD);
    },
  };
}
