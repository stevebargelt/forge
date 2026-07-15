// PROBE 4 — is ready-queue.ts:155-161's reason for NOT absorbing resolvePhasePrimary
// into the classifier still true at this SHA?
//
// The in-file claim: threading the workflow in would ALSO apply the classifier's
// ad-hoc exclusion to callers that pass an UNFILTERED row set (inputs.deriveUpstream,
// runNext's fanout upstream read) — narrowing their row universe, i.e. a behavior
// change rather than a refactor.
//
// This probe executes both the current and the would-be-classifier-filtered
// selection over the one row shape where they can differ: a COMPLETE ad-hoc invoke
// row (phase `task`) in a workflow that declares a step `task` which a later step
// depends on.
//
// Run: bash docs/plans/foundations-lane-c-probes/p4-resolve-phase-primary.sh
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePhasePrimary } from "../../../src/v2/ready-queue.js";
import { deriveUpstream } from "../../../src/v2/inputs.js";
import { classifyTaskLineage, isWorkflowPrimaryRow } from "../../../src/v2/lifecycle-evaluator.js";
import type { Workflow, Step } from "../../../src/v2/schema.js";
import type { Task } from "../../../src/types/index.js";

const runDir = mkdtempSync(join(tmpdir(), "p4-"));
mkdirSync(runDir, { recursive: true });

const wf = {
  name: "p4", description: "", inputs: [],
  steps: [
    { id: "task", agent: "engineer", depends_on: [], reds: [] },
    { id: "review", agent: "tech-lead", depends_on: ["task"], reds: [] },
  ] as Step[],
} as Workflow;

function mk(o: { id: string; phase: string; status: Task["status"]; at: string; src?: "workflow" | "invoke"; parentId?: string; result?: unknown }): Task {
  return {
    id: o.id, runId: "r", phase: o.phase, agentRole: "engineer", status: o.status,
    ...(o.parentId ? { parentId: o.parentId } : {}),
    ...(o.result !== undefined ? { result: o.result } : {}),
    taskPackage: { taskId: o.id, runId: "r", phase: o.phase, role: "engineer", inputs: {}, composedSystemPrompt: "",
      ...(o.src ? { dispatchSource: o.src } : {}) },
    createdAt: o.at,
  };
}

// The only shape where the two selections can differ: a COMPLETE marker-stamped
// invoke row sitting in a phase the workflow also declares as a step.
const invokeComplete = mk({ id: "task-invoke-1", phase: "task", status: "complete", at: "2026-07-14T00:00:01.000Z", src: "invoke", result: { note: "ad-hoc work, not the step's" } });
// A marker-LESS legacy row in the same shape — the classifier keeps this one
// (legacy_ambiguous_invoke ∈ isWorkflowPrimaryRow), so absorbing does NOT narrow here.
const legacyComplete = mk({ id: "task-legacy-1", phase: "task", status: "complete", at: "2026-07-14T00:00:00.000Z", result: { note: "legacy row" } });

for (const [label, rows] of [
  ["A. complete ad-hoc invoke row only", [invokeComplete]],
  ["B. complete marker-less legacy row only", [legacyComplete]],
] as [string, Task[]][]) {
  const kinds = classifyTaskLineage(wf, rows);
  const today = resolvePhasePrimary(rows, "task");
  // The would-be classifier-driven selection: same rule, classifier-filtered universe.
  const filtered = rows.filter((t) => isWorkflowPrimaryRow(kinds.get(t.id)!));
  const absorbed = resolvePhasePrimary(filtered, "task");
  const up = deriveUpstream({ step: wf.steps[1]!, allTasks: rows, runDir });
  console.log(`### ${label}`);
  console.log("  kinds:", rows.map((t) => `${t.id}=${kinds.get(t.id)}`).join(" "));
  console.log("  resolvePhasePrimary TODAY      ->", today?.id ?? "(undefined)");
  console.log("  resolvePhasePrimary IF ABSORBED->", absorbed?.id ?? "(undefined)");
  console.log("  deriveUpstream(review) TODAY   ->", JSON.stringify(up));
  console.log("  NARROWED?", (today?.id ?? null) !== (absorbed?.id ?? null));
  console.log();
}
