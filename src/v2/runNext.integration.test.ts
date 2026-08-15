// runNext integration test — stubs the docker exec so we can drive the runner
// end-to-end without real containers. Validates:
//   - Ready-queue → dispatch → result → status transitions
//   - Parallel-within-wave: multiple ready steps spawn concurrently
//   - Gate handling: gate: auto → complete, gate: human → awaiting_gate
//   - Run completes when all steps done
//   - manual: true creates a pending task without spawn

import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, existsSync, readFileSync, rmSync, mkdtempSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { runNext, resolveChildAgent, type DockerExecFn } from "./runNext.js";
import { publishFlatAsGeneration } from "./seed-generation.testkit.js";
import { retry } from "./retry.js";
import { loadModelPolicyWithSource } from "./loader.js";
import { startRun } from "./startRun.js";
import { tasksForRun, getTask, markTaskComplete } from "../store/tasks.js";
import { getRun, updateRunStatus } from "../store/runs.js";
import { eventsForTask, eventsForRun } from "../store/events.js";
import { verdictsForTask } from "../store/verdicts.js";
import { failureKindForTask, getOrphanEvidenceFromEvents, getContainerCausalEvidenceFromEvents } from "./failure-kind.js";
import { runOpsCheck } from "../ops/detect.js";
import { IDLE_TIMEOUT_EXIT_CODE } from "./idle-watchdog.js";
import { DEPENDENCY_PROVISIONING_FAILED_EXIT_CODE } from "./dependency-provisioning.js";
import { taskDir } from "../util/paths.js";
import type { Workflow, Step, FanoutDef } from "./schema.js";
import type { TaskManifest } from "./task-manifest.js";

// Stub docker exec that writes a fixed result.json and returns 0. The runner's
// container.stdout/stderr.log paths must be writable from this exec, so create
// the parent dir as a side effect.
function makeStubExec(resultJson: unknown, exitCode = 0): DockerExecFn {
  return async ({ stdoutPath, stderrPath }) => {
    // result.json lives in the task dir; we don't know it here directly, but
    // the runner has already created it (empty) and writes status based on
    // what's in result.json at read time. The stub writes result.json next
    // to the stdout/stderr logs (same dir).
    const dir = dirname(stdoutPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "result.json"), JSON.stringify(resultJson));
    writeFileSync(stdoutPath, "stub stdout");
    writeFileSync(stderrPath, "");
    return exitCode;
  };
}

// Synthesize a minimal claude runtime YAML so loadRuntime() succeeds in tests.
function ensureRuntime(): void {
  const fhome = process.env.FORGE_HOME!;
  const runtimePath = join(fhome, "runtimes", "claude.yml");
  if (!existsSync(runtimePath)) {
    mkdirSync(dirname(runtimePath), { recursive: true });
    writeFileSync(runtimePath, `name: claude
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
`);
  }
  // FG-583: publish the flat runtime as a complete generation so dispatch resolves it.
  publishFlatAsGeneration(fhome);
}

const LINEAR_WORKFLOW: Workflow = {
  name: "test-linear",
  description: "two-step linear test",
  review_mode: "legacy_verdict",
  inputs: [{ name: "brief", required: true, type: "text" }],
  steps: [
    { id: "first", agent: "test-agent", gate: "auto", manual: false, depends_on: [], runtime: "claude", reds: [] },
    { id: "second", agent: "test-agent", gate: "auto", manual: false, depends_on: ["first"], runtime: "claude", reds: [] },
  ],
};

const PARALLEL_WORKFLOW: Workflow = {
  name: "test-parallel",
  description: "diamond fanout test",
  review_mode: "legacy_verdict",
  inputs: [{ name: "brief", required: true, type: "text" }],
  steps: [
    { id: "root", agent: "test-agent", gate: "auto", manual: false, depends_on: [], runtime: "claude", reds: [] },
    { id: "left", agent: "test-agent", gate: "auto", manual: false, depends_on: ["root"], runtime: "claude", reds: [] },
    { id: "right", agent: "test-agent", gate: "auto", manual: false, depends_on: ["root"], runtime: "claude", reds: [] },
    { id: "merge", agent: "test-agent", gate: "auto", manual: false, depends_on: ["left", "right"], runtime: "claude", reds: [] },
  ],
};

const HUMAN_GATE_WORKFLOW: Workflow = {
  name: "test-human-gate",
  description: "step with gate: human pauses",
  review_mode: "legacy_verdict",
  inputs: [{ name: "brief", required: true, type: "text" }],
  steps: [
    { id: "needs-review", agent: "test-agent", gate: "human", manual: false, depends_on: [], runtime: "claude", reds: [] },
  ],
};

const MANUAL_WORKFLOW: Workflow = {
  name: "test-manual",
  description: "manual step doesn't dispatch a container",
  review_mode: "legacy_verdict",
  inputs: [{ name: "brief", required: true, type: "text" }],
  steps: [
    { id: "human-work", manual: true, gate: "human", depends_on: [], runtime: "claude", reds: [] },
  ],
};

test("runNext: linear workflow dispatches first step → completes → next wave dispatches second", async () => {
  const { runId } = startRun({
    workflow: LINEAR_WORKFLOW,
    title: "linear test",
    inputs: { brief: "x" },
    projectDir: "/tmp/test-project",
  });

  // Need a runtime YAML accessible. We don't actually spawn containers (stub),
  // but the runner does call loadRuntime() before invoking the exec stub, which
  // (FG-583) resolves ONLY from a published seed generation — so publish one.
  ensureRuntime();
  // apikey auth needs ANTHROPIC_API_KEY; set a fake one for the stub.
  const prevKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "sk-stub";

  try {
    const stub = makeStubExec({ status: "complete", output: "first-result" });

    // Wave 1: dispatch 'first'
    const wave1 = await runNext({ runId, workflow: LINEAR_WORKFLOW, dockerExec: stub });
    assert.deepEqual(wave1.dispatchedSteps, ["first"]);
    assert.deepEqual(wave1.completedSteps, ["first"]);
    assert.deepEqual(wave1.failedSteps, []);
    assert.equal(wave1.runStatus, "active");

    // Wave 2: dispatch 'second'
    const wave2 = await runNext({ runId, workflow: LINEAR_WORKFLOW, dockerExec: stub });
    assert.deepEqual(wave2.dispatchedSteps, ["second"]);
    assert.deepEqual(wave2.completedSteps, ["second"]);
    assert.equal(wave2.runStatus, "complete");

    // Run should be complete
    const run = getRun(runId);
    assert.equal(run!.status, "complete");

    // Two tasks total, both complete
    const tasks = tasksForRun(runId);
    assert.equal(tasks.length, 2);
    assert.ok(tasks.every((t) => t.status === "complete"));
  } finally {
    if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prevKey;
  }
});

test("runNext: gate: human transitions to awaiting_gate, doesn't auto-complete run", async () => {
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  const { runId } = startRun({
    workflow: HUMAN_GATE_WORKFLOW,
    title: "human gate test",
    inputs: { brief: "x" },
    projectDir: "/tmp/test-project",
  });

  const stub = makeStubExec({ status: "complete" });
  const wave = await runNext({ runId, workflow: HUMAN_GATE_WORKFLOW, dockerExec: stub });

  assert.deepEqual(wave.dispatchedSteps, ["needs-review"]);
  assert.deepEqual(wave.awaitingGate, ["needs-review"]);
  assert.deepEqual(wave.completedSteps, []);
  assert.equal(wave.runStatus, "active");

  const tasks = tasksForRun(runId);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0]!.status, "awaiting_gate");

  // Run is still active — human needs to gate-advance
  const run = getRun(runId);
  assert.equal(run!.status, "active");
});

test("runNext: manual step creates a pending task without invoking dockerExec", async () => {
  const { runId } = startRun({
    workflow: MANUAL_WORKFLOW,
    title: "manual test",
    inputs: { brief: "x" },
    projectDir: "/tmp/test-project",
  });

  // Stub that throws if called — manual steps shouldn't invoke it.
  const failingExec: DockerExecFn = async () => {
    throw new Error("manual step should not invoke docker exec");
  };

  const wave = await runNext({ runId, workflow: MANUAL_WORKFLOW, dockerExec: failingExec });
  assert.deepEqual(wave.dispatchedSteps, ["human-work"]);

  const tasks = tasksForRun(runId);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0]!.status, "pending");
  assert.equal(tasks[0]!.agentRole, "manual");
});

test("runNext: parallel-within-wave — diamond fanout dispatches left+right together", async () => {
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  const { runId } = startRun({
    workflow: PARALLEL_WORKFLOW,
    title: "diamond test",
    inputs: { brief: "x" },
    projectDir: "/tmp/test-project",
  });

  const stub = makeStubExec({ status: "complete" });

  // Wave 1: root only
  const wave1 = await runNext({ runId, workflow: PARALLEL_WORKFLOW, dockerExec: stub });
  assert.deepEqual(wave1.dispatchedSteps, ["root"]);

  // Wave 2: left + right in parallel
  const wave2 = await runNext({ runId, workflow: PARALLEL_WORKFLOW, dockerExec: stub });
  assert.deepEqual(wave2.dispatchedSteps.sort(), ["left", "right"]);
  assert.deepEqual(wave2.completedSteps.sort(), ["left", "right"]);

  // Wave 3: merge
  const wave3 = await runNext({ runId, workflow: PARALLEL_WORKFLOW, dockerExec: stub });
  assert.deepEqual(wave3.dispatchedSteps, ["merge"]);
  assert.equal(wave3.runStatus, "complete");

  const tasks = tasksForRun(runId);
  assert.equal(tasks.length, 4);
  assert.ok(tasks.every((t) => t.status === "complete"));
});

test("runNext: empty ready queue returns no dispatched steps (run still active)", async () => {
  // Run with a human-gated first step that already hit awaiting_gate; next
  // runNext call should be a no-op (nothing ready until human advances).
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  const { runId } = startRun({
    workflow: HUMAN_GATE_WORKFLOW,
    title: "noop test",
    inputs: { brief: "x" },
    projectDir: "/tmp/test-project",
  });
  const stub = makeStubExec({ status: "complete" });
  await runNext({ runId, workflow: HUMAN_GATE_WORKFLOW, dockerExec: stub });
  // Second call — first step is awaiting_gate; no ready work.
  const wave = await runNext({ runId, workflow: HUMAN_GATE_WORKFLOW, dockerExec: stub });
  assert.deepEqual(wave.dispatchedSteps, []);
  assert.equal(wave.runStatus, "active");
});

test("runNext: failed step (container exit nonzero + empty result.json) marks task failed", async () => {
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  const { runId } = startRun({
    workflow: LINEAR_WORKFLOW,
    title: "fail test",
    inputs: { brief: "x" },
    projectDir: "/tmp/test-project",
  });

  // Stub that returns 1 and writes empty result.json (simulating a crash).
  const crashingExec: DockerExecFn = async ({ stdoutPath, stderrPath }) => {
    const dir = dirname(stdoutPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "result.json"), ""); // empty
    writeFileSync(stdoutPath, "");
    writeFileSync(stderrPath, "container crashed");
    return 1;
  };

  const wave = await runNext({ runId, workflow: LINEAR_WORKFLOW, dockerExec: crashingExec });
  assert.deepEqual(wave.failedSteps, ["first"]);
  assert.deepEqual(wave.completedSteps, []);

  const tasks = tasksForRun(runId);
  const first = tasks.find((t) => t.phase === "first");
  assert.ok(first);
  assert.equal(first!.status, "failed");
});

// ── FG-492 review: reap/retain now decided in runNext.ts (task outcome), not
// docker-exec.ts (raw exit code) ─────────────────────────────────────────────
//
// The fake dockerExec above never calls docker itself, so `finalizeContainerRetention`'s
// real `docker rm -f` would hit whatever `docker` is on PATH. These tests shadow
// PATH with a no-op stub (same technique docker-exec.test.ts uses) and assert on
// whether `rm -f -v forge-<taskId>` was actually invoked.
function makeDockerRmStub(exitCode = 0): { binDir: string; logPath: string } {
  const binDir = mkdtempSync(join(tmpdir(), "forge-runnext-docker-stub-"));
  const logPath = join(binDir, "docker-calls.log");
  writeFileSync(join(binDir, "docker"), `#!/bin/sh\necho "$@" >> "${logPath}"\nexit ${exitCode}\n`);
  chmodSync(join(binDir, "docker"), 0o755);
  writeFileSync(logPath, "");
  return { binDir, logPath };
}

async function withDockerRmStub<T>(fn: (logPath: string) => Promise<T>): Promise<T> {
  const { binDir, logPath } = makeDockerRmStub();
  const origPath = process.env.PATH;
  process.env.PATH = `${binDir}:${origPath ?? ""}`;
  try {
    return await fn(logPath);
  } finally {
    process.env.PATH = origPath;
    rmSync(binDir, { recursive: true, force: true });
  }
}

// FG-503: `docker rm -f -v` itself failing (daemon hiccup) — same stub
// technique, non-zero exit so finalizeContainerRetention returns "reap_failed".
async function withFailingDockerRmStub<T>(fn: (logPath: string) => Promise<T>): Promise<T> {
  const { binDir, logPath } = makeDockerRmStub(1);
  const origPath = process.env.PATH;
  process.env.PATH = `${binDir}:${origPath ?? ""}`;
  try {
    return await fn(logPath);
  } finally {
    process.env.PATH = origPath;
    rmSync(binDir, { recursive: true, force: true });
  }
}

test("runNext: FG-492 review — exit 0 + valid result.json → primary completes AND the container is reaped", async () => {
  await withDockerRmStub(async (logPath) => {
    process.env.ANTHROPIC_API_KEY = "sk-stub";
    const { runId } = startRun({
      workflow: LINEAR_WORKFLOW,
      title: "reap-on-complete test",
      inputs: { brief: "x" },
      projectDir: "/tmp/test-project",
    });

    const wave = await runNext({ runId, workflow: LINEAR_WORKFLOW, dockerExec: makeStubExec({ status: "complete" }) });
    assert.deepEqual(wave.completedSteps, ["first"]);

    const first = tasksForRun(runId).find((t) => t.phase === "first")!;
    const calls = readFileSync(logPath, "utf8");
    assert.match(calls, new RegExp(`rm -f -v forge-${first.id}`), "a completed primary's container is reaped");
  });
});

test("runNext: FG-492 review — exit 0 + NO result.json (state 4) → primary fails result_missing AND the container is RETAINED, not reaped", async () => {
  await withDockerRmStub(async (logPath) => {
    process.env.ANTHROPIC_API_KEY = "sk-stub";
    const { runId } = startRun({
      workflow: LINEAR_WORKFLOW,
      title: "retain-on-result-missing test",
      inputs: { brief: "x" },
      projectDir: "/tmp/test-project",
    });

    // Confirmed clean exit, but no result.json at all — exactly the state-4
    // case a raw-exit-code-based reap policy would have destroyed.
    const cleanExitNoResult: DockerExecFn = async ({ stdoutPath, stderrPath }) => {
      const dir = dirname(stdoutPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(stdoutPath, "");
      writeFileSync(stderrPath, "");
      return 0;
    };

    const wave = await runNext({ runId, workflow: LINEAR_WORKFLOW, dockerExec: cleanExitNoResult });
    assert.deepEqual(wave.failedSteps, ["first"]);

    const first = tasksForRun(runId).find((t) => t.phase === "first")!;
    assert.match(first.error ?? "", /no_result_json/);
    const calls = readFileSync(logPath, "utf8");
    assert.doesNotMatch(calls, / rm /, "a clean exit with no result.json must be retained, never reaped just because the exit code was 0");
  });
});

test("runNext: FG-492 review — non-zero exit (container_crash) → the container is RETAINED, not reaped", async () => {
  await withDockerRmStub(async (logPath) => {
    process.env.ANTHROPIC_API_KEY = "sk-stub";
    const { runId } = startRun({
      workflow: LINEAR_WORKFLOW,
      title: "retain-on-crash test",
      inputs: { brief: "x" },
      projectDir: "/tmp/test-project",
    });

    const crashingExec: DockerExecFn = async ({ stdoutPath, stderrPath }) => {
      const dir = dirname(stdoutPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "result.json"), "");
      writeFileSync(stdoutPath, "");
      writeFileSync(stderrPath, "container crashed");
      return 1;
    };

    const wave = await runNext({ runId, workflow: LINEAR_WORKFLOW, dockerExec: crashingExec });
    assert.deepEqual(wave.failedSteps, ["first"]);

    const calls = readFileSync(logPath, "utf8");
    assert.doesNotMatch(calls, / rm /, "a genuine container_crash must stay retained for diagnosis");
  });
});

test("runNext: FG-492 review — FORGE_CONTAINER_RETENTION=off reaps even a failed primary", async () => {
  await withDockerRmStub(async (logPath) => {
    process.env.ANTHROPIC_API_KEY = "sk-stub";
    process.env.FORGE_CONTAINER_RETENTION = "off";
    try {
      const { runId } = startRun({
        workflow: LINEAR_WORKFLOW,
        title: "retention-off test",
        inputs: { brief: "x" },
        projectDir: "/tmp/test-project",
      });

      const crashingExec: DockerExecFn = async ({ stdoutPath, stderrPath }) => {
        const dir = dirname(stdoutPath);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "result.json"), "");
        writeFileSync(stdoutPath, "");
        writeFileSync(stderrPath, "container crashed");
        return 1;
      };

      const wave = await runNext({ runId, workflow: LINEAR_WORKFLOW, dockerExec: crashingExec });
      assert.deepEqual(wave.failedSteps, ["first"]);

      const first = tasksForRun(runId).find((t) => t.phase === "first")!;
      const calls = readFileSync(logPath, "utf8");
      assert.match(calls, new RegExp(`rm -f -v forge-${first.id}`), "FORGE_CONTAINER_RETENTION=off forces a reap even on failure");
    } finally {
      delete process.env.FORGE_CONTAINER_RETENTION;
    }
  });
});

// ── FG-503: reap_failed on a SUCCESSFUL task is durably recorded ────────────

test("runNext: FG-503 — no-reds completion, `docker rm` errors → primary still completes AND a container.reap_failed event is recorded", async () => {
  await withFailingDockerRmStub(async (logPath) => {
    process.env.ANTHROPIC_API_KEY = "sk-stub";
    const { runId } = startRun({
      workflow: LINEAR_WORKFLOW,
      title: "reap-failed-on-complete test",
      inputs: { brief: "x" },
      projectDir: "/tmp/test-project",
    });

    const wave = await runNext({ runId, workflow: LINEAR_WORKFLOW, dockerExec: makeStubExec({ status: "complete" }) });
    assert.deepEqual(wave.completedSteps, ["first"], "a reap failure must never turn a successful task into a failed one");

    const first = tasksForRun(runId).find((t) => t.phase === "first")!;
    const calls = readFileSync(logPath, "utf8");
    assert.match(calls, new RegExp(`rm -f -v forge-${first.id}`), "the reap was attempted");

    const types = eventsForTask(first.id).map((e) => e.eventType);
    assert.equal(types.filter((t) => t === "container.reap_failed").length, 1, "the failed reap must be durably recorded exactly once");
    const reapFailedEvent = eventsForTask(first.id).find((e) => e.eventType === "container.reap_failed")!;
    const payload = reapFailedEvent.payload as { containerName: string; why: string };
    assert.equal(payload.containerName, `forge-${first.id}`);
    // FG-503 cross-path consistency: same {containerName, why} payload shape
    // as invoke.ts and gate.ts's own reap-failure logging — see the matching
    // assertion in invoke.integration.test.ts and fg492-gate-container-reap.test.ts.
    assert.deepEqual(Object.keys(payload).sort(), ["containerName", "why"], "payload shape must match the other two reap paths (invoke.ts, gate.ts)");
    assert.match(payload.why, /^docker rm -f -v failed/, "why must follow the shared wording convention across all three reap paths");
  });
});

