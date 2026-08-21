// FG-677 (b): the active-process cwd reverse-lookup guard, incl. the 2026-08-05
// tmux-server-cwd falsification case (a workspace clean by every content proof but held
// as a live process's working directory must be RETAINED, holder named).
//
// The guard reads REAL process cwds via readProcCwd (procfs on Linux / lsof on darwin), so
// these tests probe THIS test process — whose pid holds process.cwd() — as the live holder,
// and inject a fake TmuxRunner so no real tmux server is required.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findProcessesHoldingCwd, describeCwdHolders, type TmuxRunner } from "./launch.js";

/** A tmux that reports NO server — the proven-negative branch (holds nothing). */
const noServerTmux: TmuxRunner = () => {
  const e = new Error("no server running") as Error & { stderr: string };
  e.stderr = "no server running on /tmp/x";
  throw e;
};

/** A tmux whose display-message/list-panes fail for an UNKNOWN reason — unprobed. */
const brokenTmux: TmuxRunner = () => {
  const e = new Error("tmux: command not found") as Error & { stderr: string };
  e.stderr = "tmux: command not found";
  throw e;
};

test("FG-677 cwd guard: a live process holding the path as its cwd is DETECTED (held), holder named", () => {
  const holderCwd = process.cwd();
  const result = findProcessesHoldingCwd(holderCwd, {
    tmux: noServerTmux,
    extraPids: [{ pid: process.pid, description: `this test process pid ${process.pid}` }],
  });
  assert.equal(result.held, true);
  if (result.held === true) {
    assert.ok(result.holders.some((h) => h.pid === process.pid), "the holding pid is named");
    assert.match(describeCwdHolders(result), new RegExp(`pid ${process.pid}`));
  }
});

test("FG-677 cwd guard: FALSIFICATION CASE — a tmux server holding the path bricks nothing because the guard RETAINS it", () => {
  // Reproduce the 2026-08-05 incident: the long-lived tmux server's cwd IS the deletion
  // candidate. The fake tmux reports THIS process's pid as the server pid (this process's
  // cwd is a real, readable holder), so the guard must return held with the server named —
  // the workspace is retained, not deleted, so the server is never bricked.
  const serverHeldDir = process.cwd();
  const tmux: TmuxRunner = (args) => {
    if (args[0] === "display-message" && args.includes("#{pid}")) return String(process.pid);
    if (args[0] === "list-panes") return ""; // no panes
    throw new Error("unexpected tmux call");
  };
  const result = findProcessesHoldingCwd(serverHeldDir, { tmux });
  assert.equal(result.held, true);
  if (result.held === true) {
    assert.ok(result.holders.some((h) => h.description.startsWith("tmux server")), "the tmux server is named as the holder");
  }
});

test("FG-677 cwd guard: a path NO live process holds returns held:false (safe to proceed)", () => {
  const unheld = mkdtempSync(join(tmpdir(), "fg677-unheld-"));
  try {
    const result = findProcessesHoldingCwd(unheld, {
      tmux: noServerTmux,
      extraPids: [{ pid: process.pid, description: `this test process pid ${process.pid}` }],
    });
    assert.equal(result.held, false);
  } finally {
    rmSync(unheld, { recursive: true, force: true });
  }
});

test("FG-677 cwd guard: an UNPROBEABLE tmux forces RETAIN (unprobed), never a guess", () => {
  const unheld = mkdtempSync(join(tmpdir(), "fg677-unprobed-"));
  try {
    const result = findProcessesHoldingCwd(unheld, { tmux: brokenTmux });
    assert.equal(result.held, "unprobed");
    if (result.held === "unprobed") assert.ok(result.reason.length > 0);
  } finally {
    rmSync(unheld, { recursive: true, force: true });
  }
});

test("FG-677 cwd guard: an extraCwds holder (a live launch's recorded cwd) matches by path identity", () => {
  const dir = process.cwd();
  const result = findProcessesHoldingCwd(dir, {
    tmux: noServerTmux,
    extraCwds: [{ cwd: dir, description: "open launch launch-abc" }],
  });
  assert.equal(result.held, true);
  if (result.held === true) {
    assert.ok(result.holders.some((h) => h.description === "open launch launch-abc"));
  }
});

test("FG-677 cwd guard: a vanished extraCwds path never manufactures a match (provenSameOnly refuses)", () => {
  const gone = join(tmpdir(), "fg677-gone-does-not-exist-xyz");
  const result = findProcessesHoldingCwd(gone, {
    tmux: noServerTmux,
    extraCwds: [{ cwd: gone, description: "open launch stale" }],
  });
  // Both sides are the same string but neither resolves — provenSameOnly is false, so no
  // holder. With no unprobed candidate either, the answer is a clean held:false.
  assert.equal(result.held, false);
});
