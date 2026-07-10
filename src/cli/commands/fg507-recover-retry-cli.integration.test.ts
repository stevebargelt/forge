// FG-507, production surface: the recover → cancel → retry sequence driven
// through the REAL CLI command paths, not through performInspect/performCancel/
// retry() directly.
//
// The sibling file (fg507-recover-retry-adhoc.integration.test.ts) pins the
// internals. This one pins that the commander action handlers actually wire
// them together — that `forge recover` names the two commands, and that running
// those exact commands as an operator would (through `program.parseAsync`, with
// every default the CLI supplies: the real run lock, the real containerAlive
// probe, the real defaultDockerExec) re-dispatches the ad-hoc task and finalizes
// the run.
//
// The only thing stubbed is the container-exec boundary itself: a fake `docker`
// on PATH. Everything above it — buildDockerArgs, defaultDockerExec's spawn,
// killContainer, defaultContainerAlive's inspect — runs for real against it.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { Command } from "commander";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../../store/db.js";
import { insertRun, getRun } from "../../store/runs.js";
import { insertTask, getTask, tasksForRun } from "../../store/tasks.js";
import { taskDir } from "../../util/paths.js";
import { failureKindForTask } from "../../v2/failure-kind.js";
import { invoke, createInvokeRun, type DockerExecFn } from "../../v2/invoke.js";
import { loadWorkflow } from "../../v2/loader.js";
import { isRunSettled } from "../../v2/ready-queue.js";
import { registerRecover } from "./recover.js";
import { registerCancel } from "./cancel.js";
import { registerRetry } from "./retry.js";
import type { Task } from "../../types/index.js";

const WORKFLOW_NAME = "fg507cliwf";

let db: DatabaseInstance;
let prev: DatabaseInstance | null;
const tmpDirs: string[] = [];
let savedPath: string | undefined;
let savedApiKey: string | undefined;

const REDISPATCH_RESULT = { status: "complete", note: "redispatched through the CLI" };

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

/** A fake `docker` first on PATH — the one boundary this test stubs.
 *
 *  `run`     writes the agent's result.json into whatever host dir is bind-mounted
 *            at /task, exactly as a real container would, then exits 0.
 *  `inspect` reports the container as genuinely gone, which is what makes
 *            `forge recover` treat the row as orphaned rather than live.
 *  `kill`/`rm` succeed silently — `forge cancel` and the retention sweep call them. */
function stubDockerOnPath(): string {
  const binDir = mkdtempSync(join(tmpdir(), "forge-fg507-bin-"));
  tmpDirs.push(binDir);
  const docker = join(binDir, "docker");
  writeFileSync(
    docker,
    `#!/usr/bin/env bash
case "$1" in
  run)
    for a in "$@"; do
      case "$a" in
        *:/task|*:/task:*)
          host="\${a%%:/task*}"
          mkdir -p "$host"
          printf '%s' '${JSON.stringify(REDISPATCH_RESULT)}' > "$host/result.json"
          ;;
      esac
    done
    echo "stub container stdout"
    exit 0
    ;;
  inspect)
    echo "Error: No such object: \$*" >&2
    exit 1
    ;;
  *) exit 0 ;;
esac
`,
  );
  chmodSync(docker, 0o755);
  return binDir;
}

function trackedProjectDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "forge-fg507-cli-proj-"));
  tmpDirs.push(dir);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fg507-cli-fixture" }));
  return dir;
}

/** A one-step workflow, resolvable as a project override, for the
 *  `forge invoke --run <workflow-run>` shape. */
function writeWorkflowYaml(projectDir: string): void {
  mkdirSync(join(projectDir, ".forge", "workflows"), { recursive: true });
  writeFileSync(
    join(projectDir, ".forge", "workflows", `${WORKFLOW_NAME}.yml`),
    `name: ${WORKFLOW_NAME}
description: fg507 cli fixture
inputs: []
steps:
  - id: build
    agent: engineer
    gate: auto
`,
  );
}

/** Never resolves: forge's process was killed mid-exec, so the row is stuck
 *  `running` with a real manifest and a container that no longer exists. */
const hangingExec: DockerExecFn = async () => new Promise<number>(() => {});

