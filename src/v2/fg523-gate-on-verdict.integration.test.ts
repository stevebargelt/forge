// FG-523 (F16): dispatch and the gate re-check now apply ONE blocking rule.
//
// Driven through the real path — runNext → dispatchReds (in-hand red config,
// FG-418) writes the verdict rows; gate() → aggregateVerdicts re-derives
// blocking from those ROWS. Both consumers call verdictBlocksGate. The set is
// deliberately MIXED (authoritative fail with gate_on_verdict:true, another
// with :false, plus a specialist fail) so the assertion is a quantifier, not a
// single case: exactly the flag-true fail blocks, at both sites.

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { runNext, type DockerExecFn } from "./runNext.js";
import { startRun } from "./startRun.js";
import { gate, aggregateVerdicts } from "./gate.js";
import { tasksForRun, getTask } from "../store/tasks.js";
import { verdictsForTask } from "../store/verdicts.js";
import type { Workflow, RedDef } from "./schema.js";

function ensureRuntime(): void {
  const runtimePath = join(process.env.FORGE_HOME!, "runtimes", "claude.yml");
  if (existsSync(runtimePath)) return;
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

const FAIL_RESULT = {
  status: "complete",
  verdict: "fail",
  confidence: 0.9,
  findings: [{ severity: "high", summary: "a real defect", evidence: "observed in the diff", hypothesis: "regression" }],
};

// Route by container name: the primary returns a clean implementer result, each
// red returns a fail.
const exec: DockerExecFn = async ({ args, stdoutPath, stderrPath }) => {
  const nameIdx = args.indexOf("--name");
  const taskId = (nameIdx >= 0 ? args[nameIdx + 1] ?? "" : "").replace(/^forge-/, "");
  const dir = dirname(stdoutPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const result = taskId.startsWith("task-red-") ? FAIL_RESULT : { status: "complete", tests_run: 4, tests_passed: 4 };
  writeFileSync(join(dir, "result.json"), JSON.stringify(result));
  writeFileSync(stdoutPath, "stub stdout");
  writeFileSync(stderrPath, "");
  return 0;
};

function workflowWithReds(name: string, reds: RedDef[]): Workflow {
  return {
    name,
    description: "gate_on_verdict persistence test",
    inputs: [],
    steps: [
      { id: "review", agent: "engineer", gate: "verdict", manual: false, depends_on: [], runtime: "claude", reds },
    ],
  };
}

// gate() re-loads the workflow from disk by name — the reds (and their
// gate_on_verdict flags) must be there too, since the gate's own re-check path
// resolves the step from YAML.
function ensureWorkflowYaml(wf: Workflow): void {
  const dir = join(process.env.FORGE_HOME!, "workflows");
  mkdirSync(dir, { recursive: true });
  const step = wf.steps[0]!;
  const reds = step.reds
    .map((r) => `      - agent: ${r.agent}\n        authority: ${r.authority}\n        gate_on_verdict: ${r.gate_on_verdict}`)
    .join("\n");
  writeFileSync(
    join(dir, `${wf.name}.yml`),
    `name: ${wf.name}\ndescription: ${wf.description}\ninputs: []\nsteps:\n  - id: ${step.id}\n    agent: ${step.agent}\n    gate: ${step.gate}\n    reds:\n${reds}\n`,
  );
}

async function run(wf: Workflow) {
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  ensureRuntime();
  ensureWorkflowYaml(wf);
  const { runId } = startRun({ workflow: wf, title: wf.name, inputs: {}, projectDir: "/tmp/test-project" });
  await runNext({ runId, workflow: wf, dockerExec: exec });
  const primary = tasksForRun(runId).find((t) => t.parentId === undefined)!;
  return { runId, primary: getTask(primary.id)! };
}

test("FG-523 F16: mixed verdict set — exactly the gate_on_verdict:true authoritative fail blocks dispatch AND the gate", async () => {
  const { primary } = await run(
    workflowWithReds("fg523-mixed", [
      { agent: "red-blocking", authority: "authoritative", gate_on_verdict: true },
      { agent: "red-advisory", authority: "authoritative", gate_on_verdict: false },
      { agent: "red-specialist", authority: "specialist", gate_on_verdict: true },
    ]),
  );

  // Site 1 — dispatch (in-hand red config).
  assert.equal(primary.status, "blocked_by_red", "the flag-true authoritative fail blocks dispatch");

  // The rows carry the flag as dispatched.
  const rows = verdictsForTask(primary.id);
  assert.equal(rows.length, 3);
  assert.equal(rows.find((r) => r.redRole === "red-blocking")!.gateOnVerdict, true);
  assert.equal(rows.find((r) => r.redRole === "red-advisory")!.gateOnVerdict, false);
  assert.equal(rows.find((r) => r.redRole === "red-specialist")!.gateOnVerdict, true);

  // Site 2 — the gate re-check, from the ROWS. Same one fail blocks; the
  // gate_on_verdict:false authoritative fail is not counted.
  const agg = aggregateVerdicts(rows);
  assert.equal(agg.verdict, "fail");
  assert.deepEqual(agg.authoritativeFails.map((v) => v.redRole), ["red-blocking"]);
  assert.deepEqual(agg.specialistFails.map((v) => v.redRole), ["red-specialist"]);

  await assert.rejects(() => gate(primary.id, "advance", undefined, {}), /blocked_by_red/);
});

test("FG-523 F16: a gate_on_verdict:false authoritative fail advances dispatch AND no longer blocks the gate — the two sites agree", async () => {
  const { primary } = await run(
    workflowWithReds("fg523-advisory-only", [
      { agent: "red-advisory", authority: "authoritative", gate_on_verdict: false },
      { agent: "red-specialist", authority: "specialist", gate_on_verdict: true },
    ]),
  );

  // Site 1 — dispatch: never blocked on this fail (unchanged behavior).
  assert.equal(primary.status, "awaiting_gate");

  // Site 2 — the gate re-check used to throw here (the row didn't carry the
  // flag, so the fail read as blocking). It must now advance; the specialist
  // fail still demands a rationale.
  const rows = verdictsForTask(primary.id);
  assert.deepEqual(rows.find((r) => r.redRole === "red-advisory")!.gateOnVerdict, false);
  await assert.rejects(() => gate(primary.id, "advance", undefined, {}), /Specialist red/);

  const result = await gate(primary.id, "advance", "advisory fail reviewed", {});
  assert.equal(result.task.status, "complete");
});

test("FG-523 F16 no-regression: a gate_on_verdict:true authoritative fail still blocks the gate re-check without --force", async () => {
  const { primary } = await run(
    workflowWithReds("fg523-blocking-only", [
      { agent: "red-blocking", authority: "authoritative", gate_on_verdict: true },
    ]),
  );
  assert.equal(primary.status, "blocked_by_red");

  const forced = await gate(primary.id, "advance", "human override", { force: true });
  assert.equal(forced.task.status, "complete", "the --force override is untouched");
});
