// FG-523 (F19) — the ENFORCEMENT half of the validation contract, driven through
// the real ingestion path (runNext → dispatch → finalizePrimary, stubbed docker
// exec). The evaluator's own unit tests (validation-contract.test.ts) prove the
// decision function; these prove the RUNNER acts on it — the half that keeps
// getting violated is "the rule exists but nothing enforces it".
//
// The angle here is spoof-shaped results: a result that LOOKS like it validated
// but doesn't satisfy the contract. tests_run as a STRING ("17" — the shape a
// model emits when it fills a template from prose), a negative count, a waiver
// that is present but empty or whitespace. Each must HOLD. The one shape that
// advances is a real waiver over an honest tests_run: 0.
//
// Complement to the engineer's fg523-validation-contract.integration.test.ts,
// which covers the plain missing/zero cases, the happy path and the degraded
// (no result.json) path. No overlap intended: every case below is a shape that
// file does not drive.

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { runNext, type DockerExecFn } from "./runNext.js";
import { publishFlatAsGeneration } from "./seed-generation.testkit.js";
import { startRun } from "./startRun.js";
import { computeReadyQueue, isRunSettled } from "./ready-queue.js";
import { tasksForRun, getTask } from "../store/tasks.js";
import { eventsForTask } from "../store/events.js";
import type { Workflow, RedDef } from "./schema.js";

