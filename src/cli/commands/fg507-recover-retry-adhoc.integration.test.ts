// FG-507: the recover → cancel → retry → dispatch lifecycle for an ad-hoc
// (forge invoke) task, exercised over the real store / real invoke dispatch
// path, stubbing only the container-exec boundary.
//
// Both gaps hit live on 2026-07-09 (run run-fg-502-…, task task-engineer-68c1cd):
//   1. `forge recover` on a RUNNING task with a dead container recommended a
//      bare `forge retry`, which retry then refuses ("status running, not failed").
//   2. `forge retry` on the ad-hoc row that followed minted a pending task and
//      pointed at `forge next`, which never dispatches ad-hoc rows — it stranded.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../../store/db.js";
import { insertRun, getRun } from "../../store/runs.js";
import { insertTask, getTask, tasksForRun } from "../../store/tasks.js";
import { logEvent } from "../../store/events.js";
import { taskDir } from "../../util/paths.js";
import { failureKindForTask } from "../../v2/failure-kind.js";
import { invoke, createInvokeRun, type DockerExecFn } from "../../v2/invoke.js";
import {
  retry,
  dispatchRetriedAdHocTask,
  AdHocRedispatchUnavailableError,
  RetryWorkflowUnloadableError,
} from "../../v2/retry.js";
import { taskDispatchKind } from "../../v2/run-kind.js";
import { loadWorkflow } from "../../v2/loader.js";
import { computeReadyQueue } from "../../v2/ready-queue.js";
import { performInspect } from "./recover.js";
import { performCancel } from "./cancel.js";
import { retrySummaryLines } from "./retry.js";
import type { Run, Task } from "../../types/index.js";

let db: DatabaseInstance;
let prev: DatabaseInstance | null;
const tmpDirs: string[] = [];

const WORKFLOW_NAME = "fg507wf";

