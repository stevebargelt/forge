// FG-530 — crash-point simulator: kill-injection over the finalize path,
// reconcile to fixpoint, assert the lifecycle invariants.
//
// Forge's crash-safety story was proven piecemeal: each historical wedge got its
// own regression test AFTER it happened live. This is the systematic version.
// For every (scenario × kill point) cell:
//
//   1. arm the crash hook at ONE named write boundary (src/v2/crash-points.ts),
//   2. drive the real runner (startRun → runNext → gate) over a fake docker layer.
//      If the scenario reaches that boundary the hook throws mid-sequence — a
//      process death, not a caught error: nothing after the kill point writes.
//      If it does NOT, the drive runs to its natural end and the cell degenerates
//      to a SMOKE case over a clean run (see below),
//   3. in a FRESH pass with the hook disarmed, run reconcileRun + runNext
//      repeatedly until FIXPOINT (no state change between passes; capped),
//   4. assert the five lifecycle invariants over the post-recovery DB state.
//
// A cell is NOT a promise that its scenario dies at its kill point. No scenario
// reaches every write boundary (a plain auto-gate run never touches a reject
// window), so the cross product is deliberately ragged: each cell is a KILL cell
// where its scenario reaches the armed boundary and a non-kill SMOKE cell where it
// does not — and the invariants must hold either way, so the smoke cells still
// assert something real. Each cell reports which it was via t.diagnostic.
//
// The per-point kill guarantee lives in two whole-registry tests, NOT in the cell
// titles: the coverage test at the bottom of this file fails unless every registered
// kill point actually fired in at least one matrix cell, and the invariant-3 cancel
// race runs each kill point in the first scenario that reaches it, throwing by name
// when none does. A probe that nothing can kill at is therefore loud, not silent.
//
// The kill-point axis is the coverage; the scenario set is deliberately small.
// Kill points sit BETWEEN adjacent writes in a sequence (that's where a crash
// bites), including INSIDE the transactions FG-427/FG-482/FG-463 introduced —
// a kill there must roll the whole group back, which is exactly the property
// those tickets bought and which nothing was proving directly.
//
// Invariants are NAMED checker functions so a failure reads as an invariant
// name, not assertion soup. They reuse the production predicates
// (computeReadyQueue, verdictBlocksGate, evaluateValidationContract,
// retryPolicy, isPhasePrimaryRow) rather than re-deriving lifecycle semantics —
// a checker that disagreed with the runner would prove nothing.
//
// META-AC (the last two tests): the harness's detection power is proven against
// the OLD pre-FG-427/FG-482 blocked_by_red two-write dance, seeded as a
// hand-written DB fixture. The checkers must FLAG it. Green passes alone would
// only prove the harness is quiet.
//
// The MACHINERY (kill-point registry, crash driver, fixpoint loop, invariant
// checkers, known-failure list) lives in ./fg530-harness.ts, shared with the
// worktree-tier lane (fg530-crash-worktree.worktree.test.ts) so the two lanes
// cannot drift. What stays here is this lane's own scenario set and its cells.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Database as DatabaseInstance } from "better-sqlite3";

import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { insertTask, tasksForRun, getTask, setTaskStatus, setTaskWorktreePath } from "../store/tasks.js";
import { insertVerdict, verdictsForRun, verdictsForTask } from "../store/verdicts.js";
import { eventsForRun, eventsForTask, logEvent } from "../store/events.js";
import { getRun, updateRunStatus } from "../store/runs.js";
import { taskDir } from "../util/paths.js";
import { newTaskId, newVerdictId, nowIso } from "../util/ids.js";

import { setCrashHookForTest } from "./crash-points.js";
import { runNext, type DockerExecFn } from "./runNext.js";
import { startRun } from "./startRun.js";
import { gate } from "./gate.js";
import type { Workflow } from "./schema.js";
import type { Task, TaskStatus } from "../types/index.js";

import {
  KILL_POINTS,
  FIRED,
  RUNTIME,
  PI_RUNTIME,
  ensureRuntime,
  writeWorkflowYaml,
  makeExec,
  step,
  primaryOf,
  awaitingGatePrimary,
  crashAt,
  reconcile,
  resetExitInfoFake,
  strandMidFinalize,
  strandWithNoRecoverableResult,
  dirtyWorkPath,
  runCrashPhase,
  snapshot,
  snapshotKey,
  recoverToFixpoint,
  recoveryPass,
  FIXPOINT_CAP,
  capturePersistedWork,
  checkNoCompleteWithoutEvidence,
  checkNoPermanentWedge,
  checkAbandonedNeverOverwritten,
  checkPersistedWorkNeverDiscarded,
  checkFixpointIdempotent,
  checkAllInvariants,
  formatViolations,
  partitionKnown,
  KNOWN_FAILURES,
  KNOWN_HIT,
  type ExitInfoFake,
  type KillPoint,
  type PersistedWork,
  type Scenario,
} from "./fg530-harness.js";

// Imported for the harness-detection suite (fg530-harness-detection.integration.test.ts),
// which lifts these names out of THIS module's scope. Referenced here so the
// bindings exist and a refactor that drops one fails loudly rather than silently
// weakening that verification.
void checkAbandonedNeverOverwritten;
void checkFixpointIdempotent;
void FIXPOINT_CAP;
void recoveryPass;

// ── test bed ──────────────────────────────────────────────────────────────────

let db: DatabaseInstance;
let prev: DatabaseInstance | null;
const tmpDirs: string[] = [];
let savedApiKey: string | undefined;

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
  savedApiKey = process.env["ANTHROPIC_API_KEY"];
  process.env["ANTHROPIC_API_KEY"] = "sk-stub";
});

afterEach(() => {
  setCrashHookForTest(undefined); // never leak an armed hook into the next test
  resetExitInfoFake();
  setDbForTest(prev as DatabaseInstance);
  db.close();
  if (savedApiKey === undefined) delete process.env["ANTHROPIC_API_KEY"];
  else process.env["ANTHROPIC_API_KEY"] = savedApiKey;
  for (const dir of tmpDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "forge-fg530-"));
  tmpDirs.push(dir);
  writeFileSync(join(dir, ".keep"), ""); // avoid the empty-project-dir mount preflight warning
  return dir;
}

// ── scenarios (v1: deliberately small — the kill-point axis is the coverage) ───

// (1) plain single-step workflow with an implementer primary, auto gate.
const PLAIN_WF: Workflow = {
  name: "fg530-plain",
  description: "FG-530: plain single-step implementer primary",
  inputs: [],
  steps: [step("build")],
};
const PLAIN_YAML = `name: fg530-plain
description: FG-530 plain
inputs: []
steps:
  - id: build
    agent: engineer
    gate: auto
    runtime: ${RUNTIME}
`;

// (2) the same with a red (verdict gate) — reaches the verdict-insert and
//     blocked_by_red write boundaries.
const RED_WF: Workflow = {
  name: "fg530-red",
  description: "FG-530: implementer primary behind an authoritative red",
  inputs: [],
  steps: [
    step("build", {
      gate: "verdict",
      reds: [{ agent: "red-security", authority: "authoritative", gate_on_verdict: true }],
    }),
  ],
};
const RED_YAML = `name: fg530-red
description: FG-530 red
inputs: []
steps:
  - id: build
    agent: engineer
    gate: verdict
    runtime: ${RUNTIME}
    reds:
      - agent: red-security
        authority: authoritative
        gate_on_verdict: true
`;

// (3) gate-reject with on_reject — reaches the reject + recovery-mint boundaries.
const REJECT_WF: Workflow = {
  name: "fg530-reject",
  description: "FG-530: human gate rejected back to build via on_reject",
  inputs: [],
  steps: [
    step("build"),
    step("review", { agent: "reviewer", gate: "human", depends_on: ["build"], on_reject: "build" }),
  ],
};
const REJECT_YAML = `name: fg530-reject
description: FG-530 reject
inputs: []
steps:
  - id: build
    agent: engineer
    gate: auto
    runtime: ${RUNTIME}
  - id: review
    agent: reviewer
    gate: human
    runtime: ${RUNTIME}
    depends_on: [build]
    on_reject: build
`;

