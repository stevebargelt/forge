// FG-482: blocked_by_red must be written as ONE atomic store-layer transition
// (markTaskBlockedByRed's CAS'd UPDATE + its task.blocked_by_red event, both
// inside a single getDb().transaction()) — never the old 4-write choreography
// (setTaskStatus(blocked_by_red) -> logEvent -> markTaskAwaitingGate ->
// setTaskStatus(blocked_by_red) again) that transited through awaiting_gate.
//
// Forces the SECOND write (logEvent("task.blocked_by_red")) to fail via a
// trigger on the events table, and asserts the FIRST write (the CAS'd status+
// result UPDATE) was rolled back too, leaving the task in its PRIOR state
// (awaiting_red) — never awaiting_gate, never a half-transition. Drives the
// real dispatchSingleStep + fan-out dispatch paths through runNext(), not a
// hand-rolled reimplementation, so both call sites named in the review (FG-482
// F3) are covered.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { tasksForRun, setTaskStatus } from "../store/tasks.js";
import { eventsForTask } from "../store/events.js";
import { startRun } from "./startRun.js";
import { runNext } from "./runNext.js";
import type { DockerExecFn } from "./runNext.js";
import type { Workflow } from "./schema.js";

const FAIL_VERDICT = {
  status: "complete",
  verdict: "fail",
  confidence: 0.9,
  findings: [
    {
      severity: "high",
      summary: "fg482 atomicity test finding",
      evidence: "test evidence",
      hypothesis: "test hypothesis",
    },
  ],
};

function singleStepWorkflow(runtimeName: string, redAgent: string): Workflow {
  return {
    name: runtimeName,
    description: "FG-482 blocked_by_red atomicity — single-step path",
    inputs: [],
    steps: [
      {
        id: "build",
        agent: "engineer",
        gate: "auto",
        manual: false,
        depends_on: [],
        runtime: runtimeName,
        reds: [{ agent: redAgent, authority: "authoritative", gate_on_verdict: true }],
      },
    ],
  };
}

function fanoutWorkflow(runtimeName: string, redAgent: string): Workflow {
  return {
    name: runtimeName,
    description: "FG-482 blocked_by_red atomicity — fanout path",
    inputs: [],
    steps: [
      {
        id: "plan",
        agent: "planner",
        gate: "auto",
        manual: false,
        depends_on: [],
        runtime: runtimeName,
        reds: [],
      },
      {
        id: "build",
        agent: "engineer",
        gate: "auto",
        manual: false,
        depends_on: ["plan"],
        runtime: runtimeName,
        reds: [{ agent: redAgent, authority: "authoritative", gate_on_verdict: true }],
        fanout: {
          from_upstream: { step: "plan", array_key: "claims", input_key: "claim" },
          max_concurrency: 4,
          failure_mode: "fail-phase",
        },
      },
    ],
  };
}

let db: DatabaseInstance;
let prev: DatabaseInstance | null;
const tmpDirs: string[] = [];
let savedApiKey: string | undefined;

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
  savedApiKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "sk-stub";
});

