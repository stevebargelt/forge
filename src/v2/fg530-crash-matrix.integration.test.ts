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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { Database as DatabaseInstance } from "better-sqlite3";

import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { insertTask, tasksForRun, getTask, setTaskWorktreePath } from "../store/tasks.js";
import { insertVerdict, verdictsForRun, verdictsForTask } from "../store/verdicts.js";
import { gatesForRun } from "../store/gates.js";
import { eventsForRun, eventsForTask } from "../store/events.js";
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
//   dispatch  — dispatchSingleStep's post-container sequence (result ingestion →
//               validation-contract hold → awaiting_red → verdict inserts →
//               blocked_by_red → finalizePrimary → event appends)
//   gate      — gate.ts's decision writes (advance, reject + on_reject recovery
//               mint OR dedup onto an existing recovery row, request-changes
//               replacement mint OR dedup onto an existing pending primary)
//   reconcile — reconcile.ts's own writes (the FG-479 failPipelineUnfinalized
//               landing, which is what a crashed pipeline step recovers INTO)
//
// A `reconcile` cell is a crash WHILE RECOVERING from a crash: reconcile's writes
// only have anything to act on once a task is already stranded mid-finalize, so
// the driver strands one first (hook off), then arms the hook for the recovery
// reconcile. See runCrashPhase.

type Surface = "dispatch" | "gate" | "reconcile";
type KillPoint = { point: string; surface: Surface };

const KILL_POINTS: KillPoint[] = [
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

function ensureRuntime(): void {
  const runtimePath = join(process.env["FORGE_HOME"]!, "runtimes", `${RUNTIME}.yml`);
  mkdirSync(dirname(runtimePath), { recursive: true });
  writeFileSync(
    runtimePath,
    `name: ${RUNTIME}
description: FG-530 crash-matrix stub runtime
image: test-image:latest
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
`,
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
};

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
];

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

/** Arm the hook at ONE point, run `fn`, swallow only OUR injected crash.
 *  Any other throw is a real failure and propagates.
 *
 *  reconcile.ts's FG-459 never-throw guards swallow the injected crash
 *  internally (that is the production contract: a DB throw reconciling one task
 *  must not abort the pass). The crash still did its job — the surrounding
 *  transaction rolled back, so that write group did not land — and `fired`
 *  records it, so a reconcile cell is exercised even though nothing escapes. */
async function crashAt(
  point: string,
  fn: () => Promise<unknown> | unknown,
  onFire?: () => void,
): Promise<boolean> {
  let fired = false;
  setCrashHookForTest((p) => {
    if (p !== point) return;
    // onFire runs at the INSTANT of death, before the throw — the only moment the
    // pre-kill world is observable. Once only: reconcile's FG-459 guards swallow
    // the throw and keep sweeping, so the same probe can fire again on a later
    // task, and that second firing is already post-rollback.
    if (!fired) {
      fired = true;
      onFire?.();
    }
    throw new CrashInjected(p);
  });
  try {
    await fn();
  } catch (e) {
    if (!(e instanceof CrashInjected)) throw e;
  } finally {
    setCrashHookForTest(undefined);
  }
  if (fired) FIRED.add(point);
  return fired;
}

const RECONCILE_FAKES = [
  () => false, // containerAlive: the crashed process's containers are gone
  () => "not_found" as const, // reapContainer
  () => ({}), // containerExitInfo: docker knows nothing
] as const;

function reconcile(runId: string): void {
  reconcileRun(runId, RECONCILE_FAKES[0], RECONCILE_FAKES[1], RECONCILE_FAKES[2]);
}

/** Strand a task mid-finalize the way a real crash does: the container ran and
 *  wrote result.json, but the host-side finalize never happened, so the row is
 *  still `running`. This is the state reconcile's own writes exist to clean up,
 *  and therefore the precondition for exercising a `reconcile` kill point. */
async function strandMidFinalize(sc: Scenario, runId: string, exec: DockerExecFn): Promise<void> {
  await crashAt("dispatchSingleStep:after-result-ingest", () => sc.drive(runId, sc.workflow, exec));
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

  let fired: boolean;
  if (kp.surface === "reconcile") {
    await strandMidFinalize(sc, runId, exec);
    fired = await crashAt(kp.point, () => reconcile(runId), measure);
  } else {
    fired = await crashAt(kp.point, () => sc.drive(runId, sc.workflow, exec), measure);
  }
  return { fired, persistedPreKill: atKill ?? capturePersistedWork(runId) };
}

// ── state snapshot + fixpoint ─────────────────────────────────────────────────

/** Everything a recovery pass could legitimately change. Two identical
 *  snapshots ⇒ the pass was a no-op ⇒ fixpoint. Events are included by COUNT:
 *  a pass that re-logs an event without changing status is still a state
 *  change (and an unbounded-event-growth bug), so it must not read as a
 *  fixpoint. */
function snapshot(runId: string): string {
  const tasks = tasksForRun(runId)
    .map((t) => ({
      id: t.id,
      phase: t.phase,
      status: t.status,
      parentId: t.parentId ?? null,
      hasResult: t.result !== undefined && t.result !== null,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const verdicts = verdictsForRun(runId)
    .map((v) => ({ id: v.id, taskId: v.taskId, verdict: v.verdict, authority: v.authority }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const gates = gatesForRun(runId)
    .map((g) => ({ id: g.id, taskId: g.taskId, decision: g.decision }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return JSON.stringify({
    runStatus: getRun(runId)?.status ?? "missing",
    tasks,
    verdicts,
    gates,
    eventCount: eventsForRun(runId).length,
  });
}

const FIXPOINT_CAP = 12;

/** Invariant 5's driver: reconcile + runNext until nothing changes. Fails on
 *  the cap rather than looping — a recovery that never converges is the wedge
 *  this whole harness exists to catch. */
async function recoverToFixpoint(runId: string, workflow: Workflow, exec: DockerExecFn): Promise<number> {
  let before = snapshot(runId);
  for (let pass = 1; pass <= FIXPOINT_CAP; pass++) {
    reconcile(runId);
    await runNext({ runId, workflow, dockerExec: exec });
    const after = snapshot(runId);
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

    const contract = evaluateValidationContract({ role: t.agentRole, result: t.result });
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
      v.push({
        invariant: name,
        detail: `task ${t.id} (${t.phase}) is still 'running' at fixpoint — reconcile did not sweep it and no pass will`,
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
    if (existsSync(p)) results.push({ taskId: t.id, resultPath: p, bytes: readFileSync(p, "utf8") });
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

/** INVARIANT 5 — fixpoint is idempotent: one more full pass changes nothing. */
async function checkFixpointIdempotent(runId: string, workflow: Workflow, exec: DockerExecFn): Promise<Violation[]> {
  const before = snapshot(runId);
  reconcile(runId);
  await runNext({ runId, workflow, dockerExec: exec });
  const after = snapshot(runId);
  if (before === after) return [];
  return [
    {
      invariant: "5-fixpoint-idempotent",
      detail: `a second reconcile+runNext pass after fixpoint CHANGED state.\nbefore: ${before}\nafter:  ${after}`,
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
// FILED, not fixed here. Both are pinned below as `todo` tests with minimal
// repros; the matrix tolerates exactly these two signatures and nothing else, so
// the suite stays green while any NEW invariant break still fails loudly.
//
// Deliberately signature-matched rather than listed by cell name: a hardcoded
// list of ~24 (scenario, kill point) pairs would silently absorb a different bug
// that happened to land in one of those cells.

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

test("FG-530: both known HEAD bugs still reproduce in the matrix — a pin that stops firing is a pin that has silently rotted", () => {
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
