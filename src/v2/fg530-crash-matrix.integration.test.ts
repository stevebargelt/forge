// FG-530 — crash-point simulator: kill-injection over the finalize path,
// reconcile to fixpoint, assert the lifecycle invariants.
//
// Forge's crash-safety story was proven piecemeal: each historical wedge got its
// own regression test AFTER it happened live. This is the systematic version.
// For every (scenario × kill point) cell:
//
//   1. arm the crash hook at ONE named write boundary (src/v2/crash-points.ts),
//   2. drive the real runner (startRun → runNext → gate) over a fake docker
//      layer until the hook throws mid-sequence — a process death, not a caught
//      error: nothing after the kill point writes,
//   3. in a FRESH pass with the hook disarmed, run reconcileRun + runNext
//      repeatedly until FIXPOINT (no state change between passes; capped),
//   4. assert the five lifecycle invariants over the post-recovery DB state.
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

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { Database as DatabaseInstance } from "better-sqlite3";

import { getDb, makeInMemoryDb, setDbForTest } from "../store/db.js";
import { insertTask, tasksForRun, getTask, setTaskStatus, setTaskWorktreePath } from "../store/tasks.js";
import { insertVerdict, verdictsForRun, verdictsForTask } from "../store/verdicts.js";
import { eventsForRun, eventsForTask, logEvent } from "../store/events.js";
import { getRun, updateRunStatus } from "../store/runs.js";
import { taskDir } from "../util/paths.js";
import { newTaskId, newVerdictId, nowIso } from "../util/ids.js";

import { crashPoint, setCrashHookForTest } from "./crash-points.js";
import { runNext, type DockerExecFn } from "./runNext.js";
import { startRun } from "./startRun.js";
import { gate, verdictBlocksGate, findStep } from "./gate.js";
import { reconcileRun } from "./reconcile.js";
import { computeReadyQueue } from "./ready-queue.js";
import { isPhasePrimaryRow } from "./lifecycle-evaluator.js";
import { evaluateValidationContract } from "./validation-contract.js";
import { retryPolicy } from "./retry-policy.js";
import type { Workflow, Step } from "./schema.js";
import type { Task, TaskStatus } from "../types/index.js";

// ── kill-point registry ───────────────────────────────────────────────────────
//
// Walked off the production write sequences, not hand-picked:
//   dispatch  — runContainer's PRE-container span (markTaskRunning + task.started,
//               then minutes of image pull / auth staging / provisioning before
//               container.started — FG-533's wedge), then dispatchSingleStep's
//               post-container sequence (result ingestion → validation-contract
//               hold → awaiting_red → verdict inserts → blocked_by_red →
//               finalizePrimary → event appends)
//   gate      — gate.ts's decision writes (advance, reject + on_reject recovery
//               mint OR dedup onto an existing recovery row, request-changes
//               replacement mint OR dedup onto an existing pending primary)
//   reconcile — reconcile.ts's own writes: the FG-479 failPipelineUnfinalized
//               landing (what a crashed PIPELINE step recovers into), its own
//               COMPLETION path on an invoke-like run (result on disk, or one
//               recovered from stdout — the only reconcile writes that END a
//               lifecycle rather than landing it fail-safe), the three
//               no-recoverable-result failure landings the container-gone sweep
//               chooses between (oom_killed, orphaned_work_may_persist,
//               orphaned — each a distinct evidence base and branch, so each is
//               killed in its own cell rather than vouched for by transactional
//               similarity to the others), the FG-455 Mode A backfill of a
//               complete-but-resultless row, BOTH arms of the fanout-parent
//               recovery (all children complete, or a partial wave), and the
//               FG-437 mid-provisioning landing (a DISTINCT evidence base —
//               container.provision_started with no provision_succeeded — reached
//               BEFORE the container-liveness gate, so no other reconcile cell
//               covers it)
//
// A `reconcile` cell is a crash WHILE RECOVERING from a crash: reconcile's writes
// only have anything to act on once a task is already stranded, so the driver
// strands one first (hook off), then arms the hook for the recovery reconcile. The
// shape it must strand DEPENDS on the write being killed — a stranded primary for
// the failPipelineUnfinalized landing and for the invoke-like completion, a
// stranded primary with NO result.json for the stdout-recovered completion, a
// stranded primary with NO recoverable result at all (plus, per landing, a
// docker-reported OOM kill or a dirty worktree) for the three failure landings, a
// COMPLETE row whose result was lost for the backfill, a stranded fanout PARENT
// for either fanout arm (reconcile skips parents in the per-task loop: they never
// get a container), and a task stranded MID-PROVISIONING (running, a
// container.provision_started event, no provision_succeeded, no container.started)
// for the FG-437 landing. Scenario.strand owns that; see runCrashPhase.
//
// The write-surface guard in fg530-probe-inertness.test.ts is what keeps this
// registry honest going forward: every state-write in the three covered files must
// carry a probe registered here, or an allowlist entry with a written reason.

type Surface = "dispatch" | "gate" | "reconcile";
type KillPoint = { point: string; surface: Surface };

