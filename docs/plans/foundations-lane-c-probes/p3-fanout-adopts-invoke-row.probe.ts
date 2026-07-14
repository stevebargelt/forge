// PROBE (FG-527 disagreement #2b): dispatchFanoutStep's existingParent lookup
// (runNext.ts:1572-1574) has no FG-507 ad-hoc exclusion, so on a workflow whose
// FANOUT step is named `task`, a pending `forge invoke` row is ADOPTED as the
// fanout parent.
//
// This drives the REAL runNext/dispatchFanoutStep code path (no source mirror, no
// container: the fanout fails on its upstream array before any child dispatch), and
// shows the damage land on the operator's ad-hoc row: `forge next` marks the INVOKE
// task failed with a fanout error it has nothing to do with.
//
// CONSTRUCTED DB STATE: rows are seeded directly into an in-memory store; the
// workflow yaml is written to FORGE_HOME. Nothing here is mocked — runNext,
// computeReadyQueue and dispatchFanoutStep are the shipped functions.
//
// Run: bash docs/plans/foundations-lane-c-probes/p3-fanout-adopts-invoke-row.sh
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeInMemoryDb, setDbForTest } from "../../../src/store/db.js";
import { insertRun } from "../../../src/store/runs.js";
import { insertTask, getTask, tasksForRun } from "../../../src/store/tasks.js";
import { runNext } from "../../../src/v2/runNext.js";
import { loadWorkflow } from "../../../src/v2/loader.js";
import { classifyTaskLineage, isWorkflowPrimaryRow } from "../../../src/v2/lifecycle-evaluator.js";
import { computeReadyQueue } from "../../../src/v2/ready-queue.js";
import type { Run, Task } from "../../../src/types/index.js";

const HOME = process.env["FORGE_HOME"]!;
mkdirSync(join(HOME, "workflows"), { recursive: true });
// A workflow whose FANOUT step is named `task` — the id every `forge invoke` row
// carries as its phase. Schema-legal (FG-507's whole premise).
writeFileSync(join(HOME, "workflows", "taskfanout.yml"), `
name: taskfanout
description: fanout step named 'task' (FG-507 collision shape)
inputs: []
steps:
  - id: plan
    agent: tech-lead
    gate: auto
  - id: task
    agent: engineer
    gate: auto
    depends_on: [plan]
    fanout:
      from_upstream:
        step: plan
        array_key: steps
        input_key: step
      agent_map: {}
      max_concurrency: 2
      failure_mode: fail-phase
`);
const workflow = loadWorkflow("taskfanout");

const RUN: Run = {
  id: "run-p3", workflow: "taskfanout", title: "probe", status: "active",
  projectDir: "/tmp/test-project", createdAt: "2026-07-14T00:00:00.000Z",
};

const db = makeInMemoryDb();
setDbForTest(db);
insertRun(RUN);

// plan: complete. Its result deliberately carries NO `steps` array, so
// dispatchFanoutStep reaches its upstream-array check and fails the parent it
// picked — the observable that identifies WHICH row it adopted, without any
// container ever starting.
const plan: Task = {
  id: "plan-1", runId: RUN.id, phase: "plan", agentRole: "tech-lead", status: "complete",
  result: { summary: "no steps array" },
  taskPackage: { taskId: "plan-1", runId: RUN.id, phase: "plan", role: "tech-lead", inputs: {}, composedSystemPrompt: "", dispatchSource: "workflow" },
  createdAt: "2026-07-14T00:00:01.000Z",
};
// The operator's live `forge invoke` row: phase `task`, parent-less, pending,
// dispatchSource=invoke (FG-512's marker).
const invoked: Task = {
  id: "task-invoke-1", runId: RUN.id, phase: "task", agentRole: "engineer", status: "pending",
  taskPackage: { taskId: "task-invoke-1", runId: RUN.id, phase: "task", role: "engineer",
    inputs: { task: "look at the flaky test" }, composedSystemPrompt: "", dispatchSource: "invoke" },
  createdAt: "2026-07-14T00:00:02.000Z",
};
insertTask(plan);
insertTask(invoked);

const rows = tasksForRun(RUN.id);
const kinds = classifyTaskLineage(workflow, rows);
console.log("### classifier");
console.log("  kind(task-invoke-1) =", kinds.get("task-invoke-1"),
  "| isWorkflowPrimaryRow =", isWorkflowPrimaryRow(kinds.get("task-invoke-1")!));
console.log("  => dispatchSingleStep's MIGRATED lookup (runNext.ts:443-448) would NOT reuse this row.");

console.log("\n### legacy predicate actually in dispatchFanoutStep (runNext.ts:1572-1574)");
const legacyPick = rows.find((t) => t.phase === "task" && t.parentId === undefined && t.status === "pending");
console.log("  existingParent =", legacyPick?.id ?? "(none)");

console.log("\n### ready queue admits the fanout step (the invoke row is invisible to it):",
  computeReadyQueue(workflow, rows).map((s) => s.id).join(",") || "(empty)");

console.log("\n### EXECUTING runNext (real dispatch path; no docker is reached)");
const result = await runNext({ runId: RUN.id, workflow });
console.log("  runNext ->", JSON.stringify(result));

const after = getTask("task-invoke-1")!;
console.log("\n### the operator's INVOKE row, after `forge next`:");
console.log("  status =", after.status);
console.log("  error  =", after.error);
console.log("  rows in run:", tasksForRun(RUN.id).map((t) => `${t.id}[${t.status}]`).join("  "));
db.close();