function setupRuntimeStub(): void {
  const runtimePath = join(process.env["FORGE_HOME"]!, "runtimes", "claude.yml");
  if (existsSync(runtimePath)) return;
  mkdirSync(dirname(runtimePath), { recursive: true });
  writeFileSync(
    runtimePath,
    `
name: claude
description: test stub
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

/** A non-git project dir (so changedWorktreeFiles finds nothing) carrying a
 *  real workflow YAML that loadWorkflow can resolve as a project override. */
function trackedProjectDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "forge-fg507-proj-"));
  tmpDirs.push(dir);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fg507-fixture" }));
  mkdirSync(join(dir, ".forge", "workflows"), { recursive: true });
  writeFileSync(
    join(dir, ".forge", "workflows", `${WORKFLOW_NAME}.yml`),
    `
name: ${WORKFLOW_NAME}
description: fg507 fixture workflow
inputs: []
steps:
  - id: build
    agent: engineer
    gate: auto
`,
  );
  return dir;
}

/** A policy-mode project: two profiles, `ambient` is every default, `pinned` is
 *  reachable only via an explicit `--profile`. Both declare `runtime: claude` (the
 *  #265 escape hatch) so they resolve onto the single stubbed runtime YAML rather
 *  than the (provider, auth) binding table's claude-oauth/claude-apikey names. */
function policyProjectDir(): string {
  const dir = trackedProjectDir();
  writeFileSync(
    join(dir, ".forge", "model-policy.yml"),
    `
model_profiles:
  ambient:
    provider: anthropic
    auth: api
    runtime: claude
    map:
      default: { model: ambient-model, cost_tier: cheap }
  pinned:
    provider: anthropic
    auth: api
    runtime: claude
    map:
      default: { model: pinned-model, cost_tier: premium }
defaults:
  profile: ambient
  activity: {}
overrides:
  agents:
    engineer: ambient
allowed_profiles: [ambient, pinned]
`,
  );
  return dir;
}

function stubExec(result: unknown, exitCode = 0): DockerExecFn {
  return async ({ stdoutPath, stderrPath }) => {
    const dir = dirname(stdoutPath);
    mkdirSync(dir, { recursive: true });
    if (result !== undefined) writeFileSync(join(dir, "result.json"), JSON.stringify(result));
    writeFileSync(stdoutPath, "stub stdout");
    writeFileSync(stderrPath, "");
    return exitCode;
  };
}

/** Never resolves — the container is still "running" from forge's point of
 *  view. Reproduces the FG-502 shape exactly: forge's own process was killed
 *  mid-exec, so the task row never settled out of `running`. */
const hangingExec: DockerExecFn = async () => new Promise<number>(() => {});

async function settle(): Promise<void> {
  await new Promise((r) => setImmediate(r));
}

/** Start an invoke that parks in the container exec, leaving a REAL running row
 *  (manifest + task dir + container.started event all written by invoke itself). */
async function startHangingInvoke(projectDir: string): Promise<{ runId: string; task: Task }> {
  const runId = createInvokeRun("engineer", projectDir, undefined, "fg507 e2e", undefined);
  void invoke({ agentRole: "engineer", task: "fix the scope guard", projectDir, runId, dockerExec: hangingExec });
  await settle();
  const task = tasksForRun(runId)[0]!;
  return { runId, task };
}

let savedApiKey: string | undefined;

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
  setupRuntimeStub();
  // The stub runtime declares auth.mode=apikey; buildDockerArgs refuses to
  // assemble a container without the credential, before the stubbed exec runs.
  savedApiKey = process.env["ANTHROPIC_API_KEY"];
  process.env["ANTHROPIC_API_KEY"] = "sk-stub";
});

afterEach(() => {
  if (savedApiKey === undefined) delete process.env["ANTHROPIC_API_KEY"];
  else process.env["ANTHROPIC_API_KEY"] = savedApiKey;
  setDbForTest(prev as DatabaseInstance);
  db.close();
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// ── 1. END-TO-END (ticket AC3): the path that was impossible live ────────────

test("FG-507 e2e: running ad-hoc task + gone container → recover names cancel→retry → that exact sequence dispatches and completes", async () => {
  const projectDir = trackedProjectDir();
  const { runId, task } = await startHangingInvoke(projectDir);

  assert.equal(task.status, "running", "fixture: the row is stuck running");
  assert.ok(existsSync(join(taskDir(runId, task.id), "manifest.json")), "fixture: invoke wrote a real dispatch receipt");

  // recover, with the container confirmed gone (the evidence recover already holds).
  const outcome = performInspect(task.id, () => false);
  assert.equal(outcome.kind, "inspect-task");
  if (outcome.kind !== "inspect-task") return;

  // The human `next:` line carries BOTH commands, verbatim.
  assert.ok(
    outcome.task.recommendation.includes(`forge cancel ${task.id}`),
    `expected a cancel command in: ${outcome.task.recommendation}`,
  );
  assert.ok(
    outcome.task.recommendation.includes(`forge retry ${task.id}`),
    `expected a retry command in: ${outcome.task.recommendation}`,
  );
  assert.deepEqual(outcome.task.recommendationCommands, [`forge cancel ${task.id}`, `forge retry ${task.id}`]);

  // Now execute EXACTLY that sequence, driven off the recommendation itself.
  const [cancelCmd, retryCmd] = outcome.task.recommendationCommands;
  assert.equal(cancelCmd, `forge cancel ${task.id}`);
  performCancel(task.id, {}, () => {});
  assert.equal(getTask(task.id)!.status, "failed");
  assert.equal(failureKindForTask(task.id), "cancelled");

  assert.equal(retryCmd, `forge retry ${task.id}`, "post-cancel kind 'cancelled' is retryable — no --force");
  const out = await retry(task.id);
  assert.ok(out.adHoc, "the retried row is ad-hoc and carries a dispatch plan");

  const result = await dispatchRetriedAdHocTask(out.newTask, out.adHoc!, stubExec({ status: "complete", note: "redispatched" }));

  assert.equal(result.status, "complete");
  assert.equal(result.taskId, out.newTask.id);
  assert.equal(getTask(out.newTask.id)!.status, "complete", "the retried task actually dispatched and ingested its result");
  assert.deepEqual(getTask(out.newTask.id)!.result, { status: "complete", note: "redispatched" });
  assert.equal(getRun(runId)!.status, "complete", "the run finalized once no top-level task was in flight");

  // Lineage survives the re-dispatch — on the row, and in the package the agent reads.
  const prevFailure = out.newTask.taskPackage.inputs["previous_failure"] as { failedTaskId: string; kind: string };
  assert.equal(prevFailure.failedTaskId, task.id);
  assert.equal(prevFailure.kind, "cancelled");

  const pkg = readFileSync(join(taskDir(runId, out.newTask.id), "package.md"), "utf8");
  assert.match(pkg, /## Previous attempt \(this is a retry\)/);
  assert.match(pkg, new RegExp(`Task ${task.id} attempted this same work`));
  assert.match(pkg, /failure_kind=cancelled/);
  assert.match(pkg, /fix the scope guard/, "the original task text still reaches the agent");
});

test("FG-507: a plain invoke's package.md gains no previous-attempt section", async () => {
  const projectDir = trackedProjectDir();
  const r = await invoke({ agentRole: "engineer", task: "fresh work", projectDir, dockerExec: stubExec({ status: "complete" }) });
  assert.equal(r.status, "complete");
  const pkg = readFileSync(join(taskDir(r.runId, r.taskId), "package.md"), "utf8");
  assert.doesNotMatch(pkg, /Previous attempt/);
});

// ── 2. the ad-hoc discriminator ─────────────────────────────────────────────

test("FG-507 2a: a synthetic invoke-run task re-dispatches directly, with no `forge next` pointer in the output", async () => {
  const projectDir = trackedProjectDir();
  const r = await invoke({ agentRole: "engineer", task: "do work", projectDir, dockerExec: stubExec(undefined, 1) });
  assert.equal(r.status, "failed", "fixture: exit 1 with no result.json → container_crash");

  const out = await retry(r.taskId);
  assert.ok(out.adHoc, "run.workflow === 'invoke' → ad-hoc");

  const text = retrySummaryLines(r.taskId, out).join("\n");
  assert.doesNotMatch(text, /forge next/, "an ad-hoc retry must never point at the workflow ready queue");
  assert.match(text, /Re-dispatching directly \(invoke semantics\)/);

  const result = await dispatchRetriedAdHocTask(out.newTask, out.adHoc!, stubExec({ status: "complete" }));
  assert.equal(result.status, "complete");
  assert.equal(getTask(out.newTask.id)!.status, "complete");
});

test("FG-507 2b: an invoke task attached to a REAL workflow run via --run is ad-hoc too (its phase is not a step)", async () => {
  const projectDir = trackedProjectDir();
  const run: Run = {
    id: "run-fg507-real",
    workflow: WORKFLOW_NAME,
    title: "real workflow run",
    status: "active",
    createdAt: "2026-07-09T00:00:00Z",
    projectDir,
  };
  insertRun(run);

  const r = await invoke({ agentRole: "engineer", task: "side quest", projectDir, runId: run.id, dockerExec: stubExec(undefined, 1) });
  assert.equal(r.status, "failed");
  const attached = getTask(r.taskId)!;
  assert.equal(attached.phase, "task");
  assert.equal(taskDispatchKind(attached, run).kind, "adhoc", "phase 'task' is not among the workflow's step ids");

  const out = await retry(r.taskId);
  assert.ok(out.adHoc, "attached invoke task → ad-hoc");
  assert.doesNotMatch(retrySummaryLines(r.taskId, out).join("\n"), /forge next/);

  const result = await dispatchRetriedAdHocTask(out.newTask, out.adHoc!, stubExec({ status: "complete" }));
  assert.equal(result.status, "complete");
  assert.equal(getTask(out.newTask.id)!.status, "complete");
});

// REGRESSION PIN — this must pass against HEAD too. A genuine workflow-step task
// keeps today's behavior exactly: a pending primary row the ready queue picks up.
test("FG-507 2c: a genuine workflow-step task keeps the pending-row + ready-queue behavior", async () => {
  const projectDir = trackedProjectDir();
  const run: Run = {
    id: "run-fg507-step",
    workflow: WORKFLOW_NAME,
    title: "real workflow run",
    status: "active",
    createdAt: "2026-07-09T00:00:00Z",
    projectDir,
  };
  insertRun(run);

  const failed: Task = {
    id: "task-build-aaa111",
    runId: run.id,
    phase: "build",
    agentRole: "engineer",
    status: "failed",
    error: "boom",
    taskPackage: { taskId: "task-build-aaa111", runId: run.id, phase: "build", role: "engineer", inputs: { brief: "b" }, composedSystemPrompt: "PROMPT" },
    createdAt: "2026-07-09T00:00:00Z",
  };
  insertTask(failed);
  logEvent("task.failed", { runId: run.id, taskId: failed.id, payload: { failure_kind: "container_crash", error: "boom" } });

  const out = await retry(failed.id);

  const newRow = getTask(out.newTask.id)!;
  assert.equal(newRow.status, "pending");
  assert.equal(newRow.phase, "build");
  assert.equal(newRow.parentId, undefined, "a PRIMARY row — runNext.dispatchStep only reuses pending primaries");
  assert.equal(newRow.taskPackage.composedSystemPrompt, "", "recomposed at dispatch by the runner");

  // And the ready queue — what `forge next` walks — still admits it.
  const workflow = loadWorkflow(WORKFLOW_NAME, { projectDir });
  const ready = computeReadyQueue(workflow, tasksForRun(run.id));
  assert.deepEqual(ready.map((s) => s.id), ["build"], "`forge next` picks the retried step up, exactly as before");
});

test("FG-507 2c (output pin): a workflow-step retry still prints the `forge next` pointer", async () => {
  const projectDir = trackedProjectDir();
  const run: Run = { id: "run-fg507-step2", workflow: WORKFLOW_NAME, title: "t", status: "active", createdAt: "2026-07-09T00:00:00Z", projectDir };
  insertRun(run);
  const failed: Task = {
    id: "task-build-bbb222",
    runId: run.id,
    phase: "build",
    agentRole: "engineer",
    status: "failed",
    error: "boom",
    taskPackage: { taskId: "task-build-bbb222", runId: run.id, phase: "build", role: "engineer", inputs: {}, composedSystemPrompt: "P" },
    createdAt: "2026-07-09T00:00:00Z",
  };
  insertTask(failed);
  logEvent("task.failed", { runId: run.id, taskId: failed.id, payload: { failure_kind: "container_crash", error: "boom" } });

  const out = await retry(failed.id);
  assert.equal(out.adHoc, undefined, "a real workflow step is never ad-hoc");
  assert.deepEqual(retrySummaryLines(failed.id, out), [
    `Retried ${failed.id} [container_crash] (kept as failed for audit)`,
    "  transient infrastructure failure; re-dispatch.",
    `  new task: ${out.newTask.id} (pending, lineage → ${failed.id})`,
    "",
    "Next:",
    `  forge next ${run.id}`,
  ]);
});

// ── 3. fail-closed: refuse rather than strand ───────────────────────────────

test("FG-507 3: an ad-hoc retry that cannot dispatch refuses with a ready-to-run invoke command and creates NO pending row", async () => {
  const projectDir = trackedProjectDir();
  const runId = createInvokeRun("engineer", projectDir, undefined, "legacy", undefined);

  // A legacy row: no inputs.task, so there is no task text to hand the agent.
  const legacy: Task = {
    id: "task-engineer-legacy",
    runId,
    phase: "task",
    agentRole: "engineer",
    status: "failed",
    error: "boom",
    taskPackage: { taskId: "task-engineer-legacy", runId, phase: "task", role: "engineer", inputs: {}, composedSystemPrompt: "" },
    createdAt: "2026-07-09T00:00:00Z",
  };
  insertTask(legacy);
  logEvent("task.failed", { runId, taskId: legacy.id, payload: { failure_kind: "container_crash", error: "boom" } });

  await assert.rejects(
    () => retry(legacy.id),
    (e: unknown) => {
      assert.ok(e instanceof AdHocRedispatchUnavailableError);
      assert.match(e.message, /no `inputs\.task` text/);
      assert.match(e.message, /No pending task row was created/);
      assert.match(e.message, new RegExp(`forge invoke engineer --run ${runId}`));
      assert.match(e.message, new RegExp(`--project ${projectDir}`));
      return true;
    },
  );

  assert.deepEqual(
    tasksForRun(runId).map((t) => t.id),
    [legacy.id],
    "no stranded pending row — the refusal happened before any write",
  );
});

// A workflow that won't load means forge cannot tell a workflow step from an
// invoke-attached row. Answering "not ad-hoc" there mints a pending row + a
// `forge next` pointer that never fires — the exact stranding FG-507 removes.
test("FG-507 3b: an invoke-attached task whose workflow YAML broke refuses pre-write, naming the load error and the invoke command", async () => {
  const projectDir = trackedProjectDir();
  const run: Run = {
    id: "run-fg507-broken",
    workflow: WORKFLOW_NAME,
    title: "real workflow run",
    status: "active",
    createdAt: "2026-07-09T00:00:00Z",
    projectDir,
  };
  insertRun(run);

  const r = await invoke({ agentRole: "engineer", task: "side quest", projectDir, runId: run.id, dockerExec: stubExec(undefined, 1) });
  assert.equal(r.status, "failed");

  const wfPath = join(projectDir, ".forge", "workflows", `${WORKFLOW_NAME}.yml`);
  writeFileSync(wfPath, "name: fg507wf\nsteps: [ unclosed\n");
  assert.equal(taskDispatchKind(getTask(r.taskId)!, run).kind, "unknown", "fixture: the workflow no longer loads");

  await assert.rejects(
    () => retry(r.taskId),
    (e: unknown) => {
      assert.ok(e instanceof RetryWorkflowUnloadableError, `expected RetryWorkflowUnloadableError, got ${e}`);
      assert.match(e.message, /YAML parse error/, "the refusal names the workflow-load error");
      assert.match(e.message, /No pending task row was created/);
      assert.match(e.message, new RegExp(`forge invoke engineer --run ${run.id}`), "ready-to-run direct re-dispatch");
      assert.match(e.message, new RegExp(`--project ${projectDir}`));
      assert.match(e.message, /--task 'side quest'/, "the recorded task text is handed back verbatim");
      assert.match(e.message, new RegExp(`forge retry ${r.taskId}`), "and the restore-the-YAML path");
      return true;
    },
  );

  assert.deepEqual(
    tasksForRun(run.id).map((t) => t.id),
    [r.taskId],
    "no stranded pending row — the refusal happened before any write",
  );

  // A missing workflow file is the same fail-closed answer, with its own load error.
  rmSync(wfPath);
  await assert.rejects(() => retry(r.taskId), (e: unknown) => {
    assert.ok(e instanceof RetryWorkflowUnloadableError);
    assert.match(e.message, /not found at/);
    return true;
  });
  assert.equal(tasksForRun(run.id).length, 1, "still no pending row");
});

test("FG-507 3b: a genuine workflow-step task whose workflow YAML broke also refuses pre-write, with restore-then-retry guidance", async () => {
  const projectDir = trackedProjectDir();
  const run: Run = {
    id: "run-fg507-broken-step",
    workflow: WORKFLOW_NAME,
    title: "real workflow run",
    status: "active",
    createdAt: "2026-07-09T00:00:00Z",
    projectDir,
  };
  insertRun(run);

  const failed: Task = {
    id: "task-build-ccc333",
    runId: run.id,
    phase: "build",
    agentRole: "engineer",
    status: "failed",
    error: "boom",
    taskPackage: { taskId: "task-build-ccc333", runId: run.id, phase: "build", role: "engineer", inputs: { brief: "b" }, composedSystemPrompt: "PROMPT" },
    createdAt: "2026-07-09T00:00:00Z",
  };
  insertTask(failed);
  logEvent("task.failed", { runId: run.id, taskId: failed.id, payload: { failure_kind: "container_crash", error: "boom" } });

  writeFileSync(join(projectDir, ".forge", "workflows", `${WORKFLOW_NAME}.yml`), "name: fg507wf\nsteps: [ unclosed\n");

  await assert.rejects(
    () => retry(failed.id),
    (e: unknown) => {
      assert.ok(e instanceof RetryWorkflowUnloadableError);
      assert.match(e.message, /YAML parse error/);
      assert.match(e.message, /restore the workflow YAML/);
      assert.match(e.message, new RegExp(`re-run \`forge retry ${failed.id}\``), "retry is re-runnable once the YAML is back");
      assert.match(e.message, /No pending task row was created/);
      // No inputs.task text on a workflow step: don't render a fake ready-to-run command.
      assert.doesNotMatch(e.message, /the original task text — this row never recorded it/);
      return true;
    },
  );

  assert.deepEqual(tasksForRun(run.id).map((t) => t.id), [failed.id], "no pending row for the broken-workflow step either");
});

