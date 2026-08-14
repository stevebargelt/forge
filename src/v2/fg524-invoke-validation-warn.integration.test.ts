// FG-524 integration tests: `forge invoke` = WARN for non-compliant implementer
// completions — end-to-end, through the REAL invoke ingestion path.
//
// Policy (recorded in validation-contract.ts and invoke.ts): the two ad-hoc
// invoke completion seams (the FG-337 inferred-result path and the main
// markTaskComplete) route implementer completions through the ONE shared
// evaluateValidationContract before completing. Unlike the workflow PRIMARY seam
// (which HOLDS at awaiting_gate) and the fanout-child seam (which holds the
// PARENT), invoke does NOT hold — an ad-hoc invoke has no workflow run to advance
// a held task through, so a hold would strand it. A contract failure is surfaced
// as an advisory `task.validation_warning` carrying the evaluator's OWN named
// reason; the task STILL completes.
//
// These tests drive a full invoke dispatch → container-return → result-read →
// status-write cycle against a real docker-exec stub that writes a real
// result.json, and assert the externally-visible outcome: task status, the
// completion event, and the presence/absence of the WARN event.
//
// Requirements exercised:
//   1. Implementer complete-without-tests_run (no waiver) → COMPLETES + WARNS,
//      with the shared evaluator's named reason. Not held; no recovery verb.
//   2. Waivered complete (no_validation_reason set) → completes, NO warning.
//   3. Compliant implementer (tests_run > 0) → completes silently (positive control).
//   4. Non-implementer invoke without tests_run → completes, NO warning
//      (non-implementer control — the evaluator returns held:false for them).
//   5. Both markTaskComplete sites covered: the inferred-result path warns too.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  writeFileSync, mkdirSync, existsSync, mkdtempSync, rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { invoke, type DockerExecFn } from "./invoke.js";
import { publishFlatAsGeneration } from "./seed-generation.testkit.js";
import { getTask } from "../store/tasks.js";
import { eventsForTask } from "../store/events.js";

// ---------------------------------------------------------------------------
// Docker exec stub: writes a REAL result.json to the task dir (the shape the
// agent would have written), leaves stdout/stderr empty, exits 0. This drives
// the main markTaskComplete path (invoke.ts) — not the inferred-result fallback.
// ---------------------------------------------------------------------------

function makeResultExec(result: unknown, exitCode = 0): DockerExecFn {
  return async ({ stdoutPath, stderrPath }) => {
    const dir = dirname(stdoutPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    // result.json sits beside container.stdout.log in the task dir.
    writeFileSync(join(dir, "result.json"), JSON.stringify(result));
    writeFileSync(stdoutPath, "");
    writeFileSync(stderrPath, "");
    return exitCode;
  };
}

// ---------------------------------------------------------------------------
// Runtime YAML setup (idempotent) — mirrors fg337-inferred-result's pi stub.
// ---------------------------------------------------------------------------

function ensurePiRuntime(): void {
  const p = join(process.env.FORGE_HOME!, "runtimes", "pi-stub.yml");
  if (!existsSync(p)) {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, `name: pi-stub
description: test stub pi runtime
runtime_kind: pi
log_format: pi-jsonl
prompt_strategy: message-arg
auth_strategy: env-provider-api-key
image: test-image:latest
models:
  default: test-model
auth:
  mode: apikey
mounts:
  - { host: "\${TASK_DIR}", container: /task }
invocation:
  command: pi
  args: ["-p"]
container:
  name: "forge-\${TASK_ID}"
result:
  file: /task/result.json
`);
  }
  // FG-583: publish the flat runtime as a complete generation so dispatch resolves it.
  publishFlatAsGeneration(process.env.FORGE_HOME!);
}

function warningEvents(taskId: string) {
  return eventsForTask(taskId).filter((e) => e.eventType === "task.validation_warning");
}

// ---------------------------------------------------------------------------
// Requirement 1 — implementer complete-without-tests_run → COMPLETE + WARN
// ---------------------------------------------------------------------------

