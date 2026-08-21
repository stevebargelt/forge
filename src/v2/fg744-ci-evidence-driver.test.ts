// FG-744 / AC4: the FG-737 RF-1 shape, end to end through the coordinator.
//
// A demonstrated fix_now finding whose fixer cited an INTEGRATION-tier executed_assertion is
// rechecked on the fast-gate lane, which structurally cannot contain that test, so it is left
// `inconclusive / not_executed` with the review's single fix-batch cap consumed — the exact
// stranding this ticket exists to repair. Then required CI goes green at the EXACT candidate
// and executed the assertion, and `forge review ingest-ci-evidence` (runCiEvidenceIngestion)
// flips the finding to `resolved`, clearing the review_disposition gate WITHOUT a new fixer or
// recheck cycle.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { insertRun } from "../store/runs.js";
import {
  findingsForReview,
  getFinding,
  getReview,
  ingestFindings,
  insertReview,
  recordDisposition,
  recordResolution,
  recordStageEvidence,
} from "../store/reviews.js";
import {
  ensureFixBatch,
  fixBatchesForReview,
  ingestFixBatchResults,
  markFixBatchDispatched,
} from "../store/fix-batches.js";
import { fixCycleKey } from "./review-coordinator.js";
import { runCiEvidenceIngestion, type CoordinatorDeps } from "./review-run.js";
import { assessReviewDisposition } from "./review-gate.js";
import type { GateEvidence } from "../store/host-verifications.js";
import type { Run } from "../types/index.js";

const RUN: Run = {
  id: "run-fg744",
  workflow: "feature",
  title: "fg744",
  status: "active",
  createdAt: "2026-08-21T00:00:00Z",
  reviewMode: "evidence_led",
};
const REVIEW = "review-fg744-driver";
const SHA = "8e9fe0d0";
const ASSERTION = "refreshes a SETTLED row ONLY for the live lease holder";
const TEST_FILE = "src/campaign/fg737-detached-resume-fence.integration.test.ts";
const CONTRACT = {
  threat_model: "operator_trusted_candidate",
  protected_invariants: ["a settled linkage is not rebound by a stale launcher"],
  acceptance_refs: ["FG-737 AC 1"],
  risk_lenses: ["backend"] as const,
  non_goals: ["protect the host from malicious candidate code"],
  lens_scopes: { backend: ["src/campaign/"] },
};

let db: DatabaseInstance;
let prev: DatabaseInstance | null;

/** Build the stranded post-recheck state directly from store primitives: a fix_now finding, a
 *  committed+ingested fix batch whose result cites the integration-tier assertion, the fix and
 *  recheck stage records (so the single remediation window is consumed), and a resolution left
 *  `inconclusive / not_executed` at the candidate. */
function strandFinding(): string {
  const [finding] = ingestFindings(REVIEW, [
    {
      summary: "stale-launcher rebind of a settled linkage",
      severity: "high",
      riskLens: "backend",
      reachability: "demonstrated",
      evidence: "the settled row is refreshed for a detached first controller",
      file: "src/campaign/reconcile.ts",
      line: 42,
      discoveredSha: SHA,
      sources: [{ redRole: "red-backend" }],
    },
  ]);
  const id = finding!.id;
  recordDisposition(id, { decision: "fix_now", rationale: "will be remediated this cycle", operator: false });

  const findings = findingsForReview(REVIEW).filter((f) => f.disposition === "fix_now");
  const batch = ensureFixBatch(REVIEW, SHA, findings).batch;
  markFixBatchDispatched(batch.id, "task-fixer-1");
  const ing = ingestFixBatchResults(
    batch.id,
    "task-fixer-1",
    { batchId: batch.id, revision: batch.revision },
    [
      {
        findingId: id,
        result: "fixed",
        summary: "guarded the rebind behind the live-lease-holder check",
        filesChanged: ["src/campaign/reconcile.ts", TEST_FILE],
        evidence: "added the integration regression",
        executedAssertion: ASSERTION,
      },
    ],
  );
  assert.equal(ing.ok, true, ing.ok ? "" : ing.refusal);

  // The fix stage record consumes the single remediation window (cap consumed).
  recordStageEvidence(REVIEW, "fix", {
    sha: SHA,
    detail: "one batch fixed",
    meta: { fixBatchId: batch.id, revision: batch.revision },
  });
  // Docs + final verification ran at the candidate.
  recordStageEvidence(REVIEW, "docs", { sha: SHA, detail: "no docs change" });
  recordStageEvidence(REVIEW, "verified_final", { sha: SHA, detail: "green" });
  // The recheck ran and left the finding inconclusive off the fast gate.
  recordResolution(id, { resolution: "inconclusive", evidenceKind: "not_executed", evidence: "the cited integration assertion did not appear in the fast-gate output", resolvedSha: SHA });
  recordStageEvidence(REVIEW, "recheck", {
    sha: SHA,
    detail: "1 known id rechecked; inconclusive",
    meta: { fixCycleKey: fixCycleKey(fixBatchesForReview(REVIEW)), unresolved: [finding!.findingRef] },
  });
  return id;
}

