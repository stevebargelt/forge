// FG-640: the two authority models are ISOLATED, proved differentially by poisoning the path
// each one must not read.
//
// "One review_mode per run, never combined" is easy to assert weakly — a test that shows an
// evidence-led run advancing over a settled ledger passes just as happily if `gate()` also
// consulted verdict aggregation and happened to find nothing to object to. The only honest proof
// is a DIFFERENTIAL one: put something in the unused path that the OTHER model demonstrably
// refuses on, and show it has no effect here while the same rows on the other model's run block.
//
//   evidence_led → verdict aggregation is never consulted. Poison: specialist `fail` verdicts with
//                  no `--rationale`, which is exactly what legacy refuses to advance over. The
//                  evidence-led gate's outcome must be INVARIANT across 0, 1 and 3 of them.
//   legacy       → the ledger is never consulted. Poison: a review carrying every blocking
//                  condition at once. fg638-gate-unchanged.test.ts snapshots the legacy surface
//                  with a partial ledger; this adds the maximally-poisoned one and the mirror
//                  assertion that the SAME ledger blocks an evidence-led run.
//
// The authoritative verdict is deliberately NOT a poison: under evidence_led it is refused by name
// as `mixed_authority_model`, which is the opposite of being ignored. That case lives in
// fg640-gate-condition-matrix.test.ts; the point here is the rows that are genuinely inert.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { insertRun } from "../store/runs.js";
import { insertTask, getTask } from "../store/tasks.js";
import { insertVerdict } from "../store/verdicts.js";
import { gatesForTask } from "../store/gates.js";
import {
  insertReview,
  ingestFindings,
  recordDisposition,
  recordStageEvidence,
  setReviewState,
} from "../store/reviews.js";
import { gate } from "./gate.js";
import { publishFlatAsGeneration } from "./seed-generation.testkit.js";
import type { Run, Task, ReviewMode } from "../types/index.js";

const SHA = "cand640iso";
const TASK = "task-build";
const RUN_ID = "run-iso";

const CONTRACT = {
  threat_model: "a run settled by two authority models at once",
  protected_invariants: ["one review_mode per run"],
  acceptance_refs: ["FG-640 AC 18"],
  risk_lenses: ["backend"],
  non_goals: [],
};

let db: DatabaseInstance;
let prev: DatabaseInstance | null;
let originalForgeHome: string | undefined;
let homeDir: string;

/** ONE workflow file per mode, differing only in the cutover line and its consequence — a
 *  migrated workflow's reds are advisory, an unmigrated one's are authoritative. */
function writeWorkflows(): void {
  mkdirSync(join(homeDir, "workflows"), { recursive: true });
  for (const [name, mode, authority, gateOn] of [
    ["wf-el", "evidence_led", "specialist", "false"],
    ["wf-legacy", "legacy_verdict", "specialist", "false"],
  ] as const) {
    writeFileSync(
      join(homeDir, "workflows", `${name}.yml`),
      `name: ${name}
description: test
review_mode: ${mode}
inputs: []
steps:
  - id: build
    agent: engineer
    gate: verdict
    reds:
      - agent: red-backend
        authority: ${authority}
        gate_on_verdict: ${gateOn}
`,
    );
  }
  publishFlatAsGeneration(homeDir);
}

function seedRun(workflow: string, reviewMode: ReviewMode): Run {
  const run: Run = {
    id: RUN_ID,
    workflow,
    title: "authority isolation",
    status: "active",
    createdAt: "2026-07-30T00:00:00Z",
    reviewMode,
  };
  insertRun(run);
  const task: Task = {
    id: TASK,
    runId: run.id,
    phase: "build",
    agentRole: "engineer",
    status: "awaiting_gate",
    taskPackage: { taskId: TASK, runId: run.id, phase: "build", role: "engineer", inputs: {}, composedSystemPrompt: "P" },
    createdAt: "2026-07-30T00:00:00Z",
  };
  insertTask(task);
  return run;
}

