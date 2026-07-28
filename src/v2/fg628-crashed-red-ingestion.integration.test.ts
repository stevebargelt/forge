// FG-628 Half B: a red that produced no review must not ingest as a non-blocking
// `inconclusive`.
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
// The invariant (AC 5, widened by operator decision 2026-07-28) is keyed on the
// REVIEW ARTIFACT, not on the container: a verdict forge SYNTHESIZED because no
// review came back means the panel is incomplete and blocks, orthogonally to
// authority. A verdict a reviewer AUTHORED — including a genuine `inconclusive` —
// is an opinion and keeps today's behavior.
//
// The traps this file is built to catch, each of which has already been sprung:
//
//   • Both crashed reds were SPECIALIST. FG-586's `resultUnreadable` channel blocks
//     only when `authority === "authoritative" && gate_on_verdict`, so implementing
//     this by extending that channel produces a change that passes review and lets
//     the exact reported gate open. Every blocking assertion here is therefore made
//     against a specialist red.
//   • Keying on an enumerated set of failure kinds fails open on the kind nobody
//     enumerated. The marker is set at the ONE place forge fabricates a verdict
//     (runOneRed's failure return), so a future death mode inherits it for free.
//   • Keying on the container lifecycle fails open too, and B6 is the case that
//     proves it: in ATTACHED mode (`FORGE_DETACHED_EXEC=off`) `defaultDockerExec`
//     fires `onContainerStarted` the instant the docker CLIENT is spawned, before
//     the daemon has created anything. A mount failure there records
//     `container.started` and still never reviewed a byte.
//
// AC 5 asserts BOTH directions, and the second is what keeps this from being a
// blanket "any red failure blocks": a genuine reviewed-but-undecided `inconclusive`
// must still ingest exactly as it does today (B2), and so must AWN-5's downgrade of
// an unsubstantiated `fail` (B7).

import { test, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, mkdtempSync, rmSync, chmodSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { Command } from "commander";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { tasksForRun } from "../store/tasks.js";
import { verdictsForRun } from "../store/verdicts.js";
import { eventsForRun } from "../store/events.js";
import { failureKindForTask } from "./failure-kind.js";
import { startRun } from "./startRun.js";
import { runNext, type DockerExecFn } from "./runNext.js";
import { productionDockerExec } from "./docker-exec.js";
import type { Workflow } from "./schema.js";
import { publishFlatAsGeneration } from "./seed-generation.testkit.js";
import { registerShow } from "../cli/commands/show.js";

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

const ENV_VARS = ["ANTHROPIC_API_KEY", "FORGE_WORKTREES", "FORGE_NO_WORKTREES", "FORGE_DETACHED_EXEC"] as const;
const savedEnv: Partial<Record<(typeof ENV_VARS)[number], string>> = {};
// PATH is restored, never deleted — B6 prepends a stub `docker` onto it.
let savedPath: string | undefined;

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
  for (const k of ENV_VARS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  savedPath = process.env.PATH;
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
  if (savedPath !== undefined) process.env.PATH = savedPath;
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
 *  point of the file is that "produced no review" and "ran and returned a verdict"
 *  must land differently.
 *
 *  `startsContainer` reports a container start (`signalsContainerStart` +
 *  `onContainerStarted`) exactly like the production detached executor, which fires
 *  the callback only once `docker run -d` has succeeded. Under the widened rule it
 *  is a DIAGNOSTIC, not a condition: B1 and B5 differ only in this flag and must
 *  land identically. */
async function runWithRed(redBehavior: { exitCode: number; result?: unknown; startsContainer?: boolean }) {
  const projectDir = makeTmpDir();
  const { runId } = startRun({
    workflow: WORKFLOW_SPECIALIST_RED,
    title: "fg628 half B",
    inputs: {},
    projectDir,
  });

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
    // The red. A container that never starts writes NO result.json — that
    // combination (no start signal, non-zero exit, no result) is exactly what the
    // docker mount failure produces, and the exit half is what classify() reads as
    // container_crash.
    if (redBehavior.startsContainer !== false) onContainerStarted?.();
    if (redBehavior.result !== undefined) {
      writeFileSync(join(dir, "result.json"), JSON.stringify(redBehavior.result));
    }
    return redBehavior.exitCode;
  };
  exec.signalsContainerStart = true;

  const wave = await runNext({ runId, workflow: WORKFLOW_SPECIALIST_RED, dockerExec: exec });
  return { runId, wave };
}

const MISSING_SUMMARY_MARKER = "produced NO review";

// ─── (B1) direction one: a crashed red BLOCKS, orthogonally to authority ──────

test("(fg628-B1) a SPECIALIST red killed by a PRE-CONTAINER crash BLOCKS — the panel is incomplete regardless of rank", async () => {
  const { runId, wave } = await runWithRed({ exitCode: 1, startsContainer: false });

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
  const crashFinding = verdict!.findings.find((f) => f.summary.includes(MISSING_SUMMARY_MARKER));
  assert.ok(
    crashFinding !== undefined,
    `the verdict must carry a finding naming the crash — that finding is what forge show prints under the ` +
      `'inconclusive (0.00)' line and is the only thing distinguishing it from a real undecided review. Got: ` +
      JSON.stringify(verdict!.findings),
  );
  assert.equal(crashFinding!.severity, "high", "an unexecuted review is a HIGH-severity fact, not a note");

  const crashEvent = eventsForRun(runId).find((e) => e.eventType === "verdict.review_missing");
  assert.ok(crashEvent !== undefined, "verdict.review_missing must be on the timeline");
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
    !verdict!.findings.some((f) => f.summary.includes(MISSING_SUMMARY_MARKER)),
    "no crash finding may be injected into a verdict the reviewer actually produced",
  );
  assert.equal(
    eventsForRun(runId).find((e) => e.eventType === "verdict.review_missing"),
    undefined,
    "verdict.review_missing must not fire for a red that ran",
  );
});

