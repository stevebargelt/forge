// FG-559 piece A, container half: the entrypoint's git probe exits 122, and the
// RUNNER has to classify that. The implementation was smoke-tested by running
// the probe standalone; the classification itself lives in invoke.ts and
// runNext.ts and had no coverage at all — a repo-wide grep for
// GIT_UNAVAILABLE / container.git_unavailable across *.test.ts returned nothing.
//
// What has to hold:
//   - 122 lands the task on the TERMINAL failed state with
//     verification_environment_unavailable — not container_crash, and above all
//     not left `running` by an error that was returned instead of thrown.
//   - the container.git_unavailable event actually reaches the STORE, not just
//     the branch being taken.
//   - 122 and 123 stay distinct. They are adjacent integers classified to the
//     same failure kind, so a swap is invisible to any test that only looks at
//     the kind. The events are what separate them.
//
// Tier: integration — same tier and same stubbed-dockerExec shape as the
// existing exit-123 / 124 / 137 classification tests in
// invoke.integration.test.ts and runNext.integration.test.ts.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { invoke, type DockerExecFn } from "./invoke.js";
import { runNext } from "./runNext.js";
import { startRun } from "./startRun.js";
import { reconcileRun } from "./reconcile.js";
import { insertTask } from "../store/tasks.js";
import { logEvent } from "../store/events.js";
import { getContainerCausalEvidenceFromEvents } from "./failure-kind.js";
import { publishFlatAsGeneration } from "./seed-generation.testkit.js";
import { GIT_UNAVAILABLE_EXIT_CODE } from "./spawn.js";
import { DEPENDENCY_PROVISIONING_FAILED_EXIT_CODE } from "./dependency-provisioning.js";
import { getTask, tasksForRun } from "../store/tasks.js";
import { eventsForTask } from "../store/events.js";
import { failureKindForTask } from "./failure-kind.js";
import type { Workflow } from "./schema.js";

const LINEAR_WORKFLOW: Workflow = {
  name: "fg559-linear",
  description: "two-step linear test",
  review_mode: "legacy_verdict",
  inputs: [{ name: "brief", required: true, type: "text" }],
  steps: [
    { id: "first", agent: "test-agent", gate: "auto", manual: false, depends_on: [], runtime: "claude", reds: [] },
    { id: "second", agent: "test-agent", gate: "auto", manual: false, depends_on: ["first"], runtime: "claude", reds: [] },
  ],
};

function ensureRuntime(): void {
  const fhome = process.env["FORGE_HOME"]!;
  const runtimePath = join(fhome, "runtimes", "claude.yml");
  if (!existsSync(runtimePath)) {
    mkdirSync(dirname(runtimePath), { recursive: true });
    writeFileSync(
      runtimePath,
      `
name: claude
description: fg559 classification stub
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
`
    );
  }
  publishFlatAsGeneration(fhome);
}

/** The entrypoint's git probe firing: it exits BEFORE the agent runs, so there
 *  is no result.json at all — only a stderr tail naming the cause. */
