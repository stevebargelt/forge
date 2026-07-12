// FG-530 — invariant 4 over REAL worktrees (worktree-tier lane).
//
// The matrix lane (fg530-crash-matrix.integration.test.ts) runs with worktree mode
// OFF: preflightWorktreeGate hard-fails on Linux, so no matrix cell can produce a
// task worktree, and invariant 4's worktree half is inert there — its teeth are
// proven only against a hand-seeded fixture. That leaves the thing FG-352's
// no-discard rule actually protects — a REAL git worktree, holding REAL agent work,
// at a REAL kill point — never once exercised.
//
// This lane closes that. Same machinery (fg530-harness.ts: the kill-point registry,
// the crash driver, recoverToFixpoint, the five checkers, the known-failure list) —
// the two lanes cannot drift because there is only one copy of it. What differs is
// the world the cells run in:
//
//   • worktree mode ARMED (FORGE_WORKTREES=1, platform faked to darwin the way every
//     other *.worktree.test.ts suite does — the Linux gate is FG-358, not this ticket),
//   • projectDir is a REAL git repo, and each primary gets a REAL `git worktree`,
//   • the fake container writes REAL work into it through the /project mount:
//     one COMMITTED file on the task branch and one UNCOMMITTED sentinel — the two
//     shapes mergeWorktreeBranch treats differently, and the two an operator loses
//     if a crash discards the tree,
//   • FORGE_WORKTREES_EPHEMERAL is deliberately NOT set. It is the "discardable
//     output" opt-in: with it on, removeWorktreeIfSafe deletes unmerged worktrees by
//     design and every survival assertion below would be vacuous.
//
// Cells are hand-picked, not a cross product: only the kill points whose write
// sequence TOUCHES worktree_path / merge / cleanup can say anything new about a
// worktree, and the other ~50 points are already covered by the matrix. Each cell
// names why it is here in KILLS below.
//
// After every kill: recoverToFixpoint, then the five invariants (the shared
// checkers), and then this lane's own three assertions, which the matrix cannot
// make — the worktree path still exists, the work INSIDE it survives file by file,
// and the task row still points at it. Plus the positive control: a task that
// COMPLETES cleanly still gets its worktree merged and cleaned up, so "survival" is
// not being over-asserted into "forge leaks every worktree".

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Database as DatabaseInstance } from "better-sqlite3";

import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { getTask } from "../store/tasks.js";
import { logEvent } from "../store/events.js";
import { setCrashHookForTest } from "./crash-points.js";
import { runNext, type DockerExecFn } from "./runNext.js";
import { startRun } from "./startRun.js";
import { worktreeBranchName } from "./worktree-lifecycle.js";
import type { Workflow } from "./schema.js";

import {
  WORKTREE_RUNTIME,
  ensureRuntime,
  writeWorkflowYaml,
  makeExec,
  step,
  primaryOf,
  killPoint,
  crashAt,
  resetExitInfoFake,
  strandWithNoRecoverableResult,
  runCrashPhase,
  recoverToFixpoint,
  checkAllInvariants,
  formatViolations,
  partitionKnown,
  worktreeFiles,
  type PersistedWork,
  type Scenario,
} from "./fg530-harness.js";

// ── the world: worktree mode, a real repo, a container that writes real work ───

const COMMITTED_WORK = "agent-work.ts";
const UNCOMMITTED_SENTINEL = "uncommitted-sentinel.txt";

let db: DatabaseInstance;
let prev: DatabaseInstance | null;
const tmpDirs: string[] = [];
const ENV_VARS = [
  "FORGE_WORKTREES",
  "FORGE_NO_WORKTREES",
  "FORGE_WORKTREE_IGNORE_DIRTY",
  "FORGE_WORKTREES_EPHEMERAL",
  "ANTHROPIC_API_KEY",
] as const;
const savedEnv: Partial<Record<(typeof ENV_VARS)[number], string>> = {};
const realPlatform = process.platform;

function setPlatform(p: string): void {
  Object.defineProperty(process, "platform", { value: p, configurable: true });
}

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
  for (const k of ENV_VARS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  process.env["ANTHROPIC_API_KEY"] = "sk-stub";
  // Worktree mode ON. IGNORE_DIRTY because the fixture repo is created fresh per
  // cell and its cleanliness is not what these cells are about. EPHEMERAL stays
  // OFF — see the header.
  process.env["FORGE_WORKTREES"] = "1";
  process.env["FORGE_WORKTREE_IGNORE_DIRTY"] = "1";
  setPlatform("darwin");
  ensureRuntime();
});