const KILL_POINTS: KillPoint[] = [
  { point: "runContainer:after-mark-running-before-container-launch", surface: "dispatch" },
  { point: "dispatchSingleStep:after-result-ingest", surface: "dispatch" },
  { point: "dispatchSingleStep:before-validation-contract", surface: "dispatch" },
  { point: "holdIfValidationContractFails:between-hold-status-and-event", surface: "dispatch" },
  { point: "dispatchSingleStep:before-awaiting-red", surface: "dispatch" },
  { point: "dispatchSingleStep:between-awaiting-red-status-and-event", surface: "dispatch" },
  { point: "dispatchSingleStep:after-awaiting-red", surface: "dispatch" },
  { point: "dispatchReds:before-verdict-insert", surface: "dispatch" },
  { point: "dispatchReds:inside-verdict-insert-txn", surface: "dispatch" },
  { point: "dispatchReds:after-verdict-insert", surface: "dispatch" },
  { point: "dispatchSingleStep:before-blocked-by-red", surface: "dispatch" },
  { point: "dispatchSingleStep:inside-blocked-by-red-txn", surface: "dispatch" },
  { point: "dispatchSingleStep:after-blocked-by-red", surface: "dispatch" },
  { point: "finalizePrimary:before-status-write", surface: "dispatch" },
  { point: "finalizePrimary:between-complete-status-and-event", surface: "dispatch" },
  { point: "finalizePrimary:between-awaiting-gate-status-and-event", surface: "dispatch" },
  { point: "gate:before-decision-write", surface: "gate" },
  { point: "gate:inside-decision-write-txn", surface: "gate" },
  { point: "gate:after-decision-write", surface: "gate" },
  { point: "gate:advance:between-complete-status-and-event", surface: "gate" },
  { point: "gate:advance:after-complete-write", surface: "gate" },
  { point: "gate:advance:fanout-reentry:before-reentry-write", surface: "gate" },
  { point: "gate:advance:fanout-reentry:inside-reentry-write-txn", surface: "gate" },
  { point: "gate:advance:fanout-reentry:after-reentry-write", surface: "gate" },
  { point: "gate:reject:before-fail-write", surface: "gate" },
  { point: "gate:reject:inside-txn-between-fail-and-recovery-mint", surface: "gate" },
  { point: "gate:reject:inside-txn-between-recovery-mint-and-event", surface: "gate" },
  { point: "gate:reject:after-recovery-mint", surface: "gate" },
  { point: "gate:reject:dedup:inside-txn-between-inputs-and-lineage", surface: "gate" },
  { point: "gate:reject:dedup:inside-txn-between-lineage-and-event", surface: "gate" },
  { point: "gate:request-changes:before-fail-write", surface: "gate" },
  { point: "gate:request-changes:between-fail-and-replacement-mint", surface: "gate" },
  { point: "gate:request-changes:between-replacement-mint-and-event", surface: "gate" },
  { point: "gate:request-changes:dedup:between-inputs-and-event", surface: "gate" },
  { point: "gate:after-branch", surface: "gate" },
  { point: "reconcile:before-fail-pipeline-unfinalized", surface: "reconcile" },
  { point: "reconcile:inside-fail-pipeline-unfinalized-txn", surface: "reconcile" },
  { point: "reconcile:before-fail-oom-killed", surface: "reconcile" },
  { point: "reconcile:inside-fail-oom-killed-txn", surface: "reconcile" },
  { point: "reconcile:before-fail-orphaned-work-may-persist", surface: "reconcile" },
  { point: "reconcile:inside-fail-orphaned-work-may-persist-txn", surface: "reconcile" },
  { point: "reconcile:before-fail-orphaned-no-result", surface: "reconcile" },
  { point: "reconcile:inside-fail-orphaned-no-result-txn", surface: "reconcile" },
  { point: "reconcile:before-complete-invoke-like", surface: "reconcile" },
  { point: "reconcile:inside-complete-invoke-like-txn", surface: "reconcile" },
  { point: "reconcile:before-complete-invoke-like-from-stdout", surface: "reconcile" },
  { point: "reconcile:inside-complete-invoke-like-from-stdout-txn", surface: "reconcile" },
  { point: "reconcile:before-backfill-complete-empty-result", surface: "reconcile" },
  { point: "reconcile:inside-backfill-complete-empty-result-txn", surface: "reconcile" },
  { point: "reconcile:before-fail-fanout-parent-unfinalized", surface: "reconcile" },
  { point: "reconcile:inside-fail-fanout-parent-unfinalized-txn", surface: "reconcile" },
  { point: "reconcile:before-fail-fanout-wave-orphaned", surface: "reconcile" },
  { point: "reconcile:inside-fail-fanout-wave-orphaned-txn", surface: "reconcile" },
  { point: "reconcile:before-fail-provisioning-phase-crash", surface: "reconcile" },
  { point: "reconcile:inside-fail-provisioning-phase-crash-txn", surface: "reconcile" },
];

// Every probe that actually fired, across every cell in the file. Asserted
// against the registry at the end: a kill point no scenario can reach is a
// production edit with zero coverage, and the suite must say so rather than
// quietly pass.
const FIRED = new Set<string>();

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
  exitInfoFake = DOCKER_KNOWS_NOTHING;
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

const RUNTIME = "fg530-runtime";
/** reconcile's stdout-recovery (FG-455 → FG-337 inferredResultFrom) only fires for a
 *  runtime whose log_format the provider-failure analyzer can read a final assistant
 *  message out of — today that is pi-jsonl. Without a pi-format runtime there is no
 *  path to the stdout-recovered completion write at all. */
const PI_RUNTIME = "fg530-pi-runtime";

function runtimeYaml(name: string, metadata: string): string {
  return `name: ${name}
description: FG-530 crash-matrix stub runtime
${metadata}image: test-image:latest
models:
  default: test-model
auth:
  mode: apikey
mounts:
  - host: "\${TASK_DIR}"
    container: /task
    mode: rw
invocation:
  command: echo
  args: ["stub"]
container:
  name: "forge-\${TASK_ID}"
result:
  file: /task/result.json
`;
}

function ensureRuntime(): void {
  const dir = join(process.env["FORGE_HOME"]!, "runtimes");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${RUNTIME}.yml`), runtimeYaml(RUNTIME, ""));
  writeFileSync(
    join(dir, `${PI_RUNTIME}.yml`),
    runtimeYaml(PI_RUNTIME, "runtime_kind: pi\nlog_format: pi-jsonl\n"),
  );
}

/** gate.ts loads the workflow BY NAME off FORGE_HOME (runNext takes it as an
 *  arg), so any gate-driven scenario needs the YAML on disk too. */
function writeWorkflowYaml(name: string, yaml: string): void {
  const dir = join(process.env["FORGE_HOME"]!, "workflows");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.yml`), yaml);
}

type ExecOpts = {
  redVerdict: "pass" | "fail";
  /** Omit tests_run from the primary's result so it FAILS the FG-523 validation
   *  contract — the only way to reach holdIfValidationContractFails's hold write. */
  primaryFailsContract?: boolean;
  /** Write NO result.json and leave a pi-jsonl narrative on stdout instead — the
   *  shape reconcile's stdout-recovered completion is built to recover from. */
  narrativeStdoutOnly?: boolean;
};

