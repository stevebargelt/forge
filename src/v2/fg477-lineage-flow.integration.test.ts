// FG-477 slice 1 — FLOW-level regression suite for the lineage classifier's three
// migrated consumers (ready-queue.ts, runNext.ts's dispatchSingleStep pending-row
// reuse, reconcile.ts's finalizeOrphanedPrimaries).
//
// The engineer's own tests (lifecycle-evaluator.test.ts) are PREDICATE-level: the
// decision table, generator totality/order-insensitivity, and frozen-legacy parity
// per consumer, all against classifyTaskLineage in isolation. These tests are
// FLOW-level: they drive the REAL runner (startRun → runNext with a faked docker
// layer → gate → reconcile) over a real store, and assert the OBSERVABLE outputs —
// which container was dispatched for which row, which rows the ready queue admits,
// what isRunSettled says, what reconcile sweeps. A classifier that is right in
// isolation but wired into a consumer wrongly fails here and passes there.
//
// Coverage map (the four shapes the classifier now decides):
//   (a) gate reject → on_reject recovery row dispatches from the recovery pickup
//   (b) a retry-replacement row (2nd parent-less row in a phase) is dispatched,
//       not the stale first
//   (c) an attached `forge invoke` row on a workflow DECLARING a `task` step is
//       NOT adopted by dispatchSingleStep (FG-507), and the run's own primary
//       still dispatches — plus the frozen-legacy counterpart (a marker-less row
//       in the same shape IS still adopted: legacy_ambiguous_invoke)
//   (d) finalizeOrphanedPrimaries sweeps only primaries when reds / fanout children
//       / recovery / ad-hoc rows are present and orphaned
//   (2) settle-state parity on a mixed run (ready queue + isRunSettled)
//   (3) order/duplicate adversarials: identical-createdAt tie; a recovery row whose
//       rejectedTaskId points at a task in ANOTHER phase
//
// Every red child here is deliberately named `shipping-reviewer` — a red whose
// agent name does NOT start with `red-`. That is the exact row the pre-FG-477
// role-name-prefix convention misclassified, so it is the row that proves the
// workflow-lookup rule is live in the migrated consumers.

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { runNext, type DockerExecFn } from "./runNext.js";
import { startRun } from "./startRun.js";
import { gate } from "./gate.js";
import { insertTask, getTask, tasksForRun, markTaskComplete } from "../store/tasks.js";
import { getRun } from "../store/runs.js";
import { finalizeOrphanedPrimaries } from "./reconcile.js";
import { computeReadyQueue, isRunSettled } from "./ready-queue.js";
import { classifyTaskLineage } from "./lifecycle-evaluator.js";
import type { Workflow, Step } from "./schema.js";
import type { Task } from "../types/index.js";

// ── shared harness ────────────────────────────────────────────────────────────

function ensureRuntime(): void {
  const runtimePath = join(process.env["FORGE_HOME"]!, "runtimes", "claude.yml");
  if (existsSync(runtimePath)) return;
  mkdirSync(dirname(runtimePath), { recursive: true });
  writeFileSync(
    runtimePath,
    `name: claude
description: test stub runtime
image: test-image:latest
models:
  default: test-model
auth:
  mode: apikey
mounts:
  - { host: "\${TASK_DIR}", container: /task }
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

/** gate.ts loads the workflow BY NAME off FORGE_HOME (runNext takes it as an arg),
 *  so any gate-driven flow needs the YAML on disk too. */
function writeWorkflowYaml(name: string, yaml: string): void {
  const dir = join(process.env["FORGE_HOME"]!, "workflows");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.yml`), yaml);
}

/** Docker exec fake keyed by container --name (== forge-<taskId>): records every
 *  task id a container was actually dispatched for, so a test can prove WHICH row
 *  ran — the observable the whole suite turns on. */