// ─── (B3) a red that RAN and PASSED is likewise untouched ────────────────────

test("(fg628-B3) a red that RAN and passed advances the phase — the new channel fires only on a verdict forge synthesized", async () => {
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

// ─── (B5) a POST-START crash with no result blocks too ────────────────────────

test("(fg628-B5) a red whose container STARTED and then crashed with no result BLOCKS — the container lifecycle does not decide completeness", async () => {
  // Same failure_kind as B1 (`container_crash`: non-zero exit, no result.json), and
  // the ONLY difference from B1 is the start signal. Under the widened rule they must
  // land IDENTICALLY: whatever the container did, no reviewer authored a verdict, so
  // the panel is incomplete. An earlier cut of FG-628 keyed the block on
  // `containerStarted === false` and this input advanced the phase — the fail-open
  // this assertion exists to prevent.
  const { runId, wave } = await runWithRed({ exitCode: 1, startsContainer: true });

  const primary = tasksForRun(runId).find((t) => t.agentRole === "engineer" && t.parentId === undefined);
  assert.ok(
    !wave.completedSteps.includes("build"),
    "build must NOT complete — a red that died mid-review still produced no reviewable artifact",
  );
  assert.equal(primary!.status, "blocked_by_red");

  const redTask = tasksForRun(runId).find((t) => t.agentRole === "red-wide" && t.parentId !== undefined);
  assert.equal(
    failureKindForTask(redTask!.id),
    "container_crash",
    "non-vacuity: this really is the same failure_kind B1 blocks on — only the start outcome differs",
  );
  assert.ok(
    eventsForRun(runId).some((e) => e.eventType === "container.started" && e.taskId === redTask!.id),
    "non-vacuity: this container really was recorded as started — the signal the narrow rule trusted",
  );

  const verdict = verdictsForRun(runId).find((v) => v.redRole === "red-wide");
  assert.equal(verdict!.verdict, "inconclusive");
  assert.ok(
    verdict!.findings.some((f) => f.summary.includes(MISSING_SUMMARY_MARKER)),
    `the synthesized verdict must be marked as such; got ${JSON.stringify(verdict!.findings)}`,
  );

  const ev = eventsForRun(runId).find((e) => e.eventType === "verdict.review_missing");
  assert.ok(ev !== undefined, "verdict.review_missing must be on the timeline");
  const payload = ev!.payload as Record<string, unknown>;
  assert.equal(payload["failureKind"], "container_crash", "the failure kind rides in the payload as a DIAGNOSTIC");
  assert.equal(payload["containerStarted"], true, "so does the container lifecycle — recorded for the operator, not consulted for the block");
});

// ─── (B6) the case that defeated the narrow rule: ATTACHED-mode startup failure ─

test("(fg628-B6) an ATTACHED-mode docker startup failure BLOCKS, even though the executor already signalled container.started", async () => {
  // Driven through the REAL production executor selection with
  // FORGE_DETACHED_EXEC=off, against a stub `docker` on PATH that refuses `run` the
  // way the live FG-628 mount failure did. defaultDockerExec fires onContainerStarted
  // the instant the docker CLIENT is spawned (docker-exec.ts:198) — before the daemon
  // has created a container — so this red records `container.started` and then dies
  // having reviewed nothing. Keyed on the container lifecycle, this advances the
  // phase; keyed on provenance, it blocks.
  process.env.FORGE_DETACHED_EXEC = "off";
  const binDir = makeTmpDir();
  const dockerStub = join(binDir, "docker");
  // Touched only on `run`, so the assertions below can tell a real refused-startup
  // from a `docker`-not-on-PATH spawn error, which would land the same exit shape.
  const runWitness = join(binDir, "run-was-attempted");
  writeFileSync(
    dockerStub,
    `#!/bin/sh
if [ "$1" = "run" ]; then
  : > '${runWitness}'
  echo 'docker: Error response from daemon: failed to create task for container: runc create failed: error mounting "/var/lib/docker/volumes/forge-deps-x-dashboard/_data" to rootfs at "/project/dashboard/node_modules": read-only file system: unknown' >&2
  exit 125
fi
exit 0
`,
  );
  chmodSync(dockerStub, 0o755);
  process.env.PATH = `${binDir}:${process.env.PATH ?? ""}`;

  const projectDir = makeTmpDir();
  const { runId } = startRun({
    workflow: WORKFLOW_SPECIALIST_RED,
    title: "fg628 half B attached",
    inputs: {},
    projectDir,
  });

  // The primary is faked so the wave reaches its red; the RED goes through the real
  // production executor, which FORGE_DETACHED_EXEC=off routes to the attached one.
  const exec: DockerExecFn = async (execArgs) => {
    const taskId = taskIdFromDockerArgs(execArgs.args);
    if (taskId.startsWith("task-build-")) {
      const dir = dirname(execArgs.stdoutPath);
      mkdirSync(dir, { recursive: true });
      writeFileSync(execArgs.stdoutPath, "");
      writeFileSync(execArgs.stderrPath, "");
      execArgs.onContainerStarted?.();
      writeFileSync(join(dir, "result.json"), JSON.stringify(PRIMARY_RESULT));
      return 0;
    }
    return productionDockerExec(execArgs);
  };
  exec.signalsContainerStart = true;

  const wave = await runNext({ runId, workflow: WORKFLOW_SPECIALIST_RED, dockerExec: exec });

  const redTask = tasksForRun(runId).find((t) => t.agentRole === "red-wide" && t.parentId !== undefined);
  assert.ok(redTask !== undefined, "the red must have been dispatched");
  assert.ok(existsSync(runWitness), "non-vacuity: the attached executor really spawned `docker run` and it really refused");
  assert.equal(failureKindForTask(redTask!.id), "container_crash", "non-vacuity: exit 125 with no result classifies container_crash");
  assert.ok(
    eventsForRun(runId).some((e) => e.eventType === "container.started" && e.taskId === redTask!.id),
    "non-vacuity: the attached executor DID record container.started — that is the whole trap",
  );

  assert.ok(!wave.completedSteps.includes("build"), "build must NOT complete — nothing reviewed the artifact");
  const primary = tasksForRun(runId).find((t) => t.agentRole === "engineer" && t.parentId === undefined);
  assert.equal(
    primary!.status,
    "blocked_by_red",
    "a docker startup failure in attached mode must block: containerStarted=true here is an artifact of when the callback fires, not evidence a review happened",
  );
  const verdict = verdictsForRun(runId).find((v) => v.redRole === "red-wide");
  assert.ok(verdict!.findings.some((f) => f.summary.includes(MISSING_SUMMARY_MARKER)));
  assert.ok(
    eventsForRun(runId).some((e) => e.eventType === "verdict.review_missing"),
    "verdict.review_missing must be on the timeline",
  );
});

// ─── (B7) the other guard: AWN-5's downgrade is reviewer-AUTHORED, not synthesized ─

test("(fg628-B7) an unsubstantiated `fail` downgraded to `inconclusive` by AWN-5 still does NOT block", async () => {
  // dispatchReds synthesizes an inconclusive here too — but from a verdict the
  // reviewer really authored, which forge then transformed because its findings did
  // not survive grading. That is rule 2, not rule 3. Widen the block to "any verdict
  // forge rewrote" and this test fails; that would break the unsubstantiated-fail
  // downgrade outright.
  const { runId, wave } = await runWithRed({
    exitCode: 0,
    result: { status: "complete", verdict: "fail", confidence: 0.9, findings: [] },
  });

  assert.ok(wave.completedSteps.includes("build"), "build MUST complete — an unsubstantiated fail has no case to act on");
  const primary = tasksForRun(runId).find((t) => t.agentRole === "engineer" && t.parentId === undefined);
  assert.equal(primary!.status, "complete");

  const verdict = verdictsForRun(runId).find((v) => v.redRole === "red-wide");
  assert.equal(verdict!.verdict, "inconclusive", "non-vacuity: AWN-5 really did downgrade the fail");
  assert.equal(verdict!.findings.length, 0, "no synthetic finding on a verdict the reviewer authored");
  assert.equal(
    eventsForRun(runId).find((e) => e.eventType === "verdict.review_missing"),
    undefined,
    "verdict.review_missing must not fire for a reviewer-authored verdict",
  );
});

// ─── (B4) the event and the block it describes are one transition ────────────

// FG-482's invariant applied to this channel: the timeline must never claim a red
// never ran unless the verdict that BLOCKS the gate is persisted too. Written
// outside and ahead of insertVerdict, a crash (or a failing insert) leaves the
// unsafe half — an operator reads "review never ran" while nothing stops the gate.
//
// Forces the verdict insert to fail with the same technique
// fg482-blocked-by-red-atomicity.test.ts uses for its own write (a BEFORE INSERT
// trigger that RAISE(ABORT)s) and asserts the event rolled back with it.
test("(fg628-B4) a failed verdict insert leaves NO verdict.review_missing event behind — the event and the block it describes roll back together", async () => {
  db.exec(`
    CREATE TRIGGER force_fail_verdict_insert
    BEFORE INSERT ON verdicts
    BEGIN
      SELECT RAISE(ABORT, 'forced failure for fg628 ordering test');
    END;
  `);

  await assert.rejects(
    () => runWithRed({ exitCode: 1, startsContainer: false }),
    /forced failure for fg628 ordering test/,
    "runNext must propagate the forced insertVerdict failure",
  );

  const leftoverEvents = db
    .prepare(`SELECT COUNT(*) AS n FROM events WHERE event_type = 'verdict.review_missing'`)
    .get() as { n: number };
  assert.equal(
    leftoverEvents.n,
    0,
    "a verdict.review_missing event with no persisted verdict is the UNSAFE half-state: the timeline claims " +
      "no review ran while nothing blocks the gate",
  );

  const persistedVerdicts = db.prepare(`SELECT COUNT(*) AS n FROM verdicts`).get() as { n: number };
  assert.equal(persistedVerdicts.n, 0, "non-vacuity: the insert really did fail");
});

// ─── (B8/B9) the operator surface: `forge show` must render the distinction ────

// Everything above reads the STORE. AC 5 is about what an orchestrator can see, and
// the only thing an orchestrator sees is `forge show` — so a renderer regression
// (dropping the synthetic finding, dropping the event from --json) would collapse a
// never-reviewed phase back into a generic inconclusive with every assertion above
// still green. These two drive the real CLI over the real crashed-red fixture.

async function renderShowCli(args: string[]): Promise<string> {
  const lines: string[] = [];
  mock.method(console, "log", (...a: unknown[]) => {
    lines.push(a.map(String).join(" "));
  });
  try {
    const program = new Command();
    registerShow(program);
    await program.parseAsync(args, { from: "user" });
    return lines.join("\n");
  } finally {
    mock.restoreAll();
  }
}

function primaryAndRedIds(runId: string): { primaryId: string; redTaskId: string } {
  const tasks = tasksForRun(runId);
  const primary = tasks.find((t) => t.agentRole === "engineer" && t.parentId === undefined);
  const red = tasks.find((t) => t.agentRole === "red-wide" && t.parentId !== undefined);
  assert.ok(primary !== undefined && red !== undefined, "fixture must have a primary and a red task");
  return { primaryId: primary!.id, redTaskId: red!.id };
}

type ShowJson = {
  task: { status: string };
  events: Array<{ eventType: string; payload?: Record<string, unknown> }>;
  verdicts: Array<{ redTaskId: string; verdict: string; findings: Array<{ severity: string; summary: string }> }>;
};

test("(fg628-B8) `forge show` renders the never-reviewed distinction on BOTH surfaces — human finding + id, and --json finding + verdict.review_missing payload", async () => {
  const { runId } = await runWithRed({ exitCode: 1, startsContainer: false });
  const { primaryId, redTaskId } = primaryAndRedIds(runId);

  const human = await renderShowCli(["show", primaryId]);
  assert.match(
    human,
    /^ {2}- red-wide \(specialist\): inconclusive \(0\.00\) — \S+$/m,
    `the verdict line must render; got:\n${human}`,
  );
  assert.ok(
    human.includes(redTaskId),
    "the human output must name the red task id — it is the argument for the `forge show <redTaskId>` next-command",
  );
  const findingLine = human
    .split("\n")
    .find((l) => l.includes(MISSING_SUMMARY_MARKER));
  assert.ok(
    findingLine,
    `the human Verdicts section must print the produced-NO-review finding — without it this is indistinguishable ` +
      `from a reviewer that looked and could not decide. Got:\n${human}`,
  );
  assert.match(findingLine!, /^ +\[high\] /, "and it must print at HIGH severity, not as an ordinary note");
  assert.ok(
    human.includes("verdict.review_missing"),
    "the timeline must carry verdict.review_missing",
  );

  const json = JSON.parse(await renderShowCli(["show", primaryId, "--json"])) as ShowJson;
  assert.equal(json.task.status, "blocked_by_red", "non-vacuity: --json is describing the blocked primary");

  const verdict = json.verdicts.find((v) => v.redTaskId === redTaskId);
  assert.ok(verdict !== undefined, "--json must carry the red's verdict");
  const synthetic = verdict!.findings.find((f) => f.summary.includes(MISSING_SUMMARY_MARKER));
  assert.ok(
    synthetic !== undefined,
    `--json verdict findings must carry the synthetic finding; got ${JSON.stringify(verdict!.findings)}`,
  );
  assert.equal(synthetic!.severity, "high");

  const ev = json.events.find((e) => e.eventType === "verdict.review_missing");
  assert.ok(ev !== undefined, "--json events must carry verdict.review_missing — the machine-readable half of AC 5");
  assert.equal(ev!.payload?.["redRole"], "red-wide");
  assert.equal(ev!.payload?.["redTaskId"], redTaskId, "the payload names the red to inspect");
  assert.equal(ev!.payload?.["authority"], "specialist");
  assert.equal(ev!.payload?.["failureKind"], "container_crash");
});

test("(fg628-B9) `forge show` over a reviewer-AUTHORED inconclusive carries NEITHER marker — the distinction is real, not decoration", async () => {
  const { runId } = await runWithRed({
    exitCode: 0,
    result: { status: "complete", verdict: "inconclusive", confidence: 0.4, findings: [] },
  });
  const { primaryId, redTaskId } = primaryAndRedIds(runId);

  const human = await renderShowCli(["show", primaryId]);
  assert.match(
    human,
    /^ {2}- red-wide \(specialist\): inconclusive \(0\.40\) — \S+$/m,
    `non-vacuity: the genuine inconclusive really did render; got:\n${human}`,
  );
  assert.ok(!human.includes(MISSING_SUMMARY_MARKER), "no produced-NO-review finding on a review that happened");
  assert.ok(!human.includes("verdict.review_missing"), "no verdict.review_missing on the timeline");

  const json = JSON.parse(await renderShowCli(["show", primaryId, "--json"])) as ShowJson;
  const verdict = json.verdicts.find((v) => v.redTaskId === redTaskId);
  assert.ok(verdict !== undefined, "non-vacuity: --json really is carrying this red's verdict");
  assert.deepEqual(verdict!.findings, [], "no synthetic finding may be injected into a verdict the reviewer authored");
  assert.equal(
    json.events.find((e) => e.eventType === "verdict.review_missing"),
    undefined,
    "verdict.review_missing must be absent from --json events too",
  );
});