// (3b) two human-gated reviews, both with `on_reject: build`. Rejecting the first
//      MINTS the on_reject recovery row in build; rejecting the second DEDUPS onto
//      that live pending row (FG-476) — the only path that reaches gate.ts's
//      existing-recovery write sequence (inputs → parent lineage → event), which
//      the mint-only scenarios never exercised.
const REJECT_DEDUP_WF: Workflow = {
  name: "fg530-reject-dedup",
  description: "FG-530: two human gates rejecting into the same on_reject target",
  inputs: [],
  steps: [
    step("build"),
    step("review1", { agent: "reviewer", gate: "human", depends_on: ["build"], on_reject: "build" }),
    step("review2", { agent: "reviewer", gate: "human", depends_on: ["build"], on_reject: "build" }),
  ],
};
const REJECT_DEDUP_YAML = `name: fg530-reject-dedup
description: FG-530 reject dedup
inputs: []
steps:
  - id: build
    agent: engineer
    gate: auto
    runtime: ${RUNTIME}
  - id: review1
    agent: reviewer
    gate: human
    runtime: ${RUNTIME}
    depends_on: [build]
    on_reject: build
  - id: review2
    agent: reviewer
    gate: human
    runtime: ${RUNTIME}
    depends_on: [build]
    on_reject: build
`;

// (3c) a step declaring TWO authoritative gating reds. Not a matrix scenario —
//      it backs the invariant-1 evidence-chain test below, which needs a REAL
//      runner-written multi-red verdict set (not a hand-seeded one) to prove the
//      per-red check discriminates a complete evidence chain from a partial one.
const TWO_RED_WF: Workflow = {
  name: "fg530-two-reds",
  description: "FG-530: primary behind TWO authoritative gating reds",
  inputs: [],
  steps: [
    step("build", {
      gate: "verdict",
      reds: [
        { agent: "red-security", authority: "authoritative", gate_on_verdict: true },
        { agent: "red-wide", authority: "authoritative", gate_on_verdict: true },
      ],
    }),
  ],
};
const TWO_RED_YAML = `name: fg530-two-reds
description: FG-530 two reds
inputs: []
steps:
  - id: build
    agent: engineer
    gate: verdict
    runtime: ${RUNTIME}
    reds:
      - agent: red-security
        authority: authoritative
        gate_on_verdict: true
      - agent: red-wide
        authority: authoritative
        gate_on_verdict: true
`;

// (4) fanout behind an authoritative red — the ONLY path to gate.ts's blocked-
//     fanout advance branch (FG-353 re-entry): the red blocks the fanout PARENT,
//     the operator force-advances, and gate atomically writes gateForced into the
//     parent's task-package inputs + flips it to pending so dispatchFanoutStep
//     re-enters. That write surface has its own kill points.
const FANOUT_WF: Workflow = {
  name: "fg530-fanout",
  description: "FG-530: fanout step behind an authoritative red, force-advanced",
  inputs: [],
  steps: [
    step("plan"),
    step("build", {
      gate: "verdict",
      depends_on: ["plan"],
      fanout: { from_upstream: { step: "plan", array_key: "units", input_key: "unit" }, failure_mode: "fail-phase" },
      reds: [{ agent: "red-security", authority: "authoritative", gate_on_verdict: true }],
    }),
  ],
};
const FANOUT_YAML = `name: fg530-fanout
description: FG-530 fanout
inputs: []
steps:
  - id: plan
    agent: engineer
    gate: auto
    runtime: ${RUNTIME}
  - id: build
    agent: engineer
    gate: verdict
    runtime: ${RUNTIME}
    depends_on: [plan]
    fanout:
      from_upstream:
        step: plan
        array_key: units
        input_key: unit
      failure_mode: fail-phase
    reds:
      - agent: red-security
        authority: authoritative
        gate_on_verdict: true
`;

// (5) the same fanout with NO red — the shape reconcile's fanout-parent recovery
//     actually acts on. dispatchFanoutStep holds the parent at `running` from
//     markTaskRunning until its own merge/finalize sequence lands; a crash in that
//     span leaves a `running` parent whose children are already terminal, and the
//     per-task loop can never sweep it (a parent gets no container, so it has no
//     container.started event — the gate that loop turns on). It is the ONLY state
//     the fanout-parent recovery acts on. Reds are deliberately absent: a parent
//     that reached its reds has already left `running` for awaiting_red, so a
//     `running` parent never has red children — including them here would build a
//     state production cannot reach.
const FANOUT_NO_RED_WF: Workflow = {
  name: "fg530-fanout-no-red",
  description: "FG-530: fanout step with an auto gate — the fanout-parent recovery shape",
  inputs: [],
  steps: [
    step("plan"),
    step("build", {
      depends_on: ["plan"],
      fanout: { from_upstream: { step: "plan", array_key: "units", input_key: "unit" }, failure_mode: "fail-phase" },
    }),
  ],
};
const FANOUT_NO_RED_YAML = `name: fg530-fanout-no-red
description: FG-530 fanout no red
inputs: []
steps:
  - id: plan
    agent: engineer
    gate: auto
    runtime: ${RUNTIME}
  - id: build
    agent: engineer
    gate: auto
    runtime: ${RUNTIME}
    depends_on: [plan]
    fanout:
      from_upstream:
        step: plan
        array_key: units
        input_key: unit
      failure_mode: fail-phase
`;

// (6) an INVOKE-kind run. The ONLY shape in which reconcile COMPLETES a task rather
//     than landing it fail-safe: run-kind.ts says `invoke` / `invoke_chain` runs have
//     no host-side finalize, so a usable result IS the end of the task's lifecycle.
//     Every other scenario here is a pipeline, where the identical evidence sends
//     reconcile to failPipelineUnfinalized instead — which is exactly why reconcile's
//     own completion writes had no cell until this scenario. They are the reconcile
//     writes invariant 1 has the most at stake in: a completion, not a failure.
const INVOKE_WF: Workflow = {
  name: "invoke",
  description: "FG-530: an invoke-kind run — the one kind reconcile may complete",
  inputs: [],
  steps: [step("build")],
};
const INVOKE_YAML = `name: invoke
description: FG-530 invoke
inputs: []
steps:
  - id: build
    agent: engineer
    gate: auto
    runtime: ${RUNTIME}
`;

// (7) the second no-finalize run kind (`invoke_chain`, a campaign quick lane — FG-486),
//     with a NARRATIVE role on a pi-format runtime whose agent wrote no result.json at
//     all. Reconcile then completes from a result recovered out of stdout (FG-455 →
//     FG-337 inferredResultFrom) — a SECOND completion write, with a different evidence
//     base (nothing on disk to read) and its own transaction. The result-present arm's
//     cells cannot vouch for it.
const INVOKE_STDOUT_WF: Workflow = {
  name: "invoke_chain",
  description: "FG-530: an invoke_chain run whose narrative agent left only stdout",
  inputs: [],
  steps: [step("build", { agent: "research-specialist", runtime: PI_RUNTIME })],
};
const INVOKE_STDOUT_YAML = `name: invoke_chain
description: FG-530 invoke chain
inputs: []
steps:
  - id: build
    agent: research-specialist
    gate: auto
    runtime: ${PI_RUNTIME}
`;

