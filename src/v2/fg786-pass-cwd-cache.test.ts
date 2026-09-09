// FG-786 (AC2, library layer): a per-pass memoizing cwd guard ABOVE
// findProcessesHoldingCwd.
//
// A closeout pass gates many workspaces in a row. Before this fix, each gate
// re-enumerated every tmux pane and read (one lsof per pid on darwin, ~0.3s each)
// every candidate pid's cwd — turning an O(pids) liveness question into
// O(pids × workspaces) and stretching one `forge next` closeout to hours while it
// held the run lock. createPassCwdGuard enumerates panes+server ONCE and memoizes each
// pid's cwd read, so across every workspace the pass gates, each candidate pid's cwd is
// read at most once. The verdict semantics are findProcessesHoldingCwd's exactly
// (held:true / "unprobed" / held:false); only the number of probes changes.
//
// These are pure unit tests: a fake TmuxRunner supplies the pids and an injected,
// counting readCwd stands in for procfs/lsof so we can assert the probe count directly.
// The path-identity cases (a live pid holding the path; an extraCwds path-only holder)
// use this test process's own cwd, which provenSameOnly can actually resolve.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPassCwdGuard, type TmuxRunner, type CwdHolderResult } from "./launch.js";

/** A fake tmux answering the two calls enumerateTmuxPids makes: the server pid
 *  (`display-message -p #{pid}`) and the pane list (`list-panes -a -F ...`, format
 *  `#{pane_pid} #{pane_dead} #{session_name}`). */
function fakeTmux(spec: { serverPid?: number; panes: string }): TmuxRunner {
  return (args: string[]) => {
    if (args[0] === "display-message") return String(spec.serverPid ?? 0);
    if (args[0] === "list-panes") return spec.panes;
    return "";
  };
}

const livePane = (pid: number, session = "s") => `${pid} 0 ${session}`;

// FG-786 RF-2: the pass-wide snapshot is correct for the O(pids) negative enumeration, but a
// DESTROY decision must not act on it — a process that chdirs into a workspace, or a pane that
// appears, AFTER the snapshot would be absent from the memoized reads and let a now-held
// workspace be reaped. freshProbeAtDestroy re-proves a held:false with one fresh probe of that
// path before the caller acts. These tests pin BOTH shapes of "changed after the snapshot".