function checks(): unknown[] {
  return [
    { id: "verification_green", ok: true, detail: "green" },
    { id: "acceptance_mapped", ok: true, detail: "1 acceptance criterion met on executed evidence" },
    { id: "findings_settled", ok: true, detail: "settled" },
    { id: "fix_now_resolved", ok: true, detail: "resolved" },
    { id: "tip_equality", ok: true, detail: "equal" },
    { id: "identity_continuity", ok: true, detail: "continuous" },
    { id: "contract_covers_diff", ok: true, detail: "covered" },
    { id: "docs_closeout", ok: true, detail: "no gaps" },
  ];
}

function settledLedger(reviewMode: ReviewMode): void {
  insertReview({
    id: "review-iso",
    runId: RUN_ID,
    subjectTaskId: TASK,
    ticketId: "FG-640",
    reviewMode,
    candidateSha: SHA,
    contractConfirmedSha: SHA,
    trustedRemoteSha: SHA,
    contract: CONTRACT,
    lensOutcomes: [{ lens: "backend", role: "red-backend", complete: true, outcome: "pass", authored: true, findings: [] }],
    state: "shipping_review",
  });
  recordStageEvidence("review-iso", "verified_final", { sha: SHA, detail: `green CI at ${SHA}` });
  recordStageEvidence("review-iso", "shipping", { sha: SHA, detail: "shipping", meta: { checks: checks() } });
  setReviewState("review-iso", "settled");
}

/** Every blocking condition the ledger half can carry, at once. Nothing here is subtle: if a
 *  legacy gate reads ANY of it, the legacy assertions below stop passing. */
function poisonedLedger(reviewMode: ReviewMode): void {
  insertReview({
    id: "review-iso",
    runId: RUN_ID,
    subjectTaskId: TASK,
    ticketId: "FG-640",
    reviewMode,
    candidateSha: SHA,
    // no contractConfirmedSha, no trustedRemoteSha, no stage evidence, an unreadable contract
    contract: { threat_model: "half a contract" },
    state: "awaiting_disposition",
  });
  const [a, b, c] = ingestFindings("review-iso", [
    { summary: "untriaged and blocking-looking", severity: "high" },
    { summary: "an open architecture question", severity: "high" },
    { summary: "a demonstrated defect to fix", severity: "high", reachability: "demonstrated" },
  ]);
  assert.ok(a && b && c);
  recordDisposition(b.id, { decision: "architecture_question", rationale: "changes acceptance scope", operator: false });
  recordDisposition(c.id, { decision: "fix_now", rationale: "fix it", operator: false });
  setReviewState("review-iso", "fixing");
}

/** N specialist `fail` verdicts on the gated task — advisory under evidence_led, and exactly what
 *  legacy aggregation refuses to advance over without a rationale. */
function specialistFails(n: number): void {
  for (let i = 1; i <= n; i++) {
    const redTask = `task-red-${i}`;
    insertTask({
      id: redTask,
      runId: RUN_ID,
      phase: "build",
      agentRole: "red-backend",
      status: "complete",
      taskPackage: { taskId: redTask, runId: RUN_ID, phase: "build", role: "red-backend", inputs: {}, composedSystemPrompt: "P" },
      createdAt: "2026-07-30T00:00:00Z",
    });
    insertVerdict({
      id: `v-specialist-${i}`,
      taskId: TASK,
      redTaskId: redTask,
      redRole: `red-backend-${i}`,
      verdict: "fail",
      confidence: 0.9,
      authority: "specialist",
      findings: [{ severity: "high", summary: `raw red objection ${i}`, evidence: "e", hypothesis: "h" }],
      createdAt: `2026-07-30T00:00:0${i}Z`,
      gateOnVerdict: false,
    });
  }
}

async function attempt(): Promise<string> {
  try {
    const r = await gate(TASK, "advance", undefined, {});
    return `advanced:${r.task.status}`;
  } catch (e) {
    return (e as Error).message;
  }
}

beforeEach(() => {
  originalForgeHome = process.env.FORGE_HOME;
  homeDir = mkdtempSync(join(tmpdir(), "forge-fg640-iso-"));
  process.env.FORGE_HOME = homeDir;
  writeWorkflows();
  db = makeInMemoryDb();
  prev = setDbForTest(db);
});

