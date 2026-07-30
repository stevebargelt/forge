// FG-512 (verify phase): the gaps a provenance change can hide, complementary to
// the engineer's fg512-workflow-provenance.integration.test.ts (which proves each
// runner site STAMPS `workflow` and that taskDispatchKind CLASSIFIES the marker).
// The engineer drives retry end-to-end only through the primary `task`-step row.
//
// This file closes four gaps:
//   1. RETRY through each stamped row CLASS — not just classification. A red, a
//      fanout child, an on_reject recovery row, and a request-changes replacement
//      row are all runner-minted (so all stamped `workflow`). Retrying each must
//      route through taskDispatchKind's `workflow_step` branch (a fresh pending
//      row left to `forge next`, adHoc undefined) — EXCEPT where retry is
//      structurally unsupported (a fanout child / fanout-parent wave), where the
//      pre-existing refusal must still fire and the provenance marker must NOT
//      quietly turn it retryable.
//   2. MIXED provenance in ONE run (the FG-477-lineage concern): a legacy
//      marker-less row and a runner-stamped row side by side. taskDispatchKind
//      classifies each independently — stamped decisive, legacy structural /
//      fail-closed — with no cross-contamination.
//   3. Serialization round-trip across a PROCESS RESTART: the marker written by
//      the retry path must survive a real on-disk SQLite close + reopen, read back
//      through the store accessor (getTask), not the in-memory object.
//
// Every row is minted by the REAL runner / gate; retry() is driven for real.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdirSync, writeFileSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest, applyMigrations } from "../store/db.js";
import { SCHEMA_SQL } from "../store/schema.js";
import { insertRun, getRun, updateRunStatus } from "../store/runs.js";
import { insertTask, getTask, tasksForRun } from "../store/tasks.js";
import { logEvent } from "../store/events.js";
import { failTask } from "./failure-kind.js";
import { startRun } from "./startRun.js";
import { runNext, type DockerExecFn } from "./runNext.js";
import { gate } from "./gate.js";
import { retry, RetryDispatchKindUnknownError, FanoutChildRetryError, RetryNotAllowedError } from "./retry.js";
import { taskDispatchKind } from "./run-kind.js";
import { isOnRejectRecoveryTask } from "./ready-queue.js";
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
description: fg512 gaps test stub
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
  const dir = mkdtempSync(join(tmpdir(), "forge-fg512g-proj-"));
  tmpDirs.push(dir);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fg512-gaps-fixture" }));
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

// Exits 1 with NO result.json → container_crash (a retryable kind).
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

function activeRun(id: string, workflow: string, dir: string): Run {
  const run: Run = { id, workflow, title: "fg512 gaps", status: "active", createdAt: "2026-07-10T00:00:00Z", projectDir: dir };
  insertRun(run);
  return run;
}

/** Put an already-minted row into a retryable `failed` state, exactly as the
 *  attached-exit path does for a crashed container (container_crash is retryable
 *  per retry-policy.ts) — so retry() proceeds without --force. */