test("FG-786 RF-2: a process that chdirs into a workspace AFTER the snapshot is caught by the destroy-time fresh probe (held:false → retain)", () => {
  const workspace = mkdtempSync(join(tmpdir(), "fg786-rf2-ws-"));
  try {
    const panePid = 4242;
    const tmux = fakeTmux({ serverPid: 100, panes: livePane(panePid) });

    // Baseline (the bug): a snapshot-only guard that saw the pane elsewhere clears the destroy.
    const snapshotOnly = createPassCwdGuard({ tmux, readCwd: (pid) => (pid === panePid ? "/elsewhere/before" : `/x/${pid}`) });
    assert.deepEqual(snapshotOnly(workspace), { held: false }, "the pass snapshot alone sees no holder — the stale verdict that would reap");

    // The fix: readCwd for the pane returns elsewhere on the FIRST (snapshot) read and the
    // workspace on a LATER (fresh destroy-time) read — the process chdir'd in between.
    let paneReads = 0;
    const readCwd = (pid: number): string | undefined => {
      if (pid !== panePid) return `/elsewhere/pid-${pid}`;
      paneReads += 1;
      return paneReads === 1 ? "/elsewhere/before" : workspace;
    };
    const guard = createPassCwdGuard({ tmux, readCwd, freshProbeAtDestroy: true });
    const res = guard(workspace);
    assert.equal(res.held, true, "the fresh destroy-time probe catches the chdir-after-snapshot and forces retain");
    if (res.held === true) assert.equal(res.holders[0]?.pid, panePid);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("FG-786 RF-2: a NEW pane appearing after the snapshot is caught by the destroy-time fresh probe", () => {
  const workspace = mkdtempSync(join(tmpdir(), "fg786-rf2-ws2-"));
  try {
    const newPid = 5150;
    // list-panes: empty at snapshot (construction), the new pane on the fresh re-enumeration.
    let listCalls = 0;
    const tmux: TmuxRunner = (args) => {
      if (args[0] === "display-message") return "100";
      if (args[0] === "list-panes") { listCalls += 1; return listCalls === 1 ? "" : livePane(newPid); }
      return "";
    };
    const readCwd = (pid: number): string | undefined => (pid === newPid ? workspace : `/elsewhere/${pid}`);
    const guard = createPassCwdGuard({ tmux, readCwd, freshProbeAtDestroy: true });
    const res = guard(workspace);
    assert.equal(res.held, true, "a pane that appeared after the snapshot is caught at the destroy chokepoint → retain");
    if (res.held === true) assert.equal(res.holders[0]?.pid, newPid);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("FG-786 RF-2: a held:true / unprobed snapshot needs no second probe (only held:false authorizes a destroy)", () => {
  const workspace = mkdtempSync(join(tmpdir(), "fg786-rf2-ws3-"));
  try {
    // The snapshot already sees the pane holding the workspace → held:true, returned as-is.
    const holderPid = 6161;
    const tmux = fakeTmux({ serverPid: 100, panes: livePane(holderPid) });
    let reads = 0;
    const readCwd = (pid: number): string | undefined => { reads += 1; return pid === holderPid ? workspace : `/elsewhere/${pid}`; };
    const guard = createPassCwdGuard({ tmux, readCwd, freshProbeAtDestroy: true });
    const res = guard(workspace);
    assert.equal(res.held, true, "an already-held workspace is retained from the snapshot");
    const readsAfterHeld = reads;
    // A held:true verdict does not trigger a fresh re-probe — a retain never needs re-proving.
    guard(workspace);
    assert.ok(reads <= readsAfterHeld + 2, "a held workspace is not re-probed with a fresh enumeration on every call");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("one guard probes each unique pid's cwd at most once across M candidate paths (O(pids), not O(pids×paths))", () => {
  const panePids = [101, 102, 103, 104, 105, 106, 107, 108, 109, 110];
  const serverPid = 100;
  const tmux = fakeTmux({ serverPid, panes: panePids.map((p) => livePane(p)).join("\n") });
  const uniquePids = new Set<number>([serverPid, ...panePids]);

  // A counting probe that never matches any candidate path (so every gate is held:false)
  // and records exactly which pids it was asked about and how many times.
  const reads: number[] = [];
  const readCwd = (pid: number): string | undefined => {
    reads.push(pid);
    return `/no-such-holder/pid-${pid}`;
  };

  const guard = createPassCwdGuard({ tmux, readCwd });

  const M = 50;
  for (let i = 0; i < M; i++) {
    const res: CwdHolderResult = guard(`/some/workspace/candidate-${i}`);
    assert.deepEqual(res, { held: false }, "no pid holds the candidate → held:false");
  }

  // Each unique pid was read exactly once for the guard's lifetime, regardless of M.
  assert.equal(reads.length, uniquePids.size, "total probes == unique pid count, independent of M");
  assert.deepEqual(new Set(reads), uniquePids, "every enumerated pid was probed exactly once");
  // No pid appears twice.
  assert.equal(new Set(reads).size, reads.length, "no pid was probed more than once");
});

test("a live holder among the memoized pids is still reported held:true", () => {
  const holderPid = 4242;
  const tmux = fakeTmux({ serverPid: 100, panes: [livePane(holderPid), livePane(777)].join("\n") });

  const here = process.cwd();
  const readCwd = (pid: number): string | undefined => (pid === holderPid ? here : `/elsewhere/pid-${pid}`);

  const guard = createPassCwdGuard({ tmux, readCwd });
  const res = guard(here);

  assert.equal(res.held, true);
  if (res.held === true) {
    assert.equal(res.holders.length, 1);
    assert.equal(res.holders[0]?.pid, holderPid);
    assert.equal(res.holders[0]?.cwd, here);
  }
});

test("extraCwds path-only holders still match via provenSameOnly", () => {
  const tmux = fakeTmux({ serverPid: 100, panes: [livePane(201), livePane(202)].join("\n") });

  // No pid holds the path; the only holder is a recorded launch cwd (pid-less).
  const reads: number[] = [];
  const readCwd = (pid: number): string | undefined => {
    reads.push(pid);
    return `/no-such-holder/pid-${pid}`;
  };

  const here = process.cwd();
  const guard = createPassCwdGuard({
    tmux,
    readCwd,
    extraCwds: [{ cwd: here, description: "open launch launch-abc" }],
  });

  const res = guard(here);
  assert.equal(res.held, true);
  if (res.held === true) {
    assert.equal(res.holders.length, 1);
    assert.equal(res.holders[0]?.pid, -1, "path-only holder carries the pid-less sentinel");
    assert.equal(res.holders[0]?.description, "open launch launch-abc");
  }
});

test("extraCwds are folded through on EVERY call, not just the first", () => {
  const tmux = fakeTmux({ serverPid: 100, panes: livePane(301) });
  const here = process.cwd();
  const guard = createPassCwdGuard({
    tmux,
    readCwd: (pid) => `/no-such-holder/pid-${pid}`,
    extraCwds: [{ cwd: here, description: "open launch launch-xyz" }],
  });

  // First a non-matching path (held:false), then the matching extraCwds path — the
  // extraCwds holder must still be consulted on the second call.
  assert.deepEqual(guard("/unrelated/path"), { held: false });
  const res = guard(here);
  assert.equal(res.held, true);
});

test("extraPids are folded through and probed via the same memo", () => {
  const extraPid = 9001;
  const tmux = fakeTmux({ serverPid: 100, panes: livePane(401) });
  const here = process.cwd();

  const reads: number[] = [];
  const readCwd = (pid: number): string | undefined => {
    reads.push(pid);
    return pid === extraPid ? here : `/no-such-holder/pid-${pid}`;
  };

  const guard = createPassCwdGuard({
    tmux,
    readCwd,
    extraPids: [{ pid: extraPid, description: `container pid ${extraPid}` }],
  });

  // First call: the extra pid holds `here`.
  const res1 = guard(here);
  assert.equal(res1.held, true);
  if (res1.held === true) assert.equal(res1.holders[0]?.pid, extraPid);

  // Second call for a different path: the memo means no pid (incl. the extra) is re-read.
  const before = reads.length;
  guard("/unrelated/path");
  assert.equal(reads.length, before, "memo covers extraPids too — no pid re-read across calls");
});

test('an unreadable candidate pid makes the pass guard "unprobed" (fail closed), and stays memoized', () => {
  const badPid = 505;
  const tmux = fakeTmux({ serverPid: 100, panes: [livePane(badPid), livePane(506)].join("\n") });

  const reads: number[] = [];
  const readCwd = (pid: number): string | undefined => {
    reads.push(pid);
    return pid === badPid ? undefined : `/no-such-holder/pid-${pid}`;
  };

  const guard = createPassCwdGuard({ tmux, readCwd });

  const res = guard("/some/candidate");
  assert.equal(res.held, "unprobed", "an unreadable live pid forces retain — honesty preserved");

  // A proven-undefined read is cached too: a second gate does not re-spawn the probe.
  const before = reads.length;
  guard("/another/candidate");
  assert.equal(reads.length, before, "undefined reads are memoized — no re-probe of an unreadable pid");
});
