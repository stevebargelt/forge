// FG-552: the blocking completion primitive (`waitForLaunchTerminal`) and the
// reader-honesty + atomic-record properties it depends on. The wait loop is
// driven through an INJECTED harness so every disposition — including the two
// reconciled-only ones with no filesystem artifact — is exercised
// deterministically, without real timers or fs.watch.

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  LAUNCHES_DIR,
  isTerminalStatus,
  readLaunch,
  startLaunch,
  waitForLaunchTerminal,
  type LaunchStatus,
  type LaunchView,
  type TmuxRunner,
  type WaitHarness,
} from "./launch.js";

beforeEach(() => {
  rmSync(LAUNCHES_DIR, { recursive: true, force: true });
});

function tmuxStub(): { tmux: TmuxRunner; alive: Set<string>; deadPanes: Set<string> } {
  const alive = new Set<string>();
  const deadPanes = new Set<string>();
  const tmux: TmuxRunner = (args) => {
    if (args[0] === "has-session") {
      if (!alive.has(args[2]!)) throw new Error("no such session");
    }
    if (args[0] === "new-session") alive.add(args[args.indexOf("-s") + 1]!);
    if (args[0] === "kill-session") alive.delete(args[args.indexOf("-t") + 1]!);
    if (args[0] === "display-message") {
      const target = args[args.indexOf("-t") + 1]!.replace(/:$/, "");
      if (args.includes("#{pane_dead}")) return deadPanes.has(target) ? "1\n" : "0\n";
      return "4242\n";
    }
  };
  return { tmux, alive, deadPanes };
}

/** A fully controllable harness: the test drives fs events, the reconcile tick,
 *  the timeout, and cancellation by hand. `reconcileEnabled: false` models a
 *  WATCH-ONLY design (F34 negative). */
function fakeHarness(view: LaunchView | undefined, opts: { reconcileEnabled?: boolean } = {}) {
  const state = {
    view,
    watcher: undefined as (() => void) | undefined,
    reconcile: undefined as (() => void) | undefined,
    timeout: undefined as (() => void) | undefined,
    cancel: undefined as (() => void) | undefined,
  };
  const harness: WaitHarness = {
    read: () => state.view,
    installWatcher: (cb) => { state.watcher = cb; return () => { state.watcher = undefined; }; },
    startReconcile: (cb) => {
      if (opts.reconcileEnabled === false) return () => {};
      state.reconcile = cb;
      return () => { state.reconcile = undefined; };
    },
    startTimeout: (cb) => { state.timeout = cb; return () => { state.timeout = undefined; }; },
    onCancel: (cb) => { state.cancel = cb; return () => { state.cancel = undefined; }; },
  };
  return { harness, state };
}

function runningView(overrides: Partial<LaunchView> = {}): LaunchView {
  return {
    id: "launch-x-abc123",
    command: ["forge", "next"],
    tmuxSession: "forge-launch-x-abc123",
    launcherPid: 1,
    ownerPid: 2,
    startedAt: "2026-07-19T00:00:00.000Z",
    logPath: "/tmp/out.log",
    cwd: "/tmp",
    status: { state: "running" },
    forgeIds: { runIds: [], taskIds: [] },
    ...overrides,
  };
}

test("FG-552 isTerminalStatus: every state except running is terminal", () => {
  const states: LaunchStatus[] = [
    { state: "exited_ok", code: 0 },
    { state: "exited_error", code: 1 },
    { state: "signaled", signal: "SIGTERM", sender: "unrecorded" },
    { state: "terminated_unattributed", code: 143 },
    { state: "owner_gone", cause: "unrecorded", sender: "unrecorded" },
    { state: "unknown" },
  ];
  for (const s of states) assert.equal(isTerminalStatus(s), true, s.state);
  assert.equal(isTerminalStatus({ state: "running" }), false);
});

test("FG-552 wait: an unknown launch id refuses DISTINCTLY from a known launch whose status is unknown", async () => {
  const missing = fakeHarness(undefined);
  assert.deepEqual(await waitForLaunchTerminal("launch-nope-000000", missing.harness), {
    kind: "unknown_launch",
    id: "launch-nope-000000",
  });

  const knownUnknown = fakeHarness(runningView({ status: { state: "unknown" } }));
  const o = await waitForLaunchTerminal("launch-x-abc123", knownUnknown.harness);
  assert.equal(o.kind, "terminal");
  assert.deepEqual((o as { view: LaunchView }).view.status, { state: "unknown" });
});

