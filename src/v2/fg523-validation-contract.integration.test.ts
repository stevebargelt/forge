// FG-523 (F19): the tests_run contract, enforced at ingestion.
//
// Implementer seeds require tests_run on a status:complete result and the
// orchestrator treats a missing value as a reject — but the runner used to
// advance such a result silently (done-audit read it informationally, nothing
// enforced it). These tests drive the REAL ingestion path (runNext → dispatch →
// finalizePrimary, with a stubbed docker exec) and lock in:
//
//   - complete + no/zero tests_run, no waiver → awaiting_gate with a NAMED
//     reason, visible in `forge show` human output; downstream stays undispatched
//   - complete + tests_run > 0 → advances exactly as before (parity)
//   - complete + a no_validation_reason waiver → advances, waiver recorded
//   - a non-implementer role (research-specialist) → unchanged, no hold
//   - degraded paths (clean exit, no result.json) keep their existing FAILURE
//     handling — an infra failure must not become a validation hold
//   - re-entry: reconcile over a held task and retry of a held task both refuse
//     to silent-complete it; `forge gate --advance` is the recovery path

import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { Command } from "commander";
import { runNext, type DockerExecFn } from "./runNext.js";
import { publishFlatAsGeneration } from "./seed-generation.testkit.js";
import { startRun } from "./startRun.js";
import { gate } from "./gate.js";
import { retry } from "./retry.js";
import { reconcileRun } from "./reconcile.js";
import { tasksForRun, getTask } from "../store/tasks.js";
import { verdictsForTask } from "../store/verdicts.js";
import { eventsForTask } from "../store/events.js";
import { registerShow } from "../cli/commands/show.js";
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

