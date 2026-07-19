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
  realWaitHarness,
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
    invalidBound: undefined as (() => void) | undefined,
    invalidBoundArms: 0,
    invalidBoundDisarms: 0,
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
    startInvalidBound: (cb) => {
      state.invalidBound = cb;
      state.invalidBoundArms++;
      return () => { state.invalidBound = undefined; state.invalidBoundDisarms++; };
    },
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

test("FG-552 wait (F3): a committed exit-record fs event that is LOST is still recovered from the durable record by the reconcile tick", async () => {
  const h = fakeHarness(runningView());
  const p = waitForLaunchTerminal("launch-x-abc123", h.harness);
  // The wrapper committed its atomic exit record (exited_error 2), but the
  // fs.watch event for the rename is LOST — dropped or coalesced by the OS, so the
  // watcher callback is NEVER invoked. F3's recovery contract: reconciliation
  // re-reads the durable record and unblocks anyway. We prove it by firing ONLY
  // the reconcile tick, never the watcher.
  h.state.view = runningView({ status: { state: "exited_error", code: 2 } });
  assert.ok(h.state.reconcile, "reconcile installed");
  h.state.reconcile!();
  const o = await p;
  assert.equal(o.kind, "terminal");
  assert.deepEqual((o as { view: LaunchView }).view.status, { state: "exited_error", code: 2 },
    "an ordinary exit record whose watcher event was missed is recovered from the durable record");
});