/** A clean pi run whose agent honored nothing but its own narrative: agent_end with
 *  a final assistant message and no result.json. analyzePiFailure reads the message
 *  out as finalAssistantText, which inferredResultFrom turns into a result for a
 *  narrative role. */
const PI_NARRATIVE_STDOUT = JSON.stringify({
  type: "agent_end",
  messages: [{ role: "assistant", content: "FG-530 fixture: the research narrative this run produced" }],
});

/** Fake docker layer. Primaries return an implementer-shaped result that (by
 *  default) SATISFIES the validation contract, so the contract hold is not the
 *  accidental outcome of every cell; reds return a verdict-shaped result.
 *  The red's finding carries real `evidence` and no file/line citation, so it
 *  survives validateVerdict (nothing to verify) and gradeFindings (evidence
 *  present ⇒ no severity downgrade) — an authoritative fail that actually
 *  blocks, which is what the blocked_by_red kill points need. */
function makeExec(opts: ExecOpts): DockerExecFn {
  return async ({ args, stdoutPath, stderrPath }) => {
    const nameIdx = args.indexOf("--name");
    const taskId = (nameIdx >= 0 ? (args[nameIdx + 1] ?? "") : "").replace(/^forge-/, "");
    const dir = dirname(stdoutPath);
    mkdirSync(dir, { recursive: true });

    if (opts.narrativeStdoutOnly) {
      writeFileSync(stdoutPath, PI_NARRATIVE_STDOUT);
      writeFileSync(stderrPath, "");
      return 0;
    }

    const isRed = taskId.includes("red") || taskId.includes("reviewer");
    // The fanout scenario's upstream step: its result carries the array the
    // fanout step reads (`from_upstream.array_key`). One element ⇒ one child.
    const isFanoutUpstream = taskId.startsWith("task-plan-");
    const result = isRed
      ? {
          status: "complete",
          verdict: opts.redVerdict,
          confidence: 0.9,
          findings:
            opts.redVerdict === "fail"
              ? [
                  {
                    severity: "high",
                    summary: "seeded authoritative failure (FG-530 crash-matrix fixture)",
                    evidence:
                      "the crash-matrix arms this red to fail so the primary reaches the blocked_by_red write boundary",
                    hypothesis: "n/a — fixture",
                  },
                ]
              : [],
        }
      : opts.primaryFailsContract
        ? { status: "complete", files_modified: [] }
        : isFanoutUpstream
          ? { status: "complete", tests_run: 1, files_modified: [], units: ["alpha"] }
          : { status: "complete", tests_run: 1, files_modified: [] };

    writeFileSync(join(dir, "result.json"), JSON.stringify(result));
    writeFileSync(stdoutPath, "stub stdout");
    writeFileSync(stderrPath, "");
    return 0;
  };
}

function step(id: string, over: Partial<Step> = {}): Step {
  return {
    id,
    agent: "engineer",
    gate: "auto",
    manual: false,
    depends_on: [],
    runtime: RUNTIME,
    reds: [],
    ...over,
  };
}

// ── scenarios (v1: deliberately small — the kill-point axis is the coverage) ───

type Scenario = {
  name: string;
  workflow: Workflow;
  yaml: string;
  exec: ExecOpts;
  /** Drive the run the way an operator would, to completion or to a gate.
   *  Each call is crash-able: the hook throws from inside whichever write
   *  boundary it targets, and nothing after it runs. */
  drive: (runId: string, workflow: Workflow, exec: DockerExecFn) => Promise<void>;
  /** Put the run in the state a `reconcile` kill point exists to recover FROM
   *  (hook off — this is the FIRST crash; the reconcile cell is the second).
   *  Defaults to strandMidFinalize, a primary stranded mid-finalize. A recovery
   *  that acts on a different stranded shape needs its own. */
  strand?: (sc: Scenario, runId: string, exec: DockerExecFn) => Promise<void>;
  /** What `docker inspect` reports for the dead container. Defaults to "nothing
   *  known" — only the OOM landing needs docker to have witnessed the kill. */
  exitInfo?: ExitInfoFake;
};

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

function primaryOf(runId: string, phase: string): Task | undefined {
  return tasksForRun(runId).find((t) => t.phase === phase && isPhasePrimaryRow(t));
}

/** A phase can hold several primary rows once a gate has failed one and minted a
 *  replacement, so the gate-driving scenarios must name the one actually AT a
 *  gate — primaryOf() would hand back the failed original. */
function awaitingGatePrimary(runId: string, phase: string): Task | undefined {
  return tasksForRun(runId).find(
    (t) => t.phase === phase && isPhasePrimaryRow(t) && t.status === "awaiting_gate",
  );
}

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

// ── the crash driver ──────────────────────────────────────────────────────────

class CrashInjected extends Error {
  constructor(readonly point: string) {
    super(`FG-530 crash injected at ${point}`);
  }
}

/** The dead process reaching for the store AFTER the kill. A subclass so the
 *  driver swallows it exactly like the kill itself — it IS the kill, just observed
 *  one call later. */
class DeadProcessStoreAccess extends CrashInjected {
  constructor(point: string) {
    super(point);
    this.message = `FG-530: the process died at ${point} — it cannot touch the store again`;
  }
}

/** A DB handle a dead process holds: every access throws. Throwing a THROW is the
 *  only faithful model of the kill, because the code under test is allowed to catch.
 *
 *  reconcile.ts's FG-459 guards deliberately swallow any throw from one task's
 *  writes and keep sweeping — the right production contract (a SQLITE_BUSY must not
 *  abort the pass), and fatal to the crash model if the injected throw is all we do:
 *  a "dead" process would go on reconciling, finalizing, and completing state that a
 *  real crash could never have written, and the fresh recovery pass would start from
 *  a world the crash never produced. So the hook ALSO takes the store away. The
 *  guards may still catch the throw; they cannot make the dead process write. */
function deadDb(point: string): DatabaseInstance {
  return new Proxy({} as DatabaseInstance, {
    get() {
      throw new DeadProcessStoreAccess(point);
    },
  });
}

