// FG-640 / PRD #16: risk-targeted lens selection, through the REAL dispatch path.
//
// `fg640-feature-migration.test.ts` proves the selection FUNCTION over the shipped feature.yml.
// This file proves the wiring: runNext → dispatchReds actually spawns only the selected lenses,
// against a real run stamped `evidence_led` from a real workflow, with a plan step whose
// contract was approved at a real gate. A selection nothing consults would pass the unit test
// and dispatch six reds anyway.
//
// Three cases, because the interesting failures are the boundaries rather than the happy path:
// selection with an approved contract, no narrowing without one (fail closed WIDER), and no
// narrowing at all on a legacy run.

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { runNext, type DockerExecFn } from "./runNext.js";
import { startRun } from "./startRun.js";
import { gate } from "./gate.js";
import { tasksForRun } from "../store/tasks.js";
import { eventsForRun } from "../store/events.js";
import type { ReviewMode } from "../types/index.js";
import { publishFlatAsGeneration } from "./seed-generation.testkit.js";
import { loadWorkflow } from "./loader.js";

const LENS_REDS = ["red-wide", "red-narrow", "red-frontend", "red-backend", "red-security"];

const CONTRACT = {
  threat_model: "a backend write path that can lose data",
  protected_invariants: ["publication is CAS-guarded"],
  acceptance_refs: ["FG-640 AC 16"],
  risk_lenses: ["backend", "security"],
  non_goals: [],
};

function ensureRuntime(): void {
  const runtimePath = join(process.env.FORGE_HOME!, "runtimes", "claude.yml");
  if (existsSync(runtimePath)) return;
  mkdirSync(dirname(runtimePath), { recursive: true });
  writeFileSync(
    runtimePath,
    `name: claude
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
`,
  );
}

