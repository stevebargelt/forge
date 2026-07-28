// FG-628 followup coverage: the ingestion channels that SHARE dispatchReds with
// the new `reviewNeverRan` channel, and the boundary of what that channel claims.
//
// FG-628 added a third blocking channel to dispatchReds. Two were already there:
//
//   • FG-420 — an authoritative `shipping-reviewer` whose verdict came back
//     `inconclusive` (needs_human / unrecognized / no result) blocks, prepending a
//     synthetic HIGH finding.
//   • FG-586 — ANY authoritative `gate_on_verdict` red whose result payload was
//     UNREADABLE (`result_malformed` / `result_missing`) fails CLOSED, prepending
//     its own synthetic HIGH finding.
//
// The FG-628 channel is deliberately orthogonal to authority, which is exactly what
// makes it capable of disturbing the other two. This file pins three properties the
// implementation's own tests do not cover:
//
//   1. NON-REGRESSION. Both adjacent channels still fire on the inputs they always
//      fired on, still block, still carry their own finding — and are NOT
//      contaminated by the new one (no crash finding, no `verdict.review_never_ran`
//      event on a red that actually ran).
//   2. ORDERING. FG-628's finding is prepended BEHIND FG-420's on purpose: an
//      existing reader that takes `findings[0]` to be FG-420's synthetic finding
//      must not break. (`fg420-7` in
//      fg420-shipping-reviewer-authoritative.integration.test.ts is exactly such a
//      reader, and it asserts `findings[0]`.) When a crash ALSO trips the FG-420
//      trigger, BOTH facts must be kept and FG-420's must still be at the head. That
//      guarantee is load-bearing and was untested.
//   3. THE DEATH-MODE BOUNDARY. Only `container_crash` sets `reviewNeverRan`.
//      `oom_killed`, `idle_timeout` and `model_error` deliberately still ingest as
//      NON-blocking `inconclusive` in this cut. That is the CURRENT contract, pinned
//      here so the follow-up that widens it has a baseline and so nobody widens it by
//      accident. Every death-mode test asserts the red task's recorded failure_kind,
//      so a mode that silently reclassifies fails loudly instead of passing vacuously.
//
// Tier: integration — real task dirs on a real (temp) filesystem, real dispatch.

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
import { failureKindForTask } from "./failure-kind.js";
import { IDLE_TIMEOUT_EXIT_CODE } from "./idle-watchdog.js";
import { startRun } from "./startRun.js";
import { runNext, type DockerExecFn } from "./runNext.js";
import type { Workflow } from "./schema.js";
import { publishFlatAsGeneration } from "./seed-generation.testkit.js";

const RUNTIME = "fg628-channels-test";

// The marker the FG-628 channel's synthetic finding is identified by. Kept in one
// place: every "must not be contaminated" assertion below is a search for it.
const CRASH_SUMMARY_MARKER = "never ran";
const FG420_SUMMARY_MARKER = "shippable verdict";
const FG586_SUMMARY_MARKER = "UNREADABLE";

type RedSpec = { agent: string; authority: "authoritative" | "specialist"; gate_on_verdict: boolean };

function workflowFor(name: string, red: RedSpec): Workflow {
  return {
    name,
    description: `FG-628 channel boundary fixture (${red.agent}/${red.authority})`,
    inputs: [],
    steps: [
      {
        id: "build",
        agent: "engineer",
        gate: "auto",
        manual: false,
        depends_on: [],
        runtime: RUNTIME,
        reds: [red],
      },
    ],
  };
}

