// FG-590: the filesystem-authoritative launch sweep, driven by an injected clock and an
// injected tmux so terminality, retention boundaries, the never-touch-running invariant,
// the tmux-probe-only-on-no-exit-record property, and crash convergence are all provable
// without a real tmux server.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LAUNCHES_DIR, sweepTerminalLaunches, type TmuxRunner } from "./launch.js";
import type { RetentionPolicy } from "./retention-policy.js";

function resetLaunches(): void {
  rmSync(LAUNCHES_DIR, { recursive: true, force: true });
  mkdirSync(LAUNCHES_DIR, { recursive: true });
}

/** Create a launch dir. `exit` writes the terminal exit record; omit it for a
 *  no-exit-record launch whose terminality is decided by the tmux probe. */
function makeLaunch(id: string, opts: { exit?: { code: number | null; signal: string | null } } = {}): void {
  const dir = join(LAUNCHES_DIR, id);
  mkdirSync(dir, { recursive: true });
  const meta = {
    id,
    command: ["echo", "hi"],
    tmuxSession: `forge-${id}`,
    launcherPid: 999999, // a pid that is not this process and (almost certainly) dead
    ownerPid: null,
    startedAt: "2026-01-01T00:00:00.000Z",
    logPath: join(dir, "out.log"),
    cwd: "/tmp",
  };
  writeFileSync(join(dir, "meta.json"), JSON.stringify(meta));
  if (opts.exit) writeFileSync(join(dir, "exit"), JSON.stringify(opts.exit));
}

/** A fake tmux. `running` → has-session ok + pane alive (readLaunch: running). `deadPane`
 *  → has-session ok + pane dead (readLaunch: owner_gone). Anything else → has-session
 *  throws (readLaunch: unknown). `counter` counts EVERY tmux invocation. */
function fakeTmux(sets: { running?: Set<string>; deadPane?: Set<string> } = {}, counter?: { n: number }): TmuxRunner {
  const running = sets.running ?? new Set<string>();
  const deadPane = sets.deadPane ?? new Set<string>();
  return (args: string[]) => {
    if (counter) counter.n++;
    const cmd = args[0];
    if (cmd === "-V") return "tmux 3.4";
    const tIdx = args.indexOf("-t");
    const rawT = tIdx >= 0 ? String(args[tIdx + 1] ?? "") : "";
    const sess = rawT.replace(/:$/, "");
    const alive = running.has(sess) || deadPane.has(sess);
    if (cmd === "has-session") {
      if (alive) return "";
      throw new Error("no such session");
    }
    if (cmd === "display-message") {
      if (args.includes("#{pane_dead}")) return deadPane.has(sess) ? "1" : "0";
      if (args.includes("#{pane_pid}")) return "12345";
      return "";
    }
    if (cmd === "kill-session") {
      running.delete(sess);
      deadPane.delete(sess);
      return "";
    }
    return "";
  };
}

const POLICY: RetentionPolicy = { success: 1000, failureAmbiguous: 100_000 };
const T0 = 1_000_000_000_000;

test("FG-590 sweep: a successful launch is retired promptly, only AFTER its success window", () => {
  resetLaunches();
  makeLaunch("launch-ok-1", { exit: { code: 0, signal: null } });
  const tmux = fakeTmux();

  // First observation anchors the marker; age is 0, so it is retained.
  let r = sweepTerminalLaunches(POLICY, { now: new Date(T0), tmux });
  assert.deepEqual(r.retained, ["launch-ok-1"]);
  assert.deepEqual(r.removed, []);
  assert.ok(existsSync(join(LAUNCHES_DIR, "launch-ok-1")));

  // Still within the window: retained.
  r = sweepTerminalLaunches(POLICY, { now: new Date(T0 + 1000), tmux });
  assert.deepEqual(r.retained, ["launch-ok-1"]);

  // Past the success window: removed through the removeLaunch chokepoint.
  r = sweepTerminalLaunches(POLICY, { now: new Date(T0 + 1001), tmux });
  assert.deepEqual(r.removed, ["launch-ok-1"]);
  assert.ok(!existsSync(join(LAUNCHES_DIR, "launch-ok-1")));
});

