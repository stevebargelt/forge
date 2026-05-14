// runNext integration test — stubs the docker exec so we can drive the runner
// end-to-end without real containers. Validates:
//   - Ready-queue → dispatch → result → status transitions
//   - Parallel-within-wave: multiple ready steps spawn concurrently
//   - Gate handling: gate: auto → complete, gate: human → awaiting_gate
//   - Run completes when all steps done
//   - manual: true creates a pending task without spawn

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { runNext, type DockerExecFn } from "./runNext.js";
import { startRun } from "./startRun.js";
import { tasksForRun, getTask } from "../store/tasks.js";
import { getRun } from "../store/runs.js";
import type { Workflow } from "./schema.js";

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

const LINEAR_WORKFLOW: Workflow = {
  name: "test-linear",
  description: "two-step linear test",
  inputs: [{ name: "brief", required: true, type: "text" }],
  steps: [
    { id: "first", agent: "test-agent", gate: "auto", manual: false, depends_on: [], runtime: "claude", reds: [] },
    { id: "second", agent: "test-agent", gate: "auto", manual: false, depends_on: ["first"], runtime: "claude", reds: [] },
  ],
};

const PARALLEL_WORKFLOW: Workflow = {
  name: "test-parallel",
  description: "diamond fanout test",
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
  inputs: [{ name: "brief", required: true, type: "text" }],
  steps: [
    { id: "needs-review", agent: "test-agent", gate: "human", manual: false, depends_on: [], runtime: "claude", reds: [] },
  ],
};

const MANUAL_WORKFLOW: Workflow = {
  name: "test-manual",
  description: "manual step doesn't dispatch a container",
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
  // but the runner does call loadRuntime() before invoking the exec stub.
  // Skip the test if no runtime YAML exists in FORGE_HOME/runtimes/.
  const fhome = process.env.FORGE_HOME!;
  const runtimePath = join(fhome, "runtimes", "claude.yml");
  if (!existsSync(runtimePath)) {
    // Synthesize a minimal runtime YAML so loadRuntime succeeds.
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