function ensureRuntime(): void {
  const runtimePath = join(process.env.FORGE_HOME!, "runtimes", "claude.yml");
  if (!existsSync(runtimePath)) {
    mkdirSync(dirname(runtimePath), { recursive: true });
    writeFileSync(runtimePath, `name: claude
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
  // FG-583: publish the flat runtime as a complete generation so dispatch resolves it.
  publishFlatAsGeneration(process.env.FORGE_HOME!);
}

// Routes by container name so a red returns a verdict while the primary returns
// the implementer result under test.
function stubExec(primaryResult: unknown, redResult?: unknown): DockerExecFn {
  return async ({ args, stdoutPath, stderrPath }) => {
    const nameIdx = args.indexOf("--name");
    const taskId = (nameIdx >= 0 ? args[nameIdx + 1] ?? "" : "").replace(/^forge-/, "");
    const dir = dirname(stdoutPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const result = taskId.startsWith("task-red-") ? redResult : primaryResult;
    if (result !== undefined) writeFileSync(join(dir, "result.json"), JSON.stringify(result));
    writeFileSync(stdoutPath, "stub stdout");
    writeFileSync(stderrPath, "");
    return 0;
  };
}

// Two steps — "after" depends on "build". A hold on `build` must leave `after`
// undispatched: that is what makes the hold a GATE rather than a log line.
function workflow(name: string, agent: string, reds: RedDef[] = []): Workflow {
  return {
    name,
    description: "FG-523 enforcement negative space",
    inputs: [],
    steps: [
      { id: "build", agent, gate: "auto", manual: false, depends_on: [], runtime: "claude", reds },
      { id: "after", agent: "docs-agent", gate: "auto", manual: false, depends_on: ["build"], runtime: "claude", reds: [] },
    ],
  };
}

async function run(wf: Workflow, primaryResult: unknown, redResult?: unknown) {
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  ensureRuntime();
  const { runId } = startRun({ workflow: wf, title: wf.name, inputs: {}, projectDir: "/tmp/test-project" });
  const exec = stubExec(primaryResult, redResult);
  const wave = await runNext({ runId, workflow: wf, dockerExec: exec });
  // runNext dispatches ONE wave per call, so "the downstream step didn't run" is
  // vacuously true after a single wave — it would be true of a passing step too.
  // The second wave is what makes the gating claim discriminating: it is the
  // wave in which `after` WOULD dispatch if `build` had been released.
  const nextWave = await runNext({ runId, workflow: wf, dockerExec: exec });
  return { runId, wave, nextWave, build: tasksForRun(runId).find((t) => t.phase === "build")! };
}

function holdReasonFor(taskId: string): string | undefined {
  const held = eventsForTask(taskId)
    .filter((e) => e.eventType === "task.awaiting_gate")
    .at(-1);
  const payload = held?.payload as Record<string, unknown> | undefined;
  return payload?.["kind"] === "validation_contract" ? String(payload["reason"]) : undefined;
}

// Each spoof is a result an implementer could plausibly emit that LOOKS validated.
// `observed` is the fragment the hold reason must echo back — the operator has to
// be able to see WHICH spoof was rejected, not just that something was.
const SPOOFS: { label: string; result: Record<string, unknown>; observed: RegExp }[] = [
  {
    label: 'tests_run as a STRING ("17")',
    result: { status: "complete", tests_run: "17", tests_passed: "17" },
    observed: /tests_run="17"/,
  },
  {
    label: "tests_run negative (-1)",
    result: { status: "complete", tests_run: -1 },
    observed: /tests_run=-1/,
  },
  {
    label: "waiver present but EMPTY string",
    result: { status: "complete", no_validation_reason: "" },
    observed: /no tests_run/,
  },
  {
    label: "waiver present but WHITESPACE only",
    result: { status: "complete", no_validation_reason: "   " },
    observed: /no tests_run/,
  },
  {
    label: "both spoofed: string tests_run AND a whitespace waiver",
    result: { status: "complete", tests_run: "17", no_validation_reason: "\t\n " },
    observed: /tests_run="17"/,
  },
];

SPOOFS.forEach((spoof, i) => {
  test(`FG-523 F19 enforcement: ${spoof.label} → HELD at ingestion, never advanced`, async () => {
    const wf = workflow(`fg523-spoof-${i}`, "engineer");
    const { runId, wave, nextWave, build } = await run(wf, spoof.result);

    assert.equal(build.status, "awaiting_gate", `${spoof.label} must not satisfy the contract`);
    assert.deepEqual(wave.completedSteps, [], "the spoofed step must not complete");
    assert.deepEqual(wave.awaitingGate, ["build"], "the run surfaces the hold rather than advancing");

    const reason = holdReasonFor(build.id);
    assert.ok(reason, "the hold must carry a named validation_contract reason");
    assert.match(reason!, /^validation contract: engineer returned status=complete/);
    assert.match(reason!, spoof.observed, "the reason must name the observed value, not just 'invalid'");
    assert.match(reason!, /no no_validation_reason waiver/);

    // The load-bearing assertion: the hold GATES the run. A second `forge next`
    // over the held run is a clean no-op — it must neither release the step nor
    // re-ingest the spoofed result as a completion.
    assert.deepEqual(nextWave.completedSteps, [], "a second wave must not release the held step");
    assert.deepEqual(nextWave.failedSteps, [], "nor fail it");
    assert.equal(
      tasksForRun(runId).find((t) => t.phase === "after"),
      undefined,
      "no downstream step may dispatch past a held task",
    );
    assert.equal(getTask(build.id)!.status, "awaiting_gate", "still held after the second wave");

    // …and the hold is a PAUSE, not a wedge: the run is not settled (it is still
    // owed a human decision) and has no ready work to dispatch behind the gate.
    const tasks = tasksForRun(runId);
    assert.equal(isRunSettled(wf, tasks), false, "a held run is still active — parked on the human, not finished");
    assert.deepEqual(computeReadyQueue(wf, tasks).map((s) => s.id), [], "nothing is dispatchable behind the hold");
  });
});

test("FG-523 F19 enforcement: an honest tests_run: 0 WITH a real waiver advances — the waiver is the one legitimate escape", async () => {
  const { wave, nextWave, build } = await run(workflow("fg523-waiver-over-zero", "backend-specialist"), {
    status: "complete",
    tests_run: 0,
    no_validation_reason: "config-only change: no runtime surface to drive",
  });

  assert.equal(build.status, "complete", "a non-empty waiver waives even an explicit zero");
  assert.deepEqual(wave.completedSteps, ["build"]);
  assert.equal(holdReasonFor(build.id), undefined, "no hold event");

  const waiver = eventsForTask(build.id).find(
    (e) => e.eventType === "task.decision" && (e.payload as Record<string, unknown>)["kind"] === "validation_waiver",
  );
  assert.ok(waiver, "the escape must leave a durable record — a silent waiver is the bug, not the feature");
  assert.equal(
    (waiver!.payload as Record<string, unknown>)["reason"],
    "config-only change: no runtime surface to drive",
  );

  // And the run actually proceeds past it — the same second wave that stays
  // empty for every spoof above dispatches the downstream step here.
  assert.deepEqual(nextWave.completedSteps, ["after"], "the waived step releases the downstream step");
});

test("FG-523 F19 scope: test-engineer (a non-implementer) completes with NO tests_run — unchanged", async () => {
  const { wave, build } = await run(workflow("fg523-nonimpl-te", "test-engineer"), {
    status: "complete",
    test_files_written: ["src/v2/x.integration.test.ts"],
  });

  assert.equal(build.status, "complete", "the contract binds implementer roles only");
  assert.deepEqual(wave.completedSteps, ["build"]);
  assert.equal(holdReasonFor(build.id), undefined);
});

test("FG-523 F19 scope: a RED completes with no tests_run — reds are never held, and the primary still advances", async () => {
  const wf = workflow("fg523-nonimpl-red", "engineer", [
    { agent: "red-security", authority: "specialist", gate_on_verdict: true },
  ]);
  const { runId, build } = await run(
    wf,
    { status: "complete", tests_run: 3, tests_passed: 3 },
    { status: "complete", verdict: "pass", confidence: 0.9, findings: [] },
  );

  const red = tasksForRun(runId).find((t) => t.agentRole === "red-security");
  assert.ok(red, "the red dispatched");
  assert.equal(red!.status, "complete", "a red's result carries no tests_run and must never be held for it");
  assert.equal(holdReasonFor(red!.id), undefined);

  assert.equal(getTask(build.id)!.status, "complete", "the primary passed its reds and its own contract");
});