/** Arm the hook at ONE point, run `fn`, swallow only OUR injected crash.
 *  Any other throw is a real failure and propagates.
 *
 *  At the probe the process DIES: the store is replaced with `deadDb` and the throw
 *  goes up. Whatever catches it (reconcile's FG-459 guards; a runNext/gate handler)
 *  can no longer read or write a row, so no state mutates after the kill and the
 *  fresh pass in step 3 starts from exactly the world the crash left behind. The real
 *  DB is restored when the crashed call unwinds. */
async function crashAt(
  point: string,
  fn: () => Promise<unknown> | unknown,
  onFire?: () => void,
): Promise<boolean> {
  let fired = false;
  setCrashHookForTest((p) => {
    if (p !== point) return;
    // onFire runs at the INSTANT of death — before the store is taken away, the only
    // moment the pre-kill world is observable. Once only: the process dies here.
    if (!fired) {
      fired = true;
      onFire?.();
    }
    setDbForTest(deadDb(p));
    throw new CrashInjected(p);
  });
  try {
    await fn();
  } catch (e) {
    if (!(e instanceof CrashInjected)) throw e;
  } finally {
    setCrashHookForTest(undefined);
    setDbForTest(db); // the crashed process is gone; the fresh pass gets a live store
  }
  if (fired) FIRED.add(point);
  return fired;
}

/** docker's answer to `inspect` for the dead container, per scenario. Default: it
 *  knows nothing. Set from the scenario in runCrashPhase so the recovery passes
 *  (which reconcile the SAME dead world) see the same answer the crash pass did. */
type ExitInfoFake = () => { exitCode?: number; oomKilled?: boolean };
const DOCKER_KNOWS_NOTHING: ExitInfoFake = () => ({});
let exitInfoFake: ExitInfoFake = DOCKER_KNOWS_NOTHING;

const RECONCILE_FAKES = [
  () => false, // containerAlive: the crashed process's containers are gone
  () => "not_found" as const, // reapContainer
] as const;

function reconcile(runId: string): void {
  reconcileRun(runId, RECONCILE_FAKES[0], RECONCILE_FAKES[1], exitInfoFake);
}

/** Strand a task mid-finalize the way a real crash does: the container ran and
 *  wrote result.json, but the host-side finalize never happened, so the row is
 *  still `running`. This is the state reconcile's own writes exist to clean up,
 *  and therefore the precondition for exercising a `reconcile` kill point. */
async function strandMidFinalize(sc: Scenario, runId: string, exec: DockerExecFn): Promise<void> {
  await crashAt("dispatchSingleStep:after-result-ingest", () => sc.drive(runId, sc.workflow, exec));
}

const strandFor = (sc: Scenario): NonNullable<Scenario["strand"]> => sc.strand ?? strandMidFinalize;

/** Strand a task the way the container-gone sweep's three failure landings need it:
 *  `running`, container gone, and NOTHING recoverable. The container ran (so
 *  container.started is on the record and the sweep looks at the task at all), but
 *  the result never survived — result.json is removed, and the stub runtime declares
 *  no log_format, so the FG-337 stdout synthesizer has nothing to infer from either.
 *  Which of the three landings reconcile then chooses is decided purely by the
 *  evidence the scenario adds on top (docker's OOM verdict, a dirty work path). */
async function strandWithNoRecoverableResult(sc: Scenario, runId: string, exec: DockerExecFn): Promise<void> {
  await strandMidFinalize(sc, runId, exec);
  const t = primaryOf(runId, "build");
  assert.ok(t, "the primary must exist for this strand to mean anything");
  rmSync(join(taskDir(runId, t.id), "result.json"), { force: true });
}

/** Make `git status --porcelain` report changed files at the task's work path — the
 *  evidence that separates orphaned_work_may_persist from a plain orphan. The run's
 *  projectDir IS that path here (no dedicated worktree: worktree mode is macOS-only
 *  and off in the matrix), which is the `project_dir_shared` source reconcile records. */
function dirtyWorkPath(runId: string): void {
  const dir = getRun(runId)?.projectDir;
  assert.ok(dir, "the run must have a projectDir to dirty");
  execFileSync("git", ["init", "-q"], { cwd: dir, stdio: "ignore" });
  writeFileSync(join(dir, "work-the-agent-may-have-persisted.txt"), "uncommitted");
}

/** `persistedPreKill` is measured INSIDE the crash hook — the state of the world
 *  at the instant the process died, which is what invariant 4 is about. Capturing
 *  it after the driver returns (as v1 did) would miss any result or worktree the
 *  injected sequence discarded on its way down: the baseline would already be the
 *  post-discard state, and the invariant could never see it.
 *
 *  A cell whose scenario never reaches its kill point runs to its natural end; the
 *  post-drive state is then the only baseline there is, and the invariant still
 *  holds recovery to it. */
async function runCrashPhase(
  sc: Scenario,
  runId: string,
  exec: DockerExecFn,
  kp: KillPoint,
): Promise<{ fired: boolean; persistedPreKill: PersistedWork }> {
  let atKill: PersistedWork | undefined;
  const measure = (): void => {
    atKill = capturePersistedWork(runId);
  };

  exitInfoFake = sc.exitInfo ?? DOCKER_KNOWS_NOTHING;

  let fired: boolean;
  if (kp.surface === "reconcile") {
    await strandFor(sc)(sc, runId, exec);
    fired = await crashAt(kp.point, () => reconcile(runId), measure);
  } else {
    fired = await crashAt(kp.point, () => sc.drive(runId, sc.workflow, exec), measure);
  }
  return { fired, persistedPreKill: atKill ?? capturePersistedWork(runId) };
}

// ── state snapshot + fixpoint ─────────────────────────────────────────────────

/** Everything a recovery pass could write, at FULL row fidelity. Two identical
 *  snapshots ⇒ the pass was a no-op ⇒ fixpoint.
 *
 *  It reads `SELECT *` over the real tables rather than projecting named fields:
 *  a projection only sees what someone remembered to list, so a pass that
 *  rewrote a result body, a task_package's inputs, a worktree path or a
 *  started_at could read as a "no-op" and the fixpoint assertion would vouch for
 *  a write it never looked at. With `SELECT *` a new column is covered the day
 *  it is added, by default rather than by remembering.
 *
 *  Column values are compared as SQLite returns them — raw TEXT, not parsed and
 *  re-normalized. That is deliberately the strict end: a row rewritten with the
 *  same logical JSON but different key order IS a write, and a write must fail
 *  the no-op assertion. NOTHING is excluded for the same reason — a timestamp
 *  column that ticks is the very evidence the pass wrote.
 *
 *  Events are per-owner (task id, or `<run>` for run-level rows) COUNT + TAIL:
 *  the count catches a pass that re-logs an event without changing a status
 *  (a state change, and an unbounded-event-growth bug), the tail names what it
 *  logged so the failure is diagnosable without a second run. */
