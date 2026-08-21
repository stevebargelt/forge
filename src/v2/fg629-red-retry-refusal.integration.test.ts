// FG-629: `forge retry` on a failed workflow-step RED must NOT re-dispatch the step
// primary under the red's role (minting a duplicate primary + a fresh red wave). It
// refuses and names the through-the-primary recovery.
//
// Driven through the REAL runner so the red under test is a genuine dispatched
// red_review child (parented to its primary, named by the step's reds[]), not a
// hand-built row — that provenance is exactly what the classifier keys on.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { tasksForRun } from "../store/tasks.js";
import { verdictsForTask } from "../store/verdicts.js";
import { startRun } from "./startRun.js";
import { runNext, type DockerExecFn } from "./runNext.js";
import { retry, RedReviewRetryError } from "./retry.js";
import { gate } from "./gate.js";
import type { Workflow } from "./schema.js";
import { publishFlatAsGeneration } from "./seed-generation.testkit.js";

const RUNTIME = "fg629-red-test";

const WORKFLOW: Workflow = {
  name: "fg629-red-test",
  description: "FG-629: a workflow-step red is not independently retryable",
  review_mode: "legacy_verdict",
  inputs: [],
  steps: [
    {
      id: "build",
      agent: "engineer",
      gate: "auto",
      manual: false,
      depends_on: [],
      runtime: RUNTIME,
      reds: [{ agent: "red-wide", authority: "specialist", gate_on_verdict: false }],
    },
  ],
};

let db: DatabaseInstance;
let prev: DatabaseInstance | null;
const tmpDirs: string[] = [];
let savedApiKey: string | undefined;
let savedWorktrees: string | undefined;

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "forge-fg629-"));
  tmpDirs.push(dir);
  return dir;
}

function ensureRuntime(): void {
  const runtimePath = join(process.env.FORGE_HOME!, "runtimes", `${RUNTIME}.yml`);
  mkdirSync(dirname(runtimePath), { recursive: true });
  writeFileSync(
    runtimePath,
    `name: ${RUNTIME}
description: FG-629 red-retry test runtime stub
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
result:
  file: /task/result.json
`,
  );
  publishFlatAsGeneration(process.env.FORGE_HOME!);
}

function ensureWorkflowYaml(): void {
  const wfPath = join(process.env.FORGE_HOME!, "workflows", `${WORKFLOW.name}.yml`);
  mkdirSync(dirname(wfPath), { recursive: true });
  writeFileSync(
    wfPath,
    `name: ${WORKFLOW.name}
description: "FG-629: a workflow-step red is not independently retryable"
inputs: []
steps:
  - id: build
    agent: engineer
    gate: auto
    manual: false
    depends_on: []
    runtime: ${RUNTIME}
    reds:
      - agent: red-wide
        authority: specialist
        gate_on_verdict: false
`,
  );
  publishFlatAsGeneration(process.env.FORGE_HOME!);
}

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
  savedApiKey = process.env.ANTHROPIC_API_KEY;
  savedWorktrees = process.env.FORGE_WORKTREES;
  process.env.ANTHROPIC_API_KEY = "sk-fg629";
  process.env.FORGE_WORKTREES = "0";
  ensureRuntime();
  ensureWorkflowYaml();
});