function makeRecordingExec(invoked: string[]): DockerExecFn {
  return async ({ args, stdoutPath, stderrPath }) => {
    const nameIdx = args.indexOf("--name");
    const fullName = nameIdx >= 0 ? (args[nameIdx + 1] ?? "") : "";
    invoked.push(fullName.replace(/^forge-/, ""));

    const dir = dirname(stdoutPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(stdoutPath, "stub stdout");
    writeFileSync(stderrPath, "");
    writeFileSync(join(dir, "result.json"), JSON.stringify({ status: "complete", tests_run: 1 }));
    return 0;
  };
}

function mkTask(opts: {
  id: string;
  runId: string;
  phase: string;
  status: Task["status"];
  parentId?: string;
  agentRole?: string;
  createdAt: string;
  inputs?: Record<string, unknown>;
  /** Omit explicitly (`dispatchSource: undefined`) to mint a marker-less LEGACY row. */
  dispatchSource?: "workflow" | "invoke";
}): Task {
  const role = opts.agentRole ?? "engineer";
  return {
    id: opts.id,
    runId: opts.runId,
    parentId: opts.parentId,
    phase: opts.phase,
    agentRole: role,
    status: opts.status,
    taskPackage: {
      taskId: opts.id,
      runId: opts.runId,
      phase: opts.phase,
      role,
      ...(opts.dispatchSource ? { dispatchSource: opts.dispatchSource } : {}),
      inputs: opts.inputs ?? {},
      composedSystemPrompt: "PROMPT",
    },
    createdAt: opts.createdAt,
  };
}

function insert(opts: Parameters<typeof mkTask>[0]): Task {
  const t = mkTask(opts);
  insertTask(t);
  return t;
}

function step(id: string, over: Partial<Step> = {}): Step {
  return {
    id,
    agent: "engineer",
    gate: "auto",
    manual: false,
    depends_on: [],
    runtime: "claude",
    reds: [],
    ...over,
  };
}

const PROJECT_DIR = "/tmp/test-project";

// ── (a) gate reject → on_reject recovery dispatches from the recovery pickup ────

const RECOVERY_WF: Workflow = {
  name: "fg477-recovery",
  description: "FG-477 flow: reject -> on_reject recovery, driven through the real gate",
  inputs: [],
  steps: [
    step("build"),
    step("review", { agent: "reviewer", gate: "human", depends_on: ["build"], on_reject: "build" }),
  ],
};

const RECOVERY_YAML = `name: fg477-recovery
description: FG-477 flow fixture
inputs: []
steps:
  - id: build
    agent: engineer
    gate: auto
  - id: review
    agent: reviewer
    gate: human
    depends_on: [build]
    on_reject: build
`;

test("FG-477 (a) flow: a REAL gate reject mints an on_reject recovery row, and the next runNext dispatches THAT row from the recovery pickup — not a fresh build primary", async () => {
  process.env["ANTHROPIC_API_KEY"] = "sk-stub";
  ensureRuntime();
  writeWorkflowYaml(RECOVERY_WF.name, RECOVERY_YAML);

  const invoked: string[] = [];
  const exec = makeRecordingExec(invoked);
  const { runId } = startRun({
    workflow: RECOVERY_WF,
    title: "fg477 recovery flow",
    inputs: {},
    projectDir: PROJECT_DIR,
  });

  // Wave 1: build dispatches and completes (auto gate).
  await runNext({ runId, workflow: RECOVERY_WF, dockerExec: exec });
  const buildPrimary = tasksForRun(runId).find((t) => t.phase === "build" && t.parentId === undefined);
  assert.ok(buildPrimary, "build primary must exist");
  assert.equal(getTask(buildPrimary.id)!.status, "complete", "build must complete on wave 1");

  // Wave 2: review dispatches and parks on its human gate.
  await runNext({ runId, workflow: RECOVERY_WF, dockerExec: exec });
  const reviewTask = tasksForRun(runId).find((t) => t.phase === "review" && t.parentId === undefined);
  assert.ok(reviewTask, "review primary must exist");
  assert.equal(getTask(reviewTask.id)!.status, "awaiting_gate", "review must park on its human gate");

  // The REAL gate reject → on_reject fires back at build.
  const rejected = await gate(reviewTask.id, "reject", "needs another build pass");
  assert.equal(rejected.nextTasks.length, 1, "the reject must mint exactly one recovery row");
  const recovery = rejected.nextTasks[0]!;
  assert.equal(recovery.phase, "build", "the recovery row lands in the on_reject target phase");
  assert.equal(recovery.parentId, reviewTask.id, "the recovery row is parented to the REJECTED task (lineage)");
  assert.equal(
    (recovery.taskPackage.inputs as Record<string, unknown>)["rejectedTaskId"],
    reviewTask.id,
    "and carries gate.ts's explicit rejectedTaskId marker — what rule 3 keys off",
  );

  // The pickup: build already has a COMPLETE primary, so the phase is only
  // re-admitted by the live recovery row — and dispatchSingleStep must REUSE that
  // row rather than mint a fresh build primary beside it.
  const beforeIds = tasksForRun(runId).map((t) => t.id).sort();
  invoked.length = 0;
  await runNext({ runId, workflow: RECOVERY_WF, dockerExec: exec });

  assert.deepEqual(
    invoked,
    [recovery.id],
    "exactly the recovery row must be dispatched — the recovery pickup, not a fresh primary",
  );
  assert.equal(getTask(recovery.id)!.status, "complete", "the recovery row must actually run to completion");
  assert.deepEqual(
    tasksForRun(runId).map((t) => t.id).sort(),
    beforeIds,
    "no new task row may be minted — the pending recovery row is REUSED by dispatchSingleStep",
  );
  assert.equal(getTask(buildPrimary.id)!.status, "complete", "the original complete build primary is untouched");
});

// ── (b) the retry-replacement row is dispatched, not the stale first ───────────

const BUILD_VERIFY_WF: Workflow = {
  name: "fg477-build-verify",
  description: "FG-477 flow: retry-replacement row reuse",
  inputs: [],
  steps: [step("build"), step("verify", { agent: "test-engineer", depends_on: ["build"] })],
};

test("FG-477 (b) flow: with [failed older primary, pending newer replacement] in one phase, runNext dispatches the REPLACEMENT row — the stale first row is never re-run and no third row is minted", async () => {
  process.env["ANTHROPIC_API_KEY"] = "sk-stub";
  ensureRuntime();

  const invoked: string[] = [];
  const exec = makeRecordingExec(invoked);
  const { runId } = startRun({
    workflow: BUILD_VERIFY_WF,
    title: "fg477 retry replacement",
    inputs: {},
    projectDir: PROJECT_DIR,
  });

  // The retry shape: the original primary failed; `forge retry` minted a second,
  // NEWER parent-less pending row in the same phase (the classifier's
  // retry_replacement). Both are workflow primaries — reuse must pick the pending one.
  const stale = insert({
    id: "task-build-stale",
    runId,
    phase: "build",
    status: "failed",
    createdAt: "2026-07-01T10:00:00.000Z",
    dispatchSource: "workflow",
  });
  const replacement = insert({
    id: "task-build-replacement",
    runId,
    phase: "build",
    status: "pending",
    createdAt: "2026-07-01T11:00:00.000Z",
    dispatchSource: "workflow",
  });

  await runNext({ runId, workflow: BUILD_VERIFY_WF, dockerExec: exec });

  assert.deepEqual(invoked, [replacement.id], "only the pending replacement row may be dispatched");
  assert.ok(!invoked.includes(stale.id), "the stale failed row must never be re-run");
  assert.equal(getTask(replacement.id)!.status, "complete", "the replacement row runs to completion");
  assert.equal(getTask(stale.id)!.status, "failed", "the stale row is left exactly as it was");
  assert.deepEqual(
    tasksForRun(runId).filter((t) => t.phase === "build").map((t) => t.id).sort(),
    [stale.id, replacement.id].sort(),
    "build must still hold exactly two rows — the replacement was REUSED, not duplicated by a fresh mint",
  );
});

// ── (c) FG-507: an attached invoke row on a `task`-declaring workflow ──────────

// The collision shape: the workflow declares a step whose id IS the invoke phase.
const TASK_STEP_WF: Workflow = {
  name: "fg477-taskstep",
  description: "FG-477 flow: a workflow that declares a step named `task` (the invoke-phase collision)",
  inputs: [],
  steps: [step("task")],
};

test("FG-477 (c) flow: an attached `forge invoke` row in phase `task` is NOT adopted by dispatchSingleStep on a workflow declaring a `task` step — the run mints and dispatches its OWN primary, and the invoke row is left alone", async () => {
  process.env["ANTHROPIC_API_KEY"] = "sk-stub";
  ensureRuntime();

  const invoked: string[] = [];
  const exec = makeRecordingExec(invoked);
  const { runId } = startRun({
    workflow: TASK_STEP_WF,
    title: "fg477 fg507 shape",
    inputs: {},
    projectDir: PROJECT_DIR,
  });

  // The row `forge invoke --run` attached: parent-less, pending, phase `task`,
  // marked with its provenance. Structurally identical to a step primary except
  // for the marker — which is exactly what rule 0 reads.
  const adhoc = insert({
    id: "task-adhoc-attached",
    runId,
    phase: "task",
    status: "pending",
    createdAt: "2026-07-01T10:00:00.000Z",
    dispatchSource: "invoke",
  });

  await runNext({ runId, workflow: TASK_STEP_WF, dockerExec: exec });

  const ownPrimary = tasksForRun(runId).find(
    (t) => t.phase === "task" && t.parentId === undefined && t.id !== adhoc.id,
  );
  assert.ok(ownPrimary, "the run must mint its OWN `task`-step primary rather than adopt the invoke row");
  assert.deepEqual(invoked, [ownPrimary.id], "only the run's own primary may be dispatched");
  assert.ok(!invoked.includes(adhoc.id), "the ad-hoc invoke row must never be dispatched by the runner");
  assert.equal(
    getTask(adhoc.id)!.status,
    "pending",
    "the invoke row is untouched — `forge invoke`/`forge retry` owns its dispatch, not the runner",
  );

  // FG-507's other half, still true through the migration: a LIVE ad-hoc row keeps
  // the run unsettled even though every workflow step is now terminal.
  assert.equal(isRunSettled(TASK_STEP_WF, tasksForRun(runId)), false, "a live ad-hoc row keeps the run unsettled");
  assert.equal(getRun(runId)!.status, "active", "runNext must not finalize the run out from under the invoke container");
});

test("FG-477 (c') frozen-legacy parity: a MARKER-LESS row in the same phase-`task` shape IS still adopted and reused by dispatchSingleStep (legacy_ambiguous_invoke) — the classifier names the ambiguity but does not change the decision", async () => {
  process.env["ANTHROPIC_API_KEY"] = "sk-stub";
  ensureRuntime();

  const invoked: string[] = [];
  const exec = makeRecordingExec(invoked);
  const { runId } = startRun({
    workflow: TASK_STEP_WF,
    title: "fg477 legacy ambiguous",
    inputs: {},
    projectDir: PROJECT_DIR,
  });

  // A pre-FG-512 row: no dispatchSource recorded at all. Nothing distinguishes a
  // legacy `forge invoke --run` row from a genuine `task`-step primary here — and
  // every consumer's pre-FG-477 predicate counted it as a primary. That decision is
  // FROZEN by the migration, so this row must still be reused.
  const legacy = insert({
    id: "task-legacy-markerless",
    runId,
    phase: "task",
    status: "pending",
    createdAt: "2026-07-01T10:00:00.000Z",
    dispatchSource: undefined,
  });

  await runNext({ runId, workflow: TASK_STEP_WF, dockerExec: exec });

  assert.deepEqual(invoked, [legacy.id], "the marker-less legacy row is REUSED as the step's primary (pre-FG-477 behavior, unchanged)");
  assert.equal(getTask(legacy.id)!.status, "complete", "and runs to completion as that step");
  assert.deepEqual(
    tasksForRun(runId).map((t) => t.id),
    [legacy.id],
    "no second `task` primary is minted beside it",
  );
});

// ── (d) reconcile sweeps only primaries amid reds / fanout / recovery / ad-hoc ──

// `shipping-reviewer` is a red whose agent name does NOT start with `red-`: the row
// the old prefix convention misclassified, and the reason the classifier resolves
// reds by workflow lookup instead.
const MIXED_WF: Workflow = {
  name: "fg477-mixed",
  description: "FG-477 flow: mixed run — primary + reds + fanout child + recovery + ad-hoc",
  inputs: [],
  steps: [
    step("build", {
      gate: "verdict",
      reds: [{ agent: "shipping-reviewer", authority: "authoritative", gate_on_verdict: true }],
    }),
    step("verify", { agent: "test-engineer", depends_on: ["build"] }),
  ],
};

/** The mixed universe every (d)/(2) test shares: a complete build primary, an
 *  orphaned pending duplicate primary beside it, a red child, a fanout child, a
 *  live recovery row, and a live ad-hoc invoke row.
 *
 *  Task ids are namespaced per `tag` — these tests share one on-disk store, so
 *  fixed ids would collide on tasks' primary key across calls. */
function seedMixedRun(tag: string, title: string): {
  runId: string;
  ids: { primary: string; dup: string; red: string; fanout: string; recovery: string; adhoc: string };
} {
  const { runId } = startRun({ workflow: MIXED_WF, title, inputs: {}, projectDir: PROJECT_DIR });
  const ids = {
    primary: `t-${tag}-primary`,
    dup: `t-${tag}-dup`,
    red: `t-${tag}-red`,
    fanout: `t-${tag}-fanout`,
    recovery: `t-${tag}-recovery`,
    adhoc: `t-${tag}-adhoc`,
  };

  insert({ id: ids.primary, runId, phase: "build", status: "complete", createdAt: "2026-07-01T10:00:00.000Z", dispatchSource: "workflow" });
  // The duplicate-primary artifact: a second, never-run pending primary.
  insert({ id: ids.dup, runId, phase: "build", status: "pending", createdAt: "2026-07-01T11:00:00.000Z", dispatchSource: "workflow" });
  // A red child — parented, same phase, named by the step's reds[].agent.
  insert({ id: ids.red, runId, phase: "build", parentId: ids.primary, status: "pending", agentRole: "shipping-reviewer", createdAt: "2026-07-01T12:00:00.000Z", dispatchSource: "workflow" });
  // A fanout child — parented, same phase, NOT one of the step's reds.
  insert({ id: ids.fanout, runId, phase: "build", parentId: ids.primary, status: "pending", agentRole: "engineer", createdAt: "2026-07-01T13:00:00.000Z", dispatchSource: "workflow" });
  // An on_reject recovery row — parented AND carrying the rejectedTaskId marker.
  insert({ id: ids.recovery, runId, phase: "build", parentId: ids.primary, status: "pending", createdAt: "2026-07-01T14:00:00.000Z", inputs: { rejectedTaskId: ids.primary, rejectedRationale: "again" }, dispatchSource: "workflow" });
  // A live ad-hoc invoke row, in the colliding `task` phase.
  insert({ id: ids.adhoc, runId, phase: "task", status: "pending", createdAt: "2026-07-01T15:00:00.000Z", dispatchSource: "invoke" });

  return { runId, ids };
}

test("FG-477 (d) flow: finalizeOrphanedPrimaries sweeps ONLY the orphaned duplicate primary — the red child, fanout child, recovery row and ad-hoc invoke row are all pending in the same phase and must all survive", () => {
  const { runId, ids } = seedMixedRun("rec", "fg477 reconcile mixed");

  const changes = finalizeOrphanedPrimaries(runId);

  assert.deepEqual(
    changes.map((c) => c.taskId),
    [ids.dup],
    "exactly one row may be swept: the parent-less pending duplicate of a completed primary",
  );
  assert.equal(changes[0]!.to, "failed");
  assert.equal(changes[0]!.reason, "orphaned_duplicate_primary");
  assert.equal(getTask(ids.dup)!.status, "failed");

  // Everything the classifier says is NOT a phase primary must be untouched. A
  // sweep that reached any of these would fail a row another actor owns — the red
  // child is mid-audit, the recovery row is about to dispatch, and the ad-hoc row
  // is the one `forge retry` dispatches directly (the FG-507 trap).
  for (const id of [ids.red, ids.fanout, ids.recovery, ids.adhoc]) {
    assert.equal(getTask(id)!.status, "pending", `${id} is not a phase primary and must not be swept`);
  }
  assert.equal(getTask(ids.primary)!.status, "complete", "the completed primary is untouched");

  // Idempotent: a second pass finds the orphan already failed and sweeps nothing.
  assert.deepEqual(finalizeOrphanedPrimaries(runId), [], "the sweep is idempotent");
});

// ── (2) settle-state parity on the mixed run: ready queue + isRunSettled ────────

test("FG-477 (2) settle parity: on the mixed run (primary + reds + fanout + recovery + ad-hoc), the ready queue admits build for its LIVE RECOVERY row only, and isRunSettled is false", () => {
  const { runId, ids } = seedMixedRun("settle", "fg477 settle mixed");
  const tasks = tasksForRun(runId);

  // build has a COMPLETE primary, so it is only re-admitted by the live recovery
  // row (FG-476's carve-out). verify's dep IS satisfied by that complete primary —
  // the red/fanout children in the same phase neither satisfy nor block it.
  assert.deepEqual(
    computeReadyQueue(MIXED_WF, tasks).map((s) => s.id),
    ["build", "verify"],
    "build re-admitted by the live recovery row; verify ready off build's complete primary",
  );

  // Not settled: the live recovery row makes build active, verify has no rows yet,
  // and the live ad-hoc row independently keeps the run open (FG-507).
  assert.equal(isRunSettled(MIXED_WF, tasks), false);

  // The children must not be able to close a step by themselves. Completing every
  // NON-primary row leaves the picture unchanged.
  assert.equal(getTask(ids.red)!.status, "pending");
  assert.equal(getTask(ids.fanout)!.status, "pending");
  assert.equal(getTask(ids.primary)!.status, "complete");
  assert.equal(getTask(ids.adhoc)!.status, "pending");
});

test("FG-477 (2) settle parity: a COMPLETE red child on a FAILED primary must NOT read the step as complete — a red child that leaked into the primary bucket would silently close a failed phase", () => {
  const { runId } = startRun({ workflow: MIXED_WF, title: "fg477 red-not-primary", inputs: {}, projectDir: PROJECT_DIR });

  // build: the primary FAILED, but its red child completed (the red audited an
  // artifact that then failed its gate). The step is blocked, not complete —
  // and verify, downstream of it, is unreachable.
  insert({ id: "t-b-failed", runId, phase: "build", status: "failed", createdAt: "2026-07-01T10:00:00.000Z", dispatchSource: "workflow" });
  insert({ id: "t-b-red", runId, phase: "build", parentId: "t-b-failed", status: "complete", agentRole: "shipping-reviewer", createdAt: "2026-07-01T11:00:00.000Z", dispatchSource: "workflow" });

  const tasks = tasksForRun(runId);
  assert.deepEqual(
    computeReadyQueue(MIXED_WF, tasks).map((s) => s.id),
    [],
    "build is terminally failed with no pending replacement; verify's dep is unsatisfied — nothing is ready",
  );
  assert.equal(
    isRunSettled(MIXED_WF, tasks),
    true,
    "the run is SETTLED (build blocked, verify unreachable) — the complete red child must not make build read `complete`",
  );
});

test("FG-477 (2) settle parity: once the recovery row and the ad-hoc row go terminal, the mixed run settles on its steps' own states", () => {
  const { runId, ids } = seedMixedRun("term", "fg477 settle terminal");

  // Sweep the orphaned duplicate (real reconcile), then take the four live
  // non-primary rows terminal — the rows that were holding the run open.
  finalizeOrphanedPrimaries(runId);
  for (const id of [ids.recovery, ids.adhoc, ids.red, ids.fanout]) {
    assert.equal(getTask(id)!.status, "pending", `${id} starts live`);
    markTaskComplete(id, { status: "complete" });
  }

  const tasks = tasksForRun(runId);
  // build now has a complete primary and no live recovery ⇒ complete. verify has no
  // rows but its dep is satisfied ⇒ still dispatchable ⇒ ACTIVE ⇒ not settled.
  assert.deepEqual(computeReadyQueue(MIXED_WF, tasks).map((s) => s.id), ["verify"]);
  assert.equal(isRunSettled(MIXED_WF, tasks), false, "verify is dispatchable — the run is not settled yet");

  insert({ id: "t-verify", runId, phase: "verify", status: "complete", agentRole: "test-engineer", createdAt: "2026-07-01T20:00:00.000Z", dispatchSource: "workflow" });
  const after = tasksForRun(runId);
  assert.deepEqual(computeReadyQueue(MIXED_WF, after).map((s) => s.id), [], "every step closed");
  assert.equal(isRunSettled(MIXED_WF, after), true, "the run settles on its steps' own states");
});

// ── (3) order / duplicate adversarials ────────────────────────────────────────

test("FG-477 (3) tie: two parent-less rows with IDENTICAL createdAt in one phase classify deterministically and STABLY across input order — the (createdAt, id) total order breaks the tie by id", () => {
  const runId = "run-fg477-tie";
  const TIE = "2026-07-01T10:00:00.000Z";
  const a = mkTask({ id: "task-build-aaa", runId, phase: "build", status: "pending", createdAt: TIE, dispatchSource: "workflow" });
  const b = mkTask({ id: "task-build-bbb", runId, phase: "build", status: "pending", createdAt: TIE, dispatchSource: "workflow" });

  const forward = classifyTaskLineage(BUILD_VERIFY_WF, [a, b]);
  const reversed = classifyTaskLineage(BUILD_VERIFY_WF, [b, a]);

  // Documented behavior: id breaks the createdAt tie, so the lexicographically
  // SMALLER id is the phase's `primary` and the other is `retry_replacement`.
  assert.equal(forward.get(a.id), "primary");
  assert.equal(forward.get(b.id), "retry_replacement");
  assert.deepEqual(
    [...reversed.entries()].sort(),
    [...forward.entries()].sort(),
    "classification must be identical regardless of the order the rows are handed in",
  );

  // And the flow-observable outputs are order-insensitive too.
  assert.deepEqual(
    computeReadyQueue(BUILD_VERIFY_WF, [a, b]).map((s) => s.id),
    computeReadyQueue(BUILD_VERIFY_WF, [b, a]).map((s) => s.id),
    "ready queue is order-insensitive under the tie",
  );
  assert.equal(isRunSettled(BUILD_VERIFY_WF, [a, b]), isRunSettled(BUILD_VERIFY_WF, [b, a]));
});

test("FG-477 (3) tie, flow level: with TWO pending parent-less rows sharing a createdAt, runNext dispatches exactly ONE of them and mints no third row — both are workflow primaries, so the tie-break cannot change the dispatch decision", async () => {
  process.env["ANTHROPIC_API_KEY"] = "sk-stub";
  ensureRuntime();

  const invoked: string[] = [];
  const exec = makeRecordingExec(invoked);
  const { runId } = startRun({
    workflow: BUILD_VERIFY_WF,
    title: "fg477 tie flow",
    inputs: {},
    projectDir: PROJECT_DIR,
  });

  const TIE = "2026-07-01T10:00:00.000Z";
  insert({ id: "task-build-aaa", runId, phase: "build", status: "pending", createdAt: TIE, dispatchSource: "workflow" });
  insert({ id: "task-build-bbb", runId, phase: "build", status: "pending", createdAt: TIE, dispatchSource: "workflow" });

  await runNext({ runId, workflow: BUILD_VERIFY_WF, dockerExec: exec });

  assert.equal(invoked.length, 1, "exactly ONE container may be dispatched for the tied phase");
  assert.ok(
    ["task-build-aaa", "task-build-bbb"].includes(invoked[0]!),
    "and it must be one of the two existing pending rows — never a freshly minted third",
  );
  assert.deepEqual(
    tasksForRun(runId).filter((t) => t.phase === "build").map((t) => t.id).sort(),
    ["task-build-aaa", "task-build-bbb"],
    "no third build row is minted — the tie is resolved by REUSE, not by duplication",
  );
  const statuses = ["task-build-aaa", "task-build-bbb"].map((id) => getTask(id)!.status).sort();
  assert.deepEqual(statuses, ["complete", "pending"], "one row ran; the other stays pending for the orphan sweep");
});

const CROSS_PHASE_WF: Workflow = {
  name: "fg477-crossphase",
  description: "FG-477 flow: a recovery row whose rejectedTaskId points at a task in ANOTHER phase",
  inputs: [],
  steps: [
    step("build"),
    step("verify", { agent: "test-engineer", depends_on: ["build"] }),
    step("review", { agent: "reviewer", gate: "human", depends_on: ["verify"], on_reject: "build" }),
  ],
};

test("FG-477 (3) cross-phase recovery: a recovery row is bucketed by its OWN phase, not the rejected task's — it re-admits and dispatches in `build` while `verify` and `review` stay closed", async () => {
  process.env["ANTHROPIC_API_KEY"] = "sk-stub";
  ensureRuntime();

  const invoked: string[] = [];
  const exec = makeRecordingExec(invoked);
  const { runId } = startRun({
    workflow: CROSS_PHASE_WF,
    title: "fg477 cross-phase recovery",
    inputs: {},
    projectDir: PROJECT_DIR,
  });

  insert({ id: "t-cp-build", runId, phase: "build", status: "complete", createdAt: "2026-07-01T10:00:00.000Z", dispatchSource: "workflow" });
  insert({ id: "t-cp-verify", runId, phase: "verify", status: "complete", agentRole: "test-engineer", createdAt: "2026-07-01T11:00:00.000Z", dispatchSource: "workflow" });
  // The rejecter: review's primary, failed by its reject.
  insert({ id: "t-cp-review", runId, phase: "review", status: "failed", agentRole: "reviewer", createdAt: "2026-07-01T12:00:00.000Z", dispatchSource: "workflow" });
  // The recovery row: lives in `build`, but its parentId/rejectedTaskId point two
  // phases away, at `review`. Phase equality cannot identify it; only the marker can.
  const recovery = insert({
    id: "t-cp-recovery",
    runId,
    phase: "build",
    parentId: "t-cp-review",
    status: "pending",
    createdAt: "2026-07-01T13:00:00.000Z",
    inputs: { rejectedTaskId: "t-cp-review", rejectedRationale: "build was wrong" },
    dispatchSource: "workflow",
  });

  const tasks = tasksForRun(runId);
  assert.deepEqual(
    computeReadyQueue(CROSS_PHASE_WF, tasks).map((s) => s.id),
    ["build"],
    "only the recovery row's OWN phase is re-admitted — not the rejecter's phase, and not the untouched middle phase",
  );
  assert.equal(isRunSettled(CROSS_PHASE_WF, tasks), false, "the live cross-phase recovery row keeps the run active");

  await runNext({ runId, workflow: CROSS_PHASE_WF, dockerExec: exec });

  assert.deepEqual(invoked, [recovery.id], "the cross-phase recovery row is the row that dispatches");
  assert.equal(getTask(recovery.id)!.status, "complete");
  assert.equal(getTask("t-cp-verify")!.status, "complete", "the completed middle phase is not re-run");
  assert.equal(getTask("t-cp-review")!.status, "failed", "the rejected review primary is not re-dispatched");
  assert.ok(!invoked.includes("t-cp-review"), "no container for the rejecter");
});
