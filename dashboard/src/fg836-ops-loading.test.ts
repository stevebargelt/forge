// FG-836 part 2: the Ops runtime panel's window as hash state (`#ops?window=<w>`) and the
// per-metric read state machine — loading with the previous data kept, abort on a newer
// window, the client budget, and the "showing <w>" label that names the data's own window.
// The browser suite (browser-tests/fg836-ops-window.test.ts) drives it in a real page.

import assert from "node:assert/strict";
import test from "node:test";
import {
  EMPTY_WINDOW_LOAD,
  OPS_FETCH_BUDGET_MS,
  OPS_SINCES,
  RUNTIME_WINDOWS,
  beginWindowRead,
  createWindowedReader,
  failWindowRead,
  opsSinceHash,
  opsSinceState,
  runtimeWindowHash,
  runtimeWindowState,
  settleWindowRead,
  windowLoadView,
  type WindowLoad,
} from "../client/ops-window-state.js";
import { ROUTES, parseHash } from "../client/view-routing.js";

const SCOPE = { project: "forge", checkout: null };

test("the route table owns every non-default runtime window; 7d is the omitted default", () => {
  assert.deepEqual(RUNTIME_WINDOWS, ["1d", "7d", "30d", "90d", "all"]);
  assert.deepEqual(ROUTES.ops?.params, ["since", "window"]);
  assert.deepEqual(ROUTES.ops?.paramValues?.window, RUNTIME_WINDOWS.filter((w) => w !== "7d"));
  assert.equal(runtimeWindowState(null), "7d");
  assert.equal(runtimeWindowState({}), "7d");
});

test("the hash round-trips every window, keeps the scope and omits the default", () => {
  for (const w of RUNTIME_WINDOWS) {
    const hash = runtimeWindowHash(SCOPE, w);
    assert.equal(hash, w === "7d" ? "#ops?project=forge" : `#ops?project=forge&window=${w}`);
    const parsed = parseHash(hash);
    assert.equal(parsed.view, "ops");
    assert.equal(parsed.rewrite, false, `${hash} is canonical`);
    assert.equal(runtimeWindowState(parsed.params), w, `${hash} restores its window`);
  }
  assert.equal(runtimeWindowHash({ project: null, checkout: null }, "30d"), "#ops?window=30d");
});

test("an unknown or explicit-default window falls back to 7d silently and drops from the canonical hash", () => {
  for (const [hash, canonical] of [
    ["#ops?window=bogus", "#ops"],
    ["#ops?window=7d", "#ops"],
    ["#ops?project=forge&window=365d", "#ops?project=forge"],
    ["#ops?window=", "#ops"],
  ] as const) {
    const parsed = parseHash(hash);
    assert.equal(parsed.canonical, canonical, hash);
    assert.equal(parsed.notice, null, `${hash} falls back without a notice`);
    assert.equal(runtimeWindowState(parsed.params), "7d");
  }
});

test("a window change keeps the previous data and labels it by its own window until the new read settles", () => {
  const settled = settleWindowRead("7d", { n: 7 });
  assert.deepEqual(windowLoadView(settled, "7d"), { loading: false, loadingWindow: null, showing: "7d", pressed: "7d" });

  const pending = beginWindowRead(settled, "30d");
  assert.deepEqual(pending.data, { n: 7 }, "the previous series stays");
  assert.equal(pending.window, "7d");
  assert.deepEqual(windowLoadView(pending, "30d"), { loading: true, loadingWindow: "30d", showing: "7d", pressed: "7d" },
    "loading 30d, still showing 7d — the control never claims 30d before 30d's data is on screen");

  const done = settleWindowRead("30d", { n: 30 });
  assert.deepEqual(windowLoadView(done, "30d"), { loading: false, loadingWindow: null, showing: "30d", pressed: "30d" });
});

test("a background refresh of the window on screen is not a loading state; a first load is", () => {
  const refresh = beginWindowRead(settleWindowRead("30d", { n: 1 }), "30d");
  assert.equal(windowLoadView(refresh, "30d").loading, false);
  const first = beginWindowRead(EMPTY_WINDOW_LOAD, "90d");
  assert.deepEqual(windowLoadView(first, "90d"), { loading: true, loadingWindow: "90d", showing: null, pressed: "90d" });
});

