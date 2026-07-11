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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
];

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

    updateRunStatus(runId, "abandoned"); // the operator cancels before recovery runs

    await recoverToFixpoint(runId, sc.workflow, exec);

    assert.equal(getRun(runId)!.status, "abandoned", "recovery must leave the abandoned run abandoned");
    const violations = await checkAllInvariants({
      runId,
      workflow: sc.workflow,
      exec,
      persistedPreKill,
      wasAbandoned: true,
    });
    const { unexpected } = partitionKnown(violations);
    assert.deepEqual(
      unexpected,
      [],
      `cancel racing a crash @ ${kp.point} (scenario '${sc.name}') violated lifecycle invariants:\n${formatViolations(unexpected)}`,
    );
  });
}

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

// ── the two REAL bugs this harness found on HEAD (filed, not fixed) ────────────
//
// Marked `todo`: node:test RUNS them and reports the failure as expected, so the
// suite stays green (FG-530's scope guard forbids fixing them here) while the
// repro stays live. When either bug is fixed, its todo starts PASSING and node
// flags it — the prompt to delete the pin.

test(
  "FG-530-A [KNOWN FAILURE — real bug on HEAD, filed not fixed]: a crash between the awaiting_red status write and the reds' terminal write wedges the task at awaiting_red permanently — reconcile won't sweep it, the ready queue won't re-admit it, and neither `forge gate` nor `forge retry` accepts that status",
  { todo: "real crash-window wedge found by the FG-530 matrix; scope guard says file it, don't fix it in this ticket" },
  async () => {
    ensureRuntime();
    writeWorkflowYaml(RED_WF.name, RED_YAML);
    const projectDir = makeTmpDir();
    const exec = makeExec({ redVerdict: "fail" });
    const { runId } = startRun({ workflow: RED_WF, title: "fg530-A wedge repro", inputs: {}, projectDir });

    // Kill in the window: the primary is marked awaiting_red, then the process dies.
    const fired = await crashAt("dispatchSingleStep:after-awaiting-red", () =>
      runNext({ runId, workflow: RED_WF, dockerExec: exec }),
    );
    assert.ok(fired, "the kill must fire for this repro to mean anything");
    assert.equal(primaryOf(runId, "build")!.status, "awaiting_red", "the crash leaves the primary at awaiting_red");

    await recoverToFixpoint(runId, RED_WF, exec);

    // The bug: recovery converges to a fixpoint that is a WEDGE.
    assert.equal(
      primaryOf(runId, "build")!.status,
      "awaiting_red",
      "recovery leaves it at awaiting_red — reconcile only sweeps `running` rows",
    );
    assert.deepEqual(
      checkNoPermanentWedge(runId, RED_WF),
      [],
      "INVARIANT 2: an awaiting_red task orphaned by a crash has no enabled transition and no operator verb",
    );
  },
);

test(
  "FG-530-A [KNOWN FAILURE — the fanout PARENT's copy of the same window]: a crash between dispatchFanoutStep's awaiting_red status write and its reds' terminal write wedges the parent at awaiting_red with dead red children — the wave's completed children are stranded behind it",
  { todo: "same FG-530-A wedge, second callsite (dispatchFanoutStep); scope guard says pin the repro, don't fix it in this ticket" },
  async () => {
    ensureRuntime();
    writeWorkflowYaml(FANOUT_WF.name, FANOUT_YAML);
    const projectDir = makeTmpDir();
    const exec = makeExec({ redVerdict: "fail" });
    const { runId } = startRun({ workflow: FANOUT_WF, title: "fg530-A fanout wedge repro", inputs: {}, projectDir });

    await runNext({ runId, workflow: FANOUT_WF, dockerExec: exec }); // plan → complete
    const fired = await crashAt("dispatchFanoutStep:after-awaiting-red", () =>
      runNext({ runId, workflow: FANOUT_WF, dockerExec: exec }),
    );
    assert.ok(fired, "the kill must fire for this repro to mean anything");

    const parent = primaryOf(runId, "build")!;
    assert.equal(parent.status, "awaiting_red", "the crash leaves the fanout parent at awaiting_red");
    assert.ok(
      tasksForRun(runId).some((t) => t.parentId === parent.id && t.status === "complete"),
      "and its wave's children already terminal — the work the wedge strands",
    );

    await recoverToFixpoint(runId, FANOUT_WF, exec);

    assert.equal(
      primaryOf(runId, "build")!.status,
      "awaiting_red",
      "recovery leaves the parent at awaiting_red — reconcile's fanout-parent recovery only acts on `running` parents",
    );
    assert.deepEqual(
      checkNoPermanentWedge(runId, FANOUT_WF),
      [],
      "INVARIANT 2: a fanout parent orphaned at awaiting_red has no enabled transition and no operator verb",
    );
  },
);

test(
  "FG-530-B [KNOWN FAILURE — real bug on HEAD, filed not fixed]: `forge gate <id> reject` NULLs the rejected task's result — gate.ts's reject branch calls failTask() without `result`, unlike the adjacent request-changes branch that passes it deliberately",
  { todo: "real data-loss bug found by the FG-530 matrix; scope guard says file it, don't fix it in this ticket" },
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
  "FG-533 [KNOWN FAILURE — real bug on HEAD, filed not fixed]: a crash in the PRE-container window (markTaskRunning + task.started, then minutes of image pull / auth staging / provisioning before container.started) wedges the task at `running` permanently — reconcile's per-task loop and ops' reconcile-candidate SQL both gate on container.started, and `forge retry` refuses a non-failed task",
  { todo: "FG-533 — real pre-container crash-window wedge; scope guard says pin the repro, don't fix it in this ticket" },
  async () => {
    ensureRuntime();
    writeWorkflowYaml(PLAIN_WF.name, PLAIN_YAML);
    const projectDir = makeTmpDir();
    const exec = makeExec({ redVerdict: "pass" });
    const { runId } = startRun({ workflow: PLAIN_WF, title: "fg533 pre-container wedge repro", inputs: {}, projectDir });

    const fired = await crashAt("runContainer:after-mark-running-before-container-launch", () =>
      runNext({ runId, workflow: PLAIN_WF, dockerExec: exec }),
    );
    assert.ok(fired, "the kill must fire for this repro to mean anything");

    const primary = primaryOf(runId, "build")!;
    assert.equal(primary.status, "running", "the crash leaves the primary `running`");
    assert.equal(
      eventsForTask(primary.id).some((e) => e.eventType === "container.started"),
      false,
      "and with NO container.started — the event every rescue path keys on",
    );

    await recoverToFixpoint(runId, PLAIN_WF, exec);

    // The bug: recovery converges to a fixpoint that is a WEDGE.
    assert.equal(
      primaryOf(runId, "build")!.status,
      "running",
      "recovery leaves it `running` — reconcile skips it for want of a container.started event",
    );
    assert.deepEqual(
      checkNoPermanentWedge(runId, PLAIN_WF),
      [],
      "INVARIANT 2: a task stranded in the pre-container window has no enabled transition and no operator verb",
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