// ── 4. recover's recommendation ─────────────────────────────────────────────

test("FG-507 4: recover on running + confirmed-gone container recommends cancel-then-retry", async () => {
  const projectDir = trackedProjectDir();
  const { task } = await startHangingInvoke(projectDir);

  const outcome = performInspect(task.id, () => false);
  assert.equal(outcome.kind, "inspect-task");
  if (outcome.kind !== "inspect-task") return;
  assert.deepEqual(outcome.task.recommendationCommands, [`forge cancel ${task.id}`, `forge retry ${task.id}`]);
  assert.match(outcome.task.recommendation, /confirmed gone/);
  assert.match(outcome.task.recommendation, /cancel it first/);
});

test("FG-507 4: recover on running + LIVE container keeps the single-command recommendation (no cancel of live work)", async () => {
  const projectDir = trackedProjectDir();
  const { task } = await startHangingInvoke(projectDir);

  const outcome = performInspect(task.id, () => true);
  assert.equal(outcome.kind, "inspect-task");
  if (outcome.kind !== "inspect-task") return;
  assert.equal(outcome.task.recommendationCommands.length, 1);
  assert.doesNotMatch(outcome.task.recommendation, /forge cancel/);
});

// PIN: a plain failed task's recommendation is byte-for-byte what it was before FG-507.
test("FG-507 4: a failed task's single retry recommendation is unchanged", () => {
  const projectDir = trackedProjectDir();
  const run: Run = { id: "run-fg507-failed", workflow: "invoke", title: "t", status: "active", createdAt: "2026-07-09T00:00:00Z", projectDir };
  insertRun(run);
  const t: Task = {
    id: "task-engineer-fail1",
    runId: run.id,
    phase: "task",
    agentRole: "engineer",
    status: "failed",
    error: "boom",
    taskPackage: { taskId: "task-engineer-fail1", runId: run.id, phase: "task", role: "engineer", inputs: { task: "t" }, composedSystemPrompt: "" },
    createdAt: "2026-07-09T00:00:00Z",
  };
  insertTask(t);
  logEvent("task.failed", { runId: run.id, taskId: t.id, payload: { failure_kind: "container_crash", error: "boom" } });

  const outcome = performInspect(t.id, () => false);
  assert.equal(outcome.kind, "inspect-task");
  if (outcome.kind !== "inspect-task") return;
  assert.equal(outcome.task.recommendation, `forge retry ${t.id}  (no persisted work found — safe to re-dispatch from scratch)`);
  assert.deepEqual(outcome.task.recommendationCommands, [`forge retry ${t.id}`]);
});