test("FG-552 wait (F5): an already-terminal launch returns immediately, no blocking", async () => {
  const h = fakeHarness(runningView({ status: { state: "exited_ok", code: 0 } }));
  const o = await waitForLaunchTerminal("launch-x-abc123", h.harness);
  assert.equal(o.kind, "terminal");
  assert.deepEqual((o as { view: LaunchView }).view.status, { state: "exited_ok", code: 0 });
  assert.equal(h.state.watcher, undefined, "no watcher installed when already terminal");
});

test("FG-552 wait (BD-6 / F1,F2): a launch that becomes terminal DURING subscription is caught by the immediate reread — no check-then-subscribe gap", async () => {
  const h = fakeHarness(runningView());
  // Installing the watcher flips the record terminal — simulating a launch that
  // finished in the check-then-subscribe window. The immediate reread must catch it.
  const original = h.harness.installWatcher;
  h.harness.installWatcher = (cb) => {
    h.state.view = runningView({ status: { state: "exited_ok", code: 0 } });
    return original(cb);
  };
  const o = await waitForLaunchTerminal("launch-x-abc123", h.harness);
  assert.deepEqual((o as { view: LaunchView }).view.status, { state: "exited_ok", code: 0 });
});

test("FG-552 wait (F6): an fs event on the atomic exit rename unblocks with exited_error — failure is a completion, not still-running", async () => {
  const h = fakeHarness(runningView());
  const p = waitForLaunchTerminal("launch-x-abc123", h.harness);
  h.state.view = runningView({ status: { state: "exited_error", code: 2 } });
  h.state.watcher!(); // the exit-record rename fires the watcher
  const o = await p;
  assert.deepEqual((o as { view: LaunchView }).view.status, { state: "exited_error", code: 2 });
});

test("FG-552 wait (F34): owner_gone is discovered ONLY by the reconcile tick — a watch-only design is OBSERVED FAILING it", async () => {
  // Reconcile-enabled: the tick (no fs event) discovers owner_gone.
  const withReconcile = fakeHarness(runningView());
  const p1 = waitForLaunchTerminal("launch-x-abc123", withReconcile.harness);
  withReconcile.state.view = runningView({ status: { state: "owner_gone", cause: "unrecorded", sender: "unrecorded" } });
  assert.ok(withReconcile.state.reconcile, "reconcile installed");
  withReconcile.state.reconcile!();
  assert.equal((await p1).kind, "terminal");

  // Watch-only: no reconcile installed. owner_gone produces NO fs event, so the
  // watcher never fires and the disposition is never observed — the wait only ends
  // via its timeout. This is the structural failure F34 pins.
  const watchOnly = fakeHarness(runningView(), { reconcileEnabled: false });
  const p2 = waitForLaunchTerminal("launch-x-abc123", watchOnly.harness);
  watchOnly.state.view = runningView({ status: { state: "owner_gone", cause: "unrecorded", sender: "unrecorded" } });
  assert.equal(watchOnly.state.reconcile, undefined, "watch-only: no reconcile tick exists");
  // The only way this wait can end is the timeout — it never observes owner_gone.
  watchOnly.state.timeout!();
  const o2 = await p2;
  assert.equal(o2.kind, "wait_timeout", "watch-only design cannot observe owner_gone — times out instead");
});

test("FG-552 wait (F10 / OQ-5): unknown is a reconciled disposition too — observed via the tick, carrying the safe default", async () => {
  const h = fakeHarness(runningView());
  const p = waitForLaunchTerminal("launch-x-abc123", h.harness);
  h.state.view = runningView({ status: { state: "unknown" } });
  h.state.reconcile!();
  const o = await p;
  assert.deepEqual((o as { view: LaunchView }).view.status, { state: "unknown" });
});

test("FG-552 wait: a timeout is an explicit wait_timeout — NEVER a fabricated launch terminal state", async () => {
  const h = fakeHarness(runningView());
  const p = waitForLaunchTerminal("launch-x-abc123", h.harness);
  h.state.timeout!();
  const o = await p;
  assert.equal(o.kind, "wait_timeout");
  assert.deepEqual((o as { lastObserved: LaunchStatus }).lastObserved, { state: "running" });
});

test("FG-552 wait (OQ-4): cancelling the waiter yields wait_cancelled — and the harness never touches the tmux work", async () => {
  const h = fakeHarness(runningView());
  const p = waitForLaunchTerminal("launch-x-abc123", h.harness);
  h.state.cancel!();
  const o = await p;
  assert.equal(o.kind, "wait_cancelled");
  assert.deepEqual((o as { lastObserved: LaunchStatus }).lastObserved, { state: "running" });
});