afterEach(() => {
  setCrashHookForTest(undefined);
  resetExitInfoFake();
  setPlatform(realPlatform);
  setDbForTest(prev as DatabaseInstance);
  db.close();
  for (const k of ENV_VARS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k] as string;
  }
  for (const dir of tmpDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "forge-fg530-wt-"));
  tmpDirs.push(dir);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@forge.test"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Forge Test"], { cwd: dir, stdio: "ignore" });
  writeFileSync(join(dir, "README.md"), "# fg530 worktree lane\n");
  execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-q", "-m", "initial"], { cwd: dir, stdio: "ignore" });
  return dir;
}

/** The agent's work, written through the container's /project mount — which, in
 *  worktree mode, IS the task's worktree. One committed file (on the task branch,
 *  the shape merge-back fast-forwards) and one uncommitted file (the shape
 *  mergeWorktreeBranch auto-commits as a safety net). Both are work an operator
 *  loses if a crash discards the tree, and neither exists anywhere else. */
const agentWork = ({ projectMountHost }: { projectMountHost: string | undefined }): void => {
  assert.ok(projectMountHost, "the fake container must receive a /project mount — worktree mode is armed");
  const wt = projectMountHost;
  writeFileSync(join(wt, COMMITTED_WORK), "export const work = 1;\n");
  execFileSync("git", ["add", "."], { cwd: wt, stdio: "ignore" });
  execFileSync("git", ["commit", "-q", "-m", "agent output"], { cwd: wt, stdio: "ignore" });
  writeFileSync(join(wt, UNCOMMITTED_SENTINEL), "work the agent had not committed when the host died\n");
};

const PLAIN_WF: Workflow = {
  name: "fg530-wt-plain",
  description: "FG-530 worktree lane: single implementer step, auto gate",
  inputs: [],
  steps: [step("build", { runtime: WORKTREE_RUNTIME })],
};
const PLAIN_YAML = `name: fg530-wt-plain
description: FG-530 worktree plain
inputs: []
steps:
  - id: build
    agent: engineer
    gate: auto
    runtime: ${WORKTREE_RUNTIME}
`;

const RED_WF: Workflow = {
  name: "fg530-wt-red",
  description: "FG-530 worktree lane: implementer step behind an authoritative red",
  inputs: [],
  steps: [
    step("build", {
      runtime: WORKTREE_RUNTIME,
      gate: "verdict",
      reds: [{ agent: "red-security", authority: "authoritative", gate_on_verdict: true }],
    }),
  ],
};
const RED_YAML = `name: fg530-wt-red
description: FG-530 worktree red
inputs: []
steps:
  - id: build
    agent: engineer
    gate: verdict
    runtime: ${WORKTREE_RUNTIME}
    reds:
      - agent: red-security
        authority: authoritative
        gate_on_verdict: true
`;

/** The lockfile hash a real provision plan would carry (mirrors the matrix's
 *  provisioning scenario — reconcile's branch only needs containerName + cacheKey). */
const PROVISION_CACHE_KEY = "fg530-wt-lockfile-hash";