test("a failure keeps the data it failed to replace and names the failed window; a later read for another window clears it", () => {
  const failed = failWindowRead(beginWindowRead(settleWindowRead("7d", { n: 7 }), "30d"), "30d", "agent runtime unavailable — HTTP 500");
  assert.deepEqual(failed, { data: { n: 7 }, window: "7d", error: { window: "30d", reason: "agent runtime unavailable — HTTP 500" }, pending: null });
  assert.equal(windowLoadView(failed, "30d").showing, "7d");
  assert.equal(beginWindowRead(failed, "30d").error?.window, "30d", "a retry of the failed window keeps its reason on screen");
  assert.equal(beginWindowRead(failed, "90d").error, null, "another window's failure is not attributed to this read");
});

// A fetch the test resolves (or rejects) by hand, honouring the abort signal like the real one.
function controllableFetch() {
  const calls: Array<{ url: string; signal: AbortSignal; resolve: (body: unknown, status?: number) => void }> = [];
  const fetchImpl = (url: string, init: { signal: AbortSignal }) => new Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>((resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")));
    calls.push({ url, signal: init.signal, resolve: (body, status = 200) => resolve({ ok: status < 400, status, json: async () => body }) });
  });
  return { calls, fetchImpl };
}

function fakeTimers() {
  const timers = new Map<number, () => void>();
  let next = 0;
  return {
    timers,
    setTimer: (fn: () => void) => { next += 1; timers.set(next, fn); return next; },
    clearTimer: (id: number) => { timers.delete(id); },
    fireAll: () => { for (const [id, fn] of [...timers]) { timers.delete(id); fn(); } },
  };
}

const flush = () => new Promise((r) => setImmediate(r));

test("the reader: a newer window aborts the in-flight read, which never writes; the newer one settles", async () => {
  const { calls, fetchImpl } = controllableFetch();
  const clock = fakeTimers();
  const updates: WindowLoad[] = [];
  const reader = createWindowedReader({ label: "agent runtime", onUpdate: (l) => updates.push(l), fetchImpl, setTimer: clock.setTimer, clearTimer: clock.clearTimer });

  const first = reader.read("/api/agent-runtime?window=7d", "7d");
  calls[0]!.resolve({ n: 7 });
  await first;
  assert.deepEqual(reader.load, { data: { n: 7 }, window: "7d", error: null, pending: null });

  const slow = reader.read("/api/agent-runtime?window=90d", "90d");
  assert.equal(reader.load.pending, "90d");
  assert.deepEqual(reader.load.data, { n: 7 }, "the previous data is kept while 90d is in flight");
  const fast = reader.read("/api/agent-runtime?window=1d", "1d");
  assert.equal(calls[1]!.signal.aborted, true, "the 90d read is aborted when the window changes again");
  assert.equal(calls[2]!.signal.aborted, false);
  calls[2]!.resolve({ n: 1 });
  await Promise.all([slow, fast]);
  assert.deepEqual(reader.load, { data: { n: 1 }, window: "1d", error: null, pending: null });
  assert.equal(updates.some((u) => u.error !== null), false, "an aborted read reports nothing — it was superseded, not failed");
  assert.equal(clock.timers.size, 0, "every settled read clears its budget timer");
});

