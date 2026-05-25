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
import { runNext, resolveChildAgent, type DockerExecFn } from "./runNext.js";
import { startRun } from "./startRun.js";
import { tasksForRun, getTask } from "../store/tasks.js";
import { getRun } from "../store/runs.js";
import { verdictsForTask } from "../store/verdicts.js";
import type { Workflow, Step, FanoutDef } from "./schema.js";

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
      result: { status: "complete", verdict: "fail", confidence: 0.8, findings: [] },
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
  assert.equal(verdicts[0]!.verdict, "fail");
  assert.equal(verdicts[0]!.authority, "specialist");
});

// ---------------------------------------------------------------------------
// Fanout
// ---------------------------------------------------------------------------

const FANOUT_WORKFLOW: Workflow = {
  name: "test-fanout",
  description: "research step fans out per claim from upstream",
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
