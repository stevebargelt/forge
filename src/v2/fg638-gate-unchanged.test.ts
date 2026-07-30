// FG-638 explicit NON-GOAL, NARROWED BY FG-640: no LEGACY gate reads ledger state.
//
// Change 1 added durable review state and read surfaces and moved the gate not one inch.
// Change 3 (FG-640) moved it deliberately — but only for runs that declare
// `review_mode: evidence_led`. So this file now holds BOTH halves of that boundary, and the
// legacy half is the one that must never weaken:
//
//   legacy_verdict  — `verdict` aggregation and `blocked_by_red` behave exactly as they did
//                     before the ledger existed, whether or not a review with untriaged,
//                     architecture-question or fix_now findings sits alongside the run. Proved
//                     by byte-equivalence rather than spot check: the whole observable gate
//                     surface (aggregation, every refusal message, the resulting task row, the
//                     gate row, the gate.decided payload) is captured as one snapshot and taken
//                     twice — once with no ledger rows, once with a full review — and the two
//                     must be equal.
//
//   evidence_led    — the SAME ledger, on a run stamped evidence_led, DOES decide the gate. The
//                     second half below asserts the two snapshots DIVERGE there, so a future
//                     change that quietly reverts Change 3 (or that leaks the new gate into a
//                     legacy run) fails here in one direction or the other.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest, getDb } from "../store/db.js";
import { insertRun } from "../store/runs.js";
import { insertTask, getTask } from "../store/tasks.js";
import { insertVerdict, verdictsForTask } from "../store/verdicts.js";
import { gatesForTask } from "../store/gates.js";
import { insertReview, ingestFindings, recordDisposition, setReviewState } from "../store/reviews.js";
import { aggregateVerdicts, gate } from "./gate.js";
import { publishFlatAsGeneration } from "./seed-generation.testkit.js";
import type { ReviewMode, Run, Task } from "../types/index.js";

const WORKFLOW = "fg638-gate-unchanged";
const RUN: Run = {
  id: "run-fg638-gate",
  workflow: WORKFLOW,
  title: "gate is unchanged by the ledger",
  status: "active",
  createdAt: "2026-07-30T00:00:00Z",
};

let db: DatabaseInstance;
let prev: DatabaseInstance | null;
let originalForgeHome: string | undefined;
let homeDir: string;

function ensureWorkflow(reviewMode: ReviewMode = "legacy_verdict"): void {
  mkdirSync(join(homeDir, "workflows"), { recursive: true });
  writeFileSync(
    join(homeDir, "workflows", `${WORKFLOW}.yml`),
    `name: ${WORKFLOW}
description: test
review_mode: ${reviewMode}
inputs: []
steps:
  - id: step-auto
    agent: security-advisor
    gate: verdict
    reds:
      - agent: red-wide
        authority: authoritative
        gate_on_verdict: true
`,
  );
  publishFlatAsGeneration(homeDir);
}

function stubTask(id: string, phase: string, role: string, status: Task["status"]): void {
  insertTask({
    id,
    runId: RUN.id,
    phase,
    agentRole: role,
    status,
    taskPackage: { taskId: id, runId: RUN.id, phase, role, inputs: {}, composedSystemPrompt: "P" },
    createdAt: "2026-07-30T00:00:00Z",
  });
}

function authoritativeFail(taskId: string, id: string): void {
  stubTask(`${id}-red`, "red", "red-1", "complete");
  insertVerdict({
    id,
    taskId,
    redTaskId: `${id}-red`,
    redRole: "red-1",
    verdict: "fail",
    confidence: 0.9,
    authority: "authoritative",
    findings: [{ severity: "high", summary: "raw red finding", evidence: "e", hypothesis: "h" }],
    createdAt: "2026-07-30T00:00:01Z",
    gateOnVerdict: true,
  });
}

/** A full review over the same run/task: every disposition state the gate could
 *  conceivably be tempted to read, including untriaged and architecture_question. */
function seedLedger(subjectTaskId: string, reviewMode: ReviewMode): void {
  insertReview({
    id: "review-gate",
    runId: RUN.id,
    subjectTaskId,
    ticketId: "FG-638",
    reviewMode,
    candidateSha: "cand111",
    state: "awaiting_disposition",
  });
  ingestFindings("review-gate", [
    { summary: "untriaged and blocking-looking", severity: "high", riskLens: "security" },
    { summary: "an open architecture question", severity: "high" },
    { summary: "already decided", severity: "low" },
  ]);
  recordDisposition("review-gate/RF-2", {
    decision: "architecture_question",
    rationale: "changes acceptance scope",
    operator: false,
  });
  recordDisposition("review-gate/RF-3", { decision: "fix_now", rationale: "fix it", operator: false });
  setReviewState("review-gate", "fixing");
}

async function refusal(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    return "<no refusal>";
  } catch (e) {
    return (e as Error).message;
  }
}