afterEach(() => {
  setDbForTest(prev as DatabaseInstance);
  db.close();
  if (originalForgeHome === undefined) delete process.env.FORGE_HOME;
  else process.env.FORGE_HOME = originalForgeHome;
  rmSync(homeDir, { recursive: true, force: true });
});

// ── evidence_led never consults verdict aggregation ──────────────────────────

test("FG-640: the evidence_led gate outcome is INVARIANT across 0, 1 and 3 advisory red fails", async () => {
  const outcomes: string[] = [];
  for (const n of [0, 1, 3]) {
    db.close();
    db = makeInMemoryDb();
    setDbForTest(db);
    seedRun("wf-el", "evidence_led");
    settledLedger("evidence_led");
    specialistFails(n);
    outcomes.push(await attempt());
  }
  assert.deepEqual(
    outcomes,
    ["advanced:complete", "advanced:complete", "advanced:complete"],
    "poisoning the verdict table must not move the evidence-led gate one inch",
  );
});

test("FG-640: the SAME poison blocks a legacy run — the poison is real, not inert everywhere", async () => {
  seedRun("wf-legacy", "legacy_verdict");
  settledLedger("legacy_verdict");
  specialistFails(3);

  const msg = await attempt();
  assert.match(msg, /Specialist red\(s\) failed on task-build/, "legacy aggregation still refuses these rows");
  assert.match(msg, /Provide --rationale/);
  assert.equal(getTask(TASK)!.status, "awaiting_gate");
});

test("FG-640: an evidence_led advance over advisory fails records no rationale — none was demanded", async () => {
  seedRun("wf-el", "evidence_led");
  settledLedger("evidence_led");
  specialistFails(2);

  const result = await gate(TASK, "advance", undefined, {});
  assert.equal(result.task.status, "complete");
  // The legacy model's whole objection is "advance over their objections WITH a rationale"; the
  // evidence-led model has no such concept, so the recorded decision carries none.
  const rows = gatesForTask(TASK);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.rationale, undefined);
});

// ── legacy never consults the ledger ─────────────────────────────────────────

test("FG-640: a legacy run advances over a MAXIMALLY poisoned ledger — the ledger is not its authority", async () => {
  seedRun("wf-legacy", "legacy_verdict");
  poisonedLedger("legacy_verdict");

  const result = await gate(TASK, "advance", undefined, {});
  assert.equal(result.task.status, "complete", "no ledger row may reach a legacy gate");
});

test("FG-640: the SAME poisoned ledger blocks an evidence_led run on every condition it carries", async () => {
  seedRun("wf-el", "evidence_led");
  poisonedLedger("evidence_led");

  const msg = await attempt();
  assert.match(msg, /gate kind 'review_disposition'/);
  for (const id of [
    "contract_unreadable",
    "finding_untriaged",
    "architecture_question_open",
    "fix_now_unresolved",
    "verification_absent_or_red",
    "acceptance_unmet",
    "tip_not_trusted",
  ]) {
    assert.match(msg, new RegExp(id), `the poisoned ledger must trip ${id} under evidence_led`);
  }
  assert.equal(getTask(TASK)!.status, "awaiting_gate");
});

// ── the audit record names which model decided, and only where it did ────────

test("FG-640: gateKind appears in the audit payload for evidence_led and is ABSENT for legacy", async () => {
  const payloads: Record<string, unknown> = {};
  for (const [workflow, mode] of [
    ["wf-el", "evidence_led"],
    ["wf-legacy", "legacy_verdict"],
  ] as const) {
    db.close();
    db = makeInMemoryDb();
    setDbForTest(db);
    seedRun(workflow, mode);
    settledLedger(mode);
    await gate(TASK, "advance", undefined, {});
    const rows = db.prepare(`SELECT payload FROM events WHERE event_type = 'gate.decided'`).all() as { payload: string }[];
    payloads[mode] = JSON.parse(rows[0]!.payload) as unknown;
  }

  assert.deepEqual(payloads["evidence_led"], {
    decision: "advance",
    force: false,
    gateKind: "review_disposition",
  });
  assert.deepEqual(
    payloads["legacy_verdict"],
    { decision: "advance", force: false },
    "a legacy run's audit payload carries no gateKind key at all — not `gateKind: null`",
  );
});