const SCENARIOS: Record<string, Scenario> = {
  // The everyday shape: an implementer whose worktree holds committed AND
  // uncommitted work by the time the host dies.
  plain: {
    name: "plain",
    workflow: PLAIN_WF,
    yaml: PLAIN_YAML,
    exec: { redVerdict: "pass", filesModified: [COMMITTED_WORK], agentWork },
    drive: async (runId, workflow, exec) => {
      await runNext({ runId, workflow, dockerExec: exec });
    },
  },
  // Same worktree, but the agent's result omits tests_run — the FG-523 contract
  // holds the task instead of completing it. A HELD task is not merged-and-done:
  // its worktree must stay.
  "contract-hold": {
    name: "contract-hold",
    workflow: PLAIN_WF,
    yaml: PLAIN_YAML,
    exec: { redVerdict: "pass", primaryFailsContract: true, agentWork },
    drive: async (runId, workflow, exec) => {
      await runNext({ runId, workflow, dockerExec: exec });
    },
  },
  // An authoritative red blocks the primary. NOT force-advanced (the matrix does
  // that): a blocked_by_red task is precisely a task whose worktree is its only
  // copy of the work, and removeWorktreeIfSafe must never be reached for it.
  "red-blocks": {
    name: "red-blocks",
    workflow: RED_WF,
    yaml: RED_YAML,
    exec: { redVerdict: "fail", filesModified: [COMMITTED_WORK], agentWork },
    drive: async (runId, workflow, exec) => {
      await runNext({ runId, workflow, dockerExec: exec });
    },
  },
  // The container-gone sweep's orphaned_work_may_persist landing — the ONE reconcile
  // branch whose evidence IS the worktree (changedWorktreeFiles over t.worktreePath,
  // recorded with source "worktree" rather than the matrix's "project_dir_shared").
  // Reached only with a real dedicated worktree that is really dirty.
  "orphan-dirty-worktree": {
    name: "orphan-dirty-worktree",
    workflow: PLAIN_WF,
    yaml: PLAIN_YAML,
    exec: { redVerdict: "pass", filesModified: [COMMITTED_WORK], agentWork },
    drive: async (runId, workflow, exec) => {
      await runNext({ runId, workflow, dockerExec: exec });
    },
    // Nothing recoverable on disk, but the worktree still holds the agent's
    // uncommitted sentinel — dirty, so reconcile takes the may-persist branch.
    strand: strandWithNoRecoverableResult,
  },
  // FG-437's mid-provisioning landing is the only reconcile branch that CALLS
  // removeWorktreeIfSafe. Crash in the pre-container window (the worktree exists;
  // the agent never ran), then let reconcile land it.
  "provisioning-crash": {
    name: "provisioning-crash",
    workflow: PLAIN_WF,
    yaml: PLAIN_YAML,
    exec: { redVerdict: "pass", filesModified: [COMMITTED_WORK], agentWork },
    drive: async (runId, workflow, exec) => {
      await runNext({ runId, workflow, dockerExec: exec });
    },
    strand: async (sc, runId, exec) => {
      const fired = await crashAt("runContainer:after-mark-running-before-container-launch", () =>
        sc.drive(runId, sc.workflow, exec),
      );
      assert.ok(fired, "the pre-container kill must fire for this strand to build the mid-provisioning shape");
      const t = primaryOf(runId, "build");
      assert.ok(t, "the primary must exist for this strand to mean anything");
      // The provisioner's durable event, which the fake docker layer never writes.
      logEvent("container.provision_started", {
        runId,
        taskId: t.id,
        payload: {
          containerName: `forge-provision-${PROVISION_CACHE_KEY}`,
          cacheKey: PROVISION_CACHE_KEY,
          phase: "dependency_provisioning",
        },
      });
    },
  },
};

// ── the cells ─────────────────────────────────────────────────────────────────
//
// Every kill point below sits in a sequence that touches worktree_path, the
// merge-back, or the cleanup. Nothing else can discard a worktree, which is why
// this lane is ~14 cells rather than the matrix's ~60 points × scenarios.

type Cell = { scenario: keyof typeof SCENARIOS; point: string; why: string };