function crashRow(task: Task): void {
  failTask(task.id, { runId: task.runId, kind: "container_crash", error: "boom" });
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

// ── Gap 1: RETRY through each stamped row CLASS ──────────────────────────────

test("FG-512 gap1 (red): retrying a runner-stamped RED row routes through the workflow-step path, not ad-hoc", async () => {
  const dir = projectDir();
  const wf: Workflow = {
    name: "fg512g-red",
    description: "primary with a red",
    review_mode: "legacy_verdict",
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
  const { runId } = startRun({ workflow: wf, title: "fg512g red", inputs: {}, projectDir: dir });

  const exec: DockerExecFn = async ({ args, stdoutPath, stderrPath }) => {
    const d2 = dirname(stdoutPath);
    mkdirSync(d2, { recursive: true });
    const id = taskIdFromArgs(args);
    const result = id.includes("red-")
      ? { status: "complete", verdict: "pass", confidence: 0.9, findings: [] }
      : { status: "complete", tests_run: 1, files_modified: [] };
    writeFileSync(join(d2, "result.json"), JSON.stringify(result));
    writeFileSync(stdoutPath, "");
    writeFileSync(stderrPath, "");
    return 0;
  };
  await runNext({ runId, workflow: wf, dockerExec: exec });

  const red = tasksForRun(runId).find((t) => t.agentRole === "red-wide")!;
  assert.ok(red, "fixture: a runner-minted red row exists");
  assert.equal(red.taskPackage.dispatchSource, "workflow", "fixture: the red row is stamped");
  assert.notEqual(red.parentId, undefined, "fixture: a red row is parented to its primary");

  crashRow(red);
  const failedRed = getTask(red.id)!;
  const run = getRun(runId)!;
  assert.equal(taskDispatchKind(failedRed, run).kind, "workflow_step", "a stamped red classifies as a workflow step");

  const out = await retry(red.id);
  assert.equal(out.adHoc, undefined, "the retried red is a workflow step — left to `forge next`, not ad-hoc re-dispatched");
  const retried = getTask(out.newTask.id)!;
  assert.equal(retried.status, "pending");
  assert.equal(retried.parentId, undefined, "retry mints a PRIMARY row (runNext.dispatchStep only reuses pending primaries)");
  assert.equal(retried.taskPackage.dispatchSource, "workflow", "provenance is carried onto the retried row");
  assert.equal(taskDispatchKind(retried, run).kind, "workflow_step", "the retried row still routes as a workflow step");
});

test("FG-512 gap1 (fanout child): retry stays REFUSED regardless of provenance; --force proceeds as a workflow step", async () => {
  const dir = projectDir();
  const wf: Workflow = {
    name: "fg512g-fanout",
    description: "seed then fan out",
    review_mode: "legacy_verdict",
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
  const { runId } = startRun({ workflow: wf, title: "fg512g fanout", inputs: {}, projectDir: dir });
  await runNext({ runId, workflow: wf, dockerExec: completeExec({ status: "complete", tests_run: 1, items: ["a", "b"] }) });
  await runNext({ runId, workflow: wf, dockerExec: completeExec({ status: "complete", tests_run: 1 }) });

  const parent = tasksForRun(runId).find((t) => t.phase === "spread" && t.parentId === undefined)!;
  const child = tasksForRun(runId).find((t) => t.parentId === parent.id)!;
  assert.ok(child, "fixture: a runner-minted fanout child exists");
  assert.equal(child.taskPackage.dispatchSource, "workflow", "fixture: the child is stamped");

  crashRow(child);

  // The refusal is STRUCTURAL (a stray primary in the fanout phase would confuse
  // dispatchFanoutStep) — the `workflow` marker must not quietly make it retryable.
  const before = tasksForRun(runId).map((t) => t.id);
  await assert.rejects(
    () => retry(child.id),
    (e: unknown) => {
      assert.ok(e instanceof FanoutChildRetryError, `expected FanoutChildRetryError, got ${e}`);
      assert.equal(e.parentId, parent.id);
      assert.match(e.message, /forge recover .* --re-drive/);
      return true;
    },
  );
  assert.deepEqual(tasksForRun(runId).map((t) => t.id), before, "no row created — refused before any write");

  // --force overrides the structural guard; the marker then routes it as a workflow step.
  const out = await retry(child.id, { force: true });
  assert.equal(out.adHoc, undefined, "forced retry of a stamped child is a workflow step, not ad-hoc");
  const retried = getTask(out.newTask.id)!;
  assert.equal(retried.parentId, undefined, "the forced retry mints a fresh PRIMARY");
  assert.equal(retried.taskPackage.dispatchSource, "workflow", "provenance carried onto the forced retry");
});

test("FG-512 gap1 (fanout parent): a fanout-wave-orphaned parent stays non-retryable — provenance doesn't override the policy refusal", async () => {
  const dir = projectDir();
  const wf: Workflow = {
    name: "fg512g-fanout-parent",
    description: "seed then fan out",
    review_mode: "legacy_verdict",
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
  const { runId } = startRun({ workflow: wf, title: "fg512g fanout parent", inputs: {}, projectDir: dir });
  await runNext({ runId, workflow: wf, dockerExec: completeExec({ status: "complete", tests_run: 1, items: ["a", "b"] }) });
  await runNext({ runId, workflow: wf, dockerExec: completeExec({ status: "complete", tests_run: 1 }) });

  const parent = tasksForRun(runId).find((t) => t.phase === "spread" && t.parentId === undefined)!;
  assert.equal(parent.taskPackage.dispatchSource, "workflow", "fixture: the fanout parent is stamped");

  // A stamped parent reconciled as fanout_wave_orphaned — retry-policy.ts refuses
  // this kind; the `workflow` marker must not turn it retryable (that would mint a
  // second uncoordinated primary, bypassing `forge recover --re-drive`).
  failTask(parent.id, { runId, kind: "fanout_wave_orphaned", error: "wave orphaned" });
  const before = tasksForRun(runId).map((t) => t.id);
  await assert.rejects(
    () => retry(parent.id),
    (e: unknown) => {
      assert.ok(e instanceof RetryNotAllowedError, `expected RetryNotAllowedError, got ${e}`);
      assert.match(e.message, /forge recover .* --re-drive/);
      return true;
    },
  );
  assert.deepEqual(tasksForRun(runId).map((t) => t.id), before, "no row created — the policy refusal happened before any write");
});

test("FG-512 gap1 (on_reject recovery): retrying a stamped recovery row routes through the workflow-step path", async () => {
  const dir = projectDir();
  const wfName = "fg512g-onreject";
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
  const run = activeRun("run-fg512g-onreject", wfName, dir);
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

  await gate(audit.id, "reject", "redo the investigation", {});
  const recovery = tasksForRun(run.id).find((t) => t.phase === "investigate" && isOnRejectRecoveryTask(t))!;
  assert.ok(recovery, "fixture: an on_reject recovery row exists");
  assert.equal(recovery.taskPackage.dispatchSource, "workflow", "fixture: the recovery row is stamped");
  assert.equal(recovery.parentId, audit.id, "fixture: recovery lineage points at the rejector");

  crashRow(recovery);
  const out = await retry(recovery.id);
  assert.equal(out.adHoc, undefined, "the recovery row's retry is a workflow step (its phase differs from the parent's — not a fanout child)");
  const retried = getTask(out.newTask.id)!;
  assert.equal(retried.phase, "investigate");
  assert.equal(retried.parentId, undefined, "retry mints a fresh PRIMARY");
  assert.equal(retried.taskPackage.dispatchSource, "workflow", "provenance carried onto the retried recovery row");
  assert.equal(taskDispatchKind(retried, getRun(run.id)!).kind, "workflow_step");
});

test("FG-512 gap1 (request-changes replacement): retrying a stamped replacement primary routes through the workflow-step path", async () => {
  const dir = projectDir();
  const wfName = "fg512g-reqchanges";
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
  const run = activeRun("run-fg512g-reqchanges", wfName, dir);
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

  const result = await gate(primary.id, "request-changes", "tighten the guard", {});
  const replacement = result.nextTasks[0]!;
  assert.equal(replacement.taskPackage.dispatchSource, "workflow", "fixture: the replacement primary is stamped");
  assert.equal(replacement.parentId, undefined, "fixture: the replacement is a PRIMARY, not a child");

  crashRow(getTask(replacement.id)!);
  const out = await retry(replacement.id);
  assert.equal(out.adHoc, undefined, "the replacement's retry is a workflow step, not ad-hoc");
  const retried = getTask(out.newTask.id)!;
  assert.equal(retried.phase, "build");
  assert.equal(retried.parentId, undefined);
  assert.equal(retried.taskPackage.dispatchSource, "workflow", "provenance carried onto the retried replacement row");
  assert.equal(taskDispatchKind(retried, getRun(run.id)!).kind, "workflow_step");
});

// ── Gap 2: MIXED provenance in one run — independent classification ──────────

test("FG-512 gap2 (mixed, structural): a legacy invoke-attached row and a stamped runner row in one run classify independently", async () => {
  const dir = projectDir();
  const wfName = "fg512g-mixed";
  // The workflow must LOAD from disk for the marker-less-row fallback to reach its
  // structural verdict (a workflow that won't load classifies as
  // `unknown:workflow_unloadable`, not `adhoc`). This build-only workflow does NOT
  // own a `task` step, so a legacy phase-"task" row falls through to `adhoc`.
  mkdirSync(join(process.env.FORGE_HOME!, "workflows"), { recursive: true });
  writeFileSync(
    join(process.env.FORGE_HOME!, "workflows", `${wfName}.yml`),
    `name: ${wfName}
description: single build step
inputs: []
steps:
  - id: build
    agent: engineer
    gate: auto
`,
  );
  publishFlatAsGeneration(process.env.FORGE_HOME!);
  const wf: Workflow = {
    name: wfName,
    description: "single build step",
    review_mode: "legacy_verdict",
    inputs: [],
    steps: [{ id: "build", agent: "engineer", gate: "auto", manual: false, depends_on: [], runtime: "claude", reds: [] }],
  };
  const { runId } = startRun({ workflow: wf, title: "fg512g mixed", inputs: {}, projectDir: dir });
  const run = getRun(runId)!;

  // A pre-FG-512 `forge invoke --run <this-workflow-run>` row: phase "task", which
  // this workflow does NOT own — inserted BEFORE the runner mints its stamped rows,
  // simulating a run resumed after the upgrade.
  const legacy = legacyFailedTask("task-legacy-invoke", run, "task", { task: "a legacy side quest" });

  // The runner now mints a stamped `build` primary in the SAME run.
  await runNext({ runId, workflow: wf, dockerExec: completeExec({ status: "complete", tests_run: 1 }) });
  const stamped = tasksForRun(runId).find((t) => t.phase === "build" && t.parentId === undefined)!;
  assert.equal(stamped.taskPackage.dispatchSource, "workflow", "fixture: the runner row is stamped");

  // Each classifies from its OWN provenance — the sibling's marker is irrelevant.
  assert.equal(taskDispatchKind(getTask(legacy.id)!, run).kind, "adhoc", "the legacy `task` row (phase not owned by the workflow) is structurally ad-hoc");
  assert.equal(taskDispatchKind(stamped, run).kind, "workflow_step", "the stamped `build` row is decisively a workflow step");
});

test("FG-512 gap2 (mixed, fail-closed): stamped vs marker-less rows in the SAME `task` phase — only the marker decides", async () => {
  const dir = projectDir();
  const wfName = "fg512g-taskstep";
  mkdirSync(join(process.env.FORGE_HOME!, "workflows"), { recursive: true });
  // A workflow that legitimately OWNS a step whose id is `task` — the exact
  // collision the marker exists to resolve.
  writeFileSync(
    join(process.env.FORGE_HOME!, "workflows", `${wfName}.yml`),
    `name: ${wfName}
description: owns a step id 'task'
inputs: []
steps:
  - id: task
    agent: engineer
    gate: auto
`,
  );
  publishFlatAsGeneration(process.env.FORGE_HOME!);
  const wf: Workflow = {
    name: wfName,
    description: "owns a step id 'task'",
    review_mode: "legacy_verdict",
    inputs: [],
    steps: [{ id: "task", agent: "engineer", gate: "auto", manual: false, depends_on: [], runtime: "claude", reds: [] }],
  };
  const { runId } = startRun({ workflow: wf, title: "fg512g taskstep", inputs: {}, projectDir: dir });
  const run = getRun(runId)!;

  // The runner mints a stamped `task`-step primary; crash it so it's a terminal row.
  await runNext({ runId, workflow: wf, dockerExec: crashExec });
  const stamped = tasksForRun(runId).find((t) => t.phase === "task")!;
  assert.equal(stamped.taskPackage.dispatchSource, "workflow", "fixture: the runner `task`-step primary is stamped");

  // A legacy marker-less row ALSO in phase "task" (a pre-upgrade attempt) — same
  // run, same phase, same workflow. The ONLY difference from `stamped` is the
  // marker. taskDispatchKind reads a single row, so classification cannot leak
  // between the two.
  const legacy = legacyFailedTask("task-legacy-ambiguous", run, "task", { task: "pre-upgrade attempt" });

  assert.equal(taskDispatchKind(stamped, run).kind, "workflow_step", "the stamped `task` row is decisive");
  const legacyKind = taskDispatchKind(getTask(legacy.id)!, run);
  assert.equal(legacyKind.kind, "unknown", "the marker-less `task` row stays fail-closed");
  assert.equal(legacyKind.kind === "unknown" ? legacyKind.reason : undefined, "legacy_ambiguous_phase");
});

// ── Gap 3: the marker survives a real on-disk close + reopen (process restart) ──

test("FG-512 gap3: the retry-written `workflow` marker survives a SQLite close/reopen, read back through getTask", async () => {
  const dir = projectDir();
  const dbDir = mkdtempSync(join(tmpdir(), "forge-fg512g-db-"));
  tmpDirs.push(dbDir);
  const dbFile = join(dbDir, "forge.db");

  // A real on-disk DB (not :memory:) so a close + reopen is a genuine process
  // restart, not a same-handle read.
  const fileDb = new Database(dbFile);
  fileDb.pragma("foreign_keys = ON");
  fileDb.exec(SCHEMA_SQL);
  applyMigrations(fileDb);
  const innerPrev = setDbForTest(fileDb);

  let retriedId: string;
  let failedId: string;
  try {
    const wf: Workflow = {
      name: "fg512g-roundtrip",
      description: "single build step",
      review_mode: "legacy_verdict",
      inputs: [],
      steps: [{ id: "build", agent: "engineer", gate: "auto", manual: false, depends_on: [], runtime: "claude", reds: [] }],
    };
    const { runId } = startRun({ workflow: wf, title: "fg512g roundtrip", inputs: {}, projectDir: dir });

    // Real runner dispatch → crash → retry: exercises the exact write path
    // (runNext insertTask, then retry insertTask) the marker must survive.
    await runNext({ runId, workflow: wf, dockerExec: crashExec });
    const failed = tasksForRun(runId).find((t) => t.phase === "build")!;
    failedId = failed.id;
    assert.equal(failed.taskPackage.dispatchSource, "workflow", "fixture: the runner primary is stamped");

    updateRunStatus(runId, "active");
    const out = await retry(failed.id);
    retriedId = out.newTask.id;
    assert.equal(getTask(retriedId)!.taskPackage.dispatchSource, "workflow", "pre-restart: the retried row is stamped");
  } finally {
    fileDb.close();
  }

  // Reopen the same file in a FRESH handle — the in-memory object is gone.
  const reopened = new Database(dbFile);
  reopened.pragma("foreign_keys = ON");
  setDbForTest(reopened);
  try {
    const rehydratedFailed = getTask(failedId)!;
    const rehydratedRetry = getTask(retriedId)!;
    assert.equal(rehydratedFailed.taskPackage.dispatchSource, "workflow", "the failed row's marker survived the restart");
    assert.equal(rehydratedRetry.taskPackage.dispatchSource, "workflow", "the retried row's marker survived the restart");
    // And still classifies decisively off the rehydrated JSON column.
    const run = getRun(rehydratedRetry.runId)!;
    assert.equal(taskDispatchKind(rehydratedRetry, run).kind, "workflow_step", "the rehydrated row still routes as a workflow step");
  } finally {
    reopened.close();
    setDbForTest(innerPrev as DatabaseInstance);
  }
});