const SCENARIOS: Scenario[] = [
  {
    name: "plain",
    workflow: PLAIN_WF,
    yaml: PLAIN_YAML,
    exec: { redVerdict: "pass" },
    drive: async (runId, workflow, exec) => {
      await runNext({ runId, workflow, dockerExec: exec });
    },
  },
  {
    // The same plain shape, but the agent returns a result with no tests_run —
    // it lands the FG-523 validation hold instead of completing. The only path
    // to holdIfValidationContractFails's write boundary.
    name: "contract-hold",
    workflow: PLAIN_WF,
    yaml: PLAIN_YAML,
    exec: { redVerdict: "pass", primaryFailsContract: true },
    drive: async (runId, workflow, exec) => {
      await runNext({ runId, workflow, dockerExec: exec });
    },
  },
  {
    name: "red-blocks",
    workflow: RED_WF,
    yaml: RED_YAML,
    exec: { redVerdict: "fail" },
    drive: async (runId, workflow, exec) => {
      await runNext({ runId, workflow, dockerExec: exec });
      // The authoritative fail parks the primary at blocked_by_red; the operator's
      // only move is a forced advance, which is the gate write path.
      const primary = primaryOf(runId, "build");
      if (primary && primary.status === "blocked_by_red") {
        await gate(primary.id, "advance", "override for the crash matrix", { force: true });
      }
    },
  },
  {
    // Both on_reject write sequences: review1's reject MINTS the recovery row,
    // review2's reject DEDUPS onto it.
    name: "gate-reject-on_reject",
    workflow: REJECT_DEDUP_WF,
    yaml: REJECT_DEDUP_YAML,
    exec: { redVerdict: "pass" },
    drive: async (runId, workflow, exec) => {
      await runNext({ runId, workflow, dockerExec: exec }); // build → complete
      await runNext({ runId, workflow, dockerExec: exec }); // review1 + review2 → awaiting_gate
      const r1 = awaitingGatePrimary(runId, "review1");
      if (r1) await gate(r1.id, "reject", "needs another build pass"); // mint
      const r2 = awaitingGatePrimary(runId, "review2");
      if (r2) await gate(r2.id, "reject", "the second rejection lands on the same recovery row"); // dedup
      await runNext({ runId, workflow, dockerExec: exec }); // recovery row dispatches
    },
  },
  {
    // Both request-changes write sequences: the first MINTS the replacement
    // primary, the second DEDUPS onto a pending one. The dedup guard exists for
    // a leftover pending primary it did not itself mint (a duplicate/concurrent
    // gate call, or `forge retry`'s parallel primary) — no single-threaded call
    // sequence produces two live primaries, so that row is seeded directly, the
    // same way FG-364's dedup test reaches this branch.
    name: "gate-request-changes",
    workflow: REJECT_WF,
    yaml: REJECT_YAML,
    exec: { redVerdict: "pass" },
    drive: async (runId, workflow, exec) => {
      await runNext({ runId, workflow, dockerExec: exec }); // build → complete
      await runNext({ runId, workflow, dockerExec: exec }); // review → awaiting_gate
      const review = awaitingGatePrimary(runId, "review");
      if (review) await gate(review.id, "request-changes", "revise the review"); // mint
      await runNext({ runId, workflow, dockerExec: exec }); // replacement dispatches → awaiting_gate
      const replacement = awaitingGatePrimary(runId, "review");
      if (replacement) {
        seedLeftoverPendingPrimary(runId, "review", "reviewer");
        await gate(replacement.id, "request-changes", "revise again — onto the pending primary"); // dedup
      }
      await runNext({ runId, workflow, dockerExec: exec }); // the dedup'd pending row dispatches
    },
  },
  {
    name: "fanout-red-blocks",
    workflow: FANOUT_WF,
    yaml: FANOUT_YAML,
    exec: { redVerdict: "fail" },
    drive: async (runId, workflow, exec) => {
      await runNext({ runId, workflow, dockerExec: exec }); // plan → complete
      await runNext({ runId, workflow, dockerExec: exec }); // fanout children + red → parent blocked_by_red
      const parent = primaryOf(runId, "build");
      if (parent && parent.status === "blocked_by_red") {
        await gate(parent.id, "advance", "override the fanout red for the crash matrix", { force: true });
      }
      await runNext({ runId, workflow, dockerExec: exec }); // gateForced re-entry finalizes the parent
    },
  },
  {
    name: "fanout-parent-orphaned",
    workflow: FANOUT_NO_RED_WF,
    yaml: FANOUT_NO_RED_YAML,
    exec: { redVerdict: "pass" },
    drive: async (runId, workflow, exec) => {
      await runNext({ runId, workflow, dockerExec: exec }); // plan → complete
      await runNext({ runId, workflow, dockerExec: exec }); // wave: children complete, parent finalizes
    },
    strand: async (sc, runId, exec) => {
      await sc.drive(runId, sc.workflow, exec);
      const parent = primaryOf(runId, "build");
      assert.ok(parent, "the fanout parent must exist for this strand to mean anything");
      // The wave ran for real — children dispatched, completed, and the runner
      // wrote the parent's aggregate. Now put the parent back where a crash inside
      // dispatchFanoutStep's own finalize span leaves it: `running`, children already
      // terminal. That span (markTaskRunning → merge → gate → finalizePrimary,
      // runNext.ts) carries no probe of its own — FG-530 scopes production probes to
      // reconcile.ts — so the state is reconstructed here rather than crashed into.
      // It is the exact precondition of the fanout-parent recovery, and nothing else
      // in the run is touched.
      setTaskStatus(parent.id, "running");
    },
  },
  {
    // The fanout-parent recovery's OTHER arm. A wave in which not every child made
    // it is a different recovery decision — a `partial` aggregate, a different
    // operator message — reached through its own transaction, and the all-complete
    // strand above can never produce it.
    name: "fanout-parent-partial",
    workflow: FANOUT_NO_RED_WF,
    yaml: FANOUT_NO_RED_YAML,
    exec: { redVerdict: "pass" },
    drive: async (runId, workflow, exec) => {
      await runNext({ runId, workflow, dockerExec: exec }); // plan → complete
      await runNext({ runId, workflow, dockerExec: exec }); // wave: children complete, parent finalizes
    },
    strand: async (sc, runId, exec) => {
      await sc.drive(runId, sc.workflow, exec);
      const parent = primaryOf(runId, "build");
      assert.ok(parent, "the fanout parent must exist for this strand to mean anything");
      const children = tasksForRun(runId).filter((c) => c.parentId === parent.id);
      assert.ok(children.length > 0, "the wave must have dispatched a child to fail");
      // Same reconstruction as fanout-parent-orphaned above (and the same reason it
      // is reconstructed rather than crashed into), with one child left FAILED: the
      // wave that partly died, whose parent never got to finalize.
      setTaskStatus(children[0]!.id, "failed");
      setTaskStatus(parent.id, "running");
    },
  },
  {
    name: "invoke-reconcile-completes",
    workflow: INVOKE_WF,
    yaml: INVOKE_YAML,
    exec: { redVerdict: "pass" },
    drive: async (runId, workflow, exec) => {
      await runNext({ runId, workflow, dockerExec: exec });
    },
    // strandMidFinalize is exactly right here: a `running` task whose container is
    // gone with a usable result.json. On a PIPELINE that lands failPipelineUnfinalized;
    // on this run kind it is reconcile's completion write.
  },
  {
    name: "invoke-reconcile-completes-from-stdout",
    workflow: INVOKE_STDOUT_WF,
    yaml: INVOKE_STDOUT_YAML,
    exec: { redVerdict: "pass", narrativeStdoutOnly: true },
    drive: async (runId, workflow, exec) => {
      await runNext({ runId, workflow, dockerExec: exec });
    },
    strand: async (sc, runId, exec) => {
      await strandMidFinalize(sc, runId, exec);
      const t = primaryOf(runId, "build");
      assert.ok(t, "the primary must exist for this strand to mean anything");
      // The container wrote no result.json — the file on disk is the copy runNext's
      // own FG-337 ingest synthesized from this stdout, moments before the kill. The
      // crash being modelled lands EARLIER than that write: the container exited, the
      // host died, and the captured stdout is all that survived. Remove it so reconcile
      // faces the state its stdout-recovery exists for.
      rmSync(join(taskDir(runId, t.id), "result.json"), { force: true });
    },
  },
  {
    // The container-gone sweep's three NO-RECOVERABLE-RESULT landings, one scenario
    // each. They share a stranded shape (a `running` primary, container gone, no
    // result.json, nothing inferable from stdout) and differ only in the evidence
    // reconcile then reads — which is the whole point: the branch it picks, the
    // failure_kind it persists, and the operator verb it names are all decided by
    // that evidence, so each landing is killed in its own transaction rather than
    // vouched for by the shape of a sibling's.
    //
    // (a) docker witnessed an OOM kill.
    name: "container-gone-oom",
    workflow: PLAIN_WF,
    yaml: PLAIN_YAML,
    exec: { redVerdict: "pass" },
    exitInfo: () => ({ oomKilled: true, exitCode: 137 }),
    drive: async (runId, workflow, exec) => {
      await runNext({ runId, workflow, dockerExec: exec });
    },
    strand: strandWithNoRecoverableResult,
  },
  {
    // (b) docker knows nothing, but the work path is DIRTY — files may have landed.
    name: "container-gone-worktree-dirty",
    workflow: PLAIN_WF,
    yaml: PLAIN_YAML,
    exec: { redVerdict: "pass" },
    drive: async (runId, workflow, exec) => {
      await runNext({ runId, workflow, dockerExec: exec });
    },
    strand: async (sc, runId, exec) => {
      await strandWithNoRecoverableResult(sc, runId, exec);
      dirtyWorkPath(runId);
    },
  },
  {
    // (c) docker knows nothing and nothing was persisted: the ordinary orphan.
    name: "container-gone-no-result",
    workflow: PLAIN_WF,
    yaml: PLAIN_YAML,
    exec: { redVerdict: "pass" },
    drive: async (runId, workflow, exec) => {
      await runNext({ runId, workflow, dockerExec: exec });
    },
    strand: strandWithNoRecoverableResult,
  },
  {
    name: "backfill-complete-empty-result",
    workflow: PLAIN_WF,
    yaml: PLAIN_YAML,
    exec: { redVerdict: "pass" },
    drive: async (runId, workflow, exec) => {
      await runNext({ runId, workflow, dockerExec: exec });
    },
    strand: async (sc, runId, exec) => {
      await sc.drive(runId, sc.workflow, exec); // build completes: result on the row AND on disk
      const t = primaryOf(runId, "build");
      assert.ok(t, "the primary must exist for this strand to mean anything");
      // FG-455 Mode A: a detached wrapper killed after the row went `complete` but
      // before the structured result reached it. The ROW's result is the only casualty
      // — result.json survives, and is what the backfill pass reads back. Nothing in
      // production nulls a result (no store accessor does, deliberately), so the row is
      // edited directly here; it is the only way to build the state.
      db.prepare("UPDATE tasks SET result = NULL WHERE id = ?").run(t.id);
    },
  },
  {
    // The FG-437 mid-provisioning recovery — reconcile's one landing reached BEFORE
    // the container-liveness gate, on a DISTINCT evidence base: a task `running` with
    // a container.provision_started event, no provision_succeeded, and no
    // container.started. The container-gone cells cannot vouch for it (they all sit
    // past the `if (!hasContainerStarted) continue` gate this branch precedes).
    name: "provisioning-crash",
    workflow: PLAIN_WF,
    yaml: PLAIN_YAML,
    exec: { redVerdict: "pass" },
    drive: async (runId, workflow, exec) => {
      await runNext({ runId, workflow, dockerExec: exec });
    },
    strand: async (sc, runId, exec) => {
      // Crash in the REAL pre-container window (the FG-533 probe): the row is `running`,
      // task.started is appended, and no container ever started. That is half the shape
      // reconcile's provisioning branch keys on.
      const fired = await crashAt("runContainer:after-mark-running-before-container-launch", () =>
        sc.drive(runId, sc.workflow, exec),
      );
      assert.ok(fired, "the pre-container kill must fire for this strand to build the mid-provisioning shape");
      const t = primaryOf(runId, "build");
      assert.ok(t, "the primary must exist for this strand to mean anything");
      assert.equal(t.status, "running", "the pre-container crash leaves the row `running`");

      // The other half: the provisioner's own durable event. The matrix's fake docker
      // layer never provisions (no lockfile, no cache plan), so the event a real
      // dependency-provisioning pass would have appended between task.started and
      // container.started is appended here, with the containerName + cacheKey payload
      // FG-437's recovery reads. Appending an event is not a lifecycle write — it builds
      // the evidence base, which is what a fixture is for.
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
  {
    // FG-533: the pre-container crash window with NO provisioning evidence — the
    // shape reconcile's pre-container sweep (not the FG-437 branch) owns. The
    // strand is a real kill at runContainer's pre-container probe: the row is
    // `running`, task.started is on the record, and neither a provisioning event
    // nor container.started ever lands. This scenario is what makes the sweep's
    // own write probes (reconcile:before-fail-pre-container-crash / -txn)
    // reachable in the matrix.
    name: "pre-container-crash",
    workflow: PLAIN_WF,
    yaml: PLAIN_YAML,
    exec: { redVerdict: "pass" },
    drive: async (runId, workflow, exec) => {
      await runNext({ runId, workflow, dockerExec: exec });
    },
    strand: async (sc, runId, exec) => {
      const fired = await crashAt("runContainer:after-mark-running-before-container-launch", () =>
        sc.drive(runId, sc.workflow, exec),
      );
      assert.ok(fired, "the pre-container kill must fire for this strand to build the FG-533 shape");
      const t = primaryOf(runId, "build");
      assert.ok(t, "the primary must exist for this strand to mean anything");
      assert.equal(t.status, "running", "the pre-container crash leaves the row `running`");
    },
  },
  {
    // FG-531: the awaiting_red crash window, single-step callsite. The strand IS
    // the first crash — a real kill inside dispatchSingleStep's window between
    // the awaiting_red status write and dispatchReds — so reconcile's awaiting_red
    // sweep faces the exact production shape: primary at awaiting_red, its reds
    // dead with the process. A pending red row is seeded alongside it (the
    // insert→dispatch window inside runOneRed carries no probe of its own to
    // crash into — FG-530 scopes probes to the status-write boundaries — so the
    // row a crash there leaves behind is reconstructed, nothing else touched):
    // that is the dead-red settlement write's only reachable path.
    name: "awaiting-red-orphaned",
    workflow: RED_WF,
    yaml: RED_YAML,
    exec: { redVerdict: "pass" },
    drive: async (runId, workflow, exec) => {
      await runNext({ runId, workflow, dockerExec: exec });
    },
    strand: async (sc, runId, exec) => {
      const fired = await crashAt("dispatchSingleStep:after-awaiting-red", () =>
        sc.drive(runId, sc.workflow, exec),
      );
      assert.ok(fired, "the awaiting_red kill must fire for this strand to build the FG-531 shape");
      const t = primaryOf(runId, "build");
      assert.ok(t, "the primary must exist for this strand to mean anything");
      assert.equal(t.status, "awaiting_red", "the crash leaves the primary at awaiting_red");
      seedPendingRedChild(runId, t.id, "red-security");
    },
  },
  {
    // FG-531: the same window on the fanout PARENT callsite (dispatchFanoutStep).
    // The wave ran for real — children dispatched and completed — then the kill
    // lands between the parent's awaiting_red write and its reds, stranding the
    // parent with terminal children behind it. Reconcile's sweep must land the
    // parent as fanout_wave_orphaned WITHOUT touching the completed children.
    name: "awaiting-red-fanout-orphaned",
    workflow: FANOUT_WF,
    yaml: FANOUT_YAML,
    exec: { redVerdict: "pass" },
    drive: async (runId, workflow, exec) => {
      await runNext({ runId, workflow, dockerExec: exec }); // plan → complete
      await runNext({ runId, workflow, dockerExec: exec }); // wave + parent finalize
    },
    strand: async (sc, runId, exec) => {
      await runNext({ runId, workflow: sc.workflow, dockerExec: exec }); // plan → complete
      const fired = await crashAt("dispatchFanoutStep:after-awaiting-red", () =>
        runNext({ runId, workflow: sc.workflow, dockerExec: exec }),
      );
      assert.ok(fired, "the fanout awaiting_red kill must fire for this strand to build the FG-531 shape");
      const parent = primaryOf(runId, "build");
      assert.ok(parent, "the fanout parent must exist for this strand to mean anything");
      assert.equal(parent.status, "awaiting_red", "the crash leaves the parent at awaiting_red");
    },
  },
];

/** FG-531: the pending red row a crash inside runOneRed's insert→dispatch window
 *  leaves behind — the dead-red settlement's only reachable input shape. */
function seedPendingRedChild(runId: string, parentId: string, role: string): void {
  const id = newTaskId("red-build");
  insertTask({
    id,
    runId,
    parentId,
    phase: "build",
    agentRole: role,
    status: "pending",
    taskPackage: {
      taskId: id,
      runId,
      phase: "build",
      role,
      dispatchSource: "workflow",
      inputs: {},
      composedSystemPrompt: "",
    },
    createdAt: nowIso(),
  });
}

/** The lockfile hash a real provision plan would carry. Any stable string does —
 *  reconcile's branch only requires containerName + cacheKey to be present, and the
 *  matrix's containerAlive fake reports every container gone. */
const PROVISION_CACHE_KEY = "fg530-lockfile-hash";

/** The pending primary gate.ts's request-changes dedup exists to find: one it did
 *  not mint itself. */
function seedLeftoverPendingPrimary(runId: string, phase: string, role: string): void {
  const id = newTaskId(phase);
  insertTask({
    id,
    runId,
    phase,
    agentRole: role,
    status: "pending",
    taskPackage: {
      taskId: id,
      runId,
      phase,
      role,
      dispatchSource: "workflow",
      inputs: { requestedChanges: "an earlier rationale that the dedup must supersede" },
      composedSystemPrompt: "",
    },
    createdAt: nowIso(),
  });
}

// ── the matrix ────────────────────────────────────────────────────────────────

for (const sc of SCENARIOS) {
  for (const kp of KILL_POINTS) {
    test(`FG-530 matrix [${sc.name}] hook armed @ ${kp.point}`, async (t) => {
      ensureRuntime();
      writeWorkflowYaml(sc.workflow.name, sc.yaml);
      const projectDir = makeTmpDir();
      const exec = makeExec(sc.exec);

      const { runId } = startRun({
        workflow: sc.workflow,
        title: `fg530 ${sc.name} @ ${kp.point}`,
        inputs: {},
        projectDir,
      });

      // 1–2. Drive with the hook armed, measuring the persisted work AT the kill.
      // Whether this cell is a KILL cell or a non-kill SMOKE cell is a property of
      // the (scenario, kill point) pair, not something the cell gets to assert: no
      // scenario reaches every boundary. The invariants must hold on both, and the
      // per-point kill requirement is enforced whole-registry (coverage test below).
      const { fired, persistedPreKill } = await runCrashPhase(sc, runId, exec, kp);
      t.diagnostic(
        fired
          ? `KILL cell: the scenario died at ${kp.point}`
          : `SMOKE cell: this scenario never reaches ${kp.point} — the drive ran to its natural end`,
      );

      const wasAbandoned = getRun(runId)?.status === "abandoned";

      // 3. FRESH pass, hook disarmed: reconcile + runNext to fixpoint.
      await recoverToFixpoint(runId, sc.workflow, exec);

      // 4. The five invariants over the post-recovery state. Everything except
      //    the two known HEAD bugs (pinned as todo tests below) must hold.
      const violations = await checkAllInvariants({
        runId,
        workflow: sc.workflow,
        exec,
        persistedPreKill,
        wasAbandoned,
      });
      const { unexpected } = partitionKnown(violations);
      assert.deepEqual(
        unexpected,
        [],
        `crash @ ${kp.point} in scenario '${sc.name}' left the run violating lifecycle invariants:\n${formatViolations(unexpected)}`,
      );
    });
  }
}

// ── the crash model itself: a kill must actually END the pass ──────────────────
//
// Every reconcile cell above rests on one assumption: the fresh recovery pass starts
// from the world the CRASH left, not from a world the dead process kept building. On
// the reconcile surface that assumption is not free. reconcile.ts's FG-459 guards
// swallow any throw from one task's writes and keep sweeping — correct in production
// (a SQLITE_BUSY must not abort the pass), and fatal to the crash model if the hook
// only throws: reconcile would catch the "death" and go on to finalize the run's
// other tasks, so recoverToFixpoint would be handed state a real crash could never
// have produced, and every reconcile cell would be testing the wrong precondition.
//
// crashAt takes the store away at the probe for exactly this reason. This test is
// what proves it: two tasks stranded in the identical shape, killed at the write for
// the first. The second must be exactly as the crash left it.

test("FG-530 crash model: a kill inside reconcile ENDS the pass — the FG-459 guards may catch the throw, but the dead process must not write again", async () => {
  ensureRuntime();
  const sc = SCENARIOS[0]!; // plain: strandMidFinalize leaves a `running` primary with its result on disk
  writeWorkflowYaml(sc.workflow.name, sc.yaml);
  const projectDir = makeTmpDir();
  const exec = makeExec(sc.exec);
  const { runId } = startRun({ workflow: sc.workflow, title: "fg530 crash model", inputs: {}, projectDir });

  await strandMidFinalize(sc, runId, exec);

  // A SECOND task stranded in the same shape — same landing, same transaction, later
  // in reconcile's sweep. It is the witness: reconcile only ever reaches it by
  // continuing PAST the kill.
  const second = newTaskId("verify");
  insertTask({
    id: second,
    runId,
    phase: "verify",
    agentRole: "engineer",
    status: "running",
    taskPackage: { taskId: second, runId, phase: "verify", role: "engineer", dispatchSource: "workflow", inputs: {}, composedSystemPrompt: "" },
    createdAt: nowIso(),
  });
  logEvent("container.started", { runId, taskId: second, payload: { containerName: `forge-${second}` } });
  const secondDir = taskDir(runId, second);
  mkdirSync(secondDir, { recursive: true });
  writeFileSync(join(secondDir, "result.json"), JSON.stringify({ status: "complete", tests_run: 1, files_modified: [] }));

  const atCrash = snapshotKey(snapshot(runId));
  const fired = await crashAt("reconcile:before-fail-pipeline-unfinalized", () => reconcile(runId));
  assert.ok(fired, "the kill must land on the first stranded task's write");

  assert.equal(
    snapshotKey(snapshot(runId)),
    atCrash,
    "a crashed reconcile pass committed state: the injected death was caught by the FG-459 guards and the pass kept " +
      "writing. Every reconcile cell's recovery pass would then start from a world no crash could produce.",
  );
  assert.equal(getTask(second)?.status, "running", "the witness task must be untouched — reconcile never reached it");
  assert.deepEqual(
    eventsForTask(second).map((e) => e.eventType),
    ["container.started"],
    "the witness task must carry no reconcile event: the dead process cannot log one",
  );
});

// ── invariant 3, at every kill point: the cancel race ──────────────────────────
//
// The matrix cells above never cancel, so `wasAbandoned` is false for all of them
// and checkAbandonedNeverOverwritten returns immediately — invariant 3 only has
// teeth when a `forge cancel` lands WHILE the runner is dead. So run that race at
// EVERY kill window, not just one: the resurrection bug is a property of the
// recovery path, and each crash window leaves recovery a different state to
// resurrect from.
//
// Each cell picks the first scenario that actually reaches its kill point (not
// every scenario reaches every one — that's what the registry-coverage test at the
// end is for), crashes there, cancels, then recovers to fixpoint.

async function crashInFirstReachingScenario(
  kp: KillPoint,
): Promise<{ sc: Scenario; runId: string; exec: DockerExecFn; persistedPreKill: PersistedWork }> {
  for (const sc of SCENARIOS) {
    writeWorkflowYaml(sc.workflow.name, sc.yaml);
    const projectDir = makeTmpDir();
    const exec = makeExec(sc.exec);
    const { runId } = startRun({
      workflow: sc.workflow,
      title: `fg530 cancel race ${sc.name} @ ${kp.point}`,
      inputs: {},
      projectDir,
    });
    const { fired, persistedPreKill } = await runCrashPhase(sc, runId, exec, kp);
    if (fired) return { sc, runId, exec, persistedPreKill };
  }
  throw new Error(
    `no scenario reaches kill point ${kp.point}, so invariant 3 cannot be exercised there — add a scenario (the registry-coverage test names the same gap)`,
  );
}

for (const kp of KILL_POINTS) {
  test(`FG-530 invariant 3 [cancel race] kill @ ${kp.point}: a \`forge cancel\` that lands while the runner is crashed must never be resurrected by recovery`, async () => {
    ensureRuntime();
    const { sc, runId, exec, persistedPreKill } = await crashInFirstReachingScenario(kp);

    // The operator's `forge cancel --abandon-run` lands while the runner is crashed.
    // A run the crash left in-flight (active) is abandoned; a run the crash already
    // SETTLED to a terminal state is a no-op for cancel — `forge cancel` refuses a
    // terminal run (cancel.ts) and the store's terminal-crossing guard equally
    // refuses complete/failed -> abandoned (FG-585). Some (scenario, kill point)
    // cells reach their probe only after the run has genuinely finalized (a gate
    // advance that completed the run, a reconcile backfill on an already-complete
    // run), so the abandon there is correctly refused. Attempt it, then read back
    // what actually settled.
    updateRunStatus(runId, "abandoned"); // active -> abandoned; a no-op if already terminal
    const settled = getRun(runId)!.status;

    await recoverToFixpoint(runId, sc.workflow, exec);

    // The invariant across BOTH outcomes: recovery must never resurrect or flip the
    // settled run. An abandoned (cancelled) run stays abandoned — the AWN-2 rule that
    // recovery never resurrects a cancelled run; a run the crash already completed
    // stays complete — recovery never re-opens or re-terminalizes a settled run.
    assert.equal(
      getRun(runId)!.status,
      settled,
      `recovery changed the settled run's status away from '${settled}' — it must never resurrect or flip a settled run`,
    );
    const violations = await checkAllInvariants({
      runId,
      workflow: sc.workflow,
      exec,
      persistedPreKill,
      wasAbandoned: settled === "abandoned",
    });
    const { unexpected } = partitionKnown(violations);
    assert.deepEqual(
      unexpected,
      [],
      `cancel racing a crash @ ${kp.point} (scenario '${sc.name}') violated lifecycle invariants:\n${formatViolations(unexpected)}`,
    );
  });
}

// ── FG-585 regression: the cancel/complete race resolves ONE way per run ───────
//
// The AWN-2 cancel race has two faithful outcomes, and FG-585's terminal-crossing
// guard is what keeps them apart. This pins BOTH arms in isolation so the invariant
// reads without the crash-matrix machinery, and so a revert of either guard fails
// loudly:
//   • a run the crash already SETTLED to complete cannot be re-terminalized to
//     abandoned by a racing operator cancel (store crossing guard, FG-585), and
//     recovery leaves it complete; and
//   • a run the crash left in-flight (active) IS abandoned by the cancel, and
//     recovery never resurrects it (the finalizeRunIfSettled abandoned re-read).
test("FG-585 cancel race: a genuinely-completed run refuses a racing abandon and recovery leaves it complete; an in-flight run abandons and stays abandoned", async () => {
  ensureRuntime();
  writeWorkflowYaml(PLAIN_WF.name, PLAIN_YAML);

  // Arm A — the crash finalized the run to complete before the cancel landed.
  {
    const projectDir = makeTmpDir();
    const exec = makeExec({ redVerdict: "pass" });
    const { runId } = startRun({ workflow: PLAIN_WF, title: "fg585 cancel-race complete arm", inputs: {}, projectDir });
    await runNext({ runId, workflow: PLAIN_WF, dockerExec: exec }); // build → complete → run complete
    assert.equal(getRun(runId)!.status, "complete", "precondition: the run finalized to complete");

    updateRunStatus(runId, "abandoned"); // operator cancel racing the settled run
    assert.equal(
      getRun(runId)!.status,
      "complete",
      "the terminal-crossing guard must refuse complete → abandoned (FG-585)",
    );

    await recoverToFixpoint(runId, PLAIN_WF, exec);
    assert.equal(getRun(runId)!.status, "complete", "recovery must leave the settled complete run complete");
  }

  // Arm B — the crash left the run in-flight (active), so the cancel abandons it.
  {
    const projectDir = makeTmpDir();
    const exec = makeExec({ redVerdict: "pass" });
    const { runId } = startRun({ workflow: PLAIN_WF, title: "fg585 cancel-race abandon arm", inputs: {}, projectDir });
    await runNext({ runId, workflow: PLAIN_WF, dockerExec: exec }); // build → complete (to mint the task graph)
    // Reconstruct a crash mid-finalize: the primary is back in flight and the run's
    // own completion write never became durable — a runner crashed here leaves the
    // RUN active, not complete (the run-complete finalize runs strictly after).
    const primary = primaryOf(runId, "build");
    assert.ok(primary, "the primary must exist to reopen");
    setTaskStatus(primary.id, "running");
    updateRunStatus(runId, "active");

    updateRunStatus(runId, "abandoned"); // operator cancel on the in-flight run
    assert.equal(getRun(runId)!.status, "abandoned", "an active run is abandonable");

    await recoverToFixpoint(runId, PLAIN_WF, exec);
    assert.equal(
      getRun(runId)!.status,
      "abandoned",
      "recovery must never resurrect a cancelled in-flight run (AWN-2)",
    );
  }
});

// ── inertness at FLOW level (the other half of the scope guard) ────────────────

test("FG-530 scope guard: an installed but NON-THROWING hook does not change a single write the runner makes — the probe callsites are side-effect-free", async () => {
  ensureRuntime();
  writeWorkflowYaml(RED_WF.name, RED_YAML);

  const normalize = (runId: string): string =>
    JSON.stringify({
      tasks: tasksForRun(runId)
        .map((t) => ({ phase: t.phase, role: t.agentRole, status: t.status, hasResult: t.result != null }))
        .sort((a, b) => `${a.phase}${a.role}`.localeCompare(`${b.phase}${b.role}`)),
      verdicts: verdictsForRun(runId)
        .map((v) => ({ role: v.redRole, verdict: v.verdict, authority: v.authority }))
        .sort((a, b) => a.role.localeCompare(b.role)),
      events: eventsForRun(runId)
        .map((e) => e.eventType)
        .sort(),
      runStatus: getRun(runId)?.status,
    });

  const driveOnce = async (title: string): Promise<string> => {
    const projectDir = makeTmpDir();
    const { runId } = startRun({ workflow: RED_WF, title, inputs: {}, projectDir });
    await runNext({ runId, workflow: RED_WF, dockerExec: makeExec({ redVerdict: "fail" }) });
    return normalize(runId);
  };

  setCrashHookForTest(undefined);
  const withoutHook = await driveOnce("fg530 inert baseline");

  const observed: string[] = [];
  setCrashHookForTest((p) => void observed.push(p)); // observes, never throws
  const withHook = await driveOnce("fg530 inert observed");
  setCrashHookForTest(undefined);

  assert.ok(observed.length > 0, "the observing hook must actually see probes fire (otherwise this proves nothing)");
  assert.equal(
    withHook,
    withoutHook,
    "a run driven with an observing hook installed must produce byte-identical task/verdict/event/run state to one driven with no hook at all",
  );
});

// ── META-AC: prove the harness DETECTS the historical regression shape ─────────
//
// The pre-FG-427/FG-482 blocked_by_red two-write dance: the verdict row landed
// and the status transition to blocked_by_red was a SEPARATE write. A crash
// between them left the primary un-blocked, and the next finalizePrimary
// completed it — shipping over an authoritative red's block. Seeded here as a
// hand-written DB fixture (NOT by reverting code), so the checkers are proven to
// have detection power, not merely to pass quietly.

function seedTwoWriteDanceFixture(opts: { primaryStatus: TaskStatus }): { runId: string; primaryId: string } {
  ensureRuntime();
  writeWorkflowYaml(RED_WF.name, RED_YAML);
  const projectDir = makeTmpDir();
  const { runId } = startRun({ workflow: RED_WF, title: "fg530 meta-AC fixture", inputs: {}, projectDir });

  const primaryId = "task-build-metaac";
  const redId = "task-red-metaac";
  const result = { status: "complete", tests_run: 1, files_modified: [] };
  const mk = (id: string, over: Partial<Task>): Task => ({
    id,
    runId,
    phase: "build",
    agentRole: "engineer",
    status: "complete",
    taskPackage: {
      taskId: id,
      runId,
      phase: "build",
      role: "engineer",
      dispatchSource: "workflow",
      inputs: {},
      composedSystemPrompt: "",
    },
    createdAt: "2026-07-11T10:00:00.000Z",
    ...over,
  });

  insertTask(mk(primaryId, { status: opts.primaryStatus, result }));
  insertTask(mk(redId, { parentId: primaryId, agentRole: "red-security", result: {} }));

  // The verdict write that DID land: an authoritative fail that must block.
  insertVerdict({
    id: newVerdictId(),
    taskId: primaryId,
    redTaskId: redId,
    redRole: "red-security",
    verdict: "fail",
    confidence: 0.9,
    authority: "authoritative",
    findings: [
      {
        severity: "high",
        summary: "seeded blocking finding",
        evidence: "meta-AC fixture",
        hypothesis: "n/a — fixture",
      },
    ],
    createdAt: "2026-07-11T10:01:00.000Z",
    gateOnVerdict: true,
  });

  return { runId, primaryId };
}

test("FG-530 META-AC: the harness FLAGS the old blocked_by_red two-write dance — a primary left `complete` over a landed authoritative-fail verdict violates invariant 1", () => {
  const { runId, primaryId } = seedTwoWriteDanceFixture({ primaryStatus: "complete" });

  const violations = checkNoCompleteWithoutEvidence(runId, RED_WF);

  assert.ok(
    violations.length > 0,
    "the harness MUST detect the seeded regression — a checker that stays silent here proves nothing about the green cells above",
  );
  assert.equal(violations[0]!.invariant, "1-no-complete-without-evidence-chain");
  assert.match(
    violations[0]!.detail,
    new RegExp(`task ${primaryId}.*BLOCKING verdict`),
    "the violation must name the offending task and the blocking verdict — a failure that reads as an invariant, not assertion soup",
  );
  assert.match(violations[0]!.detail, /two-write dance/, "and name the historical shape it corresponds to");
});

test("FG-530 META-AC control: the SAME fixture with the status write applied (blocked_by_red, as FG-482 makes atomic) is CLEAN — the checker discriminates, it does not just always fail", () => {
  const { runId } = seedTwoWriteDanceFixture({ primaryStatus: "blocked_by_red" });

  assert.deepEqual(
    checkNoCompleteWithoutEvidence(runId, RED_WF),
    [],
    "with the status write landed atomically alongside the verdict, invariant 1 is satisfied",
  );
  // And the blocked task is not a wedge: `forge gate <id> advance --force` is the named verb.
  assert.deepEqual(
    checkNoPermanentWedge(runId, RED_WF),
    [],
    "blocked_by_red carries a named operator verb, so it is not a permanent wedge",
  );
});

// ── invariant 1: the evidence chain is per-red, not "any verdict at all" ───────

test("FG-530 invariant 1 [multi-red, real path]: a step declaring TWO gating reds that completes carrying only ONE verdict row is FLAGGED — a surviving passing verdict must not stand in for the red that never wrote one", async () => {
  ensureRuntime();
  writeWorkflowYaml(TWO_RED_WF.name, TWO_RED_YAML);
  const projectDir = makeTmpDir();
  const exec = makeExec({ redVerdict: "pass" });
  const { runId } = startRun({ workflow: TWO_RED_WF, title: "fg530 two-red evidence chain", inputs: {}, projectDir });

  await runNext({ runId, workflow: TWO_RED_WF, dockerExec: exec });

  // Real path, real writes: both reds pass, the operator advances the verdict
  // gate (no force — the verdicts are clean), and the primary completes with a
  // full evidence chain. This is the control — the checker must be quiet here.
  const primary = primaryOf(runId, "build")!;
  assert.equal(primary.status, "awaiting_gate", "a passing verdict gate parks the primary for the operator");
  await gate(primary.id, "advance", "both reds passed");
  assert.equal(getTask(primary.id)!.status, "complete");

  const rows = verdictsForTask(primary.id);
  assert.deepEqual(
    rows.map((r) => r.redRole).sort(),
    ["red-security", "red-wide"],
    "the runner wrote one verdict row per declared gating red",
  );
  assert.deepEqual(
    checkNoCompleteWithoutEvidence(runId, TWO_RED_WF),
    [],
    "a complete evidence chain must not be flagged",
  );

  // Now lose exactly ONE of the two verdict writes — the crash shape between two
  // reds' inserts. The task still carries a passing verdict, so an emptiness test
  // (`verdicts.length === 0`) reads this as fine; the per-red check must not.
  const lost = rows.find((r) => r.redRole === "red-wide")!;
  db.prepare("DELETE FROM verdicts WHERE id = ?").run(lost.id);

  const violations = checkNoCompleteWithoutEvidence(runId, TWO_RED_WF);
  assert.equal(violations.length, 1, "the harness MUST detect the half-written evidence chain");
  assert.equal(violations[0]!.invariant, "1-no-complete-without-evidence-chain");
  assert.match(
    violations[0]!.detail,
    /MISSING for \[red-wide \(0\/1 verdict rows\)\]/,
    "the violation must name the red whose verdict never landed, not just report a count",
  );
});

// ── invariant 4: the snapshot covers worktrees, not just result.json ───────────

test("FG-530 invariant 4 [worktree discard]: a worktree that existed at the kill and is GONE after recovery on a NON-complete task is flagged; the same removal on a complete (proven-merged) task is not", () => {
  ensureRuntime();
  writeWorkflowYaml(PLAIN_WF.name, PLAIN_YAML);
  const projectDir = makeTmpDir();
  const { runId } = startRun({ workflow: PLAIN_WF, title: "fg530 worktree discard", inputs: {}, projectDir });

  // Worktree mode is macOS-only (preflightWorktreeGate), so no Linux matrix cell
  // can produce a real worktree — the checker's teeth are proven here instead.
  const mk = (id: string, status: TaskStatus): string => {
    insertTask({
      id,
      runId,
      phase: "build",
      agentRole: "engineer",
      status,
      taskPackage: { taskId: id, runId, phase: "build", role: "engineer", dispatchSource: "workflow", inputs: {}, composedSystemPrompt: "" },
      createdAt: nowIso(),
    });
    const wt = makeTmpDir();
    setTaskWorktreePath(id, wt);
    return wt;
  };
  const crashedWt = mk("task-build-crashed", "failed");
  const mergedWt = mk("task-build-merged", "complete");

  const pre = capturePersistedWork(runId);
  assert.deepEqual(
    pre.worktrees.map((w) => w.worktreePath).sort(),
    [crashedWt, mergedWt].sort(),
    "the pre-kill snapshot must SEE worktrees — capturing result.json alone cannot detect a discarded one",
  );

  rmSync(crashedWt, { recursive: true, force: true });
  rmSync(mergedWt, { recursive: true, force: true });

  const violations = checkPersistedWorkNeverDiscarded(pre);
  assert.equal(violations.length, 1, "exactly the failed task's worktree is a discard; the merged one's removal is sanctioned");
  assert.equal(violations[0]!.invariant, "4-persisted-work-never-discarded");
  assert.match(violations[0]!.detail, /worktree for task task-build-crashed .* is GONE after recovery/);
});

// ── FG-536: the watcher window, with the container still RUNNING ──────────────
//
// The matrix cells at runContainer:after-container-started-before-exec establish that
// the invariants hold when the host dies mid-watch. They cannot establish the thing
// detached execution is FOR: that the container the host stopped watching runs on, and
// that the result it produces after the host is gone is recovered rather than lost. So
// this cell pins the two halves of that window apart — nothing on disk at the kill, the
// container's result on disk after it, and reconcile landing THAT result on the row.
// Without it, a regression that kills or stops the container with the parent (an
// attached exec, a `--rm` teardown, a process-group kill) leaves every matrix cell green.

test("FG-536 [detached durability]: the host dies in the WATCHER window — the container had started and produced NOTHING; it runs to completion unwatched, and reconcile recovers its POST-KILL result", async () => {
  ensureRuntime();
  writeWorkflowYaml(PLAIN_WF.name, PLAIN_YAML);
  const projectDir = makeTmpDir();
  const exec = makeExec({ redVerdict: "pass" });
  const { runId } = startRun({ workflow: PLAIN_WF, title: "fg536 watcher death", inputs: {}, projectDir });

  let atKill: PersistedWork | undefined;
  const fired = await crashAt(
    "runContainer:after-container-started-before-exec",
    () => runNext({ runId, workflow: PLAIN_WF, dockerExec: exec }),
    () => {
      atKill = capturePersistedWork(runId);
    },
  );
  assert.ok(fired, "the watcher-window kill must fire");

  const primary = primaryOf(runId, "build")!;
  assert.equal(primary.status, "running", "the host died watching a live container: the row is still `running`");
  assert.ok(
    eventsForTask(primary.id).some((e) => e.eventType === "container.started"),
    "with container.started on the record — `docker run -d` had returned before the kill",
  );
  assert.deepEqual(
    atKill!.results,
    [],
    "and NOTHING persisted at the kill — the container was still RUNNING. This is what makes the cell a durability " +
      "test: a result already on disk would only prove reconcile re-reads work that was never at risk",
  );

  // The dead process has unwound; the container it started never noticed. It runs to
  // completion with no watcher and its result lands — the window detached execution opens.
  const resultPath = join(taskDir(runId, primary.id), "result.json");
  const postKill = readFileSync(resultPath, "utf8");
  assert.match(postKill, /"tests_run":1/, "the container's result landed AFTER the host was gone");

  await recoverToFixpoint(runId, PLAIN_WF, exec);

  const recovered = getTask(primary.id)!;
  assert.equal(
    recovered.status,
    "failed",
    "a pipeline step whose host died before its finalize lands fail-safe, not complete (orphaned_needs_finalize)",
  );
  assert.match(recovered.error ?? "", /orphaned_needs_finalize/, "the landing names the window it recovered from");
  assert.deepEqual(
    recovered.result,
    JSON.parse(postKill),
    "and carries the POST-KILL result on its row — a container killed with its parent, or a result reaped with it, " +
      "leaves this null. That is the FG-536 regression this cell exists to catch",
  );
  assert.equal(readFileSync(resultPath, "utf8"), postKill, "the result on disk is preserved verbatim");
  assert.deepEqual(
    checkNoPermanentWedge(runId, PLAIN_WF),
    [],
    "INVARIANT 2: the recovered state leaves the operator a named verb (forge retry --force)",
  );
});

// ── the REAL bugs this harness found on HEAD ───────────────────────────────────
//
// Fixed bugs keep their repro here, flipped to a plain passing assertion of the
// recovery (FG-530-B → FG-532; FG-530-A both callsites → FG-531; the
// pre-container wedge → FG-533). A still-open
// bug is marked `todo`: node:test RUNS it and reports the failure as expected,
// so the suite stays green (FG-530's scope guard forbids fixing them in that
// ticket) while the repro stays live. When the bug is fixed, its todo starts
// PASSING and node flags it — the prompt to delete the pin and flip the repro.

test(
  "FG-530-A [FIXED by FG-531]: a crash between the awaiting_red status write and the reds' terminal write is RECOVERED — reconcile's awaiting_red sweep lands the primary fail-safe as orphaned_needs_finalize with a named operator verb (forge retry --force)",
  async () => {
    ensureRuntime();
    writeWorkflowYaml(RED_WF.name, RED_YAML);
    const projectDir = makeTmpDir();
    const exec = makeExec({ redVerdict: "fail" });
    const { runId } = startRun({ workflow: RED_WF, title: "fg530-A recovery", inputs: {}, projectDir });

    // Kill in the window: the primary is marked awaiting_red, then the process dies.
    const fired = await crashAt("dispatchSingleStep:after-awaiting-red", () =>
      runNext({ runId, workflow: RED_WF, dockerExec: exec }),
    );
    assert.ok(fired, "the kill must fire for this repro to mean anything");
    assert.equal(primaryOf(runId, "build")!.status, "awaiting_red", "the crash leaves the primary at awaiting_red");

    await recoverToFixpoint(runId, RED_WF, exec);

    const primary = primaryOf(runId, "build")!;
    assert.equal(primary.status, "failed", "the sweep lands the orphaned awaiting_red primary fail-safe");
    assert.match(
      primary.error ?? "",
      /orphaned_needs_finalize: .*reached awaiting_red.*forge retry .* --force/s,
      "the landing names the window and the real re-drive verb",
    );
    assert.ok(primary.result != null, "the step's persisted result rides the failed row as evidence (invariant 4)");
    assert.deepEqual(
      checkNoPermanentWedge(runId, RED_WF),
      [],
      "INVARIANT 2: the recovered state has an enabled transition or a named operator verb everywhere",
    );
  },
);

test(
  "FG-530-A [FIXED by FG-531 — the fanout PARENT's copy of the same window]: a crash between dispatchFanoutStep's awaiting_red status write and its reds' terminal write is RECOVERED — the parent lands as fanout_wave_orphaned (forge recover --re-drive) and the wave's completed children stay complete with their results preserved",
  async () => {
    ensureRuntime();
    writeWorkflowYaml(FANOUT_WF.name, FANOUT_YAML);
    const projectDir = makeTmpDir();
    const exec = makeExec({ redVerdict: "fail" });
    const { runId } = startRun({ workflow: FANOUT_WF, title: "fg530-A fanout recovery", inputs: {}, projectDir });

    await runNext({ runId, workflow: FANOUT_WF, dockerExec: exec }); // plan → complete
    const fired = await crashAt("dispatchFanoutStep:after-awaiting-red", () =>
      runNext({ runId, workflow: FANOUT_WF, dockerExec: exec }),
    );
    assert.ok(fired, "the kill must fire for this repro to mean anything");

    const parentAtCrash = primaryOf(runId, "build")!;
    assert.equal(parentAtCrash.status, "awaiting_red", "the crash leaves the fanout parent at awaiting_red");
    const completeChildIds = tasksForRun(runId)
      .filter((t) => t.parentId === parentAtCrash.id && t.status === "complete")
      .map((t) => t.id);
    assert.ok(completeChildIds.length > 0, "the wave's children were already terminal — the work the wedge used to strand");

    await recoverToFixpoint(runId, FANOUT_WF, exec);

    const parent = primaryOf(runId, "build")!;
    assert.equal(parent.status, "failed", "the sweep lands the orphaned awaiting_red fanout parent fail-safe");
    assert.match(
      parent.error ?? "",
      /fanout parent orphaned at awaiting_red: .*forge recover .* --re-drive/s,
      "the landing names the window and recover --re-drive as the wave-coherent verb",
    );
    for (const childId of completeChildIds) {
      const child = getTask(childId)!;
      assert.equal(child.status, "complete", "a completed wave child is never touched by the sweep");
      assert.ok(child.result != null, "its persisted result is preserved untouched");
    }
    assert.deepEqual(
      checkNoPermanentWedge(runId, FANOUT_WF),
      [],
      "INVARIANT 2: the recovered state has an enabled transition or a named operator verb everywhere",
    );
  },
);

test(
  "FG-530-B [FIXED by FG-532]: `forge gate <id> reject` preserves the rejected task's result — gate.ts's reject branch now passes `result: task.result` through failTask, matching the adjacent request-changes branch",
  async () => {
    ensureRuntime();
    writeWorkflowYaml(REJECT_WF.name, REJECT_YAML);
    const projectDir = makeTmpDir();
    const exec = makeExec({ redVerdict: "pass" });
    const { runId } = startRun({ workflow: REJECT_WF, title: "fg530-B discard repro", inputs: {}, projectDir });

    // No crash at all — this is the clean, everyday reject path.
    await runNext({ runId, workflow: REJECT_WF, dockerExec: exec }); // build completes
    await runNext({ runId, workflow: REJECT_WF, dockerExec: exec }); // review parks at its human gate

    const review = primaryOf(runId, "review")!;
    assert.equal(review.status, "awaiting_gate");
    assert.ok(
      getTask(review.id)!.result != null,
      "precondition: markTaskAwaitingGate put the agent's result on the row",
    );

    await gate(review.id, "reject", "not good enough");

    assert.ok(
      getTask(review.id)!.result != null,
      "INVARIANT 4: rejecting a task must not DISCARD the result it had already persisted — the rejected artifact is the audit record for why it was rejected",
    );
  },
);

test(
  "FG-533 [FIXED]: a crash in the PRE-container window (markTaskRunning + task.started, then minutes of image pull / auth staging / provisioning before container.started) is RECOVERED — reconcile's pre-container sweep lands the runner-dispatched task as retryable pre_container_crash with a named operator verb (forge retry)",
  async () => {
    ensureRuntime();
    writeWorkflowYaml(PLAIN_WF.name, PLAIN_YAML);
    const projectDir = makeTmpDir();
    const exec = makeExec({ redVerdict: "pass" });
    const { runId } = startRun({ workflow: PLAIN_WF, title: "fg533 pre-container recovery", inputs: {}, projectDir });

    const fired = await crashAt("runContainer:after-mark-running-before-container-launch", () =>
      runNext({ runId, workflow: PLAIN_WF, dockerExec: exec }),
    );
    assert.ok(fired, "the kill must fire for this repro to mean anything");

    const primary = primaryOf(runId, "build")!;
    assert.equal(primary.status, "running", "the crash leaves the primary `running`");
    assert.equal(
      eventsForTask(primary.id).some((e) => e.eventType === "container.started"),
      false,
      "and with NO container.started — the event every rescue path used to key on",
    );

    await recoverToFixpoint(runId, PLAIN_WF, exec);

    const recovered = primaryOf(runId, "build")!;
    assert.equal(recovered.status, "failed", "the sweep lands the stranded pre-container task fail-safe");
    assert.match(
      recovered.error ?? "",
      /pre_container_crash: .*agent container never launched.*forge retry/s,
      "the landing names the window and the plain re-dispatch verb (no work exists, so no --force)",
    );
    assert.deepEqual(
      checkNoPermanentWedge(runId, PLAIN_WF),
      [],
      "INVARIANT 2: the recovered state has an enabled transition or a named operator verb everywhere",
    );
  },
);

test("FG-530: every known HEAD bug still reproduces in the matrix — a pin that stops firing is a pin that has silently rotted", () => {
  assert.deepEqual(
    KNOWN_FAILURES.filter((k) => !KNOWN_HIT.has(k.id)).map((k) => k.id),
    [],
    "every known-failure signature must still be hit by at least one matrix cell; if one no longer fires, the bug was fixed (delete the pin) or the scenario stopped reaching it (fix the scenario)",
  );
});

// ── coverage: every registered kill point must actually be reachable ───────────
//
// This is where the matrix's per-point kill requirement is enforced. An individual
// cell cannot carry it — a scenario reaches only the boundaries its own workflow and
// operator moves walk through — so the guarantee is stated over the whole registry:
// every point is killed at SOMEWHERE. Ragged cells, exhaustive points.

test("FG-530 coverage: every kill point in the registry FIRED in at least one matrix cell — an unreachable probe is a production edit with no coverage", () => {
  const unfired = KILL_POINTS.filter((kp) => !FIRED.has(kp.point)).map((kp) => kp.point);
  assert.deepEqual(
    unfired,
    [],
    `these kill points never fired in any scenario — either a scenario is missing or the probe is dead code:\n  ${unfired.join("\n  ")}`,
  );
});