test("the reader: a read past the client budget is aborted and says so, keeping the previous data", async () => {
  const { calls, fetchImpl } = controllableFetch();
  const clock = fakeTimers();
  const reader = createWindowedReader({ label: "agent runtime", onUpdate: () => {}, fetchImpl, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  const first = reader.read("/a?window=7d", "7d");
  calls[0]!.resolve({ n: 7 });
  await first;

  const slow = reader.read("/a?window=30d", "30d");
  clock.fireAll();
  await slow;
  assert.equal(calls[1]!.signal.aborted, true);
  assert.equal(OPS_FETCH_BUDGET_MS, 10_000);
  assert.deepEqual(reader.load, {
    data: { n: 7 },
    window: "7d",
    error: { window: "30d", reason: "agent runtime for 30d did not answer within 10s — the read was cancelled" },
    pending: null,
  });
});

test("the reader: HTTP and network failures are reported with their reason, never a silent freeze", async () => {
  const clock = fakeTimers();
  const http = controllableFetch();
  const reader = createWindowedReader({ label: "completed runs", onUpdate: () => {}, fetchImpl: http.fetchImpl, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  const r = reader.read("/c?window=30d", "30d");
  http.calls[0]!.resolve(null, 503);
  await r;
  assert.deepEqual(reader.load, { data: null, window: null, error: { window: "30d", reason: "completed runs unavailable — HTTP 503" }, pending: null });

  const down = createWindowedReader({
    label: "agent runtime",
    onUpdate: () => {},
    fetchImpl: async () => { throw new TypeError("Failed to fetch"); },
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  await down.read("/a", "1d");
  assert.equal(down.load.error?.reason, "agent runtime unavailable — Failed to fetch");
  assert.equal(clock.timers.size, 0);
});

test("the reader: reset (a scope change) aborts the in-flight read and drops the data; the late response never writes", async () => {
  const { calls, fetchImpl } = controllableFetch();
  const clock = fakeTimers();
  const updates: WindowLoad[] = [];
  const reader = createWindowedReader({ label: "agent runtime", onUpdate: (l) => updates.push(l), fetchImpl, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  const first = reader.read("/a?window=7d", "7d");
  calls[0]!.resolve({ n: 7 });
  await first;
  const leaving = reader.read("/a?window=7d&projectKey=old", "7d");
  reader.reset();
  assert.equal(calls[1]!.signal.aborted, true);
  await leaving;
  await flush();
  assert.deepEqual(reader.load, EMPTY_WINDOW_LOAD);
  assert.deepEqual(updates.at(-1), EMPTY_WINDOW_LOAD);
});

test("the route table owns every non-default summary since; 7d is the omitted default", () => {
  assert.deepEqual(OPS_SINCES, ["7d", "30d", "all"]);
  assert.deepEqual(ROUTES.ops?.paramValues?.since, OPS_SINCES.filter((w) => w !== "7d"));
  assert.equal(opsSinceState(null), "7d");
  assert.equal(opsSinceState({ window: "30d" }), "7d", "the runtime window is not the summary's since");
  for (const [hash, canonical] of [
    ["#ops?since=fortnight", "#ops"],
    ["#ops?since=7d", "#ops"],
    ["#ops?since=90d&window=90d", "#ops?window=90d"],
    ["#ops?since=", "#ops"],
  ] as const) {
    const parsed = parseHash(hash);
    assert.equal(parsed.canonical, canonical, hash);
    assert.equal(parsed.notice, null, `${hash} falls back without a notice`);
    assert.equal(opsSinceState(parsed.params), "7d");
  }
});

test("since and window round-trip together: each control's hash keeps the other's value", () => {
  for (const since of OPS_SINCES) {
    for (const window of RUNTIME_WINDOWS) {
      const expected = [since !== "7d" ? `since=${since}` : null, window !== "7d" ? `window=${window}` : null].filter(Boolean);
      const canonical = `#ops?${["project=forge", ...expected].join("&")}`;
      for (const hash of [opsSinceHash(SCOPE, since, window), runtimeWindowHash(SCOPE, window, since)]) {
        assert.equal(hash, canonical);
        const parsed = parseHash(hash);
        assert.equal(parsed.rewrite, false, `${hash} is canonical`);
        assert.equal(opsSinceState(parsed.params), since, `${hash} restores its since`);
        assert.equal(runtimeWindowState(parsed.params), window, `${hash} restores its window`);
      }
    }
  }
  assert.equal(opsSinceHash({ project: null, checkout: null }, "all"), "#ops?since=all", "the runtime window defaults to 7d, omitted");
  assert.equal(parseHash("#ops?window=1d&since=30d").canonical, "#ops?since=30d&window=1d", "the canonical order is fixed");
});

test("a summary since change keeps the previous summary, labelled by its own window, until the new read settles", async () => {
  const { calls, fetchImpl } = controllableFetch();
  const clock = fakeTimers();
  const reader = createWindowedReader({ label: "ops summary", onUpdate: () => {}, fetchImpl, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  const first = reader.read("/api/ops?since=7d", "7d");
  calls[0]!.resolve({ terminal: 12 });
  await first;
  assert.deepEqual(windowLoadView(reader.load, "7d"), { loading: false, loadingWindow: null, showing: "7d", pressed: "7d" });

  const slow = reader.read("/api/ops?since=30d", "30d");
  assert.deepEqual(windowLoadView(reader.load, "30d"), { loading: true, loadingWindow: "30d", showing: "7d", pressed: "7d" },
    "loading 30d, still showing 7d — identical numbers across windows can no longer look like a no-op");
  assert.deepEqual(reader.load.data, { terminal: 12 });
  const again = reader.read("/api/ops?since=all", "all");
  assert.equal(calls[1]!.signal.aborted, true, "a further change aborts the 30d read");
  calls[2]!.resolve(null, 500);
  await Promise.all([slow, again]);
  assert.deepEqual(reader.load, { data: { terminal: 12 }, window: "7d", error: { window: "all", reason: "ops summary unavailable — HTTP 500" }, pending: null });
  assert.equal(windowLoadView(reader.load, "all").showing, "7d");
});
