// FG-523 (F16) — the two-sites-one-rule property, stated as a PARITY invariant
// and driven through both real sites in the same run:
//
//   site 1 = dispatch (runNext → dispatchReds), blocking from the in-hand red
//            config;
//   site 2 = the gate re-check (gate → aggregateVerdicts), blocking from the
//            persisted verdict ROWS.
//
// The bug: the rows never carried gate_on_verdict, so site 2 re-derived blocking
// from `authority == authoritative && verdict == fail` alone. An advisory
// (gate_on_verdict:false) authoritative fail sailed past dispatch and then wedged
// the gate — the run could neither advance nor explain why.
//
// The engineer's fg523-gate-on-verdict.integration.test.ts drives a mixed set of
// three FAILS. This file adds the shapes it does not: an authoritative PASS in
// the same set (the fail is not the only authoritative row — the predicate must
// not accidentally block on presence-of-authoritative), the same set with the
// flag FLIPPED (the only difference between advance and block is that one bit),
// and the pre-migration row shape reached through the REAL gate command rather
// than through aggregateVerdicts in isolation.

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { runNext, type DockerExecFn } from "./runNext.js";
import { startRun } from "./startRun.js";
import { gate, aggregateVerdicts } from "./gate.js";
import { getDb } from "../store/db.js";
import { tasksForRun, getTask } from "../store/tasks.js";
import { verdictsForTask } from "../store/verdicts.js";
import type { Workflow, RedDef } from "./schema.js";
import { publishFlatAsGeneration } from "./seed-generation.testkit.js";

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

const FINDINGS = [{ severity: "high", summary: "a real defect", evidence: "observed in the diff", hypothesis: "regression" }];

// Per-RED routing: the container name carries the task id, and the task row is
// already written at dispatch, so the red's ROLE is recoverable — each red can
// return its own verdict rather than all reds sharing one.
function execByRedRole(verdictByRole: Record<string, "pass" | "fail">): DockerExecFn {
  return async ({ args, stdoutPath, stderrPath }) => {
    const nameIdx = args.indexOf("--name");
    const taskId = (nameIdx >= 0 ? args[nameIdx + 1] ?? "" : "").replace(/^forge-/, "");
    const role = getTask(taskId)?.agentRole ?? "";
    const dir = dirname(stdoutPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    const redVerdict = verdictByRole[role];
    const result = redVerdict
      ? {
          status: "complete",
          verdict: redVerdict,
          confidence: 0.9,
          findings: redVerdict === "fail" ? FINDINGS : [],
        }
      : { status: "complete", tests_run: 6, tests_passed: 6 };

    writeFileSync(join(dir, "result.json"), JSON.stringify(result));
    writeFileSync(stdoutPath, "stub stdout");
    writeFileSync(stderrPath, "");
    return 0;
  };
}

function workflowWithReds(name: string, reds: RedDef[]): Workflow {
  return {
    name,
    description: "FG-523 gate re-check parity",
    review_mode: "legacy_verdict",
    inputs: [],
    steps: [
      { id: "build", agent: "engineer", gate: "verdict", manual: false, depends_on: [], runtime: "claude", reds },
    ],
  };
}

// gate() re-resolves the step (and its reds) from YAML on disk.
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
  publishFlatAsGeneration(process.env.FORGE_HOME!);
}

async function run(wf: Workflow, verdictByRole: Record<string, "pass" | "fail">) {
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  ensureRuntime();
  ensureWorkflowYaml(wf);
  const { runId } = startRun({ workflow: wf, title: wf.name, inputs: {}, projectDir: "/tmp/test-project" });
  await runNext({ runId, workflow: wf, dockerExec: execByRedRole(verdictByRole) });
  const primary = tasksForRun(runId).find((t) => t.parentId === undefined)!;
  return { runId, primary: getTask(primary.id)! };
}

// The SAME three-red shape in both directions. Only red-advisory's
// gate_on_verdict differs between the two tests below — everything else,
// including the verdicts returned, is identical. So any behavioral difference
// is attributable to that ONE bit, at both sites.
const REDS = (advisoryGates: boolean): RedDef[] => [
  { agent: "red-advisory", authority: "authoritative", gate_on_verdict: advisoryGates },
  { agent: "red-specialist", authority: "specialist", gate_on_verdict: true },
  { agent: "red-approver", authority: "authoritative", gate_on_verdict: true },
];

const VERDICTS: Record<string, "pass" | "fail"> = {
  "red-advisory": "fail",
  "red-specialist": "fail",
  "red-approver": "pass",
};

