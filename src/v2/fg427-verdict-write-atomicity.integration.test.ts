// FG-427 write-path atomicity: the verdicts table row and its matching
// verdict.received event must commit as one transaction. FG-427 makes the
// events table the SOLE source (alongside gate.decided) both the drive path
// (reconcileTerminalOutcome) and the reconcile command use to derive an
// item's authoritative outcome — a crash between the two writes would leave
// the events table missing a verdict the verdicts table already has, and
// outcome derivation would silently miss it.
//
// Forces the SECOND write (logEvent("verdict.received")) to fail via a
// trigger on the events table, keyed off a marker embedded in the red's
// agent name (which flows straight into the event payload as redRole), and
// asserts the FIRST write (insertVerdict) was rolled back too — drives the
// real dispatchReds path through runNext(), not a hand-rolled reimplementation.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { tasksForRun } from "../store/tasks.js";
import { verdictsForRun } from "../store/verdicts.js";
import { eventsForTask } from "../store/events.js";
import { startRun } from "./startRun.js";
import { runNext } from "./runNext.js";
import type { DockerExecFn } from "./runNext.js";
import type { Workflow } from "./schema.js";

// A single non-shipping-reviewer red — no ticket/context-packet machinery needed.
function workflowWithRed(runtimeName: string, redAgent: string): Workflow {
  return {
    name: runtimeName,
    description: "FG-427 verdict write-path atomicity integration test",
    inputs: [],
    steps: [
      {
        id: "build",
        agent: "engineer",
        gate: "auto",
        manual: false,
        depends_on: [],
        runtime: runtimeName,
        reds: [{ agent: redAgent, authority: "specialist", gate_on_verdict: false }],
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
  const dir = mkdtempSync(join(tmpdir(), "forge-fg427-"));
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
description: FG-427 dispatch test runtime stub
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

function installForceFailTrigger(): void {
  db.exec(`
    CREATE TRIGGER force_fail_verdict_received
    BEFORE INSERT ON events
    WHEN NEW.event_type = 'verdict.received' AND NEW.payload LIKE '%force-fail-marker-red%'
    BEGIN
      SELECT RAISE(ABORT, 'forced failure for atomicity test');
    END;
  `);
}

function makeExec(): DockerExecFn {
  return async ({ args, stdoutPath, stderrPath }) => {
    const taskId = taskIdFromDockerArgs(args);
    const dir = dirname(stdoutPath);
    mkdirSync(dir, { recursive: true });

    const result = taskId.startsWith("task-build-")
      ? { status: "complete", files_modified: [] }
      : { status: "complete", verdict: "pass", confidence: 0.9, findings: [] };

    writeFileSync(join(dir, "result.json"), JSON.stringify(result));
    writeFileSync(stdoutPath, "");
    writeFileSync(stderrPath, "");
    return 0;
  };
}

test("integ FG-427 atomicity: verdict.received logEvent failure rolls back insertVerdict (no orphaned verdict row)", async () => {
  const runtimeName = "fg427-atomicity-fail-test";
  ensureRuntime(runtimeName);
  const workflow = workflowWithRed(runtimeName, "force-fail-marker-red");
  installForceFailTrigger();

  const projectDir = makeTmpDir();
  const { runId } = startRun({
    workflow,
    title: "fg427 verdict atomicity forced-failure test",
    inputs: {},
    projectDir,
  });

  await assert.rejects(
    () => runNext({ runId, workflow, dockerExec: makeExec() }),
    /forced failure for atomicity test/,
    "runNext must propagate the forced logEvent failure",
  );

  assert.deepEqual(
    verdictsForRun(runId),
    [],
    "insertVerdict must be rolled back when the paired logEvent throws — no orphaned verdict row",
  );

  const tasks = tasksForRun(runId);
  const redTask = tasks.find((t) => t.agentRole === "force-fail-marker-red");
  assert.ok(redTask, "red task row must still exist (insertTask happens before the atomic verdict write)");
  // verdict.received is logged against the PRIMARY task id (runNext.ts's
  // `args.primaryTaskId`), not the red's own task id.
  const primaryTask = tasks.find((t) => t.agentRole === "engineer" && t.parentId === undefined);
  assert.ok(primaryTask, "primary engineer task row must exist");
  const primaryEvents = eventsForTask(primaryTask!.id);
  assert.equal(
    primaryEvents.filter((e) => e.eventType === "verdict.received").length,
    0,
    "no verdict.received event must be recorded when the write failed",
  );
});

test("integ FG-427 atomicity: verdict.received happy path still writes both insertVerdict and logEvent", async () => {
  const runtimeName = "fg427-atomicity-happy-test";
  ensureRuntime(runtimeName);
  const workflow = workflowWithRed(runtimeName, "red-wide");
  installForceFailTrigger(); // present but inert — payload won't match the marker

  const projectDir = makeTmpDir();
  const { runId } = startRun({
    workflow,
    title: "fg427 verdict atomicity happy-path test",
    inputs: {},
    projectDir,
  });

  const wave = await runNext({ runId, workflow, dockerExec: makeExec() });
  assert.ok(wave.completedSteps.includes("build"), "build step must complete on the happy path");

  const verdicts = verdictsForRun(runId);
  assert.equal(verdicts.length, 1, "insertVerdict must have written exactly one row on the happy path");
  assert.equal(verdicts[0]!.verdict, "pass");

  const tasks = tasksForRun(runId);
  const redTask = tasks.find((t) => t.agentRole === "red-wide");
  assert.ok(redTask, "red task row must exist");
  // verdict.received is logged against the PRIMARY task id, not the red's own task id.
  const primaryTask = tasks.find((t) => t.agentRole === "engineer" && t.parentId === undefined);
  assert.ok(primaryTask, "primary engineer task row must exist");
  const primaryEvents = eventsForTask(primaryTask!.id);
  const verdictEvents = primaryEvents.filter((e) => e.eventType === "verdict.received");
  assert.equal(verdictEvents.length, 1, "logEvent must have written exactly one verdict.received event on the happy path");
  assert.equal((verdictEvents[0]!.payload as Record<string, unknown>).verdict, "pass");
});