afterEach(() => {
  setDbForTest(prev as DatabaseInstance);
  db.close();
  if (savedApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedApiKey;
  for (const dir of tmpDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "forge-fg482-"));
  tmpDirs.push(dir);
  writeFileSync(join(dir, ".keep"), ""); // avoid the empty-project-dir mount preflight warning
  return dir;
}

function ensureRuntime(name: string): void {
  const forgeHome = process.env.FORGE_HOME!;
  const runtimePath = join(forgeHome, "runtimes", `${name}.yml`);
  mkdirSync(dirname(runtimePath), { recursive: true });
  writeFileSync(
    runtimePath,
    `name: ${name}
description: FG-482 dispatch test runtime stub
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
  remove_on_exit: true
result:
  file: /task/result.json
`,
  );
}

function taskIdFromDockerArgs(args: string[]): string {
  const nameIdx = args.indexOf("--name");
  const containerName = nameIdx >= 0 ? (args[nameIdx + 1] ?? "") : "";
  return containerName.replace(/^forge-/, "");
}

// Simulates a crash between the CAS'd status+result write and its paired
// event — the exact window the old 4-write choreography left open. With the
// new single-transaction write, this must roll back the CAS too.
function installForceFailTrigger(): void {
  db.exec(`
    CREATE TRIGGER force_fail_blocked_by_red
    BEFORE INSERT ON events
    WHEN NEW.event_type = 'task.blocked_by_red'
    BEGIN
      SELECT RAISE(ABORT, 'forced failure for fg482 atomicity test');
    END;
  `);
}

function makeSingleStepExec(): DockerExecFn {
  return async ({ args, stdoutPath, stderrPath }) => {
    const taskId = taskIdFromDockerArgs(args);
    const dir = dirname(stdoutPath);
    mkdirSync(dir, { recursive: true });
    const result = taskId.startsWith("task-red-build-") ? FAIL_VERDICT : { status: "complete", files_modified: [], tests_run: 4, tests_passed: 4 };
    writeFileSync(join(dir, "result.json"), JSON.stringify(result));
    writeFileSync(stdoutPath, "");
    writeFileSync(stderrPath, "");
    return 0;
  };
}

function makeFanoutExec(): DockerExecFn {
  return async ({ args, stdoutPath, stderrPath }) => {
    const taskId = taskIdFromDockerArgs(args);
    const dir = dirname(stdoutPath);
    mkdirSync(dir, { recursive: true });
    let result: unknown;
    if (taskId.startsWith("task-red-build-")) {
      result = FAIL_VERDICT;
    } else if (taskId.startsWith("task-plan-")) {
      result = { status: "complete", claims: ["claim-a"] };
    } else {
      // fanout child, e.g. task-build-0-...
      result = { status: "complete", files_modified: [] };
    }
    writeFileSync(join(dir, "result.json"), JSON.stringify(result));
    writeFileSync(stdoutPath, "");
    writeFileSync(stderrPath, "");
    return 0;
  };
}

// Simulates a concurrent `forge cancel` landing on the primary/parent task
// while dispatchReds is still awaiting the red's container — the exact race
// window markTaskBlockedByRed's CAS (guarded on status = 'awaiting_red',
// src/store/tasks.ts) is meant to close. The mutation happens synchronously
// inside the red's dockerExec callback, which fully resolves (and the
// resulting status change lands) before dispatchReds returns and the
// aggregate.authoritativeFail check runs — so it deterministically lands in
// the CAS's race window on every run, rather than depending on real
// concurrency/timing.
function makeSingleStepExecWithConcurrentCancel(runId: string): DockerExecFn {
  return async ({ args, stdoutPath, stderrPath }) => {
    const taskId = taskIdFromDockerArgs(args);
    const dir = dirname(stdoutPath);
    mkdirSync(dir, { recursive: true });
    if (taskId.startsWith("task-red-build-")) {
      const primary = tasksForRun(runId).find((t) => t.agentRole === "engineer" && t.parentId === undefined);
      if (primary) setTaskStatus(primary.id, "failed");
    }
    const result = taskId.startsWith("task-red-build-") ? FAIL_VERDICT : { status: "complete", files_modified: [], tests_run: 4, tests_passed: 4 };
    writeFileSync(join(dir, "result.json"), JSON.stringify(result));
    writeFileSync(stdoutPath, "");
    writeFileSync(stderrPath, "");
    return 0;
  };
}

function makeFanoutExecWithConcurrentCancel(runId: string): DockerExecFn {
  return async ({ args, stdoutPath, stderrPath }) => {
    const taskId = taskIdFromDockerArgs(args);
    const dir = dirname(stdoutPath);
    mkdirSync(dir, { recursive: true });
    let result: unknown;
    if (taskId.startsWith("task-red-build-")) {
      result = FAIL_VERDICT;
      const parent = tasksForRun(runId).find((t) => t.phase === "build" && t.parentId === undefined);
      if (parent) setTaskStatus(parent.id, "failed");
    } else if (taskId.startsWith("task-plan-")) {
      result = { status: "complete", claims: ["claim-a"] };
    } else {
      result = { status: "complete", files_modified: [] };
    }
    writeFileSync(join(dir, "result.json"), JSON.stringify(result));
    writeFileSync(stdoutPath, "");
    writeFileSync(stderrPath, "");
    return 0;
  };
}

test("fg482 single-step: forced task.blocked_by_red event failure rolls back the status+result CAS (task stays awaiting_red, never awaiting_gate)", async () => {
  const runtimeName = "fg482-singlestep-fail-test";
  ensureRuntime(runtimeName);
  const workflow = singleStepWorkflow(runtimeName, "fg482-red");
  installForceFailTrigger();

  const projectDir = makeTmpDir();
  const { runId } = startRun({ workflow, title: "fg482 single-step atomicity forced-failure test", inputs: {}, projectDir });

  await assert.rejects(
    () => runNext({ runId, workflow, dockerExec: makeSingleStepExec() }),
    /forced failure for fg482 atomicity test/,
    "runNext must propagate the forced logEvent failure",
  );

  const tasks = tasksForRun(runId);
  const primaryTask = tasks.find((t) => t.agentRole === "engineer" && t.parentId === undefined);
  assert.ok(primaryTask, "primary engineer task row must exist");
  assert.equal(
    primaryTask!.status,
    "awaiting_red",
    "a throw between the CAS write and its paired event must leave the task in its PRIOR state, not blocked_by_red",
  );
  assert.notEqual(primaryTask!.status, "awaiting_gate", "task must never transit through awaiting_gate");
  assert.equal(primaryTask!.result, undefined, "result must not be persisted when the paired write rolled back");

  const events = eventsForTask(primaryTask!.id);
  assert.equal(
    events.filter((e) => e.eventType === "task.blocked_by_red").length,
    0,
    "no task.blocked_by_red event must be recorded when the write failed",
  );
});

test("fg482 single-step happy path: blocked_by_red writes status+result together, event logged exactly once", async () => {
  const runtimeName = "fg482-singlestep-happy-test";
  ensureRuntime(runtimeName);
  const workflow = singleStepWorkflow(runtimeName, "fg482-red");

  const projectDir = makeTmpDir();
  const { runId } = startRun({ workflow, title: "fg482 single-step atomicity happy-path test", inputs: {}, projectDir });

  const status = await runNext({ runId, workflow, dockerExec: makeSingleStepExec() });
  void status;

  const tasks = tasksForRun(runId);
  const primaryTask = tasks.find((t) => t.agentRole === "engineer" && t.parentId === undefined);
  assert.ok(primaryTask, "primary engineer task row must exist");
  assert.equal(primaryTask!.status, "blocked_by_red");
  assert.ok(primaryTask!.result, "result must be populated on the happy path");

  const events = eventsForTask(primaryTask!.id);
  assert.equal(
    events.filter((e) => e.eventType === "task.blocked_by_red").length,
    1,
    "task.blocked_by_red must be logged exactly once",
  );
});

test("fg482 fanout: forced task.blocked_by_red event failure rolls back the parent's status+result CAS (stays awaiting_red, never awaiting_gate)", async () => {
  const runtimeName = "fg482-fanout-fail-test";
  ensureRuntime(runtimeName);
  const workflow = fanoutWorkflow(runtimeName, "fg482-red");
  installForceFailTrigger();

  const projectDir = makeTmpDir();
  const { runId } = startRun({ workflow, title: "fg482 fanout atomicity forced-failure test", inputs: {}, projectDir });

  const exec = makeFanoutExec();
  await runNext({ runId, workflow, dockerExec: exec }); // wave 1: plan

  await assert.rejects(
    () => runNext({ runId, workflow, dockerExec: exec }), // wave 2: fanout build + reds
    /forced failure for fg482 atomicity test/,
    "runNext must propagate the forced logEvent failure",
  );

  const tasks = tasksForRun(runId);
  const parentTask = tasks.find((t) => t.phase === "build" && t.parentId === undefined);
  assert.ok(parentTask, "fanout parent task must exist");
  assert.equal(
    parentTask!.status,
    "awaiting_red",
    "a throw between the CAS write and its paired event must leave the parent in its PRIOR state, not blocked_by_red",
  );
  assert.notEqual(parentTask!.status, "awaiting_gate", "parent must never transit through awaiting_gate");

  const events = eventsForTask(parentTask!.id);
  assert.equal(
    events.filter((e) => e.eventType === "task.blocked_by_red").length,
    0,
    "no task.blocked_by_red event must be recorded when the write failed",
  );
});

test("fg482 fanout happy path: blocked_by_red writes status+result together, event logged exactly once", async () => {
  const runtimeName = "fg482-fanout-happy-test";
  ensureRuntime(runtimeName);
  const workflow = fanoutWorkflow(runtimeName, "fg482-red");

  const projectDir = makeTmpDir();
  const { runId } = startRun({ workflow, title: "fg482 fanout atomicity happy-path test", inputs: {}, projectDir });

  const exec = makeFanoutExec();
  await runNext({ runId, workflow, dockerExec: exec }); // wave 1: plan
  await runNext({ runId, workflow, dockerExec: exec }); // wave 2: fanout build + reds

  const tasks = tasksForRun(runId);
  const parentTask = tasks.find((t) => t.phase === "build" && t.parentId === undefined);
  assert.ok(parentTask, "fanout parent task must exist");
  assert.equal(parentTask!.status, "blocked_by_red");
  assert.ok(parentTask!.result, "result must be populated on the happy path");

  const events = eventsForTask(parentTask!.id);
  assert.equal(
    events.filter((e) => e.eventType === "task.blocked_by_red").length,
    1,
    "task.blocked_by_red must be logged exactly once",
  );
});

test("fg482 single-step: CAS loses a race (task no longer awaiting_red) — no resurrection to blocked_by_red, no event, actual status reported", async () => {
  const runtimeName = "fg482-singlestep-cas-race-test";
  ensureRuntime(runtimeName);
  const workflow = singleStepWorkflow(runtimeName, "fg482-red");

  const projectDir = makeTmpDir();
  const { runId } = startRun({ workflow, title: "fg482 single-step CAS-race test", inputs: {}, projectDir });

  const status = await runNext({ runId, workflow, dockerExec: makeSingleStepExecWithConcurrentCancel(runId) });
  void status;

  const tasks = tasksForRun(runId);
  const primaryTask = tasks.find((t) => t.agentRole === "engineer" && t.parentId === undefined);
  assert.ok(primaryTask, "primary engineer task row must exist");
  assert.equal(
    primaryTask!.status,
    "failed",
    "the status set by the concurrent actor must win — the CAS must not resurrect the task into blocked_by_red",
  );
  assert.notEqual(primaryTask!.status, "awaiting_gate", "task must never transit through awaiting_gate");

  const events = eventsForTask(primaryTask!.id);
  assert.equal(
    events.filter((e) => e.eventType === "task.blocked_by_red").length,
    0,
    "no task.blocked_by_red event must be recorded when the CAS lost the race — the transition never happened",
  );
});

test("fg482 fanout: CAS loses a race on the parent (no longer awaiting_red) — no resurrection to blocked_by_red, no event, actual status reported", async () => {
  const runtimeName = "fg482-fanout-cas-race-test";
  ensureRuntime(runtimeName);
  const workflow = fanoutWorkflow(runtimeName, "fg482-red");

  const projectDir = makeTmpDir();
  const { runId } = startRun({ workflow, title: "fg482 fanout CAS-race test", inputs: {}, projectDir });

  const exec = makeFanoutExecWithConcurrentCancel(runId);
  await runNext({ runId, workflow, dockerExec: exec }); // wave 1: plan
  await runNext({ runId, workflow, dockerExec: exec }); // wave 2: fanout build + reds

  const tasks = tasksForRun(runId);
  const parentTask = tasks.find((t) => t.phase === "build" && t.parentId === undefined);
  assert.ok(parentTask, "fanout parent task must exist");
  assert.equal(
    parentTask!.status,
    "failed",
    "the status set by the concurrent actor must win — the CAS must not resurrect the parent into blocked_by_red",
  );
  assert.notEqual(parentTask!.status, "awaiting_gate", "parent must never transit through awaiting_gate");

  const events = eventsForTask(parentTask!.id);
  assert.equal(
    events.filter((e) => e.eventType === "task.blocked_by_red").length,
    0,
    "no task.blocked_by_red event must be recorded when the CAS lost the race — the transition never happened",
  );
});
