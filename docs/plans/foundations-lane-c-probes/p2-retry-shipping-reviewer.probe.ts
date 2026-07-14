// PROBE (FG-527 disagreement #1): a FAILED shipping-reviewer red on feature.yml's
// `build` FANOUT step is refused by `forge retry` today (FanoutChildRetryError),
// and the naive migration ("classifier says red_review ⇒ allow the retry") mints a
// DETACHED PRIMARY in the fanout phase. Both halves are executed, not asserted from
// source reading.
//
// CONSTRUCTED DB STATE (stated plainly): the row shape is built directly in an
// in-memory store rather than reached through a live containerized run. The shape
// itself is production-reachable — runNext.ts:1067-1090 (dispatchReds) inserts
// exactly this row (parentId = primary, phase = step.id, agentRole =
// "shipping-reviewer", status failed) when the reviewer context packet is missing
// required fields. The real seeds/workflows/feature.yml is used verbatim.
//
// Run: bash docs/plans/foundations-lane-c-probes/p2-retry-shipping-reviewer.sh
import { cpSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { makeInMemoryDb, setDbForTest } from "../../../src/store/db.js";
import { insertRun } from "../../../src/store/runs.js";
import { insertTask, tasksForRun } from "../../../src/store/tasks.js";
import { logEvent } from "../../../src/store/events.js";
import { retry, FanoutChildRetryError } from "../../../src/v2/retry.js";
import { loadWorkflow } from "../../../src/v2/loader.js";
import { classifyTaskLineage } from "../../../src/v2/lifecycle-evaluator.js";
import { computeReadyQueue, isRunSettled } from "../../../src/v2/ready-queue.js";
import type { Run, Task } from "../../../src/types/index.js";

const HOME = process.env["FORGE_HOME"]!;
mkdirSync(join(HOME, "workflows"), { recursive: true });
cpSync("seeds/workflows/feature.yml", join(HOME, "workflows", "feature.yml"));
const workflow = loadWorkflow("feature");
const buildStep = workflow.steps.find((s) => s.id === "build")!;
console.log("### feature.yml `build` step: fanout =", !!buildStep.fanout,
  "| reds =", buildStep.reds.map((r) => r.agent).join(", "));

const RUN: Run = {
  id: "run-p2", workflow: "feature", title: "probe", status: "active",
  projectDir: "/tmp/test-project", createdAt: "2026-07-14T00:00:00.000Z",
};

function mkComplete(id: string, phase: string, role: string, at: string, result?: unknown): Task {
  return {
    id, runId: RUN.id, phase, agentRole: role, status: "complete",
    ...(result !== undefined ? { result } : {}),
    taskPackage: { taskId: id, runId: RUN.id, phase, role, inputs: {}, composedSystemPrompt: "", dispatchSource: "workflow" },
    createdAt: at,
  };
}

function seed(): void {
  insertRun(RUN);
  // build's deps, complete — so the ready queue's dep check on `build` is satisfied
  // and the only thing gating `build` is its own attempt rows.
  insertTask(mkComplete("architect-1", "architect", "architecture-advisor", "2026-07-13T00:00:00.000Z"));
  insertTask(mkComplete("plan-1", "plan", "tech-lead", "2026-07-13T01:00:00.000Z", { steps: [{ id: "s1" }] }));
  const primary: Task = {
    id: "build-primary", runId: RUN.id, phase: "build", agentRole: "engineer",
    status: "blocked_by_red",
    taskPackage: { taskId: "build-primary", runId: RUN.id, phase: "build", role: "engineer",
      inputs: {}, composedSystemPrompt: "", dispatchSource: "workflow" },
    createdAt: "2026-07-14T00:00:01.000Z",
  };
  // dispatchReds' pre-fail row: note the TASK ID is `red-build-...` but the
  // agentRole — which every legacy predicate tests — is `shipping-reviewer`.
  const red: Task = {
    id: "red-build-sr", runId: RUN.id, parentId: "build-primary", phase: "build",
    agentRole: "shipping-reviewer", status: "failed",
    error: "shipping-reviewer: missing required context (planPath)",
    taskPackage: { taskId: "red-build-sr", runId: RUN.id, phase: "build", role: "shipping-reviewer",
      inputs: {}, composedSystemPrompt: "", dispatchSource: "workflow" },
    createdAt: "2026-07-14T00:00:02.000Z",
  };
  insertTask(primary);
  insertTask(red);
  logEvent("task.failed", { runId: RUN.id, taskId: red.id, payload: { failure_kind: "unknown", error: red.error } });
}

// ---- A. TODAY: forge retry refuses the failed shipping-reviewer ----
{
  const db = makeInMemoryDb();
  setDbForTest(db);
  seed();
  const kinds = classifyTaskLineage(workflow, tasksForRun(RUN.id));
  console.log("\n### A. TODAY (unmigrated retry.ts)");
  console.log("classifier kind of red-build-sr:", kinds.get("red-build-sr"));
  try {
    await retry("red-build-sr");
    console.log("retry() RESOLVED — no refusal (UNEXPECTED)");
  } catch (e) {
    console.log("retry() threw:", (e as Error).name);
    console.log("  fanout child?", e instanceof FanoutChildRetryError);
    console.log("  message:", (e as Error).message);
  }
  db.close();
}

// ---- B. POST-MIGRATION SHAPE: what allowing the retry actually produces ----
// `--force` bypasses fanoutParentOf's refusal, so it mints EXACTLY the row a
// classifier-migrated retry.ts would mint (retry.ts:427-467 — parentId left
// undefined by design). This is the row shape, not a mock of it.
{
  const db = makeInMemoryDb();
  setDbForTest(db);
  seed();
  console.log("\n### B. POST-MIGRATION SHAPE (retry --force mints the same row a migrated retry.ts would)");
  const out = await retry("red-build-sr", { force: true });
  const rows = tasksForRun(RUN.id);
  const kinds = classifyTaskLineage(workflow, rows);
  console.log("new row:", JSON.stringify({
    id: out.newTask.id, phase: out.newTask.phase, agentRole: out.newTask.agentRole,
    parentId: out.newTask.parentId ?? null, status: out.newTask.status,
  }));
  console.log("classifier kind of the NEW row:", kinds.get(out.newTask.id));
  console.log("rows in phase `build`:", rows.filter((t) => t.phase === "build")
    .map((t) => `${t.id}[${t.status},parent=${t.parentId ?? "-"},kind=${kinds.get(t.id)}]`).join("  "));
  console.log("computeReadyQueue ->", computeReadyQueue(workflow, rows).map((s) => s.id).join(",") || "(empty)");
  console.log("isRunSettled ->", isRunSettled(workflow, rows));

  // What dispatchFanoutStep would then do with that row. This mirrors its
  // existingParent lookup VERBATIM (runNext.ts:1572-1574) — a source mirror, not an
  // execution of dispatchFanoutStep (which needs a container runtime).
  const existingParent = rows.find(
    (t) => t.phase === "build" && t.parentId === undefined && t.status === "pending",
  );
  console.log("dispatchFanoutStep existingParent (mirror of runNext.ts:1572-1574) ->",
    existingParent ? `${existingParent.id} (agentRole=${existingParent.agentRole})` : "(none)");
  console.log("  => the next `forge next` adopts the RED's retry row as the fanout PARENT of a fresh wave.");
  db.close();
}