test("runNext: FG-503 — post-reds completion (gate: auto, advisory red), `docker rm` errors → a container.reap_failed event is recorded", async () => {
  await withFailingDockerRmStub(async (logPath) => {
    process.env.ANTHROPIC_API_KEY = "sk-stub";
    const { runId } = startRun({
      workflow: REDS_SPECIALIST_FAIL_WORKFLOW,
      title: "post-reds reap-failed test",
      inputs: {},
      projectDir: "/tmp/test-project",
    });

    const exec = makeRoutingExec([
      { matches: (id) => id.startsWith("task-review-"), result: { status: "complete", artifact: "x" } },
      {
        matches: (id) => id.startsWith("task-red-review-"),
        result: { status: "complete", verdict: "fail", confidence: 0.8, findings: [{ severity: "high", summary: "real issue", evidence: "observed in logs", hypothesis: "bug" }] },
      },
    ]);

    const wave = await runNext({ runId, workflow: REDS_SPECIALIST_FAIL_WORKFLOW, dockerExec: exec });
    assert.deepEqual(wave.completedSteps, ["review"], "gate: auto + only a specialist verdict-fail still completes (advisory only)");

    const primary = tasksForRun(runId).find((t) => t.parentId === undefined)!;
    assert.equal(primary.status, "complete");
    const calls = readFileSync(logPath, "utf8");
    assert.match(calls, new RegExp(`rm -f -v forge-${primary.id}`), "the post-reds reap was attempted");

    const types = eventsForTask(primary.id).map((e) => e.eventType);
    assert.equal(types.filter((t) => t === "container.reap_failed").length, 1, "the post-reds reap failure must be durably recorded");
  });
});

test("runNext: FG-503 — happy-path completion (reap succeeds) emits no container.reap_failed event", async () => {
  await withDockerRmStub(async (logPath) => {
    process.env.ANTHROPIC_API_KEY = "sk-stub";
    const { runId } = startRun({
      workflow: LINEAR_WORKFLOW,
      title: "reap-happy-path test",
      inputs: { brief: "x" },
      projectDir: "/tmp/test-project",
    });

    const wave = await runNext({ runId, workflow: LINEAR_WORKFLOW, dockerExec: makeStubExec({ status: "complete" }) });
    assert.deepEqual(wave.completedSteps, ["first"]);

    const first = tasksForRun(runId).find((t) => t.phase === "first")!;
    const calls = readFileSync(logPath, "utf8");
    assert.match(calls, new RegExp(`rm -f -v forge-${first.id}`));

    const types = eventsForTask(first.id).map((e) => e.eventType);
    assert.equal(types.filter((t) => t === "container.reap_failed").length, 0, "the happy path must stay silent — no new event on a successful reap");
  });
});

test("runNext: idle-timeout exit code marks the pipeline task failed with idle_timeout", async () => {
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  const { runId } = startRun({
    workflow: LINEAR_WORKFLOW,
    title: "idle test",
    inputs: { brief: "x" },
    projectDir: "/tmp/test-project",
  });

  // Mimic the watchdog SIGKILLing a hung agent: empty result.json, exit 124.
  const idleKilled: DockerExecFn = async ({ stdoutPath, stderrPath }) => {
    const dir = dirname(stdoutPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "result.json"), "");
    writeFileSync(stdoutPath, "");
    writeFileSync(stderrPath, "");
    return IDLE_TIMEOUT_EXIT_CODE;
  };

  const wave = await runNext({ runId, workflow: LINEAR_WORKFLOW, dockerExec: idleKilled });
  assert.deepEqual(wave.failedSteps, ["first"]);

  const first = tasksForRun(runId).find((t) => t.phase === "first");
  assert.ok(first);
  assert.equal(first!.status, "failed");
  assert.match(first!.error ?? "", /idle_timeout/);
});

test("runNext: FG-376 dependency-provisioning exit code marks the pipeline task failed with verification_environment_unavailable, not container_crash", async () => {
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  const { runId } = startRun({
    workflow: LINEAR_WORKFLOW,
    title: "provisioning-failure test",
    inputs: { brief: "x" },
    projectDir: "/tmp/test-project",
  });

  // Mimic the entrypoint's `npm ci` failing before it could exec the agent:
  // no result.json, exit DEPENDENCY_PROVISIONING_FAILED_EXIT_CODE.
  const provisioningFailed: DockerExecFn = async ({ stdoutPath, stderrPath }) => {
    const dir = dirname(stdoutPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(stdoutPath, "");
    writeFileSync(stderrPath, "npm ci failed: EACCES");
    return DEPENDENCY_PROVISIONING_FAILED_EXIT_CODE;
  };

  const wave = await runNext({ runId, workflow: LINEAR_WORKFLOW, dockerExec: provisioningFailed });
  assert.deepEqual(wave.failedSteps, ["first"]);

  const first = tasksForRun(runId).find((t) => t.phase === "first");
  assert.ok(first);
  assert.equal(first!.status, "failed");
  assert.match(first!.error ?? "", /verification_environment_unavailable/);
  assert.match(first!.error ?? "", /npm ci failed: EACCES/);
  assert.doesNotMatch(first!.error ?? "", /container_crash/);
  assert.equal(failureKindForTask(first!.id), "verification_environment_unavailable");
});

test("runNext: FG-455 attached exit 137 marks the pipeline task failed with oom_killed, not container_crash", async () => {
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  const { runId } = startRun({
    workflow: LINEAR_WORKFLOW,
    title: "oom test",
    inputs: { brief: "x" },
    projectDir: "/tmp/test-project",
  });

  // Mimic a Docker OOM-kill / external SIGKILL at attached-exit: empty
  // result.json, exit 137, no provider/model error in stdout.
  const oomKilled: DockerExecFn = async ({ stdoutPath, stderrPath }) => {
    const dir = dirname(stdoutPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "result.json"), "");
    writeFileSync(stdoutPath, "");
    writeFileSync(stderrPath, "");
    return 137;
  };

  const wave = await runNext({ runId, workflow: LINEAR_WORKFLOW, dockerExec: oomKilled });
  assert.deepEqual(wave.failedSteps, ["first"]);

  const first = tasksForRun(runId).find((t) => t.phase === "first");
  assert.ok(first);
  assert.equal(first!.status, "failed");
  assert.match(first!.error ?? "", /killed|exit 137|OOM/);
  assert.doesNotMatch(first!.error ?? "", /container_crash/);
  assert.equal(failureKindForTask(first!.id), "oom_killed");
});

// ── FG-461: runNext attached-exit recovery evidence ─────────────────────────
// runNext.ts wires the same recoveryEvidenceFor/attachedExitEvidence call as
// invoke.ts (see invoke.integration.test.ts's FG-461 block); cover it independently since
// runNext dispatches via the real docker-args/task-manifest path, not invoke's.

// A dirty git project dir so changedWorktreeFiles returns a non-empty diff.
function makeDirtyGitProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "forge-fg461-runnext-proj-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  writeFileSync(join(dir, "agent-work.txt"), "partial edits before the kill\n");
  return dir;
}

test("runNext: FG-461 container_crash records OrphanEvidence with exitCode and changed files", async () => {
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  const projectDir = makeDirtyGitProject();
  const { runId } = startRun({
    workflow: LINEAR_WORKFLOW,
    title: "container_crash evidence test",
    inputs: { brief: "x" },
    projectDir,
  });

  const crashingExec: DockerExecFn = async ({ stdoutPath, stderrPath }) => {
    const dir = dirname(stdoutPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "result.json"), "");
    writeFileSync(stdoutPath, "");
    writeFileSync(stderrPath, "container crashed");
    return 1;
  };

  await runNext({ runId, workflow: LINEAR_WORKFLOW, dockerExec: crashingExec });

  const first = tasksForRun(runId).find((t) => t.phase === "first");
  assert.ok(first);
  assert.equal(failureKindForTask(first!.id), "container_crash");

  const evidence = getOrphanEvidenceFromEvents(eventsForTask(first!.id));
  assert.ok(evidence, "container_crash attached-exit must record recovery evidence");
  assert.equal(evidence!.exitCode, 1);
  assert.equal(evidence!.oomKilled, undefined, "attached path never inspects OOM — left unset");
  assert.equal(evidence!.source, "project_dir_shared");
  assert.ok(evidence!.changedFiles.some((f) => f.includes("agent-work.txt")));
});

test("runNext: FG-461 idle_timeout records OrphanEvidence with changed files", async () => {
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  const projectDir = makeDirtyGitProject();
  const { runId } = startRun({
    workflow: LINEAR_WORKFLOW,
    title: "idle_timeout evidence test",
    inputs: { brief: "x" },
    projectDir,
  });

  const idleKilled: DockerExecFn = async ({ stdoutPath, stderrPath }) => {
    const dir = dirname(stdoutPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "result.json"), "");
    writeFileSync(stdoutPath, "");
    writeFileSync(stderrPath, "");
    return IDLE_TIMEOUT_EXIT_CODE;
  };

  await runNext({ runId, workflow: LINEAR_WORKFLOW, dockerExec: idleKilled });

  const first = tasksForRun(runId).find((t) => t.phase === "first");
  assert.ok(first);
  assert.equal(failureKindForTask(first!.id), "idle_timeout");

  const evidence = getOrphanEvidenceFromEvents(eventsForTask(first!.id));
  assert.ok(evidence, "idle_timeout attached-exit must record recovery evidence");
  assert.equal(evidence!.oomKilled, undefined, "attached path never inspects OOM — left unset");
  assert.ok(evidence!.changedFiles.some((f) => f.includes("agent-work.txt")));
});