type Row = Record<string, unknown>;
type Snapshot = {
  run: Row | null;
  tasks: Row[];
  verdicts: Row[];
  gates: Row[];
  events: Record<string, { count: number; tail: Row[] }>;
};

const EVENT_TAIL = 5;

function sqlRows(sql: string, ...params: unknown[]): Row[] {
  return getDb().prepare(sql).all(...params) as Row[];
}

function snapshot(runId: string): Snapshot {
  const tasks = sqlRows("SELECT * FROM tasks WHERE run_id = ? ORDER BY id", runId);
  const events: Snapshot["events"] = {};
  for (const e of sqlRows(
    `SELECT * FROM events
      WHERE run_id = ? OR task_id IN (SELECT id FROM tasks WHERE run_id = ?)
      ORDER BY id`,
    runId,
    runId,
  )) {
    const owner = (e["task_id"] as string | null) ?? "<run>";
    const bucket = (events[owner] ??= { count: 0, tail: [] });
    bucket.count += 1;
    bucket.tail.push(e);
    if (bucket.tail.length > EVENT_TAIL) bucket.tail.shift();
  }
  return {
    run: sqlRows("SELECT * FROM runs WHERE id = ?", runId)[0] ?? null,
    tasks,
    verdicts: sqlRows(
      "SELECT v.* FROM verdicts v JOIN tasks t ON t.id = v.task_id WHERE t.run_id = ? ORDER BY v.id",
      runId,
    ),
    gates: sqlRows("SELECT g.* FROM gates g JOIN tasks t ON t.id = g.task_id WHERE t.run_id = ? ORDER BY g.id", runId),
    events,
  };
}

const snapshotKey = (s: Snapshot): string => JSON.stringify(s);

/** Deep diff, so a violation names the COLUMN that moved (`tasks[0].result`)
 *  rather than dumping two walls of JSON at the reader. */
function diffSnapshots(before: Snapshot, after: Snapshot): string[] {
  const out: string[] = [];
  const trunc = (v: unknown): string => {
    const s = JSON.stringify(v) ?? "undefined";
    return s.length > 200 ? `${s.slice(0, 200)}…` : s;
  };
  const isObj = (v: unknown): v is Row => typeof v === "object" && v !== null && !Array.isArray(v);
  const walk = (a: unknown, b: unknown, path: string): void => {
    if (JSON.stringify(a) === JSON.stringify(b)) return;
    if (isObj(a) && isObj(b)) {
      for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) walk(a[k], b[k], `${path}.${k}`);
      return;
    }
    if (Array.isArray(a) && Array.isArray(b)) {
      for (let i = 0; i < Math.max(a.length, b.length); i++) walk(a[i], b[i], `${path}[${i}]`);
      return;
    }
    out.push(`${path}: ${trunc(a)} → ${trunc(b)}`);
  };
  walk(before, after, "");
  return out;
}

const FIXPOINT_CAP = 12;

/** One recovery pass: what a fresh `forge next` after a crash actually does. */
async function recoveryPass(runId: string, workflow: Workflow, exec: DockerExecFn): Promise<void> {
  reconcile(runId);
  await runNext({ runId, workflow, dockerExec: exec });
}

/** Invariant 5's driver: reconcile + runNext until nothing changes. Fails on
 *  the cap rather than looping — a recovery that never converges is the wedge
 *  this whole harness exists to catch. */
async function recoverToFixpoint(runId: string, workflow: Workflow, exec: DockerExecFn): Promise<number> {
  let before = snapshotKey(snapshot(runId));
  for (let pass = 1; pass <= FIXPOINT_CAP; pass++) {
    await recoveryPass(runId, workflow, exec);
    const after = snapshotKey(snapshot(runId));
    if (after === before) return pass;
    before = after;
  }
  throw new Error(
    `INVARIANT 5 (fixpoint) VIOLATED: recovery did not converge in ${FIXPOINT_CAP} reconcile+runNext passes — state still changing. Final state: ${before}`,
  );
}

// ── the five invariants, as named checkers ────────────────────────────────────

type Violation = { invariant: string; detail: string };

const TERMINAL: ReadonlySet<TaskStatus> = new Set<TaskStatus>(["complete", "failed"]);

function failureKindOf(taskId: string): string | undefined {
  const failed = eventsForTask(taskId).filter((e) => e.eventType === "task.failed");
  const last = failed[failed.length - 1];
  const payload = last?.payload as { failure_kind?: string } | null | undefined;
  return payload?.failure_kind;
}

/** A gate.decided event with force:true is the AUDITED human override — the one
 *  documented way a task may complete over a blocking verdict or a validation
 *  hold. Anything else completing over them is a lost evidence chain. */
function hasForcedGateAdvance(taskId: string): boolean {
  return eventsForTask(taskId).some((e) => {
    if (e.eventType !== "gate.decided") return false;
    const p = e.payload as { decision?: string; force?: boolean } | null;
    return p?.decision === "advance" && p?.force === true;
  });
}

function hasValidationWaiver(taskId: string): boolean {
  return eventsForTask(taskId).some((e) => {
    if (e.eventType !== "task.decision") return false;
    const p = e.payload as { kind?: string } | null;
    return p?.kind === "validation_waiver";
  });
}

/** INVARIANT 1 — no `complete` without its evidence chain.
 *  A completed workflow primary must carry: its result, no BLOCKING verdict
 *  (the pre-FG-482 two-write dance is exactly a complete task with an
 *  authoritative fail on it), a verdict row for every gating red the step
 *  declares, and a satisfied-or-waived validation contract. */