function ciDeps(gate: GateEvidence | null): Partial<CoordinatorDeps> {
  return { coveringGateEvidence: () => gate };
}

const ciGate: GateEvidence = { source: "ci", sha: SHA, checkUrl: "https://ci/1", checks: [{ context: "CI / test" }, { context: "CI / test-extended" }] };

function ciEvidenceInput() {
  return {
    review_id: REVIEW,
    candidate_sha: SHA,
    findings: [
      { finding_id: `${REVIEW}/RF-1`, test_file: TEST_FILE, ci_lane: "CI / test-extended", ci_runner_output: `ok 1 - ${ASSERTION}` },
    ],
  };
}

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
  insertRun(RUN);
  insertReview({
    id: REVIEW,
    runId: RUN.id,
    ticketId: "FG-737",
    reviewMode: "evidence_led",
    baseSha: "base000",
    candidateSha: SHA,
    contractConfirmedSha: SHA,
    contract: CONTRACT,
    state: "awaiting_disposition",
  });
  // Discovery completed at the confirmed sha (so the machine is genuinely past discovery).
  recordStageEvidence(REVIEW, "verified_entry", { sha: SHA, detail: "green" });
  recordStageEvidence(REVIEW, "contract_confirmed", { sha: SHA, detail: "confirmed" });
});

afterEach(() => {
  setDbForTest(prev as DatabaseInstance);
  db.close();
});

test("FG-744 / AC4: a stranded integration-tier fix_now finding blocks the gate with its single fix-batch cap consumed", () => {
  strandFinding();

  const before = assessReviewDisposition({ review: getReview(REVIEW)!, findings: findingsForReview(REVIEW) });
  assert.ok(
    before.conditions.some((c) => c.id === "fix_now_unresolved"),
    "the stranded finding holds the review with fix_now_unresolved",
  );
  // The single remediation window is recorded consumed — a second fixer is not on the table.
  assert.ok(getReview(REVIEW)!.stageEvidence?.fix !== undefined, "the fix stage record marks the cap consumed");
});

test("FG-744 / AC4: green exact-candidate CI evidence flips the stranded finding to resolved and clears the gate — no new cycle", async () => {
  const id = strandFinding();

  const outcome = await runCiEvidenceIngestion(REVIEW, ciEvidenceInput(), ciDeps(ciGate) as CoordinatorDeps);
  assert.equal(outcome.status, "ingested", outcome.status === "refused" ? `${outcome.reason}: ${outcome.message}` : "");
  if (outcome.status !== "ingested") return;
  assert.deepEqual(outcome.resolved, ["RF-1"]);

  const f = getFinding(id)!;
  assert.equal(f.resolution, "resolved");
  assert.equal(f.resolvedSha, SHA);
  assert.equal(f.resolutionEvidenceKind, "regression_test", "regression_test is proportional to the demonstrated finding");
  assert.equal(f.disposition, "fix_now", "the disposition is untouched — only the resolution changed");

  // The gate no longer holds on this finding.
  const after = assessReviewDisposition({ review: getReview(REVIEW)!, findings: findingsForReview(REVIEW) });
  assert.ok(!after.conditions.some((c) => c.id === "fix_now_unresolved"), "fix_now_unresolved is cleared");

  // No new fix batch was minted.
  assert.equal(fixBatchesForReview(REVIEW).length, 1, "the one-fix-batch cap is untouched");
});

test("FG-744 / AC2: without green required CI at the candidate the ingestion refuses and changes nothing", async () => {
  const id = strandFinding();

  const outcome = await runCiEvidenceIngestion(REVIEW, ciEvidenceInput(), ciDeps(null) as CoordinatorDeps);
  assert.equal(outcome.status, "refused");
  if (outcome.status !== "refused") return;
  assert.match(outcome.message, /no green required-CI covering evidence/);

  const f = getFinding(id)!;
  assert.equal(f.resolution, "inconclusive", "the stranded resolution is unchanged");
});

test("FG-744 / AC3: a SKIPPED assertion in the CI output refuses and changes nothing", async () => {
  const id = strandFinding();
  const input = {
    review_id: REVIEW,
    candidate_sha: SHA,
    findings: [{ finding_id: `${REVIEW}/RF-1`, test_file: TEST_FILE, ci_lane: "CI / test-extended", ci_runner_output: `ok 1 - ${ASSERTION} # SKIP no db lane` }],
  };
  const outcome = await runCiEvidenceIngestion(REVIEW, input, ciDeps(ciGate) as CoordinatorDeps);
  assert.equal(outcome.status, "refused");
  assert.equal(getFinding(id)!.resolution, "inconclusive");
});

test("FG-744: the ingestion refuses when the coordinator has no covering-gate-evidence authority", async () => {
  strandFinding();
  const outcome = await runCiEvidenceIngestion(REVIEW, ciEvidenceInput(), {} as CoordinatorDeps);
  assert.equal(outcome.status, "refused");
  if (outcome.status !== "refused") return;
  assert.equal(outcome.reason, "ci_evidence_no_gate_authority");
});