// ── 5. an explicit --profile survives invoke → retry → re-dispatch ───────────

test("FG-507 5: `invoke --profile` → retry re-dispatches on the SAME pinned profile, not the ambient default", async () => {
  const projectDir = policyProjectDir();

  const r = await invoke({
    agentRole: "engineer",
    task: "pinned work",
    projectDir,
    modelProfile: "pinned",
    dockerExec: stubExec(undefined, 1),
  });
  assert.equal(r.status, "failed", "fixture: exit 1 with no result.json → container_crash");

  // Fixture pin: invoke RECORDED the explicit profile and its provenance.
  const manifest = JSON.parse(readFileSync(join(taskDir(r.runId, r.taskId), "manifest.json"), "utf8")) as {
    model?: { profile: string; model: string; resolvedBy: string };
  };
  assert.equal(manifest.model?.profile, "pinned");
  assert.equal(manifest.model?.resolvedBy, "cli.--profile");
  assert.equal(getTask(r.taskId)!.agentModel, "pinned-model");

  const out = await retry(r.taskId);
  assert.ok(out.adHoc, "ad-hoc → retry carries the dispatch plan");

  // THE REGRESSION: without replaying the recorded --profile, resolveModel would
  // fall through to overrides.agents.engineer and silently retry on `ambient`.
  assert.equal(out.adHoc!.resolution.profile, "pinned");
  assert.equal(out.adHoc!.resolution.model, "pinned-model");
  assert.equal(out.adHoc!.resolution.resolvedBy, "cli.--profile", "provenance survives, so a retry-of-a-retry stays pinned too");

  const newRow = getTask(out.newTask.id)!;
  assert.equal(newRow.resolvedProfile, "pinned", "the fresh row records the profile it will actually run under");
  assert.equal(newRow.agentModel, "pinned-model");
  assert.equal(newRow.resolvedBy, "cli.--profile");

  const result = await dispatchRetriedAdHocTask(out.newTask, out.adHoc!, stubExec({ status: "complete" }));
  assert.equal(result.status, "complete");

  const redispatched = JSON.parse(readFileSync(join(taskDir(r.runId, out.newTask.id), "manifest.json"), "utf8")) as {
    model?: { profile: string; model: string; resolvedBy: string };
  };
  assert.equal(redispatched.model?.profile, "pinned", "the re-dispatched container ran under the pinned profile");
  assert.equal(redispatched.model?.model, "pinned-model");
});