function sentinelExec(exitCode: number, stderr: string): DockerExecFn {
  return async ({ stdoutPath, stderrPath }) => {
    const dir = dirname(stdoutPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(stdoutPath, "");
    writeFileSync(stderrPath, stderr);
    return exitCode;
  };
}

const PROBE_STDERR =
  "forge: git is unusable in /project: fatal: not a git repository: /host/parent/.git/worktrees/wt";

// ─── invoke path ─────────────────────────────────────────────────────────────

test("fg559: invoke — exit 122 fails the task as verification_environment_unavailable and lands container.git_unavailable in the store", async () => {
  ensureRuntime();
  process.env["ANTHROPIC_API_KEY"] = "sk-stub";

  const r = await invoke({
    agentRole: "engineer",
    task: "do thing",
    projectDir: "/tmp/x",
    dockerExec: sentinelExec(GIT_UNAVAILABLE_EXIT_CODE, PROBE_STDERR),
  });

  assert.equal(r.status, "failed");
  assert.match(r.error ?? "", /verification_environment_unavailable/);
  assert.match(r.error ?? "", /git is unusable in the project mount/);
  assert.match(r.error ?? "", /not a git repository/, "the container's own stderr tail must reach the operator");
  assert.doesNotMatch(r.error ?? "", /container_crash/);

  // The failure mode this pins: an error RETURNED but never landed, leaving the
  // row `running` forever. Terminal state is the assertion, not the message.
  const task = getTask(r.taskId);
  assert.ok(task);
  assert.equal(task!.status, "failed", `task must be terminal-failed, got ${task!.status}`);
  assert.equal(failureKindForTask(r.taskId), "verification_environment_unavailable");

  // Asserted against the STORE, not against the branch having been taken.
  const types = eventsForTask(r.taskId).map((e) => e.eventType);
  assert.ok(types.includes("container.git_unavailable"), `container.git_unavailable must be recorded, got: ${types.join(", ")}`);
  assert.ok(!types.includes("container.exited"), "a probe refusal is not a normal container exit");

  const ev = eventsForTask(r.taskId).find((e) => e.eventType === "container.git_unavailable")!;
  assert.equal(
    (ev.payload as Record<string, unknown>)["exitCode"],
    GIT_UNAVAILABLE_EXIT_CODE,
    "the event payload must carry the sentinel that produced it"
  );
});

test("fg559: invoke — 122 and 123 are NOT conflated; each emits only its own event", async () => {
  ensureRuntime();
  process.env["ANTHROPIC_API_KEY"] = "sk-stub";

  const gitFail = await invoke({
    agentRole: "engineer",
    task: "git probe",
    projectDir: "/tmp/x",
    dockerExec: sentinelExec(GIT_UNAVAILABLE_EXIT_CODE, "git is unusable"),
  });
  const depsFail = await invoke({
    agentRole: "engineer",
    task: "deps",
    projectDir: "/tmp/x",
    dockerExec: sentinelExec(DEPENDENCY_PROVISIONING_FAILED_EXIT_CODE, "npm ci failed: EACCES"),
  });

  const gitTypes = eventsForTask(gitFail.taskId).map((e) => e.eventType);
  const depsTypes = eventsForTask(depsFail.taskId).map((e) => e.eventType);

  // Both classify to the same failure KIND, so the kind cannot tell them apart —
  // these four assertions are what would go red if the two constants were swapped.
  assert.ok(gitTypes.includes("container.git_unavailable"));
  assert.ok(!gitTypes.includes("container.dependency_provisioning_failed"));
  assert.ok(depsTypes.includes("container.dependency_provisioning_failed"));
  assert.ok(!depsTypes.includes("container.git_unavailable"));

  assert.match(gitFail.error ?? "", /git is unusable in the project mount/);
  assert.doesNotMatch(gitFail.error ?? "", /dependency/i);
  assert.match(depsFail.error ?? "", /dependency|npm ci/i);
  assert.doesNotMatch(depsFail.error ?? "", /git is unusable in the project mount/);

  assert.notEqual(
    GIT_UNAVAILABLE_EXIT_CODE,
    DEPENDENCY_PROVISIONING_FAILED_EXIT_CODE,
    "adjacent sentinels must stay distinct integers"
  );
});

// ─── runNext (pipeline) path ─────────────────────────────────────────────────

test("fg559: runNext — exit 122 fails the pipeline step terminally, records container.git_unavailable, and stops the pipeline", async () => {
  ensureRuntime();
  process.env["ANTHROPIC_API_KEY"] = "sk-stub";

  const { runId } = startRun({
    workflow: LINEAR_WORKFLOW,
    title: "fg559 git-unavailable",
    inputs: { brief: "x" },
    projectDir: "/tmp/test-project",
  });

  const wave = await runNext({
    runId,
    workflow: LINEAR_WORKFLOW,
    dockerExec: sentinelExec(GIT_UNAVAILABLE_EXIT_CODE, PROBE_STDERR),
  });
  assert.deepEqual(wave.failedSteps, ["first"]);

  const first = tasksForRun(runId).find((t) => t.phase === "first");
  assert.ok(first);
  assert.equal(first!.status, "failed", `the step must be terminal-failed, got ${first!.status}`);
  assert.match(first!.error ?? "", /verification_environment_unavailable/);
  assert.match(first!.error ?? "", /not a git repository/);
  assert.doesNotMatch(first!.error ?? "", /container_crash/);
  assert.equal(failureKindForTask(first!.id), "verification_environment_unavailable");

  const types = eventsForTask(first!.id).map((e) => e.eventType);
  assert.ok(types.includes("container.git_unavailable"), `got: ${types.join(", ")}`);
  assert.ok(!types.includes("container.exited"));

  // An environment failure at step 1 must not advance the pipeline — a
  // history-blind step must not silently feed step 2.
  assert.equal(
    tasksForRun(runId).some((t) => t.phase === "second"),
    false,
    "the downstream step must not be dispatched after a git-unavailable refusal"
  );
});

test("fg559: runNext — a git-unavailable step is classified the same as a provisioning failure but is still distinguishable from it", async () => {
  ensureRuntime();
  process.env["ANTHROPIC_API_KEY"] = "sk-stub";

  const mk = async (exitCode: number, stderr: string) => {
    const { runId } = startRun({
      workflow: LINEAR_WORKFLOW,
      title: `fg559 sentinel ${exitCode}`,
      inputs: { brief: "x" },
      projectDir: "/tmp/test-project",
    });
    await runNext({ runId, workflow: LINEAR_WORKFLOW, dockerExec: sentinelExec(exitCode, stderr) });
    const t = tasksForRun(runId).find((x) => x.phase === "first")!;
    return { task: t, types: eventsForTask(t.id).map((e) => e.eventType) };
  };

  const git = await mk(GIT_UNAVAILABLE_EXIT_CODE, "git is unusable");
  const deps = await mk(DEPENDENCY_PROVISIONING_FAILED_EXIT_CODE, "npm ci failed");

  assert.equal(failureKindForTask(git.task.id), failureKindForTask(deps.task.id));
  assert.ok(git.types.includes("container.git_unavailable"));
  assert.ok(!git.types.includes("container.dependency_provisioning_failed"));
  assert.ok(deps.types.includes("container.dependency_provisioning_failed"));
  assert.ok(!deps.types.includes("container.git_unavailable"));
});

// ─── reconcile (the watcher died) ────────────────────────────────────────────
//
// The two classification paths above both assume a live watcher: it sees the 122,
// logs container.git_unavailable, and fails the task. Kill the forge process in
// that window and reconcile inherits the landing — from EITHER surviving signal
// (docker still reports 122, or the event landed before the write did). It has to
// reach the same verification_environment_unavailable with the same git-specific
// diagnosis; the generic orphan landings send the operator hunting for agent work
// that was never done, since the probe exits before the agent command execs.

const GONE = () => false;
const NO_REAP = () => "not_found" as const;

/** A `running` row whose container has started — past reconcile's pre-container
 *  and provisioning gates, at the container-gone sweep. */
function strandRunning(runId: string, taskId: string): void {
  insertTask({
    id: taskId,
    runId,
    phase: "first",
    agentRole: "engineer",
    status: "running",
    taskPackage: { taskId, runId, phase: "first", role: "engineer", dispatchSource: "workflow", inputs: {}, composedSystemPrompt: "" },
    createdAt: "2026-07-25T00:00:00Z",
    startedAt: "2026-07-25T00:00:01Z",
  });
  logEvent("container.started", { runId, taskId, payload: { containerName: `forge-${taskId}` } });
}

function strandedRun(title: string): string {
  const { runId } = startRun({ workflow: LINEAR_WORKFLOW, title, inputs: { brief: "x" }, projectDir: "/tmp/test-project" });
  return runId;
}

test("fg559: reconcile — a container gone at exit 122 lands verification_environment_unavailable with the git diagnosis, not a generic orphan", () => {
  const runId = strandedRun("fg559 reconcile exit-122");
  strandRunning(runId, "task-fg559-exit");

  const r = reconcileRun(runId, GONE, NO_REAP, () => ({ exitCode: GIT_UNAVAILABLE_EXIT_CODE }));

  const t = getTask("task-fg559-exit")!;
  assert.equal(t.status, "failed");
  assert.equal(failureKindForTask(t.id), "verification_environment_unavailable");
  assert.match(t.error ?? "", /git is unusable in the project mount/);
  assert.match(t.error ?? "", /parent repo/, "the landing must carry the git-specific operator fix, not just the kind");
  assert.doesNotMatch(t.error ?? "", /^orphaned/);
  assert.ok(
    r.taskChanges.some((c) => c.taskId === t.id && c.to === "failed" && c.reason === "container_git_unavailable"),
    `got: ${JSON.stringify(r.taskChanges)}`,
  );
});

test("fg559: reconcile — the event alone is enough: the watcher logged container.git_unavailable and died before failTask", () => {
  const runId = strandedRun("fg559 reconcile event-only");
  strandRunning(runId, "task-fg559-event");
  logEvent("container.git_unavailable", {
    runId,
    taskId: "task-fg559-event",
    payload: { containerName: "forge-task-fg559-event", exitCode: GIT_UNAVAILABLE_EXIT_CODE },
  });

  // Docker knows nothing by then — the container is long reaped.
  reconcileRun(runId, GONE, NO_REAP, () => ({}));

  const t = getTask("task-fg559-event")!;
  assert.equal(t.status, "failed");
  assert.equal(failureKindForTask(t.id), "verification_environment_unavailable");
  assert.match(t.error ?? "", /git is unusable in the project mount/);

  // FG-492's distinction: forge DID witness this container's terminal event
  // before it died, so the recorded evidence must not read as "the container
  // disappeared with no terminal evidence".
  const evidence = getContainerCausalEvidenceFromEvents(eventsForTask(t.id));
  assert.equal(evidence?.containerExitedEventObserved, true, "container.git_unavailable is a terminal exit event forge observed");
});