afterEach(() => {
  if (savedApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedApiKey;
  if (savedWorktrees === undefined) delete process.env.FORGE_WORKTREES;
  else process.env.FORGE_WORKTREES = savedWorktrees;
  setDbForTest(prev as DatabaseInstance);
  db.close();
  for (const dir of tmpDirs.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

function taskIdFromDockerArgs(args: string[]): string {
  const i = args.indexOf("--name");
  return (i >= 0 ? (args[i + 1] ?? "") : "").replace(/^forge-/, "");
}

const PRIMARY_RESULT = { status: "complete", tests_run: 1, files_modified: [], commitSha: "deadbeef" };

// Primary completes; the red's container crashes (non-zero exit, no result) — the
// exact FG-628 shape that lands the primary blocked_by_red with a failed red child.
async function driveCrashedRed(): Promise<{ runId: string }> {
  const projectDir = makeTmpDir();
  const { runId } = startRun({ workflow: WORKFLOW, title: "fg629", inputs: {}, projectDir });

  const exec: DockerExecFn = async ({ args, stdoutPath, stderrPath, onContainerStarted }) => {
    const taskId = taskIdFromDockerArgs(args);
    const dir = dirname(stdoutPath);
    mkdirSync(dir, { recursive: true });
    writeFileSync(stdoutPath, "");
    writeFileSync(stderrPath, "");
    if (taskId.startsWith("task-build-")) {
      onContainerStarted?.();
      writeFileSync(join(dir, "result.json"), JSON.stringify(PRIMARY_RESULT));
      return 0;
    }
    // The red: crash before any review artifact (no onContainerStarted, no result).
    return 1;
  };
  exec.signalsContainerStart = true;

  await runNext({ runId, workflow: WORKFLOW, dockerExec: exec });
  return { runId };
}

test("FG-629: retrying a crashed workflow-step red is refused, minting no duplicate primary and no fresh red wave", async () => {
  const { runId } = await driveCrashedRed();

  const primary = tasksForRun(runId).find((t) => t.agentRole === "engineer" && t.parentId === undefined);
  const red = tasksForRun(runId).find((t) => t.agentRole === "red-wide" && t.parentId !== undefined);
  assert.ok(primary !== undefined, "the primary must exist");
  assert.ok(red !== undefined, "a genuine dispatched red_review child must exist");
  assert.equal(red!.status, "failed", "non-vacuity: the red really did fail (retry only accepts failed)");
  assert.equal(red!.parentId, primary!.id, "the red is parented to the primary it reviewed");

  const before = tasksForRun(runId).map((t) => t.id);

  await assert.rejects(() => retry(red!.id), (e: unknown) => {
    assert.ok(e instanceof RedReviewRetryError, `expected RedReviewRetryError, got ${e}`);
    assert.equal((e as RedReviewRetryError).primaryId, primary!.id, "the refusal names the primary the red reviewed");
    assert.equal((e as RedReviewRetryError).phase, "build");
    return true;
  });

  const after = tasksForRun(runId);
  assert.deepEqual(after.map((t) => t.id), before, "refused before any write — no duplicate primary, no new red task");
  assert.equal(
    after.filter((t) => t.parentId === undefined && t.phase === "build").length,
    1,
    "still exactly ONE primary in phase build — the retry did not plant a second one",
  );
});

test("FG-629: the refusal's request-changes recovery re-runs the step and persists a real verdict", async () => {
  const { runId } = await driveCrashedRed();
  const crashedPrimary = tasksForRun(runId).find((t) => t.agentRole === "engineer" && t.parentId === undefined)!;
  const crashedRed = tasksForRun(runId).find((t) => t.agentRole === "red-wide" && t.parentId === crashedPrimary.id)!;
  assert.equal(crashedPrimary.status, "blocked_by_red", "FG-628 makes the crashed review gateable on its primary");
  assert.equal(verdictsForTask(crashedPrimary.id).length, 1, "the crash's inconclusive ingestion is recorded on the original primary");

  // This is the recovery explicitly named by RedReviewRetryError. It replaces the
  // blocked artifact through its own gate; it is not `retry(red)`, so it cannot
  // manufacture a primary from the red's task package.
  const recovery = await gate(crashedPrimary.id, "request-changes", "re-run after reviewer crash", { force: true });
  assert.equal(recovery.nextTasks.length, 1, "gate creates one replacement primary for the step");
  assert.equal(recovery.nextTasks[0]!.parentId, undefined);
  assert.notEqual(recovery.nextTasks[0]!.id, crashedRed.id, "the replacement is never a disguised red retry");

  const exec: DockerExecFn = async ({ args, stdoutPath, stderrPath, onContainerStarted }) => {
    const taskId = taskIdFromDockerArgs(args);
    const dir = dirname(stdoutPath);
    mkdirSync(dir, { recursive: true });
    writeFileSync(stdoutPath, "");
    writeFileSync(stderrPath, "");
    onContainerStarted?.();
    writeFileSync(
      join(dir, "result.json"),
      JSON.stringify(taskId.startsWith("task-red-build-")
        ? { status: "complete", verdict: "pass", confidence: 0.95, findings: [] }
        : PRIMARY_RESULT),
    );
    return 0;
  };
  exec.signalsContainerStart = true;
  await runNext({ runId, workflow: WORKFLOW, dockerExec: exec });

  const all = tasksForRun(runId);
  const recoveryPrimary = all.find((t) => t.id === recovery.nextTasks[0]!.id)!;
  const recoveryReds = all.filter((t) => t.parentId === recoveryPrimary.id && t.agentRole === "red-wide");
  assert.equal(recoveryPrimary.status, "complete", "the supported recovery completes its replacement primary");
  assert.equal(recoveryReds.length, 1, "exactly the recovery step's own red runs — no red-of-red wave");
  assert.equal(verdictsForTask(recoveryPrimary.id).at(-1)?.verdict, "pass", "the recovered primary carries a real reviewer verdict");
  assert.equal(
    all.filter((t) => t.parentId === undefined && t.phase === "build").length,
    2,
    "only the intentional gate replacement accompanies the original primary; retrying the red minted none",
  );
});
