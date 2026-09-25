// FG-809 dispatch/retry integration coverage.  The compose/retry unit tests pin
// wording and helper bounds; these tests prove those bytes survive the real
// dispatch paths, including the mount mode passed to the container and CLI retry.

import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { Command } from "commander";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { getTask, tasksForRun } from "../store/tasks.js";
import { startRun } from "./startRun.js";
import { invoke, type DockerExecFn as InvokeDockerExecFn } from "./invoke.js";
import { runNext, type DockerExecFn } from "./runNext.js";
import type { Workflow } from "./schema.js";
import { publishFlatAsGeneration } from "./seed-generation.testkit.js";
import { registerRetry } from "../cli/commands/retry.js";

const RUNTIME = "fg809-dispatch-runtime";
const WORKFLOW_NAME = "fg809-dispatch-retry";
const tmpDirs: string[] = [];
let db: DatabaseInstance;
let previousDb: DatabaseInstance | null;
let savedApiKey: string | undefined;
let savedWorktrees: string | undefined;

const WORKFLOW: Workflow = {
  name: WORKFLOW_NAME,
  description: "FG-809 dispatch and retry fixture",
  review_mode: "legacy_verdict",
  inputs: [],
  steps: [{
    id: "build", agent: "engineer", gate: "auto", manual: false, depends_on: [], runtime: RUNTIME,
    reds: [{ agent: "red-wide", authority: "specialist", gate_on_verdict: false }],
  }],
};

function tempProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "forge-fg809-project-"));
  tmpDirs.push(dir);
  writeFileSync(join(dir, "package.json"), "{}");
  return dir;
}

function installFixtures(): void {
  const home = process.env.FORGE_HOME!;
  const runtimePath = join(home, "runtimes", `${RUNTIME}.yml`);
  const workflowPath = join(home, "workflows", `${WORKFLOW_NAME}.yml`);
  mkdirSync(dirname(runtimePath), { recursive: true });
  mkdirSync(dirname(workflowPath), { recursive: true });
  writeFileSync(runtimePath, `name: ${RUNTIME}
description: FG-809 dispatch fixture runtime
image: test-image:latest
models:
  default: test-model
auth:
  mode: apikey
mounts:
  - { host: "\${TASK_DIR}", container: /task, mode: rw }
  - { host: "\${PROJECT_DIR}", container: /project, mode: "\${PROJECT_MODE}" }
invocation:
  command: echo
  args: ["stub"]
container:
  name: "forge-\${TASK_ID}"
result:
  file: /task/result.json
`);
  writeFileSync(workflowPath, `name: ${WORKFLOW_NAME}
description: FG-809 dispatch and retry fixture
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
`);
  publishFlatAsGeneration(home);
}

function taskId(args: string[]): string {
  const index = args.indexOf("--name");
  return (index === -1 ? "" : args[index + 1] ?? "").replace(/^forge-/, "");
}

function projectMount(args: string[], projectDir: string): string | undefined {
  return args.find((arg) => arg.startsWith(`${projectDir}:/project:`));
}

async function runCli(argv: string[]): Promise<string> {
  const program = new Command();
  program.exitOverride();
  registerRetry(program);
  const lines: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...items: unknown[]) => void lines.push(items.map(String).join(" "));
  console.error = (...items: unknown[]) => void lines.push(items.map(String).join(" "));
  try {
    await program.parseAsync(argv, { from: "user" });
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  return lines.join("\n");
}

