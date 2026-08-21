// FG-744 / AC4: persisted review state + coordinator ingestion regression.
//
// This is the FG-737 RF-1 production shape: the fast recheck could not execute the
// fixer's integration-tier assertion and left the one permitted fix batch consumed.
// Required CI later proves that exact assertion at the unchanged candidate. The
// coordinator must settle the existing finding without dispatching another fix/recheck.

import { afterEach, beforeEach, test } from "node:test";
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
import { ensureFixBatch, fixBatchesForReview, ingestFixBatchResults, markFixBatchDispatched } from "../store/fix-batches.js";
import { assessReviewDisposition } from "./review-gate.js";
import { runCiEvidenceIngestion, type CoordinatorDeps } from "./review-run.js";
import type { GateEvidence } from "../store/host-verifications.js";
import type { Run } from "../types/index.js";

const reviewId = "review-fg744-integration";
const candidateSha = "8e9fe0d0";
const assertion = "refreshes a SETTLED row ONLY for the live lease holder";
const integrationTest = "src/campaign/fg737-detached-resume-fence.integration.test.ts";

let db: DatabaseInstance;
let previous: DatabaseInstance | null;

const run: Run = {
  id: "run-fg744-integration",
  workflow: "feature",
  title: "FG-744 integration evidence regression",
  status: "active",
  createdAt: "2026-08-21T00:00:00Z",
  reviewMode: "evidence_led",
};

const greenRequiredCi: GateEvidence = {
  source: "ci",
  sha: candidateSha,
  checkUrl: "https://ci.example.test/runs/744",
  checks: [{ context: "CI / test" }, { context: "CI / test-extended" }],
};

beforeEach(() => {
  db = makeInMemoryDb();
  previous = setDbForTest(db);
  insertRun(run);
  insertReview({
    id: reviewId,
    runId: run.id,
    ticketId: "FG-737",
    reviewMode: "evidence_led",
    baseSha: "base0000",
    candidateSha,
    contractConfirmedSha: candidateSha,
    contract: {
      threat_model: "operator-trusted candidate",
      protected_invariants: ["a stale launcher cannot rebind a settled linkage"],
      acceptance_refs: ["FG-737 AC 1"],
      risk_lenses: ["backend"],
      non_goals: ["rechecking unrelated campaign paths"],
      lens_scopes: { backend: ["src/campaign/"] },
    },
    state: "awaiting_disposition",
  });
});

afterEach(() => {
  setDbForTest(previous as DatabaseInstance);
  db.close();
});

function strandedFinding(): string {
  const [finding] = ingestFindings(reviewId, [
    {
      summary: "stale launcher can rebind a settled linkage",
      severity: "high",
      riskLens: "backend",
      reachability: "demonstrated",
      evidence: "the settled row is refreshed by a detached controller",
      file: "src/campaign/reconcile.ts",
      line: 42,
      discoveredSha: candidateSha,
      sources: [{ redRole: "red-backend" }],
    },
  ]);
  assert.ok(finding);
  recordDisposition(finding.id, { decision: "fix_now", rationale: "remediate in the single fix batch", operator: false });

  const batch = ensureFixBatch(reviewId, candidateSha, findingsForReview(reviewId)).batch;
  markFixBatchDispatched(batch.id, "task-fixer-744");
  const ingested = ingestFixBatchResults(
    batch.id,
    "task-fixer-744",
    { batchId: batch.id, revision: batch.revision },
    [{
      findingId: finding.id,
      result: "fixed",
      summary: "added live-lease-holder fence",
      filesChanged: ["src/campaign/reconcile.ts", integrationTest],
      evidence: "integration regression added",
      executedAssertion: assertion,
    }],
  );
  assert.equal(ingested.ok, true, ingested.ok ? "" : ingested.refusal);

  // These persisted records model the fast recheck's structural limitation and prove the
  // normal remediation window has already been used before CI arrives.
  recordStageEvidence(reviewId, "fix", { sha: candidateSha, detail: "single fix batch ingested" });
  recordStageEvidence(reviewId, "verified_final", { sha: candidateSha, detail: "fast gate green" });
  recordResolution(finding.id, {
    resolution: "inconclusive",
    evidenceKind: "not_executed",
    evidence: "integration assertion was absent from the fast-gate runner output",
    resolvedSha: candidateSha,
  });
  recordStageEvidence(reviewId, "recheck", { sha: candidateSha, detail: "fast recheck finalized not_executed" });
  return finding.id;
}

function evidence(output = `ok 1 - ${assertion}`, sha = candidateSha) {
  return {
    review_id: reviewId,
    candidate_sha: sha,
    findings: [{ finding_id: `${reviewId}/RF-1`, test_file: integrationTest, ci_lane: "CI / test-extended", ci_runner_output: output }],
  };
}

// CI ingestion reads no normal stage dependencies; retain the coordinator's full public
// signature while providing only its distinct evidence authority in this integration fixture.
function depsWithGate(gate: GateEvidence | null): CoordinatorDeps {
  return { coveringGateEvidence: () => gate } as unknown as CoordinatorDeps;
}

test("FG-744: later green exact-candidate CI resolves the fast-recheck stranded integration assertion without a new fix cycle", async () => {
  const findingId = strandedFinding();
  assert.ok(assessReviewDisposition({ review: getReview(reviewId)!, findings: findingsForReview(reviewId) }).conditions.some((c) => c.id === "fix_now_unresolved"));

  const outcome = await runCiEvidenceIngestion(reviewId, evidence(), depsWithGate(greenRequiredCi));
  assert.equal(outcome.status, "ingested", outcome.status === "refused" ? outcome.message : "");

  const settled = getFinding(findingId)!;
  assert.equal(settled.resolution, "resolved");
  assert.equal(settled.resolvedSha, candidateSha);
  assert.equal(settled.resolutionEvidenceKind, "regression_test");
  assert.equal(fixBatchesForReview(reviewId).length, 1, "CI evidence must not mint another fixer batch");
  assert.ok(!assessReviewDisposition({ review: getReview(reviewId)!, findings: findingsForReview(reviewId) }).conditions.some((c) => c.id === "fix_now_unresolved"));
});

test("FG-744: green CI evidence from a previous candidate cannot settle the stranded finding", async () => {
  const findingId = strandedFinding();
  const outcome = await runCiEvidenceIngestion(reviewId, evidence(`ok 1 - ${assertion}`, "prior000"), depsWithGate(greenRequiredCi));

  assert.equal(outcome.status, "refused");
  assert.equal(getFinding(findingId)!.resolution, "inconclusive");
  assert.equal(fixBatchesForReview(reviewId).length, 1);
});