test("FG-552 wait (F7, classifier fast-path): GIVEN a committed WIFSIGNALED exit record, readLaunch classifies `signaled` and the already-terminal wait returns it with an UNRECORDED sender", async () => {
  // This is the CLASSIFIER/fast-path level of F7: given a record that already
  // carries the kernel's WIFSIGNALED verdict (code null, signal SIGKILL), readLaunch
  // classifies it `signaled` and the already-terminal fast path returns it through
  // waitForLaunchTerminal. It does NOT exercise the production signal-recording path
  // — no process is OS-signalled and the recorder never runs here. The OS-signalled
  // END-TO-END path (real kill of the tmux-owned workload → recorder atomically
  // commits the kernel result → wait unblocks) is covered by the F7 real test in
  // launch-wait.integration.test.ts.
  const { tmux } = tmuxStub();
  const meta = startLaunch(["sleep", "600"], { name: "signalled", tmux });
  writeFileSync(join(LAUNCHES_DIR, meta.id, "exit"), `{"code":null,"signal":"SIGKILL"}`);
  const o = await waitForLaunchTerminal(meta.id, realWaitHarness(meta.id, { tmux }));
  assert.equal(o.kind, "terminal");
  assert.deepEqual((o as { view: LaunchView }).view.status,
    { state: "signaled", signal: "SIGKILL", sender: "unrecorded" },
    "the controller wakes with the signal and the sender explicitly unrecorded — never inferred");
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

// ── BD-7: a PERSISTENTLY unreadable/invalid record wakes on a BOUND, never blocks
//    forever; a TRANSIENT one clears within the bound and classifies normally (F11).

function unreadableRunningView(terminal: LaunchStatus): LaunchView {
  return runningView({ status: { state: "running" }, pendingUnreadableExit: { terminal } });
}

test("FG-552 wait (BD-7 / 1b): a persistently-invalid record with a LIVE owner wakes on the BOUND as a terminal completion — NOT blocked forever, and independent of --timeout", async () => {
  // A live owner + present-but-unreadable exit record: readLaunch reads `running`
  // (F11 single-read) but surfaces the reconciled disposition (unknown, 1b). The
  // ordinary reconcile tick keeps seeing `running` — pre-BD-7 that blocked forever
  // with no --timeout. The bound is what wakes it.
  const h = fakeHarness(unreadableRunningView({ state: "unknown" }));
  const p = waitForLaunchTerminal("launch-x-abc123", h.harness);
  assert.equal(h.state.invalidBoundArms, 1, "the persistently-unreadable record armed the bound");

  // The reconcile tick alone never terminals it — the record is still unreadable.
  h.state.reconcile!();
  // Only the bound firing wakes the waiter, on the reconciled terminal disposition.
  h.state.invalidBound!();
  const o = await p;
  assert.equal(o.kind, "terminal");
  assert.deepEqual((o as { view: LaunchView }).view.status, { state: "unknown" },
    "a persistently-invalid record with a live owner wakes as terminal unknown (BD-7)");
});

test("FG-552 wait (BD-7 / 1a): a persistently-invalid record whose OWNER is GONE wakes on the reconciled owner disposition (owner_gone), never running forever", async () => {
  const h = fakeHarness(unreadableRunningView({ state: "owner_gone", cause: "unrecorded", sender: "unrecorded" }));
  const p = waitForLaunchTerminal("launch-x-abc123", h.harness);
  assert.equal(h.state.invalidBoundArms, 1, "bound armed for the unreadable record");
  h.state.invalidBound!();
  const o = await p;
  assert.equal(o.kind, "terminal");
  assert.deepEqual((o as { view: LaunchView }).view.status, { state: "owner_gone", cause: "unrecorded", sender: "unrecorded" },
    "an unreadable record + gone owner wakes as the reconciled owner disposition (1a)");
});

test("FG-552 wait (BD-7 / F11 transient): an unreadable record that becomes READABLE within the bound classifies NORMALLY — the bound is disarmed, never a premature terminal", async () => {
  // The transient case: the record is unreadable when first observed (bound armed),
  // then the atomic exit record lands and it classifies exited_ok BEFORE the bound
  // fires. The waiter must wake on the TRUE disposition and never on the pending
  // reconciled one — and the bound must be disarmed so a stale fire cannot trip.
  const h = fakeHarness(unreadableRunningView({ state: "unknown" }));
  const p = waitForLaunchTerminal("launch-x-abc123", h.harness);
  assert.equal(h.state.invalidBoundArms, 1, "bound armed while unreadable");

  // The record becomes readable (a real terminal) — a reconcile tick observes it.
  h.state.view = runningView({ status: { state: "exited_ok", code: 0 } });
  h.state.reconcile!();
  const o = await p;
  assert.equal(o.kind, "terminal");
  assert.deepEqual((o as { view: LaunchView }).view.status, { state: "exited_ok", code: 0 },
    "the transient unreadable record classified normally once readable — never the pending disposition");
  assert.ok(h.state.invalidBoundDisarms >= 1, "the bound was disarmed when the record cleared (F11: no premature terminal)");
});

test("FG-552 wait (BD-7): a genuinely-running launch (no exit file) NEVER arms the invalid bound — only a PRESENT-but-unreadable record does", async () => {
  const h = fakeHarness(runningView()); // no pendingUnreadableExit
  const p = waitForLaunchTerminal("launch-x-abc123", h.harness);
  h.state.reconcile!();
  assert.equal(h.state.invalidBoundArms, 0, "a genuinely-running launch has no unreadable record — the bound never arms");
  // Settle it so the test does not leave a pending wait.
  h.state.view = runningView({ status: { state: "exited_ok", code: 0 } });
  h.state.watcher!();
  assert.equal((await p).kind, "terminal");
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

test("FG-552 reader (BD-7/F11): a SCHEMA-INVALID exit record (parseable JSON, no numeric code and no string signal) with a live session reads RUNNING, not terminal unknown", () => {
  const { tmux } = tmuxStub();
  for (const bad of ["{}", `{"code":"bad"}`, `{"code":null,"signal":null}`, `{"signal":42}`]) {
    const meta = startLaunch(["sleep", "600"], { name: "schemabad", tmux });
    writeFileSync(join(LAUNCHES_DIR, meta.id, "exit"), bad);
    assert.deepEqual(readLaunch(meta.id, tmux)!.status, { state: "running" },
      `${bad} is an invalid record — bounded retry while the owner lives, never terminal unknown on corrupt evidence`);
  }
});

test("FG-552 reader: an ABSENT exit record with NO live session is unknown — reached via INDEPENDENT terminal evidence (no session), never fabricated from a present record", () => {
  const stub = tmuxStub();
  const meta = startLaunch(["sleep", "600"], { name: "absentgone", tmux: stub.tmux });
  // No exit file at all — a host reboot took the tmux server before any record.
  // Only a GENUINELY ABSENT record may fall through to the owner-terminal verdict.
  stub.alive.clear(); // owner gone (reboot) — the independent evidence
  assert.deepEqual(readLaunch(meta.id, stub.tmux)!.status, { state: "unknown" });
});

test("FG-552 reader (F11): a PRESENT but unreadable exit record with NO live session stays RUNNING — bounded retry, NEVER a fabricated owner-terminal verdict", () => {
  // The finding's race: a valid exit record is being committed just as the owner/
  // session ends, and this read transiently fails (empty/half-written/schema-invalid).
  // A file IS there, so the reader must NOT collapse it to unknown/owner_gone after a
  // single reread — it is an invitation to bounded retry. Only a genuinely ABSENT
  // record is terminal here.
  for (const bad of ["", "{not json", "{}", `{"code":null,"signal":null}`]) {
    const stub = tmuxStub();
    const meta = startLaunch(["sleep", "600"], { name: "unreadablegone", tmux: stub.tmux });
    writeFileSync(join(LAUNCHES_DIR, meta.id, "exit"), bad);
    stub.alive.clear(); // owner gone — terminal owner evidence, but a record is present
    assert.deepEqual(readLaunch(meta.id, stub.tmux)!.status, { state: "running" },
      `${JSON.stringify(bad)} is present-but-unreadable — bounded retry even as the owner ends, never terminal`);
  }
});

test("FG-552 reader (F11): a PRESENT but unreadable exit record with a DEAD pane stays RUNNING — never a premature owner_gone", () => {
  const stub = tmuxStub();
  const meta = startLaunch(["sleep", "600"], { name: "unreadabledead", tmux: stub.tmux });
  writeFileSync(join(LAUNCHES_DIR, meta.id, "exit"), "{half-written");
  stub.deadPanes.add(meta.tmuxSession); // owner terminal via a dead pane, record present
  assert.deepEqual(readLaunch(meta.id, stub.tmux)!.status, { state: "running" },
    "a present-but-unreadable record blocks the owner_gone verdict — bounded retry, not terminal");
});

test("FG-552 reader (BD-7): a present-but-unreadable record surfaces the RECONCILED disposition a bounded waiter wakes on — unknown (no session), owner_gone (dead pane), unknown (live owner)", () => {
  // status stays `running` (F11 single-read), but pendingUnreadableExit names the
  // terminal disposition the waiter adopts once its bound is exhausted, so a
  // persistently-invalid record can never block a --timeout 0 wait forever (BD-7).
  // No session (owner gone via reboot) -> unknown (1a).
  {
    const stub = tmuxStub();
    const meta = startLaunch(["sleep", "600"], { name: "bd7-nosession", tmux: stub.tmux });
    writeFileSync(join(LAUNCHES_DIR, meta.id, "exit"), "{}");
    stub.alive.clear();
    const v = readLaunch(meta.id, stub.tmux)!;
    assert.deepEqual(v.status, { state: "running" }, "single read is still bounded-retry running (F11)");
    assert.deepEqual(v.pendingUnreadableExit, { terminal: { state: "unknown" } });
  }
  // Dead pane (owner gone with a live session) -> owner_gone (1a).
  {
    const stub = tmuxStub();
    const meta = startLaunch(["sleep", "600"], { name: "bd7-deadpane", tmux: stub.tmux });
    writeFileSync(join(LAUNCHES_DIR, meta.id, "exit"), "{not json");
    stub.deadPanes.add(meta.tmuxSession);
    const v = readLaunch(meta.id, stub.tmux)!;
    assert.deepEqual(v.status, { state: "running" });
    assert.deepEqual(v.pendingUnreadableExit, { terminal: { state: "owner_gone", cause: "unrecorded", sender: "unrecorded" } });
  }
  // A live, healthy owner -> unknown (1b): a persistently-invalid record with a
  // live owner is still a terminal completion the waiter wakes on after the bound.
  {
    const stub = tmuxStub();
    const meta = startLaunch(["sleep", "600"], { name: "bd7-live", tmux: stub.tmux });
    writeFileSync(join(LAUNCHES_DIR, meta.id, "exit"), `{"code":null,"signal":null}`);
    const v = readLaunch(meta.id, stub.tmux)!;
    assert.deepEqual(v.status, { state: "running" });
    assert.deepEqual(v.pendingUnreadableExit, { terminal: { state: "unknown" } });
  }
});

test("FG-552 reader (BD-7): a genuinely-running launch (NO exit file) surfaces NO pendingUnreadableExit — only a PRESENT-but-unreadable record does", () => {
  const { tmux } = tmuxStub();
  const meta = startLaunch(["sleep", "600"], { name: "bd7-genuine", tmux });
  const v = readLaunch(meta.id, tmux)!;
  assert.deepEqual(v.status, { state: "running" });
  assert.equal(v.pendingUnreadableExit, undefined, "no exit file at all = genuinely running, not a pending unreadable record");
});

test("FG-552 reader: a PARSEABLE exit record is still authoritative — reader honesty does not weaken the happy path", () => {
  const { tmux } = tmuxStub();
  const meta = startLaunch(["true"], { name: "ok", tmux });
  writeFileSync(join(LAUNCHES_DIR, meta.id, "exit"), `{"code":0,"signal":null}`);
  assert.deepEqual(readLaunch(meta.id, tmux)!.status, { state: "exited_ok", code: 0 });
});

test("FG-552 reader (read-atomicity race): a launch that COMPLETES between the exit-existence check and the pane-liveness probe reads its TRUE disposition (exited_ok), NEVER owner_gone", () => {
  // The straddle: at the top of readLaunch the exit record is still absent, so
  // it falls through to owner evidence. The wrapper then completes — writes its
  // atomic exit record and its pane dies — in the window before the pane probe.
  // We land that interleave deterministically by writing the exit record as the
  // SIDE EFFECT of the pane_dead query, and returning "dead". Pre-fix the reader
  // saw "no record + live session + dead pane" and mis-terminaled a launch that
  // exited 0 as owner_gone; post-fix it re-reads the record and classifies it.
  const stub = tmuxStub();
  const meta = startLaunch(["true"], { name: "straddle-gone", tmux: stub.tmux });
  const exitPath = join(LAUNCHES_DIR, meta.id, "exit");
  const tmux: TmuxRunner = (args) => {
    if (args.includes("#{pane_dead}")) {
      writeFileSync(exitPath, `{"code":0,"signal":null}`); // wrapper's last act, mid-read
      return "1\n"; // pane now dead
    }
    return stub.tmux(args);
  };
  assert.deepEqual(readLaunch(meta.id, tmux)!.status, { state: "exited_ok", code: 0 },
    "a completion landing in the read window must yield the true terminal disposition, not owner_gone");
});

test("FG-552 reader (read-atomicity race): a completion landing during the no-session probe reads exited_ok, NEVER unknown", () => {
  // The unknown-path straddle: exit record absent at the top, then the session
  // ends (reboot/kill) while the wrapper's exit record lands just before. We
  // write the record as the side effect of the has-session probe (which reports
  // the session gone). Pre-fix: no record + no session -> unknown; post-fix the
  // re-read finds the record and classifies exited_ok.
  const stub = tmuxStub();
  const meta = startLaunch(["true"], { name: "straddle-unknown", tmux: stub.tmux });
  const exitPath = join(LAUNCHES_DIR, meta.id, "exit");
  const tmux: TmuxRunner = (args) => {
    if (args[0] === "has-session") {
      writeFileSync(exitPath, `{"code":0,"signal":null}`); // completion lands as the session dies
      throw new Error("no such session"); // session gone
    }
    return stub.tmux(args);
  };
  assert.deepEqual(readLaunch(meta.id, tmux)!.status, { state: "exited_ok", code: 0 },
    "a completion landing in the no-session probe window must not read unknown");
});

test("FG-552 reader: a genuinely dead pane with NO exit record still reads owner_gone — the race fix does not weaken terminal owner evidence", () => {
  // Guard the fix's negative: when the recheck ALSO finds no record, the honest
  // owner_gone verdict must survive (a wrapper truly killed before writing).
  const stub = tmuxStub();
  const meta = startLaunch(["sleep", "600"], { name: "trulygone", tmux: stub.tmux });
  stub.deadPanes.add(meta.tmuxSession);
  assert.deepEqual(readLaunch(meta.id, stub.tmux)!.status,
    { state: "owner_gone", cause: "unrecorded", sender: "unrecorded" });
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