const KILLS: Cell[] = [
  {
    scenario: "plain",
    point: "runContainer:after-mark-running-before-container-launch",
    why:
      "the worktree is created and setTaskWorktreePath committed BEFORE the container launches. A crash here is the " +
      "first moment a worktree exists at all — the row already points at a tree the agent never touched.",
  },
  {
    scenario: "plain",
    point: "dispatchSingleStep:after-result-ingest",
    why:
      "the PRE-MERGE window, and the sharpest one in the whole lifecycle: the container has written real work into the " +
      "worktree and mergeWorktreeBranch has NOT run, so the worktree is the only copy of it anywhere.",
  },
  {
    scenario: "plain",
    point: "dispatchSingleStep:before-validation-contract",
    why:
      "POST-merge, PRE-finalize: mergeWorktreeBranch has auto-committed and fast-forwarded, but the task is not complete " +
      "and removeWorktreeIfSafe has not been reached. A recovery that tidied up here would delete an unmerged-by-the-row tree.",
  },
  {
    scenario: "plain",
    point: "finalizePrimary:before-status-write",
    why: "merged, about to be marked complete — the last instant the task is non-terminal with a live worktree.",
  },
  {
    scenario: "plain",
    point: "finalizePrimary:between-complete-status-and-event",
    why:
      "the complete status IS written but the process dies before the cleanup call. The task is terminal-complete, so the " +
      "worktree's removal is sanctioned but never happened — recovery must not treat that leftover tree as garbage to " +
      "collect blind (a complete task's tree is merged; a crashed one's is not, and reconcile cannot tell them apart by path).",
  },
  {
    scenario: "contract-hold",
    point: "holdIfValidationContractFails:between-hold-status-and-event",
    why:
      "the FG-523 hold: a task parked for the operator, NOT complete. Its worktree holds the work the operator is being " +
      "asked to judge.",
  },
  {
    scenario: "red-blocks",
    point: "dispatchSingleStep:after-awaiting-red",
    why:
      "the FG-530-A window, now with a real worktree behind it. The step's work is merged (awaiting_red is written after the " +
      "merge) but the reds died with the process, so FG-531's sweep lands the primary failed/orphaned_needs_finalize — a " +
      "recovery the operator resumes with `forge retry --force`. The tree must survive THAT: the retry re-drives the step, " +
      "and the uncommitted half of the agent's work only exists inside it.",
  },
  {
    scenario: "red-blocks",
    point: "dispatchSingleStep:after-blocked-by-red",
    why:
      "a blocked task is the canonical no-discard case: an authoritative red refused it, the merge already happened, and " +
      "cleanup is skipped precisely because the operator may still want the tree.",
  },
  {
    scenario: "plain",
    point: "reconcile:before-fail-pipeline-unfinalized",
    why:
      "reconcile's landing for a crashed pipeline step, crashed itself. The stranded task's worktree (unmerged work inside) " +
      "must survive a recovery pass that dies halfway through.",
  },
  {
    scenario: "plain",
    point: "reconcile:inside-fail-pipeline-unfinalized-txn",
    why: "the same landing, killed INSIDE its transaction — the rollback must not take the worktree with it.",
  },
  {
    scenario: "orphan-dirty-worktree",
    point: "reconcile:before-fail-orphaned-work-may-persist",
    why:
      "the one reconcile branch whose EVIDENCE is the worktree itself: changedWorktreeFiles() over the task's own tree, " +
      "source 'worktree'. The matrix can only ever reach it via the shared project dir.",
  },
  {
    scenario: "orphan-dirty-worktree",
    point: "reconcile:inside-fail-orphaned-work-may-persist-txn",
    why: "same branch, killed inside the transaction that records the may-persist evidence.",
  },
  {
    scenario: "provisioning-crash",
    point: "reconcile:before-fail-provisioning-phase-crash",
    why:
      "the ONLY reconcile callsite that calls removeWorktreeIfSafe (reconcile.ts, the FG-437 landing). It passes " +
      "provenMerged=false, so outside EPHEMERAL mode it must be a no-op — this cell is what proves the guard holds on a " +
      "live tree instead of trusting the flag.",
  },
  {
    scenario: "provisioning-crash",
    point: "reconcile:inside-fail-provisioning-phase-crash-txn",
    why: "the same landing, killed inside its transaction, with the worktree-removal call sitting right after it.",
  },
];

/** This lane's own assertions — the ones the matrix structurally cannot make.
 *  checkAllInvariants already flags a vanished worktree or vanished work inside one
 *  (invariant 4); these add the row-level reference and the branch, so a "surviving"
 *  tree that nothing points at and no branch names — work stranded beyond reach —
 *  still fails. */
function assertWorktreeSurvived(pre: PersistedWork, runId: string, projectDir: string): number {
  let checked = 0;
  for (const w of pre.worktrees) {
    const t = getTask(w.taskId);
    assert.ok(t, `task ${w.taskId} vanished during recovery`);
    if (t.status === "complete") continue; // proven-merged cleanup is the sanctioned removal
    checked += 1;

    assert.ok(
      existsSync(w.worktreePath),
      `INVARIANT 4: the worktree for '${t.status}' task ${w.taskId} is GONE after recovery (${w.worktreePath})`,
    );
    for (const f of w.files) {
      assert.ok(
        existsSync(join(w.worktreePath, f)),
        `INVARIANT 4: '${f}' was in task ${w.taskId}'s worktree at the kill and is GONE after recovery — the tree survived but the work in it did not`,
      );
    }
    assert.equal(
      getTask(w.taskId)!.worktreePath,
      w.worktreePath,
      `INVARIANT 4: task ${w.taskId} no longer REFERENCES its worktree — a tree nothing points at is work the operator cannot find`,
    );
    assert.doesNotThrow(
      () =>
        execFileSync("git", ["rev-parse", "--verify", worktreeBranchName(runId, w.taskId)], {
          cwd: projectDir,
          stdio: "ignore",
        }),
      `INVARIANT 4: the task branch for ${w.taskId} was deleted — the committed half of the agent's work is unreachable`,
    );
  }
  return checked;
}