test("FG-590 sweep: an owner-gone / unknown launch is kept through its diagnostic window, then retired", () => {
  resetLaunches();
  // owner_gone: live session + dead pane, no exit record.
  makeLaunch("launch-gone-1");
  // unknown: no session, no exit record.
  makeLaunch("launch-unknown-1");
  const tmux = fakeTmux({ deadPane: new Set(["forge-launch-gone-1"]) });

  // Anchored; both are failure/ambiguous and within the (large) window → retained.
  let r = sweepTerminalLaunches(POLICY, { now: new Date(T0), tmux });
  assert.deepEqual(r.retained.sort(), ["launch-gone-1", "launch-unknown-1"]);
  assert.deepEqual(r.removed, []);

  // Halfway through the failure window: still retained (deliberately inspectable).
  r = sweepTerminalLaunches(POLICY, { now: new Date(T0 + 50_000), tmux });
  assert.deepEqual(r.removed, []);
  assert.equal(r.retained.length, 2);

  // Past the failure window: both retired.
  r = sweepTerminalLaunches(POLICY, { now: new Date(T0 + 100_001), tmux });
  assert.deepEqual(r.removed.sort(), ["launch-gone-1", "launch-unknown-1"]);
  assert.ok(!existsSync(join(LAUNCHES_DIR, "launch-gone-1")));
  assert.ok(!existsSync(join(LAUNCHES_DIR, "launch-unknown-1")));
});

test("FG-590 sweep: a running launch is NEVER removed, even far past every window", () => {
  resetLaunches();
  makeLaunch("launch-live-1"); // no exit record; live session → running
  const tmux = fakeTmux({ running: new Set(["forge-launch-live-1"]) });

  const r = sweepTerminalLaunches(POLICY, { now: new Date(T0 + 10_000_000), tmux });
  assert.deepEqual(r.skippedRunning, ["launch-live-1"]);
  assert.deepEqual(r.removed, []);
  assert.equal(r.scanned, 0); // a running launch is not a terminal candidate
  assert.ok(existsSync(join(LAUNCHES_DIR, "launch-live-1")));
});

test("FG-590 sweep: tmux probes are spent ONLY on no-exit-record candidates", () => {
  resetLaunches();
  makeLaunch("launch-rec-1", { exit: { code: 0, signal: null } });
  makeLaunch("launch-rec-2", { exit: { code: 3, signal: null } });

  // All within retention (age 0 at anchor) so removeLaunch is not called — the only tmux
  // calls that could happen are classification probes, and an exit record needs none.
  const counterA = { n: 0 };
  sweepTerminalLaunches(POLICY, { now: new Date(T0), tmux: fakeTmux({}, counterA) });
  assert.equal(counterA.n, 0, "exit-record launches must cost zero tmux probes");

  resetLaunches();
  makeLaunch("launch-rec-3", { exit: { code: 0, signal: null } });
  makeLaunch("launch-norec-1"); // no exit record → must be probed
  const counterB = { n: 0 };
  sweepTerminalLaunches(POLICY, { now: new Date(T0), tmux: fakeTmux({}, counterB) });
  assert.ok(counterB.n > 0, "a no-exit-record launch must be probed");
});

test("FG-590 sweep: a second pass does not rescan already-anchored history (marker cheap path)", () => {
  resetLaunches();
  makeLaunch("launch-norec-2"); // no exit record — pass 1 probes it and anchors a marker
  const counter = { n: 0 };
  const tmux = fakeTmux({}, counter);

  sweepTerminalLaunches(POLICY, { now: new Date(T0), tmux });
  const afterFirst = counter.n;
  assert.ok(afterFirst > 0);

  // Pass 2, still within retention: the marker short-circuits reclassification, so no new
  // tmux probe is spent on it.
  sweepTerminalLaunches(POLICY, { now: new Date(T0 + 1), tmux });
  assert.equal(counter.n, afterFirst, "an already-anchored launch is not re-probed");
});

test("FG-590 sweep: crash between kill-session and rmSync converges from disk truth", () => {
  resetLaunches();
  // Simulate the post-kill, pre-rmSync remains: the launch dir still holds meta + a
  // terminal exit record + an anchored marker, but the tmux session is already gone.
  makeLaunch("launch-crash-1", { exit: { code: 0, signal: null } });
  writeFileSync(
    join(LAUNCHES_DIR, "launch-crash-1", "terminal.json"),
    JSON.stringify({ terminalAt: new Date(T0).toISOString(), state: "exited_ok", cls: "success" }),
  );
  const tmux = fakeTmux(); // no live session — kill-session was already done

  const r = sweepTerminalLaunches(POLICY, { now: new Date(T0 + 5000), tmux });
  assert.deepEqual(r.removed, ["launch-crash-1"]);
  assert.ok(!existsSync(join(LAUNCHES_DIR, "launch-crash-1")));
});