function checkNoCompleteWithoutEvidence(runId: string, workflow: Workflow): Violation[] {
  const v: Violation[] = [];
  const name = "1-no-complete-without-evidence-chain";
  for (const t of tasksForRun(runId)) {
    if (t.status !== "complete") continue;
    if (!isPhasePrimaryRow(t)) continue;
    const st = findStep(workflow, t.phase);
    if (!st || st.manual) continue;

    if (t.result === undefined || t.result === null) {
      v.push({ invariant: name, detail: `task ${t.id} (${t.phase}) is complete with NO result on its row` });
    }

    const verdicts = verdictsForTask(t.id);
    const blocking = verdicts.filter((row) =>
      verdictBlocksGate({ verdict: row.verdict, authority: row.authority, gateOnVerdict: row.gateOnVerdict }),
    );
    if (blocking.length > 0 && !hasForcedGateAdvance(t.id)) {
      v.push({
        invariant: name,
        detail:
          `task ${t.id} (${t.phase}) is complete while carrying ${blocking.length} BLOCKING verdict(s) ` +
          `[${blocking.map((b) => `${b.redRole}=${b.verdict}/${b.authority}`).join(", ")}] and no forced gate advance — ` +
          `a red's block was overwritten by a completion (the pre-FG-427/FG-482 two-write dance)`,
      });
    }

    // Per-role, per-count — not "are there ANY verdicts". A step declaring two
    // gating reds that completes carrying one passing verdict has lost half its
    // evidence chain, and a bare emptiness test reads that as fine.
    const gatingReds = st.reds.filter((r) => r.authority === "authoritative" && r.gate_on_verdict !== false);
    if (gatingReds.length > 0 && !hasForcedGateAdvance(t.id)) {
      const landed = new Map<string, number>();
      for (const row of verdicts) landed.set(row.redRole, (landed.get(row.redRole) ?? 0) + 1);
      const declared = new Map<string, number>();
      for (const r of gatingReds) declared.set(r.agent, (declared.get(r.agent) ?? 0) + 1);

      const short = [...declared]
        .filter(([role, want]) => (landed.get(role) ?? 0) < want)
        .map(([role, want]) => `${role} (${landed.get(role) ?? 0}/${want} verdict rows)`);

      if (short.length > 0) {
        v.push({
          invariant: name,
          detail:
            `task ${t.id} (${t.phase}) is complete but its step declares ${gatingReds.length} gating red(s) ` +
            `[${gatingReds.map((r) => r.agent).join(", ")}] and the verdict rows are MISSING for [${short.join(", ")}] — ` +
            `completed without the red evidence`,
        });
      }
    }

    // The contract binds the shapes production actually gates: single-step
    // primaries. A fanout PARENT is exempt, mirroring the FG-523 carve-out at
    // holdIfValidationContractFails (runNext.ts) — the parent runs no container,
    // and its result is a synthetic {status, children} aggregate that never
    // carries tests_run. Holding it here would make the checker stricter than the
    // contract it audits, and would flag every healthy wave. The real agent
    // results live on the CHILDREN, which are ungated today (they finalize via
    // markTaskComplete, not finalizePrimary) — a known gap, FG-524. They fall out
    // of this loop anyway: a child has a parentId, so isPhasePrimaryRow skips it.
    // When FG-524 lands, the child rows are what this invariant should grow to.
    const isFanoutParent = st.fanout !== undefined;
    const contract = isFanoutParent
      ? ({ held: false } as const)
      : evaluateValidationContract({ role: t.agentRole, result: t.result });
    if (contract.held && !hasValidationWaiver(t.id) && !hasForcedGateAdvance(t.id)) {
      v.push({
        invariant: name,
        detail: `task ${t.id} (${t.phase}) is complete but fails the validation contract (${contract.reason}) with no waiver and no forced gate advance`,
      });
    }
  }
  return v;
}

/** INVARIANT 2 — no permanent wedge.
 *  Every NON-TERMINAL task must have an enabled transition (its phase is in the
 *  ready queue — which is also how a live recovery/replacement row re-admits a
 *  phase) or a NAMED operator verb. Every TERMINAL-failed task must leave the
 *  operator a concrete verb too: retryPolicy is the production answer, so a
 *  failure kind that is neither retryable nor carrying `forge ...` advice is a
 *  dead end with nothing to type. */
function checkNoPermanentWedge(runId: string, workflow: Workflow): Violation[] {
  const v: Violation[] = [];
  const name = "2-no-permanent-wedge";
  const tasks = tasksForRun(runId);
  const ready = new Set(computeReadyQueue(workflow, tasks).map((s) => s.id));

  for (const t of tasks) {
    if (TERMINAL.has(t.status)) {
      if (t.status !== "failed") continue;
      const kind = failureKindOf(t.id);
      const disposition = retryPolicy(kind, t.id);
      const verb = disposition.retryable
        ? `forge retry ${t.id}`
        : (disposition.advice ?? "").includes("forge ")
          ? disposition.advice
          : undefined;
      if (!verb) {
        v.push({
          invariant: name,
          detail:
            `failed task ${t.id} (${t.phase}, failure_kind=${kind ?? "none"}) is not retryable and retryPolicy offers ` +
            `no concrete operator command — the operator has nothing to type`,
        });
      }
      continue;
    }

    // Non-terminal: an enabled transition, or a named operator verb.
    if (ready.has(t.phase)) continue;
    if (t.status === "awaiting_gate" || t.status === "blocked_by_red") continue; // `forge gate <id> ...`
    if (t.status === "running") {
      // Whether container.started landed is the discriminator, not colour: it is the
      // event BOTH sweeps gate on, so a `running` row without it is unsweepable BY
      // CONSTRUCTION (FG-533) while one WITH it means the container-gone sweep itself
      // failed — a different, unknown bug. Naming it here is what lets the FG-533 pin
      // below match the first without absorbing the second.
      const started = eventsForTask(t.id).some((e) => e.eventType === "container.started");
      v.push({
        invariant: name,
        detail:
          `task ${t.id} (${t.phase}) is still 'running' at fixpoint — reconcile did not sweep it and no pass will ` +
          `[container.started seen: ${started ? "yes" : "no"}]`,
      });
      continue;
    }
    v.push({
      invariant: name,
      detail:
        `task ${t.id} (${t.phase}) is non-terminal ('${t.status}') but its phase is NOT in the ready queue ` +
        `[${[...ready].join(", ") || "empty"}] and its status carries no operator verb — permanently wedged`,
    });
  }

  const run = getRun(runId);
  if (run?.status === "active" && ready.size === 0 && !tasks.some((t) => !TERMINAL.has(t.status))) {
    v.push({
      invariant: name,
      detail: `run ${runId} is still 'active' with an empty ready queue and no non-terminal task — nothing will ever move it`,
    });
  }
  return v;
}

