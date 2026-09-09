// FG-786 (AC1): dead tmux panes must never poison the cwd-holder gate.
//
// A pane left by remain-on-exit reports `#{pane_dead}`==1 and has NO live process:
// its pid is gone, so readProcCwd() returns undefined and — before this fix — every
// dead pane forced findProcessesHoldingCwd() to `unprobed`. On a host with 1306 dead
// panes vs 2 live, that made EVERY workspace gate ambiguous and retention never
// converged. A dead pane is a PROVEN negative (no live process can hold a cwd on its
// behalf), so it must be dropped at the enumeration boundary and never reach the probe.
//
// These are pure unit tests over a fake TmuxRunner. The one place we need a genuinely
// live, readable pid is the "a live pane holds the path" case: we use this test
// process's own pid + cwd, whose working directory readProcCwd can actually read
// (Linux procfs / darwin lsof), so the guard reports a real holder.

import { test } from "node:test";
import assert from "node:assert/strict";
import { findProcessesHoldingCwd, type TmuxRunner } from "./launch.js";

/** A fake tmux that answers the two calls enumerateTmuxPids makes:
 *  `display-message -p #{pid}` (the server pid) and `list-panes -a -F ...` (panes).
 *  `serverError` (if set) is thrown as the stderr of a failed display-message so we
 *  can exercise the proven-negative "no server running" arm without a real server. */
function fakeTmux(spec: { serverError?: string; serverPid?: number; panes: string }): TmuxRunner {
  return (args: string[]) => {
    if (args[0] === "display-message") {
      if (spec.serverError !== undefined) {
        const e = new Error("display-message failed") as Error & { stderr?: string };
        e.stderr = spec.serverError;
        throw e;
      }
      return String(spec.serverPid ?? 0);
    }
    if (args[0] === "list-panes") return spec.panes;
    return "";
  };
}

// The format enumerateTmuxPids now asks for: `#{pane_pid} #{pane_dead} #{session_name}`.
const deadPane = (pid: number, session = "dead") => `${pid} 1 ${session}`;
const livePane = (pid: number, session = "live") => `${pid} 0 ${session}`;

test("FG-786 AC1: 1000 dead panes + live panes, no live holder → held:false (NOT unprobed)", () => {
  // A candidate path this process is NOT sitting in, so the live panes (this process's
  // own pid, readable) do not match and do not force unprobed either.
  const candidate = "/definitely/not/a/real/holder/path/fg786";
  const deadLines = Array.from({ length: 1000 }, (_, i) => deadPane(900000 + i));
  // Two LIVE panes whose pid is genuinely readable (this test process) but whose cwd
  // is NOT the candidate — they must resolve cleanly to "not a holder", not unprobed.
  const liveLines = [livePane(process.pid, "a"), livePane(process.pid, "b")];
  const tmux = fakeTmux({
    serverError: "no server running on /tmp/tmux-501/default",
    panes: [...deadLines, ...liveLines].join("\n"),
  });

  const result = findProcessesHoldingCwd(candidate, { tmux });
  // Before the fix, the 1000 dead pids each fail readProcCwd → held:"unprobed".
  assert.deepEqual(result, { held: false });
});

test("FG-786 AC1: a dead pane whose (bogus) pid is unreadable never contributes to unprobed", () => {
  const candidate = "/definitely/not/a/real/holder/path/fg786";
  // ONLY dead panes with bogus pids + a proven-negative server. If dead panes were
  // still probed, every one would be unprobed; excluded, the whole result is held:false.
  const tmux = fakeTmux({
    serverError: "no server running on /tmp/tmux-501/default",
    panes: [deadPane(4000001), deadPane(4000002), deadPane(4000003)].join("\n"),
  });

  const result = findProcessesHoldingCwd(candidate, { tmux });
  assert.deepEqual(result, { held: false });
});

test("FG-786 AC1: a LIVE pane whose pid holds the candidate path → held:true", () => {
  // This test process's own cwd IS the candidate, and its pid is a live pane.
  const candidate = process.cwd();
  const tmux = fakeTmux({
    serverError: "no server running on /tmp/tmux-501/default",
    // Dead panes present too — they must not change the verdict.
    panes: [deadPane(900001), deadPane(900002), livePane(process.pid, "holder")].join("\n"),
  });

  const result = findProcessesHoldingCwd(candidate, { tmux });
  assert.equal(result.held, true);
  if (result.held === true) {
    assert.ok(result.holders.length >= 1, "at least one holder reported");
    assert.ok(
      result.holders.some((h) => h.pid === process.pid),
      "the live pane pid is named as a holder",
    );
  }
});

test("FG-786 AC1: a genuinely-unreadable LIVE pid is STILL honestly unprobed (honesty boundary preserved)", () => {
  const candidate = "/definitely/not/a/real/holder/path/fg786";
  // A LIVE pane (dead=="0") whose pid does not exist → readProcCwd fails → the
  // guard MUST report unprobed. The dead-pane fix removes the false-positive from
  // DEAD panes only; a live-but-unreadable pid stays unprobed (fail closed: retain).
  const tmux = fakeTmux({
    serverError: "no server running on /tmp/tmux-501/default",
    panes: [livePane(4000099, "ghost")].join("\n"),
  });

  const result = findProcessesHoldingCwd(candidate, { tmux });
  assert.equal(result.held, "unprobed");
});

test("FG-786 AC1: legacy 2-field format lines degrade to the existing unprobed rules", () => {
  const candidate = "/definitely/not/a/real/holder/path/fg786";
  // A legacy `#{pane_pid} #{session_name}` line: the second field ("legacysess") is
  // not "1", so the pid stays a candidate and is probed like before. A bogus legacy
  // pid is therefore unprobed exactly as it was pre-fix — no silent drop.
  const tmux = fakeTmux({
    serverError: "no server running on /tmp/tmux-501/default",
    panes: ["4000123 legacysess"].join("\n"),
  });

  const result = findProcessesHoldingCwd(candidate, { tmux });
  assert.equal(result.held, "unprobed");
});