// An AUTHORITATIVE gate_on_verdict red that is NOT the shipping-reviewer — the
// FG-586 channel's own class.
const WF_AUTH_RED_WIDE = workflowFor("fg628-auth-red-wide", {
  agent: "red-wide",
  authority: "authoritative",
  gate_on_verdict: true,
});
// The same red demoted to SPECIALIST — FG-586 blocks only authoritative reds, and
// that scoping must survive the arrival of an authority-orthogonal channel.
const WF_SPECIALIST_RED_WIDE = workflowFor("fg628-specialist-red-wide", {
  agent: "red-wide",
  authority: "specialist",
  gate_on_verdict: true,
});
// The FG-420 channel's own class.
const WF_AUTH_SHIPPING = workflowFor("fg628-auth-shipping", {
  agent: "shipping-reviewer",
  authority: "authoritative",
  gate_on_verdict: true,
});
// The weakest possible rank — the configuration the live crash hit, used for the
// death-mode boundary so a non-block can never be attributed to low authority
// having been the reason.
const WF_SPECIALIST_ADVISORY = workflowFor("fg628-specialist-advisory", {
  agent: "red-wide",
  authority: "specialist",
  gate_on_verdict: false,
});

const ALL_WORKFLOWS = [WF_AUTH_RED_WIDE, WF_SPECIALIST_RED_WIDE, WF_AUTH_SHIPPING, WF_SPECIALIST_ADVISORY];

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
  for (const wf of ALL_WORKFLOWS) ensureWorkflowYaml(wf);
  publishFlatAsGeneration(process.env.FORGE_HOME!);
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
  const dir = mkdtempSync(join(tmpdir(), "forge-fg628-ch-"));
  tmpDirs.push(dir);
  return dir;
}