/** The plan step emits the contract; every red passes. */
function execFor(planResult: unknown): DockerExecFn {
  return async ({ args, stdoutPath, stderrPath }) => {
    const nameIdx = args.indexOf("--name");
    const taskId = (nameIdx >= 0 ? (args[nameIdx + 1] ?? "") : "").replace(/^forge-/, "");
    const dir = dirname(stdoutPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const result = taskId.startsWith("task-red-")
      ? { status: "complete", verdict: "pass", confidence: 0.9, findings: [] }
      : taskId.startsWith("task-plan")
        ? planResult
        : { status: "complete", tests_run: 4, tests_passed: 4 };
    writeFileSync(join(dir, "result.json"), JSON.stringify(result));
    writeFileSync(stdoutPath, "stub stdout");
    writeFileSync(stderrPath, "");
    return 0;
  };
}

function writeWorkflow(name: string, reviewMode: ReviewMode): void {
  const dir = join(process.env.FORGE_HOME!, "workflows");
  mkdirSync(dir, { recursive: true });
  const authority = reviewMode === "evidence_led" ? "specialist" : "authoritative";
  const gateOn = reviewMode === "evidence_led" ? "false" : "true";
  const reds = LENS_REDS.map(
    (r) => `      - agent: ${r}\n        authority: ${authority}\n        gate_on_verdict: ${gateOn}`,
  ).join("\n");
  writeFileSync(
    join(dir, `${name}.yml`),
    `name: ${name}
description: lens selection through dispatch
review_mode: ${reviewMode}
inputs: []
steps:
  - id: plan
    agent: tech-lead
    gate: human
  - id: build
    agent: engineer
    gate: verdict
    depends_on: [plan]
    reds:
${reds}
`,
  );
  publishFlatAsGeneration(process.env.FORGE_HOME!);
}

/** Run plan → approve it at its human gate → run build (which dispatches the reds). */
async function runThroughBuild(name: string, reviewMode: ReviewMode, planResult: unknown): Promise<string[]> {
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  ensureRuntime();
  writeWorkflow(name, reviewMode);
  const workflow = loadWorkflow(name);
  const exec = execFor(planResult);

  const { runId } = startRun({ workflow, title: name, inputs: {}, projectDir: "/tmp/test-project" });
  await runNext({ runId, workflow, dockerExec: exec });

  // The plan parks at its human gate; advancing it IS the approval that makes the contract
  // authoritative. Without this the contract is a proposal and selection must not read it.
  const plan = tasksForRun(runId).find((t) => t.phase === "plan")!;
  if (plan.status === "awaiting_gate") await gate(plan.id, "advance", "approved", {});

  await runNext({ runId, workflow, dockerExec: exec });

  return tasksForRun(runId)
    .filter((t) => t.phase === "build" && t.parentId !== undefined)
    .map((t) => t.agentRole)
    .sort();
}

test("FG-640 / PRD #16: an evidence_led run dispatches ONLY the approved contract's lenses", async () => {
  const roles = await runThroughBuild("fg640-selected", "evidence_led", {
    status: "complete",
    steps: [],
    review_contract: CONTRACT,
  });
  assert.deepEqual(roles, ["red-backend", "red-security"], "three declared lens reds were not selected, so must not have run");
});

test("FG-640: the narrowed panel is RECORDED — a reader can tell selection from three reds failing to start", async () => {
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  ensureRuntime();
  writeWorkflow("fg640-recorded", "evidence_led");
  const workflow = loadWorkflow("fg640-recorded");
  const exec = execFor({ status: "complete", steps: [], review_contract: CONTRACT });
  const { runId } = startRun({ workflow, title: "fg640-recorded", inputs: {}, projectDir: "/tmp/test-project" });
  await runNext({ runId, workflow, dockerExec: exec });
  const plan = tasksForRun(runId).find((t) => t.phase === "plan")!;
  await gate(plan.id, "advance", "approved", {});
  await runNext({ runId, workflow, dockerExec: exec });

  const ev = eventsForRun(runId).find((e) => e.eventType === "review.lenses_selected");
  assert.ok(ev, "no review.lenses_selected event — a silently narrower panel is indistinguishable from three crashed reds");
  const payload = ev!.payload as { selected: string[]; skipped: string[]; reason: string };
  assert.deepEqual([...payload.selected].sort(), ["red-backend", "red-security"]);
  assert.deepEqual([...payload.skipped].sort(), ["red-frontend", "red-narrow", "red-wide"]);
  assert.match(payload.reason, /backend, security/);
});

test("FG-640: an evidence_led run with NO approved contract fails closed WIDER — every declared red runs", async () => {
  const roles = await runThroughBuild("fg640-noncontract", "evidence_led", { status: "complete", steps: [] });
  assert.deepEqual(roles, [...LENS_REDS].sort(), "an absent contract narrowed the panel");
});

test("FG-640: an evidence_led run whose contract is UNAPPROVED does not narrow — a proposal is not authority", async () => {
  // Same contract, but the plan gate is never advanced: `runThroughBuild` only gates when the
  // task is awaiting_gate, so we drive it by hand and skip the approval.
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  ensureRuntime();
  writeWorkflow("fg640-unapproved", "evidence_led");
  const workflow = loadWorkflow("fg640-unapproved");
  const exec = execFor({ status: "complete", steps: [], review_contract: CONTRACT });
  const { runId } = startRun({ workflow, title: "fg640-unapproved", inputs: {}, projectDir: "/tmp/test-project" });
  await runNext({ runId, workflow, dockerExec: exec });
  const plan = tasksForRun(runId).find((t) => t.phase === "plan")!;
  // reject → no `advance` gate row exists, so the contract stays a proposal. The build step
  // never becomes ready either, which is itself the point: nothing downstream reads it.
  await gate(plan.id, "reject", "not approved", {});
  await runNext({ runId, workflow, dockerExec: exec });

  const buildReds = tasksForRun(runId).filter((t) => t.phase === "build" && t.parentId !== undefined);
  assert.deepEqual(buildReds, [], "an unapproved plan must not have dispatched a narrowed build panel");
});

test("FG-640: a contract from a NON-PLAN human-gated step never narrows the panel — and the refusal is recorded", async () => {
  // The injection this binding exists to refuse: `architect` is a real step of this run, gated
  // by a real human `advance`, and its result carries a perfectly valid two-lens contract. It
  // is still not the step `build` declares as its upstream, so the panel stays wide.
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  ensureRuntime();
  const dir = join(process.env.FORGE_HOME!, "workflows");
  mkdirSync(dir, { recursive: true });
  const reds = LENS_REDS.map(
    (r) => `      - agent: ${r}\n        authority: specialist\n        gate_on_verdict: false`,
  ).join("\n");
  writeFileSync(
    join(dir, "fg640-foreign.yml"),
    `name: fg640-foreign
description: a contract written by a step build was not planned by
review_mode: evidence_led
inputs: []
steps:
  - id: architect
    agent: architecture-advisor
    gate: human
  - id: plan
    agent: tech-lead
    gate: human
    depends_on: [architect]
  - id: build
    agent: engineer
    gate: verdict
    depends_on: [plan]
    reds:
${reds}
`,
  );
  publishFlatAsGeneration(process.env.FORGE_HOME!);
  const workflow = loadWorkflow("fg640-foreign");

  // architect emits the narrow contract; the plan step emits none.
  const exec: DockerExecFn = async ({ args, stdoutPath, stderrPath }) => {
    const nameIdx = args.indexOf("--name");
    const taskId = (nameIdx >= 0 ? (args[nameIdx + 1] ?? "") : "").replace(/^forge-/, "");
    const d = dirname(stdoutPath);
    if (!existsSync(d)) mkdirSync(d, { recursive: true });
    const result = taskId.startsWith("task-red-")
      ? { status: "complete", verdict: "pass", confidence: 0.9, findings: [] }
      : taskId.startsWith("task-architect")
        ? { status: "complete", risks: [], review_contract: CONTRACT }
        : taskId.startsWith("task-plan")
          ? { status: "complete", steps: [] }
          : { status: "complete", tests_run: 4, tests_passed: 4 };
    writeFileSync(join(d, "result.json"), JSON.stringify(result));
    writeFileSync(stdoutPath, "stub stdout");
    writeFileSync(stderrPath, "");
    return 0;
  };

  const { runId } = startRun({ workflow, title: "fg640-foreign", inputs: {}, projectDir: "/tmp/test-project" });
  for (const phase of ["architect", "plan"]) {
    await runNext({ runId, workflow, dockerExec: exec });
    const task = tasksForRun(runId).find((t) => t.phase === phase && t.parentId === undefined)!;
    await gate(task.id, "advance", "approved", {});
  }
  await runNext({ runId, workflow, dockerExec: exec });

  const roles = tasksForRun(runId)
    .filter((t) => t.phase === "build" && t.parentId !== undefined)
    .map((t) => t.agentRole)
    .sort();
  assert.deepEqual(roles, [...LENS_REDS].sort(), "an approved architect's contract narrowed a panel it does not select");

  const ev = eventsForRun(runId).find((e) => e.eventType === "review.contract_ignored");
  assert.ok(ev, "the ignored contract must be readable — a wide panel alone cannot say a contract was refused");
  const payload = ev!.payload as { step: string; reviewedStep: string; approvingSteps: string[] };
  assert.equal(payload.step, "architect");
  assert.equal(payload.reviewedStep, "build");
  assert.deepEqual(payload.approvingSteps, ["plan"]);
});

test("FG-640: a LEGACY run never narrows — selection is scoped to the evidence_led cutover", async () => {
  const roles = await runThroughBuild("fg640-legacy", "legacy_verdict", {
    status: "complete",
    steps: [],
    review_contract: CONTRACT,
  });
  assert.deepEqual(roles, [...LENS_REDS].sort(), "a legacy run read a contract it must ignore");
});