/** INVARIANT 3 — `abandoned` is never overwritten by completion.
 *  Task rows have no `abandoned` status (RunStatus does), so this is the run:
 *  a run abandoned before recovery must never be resurrected to complete. */
function checkAbandonedNeverOverwritten(runId: string, wasAbandoned: boolean): Violation[] {
  if (!wasAbandoned) return [];
  const run = getRun(runId);
  if (run?.status === "abandoned") return [];
  return [
    {
      invariant: "3-abandoned-never-overwritten",
      detail: `run ${runId} was 'abandoned' before recovery but is now '${run?.status}' — recovery resurrected a cancelled run`,
    },
  ];
}

type PersistedResult = { taskId: string; resultPath: string; bytes: string };
type PersistedWorktree = { taskId: string; worktreePath: string };
/** The two things an agent leaves on disk: its result.json and, in worktree mode,
 *  the git worktree it worked in. Both are the crashed step's evidence, and both
 *  are what FG-352's no-discard rule keeps around after a failure. */
type PersistedWork = { results: PersistedResult[]; worktrees: PersistedWorktree[] };

/** Snapshot the work the containers actually persisted. Call it AT the kill (see
 *  runCrashPhase) — a snapshot taken after the injected sequence unwinds cannot
 *  tell "never existed" from "existed and was discarded".
 *
 *  Worktrees are only ever populated when worktree mode is armed
 *  (FORGE_WORKTREES=1) AND preflightWorktreeGate passes — it is macOS-only, so on
 *  Linux/CI the matrix cells carry none and this half of invariant 4 is inert
 *  there. Its detection power is proven directly instead, by the worktree-discard
 *  test below. */
function capturePersistedWork(runId: string): PersistedWork {
  const results: PersistedResult[] = [];
  const worktrees: PersistedWorktree[] = [];
  for (const t of tasksForRun(runId)) {
    const p = join(taskDir(runId, t.id), "result.json");
    // An EMPTY result.json is not persisted work: runContainer writes a zero-byte
    // placeholder into the task dir BEFORE the container launches (so the mount has
    // the file to write into). A pre-container crash therefore always leaves one, and
    // counting it as work would make every recovery that fails such a task read as a
    // discard — the invariant would fire on a task whose agent never ran and produced
    // nothing to lose. Work is what the CONTAINER wrote, which is never empty.
    const bytes = existsSync(p) ? readFileSync(p, "utf8") : "";
    if (bytes.trim().length > 0) results.push({ taskId: t.id, resultPath: p, bytes });
    if (t.worktreePath && existsSync(t.worktreePath)) {
      worktrees.push({ taskId: t.id, worktreePath: t.worktreePath });
    }
  }
  return { results, worktrees };
}

const NO_PERSISTED_WORK: PersistedWork = { results: [], worktrees: [] };

/** INVARIANT 4 — persisted work is never discarded.
 *  A result.json that existed before the kill must (a) still exist byte-identical
 *  after recovery, and (b) still be REFERENCED by its task row once that row is
 *  terminal — reconcile's failPipelineUnfinalized preserves the result onto the
 *  row precisely so a crashed step's work is inspectable, not silently dropped.
 *  A worktree that existed before the kill must survive too, unless its task went
 *  on to COMPLETE: removeWorktreeIfSafe is only ever called on a proven-merged
 *  worktree, so a crashed or failed step losing its worktree is the work-discard
 *  this invariant is named for. */
function checkPersistedWorkNeverDiscarded(pre: PersistedWork): Violation[] {
  const v: Violation[] = [];
  const name = "4-persisted-work-never-discarded";
  for (const w of pre.results) {
    if (!existsSync(w.resultPath)) {
      v.push({ invariant: name, detail: `result.json for task ${w.taskId} existed before the kill and is GONE after recovery (${w.resultPath})` });
      continue;
    }
    const now = readFileSync(w.resultPath, "utf8");
    if (now !== w.bytes) {
      v.push({ invariant: name, detail: `result.json for task ${w.taskId} was REWRITTEN during recovery (persisted work must be preserved verbatim)` });
    }
    const t = getTask(w.taskId);
    if (!t) {
      v.push({ invariant: name, detail: `task ${w.taskId} had persisted work but its row VANISHED during recovery` });
      continue;
    }
    if (TERMINAL.has(t.status) && (t.result === undefined || t.result === null)) {
      v.push({
        invariant: name,
        detail:
          `task ${w.taskId} persisted a result before the kill and is now terminal ('${t.status}') with NO result on its row — ` +
          `the work is orphaned on disk with nothing pointing at it`,
      });
    }
  }
  for (const w of pre.worktrees) {
    if (existsSync(w.worktreePath)) continue;
    const t = getTask(w.taskId);
    if (t?.status === "complete") continue; // proven-merged cleanup — the one sanctioned removal
    v.push({
      invariant: name,
      detail:
        `the worktree for task ${w.taskId} existed before the kill and is GONE after recovery (${w.worktreePath}), ` +
        `while the task is '${t?.status ?? "missing"}' — an unmerged step's worktree is its only copy of the work`,
    });
  }
  return v;
}

/** INVARIANT 5 — fixpoint is idempotent: one more full pass changes nothing.
 *
 *  `pass` is the recovery pass under test and defaults to the real one; every
 *  matrix cell uses that default. The detection suite substitutes a pass that
 *  writes ONE persisted field, which is how the SNAPSHOT's fidelity gets proven
 *  rather than assumed — a checker whose snapshot cannot see a write cannot
 *  honestly report "no-op", and that is precisely what it used to do. */