function ensureRuntime(): void {
  const runtimePath = join(process.env.FORGE_HOME!, "runtimes", `${RUNTIME}.yml`);
  mkdirSync(dirname(runtimePath), { recursive: true });
  // No explicit log_format: the schema defaults a non-codex runtime to
  // claude-stream-json, which is what routes the model_error case below through
  // analyzeClaudeFailure. Pinning it here would be pinning the fixture, not the
  // production default the boundary test needs to exercise.
  writeFileSync(
    runtimePath,
    `name: ${RUNTIME}
description: FG-628 channel-boundary test runtime stub
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

function ensureWorkflowYaml(wf: Workflow): void {
  const red = wf.steps[0]!.reds![0]!;
  const wfPath = join(process.env.FORGE_HOME!, "workflows", `${wf.name}.yml`);
  mkdirSync(dirname(wfPath), { recursive: true });
  writeFileSync(
    wfPath,
    `name: ${wf.name}
description: "${wf.description}"
inputs: []
steps:
  - id: build
    agent: engineer
    gate: auto
    manual: false
    depends_on: []
    runtime: ${RUNTIME}
    reds:
      - agent: ${red.agent}
        authority: ${red.authority}
        gate_on_verdict: ${red.gate_on_verdict}
`,
  );
}

function taskIdFromDockerArgs(args: string[]): string {
  const i = args.indexOf("--name");
  return (i >= 0 ? (args[i + 1] ?? "") : "").replace(/^forge-/, "");
}

/** The shipping-reviewer resolves a ticket for its reviewer-context packet; without
 *  one the run blocks on `shippingReviewerPreFailed` and never reaches the channel
 *  under test. Mirrors the fixture fg420-*'s tests use. */
function writeStructuredTicket(projectDir: string, id: string): void {
  const storiesDir = join(projectDir, "backlog", "stories");
  mkdirSync(storiesDir, { recursive: true });
  writeFileSync(
    join(storiesDir, `${id}-fg628-channel-fixture.md`),
    ["---", `id: ${id}`, "type: story", "status: active", "title: FG-628 channel fixture", "---", ""].join("\n") +
      "## Acceptance Criteria\n\n- The channel under test fires\n\n",
  );
}

const PRIMARY_RESULT = { status: "complete", tests_run: 1, files_modified: [], commitSha: "deadbeef" };

/** What the red's container does. Exactly one of these shapes per test — the whole
 *  point of the file is that they must land differently. */
type RedBehavior = {
  exitCode: number;
  /** Written to result.json verbatim. Omit for the "produced nothing" shapes. */
  rawResult?: string;
  /** Written to the container's stdout log — the only input the provider-failure
   *  analyzer reads, and therefore the only way to reach `model_error`. */
  stdout?: string;
};

async function drive(wf: Workflow, redBehavior: RedBehavior) {
  const projectDir = makeTmpDir();
  const ticketId = "FG-T628C";
  writeStructuredTicket(projectDir, ticketId);

  const { runId } = startRun({ workflow: wf, title: `fg628 channels ${wf.name}`, inputs: { ticketId }, projectDir });

  const exec: DockerExecFn = async ({ args, stdoutPath, stderrPath }) => {
    const taskId = taskIdFromDockerArgs(args);
    const dir = dirname(stdoutPath);
    mkdirSync(dir, { recursive: true });
    writeFileSync(stderrPath, "");
    if (taskId.startsWith("task-build-")) {
      writeFileSync(stdoutPath, "");
      writeFileSync(join(dir, "result.json"), JSON.stringify(PRIMARY_RESULT));
      return 0;
    }
    writeFileSync(stdoutPath, redBehavior.stdout ?? "");
    if (redBehavior.rawResult !== undefined) {
      writeFileSync(join(dir, "result.json"), redBehavior.rawResult);
    }
    return redBehavior.exitCode;
  };

  const wave = await runNext({ runId, workflow: wf, dockerExec: exec });
  const redRole = wf.steps[0]!.reds![0]!.agent;
  const tasks = tasksForRun(runId);
  return {
    runId,
    wave,
    primary: tasks.find((t) => t.agentRole === "engineer" && t.parentId === undefined)!,
    redTask: tasks.find((t) => t.agentRole === redRole && t.parentId !== undefined)!,
    verdict: verdictsForRun(runId).find((v) => v.redRole === redRole)!,
    reviewNeverRanEvents: eventsForRun(runId).filter((e) => e.eventType === "verdict.review_never_ran"),
  };
}

// A stray byte in the MIDDLE of the document — the shape FG-586's bounded envelope
// strip deliberately does NOT salvage, so it stays `result_malformed`.
const MALFORMED_RESULT = '{"status":"complete","verdict":"fa%%il","confidence":0.9,"findings":[}';

// ─── (1) FG-586's channel still fires, and is not contaminated ────────────────

test("(fg628-C1) FG-586 non-regression: an AUTHORITATIVE gate_on_verdict red with an unreadable result still fails CLOSED — and the FG-628 channel stays out of it", async () => {
  const r = await drive(WF_AUTH_RED_WIDE, { exitCode: 0, rawResult: MALFORMED_RESULT });

  assert.ok(!r.wave.completedSteps.includes("build"), "build must NOT complete — unreadable authoritative output fails closed");
  assert.equal(r.primary.status, "blocked_by_red", "FG-586's block is unchanged by FG-628's arrival");
  assert.equal(r.verdict.verdict, "inconclusive", "the recorded verdict value is unchanged");

  // Non-vacuity: this really is the unreadable path, not a crash wearing its clothes.
  assert.equal(
    failureKindForTask(r.redTask.id),
    "result_malformed",
    "the red must have failed as result_malformed — if this reclassifies, the test below proves nothing",
  );

  const head = r.verdict.findings[0];
  assert.ok(head !== undefined, "FG-586's synthetic finding must be persisted");
  assert.ok(
    head!.summary.includes(FG586_SUMMARY_MARKER),
    `FG-586's finding must still be at findings[0]; got ${JSON.stringify(r.verdict.findings)}`,
  );
  assert.equal(head!.severity, "high");

  // Contamination guard: a red whose container RAN did not fail to review — the
  // FG-628 channel must be silent on this input, in both the finding list and the
  // event stream.
  assert.ok(
    !r.verdict.findings.some((f) => f.summary.includes(CRASH_SUMMARY_MARKER)),
    "no crash finding may be injected into an unreadable-result verdict — its container ran",
  );
  assert.equal(r.reviewNeverRanEvents.length, 0, "verdict.review_never_ran must not fire for result_malformed");
});