/** Everything an operator or a caller can observe about the gate, as one value. */
async function gateSurface(withLedger: boolean, reviewMode: ReviewMode = "legacy_verdict"): Promise<unknown> {
  ensureWorkflow(reviewMode);
  db = makeInMemoryDb();
  prev = setDbForTest(db);
  insertRun({ ...RUN, reviewMode });

  stubTask("task-awaiting", "step-auto", "security-advisor", "awaiting_gate");
  stubTask("task-blocked", "step-auto", "security-advisor", "blocked_by_red");
  authoritativeFail("task-awaiting", "verdict-awaiting");
  authoritativeFail("task-blocked", "verdict-blocked");
  if (withLedger) seedLedger("task-awaiting", reviewMode);

  const snapshot = {
    aggregation: aggregateVerdicts(verdictsForTask("task-awaiting")),
    advanceWithoutForce: await refusal(() => gate("task-awaiting", "advance", undefined, {})),
    blockedWithoutForce: await refusal(() => gate("task-blocked", "advance", undefined, {})),
    blockedForcedWithoutRationale: await refusal(() => gate("task-blocked", "advance", undefined, { force: true })),
    statusesAfterRefusals: {
      awaiting: getTask("task-awaiting")!.status,
      blocked: getTask("task-blocked")!.status,
    },
    forcedAdvance: (await gate("task-awaiting", "advance", "operator override", { force: true })).task.status,
    gateRows: gatesForTask("task-awaiting").map((g) => ({ decision: g.decision, rationale: g.rationale, decidedBy: g.decidedBy })),
    gateEvents: (
      getDb()
        .prepare(`SELECT task_id, payload FROM events WHERE event_type = 'gate.decided' ORDER BY id ASC`)
        .all() as { task_id: string; payload: string }[]
    ).map((e) => ({ taskId: e.task_id, payload: JSON.parse(e.payload) as unknown })),
    verdictsUnchanged: verdictsForTask("task-awaiting").map((v) => ({ id: v.id, verdict: v.verdict, authority: v.authority })),
  };

  setDbForTest(prev as DatabaseInstance);
  db.close();
  return snapshot;
}

beforeEach(() => {
  originalForgeHome = process.env.FORGE_HOME;
  homeDir = mkdtempSync(join(tmpdir(), "forge-fg638-gate-"));
  process.env.FORGE_HOME = homeDir;
});

afterEach(() => {
  if (originalForgeHome === undefined) delete process.env.FORGE_HOME;
  else process.env.FORGE_HOME = originalForgeHome;
  rmSync(homeDir, { recursive: true, force: true });
});

test("FG-638 non-goal: the entire gate surface is identical with and without ledger rows", async () => {
  const without = await gateSurface(false);
  const with_ = await gateSurface(true);
  assert.deepEqual(with_, without, "the gate must not read review-ledger state");
});

test("FG-638 non-goal: the ledger does not soften an authoritative fail or blocked_by_red", async () => {
  const surface = (await gateSurface(true)) as {
    aggregation: { verdict: string };
    advanceWithoutForce: string;
    blockedWithoutForce: string;
    statusesAfterRefusals: { awaiting: string; blocked: string };
  };
  // The snapshot equality above would also pass if BOTH sides stopped blocking, so
  // pin the behavior itself, not only its invariance.
  assert.equal(surface.aggregation.verdict, "fail");
  assert.match(surface.advanceWithoutForce, /verdict aggregation = fail/);
  assert.match(surface.blockedWithoutForce, /blocked_by_red/);
  assert.equal(surface.statusesAfterRefusals.awaiting, "awaiting_gate");
  assert.equal(surface.statusesAfterRefusals.blocked, "blocked_by_red");
});

// ── FG-640: the SAME ledger, on an evidence_led run, DOES decide the gate ──────

test("FG-640: on an evidence_led run the ledger CHANGES the gate surface — the non-goal is scoped to legacy", async () => {
  const without = await gateSurface(false, "evidence_led");
  const with_ = await gateSurface(true, "evidence_led");
  assert.notDeepEqual(
    with_,
    without,
    "an evidence_led run must read the ledger — if these are equal, Change 3's gate is inert",
  );
});

test("FG-640: the evidence_led refusal is the disposition gate, naming its conditions — not verdict aggregation", async () => {
  const surface = (await gateSurface(true, "evidence_led")) as { advanceWithoutForce: string };
  assert.match(surface.advanceWithoutForce, /gate kind 'review_disposition'/);
  assert.match(surface.advanceWithoutForce, /finding_untriaged/);
  assert.match(surface.advanceWithoutForce, /architecture_question_open/);
  assert.match(surface.advanceWithoutForce, /fix_now_unresolved/);
  assert.doesNotMatch(surface.advanceWithoutForce, /verdict aggregation = fail/);
});

test("FG-640: an evidence_led run carrying a still-AUTHORITATIVE verdict is refused as mixed authority", async () => {
  // This fixture is exactly the half-migrated shape: the run declares evidence_led while a red
  // still writes an authoritative, gate_on_verdict verdict. Silently dropping that verdict is
  // the failure mode the condition exists to refuse.
  const surface = (await gateSurface(true, "evidence_led")) as { advanceWithoutForce: string };
  assert.match(surface.advanceWithoutForce, /mixed_authority_model/);
  assert.match(surface.advanceWithoutForce, /exactly one review_mode settles a run/);
});

test("FG-640: an evidence_led run with NO ledger fails closed rather than reading clean", async () => {
  const surface = (await gateSurface(false, "evidence_led")) as { advanceWithoutForce: string; statusesAfterRefusals: { awaiting: string } };
  assert.match(surface.advanceWithoutForce, /review_absent/);
  assert.equal(surface.statusesAfterRefusals.awaiting, "awaiting_gate", "FG-585: still awaiting_gate, no new status");
});
