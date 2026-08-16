// FG-385 integration coverage: the risk-targeted plan remains advisory and survives
// the real Reviewer Context Packet assembly seam used to hand context to the Shipping Reviewer.

import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { insertRun } from "../store/runs.js";
import { insertTask } from "../store/tasks.js";
import type { Run, Task, TaskPackage } from "../types/index.js";
import { assembleReviewerContextPacket } from "./reviewer-context-packet.js";
import { planRiskReds, RISK_SIGNALS, type PlanRiskRedsInput } from "./risk-reds-planner.js";

let db: DatabaseInstance;
let previousDb: DatabaseInstance | null;

beforeEach(() => {
  db = makeInMemoryDb();
  previousDb = setDbForTest(db);
});

afterEach(() => {
  setDbForTest(previousDb as DatabaseInstance);
  db.close();
});

function insertPrimaryTask(runId: string): void {
  const taskPackage: TaskPackage = {
    taskId: "task-fg385-engineer",
    runId,
    phase: "build",
    role: "engineer",
    inputs: {},
    composedSystemPrompt: "",
  };
  const task: Task = {
    id: taskPackage.taskId,
    runId,
    phase: taskPackage.phase,
    agentRole: taskPackage.role,
    status: "complete",
    taskPackage,
    createdAt: "2026-08-16T00:00:00Z",
    result: { status: "complete", files_modified: ["src/v2/project-auth.ts"] },
  };
  insertTask(task);
}

function advisoryInput(overrides: Partial<PlanRiskRedsInput> = {}): PlanRiskRedsInput {
  return {
    route: "review_backend",
    changedPathClasses: [],
    acceptanceRefs: ["FG-385 AC 1"],
    protectedInvariants: ["a missing red is never represented as passed"],
    riskSignals: [],
    ...overrides,
  };
}

test("FG-385: packet assembly carries the complete advisory plan to the Shipping Reviewer", () => {
  const run: Run = {
    id: "run-fg385",
    workflow: "feature",
    title: "risk reds packet transport",
    status: "active",
    createdAt: "2026-08-16T00:00:00Z",
  };
  insertRun(run);
  insertPrimaryTask(run.id);

  const plan = planRiskReds(
    advisoryInput({
      changedPathClasses: [
        { signal: RISK_SIGNALS[0], paths: ["src/v2/lifecycle-evaluator.ts"] },
        { signal: RISK_SIGNALS[2], paths: ["src/v2/project-auth.ts"] },
      ],
      // The lifecycle selections can run; security is deliberately unavailable.
      availableLenses: ["wide", "narrow", "frontend", "backend"],
    }),
  );
  assert.deepEqual(plan.selectedLenses, ["narrow", "backend"]);
  assert.equal(plan.perLens.length, 2);
  assert.deepEqual(plan.unavailable.map(({ lens }) => lens), ["security"]);
  assert.deepEqual(plan.skipped.map(({ lens }) => lens), ["wide", "frontend"]);

  const packet = assembleReviewerContextPacket(run.id, "task-fg385-engineer", "/project", undefined, plan);

  // This is intentionally identity-preserving transport: no packet layer may rewrite a
  // selected lens, discard its attack spec, or turn unavailable into skipped/passed.
  assert.strictEqual(packet.riskRedsPlan, plan);
  assert.deepEqual(packet.riskRedsPlan, plan);
  assert.deepEqual(packet.riskRedsPlan?.perLens, plan.perLens);
  assert.deepEqual(packet.riskRedsPlan?.unavailable, plan.unavailable);
  assert.deepEqual(packet.riskRedsPlan?.skipped, plan.skipped);
});

test("FG-385: planner is immutable advisory data and has no review-contract authority call", () => {
  const input = advisoryInput({
    changedPathClasses: [{ signal: RISK_SIGNALS[4], paths: ["src/store/migrations/003.sql"] }],
  });
  const before = structuredClone(input);
  Object.freeze(input.changedPathClasses[0]!.paths);
  Object.freeze(input.changedPathClasses[0]!);
  Object.freeze(input.changedPathClasses);
  Object.freeze(input.acceptanceRefs);
  Object.freeze(input.protectedInvariants);
  Object.freeze(input.riskSignals);
  Object.freeze(input);

  const plan = planRiskReds(input);

  assert.deepEqual(input, before, "planning must not mutate the authored classification or review inputs");
  assert.deepEqual(
    Object.keys(plan).sort(),
    ["perLens", "reason", "selectedLenses", "skipped", "unavailable"],
    "planner returns only advisory selection/attack data, not a persisted or confirmed review contract",
  );
  assert.ok(!("risk_lenses" in plan) && !("threat_model" in plan), "plan is not a review-contract shape");

  const plannerPath = fileURLToPath(new URL("./risk-reds-planner.ts", import.meta.url));
  const implementation = readFileSync(plannerPath, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(
    implementation,
    /\b(?:confirmContract|selectRedsForContract)\s*\(/,
    "the advisory planner must not invoke review-contract confirmation or red-selection authority",
  );
  assert.doesNotMatch(
    implementation,
    /import\s*\{[^}]*\b(?:confirmContract|selectRedsForContract)\b[^}]*\}\s*from/,
    "the advisory planner must not import review-contract authority",
  );
});