test("(fg628-C2) FG-586 scoping non-regression: a SPECIALIST red with an unreadable result still advances the phase", async () => {
  // FG-586 blocks only `authority === "authoritative" && gate_on_verdict`. FG-628's
  // channel is authority-orthogonal, so the risk being pinned here is the reverse of
  // C1: that the new channel widened blocking to every red that produced no usable
  // verdict. It must not have — the boundary is the death mode, not the outcome.
  const r = await drive(WF_SPECIALIST_RED_WIDE, { exitCode: 0, rawResult: MALFORMED_RESULT });

  assert.ok(r.wave.completedSteps.includes("build"), "build MUST complete — a specialist's unreadable result is non-blocking, exactly as before");
  assert.equal(r.primary.status, "complete");
  assert.equal(failureKindForTask(r.redTask.id), "result_malformed", "non-vacuity: really the unreadable path");
  assert.equal(r.verdict.verdict, "inconclusive");
  assert.equal(r.verdict.findings.length, 0, "no synthetic finding is prepended for a specialist unreadable result");
  assert.equal(r.reviewNeverRanEvents.length, 0, "verdict.review_never_ran must not fire");
});

// ─── (2) FG-420's trigger still fires on a red that RAN ───────────────────────

test("(fg628-C3) FG-420 non-regression: an authoritative shipping-reviewer that RAN and returned `inconclusive` still blocks with its own finding at the head", async () => {
  const r = await drive(WF_AUTH_SHIPPING, {
    exitCode: 0,
    rawResult: JSON.stringify({ status: "complete", verdict: "needs_human", confidence: 0.5, findings: [] }),
  });

  assert.ok(!r.wave.completedSteps.includes("build"), "build must NOT complete — FG-420's hard block on needs_human is unchanged");
  assert.equal(r.primary.status, "blocked_by_red");
  assert.equal(r.verdict.verdict, "inconclusive");
  assert.equal(r.verdict.findings.length, 1, "exactly one synthetic finding — FG-420's, and nothing from FG-628");
  assert.ok(
    r.verdict.findings[0]!.summary.includes(FG420_SUMMARY_MARKER),
    `FG-420's finding must be at findings[0]; got ${JSON.stringify(r.verdict.findings)}`,
  );
  assert.equal(r.reviewNeverRanEvents.length, 0, "the reviewer ran and returned a verdict — review_never_ran must not fire");
});

// ─── (3) THE ORDERING GUARANTEE ───────────────────────────────────────────────

test("(fg628-C4) ORDERING: when a crash ALSO trips FG-420, BOTH findings are kept and FG-420's is still at findings[0]", async () => {
  // This is the property the engineer hit live: `fg420-7` asserts `findings[0]` is
  // FG-420's synthetic finding on exactly this input (an authoritative
  // shipping-reviewer whose container crashed with no result.json). FG-628 prepends
  // its own finding too — and it is prepended FIRST, so that FG-420's prepend lands
  // in front of it. Reverse the two blocks in dispatchReds and this test fails while
  // every "does it block" assertion in the suite still passes: the block is not the
  // fragile part, the head of the list is.
  const r = await drive(WF_AUTH_SHIPPING, { exitCode: 1 });

  assert.equal(failureKindForTask(r.redTask.id), "container_crash", "non-vacuity: the reviewer's container really crashed");
  assert.equal(r.primary.status, "blocked_by_red", "both channels agree this blocks");
  assert.equal(r.verdict.verdict, "inconclusive", "the verdict value stays inconclusive under both channels");

  const summaries = r.verdict.findings.map((f) => f.summary);
  assert.equal(
    r.verdict.findings.length,
    2,
    `both facts must be kept — FG-420's "no shippable verdict" AND FG-628's "never ran"; got ${JSON.stringify(summaries)}`,
  );

  // The pin. An existing reader that takes findings[0] to be FG-420's must not break.
  assert.ok(
    r.verdict.findings[0]!.summary.includes(FG420_SUMMARY_MARKER),
    `FG-420's synthetic finding must remain at the HEAD of the list; got ${JSON.stringify(summaries)}`,
  );
  assert.ok(
    r.verdict.findings[1]!.summary.includes(CRASH_SUMMARY_MARKER),
    `FG-628's crash finding must sit directly BEHIND it, not in front; got ${JSON.stringify(summaries)}`,
  );
  assert.equal(r.verdict.findings[1]!.severity, "high", "the crash finding keeps its HIGH severity when it rides behind FG-420's");
  assert.ok(
    r.verdict.findings[1]!.evidence?.includes(r.redTask.id),
    "the crash finding must still name the red's task id so `forge show <id>` is actionable",
  );

  // Both channels are independently observable on the timeline, not merged.
  assert.equal(r.reviewNeverRanEvents.length, 1, "verdict.review_never_ran fires exactly once, even when FG-420 also blocks");
});

