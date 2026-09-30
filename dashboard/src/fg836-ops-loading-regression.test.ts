// FG-836 verification additions: a background refresh must stay silent, and a
// transport that resolves even after AbortController fires must not repaint a
// newer window. This is deliberately distinct from the normal abort path,
// where fetch rejects immediately on abort.

import assert from "node:assert/strict";
import test from "node:test";
import { createWindowedReader, windowLoadView, type WindowLoad } from "../client/ops-window-state.js";

type Call = { signal: AbortSignal; resolve: (body: unknown) => void };

function abortIgnoringFetch() {
  const calls: Call[] = [];
  const fetchImpl = (_url: string, init: { signal: AbortSignal }) => new Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>((resolve) => {
    calls.push({ signal: init.signal, resolve: (body) => resolve({ ok: true, status: 200, json: async () => body }) });
  });
  return { calls, fetchImpl };
}

function fakeTimers() {
  let id = 0;
  return { setTimer: (_fn: () => void) => ++id, clearTimer: (_timer: number) => {} };
}

test("FG-836: a silent same-window refresh aborted by a new window cannot overwrite that newer data when it resolves late", async () => {
  const transport = abortIgnoringFetch();
  const clock = fakeTimers();
  const updates: WindowLoad[] = [];
  const reader = createWindowedReader({ label: "agent runtime", onUpdate: (load) => updates.push(load), fetchImpl: transport.fetchImpl, setTimer: clock.setTimer, clearTimer: clock.clearTimer });

  const initial = reader.read("/api/agent-runtime?window=7d", "7d");
  transport.calls[0]!.resolve({ series: "initial-7d" });
  await initial;

  const refresh = reader.read("/api/agent-runtime?window=7d", "7d");
  assert.equal(windowLoadView(reader.load, "7d").loading, false, "a background refresh of displayed data is silent");

  const change = reader.read("/api/agent-runtime?window=30d", "30d");
  assert.equal(transport.calls[1]!.signal.aborted, true, "changing the window aborts the background refresh");
  assert.deepEqual(windowLoadView(reader.load, "30d"), { loading: true, loadingWindow: "30d", showing: "7d", pressed: "7d" }, "the pending 30d read still labels retained 7d data honestly");

  transport.calls[2]!.resolve({ series: "new-30d" });
  await change;
  transport.calls[1]!.resolve({ series: "late-7d" });
  await refresh;

  assert.deepEqual(reader.load, { data: { series: "new-30d" }, window: "30d", error: null, pending: null });
  assert.equal(windowLoadView(reader.load, "30d").showing, "30d");
  assert.equal(updates.at(-1)?.window, "30d", "the late aborted refresh emitted no stale final update");
});