function stubExec(result: unknown, exitCode = 0): DockerExecFn {
  return async ({ stdoutPath, stderrPath }) => {
    const dir = dirname(stdoutPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    if (result !== undefined) writeFileSync(join(dir, "result.json"), JSON.stringify(result));
    writeFileSync(stdoutPath, "stub stdout");
    writeFileSync(stderrPath, "");
    return exitCode;
  };
}

// Two steps: the second depends on the first, so a held first step must leave
// the second undispatched (the hold actually gates the run).
function workflow(agent: string): Workflow {
  return {
    name: `fg523-${agent}`,
    description: "validation-contract ingestion test",
    inputs: [],
    steps: [
      { id: "build", agent, gate: "auto", manual: false, depends_on: [], runtime: "claude", reds: [] },
      { id: "after", agent: "docs-agent", gate: "auto", manual: false, depends_on: ["build"], runtime: "claude", reds: [] },
    ],
  };
}

// gate() re-loads the workflow from disk by name, so the in-memory Workflow the
// runner is driven with must also exist as YAML in FORGE_HOME.
function ensureWorkflowYaml(wf: Workflow): void {
  const dir = join(process.env.FORGE_HOME!, "workflows");
  mkdirSync(dir, { recursive: true });
  const steps = wf.steps
    .map((s) => `  - id: ${s.id}\n    agent: ${s.agent}\n    gate: ${s.gate}\n    depends_on: [${s.depends_on.join(", ")}]`)
    .join("\n");
  writeFileSync(join(dir, `${wf.name}.yml`), `name: ${wf.name}\ndescription: ${wf.description}\ninputs: []\nsteps:\n${steps}\n`);
  // FG-583: publish the flat workflow as a complete generation so gate.ts resolves it.
  publishFlatAsGeneration(process.env.FORGE_HOME!);
}

function startAndRun(agent: string, result: unknown, exitCode = 0) {
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  ensureRuntime();
  const wf = workflow(agent);
  ensureWorkflowYaml(wf);
  const { runId } = startRun({ workflow: wf, title: `fg523 ${agent}`, inputs: {}, projectDir: "/tmp/test-project" });
  return { runId, wf, wave: runNext({ runId, workflow: wf, dockerExec: stubExec(result, exitCode) }) };
}

function buildTask(runId: string) {
  return tasksForRun(runId).find((t) => t.phase === "build")!;
}

function captureConsoleLog(): string[] {
  const lines: string[] = [];
  mock.method(console, "log", (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
  return lines;
}

test("FG-523 F19: engineer completes with no tests_run and no waiver → held awaiting_gate with a named reason", async () => {
  const { runId, wave } = startAndRun("engineer", { status: "complete", files_modified: [] });
  const w = await wave;

  const build = buildTask(runId);
  assert.equal(build.status, "awaiting_gate", "a complete result with no tests_run must NOT silent-complete");
  assert.deepEqual(w.completedSteps, [], "the step did not complete");
  assert.deepEqual(w.awaitingGate, ["build"], "the run surfaces the gate rather than wedging");

  const held = eventsForTask(build.id).find((e) => e.eventType === "task.awaiting_gate");
  const payload = held?.payload as Record<string, unknown>;
  assert.equal(payload["kind"], "validation_contract");
  assert.match(String(payload["reason"]), /validation contract: engineer returned status=complete with no tests_run/);

  // The hold gates the run: the downstream step must not dispatch.
  const after = tasksForRun(runId).find((t) => t.phase === "after");
  assert.equal(after, undefined, "no downstream step may dispatch past a held task");
});

test("FG-523 F19: the hold reason is visible in `forge show <taskId>` human output", async () => {
  const { runId, wave } = startAndRun("backend-specialist", { status: "complete", tests_run: 0 });
  await wave;
  const build = buildTask(runId);
  assert.equal(build.status, "awaiting_gate", "tests_run: 0 is as much a hold as a missing field");

  const lines = captureConsoleLog();
  try {
    const program = new Command();
    registerShow(program);
    await program.parseAsync(["show", build.id], { from: "user" });
    const out = lines.join("\n");
    assert.match(out, /gate hold: validation contract: backend-specialist returned status=complete with tests_run=0/);
    assert.match(out, /and no no_validation_reason waiver/);
    assert.match(out, new RegExp(`forge gate ${build.id} --advance \\| --reject`), "the recovery path is offered");
  } finally {
    mock.restoreAll();
  }
});

test("FG-523 F19: a held task advances through the existing gate verbs — it does not wedge the run", async () => {
  const { runId, wf, wave } = startAndRun("engineer", { status: "complete" });
  await wave;
  const build = buildTask(runId);
  assert.equal(build.status, "awaiting_gate");

  await gate(build.id, "advance", "validated by hand", {});
  assert.equal(getTask(build.id)!.status, "complete");

  const w2 = await runNext({ runId, workflow: wf, dockerExec: stubExec({ status: "complete" }) });
  assert.deepEqual(w2.completedSteps, ["after"], "the run resumes once the gate is decided");
});

test("FG-523 F19 parity: engineer completes with tests_run > 0 → completes exactly as before", async () => {
  const { runId, wave } = startAndRun("engineer", { status: "complete", tests_run: 12, tests_passed: 12 });
  const w = await wave;

  assert.deepEqual(w.completedSteps, ["build"]);
  assert.equal(buildTask(runId).status, "complete");
});

test("FG-523 F19 waiver: an explicit no_validation_reason advances the task and is recorded", async () => {
  const { runId, wave } = startAndRun("frontend-specialist", {
    status: "complete",
    no_validation_reason: "no visual verification path for React Native",
  });
  const w = await wave;

  const build = buildTask(runId);
  assert.deepEqual(w.completedSteps, ["build"]);
  assert.equal(build.status, "complete");

  const waiver = eventsForTask(build.id).find(
    (e) => e.eventType === "task.decision" && (e.payload as Record<string, unknown>)["kind"] === "validation_waiver",
  );
  assert.ok(waiver, "the waiver must leave a durable record");
  assert.equal(
    (waiver!.payload as Record<string, unknown>)["reason"],
    "no visual verification path for React Native",
  );
});

test("FG-523 F19 scope: a non-implementer role completes without tests_run, unchanged", async () => {
  const { runId, wave } = startAndRun("research-specialist", { status: "complete", report: "findings" });
  const w = await wave;

  assert.deepEqual(w.completedSteps, ["build"], "research/docs/red roles are not subject to the tests_run contract");
  assert.equal(buildTask(runId).status, "complete");
});

test("FG-523 F19 degraded: a clean exit with NO result.json still FAILS — an infra failure is never a validation hold", async () => {
  const { runId, wave } = startAndRun("engineer", undefined);
  const w = await wave;

  const build = buildTask(runId);
  assert.equal(build.status, "failed", "missing result.json keeps its existing failure handling");
  assert.deepEqual(w.failedSteps, ["build"]);
});

// --- the contract vs the reds: which outcome claims the task? --------------
//
// The contract used to be evaluated only AFTER dispatchReds returned, so an
// authoritative red fail reached markTaskBlockedByRed first: an implementer
// completion with no tests_run came out as blocked_by_red — a status that names
// the red's finding, says nothing about the missing validation, and takes a
// --force to clear. The hold is now evaluated before the reds are dispatched.

const RED_FINDINGS = [{ severity: "high", summary: "a real defect", evidence: "in the diff", hypothesis: "regression" }];

function workflowWithRed(agent: string, reds: RedDef[]): Workflow {
  return {
    name: `fg523-red-${agent}`,
    description: "validation contract vs. red dispatch",
    inputs: [],
    steps: [
      { id: "build", agent, gate: "verdict", manual: false, depends_on: [], runtime: "claude", reds },
    ],
  };
}

// The red returns a FAILING verdict — if it ever runs, it blocks the primary.
function execPrimaryThenRed(primaryResult: unknown): DockerExecFn {
  return async ({ args, stdoutPath, stderrPath }) => {
    const nameIdx = args.indexOf("--name");
    const taskId = (nameIdx >= 0 ? args[nameIdx + 1] ?? "" : "").replace(/^forge-/, "");
    const role = getTask(taskId)?.agentRole ?? "";
    const dir = dirname(stdoutPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const result = role.startsWith("red-")
      ? { status: "complete", verdict: "fail", confidence: 0.9, findings: RED_FINDINGS }
      : primaryResult;
    writeFileSync(join(dir, "result.json"), JSON.stringify(result));
    writeFileSync(stdoutPath, "stub stdout");
    writeFileSync(stderrPath, "");
    return 0;
  };
}

async function runWithRed(agent: string, primaryResult: unknown) {
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  ensureRuntime();
  const wf = workflowWithRed(agent, [{ agent: "red-wide", authority: "authoritative", gate_on_verdict: true }]);
  const { runId } = startRun({ workflow: wf, title: wf.name, inputs: {}, projectDir: "/tmp/test-project" });
  await runNext({ runId, workflow: wf, dockerExec: execPrimaryThenRed(primaryResult) });
  return { runId, primary: getTask(tasksForRun(runId).find((t) => t.parentId === undefined)!.id)! };
}

test("FG-523 F19: no tests_run + an authoritative red that FAILS → the named validation hold, not blocked_by_red", async () => {
  const { runId, primary } = await runWithRed("engineer", { status: "complete" });

  assert.equal(
    primary.status,
    "awaiting_gate",
    "the validation hold owns the outcome — blocked_by_red would hide the missing tests_run behind the red's finding",
  );

  const held = eventsForTask(primary.id).find((e) => e.eventType === "task.awaiting_gate");
  const payload = held?.payload as Record<string, unknown>;
  assert.equal(payload["kind"], "validation_contract");
  assert.match(String(payload["reason"]), /validation contract: engineer returned status=complete with no tests_run/);
  assert.equal(
    eventsForTask(primary.id).some((e) => e.eventType === "task.blocked_by_red"),
    false,
  );

  // The hold precedes dispatch: a result that fails the contract is not worth
  // spending reds on, so no red task (and no verdict) exists at all.
  assert.deepEqual(tasksForRun(runId).filter((t) => t.parentId !== undefined), []);
  assert.deepEqual(verdictsForTask(primary.id), []);
});

test("FG-523 F19 parity: WITH tests_run, the same failing authoritative red still blocks the primary", async () => {
  const { runId, primary } = await runWithRed("engineer", { status: "complete", tests_run: 8, tests_passed: 8 });

  assert.equal(primary.status, "blocked_by_red", "the contract must not swallow a real red block");
  assert.equal(tasksForRun(runId).filter((t) => t.parentId !== undefined).length, 1, "the red ran");
  assert.equal(verdictsForTask(primary.id)[0]!.verdict, "fail");
});

test("FG-523 F19 re-entry: reconcile over a held task leaves it held; retry refuses it", async () => {
  const { runId, wave } = startAndRun("security-advisor", { status: "complete" });
  await wave;
  const build = buildTask(runId);
  assert.equal(build.status, "awaiting_gate");

  // reconcile only finalizes `running` tasks (and fails orphaned PENDING
  // primaries) — a held task must come out the other side untouched.
  const rec = reconcileRun(runId, () => false, () => "not_found", () => ({}));
  assert.deepEqual(rec.taskChanges.filter((c) => c.taskId === build.id), []);
  assert.equal(getTask(build.id)!.status, "awaiting_gate", "reconcile must never silent-complete a held task");

  // retry is scoped to failed tasks — it cannot re-enter (and so cannot
  // silently complete) a held one.
  await assert.rejects(() => retry(build.id), /not failed/);
  assert.equal(getTask(build.id)!.status, "awaiting_gate");
});