// The mirror image: an ambient resolution is a POLICY rule, not an operator pin,
// so it must re-evaluate against today's policy rather than being frozen at the
// failed attempt's value.
test("FG-507 5: a retry with no explicit --profile re-resolves through policy (no accidental pinning)", async () => {
  const projectDir = policyProjectDir();

  const r = await invoke({ agentRole: "engineer", task: "ambient work", projectDir, dockerExec: stubExec(undefined, 1) });
  assert.equal(r.status, "failed");
  assert.equal(getTask(r.taskId)!.resolvedBy, "overrides.agents.engineer");

  const out = await retry(r.taskId);
  assert.ok(out.adHoc);
  assert.equal(out.adHoc!.resolution.profile, "ambient");
  assert.equal(out.adHoc!.resolution.resolvedBy, "overrides.agents.engineer", "still a policy rule — never rewritten to cli.--profile");
  assert.equal(getTask(out.newTask.id)!.agentModel, "ambient-model");
});

// ── 6. partial manifests: recorded facts, never guesses ─────────────────────
// A pre-receipt / pre-#292 invoke row can carry a manifest missing whole blocks.
// The dispatch plan must read what WAS recorded (the auth.profile_applied event,
// either runtime name) and refuse when a fact it needs was never recorded at all
// — silently defaulting is how a retry lands unauthenticated or on the wrong runtime.