beforeEach(() => {
  db = makeInMemoryDb();
  previousDb = setDbForTest(db);
  savedApiKey = process.env.ANTHROPIC_API_KEY;
  savedWorktrees = process.env.FORGE_WORKTREES;
  process.env.ANTHROPIC_API_KEY = "sk-fg809";
  process.env.FORGE_WORKTREES = "0";
  installFixtures();
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

test("FG-809: runNext dispatch gives the primary write framing and its red only read framing, matching the actual /project mount", async () => {
  const projectDir = tempProject();
  const { runId } = startRun({ workflow: WORKFLOW, title: "fg809 mounts", inputs: {}, projectDir });
  const observed = new Map<string, { prompt: string; mount?: string }>();
  const exec: DockerExecFn = async ({ args, stdoutPath, stderrPath }) => {
    const id = taskId(args);
    const dir = dirname(stdoutPath);
    observed.set(id, { prompt: readFileSync(join(dir, "CLAUDE.md"), "utf8"), mount: projectMount(args, projectDir) });
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "result.json"), JSON.stringify(id.startsWith("task-build-")
      ? { status: "complete", tests_run: 1, files_modified: [] }
      : { status: "complete", verdict: "pass", confidence: 1, findings: [] }));
    writeFileSync(stdoutPath, "");
    writeFileSync(stderrPath, "");
    return 0;
  };

  await runNext({ runId, workflow: WORKFLOW, dockerExec: exec });
  const primary = tasksForRun(runId).find((task) => task.agentRole === "engineer")!;
  const red = tasksForRun(runId).find((task) => task.agentRole === "red-wide")!;
  const primaryObserved = observed.get(primary.id)!;
  const redObserved = observed.get(red.id)!;
  assert.match(primaryObserved.mount ?? "", /:\/project:rw$/);
  assert.match(primaryObserved.prompt, /## Actions you must not take/);
  assert.match(primaryObserved.prompt, /\/task\/TASKS\.md/);
  assert.match(redObserved.mount ?? "", /:\/project:ro$/);
  assert.match(redObserved.prompt, /## Non-interactive run/);
  assert.doesNotMatch(redObserved.prompt, /## Actions you must not take|TASKS\.md/);
});

test("FG-809: forge invoke's writable default and --read-only equivalent compose from the same mount mode", async () => {
  const projectDir = tempProject();
  const cases: Array<{ readOnlyProject: boolean; prompt: string; mount?: string }> = [];
  const inspect: InvokeDockerExecFn = async ({ args, stdoutPath, stderrPath }) => {
    const dir = dirname(stdoutPath);
    cases.push({ readOnlyProject: args.includes(`${projectDir}:/project:ro`), prompt: readFileSync(join(dir, "CLAUDE.md"), "utf8"), mount: projectMount(args, projectDir) });
    writeFileSync(join(dir, "result.json"), JSON.stringify({ status: "complete" }));
    writeFileSync(stdoutPath, "");
    writeFileSync(stderrPath, "");
    return 0;
  };
  await invoke({ agentRole: "engineer", task: "write", projectDir, runtimeName: RUNTIME, dockerExec: inspect });
  await invoke({ agentRole: "red-wide", task: "audit", projectDir, runtimeName: RUNTIME, readOnlyProject: true, dockerExec: inspect });
  const writable = cases.find((entry) => !entry.readOnlyProject)!;
  const readOnly = cases.find((entry) => entry.readOnlyProject)!;
  assert.match(writable.mount ?? "", /:\/project:rw$/);
  assert.match(writable.prompt, /## Actions you must not take/);
  assert.match(readOnly.mount ?? "", /:\/project:ro$/);
  assert.doesNotMatch(readOnly.prompt, /## Actions you must not take|TASKS\.md/);
});

test("FG-809: forge retry carries bounded, safely fenced previous files into the next real workflow dispatch", async () => {
  const projectDir = tempProject();
  const { runId } = startRun({ workflow: WORKFLOW, title: "fg809 retry", inputs: {}, projectDir });
  let firstTaskId = "";
  const failAfterRecording: DockerExecFn = async ({ args, stdoutPath, stderrPath }) => {
    firstTaskId = taskId(args);
    const dir = dirname(stdoutPath);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "TASKS.md"), `${"`".repeat(40)}\n${"A".repeat(16_100)}\n`);
    writeFileSync(join(dir, "progress.jsonl"), Array.from({ length: 7 }, (_, i) => JSON.stringify({ message: `${i}:${"P".repeat(600)}` })).join("\n"));
    writeFileSync(stdoutPath, "");
    writeFileSync(stderrPath, "container crashed after recording progress");
    return 1;
  };
  await runNext({ runId, workflow: WORKFLOW, dockerExec: failAfterRecording });
  assert.equal(getTask(firstTaskId)!.status, "failed", "fixture must fail after writing its task artifacts");

  const cliOutput = await runCli(["retry", firstTaskId]);
  assert.match(cliOutput, new RegExp(`Retried ${firstTaskId}`), "the real forge retry command accepted the failed workflow task");
  const retryTask = tasksForRun(runId).find((task) => task.id !== firstTaskId)!;
  let packageMd = "";
  const completeAndCapture: DockerExecFn = async ({ args, stdoutPath, stderrPath }) => {
    const dir = dirname(stdoutPath);
    const isRetryPrimary = taskId(args) === retryTask.id;
    if (isRetryPrimary) packageMd = readFileSync(join(dir, "package.md"), "utf8");
    writeFileSync(join(dir, "result.json"), JSON.stringify(isRetryPrimary
      ? { status: "complete", tests_run: 1, files_modified: [] }
      : { status: "complete", verdict: "pass", confidence: 1, findings: [] }));
    writeFileSync(stdoutPath, "");
    writeFileSync(stderrPath, "");
    return 0;
  };
  await runNext({ runId, workflow: WORKFLOW, dockerExec: completeAndCapture });

  assert.equal((packageMd.match(/## What the previous attempt completed/g) ?? []).length, 1, "previous attempt context renders exactly once");
  assert.ok(
    (packageMd.match(/… \[truncated: \d+ more characters\]/g) ?? []).length >= 2,
    "oversized TASKS.md and progress records each retain a visible truncation marker",
  );
  const opening = packageMd.match(/\n(`+)markdown\n/)![1]!;
  const bodyEnd = packageMd.indexOf(`\n${opening}\n`, packageMd.indexOf(`${opening}markdown`) + opening.length);
  assert.ok(opening.length > 40, "the generated fence exceeds the long backtick run supplied by prior agent output");
  assert.ok(bodyEnd > packageMd.indexOf("`".repeat(40)), "the prior TASKS.md backticks stay inside the generated fence");
  assert.equal(getTask(retryTask.id)!.status, "complete");
});