async function settle(): Promise<void> {
  await new Promise((r) => setImmediate(r));
}

async function startHangingInvoke(projectDir: string): Promise<{ runId: string; task: Task }> {
  const runId = createInvokeRun("engineer", projectDir, undefined, "fg507 cli e2e", undefined);
  void invoke({ agentRole: "engineer", task: "fix the scope guard", projectDir, runId, dockerExec: hangingExec });
  await settle();
  return { runId, task: tasksForRun(runId)[0]! };
}

/** Run one CLI command exactly as `bin/forge` does, capturing its stdout. */
async function runCli(register: (p: Command) => void, argv: string[]): Promise<string> {
  const program = new Command();
  program.exitOverride();
  register(program);
  const lines: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
  console.error = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
  try {
    await program.parseAsync(argv, { from: "user" });
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
  return lines.join("\n");
}

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
  setupRuntimeStub();
  savedPath = process.env["PATH"];
  process.env["PATH"] = `${stubDockerOnPath()}:${savedPath ?? ""}`;
  savedApiKey = process.env["ANTHROPIC_API_KEY"];
  process.env["ANTHROPIC_API_KEY"] = "sk-stub";
});

afterEach(() => {
  if (savedPath === undefined) delete process.env["PATH"];
  else process.env["PATH"] = savedPath;
  if (savedApiKey === undefined) delete process.env["ANTHROPIC_API_KEY"];
  else process.env["ANTHROPIC_API_KEY"] = savedApiKey;
  setDbForTest(prev as DatabaseInstance);
  db.close();
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

test("FG-507 CLI e2e: `forge recover` (human + --json) names cancel→retry, and running those two commands through the CLI re-dispatches the ad-hoc task and finalizes the run", async () => {
  const projectDir = trackedProjectDir();
  const { runId, task } = await startHangingInvoke(projectDir);
  assert.equal(task.status, "running", "fixture: a real invoke row, stuck running");

  // ── forge recover <task> ── human surface.
  const human = await runCli(registerRecover, ["recover", task.id]);
  assert.match(human, new RegExp(`Task ${task.id} — recoverable evidence:`));
  assert.match(human, /next:\s+.*forge cancel/, "the human `next:` line must name the cancel");
  assert.ok(human.includes(`forge cancel ${task.id}`), `expected the cancel command in:\n${human}`);
  assert.ok(human.includes(`forge retry ${task.id}`), `expected the retry command in:\n${human}`);

  // ── forge recover <task> --json ── the orchestrator surface.
  const jsonOut = await runCli(registerRecover, ["recover", task.id, "--json"]);
  const outcome = JSON.parse(jsonOut) as {
    kind: string;
    task: { taskId: string; status: string; recommendationCommands: string[] };
  };
  assert.equal(outcome.kind, "inspect-task");
  assert.equal(outcome.task.taskId, task.id);
  assert.equal(outcome.task.status, "running");
  assert.deepEqual(
    outcome.task.recommendationCommands,
    [`forge cancel ${task.id}`, `forge retry ${task.id}`],
    "the JSON surface must carry the exact two commands, in order",
  );

  // ── Execute EXACTLY the recommended commands, through the CLI. ──
  const [cancelCmd, retryCmd] = outcome.task.recommendationCommands as [string, string];
  assert.equal(cancelCmd, `forge cancel ${task.id}`);
  assert.equal(retryCmd, `forge retry ${task.id}`, "post-cancel kind `cancelled` is retryable — no --force");

  await runCli(registerCancel, cancelCmd.split(" ").slice(1));
  assert.equal(getTask(task.id)!.status, "failed", "forge cancel marked the stuck row failed");
  assert.equal(failureKindForTask(task.id), "cancelled");
  assert.equal(getRun(runId)!.status, "active", "a bare task cancel must not abandon the run");

  const retryOut = await runCli(registerRetry, retryCmd.split(" ").slice(1));
  assert.equal(process.exitCode ?? 0, 0, `forge retry must exit clean:\n${retryOut}`);

  // The retry minted a fresh ad-hoc row and dispatched it directly — the output
  // says so, and never points the operator at `forge next`.
  assert.match(retryOut, /is an ad-hoc task .* so the workflow ready queue would never dispatch it/s);
  assert.doesNotMatch(retryOut, /forge next/, "an ad-hoc retry must never print the `forge next` pointer");
  assert.match(retryOut, /✓ engineer complete/);

  const newTask = tasksForRun(runId).find((t) => t.id !== task.id);
  assert.ok(newTask, "retry inserted a replacement row");
  assert.equal(getTask(newTask.id)!.status, "complete", "the ad-hoc row dispatched through the real docker boundary and ingested its result");
  assert.deepEqual(getTask(newTask.id)!.result, REDISPATCH_RESULT);
  assert.equal(newTask.taskPackage.dispatchSource, "invoke", "the replacement carries the provenance marker forward");

  assert.equal(getRun(runId)!.status, "complete", "with no top-level task in flight, invoke's own finalize closes the run");

  // Lineage reached the agent: the package the container would have read.
  const pkgPath = join(taskDir(runId, newTask.id), "package.md");
  assert.ok(existsSync(pkgPath), "the re-dispatch materialized a real task dir");
});

test("FG-507 CLI e2e: mid-retry, the run is NOT settled — a concurrent forge next / gate cannot finalize it out from under the ad-hoc dispatch", async () => {
  // `forge retry` releases the run lock before dispatching the ad-hoc container
  // (matching `forge invoke`'s concurrency profile), so there is a real window
  // where the replacement row is pending and no lock protects it. Every
  // finalize path — runNext's two checks, gate's finalizeRunIfDone — gates on
  // isRunSettled. Snapshot that predicate exactly inside the window.
  const projectDir = trackedProjectDir();
  writeWorkflowYaml(projectDir);
  const runId = "run-fg507-cli-attached";
  insertRun({ id: runId, workflow: WORKFLOW_NAME, title: "attached", status: "active", createdAt: "2026-07-10T00:00:00Z", projectDir });
  insertTask({
    id: "task-build",
    runId,
    phase: "build",
    agentRole: "engineer",
    status: "complete",
    taskPackage: { taskId: "task-build", runId, phase: "build", role: "engineer", inputs: {}, composedSystemPrompt: "" },
    createdAt: "2026-07-10T00:00:00Z",
  });

  // `forge invoke --run <workflow-run>`: an ad-hoc row attached to a run whose
  // only workflow step is already complete. Pre-fix, that run read as settled.
  void invoke({ agentRole: "engineer", task: "fix the scope guard", projectDir, runId, dockerExec: hangingExec });
  await settle();
  const adHoc = tasksForRun(runId).find((t) => t.phase === "task")!;

  await runCli(registerCancel, ["cancel", adHoc.id]);
  assert.equal(getRun(runId)!.status, "active", "the workflow run survives a task-level cancel");

  const workflow = loadWorkflow(WORKFLOW_NAME, { projectDir });
  assert.equal(
    isRunSettled(workflow, tasksForRun(runId)),
    true,
    "baseline: with the ad-hoc row terminal (cancelled) and `build` complete, the run IS settled",
  );

  // retry.ts logs the "is an ad-hoc task…" line after inserting the pending
  // replacement row and before dispatching it — precisely the unlocked window.
  let settledMidFlight: boolean | undefined;
  const program = new Command();
  registerRetry(program);
  const origLog = console.log;
  console.log = (...a: unknown[]) => {
    if (String(a[0]).includes("is an ad-hoc task")) {
      settledMidFlight = isRunSettled(workflow, tasksForRun(runId));
    }
  };
  try {
    await program.parseAsync(["retry", adHoc.id], { from: "user" });
  } finally {
    console.log = origLog;
  }

  assert.equal(
    settledMidFlight,
    false,
    "the pending ad-hoc replacement must hold the run unsettled — otherwise a concurrent forge next/gate finalizes it mid-dispatch",
  );
  assert.equal(getRun(runId)!.status, "complete", "and once the ad-hoc container returns, the run finalizes normally");
  assert.equal(
    isRunSettled(workflow, tasksForRun(runId)),
    true,
    "a terminal ad-hoc row blocks nothing — settledness falls back to the workflow steps",
  );
});