for (const cell of KILLS) {
  const sc = SCENARIOS[cell.scenario]!;
  test(`FG-530 worktree [${sc.name}] hook armed @ ${cell.point}`, async (t) => {
    writeWorkflowYaml(sc.workflow.name, sc.yaml);
    const projectDir = makeRepo();
    const exec = makeExec(sc.exec);
    const { runId } = startRun({
      workflow: sc.workflow,
      title: `fg530 worktree ${sc.name} @ ${cell.point}`,
      inputs: {},
      projectDir,
    });

    const { fired, persistedPreKill } = await runCrashPhase(sc, runId, exec, killPoint(cell.point));
    assert.ok(
      fired,
      `this lane's cells are hand-picked to be REACHABLE — scenario '${sc.name}' never reached ${cell.point}, so the cell ` +
        `proves nothing. Fix the scenario or drop the cell (unlike the matrix, there are no smoke cells here).`,
    );
    assert.ok(
      persistedPreKill.worktrees.length > 0,
      `no worktree existed at the kill — worktree mode is not actually armed, and this cell would pass vacuously`,
    );
    t.diagnostic(`KILL cell: died at ${cell.point} with ${persistedPreKill.worktrees.length} live worktree(s). ${cell.why}`);

    await recoverToFixpoint(runId, sc.workflow, exec);

    const violations = await checkAllInvariants({
      runId,
      workflow: sc.workflow,
      exec,
      persistedPreKill,
      wasAbandoned: false,
    });
    const { unexpected } = partitionKnown(violations);
    assert.deepEqual(
      unexpected,
      [],
      `crash @ ${cell.point} in worktree scenario '${sc.name}' left the run violating lifecycle invariants:\n${formatViolations(unexpected)}`,
    );

    const checked = assertWorktreeSurvived(persistedPreKill, runId, projectDir);
    t.diagnostic(
      checked > 0
        ? `${checked} non-complete worktree(s) survived recovery with their work and their row reference intact`
        : `every worktree's task completed — survival is not asserted (cleanup is sanctioned); see the positive control`,
    );
  });
}

// ── the positive control ──────────────────────────────────────────────────────
//
// Survival must not be over-asserted into "forge never cleans up". A task that
// completes cleanly has a PROVEN-MERGED worktree, and removing it is the one
// sanctioned removal — if this test ever starts failing because the tree is still
// there, the cells above are vouching for a leak, not for the no-discard rule.

test("FG-530 worktree [positive control]: a task that COMPLETES has its work merged into projectDir and its worktree + branch cleaned up — no-discard is not a licence to leak", async () => {
  writeWorkflowYaml(PLAIN_WF.name, PLAIN_YAML);
  const projectDir = makeRepo();
  const exec = makeExec(SCENARIOS["plain"]!.exec);
  const { runId } = startRun({
    workflow: PLAIN_WF,
    title: "fg530 worktree positive control",
    inputs: {},
    projectDir,
  });

  // No crash at all — the clean, everyday worktree run.
  await runNext({ runId, workflow: PLAIN_WF, dockerExec: exec });

  const primary = primaryOf(runId, "build")!;
  assert.equal(primary.status, "complete", "the clean worktree run must complete");
  const worktreePath = primary.worktreePath;
  assert.ok(worktreePath, "a completed worktree-mode task must have carried a worktree path on its row");

  assert.ok(
    existsSync(join(projectDir, COMMITTED_WORK)),
    "the agent's committed work must have fast-forwarded into projectDir",
  );
  assert.ok(
    existsSync(join(projectDir, UNCOMMITTED_SENTINEL)),
    "and its UNCOMMITTED work too — mergeWorktreeBranch auto-commits the worktree before merging (FG-352's safety net)",
  );
  assert.equal(
    existsSync(worktreePath),
    false,
    "the proven-merged worktree must be REMOVED — a completed task's tree is redundant, and never removing it would leak one per task",
  );
  assert.throws(
    () =>
      execFileSync("git", ["rev-parse", "--verify", worktreeBranchName(runId, primary.id)], {
        cwd: projectDir,
        stdio: "ignore",
      }),
    "and the merged task branch with it",
  );
});

