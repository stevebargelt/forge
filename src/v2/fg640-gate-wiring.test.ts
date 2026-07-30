// FG-640: the `review_disposition` gate as `forge gate` actually reaches it.
//
// fg640-review-disposition-gate.test.ts proves the DERIVATION over hand-built rows. This file
// proves the WIRING: a real run stamped `evidence_led` from a real workflow, a real ledger
// written through the real store accessors, and the real `gate()` entry point — because a
// perfect derivation nothing calls is not a gate.
//
// AC scenarios placed here because this is where they are decided:
//   #21 — one selected lens crashes while the others pass; the gate stays blocked.
//   #22 — a reviewer-authored `inconclusive` completes discovery (and must be dispositioned);
//         a SYNTHESIZED one does not complete it.
//   #18 — a settled ledger advances with no --force.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest, getDb } from "../store/db.js";
import { insertRun } from "../store/runs.js";
import { insertTask, getTask } from "../store/tasks.js";
import { insertVerdict } from "../store/verdicts.js";
import {
  insertReview,
  ingestFindings,
  recordDisposition,
  recordResolution,
  recordStageEvidence,
  updateReview,
  setReviewState,
} from "../store/reviews.js";
import { gate } from "./gate.js";
import { publishFlatAsGeneration } from "./seed-generation.testkit.js";
import type { Run, Task, ReviewMode } from "../types/index.js";

const SHA = "cand640wire";
const CONTRACT = {
  threat_model: "an evidence-led gate that can be talked past",
  protected_invariants: ["one review_mode per run"],
  acceptance_refs: ["FG-640 AC 18"],
  risk_lenses: ["backend", "security"],
  non_goals: [],
};

let db: DatabaseInstance;
let prev: DatabaseInstance | null;
let originalForgeHome: string | undefined;
let homeDir: string;

function writeWorkflow(name: string, reviewMode: ReviewMode): void {
  mkdirSync(join(homeDir, "workflows"), { recursive: true });
  writeFileSync(
    join(homeDir, "workflows", `${name}.yml`),
    `name: ${name}
description: test
review_mode: ${reviewMode}
inputs: []
steps:
  - id: build
    agent: engineer
    gate: verdict
    reds:
      - agent: red-backend
        authority: ${reviewMode === "evidence_led" ? "specialist" : "authoritative"}
        gate_on_verdict: ${reviewMode === "evidence_led" ? "false" : "true"}
`,
  );
  publishFlatAsGeneration(homeDir);
}

function seedRun(workflow: string, reviewMode: ReviewMode): Run {
  const run: Run = {
    id: `run-${workflow}`,
    workflow,
    title: "gate wiring",
    status: "active",
    createdAt: "2026-07-30T00:00:00Z",
    reviewMode,
  };
  insertRun(run);
  const task: Task = {
    id: "task-build",
    runId: run.id,
    phase: "build",
    agentRole: "engineer",
    status: "awaiting_gate",
    taskPackage: { taskId: "task-build", runId: run.id, phase: "build", role: "engineer", inputs: {}, composedSystemPrompt: "P" },
    createdAt: "2026-07-30T00:00:00Z",
  };
  insertTask(task);
  return run;
}

function lensOutcome(lens: string, over: Record<string, unknown> = {}): unknown {
  return { lens, role: `red-${lens}`, complete: true, outcome: "pass", authored: true, findings: [], ...over };
}

function shippingChecks(): unknown[] {
  return [
    { id: "verification_green", ok: true, detail: "green" },
    { id: "acceptance_mapped", ok: true, detail: "1 acceptance criteria met on executed evidence" },
    { id: "findings_settled", ok: true, detail: "settled" },
    { id: "fix_now_resolved", ok: true, detail: "resolved" },
    { id: "tip_equality", ok: true, detail: "equal" },
    { id: "identity_continuity", ok: true, detail: "continuous" },
    { id: "contract_covers_diff", ok: true, detail: "covered" },
    { id: "docs_closeout", ok: true, detail: "no gaps" },
  ];
}