/** A failed ad-hoc row whose manifest.json is exactly `manifest` (possibly partial). */
function failedAdHocWithManifest(id: string, projectDir: string, manifest: unknown): Task {
  const runId = createInvokeRun("engineer", projectDir, undefined, "partial manifest", undefined);
  const t: Task = {
    id,
    runId,
    phase: "task",
    agentRole: "engineer",
    status: "failed",
    error: "boom",
    taskPackage: { taskId: id, runId, phase: "task", role: "engineer", inputs: { task: "partial work" }, composedSystemPrompt: "" },
    createdAt: "2026-07-09T00:00:00Z",
  };
  insertTask(t);
  logEvent("task.failed", { runId, taskId: id, payload: { failure_kind: "container_crash", error: "boom" } });
  const dir = taskDir(runId, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
  return t;
}

test("FG-507 6: a recorded auth profile is replayed even when the manifest has no `auth` block", async () => {
  const t = failedAdHocWithManifest("task-engineer-p001", trackedProjectDir(), { runtime: { name: "claude" } });
  logEvent("auth.profile_applied", { runId: t.runId, taskId: t.id, payload: { profile: "acme-staging", kind: "captured" } });

  const out = await retry(t.id);
  assert.ok(out.adHoc);
  assert.equal(
    out.adHoc!.authProfile,
    "acme-staging",
    "auth.profile_applied is the durable record — a missing manifest.auth flag must not drop it",
  );
});

test("FG-507 6: a manifest that requested a profile whose name was never recorded refuses pre-write", async () => {
  const t = failedAdHocWithManifest("task-engineer-p002", trackedProjectDir(), { runtime: { name: "claude" }, auth: { profileRequested: true, stateMounted: false } });

  await assert.rejects(() => retry(t.id), (e: unknown) => {
    assert.ok(e instanceof AdHocRedispatchUnavailableError);
    assert.match(e.message, /auth profile whose name was never recorded/);
    assert.match(e.message, /No pending task row was created/);
    return true;
  });
  assert.deepEqual(tasksForRun(t.runId).map((x) => x.id), [t.id], "no stranded pending row");
});

test("FG-507 6: an unauthenticated ad-hoc task (no flag, no event) still plans without a profile", async () => {
  const t = failedAdHocWithManifest("task-engineer-p003", trackedProjectDir(), { runtime: { name: "claude" }, auth: { profileRequested: false, stateMounted: false } });
  const out = await retry(t.id);
  assert.ok(out.adHoc);
  assert.equal(out.adHoc!.authProfile, undefined);
});

// These projects carry no model-policy.yml, so resolveModel runs in LEGACY mode —
// where `resolution.runtime` IS the runtime name it was handed, and is what selects
// the runtime YAML at spawn. That's the field a silent `?? "claude"` corrupts.
test("FG-507 6: a partial manifest's non-default runtime reaches the model resolution, not the `claude` default", async () => {
  const t = failedAdHocWithManifest("task-engineer-p004", trackedProjectDir(), { runtime: { name: "codex" } });

  const out = await retry(t.id);
  assert.ok(out.adHoc);
  assert.equal(out.adHoc!.runtimeName, "codex", "the RECORDED runtime");
  assert.equal(out.adHoc!.resolution.runtime, "codex", "and it is what the re-dispatch will actually run on");
});

test("FG-507 6: the FG-350 receipt's runtime.name is recovered when the manifest has no runtime block", async () => {
  const t = failedAdHocWithManifest("task-engineer-p005", trackedProjectDir(), { controlPlane: { runtime: { name: "codex" }, mountMode: "rw" } });

  const out = await retry(t.id);
  assert.ok(out.adHoc);
  assert.equal(out.adHoc!.runtimeName, "codex");
  assert.equal(out.adHoc!.resolution.runtime, "codex", "a legacy invoke on codex must never silently re-dispatch on claude");
});

test("FG-507 6: a manifest recording no runtime at all refuses pre-write rather than guessing claude", async () => {
  const t = failedAdHocWithManifest("task-engineer-p006", trackedProjectDir(), { taskId: "x", runId: "y" });

  await assert.rejects(() => retry(t.id), (e: unknown) => {
    assert.ok(e instanceof AdHocRedispatchUnavailableError);
    assert.match(e.message, /manifest records no runtime/);
    assert.match(e.message, /No pending task row was created/);
    assert.match(e.message, new RegExp(`forge invoke engineer --run ${t.runId}`));
    assert.match(e.message, /--task 'partial work'/);
    return true;
  });
  assert.deepEqual(tasksForRun(t.runId).map((x) => x.id), [t.id], "no stranded pending row");
});

// The runtime refusal above must NOT swallow the advertised "fix your auth, then
// retry" flow. invoke writes the manifest just before buildDockerArgs, so an auth
// or provider-preflight failure fails the task with NO manifest at all — nothing
// dispatched, so there is no runtime it ran under, and the retry re-resolves like
// a fresh invoke rather than refusing.
test("FG-507 6: an ad-hoc task that failed before dispatch wrote a manifest still retries (no over-refusal)", async () => {
  const projectDir = trackedProjectDir();
  const runId = createInvokeRun("engineer", projectDir, undefined, "auth failed", undefined);
  const id = "task-engineer-p007";
  insertTask({
    id, runId, phase: "task", agentRole: "engineer", status: "failed", error: "auth profile expired",
    taskPackage: { taskId: id, runId, phase: "task", role: "engineer", inputs: { task: "partial work" }, composedSystemPrompt: "" },
    createdAt: "2026-07-09T00:00:00Z",
  });
  logEvent("task.failed", { runId, taskId: id, payload: { failure_kind: "auth_expired", error: "auth profile expired" } });
  assert.ok(!existsSync(join(taskDir(runId, id), "manifest.json")), "fixture: the task died before dispatch wrote a receipt");

  const out = await retry(id);
  assert.ok(out.adHoc, "retryable after the operator fixes auth — not refused for a runtime that was never recorded");
  assert.equal(out.adHoc!.runtimeName, undefined, "nothing was recorded, so nothing is claimed as recorded");
  assert.equal(out.adHoc!.resolution.runtime, "claude", "re-resolved exactly as a fresh `forge invoke` would");
});