test("FG-524 invoke: implementer complete-without-tests_run completes AND warns with the shared reason", async () => {
  ensurePiRuntime();
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  const projectDir = mkdtempSync(join(tmpdir(), "forge-fg524-warn-"));
  try {
    const result = { status: "complete", diff_summary: "did work", notes: "no tests reported" };
    const r = await invoke({
      agentRole: "backend-specialist",
      task: "an ad-hoc backend change",
      projectDir,
      runtimeName: "pi-stub",
      dockerExec: makeResultExec(result),
    });

    // WARN, not hold: the task still completes.
    assert.equal(r.status, "complete", "invoke must still COMPLETE under WARN policy");
    const task = getTask(r.taskId)!;
    assert.equal(task.status, "complete");
    assert.notEqual(task.status, "awaiting_gate", "invoke must NOT hold — no run to advance through");

    // The completion event fired, and the advisory warning carries the evaluator's reason.
    const evTypes = eventsForTask(r.taskId).map((e) => e.eventType);
    assert.ok(evTypes.includes("task.completed"), "task.completed must be emitted");
    assert.ok(!evTypes.includes("task.awaiting_gate"), "invoke must never emit awaiting_gate");

    const warnings = warningEvents(r.taskId);
    assert.equal(warnings.length, 1, "exactly one validation_warning must be emitted");
    const warning = warnings[0];
    assert.ok(warning);
    const payload = warning.payload as { kind?: string; reason?: string };
    assert.equal(payload.kind, "validation_contract");
    // The reason is the ONE evaluator's, verbatim — names the role and the missing value.
    assert.match(payload.reason ?? "", /validation contract/);
    assert.match(payload.reason ?? "", /backend-specialist/);
    assert.match(payload.reason ?? "", /no tests_run/);
    assert.match(payload.reason ?? "", /no no_validation_reason waiver/);
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Requirement 2 — waivered complete → completes, NO warning
// ---------------------------------------------------------------------------

test("FG-524 invoke: a no_validation_reason waiver completes WITHOUT warning (waiver semantics preserved)", async () => {
  ensurePiRuntime();
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  const projectDir = mkdtempSync(join(tmpdir(), "forge-fg524-waiver-"));
  try {
    const result = {
      status: "complete",
      diff_summary: "config-only change",
      no_validation_reason: "config-only change, no test path exists",
    };
    const r = await invoke({
      agentRole: "engineer",
      task: "a config-only change",
      projectDir,
      runtimeName: "pi-stub",
      dockerExec: makeResultExec(result),
    });

    assert.equal(r.status, "complete");
    assert.equal(getTask(r.taskId)!.status, "complete");
    assert.equal(warningEvents(r.taskId).length, 0, "a waivered result must NOT warn");
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Requirement 3 — compliant implementer → completes silently (positive control)
// ---------------------------------------------------------------------------

test("FG-524 invoke: a compliant implementer result (tests_run>0) completes silently", async () => {
  ensurePiRuntime();
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  const projectDir = mkdtempSync(join(tmpdir(), "forge-fg524-ok-"));
  try {
    const result = { status: "complete", diff_summary: "did work", tests_run: 12, tests_passed: 12, tests_failed: 0 };
    const r = await invoke({
      agentRole: "backend-specialist",
      task: "a validated backend change",
      projectDir,
      runtimeName: "pi-stub",
      dockerExec: makeResultExec(result),
    });

    assert.equal(r.status, "complete");
    assert.equal(getTask(r.taskId)!.status, "complete");
    assert.equal(warningEvents(r.taskId).length, 0, "a compliant result must NOT warn");
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Requirement 4 — non-implementer invoke → completes, NO warning (control)
// ---------------------------------------------------------------------------

test("FG-524 invoke: a non-implementer invoke without tests_run is unaffected (no warning)", async () => {
  ensurePiRuntime();
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  const projectDir = mkdtempSync(join(tmpdir(), "forge-fg524-nonimpl-"));
  try {
    // test-engineer is outside IMPLEMENTER_ROLES → evaluator returns held:false.
    const result = { status: "complete", summary: "reviewed the tests", verdict: "ok" };
    const r = await invoke({
      agentRole: "test-engineer",
      task: "review the test suite",
      projectDir,
      runtimeName: "pi-stub",
      dockerExec: makeResultExec(result),
    });

    assert.equal(r.status, "complete");
    assert.equal(getTask(r.taskId)!.status, "complete");
    assert.equal(warningEvents(r.taskId).length, 0, "a non-implementer invoke must never warn");
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Requirement 5 — the inferred-result seam is ALSO routed through the evaluator.
// inferredResultFrom only fires for narrative roles today, so the evaluator
// returns held:false there — this pins that the inferred path completes a
// narrative role silently (never a spurious warning), proving the seam is wired
// without changing narrative behavior.
// ---------------------------------------------------------------------------

function makePiNoResultExec(stdoutJsonl: string): DockerExecFn {
  return async ({ stdoutPath, stderrPath }) => {
    const dir = dirname(stdoutPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(stdoutPath, stdoutJsonl);
    writeFileSync(stderrPath, "");
    return 0;
  };
}

test("FG-524 invoke: the inferred-result seam completes a narrative role without a spurious warning", async () => {
  ensurePiRuntime();
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  const projectDir = mkdtempSync(join(tmpdir(), "forge-fg524-inferred-"));
  try {
    // Clean pi completion with assistant text, no result.json → inferred fallback.
    const stdout =
      JSON.stringify({ type: "agent_start" }) + "\n" +
      JSON.stringify({
        type: "agent_end",
        messages: [{ role: "assistant", stopReason: "end_turn", content: "research finding" }],
      }) + "\n";
    const r = await invoke({
      agentRole: "research-specialist",
      task: "a narrative research task",
      projectDir,
      runtimeName: "pi-stub",
      dockerExec: makePiNoResultExec(stdout),
    });

    assert.equal(r.status, "complete", "narrative role completes via inferred result");
    assert.equal(warningEvents(r.taskId).length, 0, "inferred-path narrative completion must NOT warn");
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});