test("runNext: FG-461 a red task crash (projectMode ro) records NO evidence", async () => {
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  const projectDir = makeDirtyGitProject();
  const { runId } = startRun({
    workflow: REDS_SPECIALIST_FAIL_WORKFLOW,
    title: "red crash evidence test",
    inputs: {},
    projectDir,
  });

  // Primary completes normally; the red container crashes (exit 137, empty result).
  const primaryOkRedCrash: DockerExecFn = async ({ args, stdoutPath, stderrPath }) => {
    const nameIdx = args.indexOf("--name");
    const fullName = nameIdx >= 0 ? args[nameIdx + 1] ?? "" : "";
    const taskId = fullName.replace(/^forge-/, "");
    const dir = dirname(stdoutPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    if (taskId.startsWith("task-review-")) {
      writeFileSync(join(dir, "result.json"), JSON.stringify({ status: "complete", artifact: "ok" }));
      writeFileSync(stdoutPath, "stub stdout");
      writeFileSync(stderrPath, "");
      return 0;
    }
    writeFileSync(join(dir, "result.json"), "");
    writeFileSync(stdoutPath, "");
    writeFileSync(stderrPath, "");
    return 137;
  };

  await runNext({ runId, workflow: REDS_SPECIALIST_FAIL_WORKFLOW, dockerExec: primaryOkRedCrash });

  const tasks = tasksForRun(runId);
  const primary = tasks.find((t) => t.parentId === undefined)!;
  const red = tasks.find((t) => t.parentId === primary.id)!;
  assert.ok(red);
  assert.equal(failureKindForTask(red.id), "oom_killed");
  // Reds run projectMode "ro" — they can't persist work, so recoveryEvidenceFor
  // must not gather evidence even though the (shared) project dir is dirty.
  assert.equal(getOrphanEvidenceFromEvents(eventsForTask(red.id)), undefined);
});

// Finding 1: runNext guard — non-active run returns empty dispatch
test("runNext: abandoned run returns empty dispatch without starting any work", async () => {
  const { runId } = startRun({
    workflow: LINEAR_WORKFLOW,
    title: "abandoned guard test",
    inputs: { brief: "x" },
    projectDir: "/tmp/test-project",
  });

  // Manually mark the run abandoned (as forge cancel would do).
  updateRunStatus(runId, "abandoned");

  const throwingExec: DockerExecFn = async () => {
    throw new Error("runNext dispatched a step on a non-active run");
  };

  const result = await runNext({ runId, workflow: LINEAR_WORKFLOW, dockerExec: throwingExec });
  assert.deepEqual(result.dispatchedSteps, []);
  assert.deepEqual(result.completedSteps, []);
  assert.deepEqual(result.awaitingGate, []);
  assert.deepEqual(result.failedSteps, []);
  assert.equal(result.runStatus, "abandoned");
});

test("runNext: complete run returns empty dispatch without starting any work", async () => {
  const { runId } = startRun({
    workflow: LINEAR_WORKFLOW,
    title: "complete guard test",
    inputs: { brief: "x" },
    projectDir: "/tmp/test-project",
  });

  updateRunStatus(runId, "complete");

  const throwingExec: DockerExecFn = async () => {
    throw new Error("runNext dispatched a step on a non-active run");
  };

  const result = await runNext({ runId, workflow: LINEAR_WORKFLOW, dockerExec: throwingExec });
  assert.deepEqual(result.dispatchedSteps, []);
  assert.equal(result.runStatus, "complete");
});

// ---------------------------------------------------------------------------
// Reds + fanout
// ---------------------------------------------------------------------------

// Route docker exec by the agent role embedded in the runtime's --name arg.
// The runtime stub uses container.name = "forge-${TASK_ID}" and TASK_ID
// starts with phase or `red-<phase>` (see newTaskId). We sniff the args
// for the container name and route to the right canned result.
function makeRoutingExec(rules: Array<{ matches: (taskId: string) => boolean; result: unknown; exitCode?: number }>): DockerExecFn {
  return async ({ args, stdoutPath, stderrPath }) => {
    const nameIdx = args.indexOf("--name");
    const fullName = nameIdx >= 0 ? args[nameIdx + 1] ?? "" : "";
    // strip "forge-" prefix to get the task id
    const taskId = fullName.replace(/^forge-/, "");
    const rule = rules.find((r) => r.matches(taskId));
    const dir = dirname(stdoutPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    if (rule) {
      writeFileSync(join(dir, "result.json"), JSON.stringify(rule.result));
      writeFileSync(stdoutPath, "stub stdout");
      writeFileSync(stderrPath, "");
      return rule.exitCode ?? 0;
    }
    // Default: complete with empty output. Surfaces test misconfiguration.
    writeFileSync(join(dir, "result.json"), JSON.stringify({ status: "complete" }));
    writeFileSync(stdoutPath, "stub stdout (default)");
    writeFileSync(stderrPath, "");
    return 0;
  };
}

const REDS_AUTH_ALL_PASS_WORKFLOW: Workflow = {
  name: "test-reds-pass",
  description: "primary + 2 authoritative reds, all pass → gate: verdict → awaiting_gate",
  review_mode: "legacy_verdict",
  inputs: [],
  steps: [
    {
      id: "review",
      agent: "primary-agent",
      gate: "verdict",
      manual: false,
      depends_on: [],
      runtime: "claude",
      reds: [
        { agent: "red-wide", authority: "authoritative", gate_on_verdict: true },
        { agent: "red-narrow", authority: "authoritative", gate_on_verdict: true },
      ],
    },
  ],
};

const REDS_AUTH_FAIL_WORKFLOW: Workflow = {
  name: "test-reds-fail",
  description: "primary + 2 authoritative reds, one fails → blocked_by_red",
  review_mode: "legacy_verdict",
  inputs: [],
  steps: [
    {
      id: "review",
      agent: "primary-agent",
      gate: "verdict",
      manual: false,
      depends_on: [],
      runtime: "claude",
      reds: [
        { agent: "red-wide", authority: "authoritative", gate_on_verdict: true },
        { agent: "red-narrow", authority: "authoritative", gate_on_verdict: true },
      ],
    },
  ],
};

const REDS_SPECIALIST_FAIL_WORKFLOW: Workflow = {
  name: "test-reds-spec-fail",
  description: "specialist red fails — should NOT block (advisory only)",
  review_mode: "legacy_verdict",
  inputs: [],
  steps: [
    {
      id: "review",
      agent: "primary-agent",
      gate: "auto",
      manual: false,
      depends_on: [],
      runtime: "claude",
      reds: [
        { agent: "red-frontend", authority: "specialist", gate_on_verdict: true },
      ],
    },
  ],
};

test("runNext: reds — all authoritative reds pass → primary moves to awaiting_gate (verdict), verdicts recorded", async () => {
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  const { runId } = startRun({
    workflow: REDS_AUTH_ALL_PASS_WORKFLOW,
    title: "reds pass",
    inputs: {},
    projectDir: "/tmp/test-project",
  });

  const exec = makeRoutingExec([
    {
      matches: (id) => id.startsWith("task-review-"),
      result: { status: "complete", artifact: "the thing" },
    },
    {
      matches: (id) => id.startsWith("task-red-review-"),
      result: { status: "complete", verdict: "pass", confidence: 0.9, findings: [] },
    },
  ]);

  const wave = await runNext({ runId, workflow: REDS_AUTH_ALL_PASS_WORKFLOW, dockerExec: exec });

  assert.deepEqual(wave.dispatchedSteps, ["review"]);
  assert.deepEqual(wave.awaitingGate, ["review"]);
  assert.deepEqual(wave.completedSteps, []);
  assert.deepEqual(wave.failedSteps, []);

  const tasks = tasksForRun(runId);
  // 1 primary + 2 reds
  assert.equal(tasks.length, 3);
  const primary = tasks.find((t) => t.parentId === undefined)!;
  assert.equal(primary.status, "awaiting_gate");
  const redTasks = tasks.filter((t) => t.parentId === primary.id);
  assert.equal(redTasks.length, 2);
  assert.ok(redTasks.every((t) => t.status === "complete"));

  // Verdicts persisted
  const verdicts = verdictsForTask(primary.id);
  assert.equal(verdicts.length, 2);
  assert.ok(verdicts.every((v) => v.verdict === "pass"));
});

// FG-503 (review): a red's own container reap — runOneRed's finalizeContainerRetention
// call — previously discarded its outcome, unlike the primary's. Same
// reapContainerAndReportFailure wrapper, same durability guarantee, keyed on
// the RED's own task id (not the primary's).
test("runNext: FG-503 — a completed red's own container reap failure is durably recorded", async () => {
  await withFailingDockerRmStub(async (logPath) => {
    process.env.ANTHROPIC_API_KEY = "sk-stub";
    const { runId } = startRun({
      workflow: REDS_AUTH_ALL_PASS_WORKFLOW,
      title: "red reap-failed test",
      inputs: {},
      projectDir: "/tmp/test-project",
    });

    const exec = makeRoutingExec([
      { matches: (id) => id.startsWith("task-review-"), result: { status: "complete", artifact: "the thing" } },
      { matches: (id) => id.startsWith("task-red-review-"), result: { status: "complete", verdict: "pass", confidence: 0.9, findings: [] } },
    ]);

    const wave = await runNext({ runId, workflow: REDS_AUTH_ALL_PASS_WORKFLOW, dockerExec: exec });
    assert.deepEqual(wave.awaitingGate, ["review"], "a red's reap failure must never block the primary reaching its gate");

    const tasks = tasksForRun(runId);
    const primary = tasks.find((t) => t.parentId === undefined)!;
    const redTasks = tasks.filter((t) => t.parentId === primary.id);
    assert.equal(redTasks.length, 2);
    assert.ok(redTasks.every((t) => t.status === "complete"));

    const calls = readFileSync(logPath, "utf8");
    for (const red of redTasks) {
      assert.match(calls, new RegExp(`rm -f -v forge-${red.id}`), "each completed red's own container reap was attempted");
      const types = eventsForTask(red.id).map((e) => e.eventType);
      assert.equal(types.filter((t) => t === "container.reap_failed").length, 1, "the red's own reap failure must be durably recorded on the red's own task");
      const payload = eventsForTask(red.id).find((e) => e.eventType === "container.reap_failed")!.payload as { containerName: string; why: string };
      assert.equal(payload.containerName, `forge-${red.id}`);
    }
  });
});

test("runNext: FG-503 — a completed red's own container reap succeeding emits no container.reap_failed event", async () => {
  await withDockerRmStub(async (logPath) => {
    process.env.ANTHROPIC_API_KEY = "sk-stub";
    const { runId } = startRun({
      workflow: REDS_AUTH_ALL_PASS_WORKFLOW,
      title: "red reap-happy-path test",
      inputs: {},
      projectDir: "/tmp/test-project",
    });

    const exec = makeRoutingExec([
      { matches: (id) => id.startsWith("task-review-"), result: { status: "complete", artifact: "the thing" } },
      { matches: (id) => id.startsWith("task-red-review-"), result: { status: "complete", verdict: "pass", confidence: 0.9, findings: [] } },
    ]);

    const wave = await runNext({ runId, workflow: REDS_AUTH_ALL_PASS_WORKFLOW, dockerExec: exec });
    assert.deepEqual(wave.awaitingGate, ["review"]);

    const tasks = tasksForRun(runId);
    const primary = tasks.find((t) => t.parentId === undefined)!;
    const redTasks = tasks.filter((t) => t.parentId === primary.id);
    assert.equal(redTasks.length, 2);

    const calls = readFileSync(logPath, "utf8");
    for (const red of redTasks) {
      assert.match(calls, new RegExp(`rm -f -v forge-${red.id}`));
      const types = eventsForTask(red.id).map((e) => e.eventType);
      assert.equal(types.filter((t) => t === "container.reap_failed").length, 0, "the happy path must stay silent for a red's own reap too");
    }
  });
});

// AWN-7: a run-level model profile (`forge new --profile`, stored as
// metadata.modelProfile) must pin EVERY task in the run — primary and red —
// at the highest profile-selection precedence, beating both agent overrides
// and activity defaults, and recording resolvedBy="run.profile". Writes a
// throwaway policy + claude-apikey runtime into FORGE_HOME and removes them in
// finally so the legacy-mode tests sharing this process aren't affected.
test("runNext: run-level --profile (metadata.modelProfile) pins primary AND red, beating agent overrides", async () => {
  const policyPath = join(process.env.FORGE_HOME!, "model-policy.yml");
  const apikeyRuntimePath = join(process.env.FORGE_HOME!, "runtimes", "claude-apikey.yml");
  process.env.ANTHROPIC_API_KEY = "sk-stub"; // makes auth:api available (probeAuth)

  // default-api is what defaults/overrides would select; pinned-api is the
  // run override. red-wide has an explicit agent override to default-api so the
  // assertion proves run.profile beats overrides.agents, not just the default.
  writeFileSync(policyPath, `
on_unavailable: fail
schema_version: 2
model_profiles:
  default-api:
    provider: anthropic
    auth: api
    map:
      review:  { model: model-default-review, cost_tier: standard }
      default: { model: model-default,        cost_tier: standard }
  pinned-api:
    provider: anthropic
    auth: api
    map:
      review:  { model: model-pinned-review, cost_tier: premium }
      default: { model: model-pinned,        cost_tier: premium }
defaults:
  profile: default-api
  activity:
    review: default-api
overrides:
  agents:
    red-wide: default-api
allowed_profiles: [default-api, pinned-api]
`);
  if (!existsSync(apikeyRuntimePath)) {
    mkdirSync(dirname(apikeyRuntimePath), { recursive: true });
    writeFileSync(apikeyRuntimePath, `name: claude-apikey
description: test stub apikey runtime
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
`);
  }
  // FG-583: publish the flat runtimes as a complete generation so dispatch resolves them.
  publishFlatAsGeneration(process.env.FORGE_HOME!);

  try {
    const { runId } = startRun({
      workflow: REDS_AUTH_ALL_PASS_WORKFLOW,
      title: "run profile pin",
      inputs: {},
      projectDir: "/tmp/test-project",
      modelProfile: "pinned-api",
    });

    const exec = makeRoutingExec([
      { matches: (id) => id.startsWith("task-review-"), result: { status: "complete", artifact: "x" } },
      { matches: (id) => id.startsWith("task-red-review-"), result: { status: "complete", verdict: "pass", confidence: 0.9, findings: [] } },
    ]);

    await runNext({ runId, workflow: REDS_AUTH_ALL_PASS_WORKFLOW, dockerExec: exec });

    const tasks = tasksForRun(runId);
    const primary = tasks.find((t) => t.parentId === undefined)!;
    const reds = tasks.filter((t) => t.parentId === primary.id);
    assert.equal(reds.length, 2);

    // Primary: capability "default" → pinned-api's default model, via run.profile.
    assert.equal(primary.resolvedProfile, "pinned-api");
    assert.equal(primary.resolvedBy, "run.profile");
    assert.equal(primary.agentModel, "model-pinned");

    // The pin is control-plane — it must NOT leak into the task inputs/prompt.
    assert.ok(!("modelProfile" in primary.taskPackage.inputs), "modelProfile must not ride into primary task inputs");

    // Both reds: capability "review" → pinned-api's review model, via run.profile —
    // overriding red-wide's explicit agent override (default-api) too.
    for (const red of reds) {
      assert.equal(red.resolvedProfile, "pinned-api");
      assert.equal(red.resolvedBy, "run.profile");
      assert.equal(red.agentModel, "model-pinned-review");
    }
  } finally {
    rmSync(policyPath, { force: true });
  }
});

// FG-560 step 4: a workflow STEP declaring an explicit activity that the selected
// profile does not map (and is not default-only) is refused BEFORE the container
// starts, with the activity_unmapped reason — and a role-derived / exact step is not.
test("runNext: a workflow step whose explicit activity is unmapped is blocked with activity_unmapped; an exact one proceeds", async () => {
  const policyPath = join(process.env.FORGE_HOME!, "model-policy.yml");
  const apikeyRuntimePath = join(process.env.FORGE_HOME!, "runtimes", "claude-apikey.yml");
  process.env.ANTHROPIC_API_KEY = "sk-stub"; // makes auth:api available (probeAuth)

  writeFileSync(policyPath, `
schema_version: 2
on_unavailable: fail
model_profiles:
  claude-api:
    provider: anthropic
    auth: api
    map:
      review:  { model: model-review,  cost_tier: standard }
      default: { model: model-default, cost_tier: standard }
defaults:
  profile: claude-api
  activity: {}
`);
  if (!existsSync(apikeyRuntimePath)) {
    mkdirSync(dirname(apikeyRuntimePath), { recursive: true });
    writeFileSync(apikeyRuntimePath, `name: claude-apikey
description: test stub apikey runtime
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
`);
  }
  publishFlatAsGeneration(process.env.FORGE_HOME!);

  try {
    // Explicit 'reasoning' activity is absent from claude-api's map (review/default),
    // which is NOT default-only → activity_unmapped, refused before dispatch.
    const BLOCKED_WF: Workflow = {
      name: "test-activity-unmapped",
      description: "one step with an explicit unmapped activity",
      review_mode: "legacy_verdict",
      inputs: [],
      steps: [{ id: "work", agent: "engineer", activity: "reasoning", gate: "auto", manual: false, depends_on: [], runtime: "claude", reds: [] }],
    };
    const blocked = startRun({ workflow: BLOCKED_WF, title: "unmapped", inputs: {}, projectDir: "/tmp/test-project" });

    let dockerCalled = false;
    const spyExec: DockerExecFn = async (a) => {
      dockerCalled = true;
      return makeStubExec({ status: "complete" })(a);
    };
    await runNext({ runId: blocked.runId, workflow: BLOCKED_WF, dockerExec: spyExec });

    const blockedPrimary = tasksForRun(blocked.runId).find((t) => t.phase === "work")!;
    assert.equal(blockedPrimary.status, "failed");
    assert.match(blockedPrimary.error ?? "", /activity_unmapped/);
    assert.equal(dockerCalled, false, "container must not spawn on an activity_unmapped step");
    const blockedEvents = eventsForTask(blockedPrimary.id).map((e) => e.eventType);
    assert.ok(blockedEvents.includes("model.profile_unavailable"));
    assert.ok(!blockedEvents.includes("container.started"), "no container.started on an activity_unmapped refusal");

    // Negative: an EXACT explicit activity on the same profile dispatches normally.
    const OK_WF: Workflow = {
      name: "test-activity-mapped",
      description: "one step with an explicit exact activity",
      review_mode: "legacy_verdict",
      inputs: [],
      steps: [{ id: "work", agent: "engineer", activity: "review", gate: "auto", manual: false, depends_on: [], runtime: "claude", reds: [] }],
    };
    const ok = startRun({ workflow: OK_WF, title: "mapped", inputs: {}, projectDir: "/tmp/test-project" });
    let okDockerCalled = false;
    const okExec: DockerExecFn = async (a) => {
      okDockerCalled = true;
      return makeStubExec({ status: "complete" })(a);
    };
    await runNext({ runId: ok.runId, workflow: OK_WF, dockerExec: okExec });
    const okPrimary = tasksForRun(ok.runId).find((t) => t.phase === "work")!;
    // Dispatch PROCEEDED (container ran); it was not refused by the activity gate.
    // The stub's tests-less "complete" is then held at awaiting_gate by the
    // validation contract — that is downstream of, and orthogonal to, the FG-560 gate.
    assert.equal(okDockerCalled, true, "an exact explicit activity must dispatch (container runs)");
    assert.notEqual(okPrimary.status, "failed");
    const okEvents = eventsForTask(okPrimary.id).map((e) => e.eventType);
    assert.ok(okEvents.includes("container.started"), "exact activity must reach container.started");
    assert.equal(okPrimary.agentModel, "model-review");
    assert.equal(okPrimary.resolvedMappingPath, "exact");
    assert.equal(okPrimary.resolvedCapabilitySource, "explicit");

    // The other allowed negative half: with no step activity, the role-derived
    // capability may use map.default. This must dispatch rather than inheriting
    // the explicit-activity refusal above.
    const DEFAULT_FALLBACK_WF: Workflow = {
      name: "test-role-derived-default-fallback",
      description: "role-derived capability uses the profile default",
      review_mode: "legacy_verdict",
      inputs: [],
      steps: [{ id: "work", agent: "tech-lead", gate: "auto", manual: false, depends_on: [], runtime: "claude", reds: [] }],
    };
    const fallback = startRun({ workflow: DEFAULT_FALLBACK_WF, title: "fallback", inputs: {}, projectDir: "/tmp/test-project" });
    let fallbackDockerCalled = false;
    await runNext({ runId: fallback.runId, workflow: DEFAULT_FALLBACK_WF, dockerExec: async (a) => {
      fallbackDockerCalled = true;
      return makeStubExec({ status: "complete" })(a);
    } });
    const fallbackPrimary = tasksForRun(fallback.runId).find((t) => t.phase === "work")!;
    assert.equal(fallbackDockerCalled, true, "role-derived default-fallback must reach the container");
    assert.notEqual(fallbackPrimary.status, "failed");
    assert.equal(fallbackPrimary.resolvedMappingPath, "default-fallback");
    assert.equal(fallbackPrimary.resolvedCapabilitySource, "role-derived");
  } finally {
    rmSync(policyPath, { force: true });
  }
});

test("runNext: AWN-5 grading is ENFORCED on verdict ingestion — malformed rejected, weak downgraded (finding)", async () => {
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  const { runId } = startRun({ workflow: REDS_AUTH_ALL_PASS_WORKFLOW, title: "grade", inputs: {}, projectDir: "/tmp/test-project" });

  const exec = makeRoutingExec([
    { matches: (id) => id.startsWith("task-review-"), result: { status: "complete", artifact: "x" } },
    {
      matches: (id) => id.startsWith("task-red-review-"),
      result: {
        status: "complete", verdict: "fail", confidence: 0.9,
        findings: [
          { summary: "", severity: "high", evidence: "", hypothesis: "" },                                    // malformed → rejected
          { summary: "weak unverified claim", severity: "high", evidence: "", hypothesis: "", confidence: 0.3 }, // unsupported+confident → downgraded
        ],
      },
    },
  ]);
  await runNext({ runId, workflow: REDS_AUTH_ALL_PASS_WORKFLOW, dockerExec: exec });

  const primary = tasksForRun(runId).find((t) => t.parentId === undefined)!;
  const verdicts = verdictsForTask(primary.id);
  assert.ok(verdicts.length >= 1);
  const findings = verdicts[0]!.findings;
  assert.equal(findings.length, 1, "the malformed (no-summary) finding is rejected at ingestion");
  assert.equal(findings[0]!.severity, "medium", "the weak unsupported high-severity finding is downgraded to medium");
});

test("runNext: an authoritative fail whose findings are ALL malformed does NOT block — grading downgrades it to inconclusive (finding)", async () => {
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  const { runId } = startRun({ workflow: REDS_AUTH_ALL_PASS_WORKFLOW, title: "grade-gate", inputs: {}, projectDir: "/tmp/test-project" });

  const exec = makeRoutingExec([
    { matches: (id) => id.startsWith("task-review-"), result: { status: "complete", artifact: "x" } },
    {
      matches: (id) => id.startsWith("task-red-review-"),
      // an authoritative FAIL, but its only finding is malformed (no summary)
      result: { status: "complete", verdict: "fail", confidence: 0.9, findings: [{ summary: "", severity: "high", evidence: "", hypothesis: "" }] },
    },
  ]);
  await runNext({ runId, workflow: REDS_AUTH_ALL_PASS_WORKFLOW, dockerExec: exec });

  const primary = tasksForRun(runId).find((t) => t.parentId === undefined)!;
  assert.notEqual(primary.status, "blocked_by_red", "an all-malformed fail must NOT block the gate");
  assert.equal(primary.status, "awaiting_gate", "downgraded → no authoritative block → normal verdict gate");
  const verdicts = verdictsForTask(primary.id);
  assert.ok(verdicts.every((v) => v.verdict === "inconclusive"), "fail with all-malformed findings is downgraded to inconclusive");
});

test("runNext: an authoritative fail with NO findings at all does NOT block — unsubstantiated → inconclusive (finding)", async () => {
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  const { runId } = startRun({ workflow: REDS_AUTH_ALL_PASS_WORKFLOW, title: "empty-fail", inputs: {}, projectDir: "/tmp/test-project" });

  const exec = makeRoutingExec([
    { matches: (id) => id.startsWith("task-review-"), result: { status: "complete", artifact: "x" } },
    { matches: (id) => id.startsWith("task-red-review-"), result: { status: "complete", verdict: "fail", confidence: 0.9, findings: [] } }, // fail, zero findings
  ]);
  await runNext({ runId, workflow: REDS_AUTH_ALL_PASS_WORKFLOW, dockerExec: exec });

  const primary = tasksForRun(runId).find((t) => t.parentId === undefined)!;
  assert.notEqual(primary.status, "blocked_by_red", "an unsubstantiated fail (no findings) must NOT block");
  assert.equal(primary.status, "awaiting_gate");
  const verdicts = verdictsForTask(primary.id);
  assert.ok(verdicts.every((v) => v.verdict === "inconclusive"), "fail with no findings downgraded to inconclusive");
});

test("runNext: reds — authoritative fail blocks the primary (blocked_by_red)", async () => {
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  const { runId } = startRun({
    workflow: REDS_AUTH_FAIL_WORKFLOW,
    title: "reds fail",
    inputs: {},
    projectDir: "/tmp/test-project",
  });

  let redSeq = 0;
  const exec = makeRoutingExec([
    {
      matches: (id) => id.startsWith("task-review-"),
      result: { status: "complete", artifact: "the thing" },
    },
    {
      matches: (id) => id.startsWith("task-red-review-"),
      // First red passes, second fails. Order isn't strictly deterministic
      // because they run in parallel, but the routing closure captures the
      // sequence — the test cares that at least one red fail produces blocked_by_red.
      result: undefined as never, // overwritten below
    },
  ]);
  // Custom exec: alternate pass / fail for reds.
  const customExec: DockerExecFn = async ({ args, stdoutPath, stderrPath }) => {
    const nameIdx = args.indexOf("--name");
    const fullName = nameIdx >= 0 ? args[nameIdx + 1] ?? "" : "";
    const taskId = fullName.replace(/^forge-/, "");
    const dir = dirname(stdoutPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    if (taskId.startsWith("task-review-")) {
      writeFileSync(join(dir, "result.json"), JSON.stringify({ status: "complete", artifact: "x" }));
    } else if (taskId.startsWith("task-red-review-")) {
      // First red passes, second fails.
      const result = redSeq === 0
        ? { status: "complete", verdict: "pass", confidence: 0.9, findings: [] }
        : { status: "complete", verdict: "fail", confidence: 0.9, findings: [{ severity: "high", summary: "boom", evidence: "logs", hypothesis: "bug" }] };
      redSeq++;
      writeFileSync(join(dir, "result.json"), JSON.stringify(result));
    } else {
      writeFileSync(join(dir, "result.json"), JSON.stringify({ status: "complete" }));
    }
    writeFileSync(stdoutPath, "");
    writeFileSync(stderrPath, "");
    return 0;
  };

  // Suppress lint about unused exec.
  void exec;

  const wave = await runNext({ runId, workflow: REDS_AUTH_FAIL_WORKFLOW, dockerExec: customExec });

  assert.deepEqual(wave.awaitingGate, ["review"]); // awaitingGate bucket includes blocked_by_red
  const tasks = tasksForRun(runId);
  const primary = tasks.find((t) => t.parentId === undefined)!;
  assert.equal(primary.status, "blocked_by_red");

  const verdicts = verdictsForTask(primary.id);
  assert.equal(verdicts.length, 2);
  assert.ok(verdicts.some((v) => v.verdict === "fail"));
});

test("runNext: reds — specialist fail does NOT block (advisory), primary proceeds to complete", async () => {
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  const { runId } = startRun({
    workflow: REDS_SPECIALIST_FAIL_WORKFLOW,
    title: "specialist red fail",
    inputs: {},
    projectDir: "/tmp/test-project",
  });

  const exec = makeRoutingExec([
    {
      matches: (id) => id.startsWith("task-review-"),
      result: { status: "complete", artifact: "x" },
    },
    {
      matches: (id) => id.startsWith("task-red-review-"),
      // A SUBSTANTIATED fail (real finding) so it stays 'fail' through grading —
      // the point is that a specialist fail is advisory and doesn't block.
      result: { status: "complete", verdict: "fail", confidence: 0.8, findings: [{ severity: "high", summary: "real issue", evidence: "observed in logs", hypothesis: "bug" }] },
    },
  ]);

  const wave = await runNext({ runId, workflow: REDS_SPECIALIST_FAIL_WORKFLOW, dockerExec: exec });

  assert.deepEqual(wave.completedSteps, ["review"]);
  assert.deepEqual(wave.awaitingGate, []);

  const tasks = tasksForRun(runId);
  const primary = tasks.find((t) => t.parentId === undefined)!;
  // gate: auto + only specialist verdict-fail → primary completes (advisory only)
  assert.equal(primary.status, "complete");

  const verdicts = verdictsForTask(primary.id);
  assert.equal(verdicts.length, 1);
  assert.equal(verdicts[0]!.verdict, "fail", "a substantiated specialist fail stays fail (advisory, not blocking)");
  assert.equal(verdicts[0]!.authority, "specialist");
});

// ---------------------------------------------------------------------------
// Fanout
// ---------------------------------------------------------------------------

const FANOUT_WORKFLOW: Workflow = {
  name: "test-fanout",
  description: "research step fans out per claim from upstream",
  review_mode: "legacy_verdict",
  inputs: [],
  steps: [
    {
      id: "plan",
      agent: "planner-agent",
      gate: "auto",
      manual: false,
      depends_on: [],
      runtime: "claude",
      reds: [],
    },
    {
      id: "research",
      agent: "research-agent",
      gate: "auto",
      manual: false,
      depends_on: ["plan"],
      runtime: "claude",
      reds: [],
      fanout: {
        from_upstream: { step: "plan", array_key: "claims", input_key: "claim" },
        max_concurrency: 2,
        failure_mode: "fail-phase",
      },
    },
  ],
};

test("runNext: fanout — plan returns N claims, research spawns N children, parent aggregates", async () => {
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  const { runId } = startRun({
    workflow: FANOUT_WORKFLOW,
    title: "fanout test",
    inputs: {},
    projectDir: "/tmp/test-project",
  });

  const claims = ["claim-a", "claim-b", "claim-c"];
  const exec = makeRoutingExec([
    {
      matches: (id) => id.startsWith("task-plan-"),
      result: { status: "complete", claims },
    },
    {
      matches: (id) => id.startsWith("task-research-"),
      result: { status: "complete", evidence: "found stuff" },
    },
  ]);

  // Wave 1: plan
  const wave1 = await runNext({ runId, workflow: FANOUT_WORKFLOW, dockerExec: exec });
  assert.deepEqual(wave1.dispatchedSteps, ["plan"]);
  assert.deepEqual(wave1.completedSteps, ["plan"]);

  // Wave 2: research (fanout)
  const wave2 = await runNext({ runId, workflow: FANOUT_WORKFLOW, dockerExec: exec });
  assert.deepEqual(wave2.dispatchedSteps, ["research"]);
  assert.deepEqual(wave2.completedSteps, ["research"]);

  const tasks = tasksForRun(runId);
  // plan (1 primary) + research parent (1) + 3 children = 5
  assert.equal(tasks.length, 5);

  const researchParent = tasks.find((t) => t.phase === "research" && t.parentId === undefined)!;
  assert.equal(researchParent.status, "complete");

  const children = tasks.filter((t) => t.phase === "research" && t.parentId === researchParent.id);
  assert.equal(children.length, 3);
  assert.ok(children.every((c) => c.status === "complete"));

  // Parent result aggregates children
  const parentResult = researchParent.result as { children: Array<{ index: number; status: string }> };
  assert.equal(parentResult.children.length, 3);
  assert.ok(parentResult.children.every((c) => c.status === "complete"));

  const wave3 = await runNext({ runId, workflow: FANOUT_WORKFLOW, dockerExec: exec });
  assert.deepEqual(wave3.dispatchedSteps, []);
  assert.equal(wave3.runStatus, "complete");
});

// FG-503 (review): a fanout child's own container reap — runFanoutChild's
// finalizeContainerRetention call — previously discarded its outcome, unlike
// the primary's. Same reapContainerAndReportFailure wrapper, keyed on the
// CHILD's own task id (not the fanout parent's).
test("runNext: FG-503 — a completed fanout child's own container reap failure is durably recorded", async () => {
  await withFailingDockerRmStub(async (logPath) => {
    process.env.ANTHROPIC_API_KEY = "sk-stub";
    const { runId } = startRun({
      workflow: FANOUT_WORKFLOW,
      title: "fanout child reap-failed test",
      inputs: {},
      projectDir: "/tmp/test-project",
    });

    const claims = ["claim-a", "claim-b"];
    const exec = makeRoutingExec([
      { matches: (id) => id.startsWith("task-plan-"), result: { status: "complete", claims } },
      { matches: (id) => id.startsWith("task-research-"), result: { status: "complete", evidence: "found stuff" } },
    ]);

    await runNext({ runId, workflow: FANOUT_WORKFLOW, dockerExec: exec }); // plan
    const wave2 = await runNext({ runId, workflow: FANOUT_WORKFLOW, dockerExec: exec }); // research fanout
    assert.deepEqual(wave2.completedSteps, ["research"], "a child's reap failure must never block the parent from completing");

    const tasks = tasksForRun(runId);
    const parent = tasks.find((t) => t.phase === "research" && t.parentId === undefined)!;
    const children = tasks.filter((t) => t.phase === "research" && t.parentId === parent.id);
    assert.equal(children.length, 2);
    assert.ok(children.every((c) => c.status === "complete"));

    const calls = readFileSync(logPath, "utf8");
    for (const child of children) {
      assert.match(calls, new RegExp(`rm -f -v forge-${child.id}`), "each completed fanout child's own container reap was attempted");
      const types = eventsForTask(child.id).map((e) => e.eventType);
      assert.equal(types.filter((t) => t === "container.reap_failed").length, 1, "the child's own reap failure must be durably recorded on the child's own task");
      const payload = eventsForTask(child.id).find((e) => e.eventType === "container.reap_failed")!.payload as { containerName: string; why: string };
      assert.equal(payload.containerName, `forge-${child.id}`);
    }
  });
});

test("runNext: FG-503 — a completed fanout child's own container reap succeeding emits no container.reap_failed event", async () => {
  await withDockerRmStub(async (logPath) => {
    process.env.ANTHROPIC_API_KEY = "sk-stub";
    const { runId } = startRun({
      workflow: FANOUT_WORKFLOW,
      title: "fanout child reap-happy-path test",
      inputs: {},
      projectDir: "/tmp/test-project",
    });

    const claims = ["claim-a", "claim-b"];
    const exec = makeRoutingExec([
      { matches: (id) => id.startsWith("task-plan-"), result: { status: "complete", claims } },
      { matches: (id) => id.startsWith("task-research-"), result: { status: "complete", evidence: "found stuff" } },
    ]);

    await runNext({ runId, workflow: FANOUT_WORKFLOW, dockerExec: exec }); // plan
    const wave2 = await runNext({ runId, workflow: FANOUT_WORKFLOW, dockerExec: exec }); // research fanout
    assert.deepEqual(wave2.completedSteps, ["research"]);

    const tasks = tasksForRun(runId);
    const parent = tasks.find((t) => t.phase === "research" && t.parentId === undefined)!;
    const children = tasks.filter((t) => t.phase === "research" && t.parentId === parent.id);
    assert.equal(children.length, 2);

    const calls = readFileSync(logPath, "utf8");
    for (const child of children) {
      assert.match(calls, new RegExp(`rm -f -v forge-${child.id}`));
      const types = eventsForTask(child.id).map((e) => e.eventType);
      assert.equal(types.filter((t) => t === "container.reap_failed").length, 0, "the happy path must stay silent for a fanout child's own reap too");
    }
  });
});

// ---------------------------------------------------------------------------
// FG-365: model-policy provenance is memoized per projectDir per dispatch
// wave — runContainer previously called loadModelPolicyWithSource once per
// container, so a fan-out of N children + M reds re-read/re-parsed the same
// model-policy.yml N+M times.
// ---------------------------------------------------------------------------

const FANOUT_WITH_REDS_WORKFLOW: Workflow = {
  name: "fg365-fanout-reds",
  description: "fanout step with reds, for model-policy memoization test",
  review_mode: "legacy_verdict",
  inputs: [],
  steps: [
    {
      id: "plan",
      agent: "planner-agent",
      gate: "auto",
      manual: false,
      depends_on: [],
      runtime: "claude",
      reds: [],
    },
    {
      id: "build",
      agent: "engineer",
      gate: "auto",
      manual: false,
      depends_on: ["plan"],
      runtime: "claude",
      reds: [
        { agent: "red-narrow", authority: "specialist", gate_on_verdict: false },
        { agent: "red-wide", authority: "specialist", gate_on_verdict: false },
      ],
      fanout: {
        from_upstream: { step: "plan", array_key: "items", input_key: "item" },
        max_concurrency: 4,
        failure_mode: "continue",
      },
    },
  ],
};

test("runNext: FG-365 — model-policy loaded once per projectDir per wave, not once per container, across a fanout+reds dispatch", async () => {
  ensureRuntime();
  process.env.ANTHROPIC_API_KEY = "sk-stub"; // makes auth:api available (probeAuth)

  // Policy mode resolves the RUNTIME from (provider, auth) — auth:api binds to
  // "claude-apikey", not the workflow-declared "claude" — so a stub runtime for
  // it must exist too (mirrors the run-level --profile test above).
  const apikeyRuntimePath = join(process.env.FORGE_HOME!, "runtimes", "claude-apikey.yml");
  if (!existsSync(apikeyRuntimePath)) {
    mkdirSync(dirname(apikeyRuntimePath), { recursive: true });
    writeFileSync(apikeyRuntimePath, `name: claude-apikey
description: test stub apikey runtime
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
`);
  }
  // FG-583: publish the flat runtimes as a complete generation so dispatch resolves them.
  publishFlatAsGeneration(process.env.FORGE_HOME!);

  const projectDir = mkdtempSync(join(tmpdir(), "forge-fg365-"));
  mkdirSync(join(projectDir, ".forge"), { recursive: true });
  writeFileSync(join(projectDir, ".forge", "model-policy.yml"), `
on_unavailable: fail
schema_version: 2
model_profiles:
  claude-api:
    provider: anthropic
    auth: api
    map:
      default: { model: claude-sonnet-4-6, cost_tier: standard }
defaults:
  profile: claude-api
  activity: {}
`);

  try {
    const { runId } = startRun({
      workflow: FANOUT_WITH_REDS_WORKFLOW,
      title: "fg365 memoization test",
      inputs: {},
      projectDir,
    });

    // FG-524 contract: this shared result also completes implementer fanout children.
    // Plan needs `items` (the fanout array); children and reds just need to report complete.
    const exec = makeStubExec({ status: "complete", tests_run: 1, items: ["a", "b", "c"] });

    // Spy that delegates to the REAL loader — proves both call count and that
    // the memoized receipt still reflects real provenance (source: "project").
    let loadCount = 0;
    const countingLoader: typeof loadModelPolicyWithSource = (ctx) => {
      loadCount++;
      return loadModelPolicyWithSource(ctx);
    };

    // Wave 1: single primary ("plan") — one container, one load.
    const wave1 = await runNext({
      runId,
      workflow: FANOUT_WITH_REDS_WORKFLOW,
      dockerExec: exec,
      modelPolicyLoader: countingLoader,
    });
    assert.deepEqual(wave1.dispatchedSteps, ["plan"]);
    assert.equal(loadCount, 1, "wave 1 (single primary) loads model-policy exactly once");

    // Wave 2: fanout ("build") — 3 children + 2 reds = 5 containers dispatched
    // against the SAME projectDir. Without the fix this would load 5 times.
    const wave2 = await runNext({
      runId,
      workflow: FANOUT_WITH_REDS_WORKFLOW,
      dockerExec: exec,
      modelPolicyLoader: countingLoader,
    });
    assert.deepEqual(wave2.dispatchedSteps, ["build"]);

    const tasks = tasksForRun(runId);
    const buildParent = tasks.find((t) => t.phase === "build" && t.parentId === undefined)!;
    const children = tasks.filter(
      (t) => t.parentId === buildParent.id && !t.agentRole.startsWith("red-"),
    );
    const reds = tasks.filter(
      (t) => t.parentId === buildParent.id && t.agentRole.startsWith("red-"),
    );
    assert.equal(children.length, 3, "3 fanout children dispatched");
    assert.equal(reds.length, 2, "2 reds dispatched on the fanout aggregate");

    assert.equal(
      loadCount,
      2,
      "wave 2 dispatches 5 containers (3 children + 2 reds) against one projectDir but must add exactly " +
        "one more model-policy load (total 2), not 5 more (FG-365)",
    );

    // The memoized receipt still records real, correct provenance.
    const childManifest = JSON.parse(
      readFileSync(join(taskDir(runId, children[0]!.id), "manifest.json"), "utf8"),
    ) as TaskManifest;
    assert.equal(childManifest.controlPlane?.modelPolicy.source, "project");
    assert.ok(childManifest.controlPlane?.modelPolicy.path?.includes(projectDir));
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

// AWN-7 leak guard: a run-level --profile (metadata.modelProfile) pours through
// run metadata into fanout child inputs unless stripped. The leak is independent
// of policy mode — modelProfile is in metadata regardless — so this runs in
// legacy mode (no model-policy.yml) and asserts the child task packages are
// clean of every control-plane key.
test("runNext: fanout — control-plane metadata (modelProfile/workspace) is stripped from child task inputs", async () => {
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  const { runId } = startRun({
    workflow: FANOUT_WORKFLOW,
    title: "fanout leak guard",
    inputs: {},
    projectDir: "/tmp/test-project",
    workspace: "/tmp/test-workspace",
    modelProfile: "some-profile",
  });

  const exec = makeRoutingExec([
    { matches: (id) => id.startsWith("task-plan-"), result: { status: "complete", claims: ["a", "b"] } },
    { matches: (id) => id.startsWith("task-research-"), result: { status: "complete", evidence: "x" } },
  ]);

  await runNext({ runId, workflow: FANOUT_WORKFLOW, dockerExec: exec }); // plan
  await runNext({ runId, workflow: FANOUT_WORKFLOW, dockerExec: exec }); // research fanout

  const tasks = tasksForRun(runId);
  const parent = tasks.find((t) => t.phase === "research" && t.parentId === undefined)!;
  const children = tasks.filter((t) => t.phase === "research" && t.parentId === parent.id);
  assert.equal(children.length, 2);
  for (const child of children) {
    assert.ok(!("modelProfile" in child.taskPackage.inputs), "modelProfile must not leak into fanout child inputs");
    assert.ok(!("workspace" in child.taskPackage.inputs), "workspace must not leak into fanout child inputs");
    // the real per-child input is still present
    assert.ok(["a", "b"].includes(child.taskPackage.inputs["claim"] as string), "the fanout claim input survives the strip");
  }
  assert.deepEqual(
    children.map((c) => c.taskPackage.inputs["claim"]).sort(),
    ["a", "b"],
    "both claims dispatched exactly once",
  );
});

test("runNext: fanout — failure_mode=fail-phase short-circuits and parent fails", async () => {
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  const wf: Workflow = {
    ...FANOUT_WORKFLOW,
    name: "test-fanout-failphase",
  };

  const { runId } = startRun({
    workflow: wf,
    title: "fanout fail-phase",
    inputs: {},
    projectDir: "/tmp/test-project",
  });

  // Custom exec: plan returns 4 claims; first research child fails (exit 1, empty result.json).
  let researchCount = 0;
  const customExec: DockerExecFn = async ({ args, stdoutPath, stderrPath }) => {
    const nameIdx = args.indexOf("--name");
    const fullName = nameIdx >= 0 ? args[nameIdx + 1] ?? "" : "";
    const taskId = fullName.replace(/^forge-/, "");
    const dir = dirname(stdoutPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    if (taskId.startsWith("task-plan-")) {
      writeFileSync(join(dir, "result.json"), JSON.stringify({ status: "complete", claims: ["a", "b", "c", "d"] }));
      writeFileSync(stdoutPath, "");
      writeFileSync(stderrPath, "");
      return 0;
    }
    // research child
    researchCount++;
    if (researchCount === 1) {
      // crash
      writeFileSync(join(dir, "result.json"), "");
      writeFileSync(stdoutPath, "");
      writeFileSync(stderrPath, "boom");
      return 1;
    }
    writeFileSync(join(dir, "result.json"), JSON.stringify({ status: "complete" }));
    writeFileSync(stdoutPath, "");
    writeFileSync(stderrPath, "");
    return 0;
  };

  await runNext({ runId, workflow: wf, dockerExec: customExec });
  await runNext({ runId, workflow: wf, dockerExec: customExec });

  const tasks = tasksForRun(runId);
  const researchParent = tasks.find((t) => t.phase === "research" && t.parentId === undefined)!;
  assert.equal(researchParent.status, "failed");

  const children = tasks.filter((t) => t.phase === "research" && t.parentId === researchParent.id);
  // fail-phase short-circuits after the first batch. max_concurrency=2 means
  // 2 children launched in batch 1; the failing one stops further dispatch.
  // So we expect 2 children total, not 4.
  assert.equal(children.length, 2);
});

test("runNext: fanout — missing array_key on upstream marks parent failed", async () => {
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  const wf: Workflow = {
    ...FANOUT_WORKFLOW,
    name: "test-fanout-noarr",
  };
  const { runId } = startRun({
    workflow: wf,
    title: "fanout missing key",
    inputs: {},
    projectDir: "/tmp/test-project",
  });

  // plan returns no claims array
  const exec = makeRoutingExec([
    {
      matches: (id) => id.startsWith("task-plan-"),
      result: { status: "complete", other: "field" },
    },
  ]);

  await runNext({ runId, workflow: wf, dockerExec: exec });
  await runNext({ runId, workflow: wf, dockerExec: exec });

  const tasks = tasksForRun(runId);
  const researchParent = tasks.find((t) => t.phase === "research" && t.parentId === undefined)!;
  assert.equal(researchParent.status, "failed");
  assert.match(researchParent.error ?? "", /no array/);
  // Defensive fanout failure must still go through normal lifecycle bookkeeping:
  // completedAt is set (markTaskFailed), and the timeline brackets created→failed.
  assert.ok(researchParent.completedAt, "defensively-failed fanout parent must have completedAt set");
  const types = eventsForTask(researchParent.id).map((e) => e.eventType);
  assert.ok(types.includes("task.created"), "fanout parent must emit task.created even on defensive failure");
  assert.ok(types.includes("task.failed"), "fanout parent must emit task.failed");
  assert.ok(
    types.indexOf("task.created") < types.indexOf("task.failed"),
    "task.created must precede task.failed",
  );
  // failure_kind comes from the classifier (via failTask), not a hardcoded string.
  const failedEv = eventsForTask(researchParent.id).find((e) => e.eventType === "task.failed")!;
  assert.equal(typeof (failedEv.payload as Record<string, unknown>).failure_kind, "string");
});

// ------------------------------------------------------------------
// resolveChildAgent (#139) — pure function unit tests
// ------------------------------------------------------------------

const _step: Step = {
  id: "build",
  agent: "engineer",
  runtime: "claude",
  depends_on: [],
  gate: "human",
  manual: false,
  reds: [],
};

function fanoutWith(over: Partial<FanoutDef>): FanoutDef {
  return {
    from_upstream: { step: "plan", array_key: "steps", input_key: "step" },
    failure_mode: "fail-phase",
    ...over,
  };
}

test("resolveChildAgent: returns mapped agent when discipline matches", () => {
  const fanout = fanoutWith({ agent_map: { frontend: "frontend-specialist", backend: "backend-specialist" } });
  assert.equal(resolveChildAgent(_step, fanout, { discipline: "frontend" }), "frontend-specialist");
  assert.equal(resolveChildAgent(_step, fanout, { discipline: "backend" }), "backend-specialist");
});

test("resolveChildAgent: falls back to step.agent when discipline not in map", () => {
  const fanout = fanoutWith({ agent_map: { frontend: "frontend-specialist" } });
  assert.equal(resolveChildAgent(_step, fanout, { discipline: "general" }), "engineer");
  assert.equal(resolveChildAgent(_step, fanout, { discipline: "unknown" }), "engineer");
});

test("resolveChildAgent: falls back to step.agent when discipline key missing on input", () => {
  const fanout = fanoutWith({ agent_map: { frontend: "frontend-specialist" } });
  assert.equal(resolveChildAgent(_step, fanout, { id: "1", summary: "x" }), "engineer");
});

test("resolveChildAgent: falls back to step.agent when input is not an object", () => {
  const fanout = fanoutWith({ agent_map: { frontend: "frontend-specialist" } });
  assert.equal(resolveChildAgent(_step, fanout, "frontend"), "engineer");
  assert.equal(resolveChildAgent(_step, fanout, 42), "engineer");
  assert.equal(resolveChildAgent(_step, fanout, null), "engineer");
  assert.equal(resolveChildAgent(_step, fanout, ["frontend"]), "engineer");
});

test("resolveChildAgent: respects custom discipline_key (not default 'discipline')", () => {
  const fanout = fanoutWith({
    agent_map: { fe: "frontend-specialist" },
    discipline_key: "track",
  });
  assert.equal(resolveChildAgent(_step, fanout, { track: "fe" }), "frontend-specialist");
  // The default key 'discipline' should NOT be consulted when discipline_key is set.
  assert.equal(resolveChildAgent(_step, fanout, { discipline: "fe" }), "engineer");
});

test("resolveChildAgent: returns step.agent when agent_map is undefined (backwards compat)", () => {
  const fanout = fanoutWith({});
  assert.equal(resolveChildAgent(_step, fanout, { discipline: "frontend" }), "engineer");
});

// ---------------------------------------------------------------------------
// #194: lifecycle event backfill — task.awaiting_gate, container.*
// ---------------------------------------------------------------------------

function ensureClaudeRuntime(): void {
  const fhome = process.env.FORGE_HOME!;
  const runtimePath = join(fhome, "runtimes", "claude.yml");
  if (!existsSync(runtimePath)) {
    mkdirSync(dirname(runtimePath), { recursive: true });
    writeFileSync(runtimePath, `
name: claude
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
`);
  }
  // FG-583: publish the flat runtime as a complete generation so dispatch resolves it.
  publishFlatAsGeneration(fhome);
}

test("runNext: gate: human emits task.awaiting_gate with runId and taskId", async () => {
  ensureClaudeRuntime();
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  const { runId } = startRun({
    workflow: HUMAN_GATE_WORKFLOW,
    title: "awaiting_gate event test",
    inputs: { brief: "x" },
    projectDir: "/tmp/test-project",
  });

  const stub = makeStubExec({ status: "complete" });
  await runNext({ runId, workflow: HUMAN_GATE_WORKFLOW, dockerExec: stub });

  const tasks = tasksForRun(runId);
  const primary = tasks.find((t) => t.phase === "needs-review" && t.parentId === undefined)!;
  assert.equal(primary.status, "awaiting_gate");

  const events = eventsForTask(primary.id);
  const gateEv = events.find((e) => e.eventType === "task.awaiting_gate");
  assert.ok(gateEv, "must emit task.awaiting_gate when task enters awaiting_gate");
  assert.equal(gateEv!.runId, runId);
  assert.equal(gateEv!.taskId, primary.id);
});

test("runNext: container.started and container.exited emitted on successful step", async () => {
  ensureClaudeRuntime();
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  const WF: Workflow = {
    name: "test-container-events",
    description: "one step for container event test",
    review_mode: "legacy_verdict",
    inputs: [],
    steps: [{ id: "work", agent: "engineer", gate: "auto", manual: false, depends_on: [], runtime: "claude", reds: [] }],
  };
  const { runId } = startRun({ workflow: WF, title: "container event test", inputs: {}, projectDir: "/tmp/test-project" });

  await runNext({ runId, workflow: WF, dockerExec: makeStubExec({ status: "complete" }) });

  const tasks = tasksForRun(runId);
  const primary = tasks.find((t) => t.phase === "work" && t.parentId === undefined)!;
  const events = eventsForTask(primary.id);
  const types = events.map((e) => e.eventType);

  assert.ok(types.includes("container.started"), "must emit container.started");
  assert.ok(types.includes("container.exited"), "must emit container.exited on success");

  const started = events.find((e) => e.eventType === "container.started")!;
  assert.equal((started.payload as Record<string, unknown>).containerName, `forge-${primary.id}`);

  const exited = events.find((e) => e.eventType === "container.exited")!;
  assert.equal((exited.payload as Record<string, unknown>).exitCode, 0);
});

// FG-492: docker-exec.ts's capture-at-close reports causal evidence via
// onContainerEvidence — mirrors invoke.ts's wiring test. A clean exit (0) with
// no usable result must render as a CONFIRMED exit, never conflated with
// reconcile's "container disappeared with no terminal evidence" state.
test("runNext: FG-492 result-missing after a clean container exit carries confirmed container evidence, not a disappearance", async () => {
  ensureClaudeRuntime();
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  const WF: Workflow = {
    name: "test-fg492-container-evidence",
    description: "one step that exits cleanly but writes no result",
    review_mode: "legacy_verdict",
    inputs: [],
    steps: [{ id: "work", agent: "engineer", gate: "auto", manual: false, depends_on: [], runtime: "claude", reds: [] }],
  };
  const { runId } = startRun({ workflow: WF, title: "fg492 container evidence test", inputs: {}, projectDir: "/tmp/test-project" });

  const cleanExitNoResult: DockerExecFn = async ({ stdoutPath, stderrPath, onContainerEvidence }) => {
    const dir = dirname(stdoutPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(stdoutPath, "agent produced no result.json");
    writeFileSync(stderrPath, "");
    onContainerEvidence?.({ containerName: "forge-stub", containerExitedEventObserved: true, dockerExitCode: 0, oomKilled: false });
    return 0;
  };

  await runNext({ runId, workflow: WF, dockerExec: cleanExitNoResult });

  const tasks = tasksForRun(runId);
  const primary = tasks.find((t) => t.phase === "work" && t.parentId === undefined)!;
  assert.equal(primary.status, "failed");
  assert.equal(failureKindForTask(primary.id), "result_missing");

  const events = eventsForTask(primary.id);
  const containerEvidence = getContainerCausalEvidenceFromEvents(events)!;
  assert.ok(containerEvidence, "container.exited must carry the causal evidence");
  assert.equal(containerEvidence.containerExitedEventObserved, true, "Forge directly observed this exit");
  assert.equal(containerEvidence.dockerExitCode, 0);
});

// FG-492 review findings 2+3: same gap as invoke.ts's failTask call — the
// pipeline/fanout-child dispatch path's `no_result_json` failure used to omit
// `evidence`, so detect.ts's state-4 distinction could only be exercised with
// a hand-crafted event. Drive it end to end through runNext's real failTask
// call and confirm runOpsCheck raises the incident off that production shape.
test("runNext: FG-492 finding 2+3 — result_missing from the REAL failTask call carries recovery evidence and is detected by runOpsCheck", async () => {
  ensureClaudeRuntime();
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  const WF: Workflow = {
    name: "test-fg492-detect",
    description: "one step that exits cleanly but writes no result",
    review_mode: "legacy_verdict",
    inputs: [],
    steps: [{ id: "work", agent: "engineer", gate: "auto", manual: false, depends_on: [], runtime: "claude", reds: [] }],
  };
  const { runId } = startRun({ workflow: WF, title: "fg492 detect test", inputs: {}, projectDir: "/tmp/test-project" });

  const cleanExitNoResult: DockerExecFn = async ({ stdoutPath, stderrPath, onContainerEvidence }) => {
    const dir = dirname(stdoutPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(stdoutPath, "agent produced no result.json");
    writeFileSync(stderrPath, "");
    onContainerEvidence?.({ containerName: "forge-stub", containerExitedEventObserved: true, dockerExitCode: 0, oomKilled: false });
    return 0;
  };

  await runNext({ runId, workflow: WF, dockerExec: cleanExitNoResult });

  const tasks = tasksForRun(runId);
  const primary = tasks.find((t) => t.phase === "work" && t.parentId === undefined)!;
  assert.equal(primary.status, "failed");
  assert.equal(failureKindForTask(primary.id), "result_missing");

  const events = eventsForTask(primary.id);
  const orphanEvidence = getOrphanEvidenceFromEvents(events);
  assert.ok(orphanEvidence, "result_missing must now carry recovery evidence off the real failTask call");
  assert.equal(orphanEvidence!.containerExitedEventObserved, true);

  const incidents = runOpsCheck();
  const incident = incidents.find((i) => i.taskId === primary.id);
  assert.ok(incident, "detectOrphanedWorkMayPersist must raise an incident for a real result_missing task.failed event");
  assert.match(incident!.evidence.join(" "), /container exited cleanly but no result\.json was ever produced/);
});

test("runNext: container.idle_timeout emitted (not container.exited) on idle timeout", async () => {
  ensureClaudeRuntime();
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  const WF: Workflow = {
    name: "test-idle-timeout-events",
    description: "one step that idle-timeouts",
    review_mode: "legacy_verdict",
    inputs: [],
    steps: [{ id: "work", agent: "engineer", gate: "auto", manual: false, depends_on: [], runtime: "claude", reds: [] }],
  };
  const { runId } = startRun({ workflow: WF, title: "idle timeout event test", inputs: {}, projectDir: "/tmp/test-project" });

  const idleKilled: DockerExecFn = async ({ stdoutPath, stderrPath }) => {
    const dir = dirname(stdoutPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "result.json"), "");
    writeFileSync(stdoutPath, "");
    writeFileSync(stderrPath, "");
    return IDLE_TIMEOUT_EXIT_CODE;
  };

  await runNext({ runId, workflow: WF, dockerExec: idleKilled });

  const tasks = tasksForRun(runId);
  const primary = tasks.find((t) => t.phase === "work" && t.parentId === undefined)!;
  const events = eventsForTask(primary.id);
  const types = events.map((e) => e.eventType);

  assert.ok(types.includes("container.started"), "must emit container.started");
  assert.ok(types.includes("container.idle_timeout"), "must emit container.idle_timeout");
  assert.ok(!types.includes("container.exited"), "must NOT emit container.exited for idle_timeout");

  const idleEv = events.find((e) => e.eventType === "container.idle_timeout")!;
  assert.equal((idleEv.payload as Record<string, unknown>).exitCode, IDLE_TIMEOUT_EXIT_CODE);
});

// ----- #197: manifest.json written on pipeline dispatch -----

test("runNext: writes manifest.json into the task dir on pipeline dispatch", async () => {
  ensureClaudeRuntime();
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  const WF: Workflow = {
    name: "test-manifest-dispatch",
    description: "one step for manifest test",
    review_mode: "legacy_verdict",
    inputs: [],
    steps: [{ id: "work", agent: "engineer", gate: "auto", manual: false, depends_on: [], runtime: "claude", reds: [] }],
  };
  const { runId } = startRun({ workflow: WF, title: "manifest test", inputs: {}, projectDir: "/tmp/test-project" });

  await runNext({ runId, workflow: WF, dockerExec: makeStubExec({ status: "complete" }) });

  const tasks = tasksForRun(runId);
  const primary = tasks.find((t) => t.phase === "work" && t.parentId === undefined)!;
  assert.ok(primary, "primary task must exist");

  const dir = taskDir(runId, primary.id);
  const manifestPath = join(dir, "manifest.json");
  assert.ok(existsSync(manifestPath), "manifest.json must be written in the task dir");

  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as TaskManifest;
  assert.equal(manifest.taskId, primary.id);
  assert.equal(manifest.runId, runId);
  assert.equal(manifest.files.prompt, "CLAUDE.md");
  assert.equal(manifest.files.result, "result.json");
  assert.equal(manifest.container.name, `forge-${primary.id}`);
  assert.equal(manifest.auth.profileRequested, false);
  assert.equal(manifest.auth.stateMounted, false);

  // Auth block: booleans only, no credential/path values
  const authKeys = Object.keys(manifest.auth).sort();
  assert.deepEqual(authKeys, ["profileRequested", "stateMounted"]);
  for (const v of Object.values(manifest.auth as Record<string, unknown>)) {
    assert.ok(typeof v !== "string" || !v.includes("/"), `auth value must not be a path: ${String(v)}`);
  }
});

// ─── AWN-3 finding: retry must be the task that actually dispatches ──────────

test("runNext after retry: the RETRIED task is dispatched (not a fresh one) and carries previous_failure", async () => {
  const { retry } = await import("./retry.js");
  const { insertTask } = await import("../store/tasks.js");
  const { logEvent } = await import("../store/events.js");

  ensureRuntime();
  // Unlike runNext, retry gets only the run row and must load the workflow BY NAME
  // to tell a workflow step from an ad-hoc invoke row — and refuses when it can't
  // (FG-507). Every real run's workflow came off disk, so put LINEAR_WORKFLOW there.
  mkdirSync(join(process.env.FORGE_HOME!, "workflows"), { recursive: true });
  writeFileSync(
    join(process.env.FORGE_HOME!, "workflows", "test-linear.yml"),
    `name: test-linear
description: two-step linear test
inputs:
  - { name: brief, required: true, type: text }
steps:
  - { id: first, agent: test-agent, gate: auto }
  - { id: second, agent: test-agent, gate: auto, depends_on: [first] }
`,
  );
  // FG-583: republish so the generation carries both the runtime and this workflow.
  publishFlatAsGeneration(process.env.FORGE_HOME!);
  const { runId } = startRun({ workflow: LINEAR_WORKFLOW, title: "retry e2e", inputs: { brief: "x" }, projectDir: "/tmp/test-project" });

  // A failed primary task for the "first" step (as if its first attempt failed).
  insertTask({
    id: "task-first-failed", runId, phase: "first", agentRole: "test-agent", status: "failed",
    error: "no output for 10m",
    taskPackage: { taskId: "task-first-failed", runId, phase: "first", role: "test-agent", inputs: { brief: "x" }, composedSystemPrompt: "" },
    createdAt: new Date().toISOString(),
  });
  logEvent("task.failed", { runId, taskId: "task-first-failed", payload: { failure_kind: "idle_timeout", error: "no output for 10m" } });

  const out = await retry("task-first-failed");
  const retriedId = out.newTask.id;

  await runNext({ runId, workflow: LINEAR_WORKFLOW, dockerExec: makeStubExec({ status: "complete" }) });

  // The retried task itself must have been dispatched (reached a terminal state),
  // NOT a separate fresh primary created alongside it.
  const firstTasks = tasksForRun(runId).filter((t) => t.phase === "first" && t.parentId === undefined);
  const dispatchedRetry = getTask(retriedId)!;
  assert.notEqual(dispatchedRetry.status, "pending", "the retried task must actually be dispatched");
  assert.ok(["running", "complete"].includes(dispatchedRetry.status), `retried task should have run, got ${dispatchedRetry.status}`);
  assert.equal(firstTasks.length, 2, "exactly the failed task + the retried task — no third fresh primary");

  // And the dispatched retry carried the previous-failure context to the agent.
  const pkg = readFileSync(join(taskDir(runId, retriedId), "package.md"), "utf8");
  assert.match(pkg, /previous_failure/, "the retry's package must carry previous_failure context");
  assert.match(pkg, /idle_timeout/, "previous failure kind reaches the agent");
});

test("runNext: a pipeline task cancelled mid-spawn stays failed; no task.completed when the container returns success (AWN-2 task-level)", async () => {
  const { failTask } = await import("./failure-kind.js");
  const { basename } = await import("node:path");
  ensureRuntime();
  const { runId } = startRun({ workflow: LINEAR_WORKFLOW, title: "cancel race e2e", inputs: { brief: "x" }, projectDir: "/tmp/test-project" });

  // Stub: mark the dispatched task failed (cancelled) mid-spawn, then return a
  // successful result — the post-container completion must not overwrite it.
  const cancelMidSpawn: DockerExecFn = async ({ stdoutPath, stderrPath }) => {
    const dir = dirname(stdoutPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const taskId = basename(dir);
    failTask(taskId, { runId, kind: "cancelled", error: "cancelled via forge cancel" });
    writeFileSync(join(dir, "result.json"), JSON.stringify({ status: "complete" }));
    writeFileSync(stdoutPath, ""); writeFileSync(stderrPath, "");
    return 0;
  };

  await runNext({ runId, workflow: LINEAR_WORKFLOW, dockerExec: cancelMidSpawn });

  const first = tasksForRun(runId).find((t) => t.phase === "first" && t.parentId === undefined)!;
  assert.equal(first.status, "failed", "cancelled pipeline task must not be overwritten to complete");
  const types = eventsForTask(first.id).map((e) => e.eventType);
  assert.ok(types.includes("task.failed"), "task.failed (cancelled) emitted");
  assert.ok(!types.includes("task.completed"), "no task.completed after cancellation");
});

// ---------------------------------------------------------------------------
// FG-676: the AWN-2 race on the GATE side of finalizePrimary.
//
// The `none`/`auto` branch has been CAS'd since AWN-2 — a concurrent terminal
// transition wins and the finalizer reports the row's actual status. The `human`
// and `verdict` branches were not: they wrote `awaiting_gate` unconditionally,
// NULLing the error, and then emitted task.awaiting_gate, pushed an operator
// notification and returned "awaiting_gate" regardless. The row said one thing
// and the event stream said another, and the row was a phantom blocker: no agent
// ever runs for it, and no gate decision resolves it.
//
// So the CAS alone is not the fix — its BOOLEAN is. These two tests assert the
// three records AGREE when a terminal transition wins the race: the stored
// status, the status finalizePrimary returned (via the wave's step buckets), and
// the events. One test per branch, because they are separate `case`s.
// ---------------------------------------------------------------------------

test("FG-676: a gate: human task failed mid-spawn is NOT resurrected to awaiting_gate — stored status, returned status and events all agree", async () => {
  const { failTask } = await import("./failure-kind.js");
  const { basename } = await import("node:path");
  ensureRuntime();
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  const { runId } = startRun({ workflow: HUMAN_GATE_WORKFLOW, title: "gate-human cas", inputs: { brief: "x" }, projectDir: "/tmp/test-project" });

  // The human decides terminally while the container is still running, then the
  // container returns success. finalizePrimary's `human` branch lands next.
  const cancelMidSpawn: DockerExecFn = async ({ stdoutPath, stderrPath }) => {
    const dir = dirname(stdoutPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    failTask(basename(dir), { runId, kind: "cancelled", error: "cancelled via forge cancel" });
    writeFileSync(join(dir, "result.json"), JSON.stringify({ status: "complete" }));
    writeFileSync(stdoutPath, ""); writeFileSync(stderrPath, "");
    return 0;
  };

  const wave = await runNext({ runId, workflow: HUMAN_GATE_WORKFLOW, dockerExec: cancelMidSpawn });

  const task = tasksForRun(runId).find((t) => t.phase === "needs-review" && t.parentId === undefined)!;
  // (1) THE ROW. Terminal, with the error the human's decision wrote still on it —
  //     markTaskHeldForGate NULLs `error`, so a resurrection is visible here even
  //     if nothing else changed.
  assert.equal(task.status, "failed", "the terminal row must stand — the gate landing may not resurrect it");
  assert.equal(task.error, "cancelled via forge cancel", "and its error is intact, not NULLed by the awaiting_gate write");
  assert.equal(failureKindForTask(task.id), "cancelled", "still recorded as the decision it was");

  // (2) THE RETURNED STATUS, as the wave reports it. `awaiting_gate` here would be
  //     the finalizer telling `forge next` a human owes a decision on a dead row.
  assert.deepEqual(wave.awaitingGate, [], "the step is NOT reported as awaiting a gate decision");
  assert.deepEqual(wave.failedSteps, ["needs-review"], "it is reported as what it is");

  // (3) THE EVENTS.
  const types = eventsForTask(task.id).map((e) => e.eventType);
  assert.ok(types.includes("task.failed"), "task.failed emitted");
  assert.ok(!types.includes("task.awaiting_gate"), "NO awaiting-gate event over a terminal row");
  assert.ok(!types.includes("task.completed"), "and nothing completed it either");
});

test("FG-676: a gate: verdict task failed mid-spawn is NOT resurrected to awaiting_gate — the verdict branch is CAS'd too", async () => {
  const { failTask } = await import("./failure-kind.js");
  const { basename } = await import("node:path");
  ensureRuntime();
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  const { runId } = startRun({ workflow: REDS_AUTH_ALL_PASS_WORKFLOW, title: "gate-verdict cas", inputs: {}, projectDir: "/tmp/test-project" });

  // Only the PRIMARY is decided terminally — the reds run and pass as normal, so
  // finalizePrimary reaches its `verdict` branch exactly as it does on the happy
  // path. A gate rejection is the FG-676 shape; the CAS keys on the terminal
  // status, not on which human verb produced it.
  //
  // The decision has to land from inside a RED's container, not the primary's:
  // dispatchReds writes `awaiting_red` over the primary on its way in, so a
  // decision taken before that would be laundered off the row by a DIFFERENT write
  // and would prove nothing about this branch. Inside a red, the window is the real
  // one — after the last write to the primary, before finalizePrimary lands it.
  const exec = makeRoutingExec([
    {
      matches: (id) => id.startsWith("task-review-"),
      result: { status: "complete", artifact: "the thing" },
    },
    {
      matches: (id) => id.startsWith("task-red-review-"),
      result: { status: "complete", verdict: "pass", confidence: 0.9, findings: [] },
    },
  ]);
  let decided = false;
  const rejectPrimaryMidReds: DockerExecFn = async (opts) => {
    const code = await exec(opts);
    if (basename(dirname(opts.stdoutPath)).startsWith("task-red-review-") && !decided) {
      decided = true;
      const primaryId = tasksForRun(runId).find((t) => t.phase === "review" && t.parentId === undefined)!.id;
      failTask(primaryId, { runId, kind: "gate_rejected", error: "request-changes; superseded" });
    }
    return code;
  };

  const wave = await runNext({ runId, workflow: REDS_AUTH_ALL_PASS_WORKFLOW, dockerExec: rejectPrimaryMidReds });

  const primary = tasksForRun(runId).find((t) => t.phase === "review" && t.parentId === undefined)!;
  assert.equal(primary.status, "failed", "the terminal row must stand");
  assert.equal(primary.error, "request-changes; superseded", "with its rejection rationale still on the row");
  assert.equal(failureKindForTask(primary.id), "gate_rejected", "and still recorded as a gate rejection");

  assert.deepEqual(wave.awaitingGate, [], "the step is NOT reported as awaiting a verdict gate decision");
  assert.deepEqual(wave.failedSteps, ["review"], "it is reported as what it is");

  const types = eventsForTask(primary.id).map((e) => e.eventType);
  assert.ok(!types.includes("task.awaiting_gate"), "NO awaiting-gate event over a terminal row");
  assert.ok(!types.includes("task.completed"), "and nothing completed it either");
});

// ---------------------------------------------------------------------------
// FG-676: the SAME laundering, one write earlier — through `awaiting_red`.
//
// The CAS on markTaskHeldForGate is only a guard while the row it reads is still
// terminal. runRedsAgainst's `setTaskStatus(taskId, "awaiting_red")` was a bare
// UPDATE, so a decision taken BEFORE the reds dispatch was moved off terminal by
// that write; the CAS then passed over `awaiting_red` and finalizePrimary
// resurrected the task, NULLed its error and emitted task.awaiting_gate. The window
// is reachable: `forge cancel` takes the run lock with { steal: true }.
//
// So the guard has to be at the writer. The test decides the primary from INSIDE
// its own container — before the awaiting_red write, which is the case the verdict
// test above deliberately could NOT cover.
// ---------------------------------------------------------------------------

test("FG-676: a task decided before its reds dispatch is NOT laundered off terminal through awaiting_red", async () => {
  const { failTask } = await import("./failure-kind.js");
  const { basename } = await import("node:path");
  ensureRuntime();
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  const { runId } = startRun({ workflow: REDS_AUTH_ALL_PASS_WORKFLOW, title: "awaiting_red laundering", inputs: {}, projectDir: "/tmp/test-project" });

  // The human rejects at the gate while the primary's container is still running —
  // the row is terminal by the time the container returns and the reds are about to
  // be dispatched.
  const rejectMidSpawn: DockerExecFn = async ({ stdoutPath, stderrPath }) => {
    const dir = dirname(stdoutPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const id = basename(dir);
    if (id.startsWith("task-review-")) {
      failTask(id, { runId, kind: "gate_rejected", error: "request-changes; superseded" });
    }
    writeFileSync(join(dir, "result.json"), JSON.stringify({ status: "complete", verdict: "pass", confidence: 0.9, findings: [] }));
    writeFileSync(stdoutPath, ""); writeFileSync(stderrPath, "");
    return 0;
  };

  const wave = await runNext({ runId, workflow: REDS_AUTH_ALL_PASS_WORKFLOW, dockerExec: rejectMidSpawn });

  const primary = tasksForRun(runId).find((t) => t.phase === "review" && t.parentId === undefined)!;
  // (1) THE ROW — the whole point. `awaiting_gate` here is the phantom blocker.
  assert.equal(primary.status, "failed", "the decided row stays terminal — awaiting_red may not move it");
  assert.equal(primary.error, "request-changes; superseded", "with its rejection rationale intact, not NULLed");
  assert.equal(failureKindForTask(primary.id), "gate_rejected");

  // (2) THE EVENTS agree with it: nothing announced a transition that never happened.
  const types = eventsForTask(primary.id).map((e) => e.eventType);
  assert.ok(!types.includes("task.awaiting_red"), "no awaiting-red event over a terminal row");
  assert.ok(!types.includes("task.awaiting_gate"), "and therefore no resurrection to awaiting_gate");
  assert.ok(!types.includes("task.completed"), "and nothing completed it");

  // (3) NO REDS. Spending a red container on a task a human already decided is the
  //     visible symptom of the same laundering.
  assert.deepEqual(
    tasksForRun(runId).filter((t) => t.parentId === primary.id).map((t) => t.id),
    [],
    "no red was dispatched against a decided task",
  );

  // (4) THE RETURNED STATUS.
  assert.deepEqual(wave.awaitingGate, [], "the step is NOT reported as awaiting a gate decision");
  assert.deepEqual(wave.failedSteps, ["review"], "it is reported as what it is");
});

// ---------------------------------------------------------------------------
// forge-site regression: reds aren't fed the artifact, and fanout build reds
// never dispatch. Three independent gaps in the v2 red-feed path.
// ---------------------------------------------------------------------------

const FANOUT_REDS_WORKFLOW: Workflow = {
  name: "test-fanout-reds",
  description: "build fanout with authoritative reds on the parent",
  review_mode: "legacy_verdict",
  inputs: [],
  steps: [
    { id: "plan", agent: "planner", gate: "auto", manual: false, depends_on: [], runtime: "claude", reds: [] },
    {
      id: "build",
      agent: "engineer",
      gate: "verdict",
      manual: false,
      depends_on: ["plan"],
      runtime: "claude",
      reds: [
        { agent: "red-wide", authority: "authoritative", gate_on_verdict: true },
        { agent: "red-narrow", authority: "authoritative", gate_on_verdict: true },
      ],
      fanout: {
        from_upstream: { step: "plan", array_key: "steps", input_key: "step" },
        max_concurrency: 2,
        failure_mode: "fail-phase",
      },
    },
  ],
};

test("runNext: fanout reds — build fanout dispatches authoritative reds on the parent (forge-site Symptom B)", async () => {
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  const { runId } = startRun({ workflow: FANOUT_REDS_WORKFLOW, title: "fanout reds", inputs: {}, projectDir: "/tmp/test-project" });
  const exec = makeRoutingExec([
    { matches: (id) => id.startsWith("task-plan-"), result: { status: "complete", steps: ["s1", "s2"] } },
    { matches: (id) => id.startsWith("task-red-build-"), result: { status: "complete", verdict: "pass", confidence: 0.9, findings: [] } },
    // FG-524 contract: implementer fanout children report validation so reds dispatch.
    { matches: (id) => id.startsWith("task-build-"), result: { status: "complete", tests_run: 1, diff_summary: "did the thing", files_modified: [] } },
  ]);
  await runNext({ runId, workflow: FANOUT_REDS_WORKFLOW, dockerExec: exec });
  await runNext({ runId, workflow: FANOUT_REDS_WORKFLOW, dockerExec: exec });

  const tasks = tasksForRun(runId);
  const parent = tasks.find((t) => t.phase === "build" && t.parentId === undefined)!;
  const reds = tasks.filter((t) => t.parentId === parent.id && t.agentRole.startsWith("red-"));
  assert.equal(reds.length, 2, "build fanout must dispatch 2 reds on the parent (was 0 — the bug)");
  assert.ok(reds.every((t) => t.status === "complete"));
  assert.equal(parent.status, "awaiting_gate", "verdict gate + all reds pass → awaiting_gate");
  assert.equal(verdictsForTask(parent.id).length, 2, "verdicts recorded for the fanout parent");
});

test("runNext: fanout reds — an authoritative red fail blocks the fanout parent (forge-site Symptom B)", async () => {
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  const { runId } = startRun({ workflow: FANOUT_REDS_WORKFLOW, title: "fanout reds fail", inputs: {}, projectDir: "/tmp/test-project" });
  const exec = makeRoutingExec([
    { matches: (id) => id.startsWith("task-plan-"), result: { status: "complete", steps: ["s1"] } },
    { matches: (id) => id.startsWith("task-red-build-"), result: { status: "complete", verdict: "fail", confidence: 0.9, findings: [{ severity: "high", summary: "broken", evidence: "x" }] } },
    // FG-524 contract: implementer fanout children report validation so red failure remains authoritative.
    { matches: (id) => id.startsWith("task-build-"), result: { status: "complete", tests_run: 1, diff_summary: "did the thing", files_modified: [] } },
  ]);
  await runNext({ runId, workflow: FANOUT_REDS_WORKFLOW, dockerExec: exec });
  await runNext({ runId, workflow: FANOUT_REDS_WORKFLOW, dockerExec: exec });

  const parent = tasksForRun(runId).find((t) => t.phase === "build" && t.parentId === undefined)!;
  assert.equal(parent.status, "blocked_by_red", "an authoritative red fail must block the fanout parent, not silently awaiting_gate");
});

test("runNext: reds receive the artifact in their package (forge-site Symptom A — artifact)", async () => {
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  const { runId } = startRun({ workflow: REDS_AUTH_ALL_PASS_WORKFLOW, title: "red artifact", inputs: {}, projectDir: "/tmp/test-project" });
  const exec = makeRoutingExec([
    { matches: (id) => id.startsWith("task-review-"), result: { status: "complete", artifact: "the-reviewed-thing" } },
    { matches: (id) => id.startsWith("task-red-review-"), result: { status: "complete", verdict: "pass", confidence: 0.9, findings: [] } },
  ]);
  await runNext({ runId, workflow: REDS_AUTH_ALL_PASS_WORKFLOW, dockerExec: exec });

  const tasks = tasksForRun(runId);
  const primary = tasks.find((t) => t.parentId === undefined)!;
  const red = tasks.find((t) => t.parentId === primary.id)!;
  const pkg = readFileSync(join(taskDir(runId, red.id), "package.md"), "utf8");
  assert.match(pkg, /## Artifact under review/, "red package must include the artifact section");
  assert.match(pkg, /the-reviewed-thing/, "red package must contain the primary's result.json");
  assert.ok(
    Array.isArray((red.taskPackage.inputs as Record<string, unknown>).failureModes),
    "failureModes input present (inputs no longer empty {})",
  );
});

test("runNext: reds receive force-level anti-prompts as failureModes (forge-site Symptom A — failureModes)", async () => {
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  const cdir = join(process.env.FORGE_HOME as string, "constraints");
  mkdirSync(cdir, { recursive: true });
  const cfile = join(cdir, "zz-test-antiprompt.md");
  writeFileSync(
    cfile,
    ["---", "id: zz-test-antiprompt", "level: force", "roles: []", "workflows: []", 'antiPrompt: "Demonstrate the artifact is broken"', "---", "", "body", ""].join("\n"),
  );
  try {
    const { runId } = startRun({ workflow: REDS_AUTH_ALL_PASS_WORKFLOW, title: "red failuremodes", inputs: {}, projectDir: "/tmp/test-project" });
    const exec = makeRoutingExec([
      { matches: (id) => id.startsWith("task-review-"), result: { status: "complete", artifact: "x" } },
      { matches: (id) => id.startsWith("task-red-review-"), result: { status: "complete", verdict: "pass", confidence: 0.9, findings: [] } },
    ]);
    await runNext({ runId, workflow: REDS_AUTH_ALL_PASS_WORKFLOW, dockerExec: exec });
    const tasks = tasksForRun(runId);
    const primary = tasks.find((t) => t.parentId === undefined)!;
    const red = tasks.find((t) => t.parentId === primary.id)!;
    const fm = (red.taskPackage.inputs as Record<string, unknown>).failureModes as string[];
    assert.ok(fm.includes("Demonstrate the artifact is broken"), "force-level antiPrompt fed to the red as a failureMode");
  } finally {
    rmSync(cfile, { force: true });
  }
});

// ── #264: pi attribution on the WORKFLOW/runNext path (mirrors invoke.integration.test.ts) ─
const PI_ATTR_WORKFLOW: Workflow = {
  name: "test-pi-attr",
  description: "single pi step",
  review_mode: "legacy_verdict",
  inputs: [{ name: "brief", required: true, type: "text" }],
  steps: [
    { id: "pi-step", agent: "test-agent", gate: "auto", manual: false, depends_on: [], runtime: "pi-stub", reds: [] },
  ],
};

function ensurePiRuntime(): void {
  const fhome = process.env.FORGE_HOME!;
  const p = join(fhome, "runtimes", "pi-stub.yml");
  if (!existsSync(p)) {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, `name: pi-stub
description: test stub pi runtime
runtime_kind: pi
log_format: pi-jsonl
prompt_strategy: message-arg
auth_strategy: env-provider-api-key
image: test-image:latest
models:
  default: test-model
auth:
  mode: apikey
mounts:
  - { host: "\${TASK_DIR}", container: /task }
invocation:
  command: pi
  args: ["-p"]
container:
  name: "forge-\${TASK_ID}"
result:
  file: /task/result.json
`);
  }
  // FG-583: publish the flat runtime as a complete generation so dispatch resolves it.
  publishFlatAsGeneration(fhome);
}

// Exec that writes pi JSONL to stdout but NO result.json (pi exits 0 on error).
function makePiNoResultExec(stdoutJsonl: string, exitCode = 0): DockerExecFn {
  return async ({ stdoutPath, stderrPath }) => {
    const dir = dirname(stdoutPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(stdoutPath, stdoutJsonl);
    writeFileSync(stderrPath, "");
    return exitCode;
  };
}

test("runNext: #264 pi step with no result.json fails with an attributed error, not no_result_json", async () => {
  ensurePiRuntime();
  const prevKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  try {
    const { runId } = startRun({
      workflow: PI_ATTR_WORKFLOW,
      title: "pi attribution test",
      inputs: { brief: "x" },
      projectDir: "/tmp/test-project",
    });
    const stdout =
      JSON.stringify({ type: "agent_start" }) + "\n" +
      JSON.stringify({ type: "agent_end", messages: [
        { role: "assistant", stopReason: "error", errorMessage: "401 authentication_error: invalid x-api-key" },
      ] }) + "\n";

    const wave = await runNext({ runId, workflow: PI_ATTR_WORKFLOW, dockerExec: makePiNoResultExec(stdout) });
    assert.deepEqual(wave.failedSteps, ["pi-step"]);

    const task = tasksForRun(runId).find((t) => t.phase === "pi-step")!;
    assert.equal(task.status, "failed");
    assert.match(task.error ?? "", /pi run failed:/);
    assert.match(task.error ?? "", /authentication_error/);
    assert.doesNotMatch(task.error ?? "", /^no_result_json$/);
    // #267: the workflow path classifies a pi provider error as model_error too
    // (parity with the direct invoke path — guards against drift).
    assert.equal(failureKindForTask(task.id), "model_error");
  } finally {
    if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prevKey;
  }
});

// #265: full-path integration — a pi profile must thread the resolved UPSTREAM
// provider all the way through runNext -> SpawnContext -> buildDockerArgs into
// pi's `--provider` arg (the spawn unit test builds SpawnContext by hand; this
// proves runNext actually wires resolution.provider into it).
const PI_UPSTREAM_WORKFLOW: Workflow = {
  name: "test-pi-upstream",
  description: "single pi step resolved via model-policy",
  review_mode: "legacy_verdict",
  inputs: [{ name: "brief", required: true, type: "text" }],
  steps: [
    { id: "pi-step", agent: "test-agent", gate: "auto", manual: false, depends_on: [], runtime: "pi-stub", reds: [] },
  ],
};

test("runNext: a pi profile threads the resolved upstream provider into pi's --provider (#265)", async () => {
  const policyPath = join(process.env.FORGE_HOME!, "model-policy.yml");
  const runtimePath = join(process.env.FORGE_HOME!, "runtimes", "pi-upstream-stub.yml");
  // #303: groq/api is now probeable, so the availability gate requires a key —
  // set GROQ_API_KEY so the run reaches dispatch (this test asserts --provider
  // threading, not the key gate, which is covered in provider-doctor/invoke tests).
  const savedGroq = process.env.GROQ_API_KEY;
  process.env.GROQ_API_KEY = "gsk-test";
  writeFileSync(policyPath, `
on_unavailable: fail
schema_version: 2
model_profiles:
  pi-groq:
    provider: groq
    auth: api
    runtime: pi-upstream-stub
    map:
      default: { model: llama-3.3-70b-versatile, cost_tier: cheap, tool_capable: true }
defaults:
  profile: pi-groq
  activity: {}
allowed_profiles: [pi-groq]
`);
  mkdirSync(dirname(runtimePath), { recursive: true });
  writeFileSync(runtimePath, `name: pi-upstream-stub
description: test stub pi runtime with --provider threading
runtime_kind: pi
log_format: pi-jsonl
prompt_strategy: message-arg
auth_strategy: env-provider-api-key
image: test-image:latest
models:
  default: test-model
auth:
  mode: oauth-volume
mounts:
  - { host: "\${TASK_DIR}", container: /task }
invocation:
  command: pi
  args: ["-p", "--provider", "\${UPSTREAM_PROVIDER:-anthropic}", "--model", "\${MODEL}"]
container:
  name: "forge-\${TASK_ID}"
result:
  file: /task/result.json
`);
  // FG-583: publish the flat runtimes as a complete generation so dispatch resolves them.
  publishFlatAsGeneration(process.env.FORGE_HOME!);

  try {
    const { runId } = startRun({
      workflow: PI_UPSTREAM_WORKFLOW,
      title: "pi upstream threading",
      inputs: { brief: "x" },
      projectDir: "/tmp/test-project",
    });

    let captured: string[] | undefined;
    const capturingExec: DockerExecFn = async ({ args }) => { captured = args; return 0; };
    await runNext({ runId, workflow: PI_UPSTREAM_WORKFLOW, dockerExec: capturingExec });

    assert.ok(captured, "dockerExec should have been invoked");
    const provIdx = captured!.indexOf("--provider");
    assert.ok(provIdx >= 0, "docker args must contain --provider");
    assert.equal(captured![provIdx + 1], "groq"); // resolved upstream, not the :- fallback
    const modelIdx = captured!.indexOf("--model");
    assert.equal(captured![modelIdx + 1], "llama-3.3-70b-versatile");
  } finally {
    rmSync(policyPath, { force: true });
    rmSync(runtimePath, { force: true });
    if (savedGroq === undefined) delete process.env.GROQ_API_KEY;
    else process.env.GROQ_API_KEY = savedGroq;
  }
});

// ── FG-337: inferred-result fallback on the runNext/workflow path ─────────────

const FG337_NARRATIVE_WORKFLOW: Workflow = {
  name: "test-fg337-narrative",
  description: "single narrative pi step",
  review_mode: "legacy_verdict",
  inputs: [{ name: "brief", required: true, type: "text" }],
  steps: [
    { id: "research-step", agent: "research-specialist", gate: "auto", manual: false, depends_on: [], runtime: "pi-stub", reds: [] },
  ],
};

const FG337_STRUCTURED_WORKFLOW: Workflow = {
  name: "test-fg337-structured",
  description: "single structured pi step",
  review_mode: "legacy_verdict",
  inputs: [{ name: "brief", required: true, type: "text" }],
  steps: [
    { id: "engineer-step", agent: "engineer", gate: "auto", manual: false, depends_on: [], runtime: "pi-stub", reds: [] },
  ],
};

test("runNext FG-337: narrative role completes via inferred result when pi exits cleanly with assistant text", async () => {
  ensurePiRuntime();
  const prevKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  try {
    const { runId } = startRun({
      workflow: FG337_NARRATIVE_WORKFLOW,
      title: "fg337 narrative",
      inputs: { brief: "x" },
      projectDir: "/tmp/test-project",
    });
    const stdout =
      JSON.stringify({ type: "agent_end", messages: [{ role: "assistant", stopReason: "end_turn", content: "Paris is the capital of France." }] }) + "\n";

    const wave = await runNext({ runId, workflow: FG337_NARRATIVE_WORKFLOW, dockerExec: makePiNoResultExec(stdout) });
    assert.deepEqual(wave.completedSteps, ["research-step"]);
    assert.deepEqual(wave.failedSteps, []);

    const task = tasksForRun(runId).find((t) => t.phase === "research-step")!;
    assert.equal(task.status, "complete");
    const result = task.result as { contract: string; summary: string; status: string } | undefined;
    assert.equal(result?.contract, "inferred");
    assert.equal(result?.summary, "Paris is the capital of France.");
  } finally {
    if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prevKey;
  }
});

test("runNext FG-337: structured role (engineer) still hard-fails even with pi clean completion + text", async () => {
  ensurePiRuntime();
  const prevKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  try {
    const { runId } = startRun({
      workflow: FG337_STRUCTURED_WORKFLOW,
      title: "fg337 structured",
      inputs: { brief: "x" },
      projectDir: "/tmp/test-project",
    });
    const stdout =
      JSON.stringify({ type: "agent_end", messages: [{ role: "assistant", stopReason: "end_turn", content: "I did the work." }] }) + "\n";

    const wave = await runNext({ runId, workflow: FG337_STRUCTURED_WORKFLOW, dockerExec: makePiNoResultExec(stdout) });
    assert.deepEqual(wave.failedSteps, ["engineer-step"]);

    const task = tasksForRun(runId).find((t) => t.phase === "engineer-step")!;
    assert.equal(task.status, "failed");
    assert.match(task.error ?? "", /completed but wrote no .*result\.json/);
  } finally {
    if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prevKey;
  }
});

test("runNext FG-337: truncated pi run (no agent_end) still fails even for narrative role", async () => {
  ensurePiRuntime();
  const prevKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  try {
    const { runId } = startRun({
      workflow: FG337_NARRATIVE_WORKFLOW,
      title: "fg337 truncated",
      inputs: { brief: "x" },
      projectDir: "/tmp/test-project",
    });
    const stdout = JSON.stringify({ type: "agent_start" }) + "\n";

    const wave = await runNext({ runId, workflow: FG337_NARRATIVE_WORKFLOW, dockerExec: makePiNoResultExec(stdout) });
    assert.deepEqual(wave.failedSteps, ["research-step"]);

    const task = tasksForRun(runId).find((t) => t.phase === "research-step")!;
    assert.equal(task.status, "failed");
    assert.match(task.error ?? "", /no completion event/);
  } finally {
    if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prevKey;
  }
});

test("runNext FG-337: pi model error still fails for narrative role (not inferrable)", async () => {
  ensurePiRuntime();
  const prevKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  try {
    const { runId } = startRun({
      workflow: FG337_NARRATIVE_WORKFLOW,
      title: "fg337 model error",
      inputs: { brief: "x" },
      projectDir: "/tmp/test-project",
    });
    const stdout =
      JSON.stringify({ type: "agent_end", messages: [{ role: "assistant", errorMessage: "401 invalid api key" }] }) + "\n";

    const wave = await runNext({ runId, workflow: FG337_NARRATIVE_WORKFLOW, dockerExec: makePiNoResultExec(stdout) });
    assert.deepEqual(wave.failedSteps, ["research-step"]);

    const task = tasksForRun(runId).find((t) => t.phase === "research-step")!;
    assert.equal(task.status, "failed");
    assert.match(task.error ?? "", /pi run failed/);
    assert.equal(failureKindForTask(task.id), "model_error");
  } finally {
    if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prevKey;
  }
});

// ---------------------------------------------------------------------------
// FG-475: campaign resume hang — a full_feature run driven to terminal-failed
// via a gate reject with no on_reject used to leave run.status stuck "active"
// forever. computeReadyQueue correctly returns [] (nothing is dispatchable),
// but nothing ever re-evaluated whether the run was actually DONE (settled)
// vs. just quiet. isRunSettled (ready-queue.ts) closes that gap; these tests
// reproduce the exact hang shape end-to-end and prove a single call resolves it.
// ---------------------------------------------------------------------------

test("runNext: FG-475 a step already terminally failed with no pending replacement — a single runNext() call settles the run via the ready.length===0 early-return path (the reported hang shape)", async () => {
  const { insertTask } = await import("../store/tasks.js");
  const { runId } = startRun({
    workflow: LINEAR_WORKFLOW,
    title: "fg475 hang shape test",
    inputs: { brief: "x" },
    projectDir: "/tmp/test-project",
  });

  // Simulate the post-gate-reject state directly (mirrors what gate.ts's reject
  // branch leaves behind when a step has no on_reject): 'first' has a terminally
  // failed primary and zero pending replacements. computeReadyQueue reports []
  // immediately — 'second' can never become ready ('first' never completes) —
  // which is exactly the shape that hung: zero I/O, run.status never leaves
  // "active" no matter how many times runNext is called.
  insertTask({
    id: "task-first-rejected",
    runId,
    phase: "first",
    agentRole: "test-agent",
    status: "failed",
    error: "rejected by gate",
    taskPackage: {
      taskId: "task-first-rejected",
      runId,
      phase: "first",
      role: "test-agent",
      inputs: {},
      composedSystemPrompt: "",
    },
    createdAt: new Date().toISOString(),
  });

  const throwingExec: DockerExecFn = async () => {
    throw new Error("nothing should be dispatched — the ready queue must be empty");
  };

  const wave = await runNext({ runId, workflow: LINEAR_WORKFLOW, dockerExec: throwingExec });

  assert.deepEqual(wave.dispatchedSteps, [], "ready queue is empty on entry — this exercises the early-return path, not a dispatch wave");
  // FG-585: settling now tells the truth — 'first' failed with no replacement and
  // 'second' can never dispatch, so the run settles to `failed` (not a false
  // `complete`). The FG-475 guarantee — a SINGLE call settles it, no hang — holds.
  assert.equal(
    wave.runStatus,
    "failed",
    "a SINGLE runNext() call must settle the run — no hang, no manual process kill, no follow-up call required",
  );
  assert.deepEqual(wave.terminal!.failedPhases, ["first"]);
  assert.deepEqual(wave.terminal!.unreachablePhases, ["second"]);

  const run = getRun(runId);
  assert.equal(run!.status, "failed");
});

test("runNext: FG-475 empty-ready-queue-but-awaiting-gate is still NOT settled (regression guard — human/verdict gates must not be swept up by the new settled check)", async () => {
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  const { runId } = startRun({
    workflow: HUMAN_GATE_WORKFLOW,
    title: "fg475 awaiting-gate not settled test",
    inputs: { brief: "x" },
    projectDir: "/tmp/test-project",
  });
  const stub = makeStubExec({ status: "complete" });
  await runNext({ runId, workflow: HUMAN_GATE_WORKFLOW, dockerExec: stub });

  const task = tasksForRun(runId).find((t) => t.phase === "needs-review")!;
  assert.equal(task.status, "awaiting_gate");

  // Second call: ready queue is empty (nothing dispatchable while awaiting a
  // human gate) — must stay "active", not be swept into "complete" by the new
  // settled check. A human decision is still outstanding, not a permanently
  // unreachable step.
  const wave = await runNext({ runId, workflow: HUMAN_GATE_WORKFLOW, dockerExec: stub });
  assert.deepEqual(wave.dispatchedSteps, []);
  assert.equal(wave.runStatus, "active");

  const run = getRun(runId);
  assert.equal(run!.status, "active");
});

// FG-475 review Finding 2 (AWN-2 cancel-vs-completion race, zero-ready settled
// path): the ready.length===0 && isRunSettled(...) early-return used to call
// updateRunStatus(runId, "complete") without re-reading the run's current
// status, unlike the later post-dispatch completion path (which already re-reads
// via getRun before flipping to complete). A concurrent `forge cancel` racing
// between the getRun at the top of runNext and this write could resurrect an
// abandoned run back to complete. Mirrors the existing resurrection-prevention
// pattern (cancel.integration.test.ts's "cancelled run cannot be resurrected"
// test): drive the run to abandoned, then call runNext, and assert it is never
// flipped back to complete.
test("runNext: AWN-2 — an abandoned run in the settled/zero-ready shape must not be resurrected to complete", async () => {
  const { insertTask } = await import("../store/tasks.js");
  const { runId } = startRun({
    workflow: LINEAR_WORKFLOW,
    title: "fg475 awn-2 settled-path cancel race test",
    inputs: { brief: "x" },
    projectDir: "/tmp/test-project",
  });

  // Same settled-zero-ready shape as the FG-475 hang-shape test above: 'first'
  // has a terminally failed primary with no pending replacement, so
  // computeReadyQueue returns [] and isRunSettled is true — this run would
  // otherwise be a candidate for the ready.length===0 early-return completion.
  insertTask({
    id: "task-first-rejected-awn2",
    runId,
    phase: "first",
    agentRole: "test-agent",
    status: "failed",
    error: "rejected by gate",
    taskPackage: {
      taskId: "task-first-rejected-awn2",
      runId,
      phase: "first",
      role: "test-agent",
      inputs: {},
      composedSystemPrompt: "",
    },
    createdAt: new Date().toISOString(),
  });

  // A concurrent `forge cancel` wins the race: by the time this runNext call
  // happens, the run is already abandoned.
  updateRunStatus(runId, "abandoned");

  const throwingExec: DockerExecFn = async () => {
    throw new Error("nothing should be dispatched — the run is abandoned");
  };

  const wave = await runNext({ runId, workflow: LINEAR_WORKFLOW, dockerExec: throwingExec });

  assert.equal(
    wave.runStatus,
    "abandoned",
    "AWN-2: an abandoned run settled with zero ready steps must not be resurrected to complete",
  );

  const run = getRun(runId);
  assert.equal(run!.status, "abandoned", "run must stay abandoned in the DB, never flipped to complete");

  const events = eventsForRun(runId).map((e) => e.eventType);
  assert.ok(!events.includes("run.completed"), "run.completed must never fire for an abandoned run via the settled-path early return");
});

// FG-484: gate.ts's finalizeRunIfDone used to call updateRunStatus(runId,
// "complete") with no re-read at all — unlike the AWN-2 sites above. A
// concurrent `forge cancel` landing between the human's gate decision and
// finalizeRunIfDone's write could resurrect an abandoned run back to
// complete. Mirrors the AWN-2 test above but drives the completion through
// gate() (the human-gate path), not runNext(), and additionally proves no
// completion notification fires for the refused write.
//
// SYNTHETIC / store-level guard test — NOT a reachable real-cancel state.
// This primes the task at "awaiting_gate" (untouched) while the run is
// already "abandoned"; today's real `forge cancel` (cli/commands/cancel.ts)
// always fails every non-terminal task BEFORE marking the run abandoned, so
// a real cancel could never leave this exact combination. It's kept anyway
// because it is the only way to drive gate()'s internal task-complete write
// all the way through to finalizeRunIfDone/completeRun's CAS (a cancel that
// goes through cancel.ts's real fail-then-abandon sequence would instead
// fail this very task, and gate()'s own `status !== "awaiting_gate"` guard
// would then throw before ever reaching the CAS — see the realistic variant
// below, which proves that path). This test is the direct proof that the
// store-layer CAS itself refuses the resurrection, independent of gate.ts's
// upfront guard — defense-in-depth for any future caller that reaches
// finalizeRunIfDone without that guard in front of it.
test("gate: FG-484 (synthetic store-level guard) — gate-path finalize interleaved with a concurrent cancel must not resurrect the run to complete", async () => {
  const { gate } = await import("./gate.js");
  process.env.ANTHROPIC_API_KEY = "sk-stub";

  const forgeHome = process.env.FORGE_HOME!;
  const wfName = "fg484-gate-finalize-cancel-race-test";
  const wfPath = join(forgeHome, "workflows", `${wfName}.yml`);
  mkdirSync(dirname(wfPath), { recursive: true });
  writeFileSync(
    wfPath,
    `name: ${wfName}
description: FG-484 gate-path finalize vs. concurrent cancel regression test
inputs: []
steps:
  - id: needs-review
    agent: test-agent
    gate: human
    manual: false
    depends_on: []
    runtime: claude
    reds: []
`,
  );
  // FG-583: publish so gate()'s load-by-name resolves this workflow from the generation.
  publishFlatAsGeneration(forgeHome);
  const wf: Workflow = {
    name: wfName,
    description: "FG-484 gate-path finalize vs. concurrent cancel regression test",
    review_mode: "legacy_verdict",
    inputs: [],
    steps: [
      { id: "needs-review", agent: "test-agent", gate: "human", manual: false, depends_on: [], runtime: "claude", reds: [] },
    ],
  };

  const { runId } = startRun({
    workflow: wf,
    title: "fg484 gate-path cancel race test",
    inputs: { brief: "x" },
    projectDir: "/tmp/test-project",
  });

  const stub = makeStubExec({ status: "complete" });
  await runNext({ runId, workflow: wf, dockerExec: stub });

  const task = tasksForRun(runId).find((t) => t.phase === "needs-review")!;
  assert.equal(task.status, "awaiting_gate");

  // A concurrent `forge cancel` wins the race: by the time the human's gate
  // decision lands, the run is already abandoned.
  updateRunStatus(runId, "abandoned");

  // Enable a notification provider + mock fetch so "no completion
  // notification fires" is actually provable — under the suite's default
  // NO_NOTIFY=true, notifyOnRunTransition short-circuits either way,
  // silently. Mirrors store/runs.test.ts's withNtfyEnabledAndFetchMocked.
  const NOTIFY_ENV_KEYS = ["FORGE_NOTIFY", "NTFY_URL", "NTFY_TOKEN", "NTFY_PRIORITY", "NO_NOTIFY"];
  const saved: Record<string, string | undefined> = {};
  for (const k of NOTIFY_ENV_KEYS) saved[k] = process.env[k];
  process.env["FORGE_NOTIFY"] = "ntfy";
  process.env["NTFY_URL"] = "https://ntfy.example.invalid/forge-test";
  delete process.env["NO_NOTIFY"];
  const fetchMock = mock.method(globalThis, "fetch", async () => new Response("", { status: 200 }));

  try {
    await gate(task.id, "advance", undefined);
  } finally {
    fetchMock.mock.restore();
    for (const k of NOTIFY_ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }

  // notifyOnRunTransition is fired async/fire-and-forget when it does fire;
  // flush the microtask queue before asserting its absence.
  await new Promise((r) => setImmediate(r));

  const run = getRun(runId);
  assert.equal(
    run!.status,
    "abandoned",
    "FG-484: the run must stay abandoned — gate-path finalize must not resurrect it to complete",
  );

  const events = eventsForRun(runId).map((e) => e.eventType);
  assert.ok(
    !events.includes("run.completed"),
    "FG-484: no run.completed event may fire for an abandoned run via the gate path",
  );
  assert.equal(
    fetchMock.mock.calls.length,
    0,
    "FG-484: no completion notification may fire for a refused gate-path finalize",
  );
});

// FG-484 realistic variant: drives the SAME race through the real
// `forge cancel` semantics (src/cli/commands/cancel.ts's performCancel)
// instead of directly abandoning the run underneath an untouched task. Real
// cancel always fails every non-terminal task BEFORE marking the run
// abandoned, so by the time the human's stale gate() call lands, the task is
// no longer "awaiting_gate" — gate()'s own status guard refuses it outright.
// This is the reachable real-world shape: the run stays abandoned, no
// run.completed fires, no notification fires — proven end to end through the
// real cancel + real gate code paths, not by hand-priming an impossible DB
// state (see the synthetic test above for the direct store-CAS proof).
test("gate: FG-484 realistic — a real `forge cancel` (fails the awaiting task, then abandons the run) leaves a stale gate() advance unable to resurrect the run", async () => {
  const { gate } = await import("./gate.js");
  const { performCancel } = await import("../cli/commands/cancel.js");
  process.env.ANTHROPIC_API_KEY = "sk-stub";

  const forgeHome = process.env.FORGE_HOME!;
  const wfName = "fg484-gate-realcancel-race-test";
  const wfPath = join(forgeHome, "workflows", `${wfName}.yml`);
  mkdirSync(dirname(wfPath), { recursive: true });
  writeFileSync(
    wfPath,
    `name: ${wfName}
description: FG-484 realistic gate-path finalize vs. real forge-cancel regression test
inputs: []
steps:
  - id: needs-review
    agent: test-agent
    gate: human
    manual: false
    depends_on: []
    runtime: claude
    reds: []
`,
  );
  // FG-583: publish so gate()'s load-by-name resolves this workflow from the generation.
  publishFlatAsGeneration(forgeHome);
  const wf: Workflow = {
    name: wfName,
    description: "FG-484 realistic gate-path finalize vs. real forge-cancel regression test",
    review_mode: "legacy_verdict",
    inputs: [],
    steps: [
      { id: "needs-review", agent: "test-agent", gate: "human", manual: false, depends_on: [], runtime: "claude", reds: [] },
    ],
  };

  const { runId } = startRun({
    workflow: wf,
    title: "fg484 gate-path real-cancel race test",
    inputs: { brief: "x" },
    projectDir: "/tmp/test-project",
  });

  const stub = makeStubExec({ status: "complete" });
  await runNext({ runId, workflow: wf, dockerExec: stub });

  const task = tasksForRun(runId).find((t) => t.phase === "needs-review")!;
  assert.equal(task.status, "awaiting_gate");

  // The real concurrent `forge cancel --abandon-run`, wins the race for real:
  // it fails the still-awaiting task, then (no non-terminal tasks remaining)
  // marks the run abandoned.
  performCancel(runId, { abandonRun: true }, () => { /* no real containers to kill in this test */ });
  assert.equal(getTask(task.id)!.status, "failed", "real cancel must fail the awaiting task before abandoning the run");
  assert.equal(getRun(runId)!.status, "abandoned");

  const NOTIFY_ENV_KEYS = ["FORGE_NOTIFY", "NTFY_URL", "NTFY_TOKEN", "NTFY_PRIORITY", "NO_NOTIFY"];
  const saved: Record<string, string | undefined> = {};
  for (const k of NOTIFY_ENV_KEYS) saved[k] = process.env[k];
  process.env["FORGE_NOTIFY"] = "ntfy";
  process.env["NTFY_URL"] = "https://ntfy.example.invalid/forge-test";
  delete process.env["NO_NOTIFY"];
  const fetchMock = mock.method(globalThis, "fetch", async () => new Response("", { status: 200 }));

  try {
    // The human's gate decision, made against the now-stale in-hand task
    // reference, lands after the real cancel already won — gate() must
    // refuse rather than silently no-op or resurrect anything.
    await assert.rejects(
      () => gate(task.id, "advance", undefined),
      /not awaiting_gate/,
      "gate() must refuse a stale advance on a task the real cancel already failed",
    );
  } finally {
    fetchMock.mock.restore();
    for (const k of NOTIFY_ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }

  await new Promise((r) => setImmediate(r));

  const run = getRun(runId);
  assert.equal(run!.status, "abandoned", "FG-484 realistic: the run must stay abandoned");

  const events = eventsForRun(runId).map((e) => e.eventType);
  assert.ok(!events.includes("run.completed"), "FG-484 realistic: no run.completed event may fire");
  assert.equal(fetchMock.mock.calls.length, 0, "FG-484 realistic: no completion notification may fire");
});

test("gate: FG-475 reject on a step with no on_reject finalizes the run synchronously (parity with the advance branch's finalizeRunIfDone)", async () => {
  const { gate } = await import("./gate.js");
  process.env.ANTHROPIC_API_KEY = "sk-stub";

  // gate.ts loads the workflow from disk by name — write a YAML twin of
  // HUMAN_GATE_WORKFLOW (single step, gate: human, no on_reject) so gate()
  // can resolve it the same way the CLI would.
  const forgeHome = process.env.FORGE_HOME!;
  const wfName = "fg475-gate-reject-no-on-reject-test";
  const wfPath = join(forgeHome, "workflows", `${wfName}.yml`);
  mkdirSync(dirname(wfPath), { recursive: true });
  writeFileSync(
    wfPath,
    `name: ${wfName}
description: FG-475 gate-reject-with-no-on_reject regression test
inputs: []
steps:
  - id: needs-review
    agent: test-agent
    gate: human
    manual: false
    depends_on: []
    runtime: claude
    reds: []
`,
  );
  // FG-583: publish so gate()'s load-by-name resolves this workflow from the generation.
  publishFlatAsGeneration(forgeHome);
  const wf: Workflow = {
    name: wfName,
    description: "FG-475 gate-reject-with-no-on_reject regression test",
    review_mode: "legacy_verdict",
    inputs: [],
    steps: [
      { id: "needs-review", agent: "test-agent", gate: "human", manual: false, depends_on: [], runtime: "claude", reds: [] },
    ],
  };

  const { runId } = startRun({
    workflow: wf,
    title: "fg475 gate reject finalize test",
    inputs: { brief: "x" },
    projectDir: "/tmp/test-project",
  });

  const stub = makeStubExec({ status: "complete" });
  await runNext({ runId, workflow: wf, dockerExec: stub });

  const task = tasksForRun(runId).find((t) => t.phase === "needs-review")!;
  assert.equal(task.status, "awaiting_gate");

  await gate(task.id, "reject", "operator deferring this item");

  // A rejected gate with no on_reject leaves this (only) step terminally
  // failed with no replacement task — parity with the advance branch's
  // finalizeRunIfDone call. The run must reconcile synchronously within the
  // gate() call itself; it must NOT require a follow-up forge next/runNext
  // call (that follow-up call is exactly what hung in campaign-e89beee993ec).
  // FG-585: the only step failed, so the synchronous finalize settles it to
  // `failed`, not a false `complete`.
  const run = getRun(runId);
  assert.equal(run!.status, "failed", "gate(reject) with no on_reject must finalize the run synchronously");

  const rejectedTask = getTask(task.id)!;
  assert.equal(rejectedTask.status, "failed");
});

test("gate: FG-475 reject with on_reject targeting an EARLIER already-complete step keeps the run active until the recovery task actually finishes (security-audit.yml audit->investigate shape)", async () => {
  const { gate } = await import("./gate.js");
  process.env.ANTHROPIC_API_KEY = "sk-stub";

  // Mirrors seeds/workflows/security-audit.yml: 'audit' depends on 'investigate'
  // and its on_reject bounces back to 'investigate' — a step that, by the time
  // 'audit' is gate-rejected, already has a COMPLETE primary from its earlier run.
  const forgeHome = process.env.FORGE_HOME!;
  const wfName = "fg475-gate-reject-on-reject-earlier-complete-test";
  const wfPath = join(forgeHome, "workflows", `${wfName}.yml`);
  mkdirSync(dirname(wfPath), { recursive: true });
  writeFileSync(
    wfPath,
    `name: ${wfName}
description: FG-475 gate-reject with on_reject targeting an earlier complete step
inputs: []
steps:
  - id: investigate
    agent: test-agent
    gate: auto
    manual: false
    depends_on: []
    runtime: claude
    reds: []
  - id: audit
    agent: test-agent
    gate: human
    manual: false
    depends_on: [investigate]
    on_reject: investigate
    runtime: claude
    reds: []
`,
  );
  // FG-583: publish so gate()'s load-by-name resolves this workflow from the generation.
  publishFlatAsGeneration(forgeHome);
  const wf: Workflow = {
    name: wfName,
    description: "FG-475 gate-reject with on_reject targeting an earlier complete step",
    review_mode: "legacy_verdict",
    inputs: [],
    steps: [
      { id: "investigate", agent: "test-agent", gate: "auto", manual: false, depends_on: [], runtime: "claude", reds: [] },
      { id: "audit", agent: "test-agent", gate: "human", manual: false, depends_on: ["investigate"], on_reject: "investigate", runtime: "claude", reds: [] },
    ],
  };

  const { runId } = startRun({
    workflow: wf,
    title: "fg475 on_reject earlier-complete-step test",
    inputs: { brief: "x" },
    projectDir: "/tmp/test-project",
  });

  const stub = makeStubExec({ status: "complete" });

  // Wave 1: 'investigate' auto-completes, leaving a COMPLETE primary in that phase.
  const wave1 = await runNext({ runId, workflow: wf, dockerExec: stub });
  assert.deepEqual(wave1.completedSteps, ["investigate"]);

  // Wave 2: 'audit' dispatches and lands on its human gate.
  const wave2 = await runNext({ runId, workflow: wf, dockerExec: stub });
  assert.deepEqual(wave2.awaitingGate, ["audit"]);

  const auditTask = tasksForRun(runId).find((t) => t.phase === "audit")!;
  assert.equal(auditTask.status, "awaiting_gate");

  await gate(auditTask.id, "reject", "scope was too narrow, re-investigate");

  // (1) The run must NOT be prematurely finalized to "complete" immediately
  // after the reject — the fresh on_reject recovery task landing in the
  // already-complete 'investigate' phase is live outstanding work. Pre-fix,
  // computeStepSettleStates had no notion of this recovery task's lineage and
  // would see 'investigate' as settled purely off its old complete primary,
  // incorrectly finalizing the run right under the freshly-created recovery work.
  const runRightAfterReject = getRun(runId);
  assert.equal(
    runRightAfterReject!.status,
    "active",
    "run must stay active — a live on_reject recovery task in 'investigate' is outstanding work, not settled",
  );

  // (2) The recovery task itself: a fresh pending task in 'investigate', parented
  // to the rejected 'audit' task (lineage, not fanout — it's in a different phase).
  const investigatePhaseTasks = tasksForRun(runId).filter((t) => t.phase === "investigate");
  assert.equal(investigatePhaseTasks.length, 2, "original complete primary + fresh recovery task");
  const recoveryTask = investigatePhaseTasks.find((t) => t.status === "pending");
  assert.ok(recoveryTask, "expected a pending recovery task in the 'investigate' phase");
  assert.equal(recoveryTask!.parentId, auditTask.id, "recovery task is parented to the rejected 'audit' task (lineage)");

  const rejectedAuditTask = getTask(auditTask.id)!;
  assert.equal(rejectedAuditTask.status, "failed");

  // (3) Only once the recovery task ACTUALLY finishes does the run finalize.
  // Simulate the on_reject re-investigation completing (the harness has no
  // stubbed re-dispatch path for a recovery task parented outside its phase's
  // normal ready-queue flow, so drive it directly the way a real completion
  // would land: status -> complete).
  markTaskComplete(recoveryTask!.id, { status: "complete", output: "re-investigated" });

  const throwingExec: DockerExecFn = async () => {
    throw new Error("nothing should be dispatched — 'audit' is terminally failed with no retry, 'investigate' is settled");
  };
  const finalWave = await runNext({ runId, workflow: wf, dockerExec: throwingExec });
  assert.deepEqual(finalWave.dispatchedSteps, []);
  // FG-585: the run finalizes once the recovery task completes — not before.
  // Its terminal state is `failed`: the 'audit' step's only primary was rejected
  // (terminally failed) and never re-dispatches (throwingExec proves it), so the
  // declared 'audit' phase never reached a complete primary. The old evaluator
  // mislabeled this `complete`; that false green is exactly the FG-585 bug.
  assert.equal(
    finalWave.runStatus,
    "failed",
    "run finalizes once the recovery task actually completes — not before",
  );
  assert.deepEqual(finalWave.terminal!.failedPhases, ["audit"]);

  const runAfterRecoveryCompletes = getRun(runId);
  assert.equal(runAfterRecoveryCompletes!.status, "failed");
});

// ----- FG-476: the live on_reject recovery task must actually be dispatchable -----
// FG-475's fix above keeps the run "active" instead of finalizing while a
// recovery task sits pending in an already-complete phase. But nothing made
// that pending task actually DISPATCH — computeReadyQueue skipped its phase
// (complete primary) and dispatchSingleStep's pending-row reuse lookup only
// matched parentId===undefined rows, so the recovery task was permanently
// stuck pending. These tests assert the dispatch-side fix directly.

test("runNext: FG-476 a pending on_reject recovery row in an already-complete phase is dispatched by reusing that exact row, not minting a fresh primary", async () => {
  const { insertTask } = await import("../store/tasks.js");
  const wf: Workflow = {
    name: "test-fg476-recovery-reuse",
    description: "investigate/audit on_reject shape (security-audit.yml twin)",
    review_mode: "legacy_verdict",
    inputs: [],
    steps: [
      { id: "investigate", agent: "test-agent", gate: "auto", manual: false, depends_on: [], runtime: "claude", reds: [] },
      { id: "audit", agent: "test-agent", gate: "human", manual: false, depends_on: ["investigate"], on_reject: "investigate", runtime: "claude", reds: [] },
    ],
  };
  const { runId } = startRun({ workflow: wf, title: "fg476 recovery reuse", inputs: { brief: "x" }, projectDir: "/tmp/test-project" });

  // Post-reject shape: 'investigate' already has a complete primary from its
  // first run; 'audit' was gate-rejected (terminally failed, no replacement);
  // gate.ts's reject->on_reject branch left a fresh pending recovery task
  // parented to the rejected 'audit' task, in the 'investigate' phase.
  insertTask({
    id: "t-investigate-1", runId, phase: "investigate", agentRole: "test-agent", status: "complete",
    taskPackage: { taskId: "t-investigate-1", runId, phase: "investigate", role: "test-agent", inputs: {}, composedSystemPrompt: "" },
    createdAt: new Date().toISOString(),
  });
  insertTask({
    id: "t-audit-1", runId, phase: "audit", agentRole: "test-agent", status: "failed", error: "rejected by gate",
    taskPackage: { taskId: "t-audit-1", runId, phase: "audit", role: "test-agent", inputs: {}, composedSystemPrompt: "" },
    createdAt: new Date().toISOString(),
  });
  insertTask({
    id: "t-investigate-recovery", runId, parentId: "t-audit-1", phase: "investigate", agentRole: "test-agent", status: "pending",
    taskPackage: {
      taskId: "t-investigate-recovery", runId, phase: "investigate", role: "test-agent",
      inputs: { rejectedTaskId: "t-audit-1", rejectedRationale: "scope too narrow, re-investigate" },
      composedSystemPrompt: "",
    },
    createdAt: new Date().toISOString(),
  });

  const stub = makeStubExec({ status: "complete" });
  const wave = await runNext({ runId, workflow: wf, dockerExec: stub });

  assert.deepEqual(
    wave.dispatchedSteps,
    ["investigate"],
    "the recovery task's phase must be picked up by the ready queue and dispatched — this is the core FG-476 regression",
  );

  const investigateTasks = tasksForRun(runId).filter((t) => t.phase === "investigate");
  assert.equal(
    investigateTasks.length,
    2,
    "exactly the original complete primary + the reused recovery row — no third (duplicate parentId=undefined) task minted",
  );

  const recovery = getTask("t-investigate-recovery")!;
  assert.notEqual(recovery.status, "pending", "the recovery task must have actually been dispatched, not left pending");
  assert.equal(
    recovery.parentId,
    "t-audit-1",
    "lineage to the rejected task must be preserved — never rewritten to parentId=undefined",
  );
  assert.equal(recovery.taskPackage.inputs["rejectedTaskId"], "t-audit-1", "rejectedTaskId marker must survive dispatch");
  assert.equal(
    recovery.taskPackage.inputs["rejectedRationale"],
    "scope too narrow, re-investigate",
    "rejectedRationale must survive dispatch",
  );

  // 'audit' itself must never be auto-resubmitted by this fix — recovery re-runs
  // 'investigate', not 'audit'. Its terminally-failed gate-reject row is untouched.
  const auditTask = getTask("t-audit-1")!;
  assert.equal(auditTask.status, "failed", "audit's reject decision must remain the audit trail — never re-run by this fix");
});

test("runNext: FG-476 a fanout/red child (parentId-tagged, no rejectedTaskId marker) in an already-complete phase is never dispatched as a primary", async () => {
  const { insertTask } = await import("../store/tasks.js");
  const wf: Workflow = {
    name: "test-fg476-no-fanout-reuse",
    description: "complete primary + pending red/fanout child, no marker",
    review_mode: "legacy_verdict",
    inputs: [],
    steps: [
      { id: "build", agent: "test-agent", gate: "auto", manual: false, depends_on: [], runtime: "claude", reds: [] },
    ],
  };
  const { runId } = startRun({ workflow: wf, title: "fg476 no fanout reuse", inputs: { brief: "x" }, projectDir: "/tmp/test-project" });

  insertTask({
    id: "t-build-1", runId, phase: "build", agentRole: "test-agent", status: "complete",
    taskPackage: { taskId: "t-build-1", runId, phase: "build", role: "test-agent", inputs: {}, composedSystemPrompt: "" },
    createdAt: new Date().toISOString(),
  });
  // A red reviewer / fanout child: parentId-tagged, same phase, but carries NO
  // rejectedTaskId marker. Must never be mistaken for a live recovery task.
  insertTask({
    id: "t-build-1-red1", runId, parentId: "t-build-1", phase: "build", agentRole: "test-agent", status: "pending",
    taskPackage: { taskId: "t-build-1-red1", runId, phase: "build", role: "test-agent", inputs: {}, composedSystemPrompt: "" },
    createdAt: new Date().toISOString(),
  });

  const throwingExec: DockerExecFn = async () => {
    throw new Error("nothing should be dispatched — 'build' has a complete primary and no live recovery task");
  };
  const wave = await runNext({ runId, workflow: wf, dockerExec: throwingExec });

  assert.deepEqual(wave.dispatchedSteps, [], "a fanout/red child without the marker must not re-admit the phase to the ready queue");

  const buildTasks = tasksForRun(runId).filter((t) => t.phase === "build");
  assert.equal(buildTasks.length, 2, "no fresh parentId=undefined primary must be minted alongside the existing complete primary + child");

  const child = getTask("t-build-1-red1")!;
  assert.equal(child.status, "pending", "the red/fanout child is untouched — never reused or dispatched as a primary by this fix");
});

// FG-585: a required phase failing must settle the run to the `failed` terminal
// state — NOT a false `complete` — and the downstream phase that can never
// dispatch must be named as unreachable. A crashing exec (exit 1, empty
// result.json) drives `verify` to a terminal `failed` with no replacement.
const FEATURE_FAIL_WORKFLOW: Workflow = {
  name: "feature-fail-test",
  description: "verify then docs; docs depends on verify",
  review_mode: "legacy_verdict",
  inputs: [{ name: "brief", required: true, type: "text" }],
  steps: [
    { id: "verify", agent: "test-agent", gate: "auto", manual: false, depends_on: [], runtime: "claude", reds: [] },
    { id: "docs", agent: "test-agent", gate: "auto", manual: false, depends_on: ["verify"], runtime: "claude", reds: [] },
  ],
};

const crashingExecStub: DockerExecFn = async ({ stdoutPath, stderrPath }) => {
  const dir = dirname(stdoutPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "result.json"), ""); // empty ⇒ container-crash ⇒ task failed
  writeFileSync(stdoutPath, "");
  writeFileSync(stderrPath, "verify crashed");
  return 1;
};

test("FG-585: verify fails → run settles to `failed`, naming verify (failed) + docs (unreachable)", async () => {
  ensureRuntime();
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  const { runId } = startRun({
    workflow: FEATURE_FAIL_WORKFLOW,
    title: "feature fail test",
    inputs: { brief: "x" },
    projectDir: "/tmp/test-project",
  });

  const wave = await runNext({ runId, workflow: FEATURE_FAIL_WORKFLOW, dockerExec: crashingExecStub });

  assert.deepEqual(wave.dispatchedSteps, ["verify"]);
  assert.deepEqual(wave.failedSteps, ["verify"]);
  // The bug: this used to be "complete". It must now be "failed".
  assert.equal(wave.runStatus, "failed", "a run whose required phase failed must NOT report complete");
  assert.ok(wave.terminal, "the wave must carry the terminal classification");
  assert.deepEqual(wave.terminal!.failedPhases, ["verify"], "verify is the failed phase");
  assert.deepEqual(wave.terminal!.unreachablePhases, ["docs"], "docs can never dispatch — its dep failed");

  const run = getRun(runId);
  assert.equal(run!.status, "failed", "the persisted run row must be failed");
  assert.ok(run!.completedAt, "a failed run is terminal — completed_at is stamped");

  // The distinguishing lifecycle event: run.failed, NOT run.completed.
  const types = eventsForRun(runId).map((e) => e.eventType);
  assert.ok(types.includes("run.failed"), "run.failed must be logged");
  assert.ok(!types.includes("run.completed"), "run.completed must NOT be logged for a failed run");
});

test("FG-585: the distinction — verify passes then docs runs and passes → run is `complete`", async () => {
  ensureRuntime();
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  const { runId } = startRun({
    workflow: FEATURE_FAIL_WORKFLOW,
    title: "feature pass test",
    inputs: { brief: "x" },
    projectDir: "/tmp/test-project",
  });

  const okStub = makeStubExec({ status: "complete" });
  const wave1 = await runNext({ runId, workflow: FEATURE_FAIL_WORKFLOW, dockerExec: okStub });
  assert.deepEqual(wave1.completedSteps, ["verify"]);
  assert.equal(wave1.runStatus, "active", "docs still has to run");

  const wave2 = await runNext({ runId, workflow: FEATURE_FAIL_WORKFLOW, dockerExec: okStub });
  assert.deepEqual(wave2.completedSteps, ["docs"]);
  assert.equal(wave2.runStatus, "complete", "docs ran and passed ⇒ complete, not failed");

  const run = getRun(runId);
  assert.equal(run!.status, "complete");
  const types = eventsForRun(runId).map((e) => e.eventType);
  assert.ok(types.includes("run.completed"));
  assert.ok(!types.includes("run.failed"), "a clean run must never log run.failed");
});

test("FG-585 re-entry: retrying the failed verify reactivates the run, and on success it finalizes `complete`", async () => {
  ensureRuntime();
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  const { runId } = startRun({
    workflow: FEATURE_FAIL_WORKFLOW,
    title: "feature retry test",
    inputs: { brief: "x" },
    projectDir: "/tmp/test-project",
  });

  // Fail verify → run failed.
  await runNext({ runId, workflow: FEATURE_FAIL_WORKFLOW, dockerExec: crashingExecStub });
  assert.equal(getRun(runId)!.status, "failed");

  const failedVerify = tasksForRun(runId).find((t) => t.phase === "verify" && t.status === "failed");
  assert.ok(failedVerify, "the failed verify primary must exist");

  // Retry it. Recovery must NOT wedge: the run has to return to active.
  await retry(failedVerify!.id);
  assert.equal(getRun(runId)!.status, "active", "retrying a failed task must reactivate the failed run");

  // Now drive it green: verify passes, then docs.
  const okStub = makeStubExec({ status: "complete" });
  const w1 = await runNext({ runId, workflow: FEATURE_FAIL_WORKFLOW, dockerExec: okStub });
  assert.deepEqual(w1.completedSteps, ["verify"], "the retried verify dispatches and completes");
  const w2 = await runNext({ runId, workflow: FEATURE_FAIL_WORKFLOW, dockerExec: okStub });
  assert.deepEqual(w2.completedSteps, ["docs"]);
  assert.equal(w2.runStatus, "complete", "after recovery the run finalizes complete");
  assert.equal(getRun(runId)!.status, "complete");
});