test("FG-552 wait: EXACTLY ONE observation even when the watcher and reconcile race to terminal", async () => {
  const h = fakeHarness(runningView());
  let settledCount = 0;
  const p = waitForLaunchTerminal("launch-x-abc123", h.harness).then((o) => { settledCount++; return o; });
  // Capture the callbacks before settling — settle() runs teardown that detaches
  // them from state, so re-invoking the captured refs proves the settled-guard,
  // not just that teardown detached them.
  const reconcileCb = h.state.reconcile!;
  const timeoutCb = h.state.timeout!;
  h.state.view = runningView({ status: { state: "exited_ok", code: 0 } });
  h.state.watcher!();
  reconcileCb(); // second signal after already terminal — must be ignored
  timeoutCb();   // and the timeout — must be ignored
  await p;
  assert.equal(settledCount, 1, "the promise resolves exactly once");
});

// ── Reader honesty + atomic records (the properties the wait depends on) ──

test("FG-552 reader (F11): an EMPTY exit record with a live session reads RUNNING — bounded retry, NOT terminal unknown", () => {
  const { tmux } = tmuxStub();
  const meta = startLaunch(["sleep", "600"], { name: "empty", tmux });
  writeFileSync(join(LAUNCHES_DIR, meta.id, "exit"), ""); // the atomic-write window / a torn record
  assert.deepEqual(readLaunch(meta.id, tmux)!.status, { state: "running" },
    "an empty exit file is an invitation to retry while the owner is alive — not a terminal disposition");
});

test("FG-552 reader (F11): an UNPARSEABLE exit record with a live session reads RUNNING, never a terminal state", () => {
  const { tmux } = tmuxStub();
  const meta = startLaunch(["sleep", "600"], { name: "garbage", tmux });
  writeFileSync(join(LAUNCHES_DIR, meta.id, "exit"), "{not json"); // half-written JSON
  assert.deepEqual(readLaunch(meta.id, tmux)!.status, { state: "running" });
});

test("FG-552 reader: an empty exit record with NO live session is unknown — reached via INDEPENDENT terminal evidence, not the empty file", () => {
  const stub = tmuxStub();
  const meta = startLaunch(["sleep", "600"], { name: "emptygone", tmux: stub.tmux });
  writeFileSync(join(LAUNCHES_DIR, meta.id, "exit"), "");
  stub.alive.clear(); // owner gone (reboot) — the independent evidence
  assert.deepEqual(readLaunch(meta.id, stub.tmux)!.status, { state: "unknown" });
});

test("FG-552 reader: a PARSEABLE exit record is still authoritative — reader honesty does not weaken the happy path", () => {
  const { tmux } = tmuxStub();
  const meta = startLaunch(["true"], { name: "ok", tmux });
  writeFileSync(join(LAUNCHES_DIR, meta.id, "exit"), `{"code":0,"signal":null}`);
  assert.deepEqual(readLaunch(meta.id, tmux)!.status, { state: "exited_ok", code: 0 });
});

test("FG-552 (tmux): degraded/absent tmux is a NAMED observation input, not a crash — a launch with no exit record classifies as unknown when liveness cannot be confirmed", () => {
  // A tmux that cannot answer ANY query (absent/wedged binary): every call throws.
  const absentTmux: TmuxRunner = () => { throw new Error("tmux: command not found"); };
  const { tmux: real } = tmuxStub();
  const meta = startLaunch(["sleep", "600"], { name: "notmux", tmux: real });

  // Reading back with an absent tmux must not throw; liveness is unconfirmable, so
  // the honest classification is unknown — never a crash, never a guessed terminal.
  const view = readLaunch(meta.id, absentTmux);
  assert.ok(view, "the record still reads");
  assert.deepEqual(view!.status, { state: "unknown" });
});

test("FG-552 meta (F32): startLaunch publishes meta.json atomically — no .tmp remnant, and the record is complete and parseable", () => {
  const { tmux } = tmuxStub();
  const meta = startLaunch(["forge", "next"], { name: "atomic", tmux });
  const dir = join(LAUNCHES_DIR, meta.id);
  const entries = readdirSync(dir);
  assert.ok(!entries.some((e) => e.includes(".tmp")), `no temp file left behind: ${entries.join(",")}`);
  assert.ok(existsSync(join(dir, "meta.json")));
  const parsed = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")) as LaunchView;
  assert.equal(parsed.ownerPid, 4242, "the single published record carries the owner pid (no null-then-rewrite window)");
  assert.deepEqual(readLaunch(meta.id, tmux)!.status, { state: "running" });
});