// ─── (4) THE DEATH-MODE BOUNDARY — current contract, pinned ───────────────────
//
// Only container_crash sets reviewNeverRan in this cut. The three modes below are a
// deliberate, documented exclusion, NOT an oversight — they are pinned so that
// widening the channel is a visible, intentional edit to this file rather than an
// accident, and so the follow-up that widens it starts from a stated baseline.

test("(fg628-C5) boundary: `oom_killed` (exit 137, no result) still ingests as a NON-blocking inconclusive", async () => {
  const r = await drive(WF_SPECIALIST_ADVISORY, { exitCode: 137 });

  assert.equal(
    failureKindForTask(r.redTask.id),
    "oom_killed",
    "non-vacuity: exit 137 with no result must classify oom_killed, not container_crash — if this ever changes, the assertion below silently changes meaning",
  );
  assert.ok(r.wave.completedSteps.includes("build"), "CURRENT CONTRACT: an OOM-killed red does not block in this cut");
  assert.equal(r.primary.status, "complete");
  assert.equal(r.verdict.verdict, "inconclusive");
  assert.equal(r.verdict.findings.length, 0, "no synthetic finding for an OOM-killed red today");
  assert.equal(r.reviewNeverRanEvents.length, 0, "reviewNeverRan is scoped to container_crash");
});

test("(fg628-C6) boundary: `idle_timeout` still ingests as a NON-blocking inconclusive", async () => {
  const r = await drive(WF_SPECIALIST_ADVISORY, { exitCode: IDLE_TIMEOUT_EXIT_CODE });

  assert.equal(
    failureKindForTask(r.redTask.id),
    "idle_timeout",
    "non-vacuity: the watchdog exit code must classify idle_timeout",
  );
  assert.ok(r.wave.completedSteps.includes("build"), "CURRENT CONTRACT: an idle-timed-out red does not block in this cut");
  assert.equal(r.primary.status, "complete");
  assert.equal(r.verdict.verdict, "inconclusive");
  assert.equal(r.verdict.findings.length, 0);
  assert.equal(r.reviewNeverRanEvents.length, 0, "reviewNeverRan is scoped to container_crash");
});

test("(fg628-C7) boundary: `model_error` still ingests as a NON-blocking inconclusive — even though its exit shape is identical to a crash", async () => {
  // The sharpest edge of the boundary: this red exits non-zero with NO result.json —
  // byte-identical to the container_crash shape — and is diverted to `model_error`
  // only because the provider analyzer found an error event in its structured stdout.
  // So the boundary is decided by classification, not by the exit shape, and a change
  // to either side moves it.
  const r = await drive(WF_SPECIALIST_ADVISORY, {
    exitCode: 1,
    stdout: JSON.stringify({ type: "error", message: "model overloaded (529)" }) + "\n",
  });

  assert.equal(
    failureKindForTask(r.redTask.id),
    "model_error",
    "non-vacuity: the provider analyzer must have diverted this away from container_crash — otherwise this test is just C4 again",
  );
  assert.ok(r.wave.completedSteps.includes("build"), "CURRENT CONTRACT: a model_error red does not block in this cut");
  assert.equal(r.primary.status, "complete");
  assert.equal(r.verdict.verdict, "inconclusive");
  assert.equal(r.verdict.findings.length, 0);
  assert.equal(r.reviewNeverRanEvents.length, 0, "reviewNeverRan is scoped to container_crash");
});
