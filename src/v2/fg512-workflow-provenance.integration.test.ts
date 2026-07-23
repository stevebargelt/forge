// FG-512: runner-side dispatch provenance. FG-507 stamped `dispatchSource:
// "invoke"` on invoke-created rows; FG-512 completes the design by stamping
// `dispatchSource: "workflow"` on every runner-created row (primaries, reds,
// fanout parents/children, manual steps, and gate.ts's on_reject recovery /
// request-changes replacement rows). Provenance is now TOTAL for new rows, so
// taskDispatchKind's `legacy_ambiguous_phase` refusal fires ONLY for legacy
// marker-less rows.
//
// These drive the REAL runner (runNext) and the REAL gate — no rows are hand-
// constructed for the stamp-coverage assertions. The end-to-end retry case (AC1)
// dispatches a `task`-step workflow through the runner, fails it, and proves the
// stamped row retries as a workflow step with no RetryDispatchKindUnknownError —
// the exact case a legacy marker-less row (AC2) still refuses.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { insertRun, getRun, updateRunStatus } from "../store/runs.js";
import { insertTask, getTask, tasksForRun } from "../store/tasks.js";
import { logEvent } from "../store/events.js";
import { startRun } from "./startRun.js";
import { runNext, type DockerExecFn } from "./runNext.js";
import { gate } from "./gate.js";
import { retry, RetryDispatchKindUnknownError } from "./retry.js";
import { taskDispatchKind } from "./run-kind.js";
import { computeReadyQueue, isOnRejectRecoveryTask } from "./ready-queue.js";
import { loadWorkflow } from "./loader.js";
import type { Workflow } from "./schema.js";
import type { Run, Task } from "../types/index.js";
import { publishFlatAsGeneration } from "./seed-generation.testkit.js";

let db: DatabaseInstance;
let prev: DatabaseInstance | null;
const tmpDirs: string[] = [];
let savedApiKey: string | undefined;
const savedWorktreeEnv: Record<string, string | undefined> = {};
const WORKTREE_ENV = ["FORGE_WORKTREES", "FORGE_NO_WORKTREES"] as const;