async function checkFixpointIdempotent(
  runId: string,
  workflow: Workflow,
  exec: DockerExecFn,
  pass: (runId: string, workflow: Workflow, exec: DockerExecFn) => Promise<void> = recoveryPass,
): Promise<Violation[]> {
  const before = snapshot(runId);
  await pass(runId, workflow, exec);
  const after = snapshot(runId);
  if (snapshotKey(before) === snapshotKey(after)) return [];
  return [
    {
      invariant: "5-fixpoint-idempotent",
      detail:
        `a second reconcile+runNext pass after fixpoint CHANGED state:\n` +
        diffSnapshots(before, after)
          .map((d) => `    ${d}`)
          .join("\n"),
    },
  ];
}

async function checkAllInvariants(args: {
  runId: string;
  workflow: Workflow;
  exec: DockerExecFn;
  persistedPreKill: PersistedWork;
  wasAbandoned: boolean;
}): Promise<Violation[]> {
  return [
    ...checkNoCompleteWithoutEvidence(args.runId, args.workflow),
    ...checkNoPermanentWedge(args.runId, args.workflow),
    ...checkAbandonedNeverOverwritten(args.runId, args.wasAbandoned),
    ...checkPersistedWorkNeverDiscarded(args.persistedPreKill),
    ...(await checkFixpointIdempotent(args.runId, args.workflow, args.exec)),
  ];
}

function formatViolations(vs: Violation[]): string {
  return vs.map((x) => `  [${x.invariant}] ${x.detail}`).join("\n");
}

// ── known failures: REAL bugs this harness found on HEAD ───────────────────────
//
// FG-530's scope guard is explicit — a kill point that exposes a real bug gets
// FILED, not fixed here. Each is pinned below as a `todo` test with a minimal
// repro; the matrix tolerates exactly these three signatures and nothing else, so
// the suite stays green while any NEW invariant break still fails loudly.
//
// Deliberately signature-matched rather than listed by cell name: a hardcoded
// list of ~24 (scenario, kill point) pairs would silently absorb a different bug
// that happened to land in one of those cells. The signatures are correspondingly
// narrow — FG-533's names the MISSING container.started event, not merely a
// `running` task, so a container-gone sweep that started failing would not hide
// behind it.

type KnownFailure = { id: string; invariant: string; match: RegExp; summary: string };

const KNOWN_FAILURES: KnownFailure[] = [
  {
    id: "FG-530-A",
    invariant: "2-no-permanent-wedge",
    match: /is non-terminal \('awaiting_red'\)/,
    summary:
      "a crash in the window between the awaiting_red status write and the reds' terminal write wedges the task at " +
      "awaiting_red FOREVER: reconcile only sweeps `running` rows, computeReadyQueue treats awaiting_red as live work " +
      "(so the phase is never re-admitted and the run never settles), `forge gate` refuses any status but " +
      "awaiting_gate/blocked_by_red, and `forge retry` refuses any status but failed. advise.ts tells the operator to " +
      "'wait for reds to finish' — reds that died with the crashed process.",
  },
  {
    id: "FG-530-B",
    invariant: "4-persisted-work-never-discarded",
    match: /is now terminal \('failed'\) with NO result on its row/,
    summary:
      "gate.ts's REJECT branch calls failTask() without `result`, and markTaskFailed's UPDATE writes `result = ?` with " +
      "null when it is absent — so rejecting a task NULLs the result markTaskAwaitingGate had put on its row. The " +
      "adjacent request-changes branch passes `result: task.result` precisely to avoid this ('preserving its result so " +
      "it stays an audit record'), which makes the asymmetry look unintended. Not crash-specific: a clean `forge gate " +
      "<id> reject` discards it. result.json survives on disk, so the work is recoverable, but the row the operator " +
      "surfaces read loses the rejected artifact.",
  },
  {
    id: "FG-533",
    invariant: "2-no-permanent-wedge",
    match: /is still 'running' at fixpoint .*\[container\.started seen: no\]/,
    summary:
      "runContainer marks the task `running` and appends task.started BEFORE the container launches; the span that follows " +
      "(image pull, auth staging, dependency provisioning) is minutes long. A crash inside it leaves a `running` task with " +
      "NO container.started — and container.started is exactly the event both rescue paths gate on (reconcile.ts's per-task " +
      "loop, `if (!hasContainerStarted) continue`, and src/ops/reconcile-candidate.ts's SQL), while `forge retry` refuses " +
      "any status but failed. Permanent wedge, same family as FG-530-A. Filed as FG-533; the pin flips to a passing " +
      "assertion when its recovery path lands.",
  },
];

const KNOWN_HIT = new Set<string>();

function partitionKnown(vs: Violation[]): { unexpected: Violation[]; known: KnownFailure[] } {
  const unexpected: Violation[] = [];
  const known: KnownFailure[] = [];
  for (const v of vs) {
    const k = KNOWN_FAILURES.find((kf) => kf.invariant === v.invariant && kf.match.test(v.detail));
    if (k) {
      known.push(k);
      KNOWN_HIT.add(k.id);
    } else {
      unexpected.push(v);
    }
  }
  return { unexpected, known };
}

// ── the matrix ────────────────────────────────────────────────────────────────

for (const sc of SCENARIOS) {
  for (const kp of KILL_POINTS) {
    test(`FG-530 matrix [${sc.name}] kill @ ${kp.point}`, async () => {
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

      // 1–2. Drive to the kill point, measuring the persisted work AT the kill.
      // A cell whose scenario never reaches this boundary simply runs to its
      // natural end — the invariants must hold there too, so the cell still
      // asserts something; the registry-coverage test at the end is what proves
      // no kill point is unreachable everywhere.
      const { persistedPreKill } = await runCrashPhase(sc, runId, exec, kp);

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

test("FG-530 coverage: every kill point in the registry FIRED in at least one matrix cell — an unreachable probe is a production edit with no coverage", () => {
  const unfired = KILL_POINTS.filter((kp) => !FIRED.has(kp.point)).map((kp) => kp.point);
  assert.deepEqual(
    unfired,
    [],
    `these kill points never fired in any scenario — either a scenario is missing or the probe is dead code:\n  ${unfired.join("\n  ")}`,
  );
});
