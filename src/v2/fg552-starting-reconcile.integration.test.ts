// FG-552 (launcher-crash-mid-startup): the `starting` flag added by e7cbe90 must be
// BOUNDED to an independently-observable transition — the SUBMITTING launcher's pid —
// not suppress owner reconciliation unconditionally.
//
// The round-1 fix set `starting` on the pre-owner publication window so a launch whose
// tmux session does not exist yet is not misread as terminal `unknown` (F32). But if
// the launcher process is killed/crashes AFTER respawn-pane succeeds but BEFORE the
// second publish clears `starting`, a wrapper/pane that then dies before writing `exit`
// leaves a durable `starting:true` record. An UNCONDITIONAL `starting ⇒ running` reports
// that orphan as `running` FOREVER — no tmux session, no exit — and `forge launch wait`
// can only hit its `--timeout`.
//
// These drive the REAL reader (readLaunch over real files) and the REAL harness
// (realWaitHarness). Crosses the real fs → integration tier.

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  LAUNCHES_DIR,
  readLaunch,
  realWaitHarness,
  startLaunch,
  waitForLaunchTerminal,
  type LaunchView,
  type TmuxRunner,
} from "./launch.js";

/** A tmux stub whose `alive`/`deadPanes` are toggled by hand so readLaunch classifies
 *  a real launch dir deterministically without a real tmux server. */
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

// A deterministically-dead pid: kill(2**31-1, 0) throws ESRCH on Linux/macOS, so the
// REAL launcherAlive helper (process.kill) treats it as dead — no injection needed.
const DEAD_PID = 2 ** 31 - 1;

/** Rewrite meta.json into the durable crash-mid-startup shape: `starting:true` with a
 *  chosen launcher pid, everything else as startLaunch published it. */
function stampStarting(dir: string, meta: object, launcherPid: number): void {
  writeFileSync(join(dir, "meta.json"), JSON.stringify({ ...meta, starting: true, launcherPid }));
}

beforeEach(() => {
  rmSync(LAUNCHES_DIR, { recursive: true, force: true });
});

test("FG-552 launcher-crash-mid-startup: a durable starting:true record whose launcher is DEAD, with NO live session and NO exit record, reconciles to terminal `unknown` — readLaunch does NOT report running forever, and the bounded waiter WAKES (not a timeout)", async () => {
  const stub = tmuxStub();
  const meta = startLaunch(["sh", "-c", "sleep 600"], { name: "crash", tmux: stub.tmux });
  const dir = join(LAUNCHES_DIR, meta.id);
  // The launcher submitted, respawn-pane/second-publish never completed → the record
  // is durably `starting`. The launcher process is gone (DEAD_PID drives the REAL
  // launcherAlive → ESRCH) and no tmux session stayed up.
  stampStarting(dir, meta, DEAD_PID);
  stub.alive.clear(); // no live session

  // (a) the real reader RECONCILES to a terminal disposition — the round-1 bug reported
  //     `running` here forever.
  const v = readLaunch(meta.id, stub.tmux);
  assert.equal(v?.status.state, "unknown", "dead launcher + no session + no exit ⇒ terminal `unknown`, NOT running-forever");

  // (b) the bounded waiter WAKES on the reconciled terminal disposition — it does not
  //     merely hit `--timeout`. A short 5s safety timeout proves boundedness: a hang
  //     would surface as wait_timeout well after the reconcile tick already fired.
  const started = Date.now();
  const harness = realWaitHarness(meta.id, { tmux: stub.tmux, reconcileMs: 20, timeoutMs: 5000 });
  const o = await waitForLaunchTerminal(meta.id, harness);
  const elapsed = Date.now() - started;
  assert.equal(o.kind, "terminal", "the waiter WAKES on the reconciled terminal disposition, not the timeout");
  assert.deepEqual((o as { view: LaunchView }).view.status, { state: "unknown" });
  assert.ok(elapsed < 5000, `bounded — woke in ${elapsed}ms, NOT on the 5s safety timeout`);
});

test("FG-552 launcher-crash-mid-startup: dead launcher, session live but pane DEAD, no exit → owner_gone (bounded-reconcile terminal), NOT running forever", () => {
  const stub = tmuxStub();
  const meta = startLaunch(["sh", "-c", "sleep 600"], { name: "deadpane", tmux: stub.tmux });
  const dir = join(LAUNCHES_DIR, meta.id);
  stampStarting(dir, meta, DEAD_PID);
  stub.deadPanes.add(meta.tmuxSession); // the pane died before writing `exit`; session lingers
  const v = readLaunch(meta.id, stub.tmux);
  assert.equal(v?.status.state, "owner_gone", "a dead launcher + dead pane reconciles to owner_gone, not running");
});

test("FG-552 regression guard (do NOT reopen round 1): a starting:true record whose launcher is ALIVE with NO session yet STAYS running, never terminal — readLaunch reads running and the bounded waiter stays blocked (times out with a `running` last-observation)", async () => {
  const stub = tmuxStub();
  const meta = startLaunch(["sh", "-c", "sleep 600"], { name: "alive", tmux: stub.tmux });
  const dir = join(LAUNCHES_DIR, meta.id);
  // Launcher still alive (this test process's own pid) and the session has not come up
  // yet (the exact pre-respawn-pane F32 window) → must stay running, never terminal.
  stampStarting(dir, meta, process.pid);
  stub.alive.clear();

  const v = readLaunch(meta.id, stub.tmux);
  assert.equal(v?.status.state, "running", "alive launcher mid-startup stays running — the round-1 F32 fix is preserved");

  // The waiter must NOT fabricate a terminal for a genuinely-starting launch: with a
  // live launcher it stays blocked and only the (short) waiter timeout ends it.
  const harness = realWaitHarness(meta.id, { tmux: stub.tmux, reconcileMs: 30, timeoutMs: 300 });
  const o = await waitForLaunchTerminal(meta.id, harness);
  assert.equal(o.kind, "wait_timeout", "an alive-launcher starting record never terminals — the wait ends only on its own timeout");
  assert.equal((o as { lastObserved: { state: string } }).lastObserved.state, "running");
});

test("FG-552: a stale starting:true record whose launcher is DEAD but whose tmux session is LIVE (the command is genuinely running) reads `running` — real owner evidence wins over the stale `starting` marker", () => {
  const stub = tmuxStub();
  const meta = startLaunch(["sh", "-c", "sleep 600"], { name: "livesession", tmux: stub.tmux });
  const dir = join(LAUNCHES_DIR, meta.id);
  stampStarting(dir, meta, DEAD_PID);
  // startLaunch left the session in `alive` and the pane is not dead — a real live owner.
  const v = readLaunch(meta.id, stub.tmux);
  assert.equal(v?.status.state, "running", "a live session means the work is genuinely running — not a crashed-launcher orphan");
});