function ensureRuntime(): void {
  const runtimePath = join(process.env.FORGE_HOME!, "runtimes", "claude.yml");
  if (!existsSync(runtimePath)) {
    mkdirSync(dirname(runtimePath), { recursive: true });
    writeFileSync(
    runtimePath,
    `name: claude
description: fg512 test stub
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
  publishFlatAsGeneration(process.env.FORGE_HOME!);
}

function projectDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "forge-fg512-proj-"));
  tmpDirs.push(dir);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fg512-fixture" }));
  return dir;
}

// Writes result.json + exits 0, exactly as a real container would.
function completeExec(result: unknown): DockerExecFn {
  return async ({ stdoutPath, stderrPath }) => {
    const dir = dirname(stdoutPath);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "result.json"), JSON.stringify(result));
    writeFileSync(stdoutPath, "stub");
    writeFileSync(stderrPath, "");
    return 0;
  };
}

// Exits 1 with NO result.json → container_crash (FG-507's fixture shape).
const crashExec: DockerExecFn = async ({ stdoutPath, stderrPath }) => {
  const dir = dirname(stdoutPath);
  mkdirSync(dir, { recursive: true });
  writeFileSync(stdoutPath, "stub");
  writeFileSync(stderrPath, "boom");
  return 1;
};

function taskIdFromArgs(args: string[]): string {
  const i = args.indexOf("--name");
  return (i >= 0 ? args[i + 1] ?? "" : "").replace(/^forge-/, "");
}

const TASK_STEP_WORKFLOW = "fg512taskstepwf";

function activeRun(id: string, workflow: string, dir: string): Run {
  const run: Run = { id, workflow, title: "fg512", status: "active", createdAt: "2026-07-10T00:00:00Z", projectDir: dir };
  insertRun(run);
  return run;
}

/** A marker-less row — the shape of every task minted before FG-507/FG-512. */
function legacyFailedTask(id: string, run: Run, phase: string, inputs: Record<string, unknown>): Task {
  const t: Task = {
    id,
    runId: run.id,
    phase,
    agentRole: "engineer",
    status: "failed",
    error: "boom",
    taskPackage: { taskId: id, runId: run.id, phase, role: "engineer", inputs, composedSystemPrompt: "" },
    createdAt: "2026-07-10T00:00:00Z",
  };
  insertTask(t);
  logEvent("task.failed", { runId: run.id, taskId: id, payload: { failure_kind: "container_crash", error: "boom" } });
  return t;
}

/** A workflow whose only step's id is literally `task` — the collision between an
 *  invoke row's phase and a genuine workflow step that provenance exists to resolve. */
function writeTaskStepWorkflow(dir: string): void {
  mkdirSync(join(dir, ".forge", "workflows"), { recursive: true });
  writeFileSync(
    join(dir, ".forge", "workflows", `${TASK_STEP_WORKFLOW}.yml`),
    `name: ${TASK_STEP_WORKFLOW}
description: a workflow that legitimately owns a step id 'task'
inputs: []
steps:
  - id: task
    agent: engineer
    gate: auto
`,
  );
}

const TASK_STEP_WF_OBJ: Workflow = {
  name: TASK_STEP_WORKFLOW,
  description: "a workflow that legitimately owns a step id 'task'",
  inputs: [],
  steps: [{ id: "task", agent: "engineer", gate: "auto", manual: false, depends_on: [], runtime: "claude", reds: [] }],
};

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
  ensureRuntime();
  savedApiKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  for (const k of WORKTREE_ENV) {
    savedWorktreeEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  if (savedApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedApiKey;
  for (const k of WORKTREE_ENV) {
    if (savedWorktreeEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedWorktreeEnv[k]!;
  }
  setDbForTest(prev as DatabaseInstance);
  db.close();
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// ── AC1: a runner-created `task`-step row retries as a workflow step, no refusal ──

test("FG-512 AC1: a `task`-step row dispatched by the real runner carries `workflow` provenance and retries as a workflow step end-to-end", async () => {
  const dir = projectDir();
  const { runId } = startRun({ workflow: TASK_STEP_WF_OBJ, title: "fg512 taskstep", inputs: {}, projectDir: dir });

  // Real runner dispatch of the `task` step — fail it (container_crash).
  await runNext({ runId, workflow: TASK_STEP_WF_OBJ, dockerExec: crashExec });
  const failed = tasksForRun(runId).find((t) => t.phase === "task")!;
  assert.equal(failed.status, "failed", "fixture: the `task` step's primary crashed");
  assert.equal(
    failed.taskPackage.dispatchSource,
    "workflow",
    "the runner stamped `workflow` provenance on the primary (survives the SQLite round-trip)",
  );

  const run = getRun(runId)!;
  assert.equal(
    taskDispatchKind(failed, run).kind,
    "workflow_step",
    "the `workflow` marker classifies decisively — no legacy_ambiguous_phase for a stamped `task`-phase row",
  );

  // Retry MUST NOT refuse (the legacy corner) — it takes the workflow-step path.
  const out = await retry(failed.id);
  assert.equal(out.adHoc, undefined, "a stamped workflow-step row retries via the ready queue, not ad-hoc dispatch");
  const retried = getTask(out.newTask.id)!;
  assert.equal(retried.status, "pending");
  assert.equal(retried.phase, "task");
  assert.equal(retried.parentId, undefined, "a PRIMARY row — runNext.dispatchStep only reuses pending primaries");
  assert.equal(retried.taskPackage.dispatchSource, "workflow", "provenance is carried across the retry");

  // End-to-end: forge next picks the pending row up and completes the step.
  updateRunStatus(runId, "active");
  const ready = computeReadyQueue(TASK_STEP_WF_OBJ, tasksForRun(runId));
  assert.deepEqual(ready.map((s) => s.id), ["task"], "the ready queue admits the retried step");
  const wave = await runNext({ runId, workflow: TASK_STEP_WF_OBJ, dockerExec: completeExec({ status: "complete", tests_run: 1 }) });
  assert.deepEqual(wave.completedSteps, ["task"], "the retried `task` step re-dispatched and completed");
  assert.equal(getTask(out.newTask.id)!.status, "complete");
});

// ── AC2: the same shape, marker-less (legacy), still refuses — pre-write ──────

test("FG-512 AC2: a LEGACY marker-less `task` row on a workflow owning a `task` step still refuses with legacy_ambiguous_phase, writing no state", async () => {
  const dir = projectDir();
  writeTaskStepWorkflow(dir);
  const run = activeRun("run-fg512-legacy", TASK_STEP_WORKFLOW, dir);
  const legacy = legacyFailedTask("task-engineer-legacy", run, "task", { task: "legacy side quest" });

  const kind = taskDispatchKind(legacy, run);
  assert.equal(kind.kind, "unknown");
  assert.equal(kind.kind === "unknown" ? kind.reason : undefined, "legacy_ambiguous_phase", "no marker → still ambiguous");

  const tasksBefore = tasksForRun(run.id).map((t) => t.id);
  await assert.rejects(
    () => retry(legacy.id),
    (e: unknown) => {
      assert.ok(e instanceof RetryDispatchKindUnknownError, `expected RetryDispatchKindUnknownError, got ${e}`);
      assert.equal(e.reason, "legacy_ambiguous_phase");
      assert.match(e.message, /records no dispatch provenance \(a legacy pre-provenance row\)/);
      assert.match(e.message, /No pending task row was created/);
      return true;
    },
  );

  assert.deepEqual(tasksForRun(run.id).map((t) => t.id), tasksBefore, "no row created — the refusal happened before any write");
});

// ── AC4: the ambiguity does not widen — a marker-less non-`task` phase classifies structurally ──

test("FG-512 AC4: legacy marker-less rows in non-`task` phases still classify structurally", async () => {
  const dir = projectDir();
  const run = activeRun("run-fg512-nonwiden", TASK_STEP_WORKFLOW, dir);
  writeTaskStepWorkflow(dir);
  // 'task' is the only declared step; 'build' is not, so it's decisively ad-hoc.
  assert.equal(taskDispatchKind(legacyFailedTask("task-build-x", run, "build", {}), run).kind, "adhoc");
});

// ── AC5: stamp coverage by enumeration — every runner site class, through real calls ──

test("FG-512 AC5 (primary + manual): runNext stamps `workflow` on primary and manual-step rows", async () => {
  const dir = projectDir();
  const wf: Workflow = {
    name: "fg512-primary",
    description: "primary + manual",
    inputs: [],
    steps: [
      { id: "build", agent: "engineer", gate: "auto", manual: false, depends_on: [], runtime: "claude", reds: [] },
      { id: "signoff", gate: "human", manual: true, depends_on: ["build"], runtime: "claude", reds: [] },
    ],
  };
  const { runId } = startRun({ workflow: wf, title: "fg512 primary", inputs: {}, projectDir: dir });

  await runNext({ runId, workflow: wf, dockerExec: completeExec({ status: "complete", tests_run: 1 }) });
  const primary = tasksForRun(runId).find((t) => t.phase === "build")!;
  assert.equal(primary.taskPackage.dispatchSource, "workflow", "primary row stamped");
  assert.equal(taskDispatchKind(primary, getRun(runId)!).kind, "workflow_step");

  await runNext({ runId, workflow: wf, dockerExec: completeExec({ status: "complete", tests_run: 1 }) });
  const manual = tasksForRun(runId).find((t) => t.phase === "signoff")!;
  assert.equal(manual.agentRole, "manual");
  assert.equal(manual.taskPackage.dispatchSource, "workflow", "manual-step row stamped");
});

test("FG-512 AC5 (red): dispatchReds stamps `workflow` on the red row", async () => {
  const dir = projectDir();
  const wf: Workflow = {
    name: "fg512-red",
    description: "primary with a red",
    inputs: [],
    steps: [
      {
        id: "build",
        agent: "engineer",
        gate: "auto",
        manual: false,
        depends_on: [],
        runtime: "claude",
        reds: [{ agent: "red-wide", authority: "specialist", gate_on_verdict: false }],
      },
    ],
  };
  const { runId } = startRun({ workflow: wf, title: "fg512 red", inputs: {}, projectDir: dir });

  const exec: DockerExecFn = async ({ args, stdoutPath, stderrPath }) => {
    const dir2 = dirname(stdoutPath);
    mkdirSync(dir2, { recursive: true });
    const id = taskIdFromArgs(args);
    const result = id.includes("red-")
      ? { status: "complete", verdict: "pass", confidence: 0.9, findings: [] }
      : { status: "complete", tests_run: 1, files_modified: [] };
    writeFileSync(join(dir2, "result.json"), JSON.stringify(result));
    writeFileSync(stdoutPath, "");
    writeFileSync(stderrPath, "");
    return 0;
  };

  await runNext({ runId, workflow: wf, dockerExec: exec });
  const red = tasksForRun(runId).find((t) => t.agentRole === "red-wide")!;
  assert.ok(red, "the red row exists");
  assert.equal(red.taskPackage.dispatchSource, "workflow", "red row stamped");
});

test("FG-512 AC5 (fanout parent + child): dispatchFanoutStep stamps `workflow` on parent and every child", async () => {
  const dir = projectDir();
  const wf: Workflow = {
    name: "fg512-fanout",
    description: "seed then fan out",
    inputs: [],
    steps: [
      { id: "seed", agent: "engineer", gate: "auto", manual: false, depends_on: [], runtime: "claude", reds: [] },
      {
        id: "spread",
        agent: "engineer",
        gate: "auto",
        manual: false,
        depends_on: ["seed"],
        runtime: "claude",
        reds: [],
        fanout: { from_upstream: { step: "seed", array_key: "items", input_key: "item" }, failure_mode: "continue" },
      },
    ],
  };
  const { runId } = startRun({ workflow: wf, title: "fg512 fanout", inputs: {}, projectDir: dir });

  // Wave 1: seed produces a two-element array.
  await runNext({ runId, workflow: wf, dockerExec: completeExec({ status: "complete", tests_run: 1, items: ["a", "b"] }) });
  // Wave 2: fanout parent + two children.
  await runNext({ runId, workflow: wf, dockerExec: completeExec({ status: "complete", tests_run: 1 }) });

  const parent = tasksForRun(runId).find((t) => t.phase === "spread" && t.parentId === undefined)!;
  assert.ok(parent, "the fanout parent row exists");
  assert.equal(parent.taskPackage.dispatchSource, "workflow", "fanout parent stamped");

  const children = tasksForRun(runId).filter((t) => t.parentId === parent.id);
  assert.equal(children.length, 2, "two children dispatched");
  for (const child of children) {
    assert.equal(child.taskPackage.dispatchSource, "workflow", `fanout child ${child.id} stamped`);
  }
});

// The two runner sites that mint a row through emptyTaskPackage and immediately
// fail it — exercised through the REAL runner, not the helper in isolation.

test("FG-512 AC5 (shipping-reviewer preflight-failure red): the pre-failed reviewer row is stamped `workflow` and classifies decisively", async () => {
  const dir = projectDir();
  const wf: Workflow = {
    name: "fg512-shipping-preflight",
    description: "step whose only red is shipping-reviewer, which pre-fails on missing context",
    inputs: [],
    steps: [
      {
        id: "build",
        agent: "engineer",
        gate: "auto",
        manual: false,
        depends_on: [],
        runtime: "claude",
        reds: [{ agent: "shipping-reviewer", authority: "specialist", gate_on_verdict: false }],
      },
    ],
  };
  // No ticketId in inputs/metadata → assembleReviewerContextPacket short-circuits
  // with a required-missing backlogTicket, so the shipping-reviewer red pre-fails
  // BEFORE any container dispatch. That is the emptyTaskPackage insert under test.
  const { runId } = startRun({ workflow: wf, title: "fg512 shipping preflight", inputs: {}, projectDir: dir });

  await runNext({ runId, workflow: wf, dockerExec: completeExec({ status: "complete", tests_run: 1, files_modified: [] }) });

  const reviewer = tasksForRun(runId).find((t) => t.agentRole === "shipping-reviewer")!;
  assert.ok(reviewer, "the pre-failed shipping-reviewer red row exists");
  assert.equal(reviewer.status, "failed", "fixture: the reviewer pre-failed on missing required context");
  assert.equal(
    reviewer.taskPackage.dispatchSource,
    "workflow",
    "preflight-failure red row stamped via emptyTaskPackage (survives the SQLite round-trip)",
  );
  assert.equal(
    taskDispatchKind(reviewer, getRun(runId)!).kind,
    "workflow_step",
    "the `workflow` marker classifies the pre-failed red decisively — no legacy ambiguity",
  );
});

test("FG-512 AC5 (fanout parent, empty upstream): failFanoutParent stamps `workflow` on the failure parent row", async () => {
  const dir = projectDir();
  const wf: Workflow = {
    name: "fg512-fanout-empty",
    description: "seed yields an empty array → the fanout parent is minted only to fail",
    inputs: [],
    steps: [
      { id: "seed", agent: "engineer", gate: "auto", manual: false, depends_on: [], runtime: "claude", reds: [] },
      {
        id: "spread",
        agent: "engineer",
        gate: "auto",
        manual: false,
        depends_on: ["seed"],
        runtime: "claude",
        reds: [],
        fanout: { from_upstream: { step: "seed", array_key: "items", input_key: "item" }, failure_mode: "continue" },
      },
    ],
  };
  const { runId } = startRun({ workflow: wf, title: "fg512 fanout empty", inputs: {}, projectDir: dir });

  // Wave 1: seed completes with an EMPTY items array — nothing to fan out over.
  await runNext({ runId, workflow: wf, dockerExec: completeExec({ status: "complete", tests_run: 1, items: [] }) });
  // Wave 2: the fanout step dispatches, finds no upstream array, and mints the
  // parent row through emptyTaskPackage solely to fail it — the path under test.
  await runNext({ runId, workflow: wf, dockerExec: completeExec({ status: "complete", tests_run: 1 }) });

  const parent = tasksForRun(runId).find((t) => t.phase === "spread" && t.parentId === undefined)!;
  assert.ok(parent, "the failed fanout parent row exists");
  assert.equal(parent.status, "failed", "fixture: the parent failed on empty upstream");
  assert.equal(
    parent.taskPackage.dispatchSource,
    "workflow",
    "empty-upstream fanout parent stamped via emptyTaskPackage (survives the SQLite round-trip)",
  );
  assert.equal(
    taskDispatchKind(parent, getRun(runId)!).kind,
    "workflow_step",
    "the `workflow` marker classifies the failure parent decisively",
  );
});

test("FG-512 AC5 (on_reject recovery): gate reject stamps `workflow` on the recovery row", async () => {
  const dir = projectDir();
  const wfName = "fg512-onreject";
  mkdirSync(join(process.env.FORGE_HOME!, "workflows"), { recursive: true });
  writeFileSync(
    join(process.env.FORGE_HOME!, "workflows", `${wfName}.yml`),
    `name: ${wfName}
description: reject-into-earlier-step
inputs: []
steps:
  - id: investigate
    agent: security-advisor
    gate: human
  - id: audit
    agent: security-advisor
    depends_on: [investigate]
    gate: human
    on_reject: investigate
`,
  );
  publishFlatAsGeneration(process.env.FORGE_HOME!);
  const run = activeRun("run-fg512-onreject", wfName, dir);
  const audit: Task = {
    id: "task-audit-1",
    runId: run.id,
    phase: "audit",
    agentRole: "security-advisor",
    status: "awaiting_gate",
    taskPackage: { taskId: "task-audit-1", runId: run.id, phase: "audit", role: "security-advisor", inputs: {}, composedSystemPrompt: "P" },
    createdAt: "2026-07-10T00:00:00Z",
  };
  insertTask(audit);

  const result = await gate(audit.id, "reject", "redo the investigation", {});
  assert.equal(result.nextTasks.length, 1, "reject seeded exactly one recovery row");
  const recovery = tasksForRun(run.id).find((t) => t.phase === "investigate" && isOnRejectRecoveryTask(t))!;
  assert.ok(recovery, "the on_reject recovery row exists");
  assert.equal(recovery.taskPackage.dispatchSource, "workflow", "on_reject recovery row stamped");
});

test("FG-512 AC5 (request-changes replacement): gate request-changes stamps `workflow`, even replacing a legacy marker-less primary", async () => {
  const dir = projectDir();
  const wfName = "fg512-reqchanges";
  mkdirSync(join(process.env.FORGE_HOME!, "workflows"), { recursive: true });
  writeFileSync(
    join(process.env.FORGE_HOME!, "workflows", `${wfName}.yml`),
    `name: ${wfName}
description: single step with a human gate
inputs: []
steps:
  - id: build
    agent: engineer
    gate: human
`,
  );
  publishFlatAsGeneration(process.env.FORGE_HOME!);
  const run = activeRun("run-fg512-reqchanges", wfName, dir);
  // A LEGACY primary (no dispatchSource) — the spread would carry no marker, so the
  // explicit stamp is what makes the replacement total.
  const primary: Task = {
    id: "task-build-1",
    runId: run.id,
    phase: "build",
    agentRole: "engineer",
    status: "awaiting_gate",
    taskPackage: { taskId: "task-build-1", runId: run.id, phase: "build", role: "engineer", inputs: {}, composedSystemPrompt: "P" },
    createdAt: "2026-07-10T00:00:00Z",
  };
  insertTask(primary);
  assert.equal(primary.taskPackage.dispatchSource, undefined, "fixture: the rejected primary is marker-less");

  const result = await gate(primary.id, "request-changes", "tighten the guard", {});
  assert.equal(result.nextTasks.length, 1, "request-changes seeded one replacement row");
  const replacement = result.nextTasks[0]!;
  assert.equal(replacement.phase, "build");
  assert.equal(getTask(replacement.id)!.taskPackage.dispatchSource, "workflow", "request-changes replacement row stamped");
  assert.equal(
    (getTask(replacement.id)!.taskPackage.inputs as Record<string, unknown>)["requestedChanges"],
    "tighten the guard",
  );
});

// ── AC3 anchor: a stamped `workflow` row is never mistaken for an ad-hoc invoke row ──

test("FG-512: a `workflow`-stamped row is not ad-hoc — the ready queue and classifier treat it as a workflow step", async () => {
  const dir = projectDir();
  const run = activeRun("run-fg512-notadhoc", TASK_STEP_WORKFLOW, dir);
  writeTaskStepWorkflow(dir);
  const stamped: Task = {
    id: "task-task-stamped",
    runId: run.id,
    phase: "task",
    agentRole: "engineer",
    status: "pending",
    taskPackage: { taskId: "task-task-stamped", runId: run.id, phase: "task", role: "engineer", inputs: {}, dispatchSource: "workflow", composedSystemPrompt: "" },
    createdAt: "2026-07-10T00:00:00Z",
  };
  insertTask(stamped);
  assert.equal(taskDispatchKind(stamped, run).kind, "workflow_step");
  // The `task` step is still admitted (its pending stamped primary IS its primary).
  const ready = computeReadyQueue(loadWorkflow(TASK_STEP_WORKFLOW, { projectDir: dir }), tasksForRun(run.id));
  assert.deepEqual(ready.map((s) => s.id), ["task"], "a workflow-stamped row is the step's own primary, not an ad-hoc row to skip");
});