// ── the lane's own integrity: it must be running the world it claims ──────────

test("FG-530 worktree [harness integrity]: the fixture really does produce a git worktree holding BOTH shapes of agent work — a cell that silently ran without one would pass vacuously", async () => {
  writeWorkflowYaml(PLAIN_WF.name, PLAIN_YAML);
  const projectDir = makeRepo();
  const exec = makeExec(SCENARIOS["plain"]!.exec);
  const { runId } = startRun({ workflow: PLAIN_WF, title: "fg530 worktree integrity", inputs: {}, projectDir });

  // Kill at the pre-merge boundary and look at the world the crash left behind.
  const pre = await runCrashPhase(
    SCENARIOS["plain"]!,
    runId,
    exec,
    killPoint("dispatchSingleStep:after-result-ingest"),
  );
  assert.ok(pre.fired, "the kill must fire");

  assert.equal(pre.persistedPreKill.worktrees.length, 1, "exactly the primary's worktree existed at the kill");
  const wt = pre.persistedPreKill.worktrees[0]!;
  assert.deepEqual(
    wt.files.filter((f) => f !== "README.md"),
    [COMMITTED_WORK, UNCOMMITTED_SENTINEL].sort(),
    "the fake container must have written BOTH a committed file and an uncommitted sentinel into the real worktree",
  );
  assert.deepEqual(
    worktreeFiles(wt.worktreePath).filter((f) => f !== "README.md"),
    [COMMITTED_WORK, UNCOMMITTED_SENTINEL].sort(),
    "and they must still be on disk after the kill (the crash driver never touches the filesystem)",
  );

  // The committed half is really on the task branch, not just loose on disk.
  const branch = worktreeBranchName(runId, primaryOf(runId, "build")!.id);
  const listed = execFileSync("git", ["ls-tree", "--name-only", branch], {
    cwd: projectDir,
    encoding: "utf8",
  });
  assert.match(listed, new RegExp(COMMITTED_WORK), "the committed work must exist on the task branch");

  // And it is NOT in projectDir: the pre-merge kill means the worktree is the only
  // place this work lives. That is what makes its survival load-bearing.
  assert.equal(
    existsSync(join(projectDir, COMMITTED_WORK)),
    false,
    "a pre-merge crash must leave the work UNMERGED — if it were already in projectDir, losing the worktree would cost nothing and every cell above would be toothless",
  );
});

test("FG-530 worktree [strand integrity]: the orphan-dirty scenario really leaves reconcile a DIRTY dedicated worktree — the evidence its may-persist branch keys on", async () => {
  const sc = SCENARIOS["orphan-dirty-worktree"]!;
  writeWorkflowYaml(sc.workflow.name, sc.yaml);
  const projectDir = makeRepo();
  const exec = makeExec(sc.exec);
  const { runId } = startRun({ workflow: sc.workflow, title: "fg530 worktree strand", inputs: {}, projectDir });

  await strandWithNoRecoverableResult(sc, runId, exec);

  const t = primaryOf(runId, "build")!;
  assert.equal(t.status, "running", "the strand leaves the task running");
  assert.ok(t.worktreePath, "with a DEDICATED worktree on its row — not the shared project dir");
  const dirty = execFileSync("git", ["status", "--porcelain"], {
    cwd: t.worktreePath,
    encoding: "utf8",
  });
  assert.match(
    dirty,
    new RegExp(UNCOMMITTED_SENTINEL),
    "and that worktree is DIRTY — without this, reconcile takes the plain-orphan branch and the may-persist cells above are testing something else",
  );
});

// ── coverage: the cells this lane claims are the cells it ran ─────────────────

test("FG-530 worktree coverage: every selected kill point is in the shared registry and names why it touches worktree lifecycle", () => {
  for (const cell of KILLS) {
    killPoint(cell.point); // throws if the point is not registered
    assert.ok(cell.why.length > 40, `cell ${cell.scenario} @ ${cell.point} must say WHY it is in this lane`);
    assert.ok(SCENARIOS[cell.scenario], `cell names an unknown scenario: ${cell.scenario}`);
  }
});
