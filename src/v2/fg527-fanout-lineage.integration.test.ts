// FG-527 integration coverage: exercise the retry and dispatch seams through
// the real runner, rather than only asserting classifier output in isolation.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { getRun, insertRun } from "../store/runs.js";
import { getTask, insertTask, tasksForRun } from "../store/tasks.js";
import { failTask } from "./failure-kind.js";
import { startRun } from "./startRun.js";
import { runNext, type DockerExecFn } from "./runNext.js";
import { FanoutChildRetryError, retry } from "./retry.js";
import type { Run, Task } from "../types/index.js";
import type { Workflow } from "./schema.js";
import { publishFlatAsGeneration } from "./seed-generation.testkit.js";

let db: DatabaseInstance;
let previousDb: DatabaseInstance | null;
const tmpDirs: string[] = [];
let savedApiKey: string | undefined;
let savedWorktrees: string | undefined;

function ensureRuntime(): void {
  const runtimePath = join(process.env.FORGE_HOME!, "runtimes", "claude.yml");
  if (!existsSync(runtimePath)) {
    mkdirSync(dirname(runtimePath), { recursive: true });
    writeFileSync(runtimePath, `name: claude
description: fg527 integration test stub
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
}

function projectDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "forge-fg527-"));
  tmpDirs.push(dir);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fg527-fixture" }));
  return dir;
}

function writeShippingReviewerWorkflow(dir: string): void {
  const workflowDir = join(dir, ".forge", "workflows");
  mkdirSync(workflowDir, { recursive: true });
  writeFileSync(join(workflowDir, `${FANOUT_WITH_SHIPPING_REVIEWER.name}.yml`), `name: ${FANOUT_WITH_SHIPPING_REVIEWER.name}
description: seed then fan out with a non-red-prefixed reviewer
inputs: []
steps:
  - id: seed
    agent: engineer
    gate: auto
  - id: spread
    agent: engineer
    gate: auto
    depends_on: [seed]
    reds:
      - agent: shipping-reviewer
        authority: specialist
    fanout:
      from_upstream:
        step: seed
        array_key: items
        input_key: item
      failure_mode: continue
`);
}

function execWith(resultFor: (taskId: string) => unknown): DockerExecFn {
  return async ({ args, stdoutPath, stderrPath }) => {
    const taskId = (args[args.indexOf("--name") + 1] ?? "").replace(/^forge-/, "");
    mkdirSync(dirname(stdoutPath), { recursive: true });
    writeFileSync(join(dirname(stdoutPath), "result.json"), JSON.stringify(resultFor(taskId)));
    writeFileSync(stdoutPath, "stub");
    writeFileSync(stderrPath, "");
    return 0;
  };
}

const FANOUT_WITH_SHIPPING_REVIEWER: Workflow = {
  name: "fg527-shipping-reviewer",
  description: "seed then fan out with a non-red-prefixed reviewer",
  review_mode: "legacy_verdict",
  inputs: [],
  steps: [
    { id: "seed", agent: "engineer", gate: "auto", manual: false, depends_on: [], runtime: "claude", reds: [] },
    {
      id: "spread", agent: "engineer", gate: "auto", manual: false, depends_on: ["seed"], runtime: "claude",
      reds: [{ agent: "shipping-reviewer", authority: "specialist", gate_on_verdict: false }],
      fanout: { from_upstream: { step: "seed", array_key: "items", input_key: "item" }, failure_mode: "continue" },
    },
  ],
};

beforeEach(() => {
  db = makeInMemoryDb();
  previousDb = setDbForTest(db);
  ensureRuntime();
  savedApiKey = process.env.ANTHROPIC_API_KEY;
  savedWorktrees = process.env.FORGE_WORKTREES;
  process.env.ANTHROPIC_API_KEY = "sk-fg527";
  process.env.FORGE_WORKTREES = "0";
});

afterEach(() => {
  if (savedApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedApiKey;
  if (savedWorktrees === undefined) delete process.env.FORGE_WORKTREES;
  else process.env.FORGE_WORKTREES = savedWorktrees;
  setDbForTest(previousDb as DatabaseInstance);
  db.close();
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function dispatchFanoutWithReviewer(): Promise<{ runId: string; reviewer: Task; child: Task }> {
  const dir = projectDir();
  writeShippingReviewerWorkflow(dir);
  const { runId } = startRun({ workflow: FANOUT_WITH_SHIPPING_REVIEWER, title: "fg527", inputs: {}, projectDir: dir });
  await runNext({ runId, workflow: FANOUT_WITH_SHIPPING_REVIEWER, dockerExec: execWith(() => ({ status: "complete", items: ["a", "b"], tests_run: 1 })) });
  await runNext({
    runId,
    workflow: FANOUT_WITH_SHIPPING_REVIEWER,
    dockerExec: execWith((id) => id.includes("shipping-reviewer")
      ? { status: "complete", verdict: "pass", confidence: 0.9, findings: [] }
      : { status: "complete", tests_run: 1 }),
  });
  const parent = tasksForRun(runId).find((task) => task.phase === "spread" && task.parentId === undefined)!;
  const reviewer = tasksForRun(runId).find((task) => task.parentId === parent.id && task.agentRole === "shipping-reviewer")!;
  const child = tasksForRun(runId).find((task) => task.parentId === parent.id && task.agentRole === "engineer")!;
  assert.ok(reviewer, "fixture dispatched the non-prefixed red reviewer");
  assert.ok(child, "fixture dispatched a genuine fanout child");
  return { runId, reviewer, child };
}

test("FG-527: a failed shipping-reviewer red is retried through the workflow ready queue", async () => {
  const { reviewer } = await dispatchFanoutWithReviewer();
  failTask(reviewer.id, { runId: reviewer.runId, kind: "container_crash", error: "retry me" });

  const out = await retry(reviewer.id);
  assert.equal(out.adHoc, undefined, "workflow reviewer retry is left for the ready queue");
  assert.equal(getTask(out.newTask.id)!.status, "pending");
  assert.equal(getTask(out.newTask.id)!.parentId, undefined, "retry mints a fresh primary");
});

test("FG-527: a genuine fanout child remains refused before retry creates a row", async () => {
  const { runId, child } = await dispatchFanoutWithReviewer();
  failTask(child.id, { runId, kind: "container_crash", error: "retry me" });
  const before = tasksForRun(runId).map((task) => task.id);

  await assert.rejects(() => retry(child.id), (error: unknown) => {
    assert.ok(error instanceof FanoutChildRetryError, `expected FanoutChildRetryError, got ${error}`);
    return true;
  });
  assert.deepEqual(tasksForRun(runId).map((task) => task.id), before);
});

test("FG-527: a pending adhoc invoke in a fanout step named task is not adopted as its parent", async () => {
  const workflow: Workflow = {
    name: "fg527-task-fanout", description: "fanout step collides with invoke phase", review_mode: "legacy_verdict", inputs: [],
    steps: [
      { id: "seed", agent: "engineer", gate: "auto", manual: false, depends_on: [], runtime: "claude", reds: [] },
      { id: "task", agent: "engineer", gate: "auto", manual: false, depends_on: ["seed"], runtime: "claude", reds: [], fanout: { from_upstream: { step: "seed", array_key: "items", input_key: "item" }, failure_mode: "continue" } },
    ],
  };
  const { runId } = startRun({ workflow, title: "fg527 task collision", inputs: {}, projectDir: projectDir() });
  await runNext({ runId, workflow, dockerExec: execWith(() => ({ status: "complete", items: ["a", "b"], tests_run: 1 })) });
  const invoked: Task = {
    id: "task-adhoc-invoke", runId, phase: "task", agentRole: "engineer", status: "pending",
    taskPackage: { taskId: "task-adhoc-invoke", runId, phase: "task", role: "engineer", inputs: {}, composedSystemPrompt: "", dispatchSource: "invoke" },
    createdAt: "2026-08-15T00:00:00Z",
  };
  insertTask(invoked);

  await runNext({ runId, workflow, dockerExec: execWith(() => ({ status: "complete", tests_run: 1 })) });
  assert.equal(getTask(invoked.id)!.status, "pending", "the invoke row was not adopted or dispatched by the workflow runner");
  const parent = tasksForRun(runId).find((task) => task.phase === "task" && task.parentId === undefined && task.id !== invoked.id)!;
  assert.ok(parent, "runner minted its own fanout parent");
  assert.equal(tasksForRun(runId).filter((task) => task.parentId === parent.id).length, 2, "the real parent owns both fanout children");
});

test("FG-527: an unloadable-workflow fanout child is refused fail-CLOSED; --force overrides", async () => {
  // The structural guard must fail CLOSED when the workflow won't load: a run whose
  // workflow name cannot resolve must NOT let a fanout child be retried (that would
  // mint a stray primary in the fanout phase). fanoutParentOf classifies against a
  // degraded empty-steps workflow, so a parented non-recovery row resolves to
  // fanout_child and is refused — recoverable via --force.
  const run: Run = { id: "run-fg527-unloadable", workflow: "missing-fg527-workflow", title: "fg527", status: "active", createdAt: "2026-08-15T00:00:00Z", projectDir: projectDir() };
  insertRun(run);
  insertTask({
    id: "former-parent", runId: run.id, phase: "task", agentRole: "engineer", status: "complete",
    taskPackage: { taskId: "former-parent", runId: run.id, phase: "task", role: "engineer", inputs: {}, composedSystemPrompt: "", dispatchSource: "workflow" },
    createdAt: "2026-08-15T00:00:00Z",
  });
  const failed: Task = {
    id: "task-fg527-unloadable", runId: run.id, parentId: "former-parent", phase: "task", agentRole: "engineer", status: "failed", error: "boom",
    taskPackage: { taskId: "task-fg527-unloadable", runId: run.id, phase: "task", role: "engineer", inputs: { task: "resume the original fanout child" }, composedSystemPrompt: "", dispatchSource: "workflow" },
    createdAt: "2026-08-15T00:00:01Z",
  };
  insertTask(failed);
  failTask(failed.id, { runId: run.id, kind: "container_crash", error: "boom" });
  const before = tasksForRun(run.id).map((task) => task.id);

  await assert.rejects(() => retry(failed.id), (error: unknown) => {
    assert.ok(error instanceof FanoutChildRetryError, `expected FanoutChildRetryError, got ${error}`);
    assert.equal((error as FanoutChildRetryError).parentId, "former-parent");
    return true;
  });
  assert.deepEqual(tasksForRun(run.id).map((task) => task.id), before, "no row created — refused before any write");

  const out = await retry(failed.id, { force: true });
  assert.ok(out.adHoc === undefined, "forced retry of a stamped child is a workflow step, not ad-hoc");
  assert.equal(out.newTask.status, "pending");
  assert.equal(getTask(out.newTask.id)!.parentId, undefined, "the forced retry mints a fresh PRIMARY");
});
