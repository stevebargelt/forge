// FG-628 Half B: a red that never started its container must not ingest as a
// non-blocking `inconclusive`.
//
// Live evidence (dogfood 4, run-fg-628-…-3dc222): both architect reds died with
// `container_crash (exit 1)` before their agent ever ran, both were ingested as
//
//     - red-wide   (specialist): inconclusive (0.00)
//     - red-narrow (specialist): inconclusive (0.00)
//
// and the phase advanced to `awaiting_gate` with ZERO adversarial review having
// executed. An orchestrator reading that gate cannot tell it apart from "both reds
// reviewed the artifact and could not decide". Silence read as success — and that
// is what made the mount crash (Half A) invisible for four consecutive dogfoods.
//
// The two traps this file is built to catch:
//
//   • Both crashed reds were SPECIALIST. FG-586's `resultUnreadable` channel blocks
//     only when `authority === "authoritative" && gate_on_verdict`, so implementing
//     this by extending that channel produces a change that passes review and lets
//     the exact reported gate open. Every blocking assertion here is therefore made
//     against a specialist red.
//   • The distinction is destroyed one call BEFORE the seam that needs it:
//     runContainer's container-crash branch was the only one of its three `failed`
//     returns that dropped `failureKind`, so at runOneRed a container_crash was
//     indistinguishable from any other dispatch failure.
//
// AC 5 asserts BOTH directions, and the second is what keeps this from being a
// blanket "any red failure blocks": a genuine reviewed-but-undecided `inconclusive`
// must still ingest exactly as it does today.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { tasksForRun } from "../store/tasks.js";
import { verdictsForRun } from "../store/verdicts.js";
import { eventsForRun } from "../store/events.js";
import { startRun } from "./startRun.js";
import { runNext, type DockerExecFn } from "./runNext.js";
import type { Workflow } from "./schema.js";
import { publishFlatAsGeneration } from "./seed-generation.testkit.js";

const RUNTIME = "fg628-red-test";

// The red under test is SPECIALIST with gate_on_verdict FALSE — the weakest
// possible rank, and the exact configuration under which the live gate opened. If
// blocking here were routed through authority, none of it would fire.
const WORKFLOW_SPECIALIST_RED: Workflow = {
  name: "fg628-red-test",
  description: "FG-628: a crashed red is not a review outcome",
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

const ENV_VARS = ["ANTHROPIC_API_KEY", "FORGE_WORKTREES", "FORGE_NO_WORKTREES"] as const;
const savedEnv: Partial<Record<(typeof ENV_VARS)[number], string>> = {};

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
  for (const k of ENV_VARS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  ensureRuntime();
  ensureWorkflowYaml();
});

afterEach(() => {
  setDbForTest(prev as DatabaseInstance);
  db.close();
  for (const k of ENV_VARS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k] as string;
  }
  for (const dir of tmpDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch { /* best-effort */ }
  }
});

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "forge-fg628-red-"));
  tmpDirs.push(dir);
  return dir;
}