/** A ledger that is settled in every respect the gate reads. Each test breaks one thing. */
function seedSettledLedger(runId: string, lensOutcomes: unknown[] = [lensOutcome("backend"), lensOutcome("security")]): string {
  insertReview({
    id: "review-wire",
    runId,
    subjectTaskId: "task-build",
    ticketId: "FG-640",
    reviewMode: "evidence_led",
    candidateSha: SHA,
    contractConfirmedSha: SHA,
    trustedRemoteSha: SHA,
    contract: CONTRACT,
    lensOutcomes,
    state: "shipping_review",
  });
  recordStageEvidence("review-wire", "verified_final", { sha: SHA, detail: "green CI at cand640wire" });
  recordStageEvidence("review-wire", "shipping", { sha: SHA, detail: "shipping", meta: { checks: shippingChecks() } });
  setReviewState("review-wire", "settled");
  return "review-wire";
}

beforeEach(() => {
  originalForgeHome = process.env.FORGE_HOME;
  homeDir = mkdtempSync(join(tmpdir(), "forge-fg640-wire-"));
  process.env.FORGE_HOME = homeDir;
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

async function refusal(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    return "<no refusal>";
  } catch (e) {
    return (e as Error).message;
  }
}

test("FG-640 / PRD #18: a settled ledger advances the evidence_led gate without --force", async () => {
  writeWorkflow("wf-el", "evidence_led");
  const run = seedRun("wf-el", "evidence_led");
  seedSettledLedger(run.id);

  const result = await gate("task-build", "advance", undefined, {});
  assert.equal(result.task.status, "complete");

  const events = getDb()
    .prepare(`SELECT payload FROM events WHERE event_type = 'gate.decided'`)
    .all() as { payload: string }[];
  const payload = JSON.parse(events[0]!.payload) as { gateKind?: string };
  assert.equal(payload.gateKind, "review_disposition", "the audit record names WHICH gate decided this step");
});

// THE SHAPE `forge review start` ACTUALLY CREATES. It binds a review to a ticket and a run —
// never to a task, and no verb binds one to a task afterwards. A gate that demanded
// subject_task_id would report `review_absent` on every real run with the settled ledger sitting
// right there on the run, making --force the only way past a gate built to be settled.
test("FG-640: a RUN-scoped review (no subject task) settles the gate — the shape forge review start creates", async () => {
  writeWorkflow("wf-el", "evidence_led");
  const run = seedRun("wf-el", "evidence_led");
  insertReview({
    id: "review-run-scoped",
    runId: run.id,
    ticketId: "FG-640",
    reviewMode: "evidence_led",
    candidateSha: SHA,
    contractConfirmedSha: SHA,
    trustedRemoteSha: SHA,
    contract: CONTRACT,
    lensOutcomes: [lensOutcome("backend"), lensOutcome("security")],
    state: "shipping_review",
  });
  recordStageEvidence("review-run-scoped", "verified_final", { sha: SHA, detail: "green" });
  recordStageEvidence("review-run-scoped", "shipping", { sha: SHA, detail: "shipping", meta: { checks: shippingChecks() } });
  setReviewState("review-run-scoped", "settled");

  const result = await gate("task-build", "advance", undefined, {});
  assert.equal(result.task.status, "complete");
});

test("FG-640: an untriaged finding holds the task at awaiting_gate — no new status, the gate kind is named", async () => {
  writeWorkflow("wf-el", "evidence_led");
  const run = seedRun("wf-el", "evidence_led");
  seedSettledLedger(run.id);
  ingestFindings("review-wire", [{ summary: "a defect nobody has decided about", severity: "high" }]);

  const msg = await refusal(() => gate("task-build", "advance", undefined, {}));
  assert.match(msg, /gate kind 'review_disposition'/);
  assert.match(msg, /finding_untriaged/);
  assert.match(msg, /RF-1/);
  assert.match(msg, /--force .* is NOT the ordinary settlement path/s);
  assert.equal(getTask("task-build")!.status, "awaiting_gate", "FG-585: no new task status was invented");
});

test("FG-640: --force with a rationale still overrides the disposition gate", async () => {
  writeWorkflow("wf-el", "evidence_led");
  const run = seedRun("wf-el", "evidence_led");
  seedSettledLedger(run.id);
  ingestFindings("review-wire", [{ summary: "undecided", severity: "high" }]);

  const result = await gate("task-build", "advance", "operator override, recorded", { force: true });
  assert.equal(result.task.status, "complete");
});

// ── AC #21 ───────────────────────────────────────────────────────────────────

test("FG-640 / PRD #21: one crashed selected lens keeps the gate blocked while the others pass", async () => {
  writeWorkflow("wf-el", "evidence_led");
  const run = seedRun("wf-el", "evidence_led");
  seedSettledLedger(run.id, [
    lensOutcome("backend"),
    { lens: "security", role: "red-security", complete: false, reason: "crashed", detail: "container_crash" },
  ]);

  const msg = await refusal(() => gate("task-build", "advance", undefined, {}));
  assert.match(msg, /lens_outcome_missing/);
  assert.match(msg, /security \(crashed/);
  // The point of the scenario: nothing about the OTHER lenses passing clears it, and no
  // disposition on some other finding clears it either.
  assert.doesNotMatch(msg, /backend \(/);
});

// ── AC #22 ───────────────────────────────────────────────────────────────────

test("FG-640 / PRD #22: a reviewer-AUTHORED inconclusive completes discovery but must be dispositioned", async () => {
  writeWorkflow("wf-el", "evidence_led");
  const run = seedRun("wf-el", "evidence_led");
  seedSettledLedger(run.id, [
    lensOutcome("backend"),
    lensOutcome("security", { outcome: "inconclusive", inconclusiveReason: "could not reach the auth path from the diff" }),
  ]);
  // Discovery normalizes an authored inconclusive into an ordinary untriaged ledger finding.
  ingestFindings("review-wire", [
    { summary: "security lens returned inconclusive: could not reach the auth path", findingType: "lens_inconclusive" },
  ]);

  const withFinding = await refusal(() => gate("task-build", "advance", undefined, {}));
  assert.doesNotMatch(withFinding, /lens_outcome_missing/, "the authored inconclusive IS a completed outcome");
  assert.match(withFinding, /finding_untriaged/, "and it is evidence that still has to be dispositioned");

  // Dispositioned by name, it settles and the gate clears.
  const outcome = recordDisposition("review-wire/RF-1", {
    decision: "accepted_risk",
    rationale: "the lens could not reach it; the surface is out of scope for this change",
    operator: true,
  });
  assert.equal(outcome.ok, true);
  const result = await gate("task-build", "advance", undefined, {});
  assert.equal(result.task.status, "complete");
});

test("FG-640 / PRD #22: a SYNTHESIZED inconclusive does not count as completed discovery", async () => {
  writeWorkflow("wf-el", "evidence_led");
  const run = seedRun("wf-el", "evidence_led");
  seedSettledLedger(run.id, [
    lensOutcome("backend"),
    { lens: "security", role: "red-security", complete: false, reason: "synthesized", detail: "forge synthesized this verdict, no reviewer authored it" },
  ]);

  const msg = await refusal(() => gate("task-build", "advance", undefined, {}));
  assert.match(msg, /lens_outcome_missing/);
  assert.match(msg, /security \(synthesized/);
});

// ── the fix_now round trip, through the real store ───────────────────────────

test("FG-640: a fix_now clears only with a resolution proportional to its reachability, at the current sha", async () => {
  writeWorkflow("wf-el", "evidence_led");
  const run = seedRun("wf-el", "evidence_led");
  seedSettledLedger(run.id);
  const [f] = ingestFindings("review-wire", [
    { summary: "a demonstrated data-loss path", severity: "high", reachability: "demonstrated" },
  ]);
  recordDisposition(f!.id, { decision: "fix_now", rationale: "fix it", operator: false });

  assert.match(await refusal(() => gate("task-build", "advance", undefined, {})), /fix_now_unresolved/);

  // Model re-inspection is not proof for a demonstrated finding (PRD #26).
  recordResolution(f!.id, { resolution: "resolved", evidenceKind: "bounded_inspection", evidence: "read the code", resolvedSha: SHA });
  assert.match(await refusal(() => gate("task-build", "advance", undefined, {})), /fix_now_evidence_insufficient/);

  // A named regression test that executed at this sha is.
  recordResolution(f!.id, {
    resolution: "resolved",
    evidenceKind: "regression_test",
    evidence: "ok 1 - the write path fsyncs before returning",
    resolvedSha: SHA,
  });
  const result = await gate("task-build", "advance", undefined, {});
  assert.equal(result.task.status, "complete");
});

test("FG-640: the candidate moving invalidates the resolution and re-blocks the gate", async () => {
  writeWorkflow("wf-el", "evidence_led");
  const run = seedRun("wf-el", "evidence_led");
  seedSettledLedger(run.id);
  const [f] = ingestFindings("review-wire", [{ summary: "a defect", severity: "high", reachability: "speculative" }]);
  recordDisposition(f!.id, { decision: "fix_now", rationale: "fix it", operator: false });
  recordResolution(f!.id, { resolution: "resolved", evidenceKind: "bounded_inspection", evidence: "read it", resolvedSha: SHA });
  assert.equal((await gate("task-build", "advance", undefined, {})).task.status, "complete");

  // A second task on the same run, gated after the candidate moved.
  insertTask({
    id: "task-build-2",
    runId: run.id,
    phase: "build",
    agentRole: "engineer",
    status: "awaiting_gate",
    taskPackage: { taskId: "task-build-2", runId: run.id, phase: "build", role: "engineer", inputs: {}, composedSystemPrompt: "P" },
    createdAt: "2026-07-30T00:00:01Z",
  });
  updateReview("review-wire", { candidateSha: "moved999" });
  insertReview({
    id: "review-wire-2",
    runId: run.id,
    subjectTaskId: "task-build-2",
    reviewMode: "evidence_led",
    candidateSha: "moved999",
    contract: CONTRACT,
    lensOutcomes: [lensOutcome("backend"), lensOutcome("security")],
    state: "shipping_review",
  });
  const msg = await refusal(() => gate("task-build-2", "advance", undefined, {}));
  assert.match(msg, /verification_absent_or_red/);
  assert.match(msg, /acceptance_unmet/);
  assert.match(msg, /tip_not_trusted/);
});

// ── the legacy half, untouched ───────────────────────────────────────────────

test("FG-640: a LEGACY run's verdict gate is untouched — an authoritative fail still blocks by its old message", async () => {
  writeWorkflow("wf-legacy", "legacy_verdict");
  const run = seedRun("wf-legacy", "legacy_verdict");
  insertTask({
    id: "task-red",
    runId: run.id,
    phase: "build",
    agentRole: "red-backend",
    status: "complete",
    taskPackage: { taskId: "task-red", runId: run.id, phase: "build", role: "red-backend", inputs: {}, composedSystemPrompt: "P" },
    createdAt: "2026-07-30T00:00:00Z",
  });
  insertVerdict({
    id: "v-legacy",
    taskId: "task-build",
    redTaskId: "task-red",
    redRole: "red-backend",
    verdict: "fail",
    confidence: 0.9,
    authority: "authoritative",
    findings: [],
    createdAt: "2026-07-30T00:00:01Z",
    gateOnVerdict: true,
  });
  // A full ledger sits alongside and changes nothing: this run is not evidence_led.
  insertReview({
    id: "review-legacy",
    runId: run.id,
    subjectTaskId: "task-build",
    reviewMode: "legacy_verdict",
    candidateSha: SHA,
    state: "settled",
  });

  const msg = await refusal(() => gate("task-build", "advance", undefined, {}));
  assert.match(msg, /verdict aggregation = fail/);
  assert.doesNotMatch(msg, /review_disposition/);
});

test("FG-640: an evidence_led run does NOT also apply verdict aggregation — one authority model per run", async () => {
  writeWorkflow("wf-el", "evidence_led");
  const run = seedRun("wf-el", "evidence_led");
  seedSettledLedger(run.id);
  insertTask({
    id: "task-red",
    runId: run.id,
    phase: "build",
    agentRole: "red-backend",
    status: "complete",
    taskPackage: { taskId: "task-red", runId: run.id, phase: "build", role: "red-backend", inputs: {}, composedSystemPrompt: "P" },
    createdAt: "2026-07-30T00:00:00Z",
  });
  // An advisory fail — exactly what a migrated red now writes.
  insertVerdict({
    id: "v-advisory",
    taskId: "task-build",
    redTaskId: "task-red",
    redRole: "red-backend",
    verdict: "fail",
    confidence: 0.9,
    authority: "specialist",
    findings: [],
    createdAt: "2026-07-30T00:00:01Z",
    gateOnVerdict: false,
  });

  // Legacy would have demanded a --rationale for a specialist fail. The ledger is settled,
  // so the evidence-led gate advances on its own authority and never consults aggregation.
  const result = await gate("task-build", "advance", undefined, {});
  assert.equal(result.task.status, "complete");
});