test("FG-523 F16: authoritative-fail(flag=false) + specialist-fail + authoritative-PASS → dispatch advances and the gate re-check agrees (this is the bug)", async () => {
  const { primary } = await run(workflowWithReds("fg523-parity-advisory", REDS(false)), VERDICTS);

  // Site 1 — dispatch: the advisory fail never blocked, and a passing
  // authoritative red is not a blocker either.
  assert.equal(primary.status, "awaiting_gate", "dispatch advanced past the advisory fail");

  const rows = verdictsForTask(primary.id);
  assert.equal(rows.length, 3);
  assert.equal(rows.find((r) => r.redRole === "red-advisory")!.gateOnVerdict, false, "the flag reached the row");
  assert.equal(rows.find((r) => r.redRole === "red-approver")!.verdict, "pass");

  // Site 2 — the gate re-check, from those rows. BEFORE the fix this threw
  // "verdict aggregation = fail" on the advisory fail: dispatch said go, the
  // gate said stop, and the run had nowhere to go without --force.
  const agg = aggregateVerdicts(rows);
  assert.deepEqual(agg.authoritativeFails, [], "an authoritative PASS in the set must not be read as a blocker either");
  assert.deepEqual(agg.specialistFails.map((v) => v.redRole), ["red-specialist"]);

  // The specialist fail still demands a rationale (unchanged, pre-existing rule)
  // — and with one, the gate advances. No --force anywhere.
  await assert.rejects(() => gate(primary.id, "advance", undefined, {}), /Specialist red/);
  const advanced = await gate(primary.id, "advance", "advisory + specialist objections reviewed", {});
  assert.equal(advanced.task.status, "complete", "the two sites agree: this run advances");
});

test("FG-523 F16: the SAME set with gate_on_verdict flipped to true → blocks at BOTH dispatch and the gate", async () => {
  const { primary } = await run(workflowWithReds("fg523-parity-blocking", REDS(true)), VERDICTS);

  // Site 1 — dispatch.
  assert.equal(primary.status, "blocked_by_red", "flag=true is the only change, and it blocks dispatch");

  const rows = verdictsForTask(primary.id);
  assert.equal(rows.find((r) => r.redRole === "red-advisory")!.gateOnVerdict, true);

  // Site 2 — the gate re-check, same rows, same rule.
  const agg = aggregateVerdicts(rows);
  assert.equal(agg.verdict, "fail");
  assert.deepEqual(agg.authoritativeFails.map((v) => v.redRole), ["red-advisory"]);

  // Both the blocked_by_red guard and the verdict re-check demand the override.
  await assert.rejects(() => gate(primary.id, "advance", "reviewed", {}), /blocked_by_red/);
  const forced = await gate(primary.id, "advance", "human override", { force: true });
  assert.equal(forced.task.status, "complete");
});

test("FG-523 F16 pre-migration shape: a verdict row with NULL gate_on_verdict blocks the REAL gate command (fail closed)", async () => {
  // A run that dispatch advanced (its own red passed), then a legacy-shaped row
  // lands against the primary — exactly what an upgraded install sees: rows
  // written by the OLD binary, re-checked by the NEW gate.
  const { runId, primary } = await run(
    workflowWithReds("fg523-parity-legacy", [
      { agent: "red-approver", authority: "authoritative", gate_on_verdict: true },
    ]),
    { "red-approver": "pass" },
  );
  assert.equal(primary.status, "awaiting_gate");

  const redTaskId = tasksForRun(runId).find((t) => t.agentRole === "red-approver")!.id;
  // The OLD INSERT verbatim — no gate_on_verdict column in the column list.
  getDb()
    .prepare(
      `INSERT INTO verdicts (id, task_id, red_task_id, red_role, verdict, confidence, authority, findings, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      "v-legacy-parity",
      primary.id,
      redTaskId,
      "red-legacy",
      "fail",
      0.9,
      "authoritative",
      JSON.stringify(FINDINGS),
      "2026-07-11T00:00:01Z",
    );

  const legacy = verdictsForTask(primary.id).find((r) => r.id === "v-legacy-parity")!;
  assert.equal(legacy.gateOnVerdict, null, "the pre-migration row reads back NULL, not false");

  // Fail closed: an unknown flag must block, or the migration would silently
  // un-block every fail recorded before the column existed.
  await assert.rejects(
    () => gate(primary.id, "advance", "rationale", {}),
    /verdict aggregation = fail/,
    "a NULL-flag authoritative fail blocks the gate exactly as it did before the column existed",
  );

  const forced = await gate(primary.id, "advance", "human override of a legacy fail", { force: true });
  assert.equal(forced.task.status, "complete", "--force remains the escape, as for any authoritative fail");
});