function ensureRuntime(): void {
  const runtimePath = join(process.env.FORGE_HOME!, "runtimes", `${RUNTIME}.yml`);
  mkdirSync(dirname(runtimePath), { recursive: true });
  writeFileSync(
    runtimePath,
    `name: ${RUNTIME}
description: FG-628 crashed-red ingestion test runtime stub
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
  publishFlatAsGeneration(process.env.FORGE_HOME!);
}

function ensureWorkflowYaml(): void {
  const wfPath = join(process.env.FORGE_HOME!, "workflows", `${WORKFLOW_SPECIALIST_RED.name}.yml`);
  mkdirSync(dirname(wfPath), { recursive: true });
  writeFileSync(
    wfPath,
    `name: ${WORKFLOW_SPECIALIST_RED.name}
description: "FG-628: a crashed red is not a review outcome"
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

function taskIdFromDockerArgs(args: string[]): string {
  const i = args.indexOf("--name");
  return (i >= 0 ? (args[i + 1] ?? "") : "").replace(/^forge-/, "");
}

const PRIMARY_RESULT = { status: "complete", tests_run: 1, files_modified: [], commitSha: "deadbeef" };

/** Drives one wave. `redBehavior` decides what the red's container does — the whole
 *  point of the file is that "crashed before producing anything" and "ran and
 *  returned inconclusive" must land differently. */
async function runWithRed(redBehavior: { exitCode: number; result?: unknown }) {
  const projectDir = makeTmpDir();
  const { runId } = startRun({
    workflow: WORKFLOW_SPECIALIST_RED,
    title: "fg628 half B",
    inputs: {},
    projectDir,
  });

  const exec: DockerExecFn = async ({ args, stdoutPath, stderrPath }) => {
    const taskId = taskIdFromDockerArgs(args);
    const dir = dirname(stdoutPath);
    mkdirSync(dir, { recursive: true });
    writeFileSync(stdoutPath, "");
    writeFileSync(stderrPath, "");
    if (taskId.startsWith("task-build-")) {
      writeFileSync(join(dir, "result.json"), JSON.stringify(PRIMARY_RESULT));
      return 0;
    }
    // The red. A container that crashes before its agent runs writes NO
    // result.json — that combination (non-zero exit, no result) is exactly what
    // the docker mount failure produces, and it is what classify() reads as
    // container_crash.
    if (redBehavior.result !== undefined) {
      writeFileSync(join(dir, "result.json"), JSON.stringify(redBehavior.result));
    }
    return redBehavior.exitCode;
  };

  const wave = await runNext({ runId, workflow: WORKFLOW_SPECIALIST_RED, dockerExec: exec });
  return { runId, wave };
}

const CRASH_SUMMARY_MARKER = "never ran";

// ─── (B1) direction one: a crashed red BLOCKS, orthogonally to authority ──────

test("(fg628-B1) a SPECIALIST red whose container crashed before producing a verdict BLOCKS — the panel is incomplete regardless of rank", async () => {
  const { runId, wave } = await runWithRed({ exitCode: 1 });

  assert.ok(
    !wave.completedSteps.includes("build"),
    "build must NOT complete — a phase whose adversarial review never executed cannot advance on its own",
  );

  const primary = tasksForRun(runId).find((t) => t.agentRole === "engineer" && t.parentId === undefined);
  assert.ok(primary !== undefined, "primary engineer task must exist");
  assert.notEqual(
    primary!.status,
    "awaiting_gate",
    "awaiting_gate is the exact landing the live incident produced — an orchestrator reads it as 'reviewed, undecided'",
  );
  assert.equal(
    primary!.status,
    "blocked_by_red",
    "a red that never ran must land the primary blocked_by_red — a human decision, not a silent advance. " +
      "This red is SPECIALIST with gate_on_verdict false: routing this through authority (FG-586's channel) leaves this gate open.",
  );

  // The durable record has to say WHY, or the block is just an unexplained stall.
  const verdict = verdictsForRun(runId).find((v) => v.redRole === "red-wide");
  assert.ok(verdict !== undefined, "the red's verdict row must still be recorded");
  assert.equal(verdict!.authority, "specialist", "non-vacuity: the blocking red really is specialist");
  assert.equal(
    verdict!.verdict,
    "inconclusive",
    "the verdict value stays inconclusive — fabricating a `fail` would misreport the red as having judged the artifact",
  );
  const crashFinding = verdict!.findings.find((f) => f.summary.includes(CRASH_SUMMARY_MARKER));
  assert.ok(
    crashFinding !== undefined,
    `the verdict must carry a finding naming the crash — that finding is what forge show prints under the ` +
      `'inconclusive (0.00)' line and is the only thing distinguishing it from a real undecided review. Got: ` +
      JSON.stringify(verdict!.findings),
  );
  assert.equal(crashFinding!.severity, "high", "an unexecuted review is a HIGH-severity fact, not a note");

  const crashEvent = eventsForRun(runId).find((e) => e.eventType === "verdict.review_never_ran");
  assert.ok(crashEvent !== undefined, "verdict.review_never_ran must be on the timeline");
});

// ─── (B2) direction two: a genuine reviewed-but-undecided verdict is UNCHANGED ─

test("(fg628-B2) a red that RAN and returned a genuine `inconclusive` still ingests as a non-blocking inconclusive — exactly as today", async () => {
  // The other half of AC 5. Without this, "block on a crashed red" is
  // indistinguishable from "block on every inconclusive", which would break every
  // pipeline that uses a specialist red as an advisory voice.
  const { runId, wave } = await runWithRed({
    exitCode: 0,
    result: { status: "complete", verdict: "inconclusive", confidence: 0.4, findings: [] },
  });

  assert.ok(wave.completedSteps.includes("build"), "build MUST complete — a real undecided review is non-blocking");

  const primary = tasksForRun(runId).find((t) => t.agentRole === "engineer" && t.parentId === undefined);
  assert.equal(primary!.status, "complete", "a reviewed-but-undecided specialist verdict must not block");

  const verdict = verdictsForRun(runId).find((v) => v.redRole === "red-wide");
  assert.ok(verdict !== undefined, "the red's verdict row must be recorded");
  assert.equal(verdict!.verdict, "inconclusive", "the real verdict is preserved");
  assert.equal(verdict!.confidence, 0.4, "the reviewer's own confidence is preserved, not zeroed");
  assert.ok(
    !verdict!.findings.some((f) => f.summary.includes(CRASH_SUMMARY_MARKER)),
    "no crash finding may be injected into a verdict the reviewer actually produced",
  );
  assert.equal(
    eventsForRun(runId).find((e) => e.eventType === "verdict.review_never_ran"),
    undefined,
    "verdict.review_never_ran must not fire for a red that ran",
  );
});

// ─── (B3) a red that RAN and PASSED is likewise untouched ────────────────────

test("(fg628-B3) a red that RAN and passed advances the phase — the new channel fires only on a container that produced nothing", async () => {
  const { runId, wave } = await runWithRed({
    exitCode: 0,
    result: { status: "complete", verdict: "pass", confidence: 0.95, findings: [] },
  });

  assert.ok(wave.completedSteps.includes("build"), "build must complete on a passing red");
  const primary = tasksForRun(runId).find((t) => t.agentRole === "engineer" && t.parentId === undefined);
  assert.equal(primary!.status, "complete");
  const verdict = verdictsForRun(runId).find((v) => v.redRole === "red-wide");
  assert.equal(verdict!.verdict, "pass");
  assert.equal(verdict!.findings.length, 0, "a clean pass must carry no synthetic findings");
});
