// FG-639 / PRD Appendix A: the durable FixBatch.
//
// Three properties, and each is a scenario the PRD names:
//
//   #4  — N fix_now findings become ONE batch handed to ONE fixer. Not N tasks.
//   #19 — a fixer RETRY references the same immutable revision and payload hash; a CHANGED
//         disposition creates a new revision instead of mutating the running task's inputs.
//   #20 — a result that omits an expected id, names a foreign one, or repeats one is
//         refused at HOST ingestion, and nothing from it is applied.
//
// The omission arm is the load-bearing one. "An omitted id is never a resolution" is only
// true if the host refuses the WHOLE result rather than applying the ids that happened to
// be present, so that test asserts on the absence of rows, not only on the refusal string.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest, getDb } from "./db.js";
import { insertRun } from "./runs.js";
import { eventsForRun } from "./events.js";
import { insertReview, ingestFindings, recordDisposition, findingsForReview, type ReviewFinding } from "./reviews.js";
import {
  batchDecisionFingerprint,
  type ClaimedBatchIdentity,
  type FixBatch,
  ensureFixBatch,
  fixBatchEnvelope,
  fixBatchResults,
  fixBatchesForReview,
  getFixBatch,
  hashFixBatchPayload,
  ingestFixBatchResults,
  latestFixBatch,
  markFixBatchDispatched,
  serializeFixBatchPayload,
  verifyMaterializedPayload,
} from "./fix-batches.js";
import type { Run } from "../types/index.js";

const RUN: Run = {
  id: "run-fg639-batch",
  workflow: "feature",
  title: "fix batches",
  status: "active",
  createdAt: "2026-07-30T00:00:00Z",
  reviewMode: "evidence_led",
};

const REVIEW = "review-fg639-batch";

/** The identity an honest fixer claims: the batch it was dispatched for, at the revision it
 *  was dispatched at. Both halves are checked at ingestion, so both are stated here. */
function self(batch: FixBatch): ClaimedBatchIdentity {
  return { batchId: batch.id, revision: batch.revision };
}

let db: DatabaseInstance;
let prev: DatabaseInstance | null;

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
  insertRun(RUN);
  insertReview({
    id: REVIEW,
    runId: RUN.id,
    ticketId: "FG-639",
    reviewMode: "evidence_led",
    baseSha: "base000",
    contractConfirmedSha: "conf222",
    candidateSha: "cand111",
    contract: { threat_model: "operator_trusted_candidate", risk_lenses: ["wide"] },
    state: "awaiting_disposition",
  });
});

afterEach(() => {
  setDbForTest(prev as DatabaseInstance);
  db.close();
});

/** Ingest `n` findings and disposition each fix_now, returning them in ledger order. */
function fixNowFindings(n: number, rationale = "will be remediated this cycle"): ReviewFinding[] {
  ingestFindings(
    REVIEW,
    Array.from({ length: n }, (_, i) => ({
      summary: `finding ${i + 1}`,
      evidence: `evidence ${i + 1}`,
      reachability: "demonstrated",
      riskLens: "wide",
      file: `src/f${i + 1}.ts`,
      line: i + 1,
    })),
  );
  for (const f of findingsForReview(REVIEW)) {
    recordDisposition(f.id, { decision: "fix_now", rationale, operator: false });
  }
  return findingsForReview(REVIEW).filter((f) => f.disposition === "fix_now");
}

test("FG-639 / PRD #4: five fix_now findings become ONE batch with all five in its payload", () => {
  const findings = fixNowFindings(5);
  const { batch, created } = ensureFixBatch(REVIEW, "cand111", findings);

  assert.equal(created, true);
  assert.equal(batch.revision, 1);
  assert.equal(fixBatchesForReview(REVIEW).length, 1, "one batch, not one per finding");
  assert.equal(batch.payload.findings.length, 5);
  assert.deepEqual(
    batch.payload.findings.map((f) => f.finding_ref),
    ["RF-1", "RF-2", "RF-3", "RF-4", "RF-5"],
  );
  assert.equal(batch.payload.candidate_sha, "cand111");
  assert.equal(batch.state, "open");
});

test("FG-639: the payload carries each finding's evidence and disposition rationale — the batch IS the handoff", () => {
  const findings = fixNowFindings(2, "trust-gate write path, fix before advancing");
  const { batch } = ensureFixBatch(REVIEW, "cand111", findings);
  const first = batch.payload.findings[0];
  assert.equal(first?.evidence, "evidence 1");
  assert.equal(first?.disposition_rationale, "trust-gate write path, fix before advancing");
  assert.equal(first?.reachability, "demonstrated");
});

test("FG-639: the persisted hash is the hash OF the canonical payload serialization", () => {
  const { batch } = ensureFixBatch(REVIEW, "cand111", fixNowFindings(1));
  assert.equal(batch.payloadSha256, hashFixBatchPayload(batch.payload));
  const verified = verifyMaterializedPayload(batch, serializeFixBatchPayload(batch.payload));
  assert.equal(verified.ok, true);
});

test("FG-639: a materialized payload that does not hash to the persisted value REFUSES the dispatch", () => {
  const { batch } = ensureFixBatch(REVIEW, "cand111", fixNowFindings(1));
  const tampered = serializeFixBatchPayload(batch.payload).replace("evidence 1", "evidence 1 (edited)");
  const verified = verifyMaterializedPayload(batch, tampered);
  assert.equal(verified.ok, false);
  assert.match(verified.ok ? "" : verified.refusal, /refusing to start the fixer on an unverified delivery snapshot/);
});

test("FG-639: the delivery envelope carries the batch identity and the payload hash", () => {
  const { batch } = ensureFixBatch(REVIEW, "cand111", fixNowFindings(1));
  const env = fixBatchEnvelope(batch);
  assert.deepEqual(env, {
    kind: "review_fix_batch",
    schema_version: 1,
    fix_batch_id: batch.id,
    revision: 1,
    review_id: REVIEW,
    candidate_sha: "cand111",
    payload_sha256: batch.payloadSha256,
  });
});

test("FG-639 / PRD #19: a fixer RETRY gets the SAME revision and the SAME payload hash", () => {
  const findings = fixNowFindings(3);
  const first = ensureFixBatch(REVIEW, "cand111", findings);
  markFixBatchDispatched(first.batch.id, "task-fixer-1");

  // The retry re-enters the stage with nothing changed.
  const retry = ensureFixBatch(REVIEW, "cand111", findingsForReview(REVIEW).filter((f) => f.disposition === "fix_now"));
  assert.equal(retry.created, false);
  assert.equal(retry.batch.id, first.batch.id);
  assert.equal(retry.batch.revision, 1);
  assert.equal(retry.batch.payloadSha256, first.batch.payloadSha256);
  assert.equal(fixBatchesForReview(REVIEW).length, 1, "a retry must not create a second revision");
});

test("FG-639 / PRD #19: a CHANGED disposition creates a NEW revision instead of mutating the running task's inputs", () => {
  const findings = fixNowFindings(3);
  const first = ensureFixBatch(REVIEW, "cand111", findings);
  markFixBatchDispatched(first.batch.id, "task-fixer-1");
  const originalPayload = serializeFixBatchPayload(first.batch.payload);

  // The operator changes their mind about one finding while the fixer runs.
  const third = findings[2] as ReviewFinding;
  recordDisposition(third.id, {
    decision: "deferred",
    rationale: "broader lifecycle scope than this ticket",
    operator: true,
    followupTicketId: "FG-999",
  });

  const next = ensureFixBatch(
    REVIEW,
    "cand111",
    findingsForReview(REVIEW).filter((f) => f.disposition === "fix_now"),
  );
  assert.equal(next.created, true);
  assert.equal(next.batch.revision, 2);
  assert.equal(next.batch.supersedesBatchId, first.batch.id);
  assert.equal(next.batch.payload.findings.length, 2);

  const stillRunning = getFixBatch(first.batch.id);
  assert.equal(stillRunning?.state, "superseded");
  assert.equal(
    serializeFixBatchPayload(stillRunning?.payload as never),
    originalPayload,
    "the revision a container is bound to is IMMUTABLE — the payload it was dispatched with is byte-identical",
  );
  assert.equal(stillRunning?.dispatchTaskId, "task-fixer-1");
});

test("FG-639 / PRD #19: a result from the container bound to a SUPERSEDED revision is recorded against that revision and never revives it", () => {
  const findings = fixNowFindings(2);
  const first = ensureFixBatch(REVIEW, "cand111", findings);
  markFixBatchDispatched(first.batch.id, "task-fixer-1");

  // The operator re-decides one finding while task-fixer-1 is still running, so revision 2
  // exists before revision 1's container has delivered anything.
  recordDisposition((findings[0] as ReviewFinding).id, {
    decision: "fix_now",
    rationale: "re-decided: guard the reconcile path too",
    operator: false,
  });
  const next = ensureFixBatch(REVIEW, "cand111", findingsForReview(REVIEW).filter((f) => f.disposition === "fix_now"));
  assert.equal(next.batch.revision, 2);
  assert.equal(getFixBatch(first.batch.id)?.state, "superseded");

  // Now the in-flight container delivers. It was dispatched against revision 1 and its
  // result is about revision 1 — it is recorded there, and it does not become the current
  // scope by arriving late.
  const late = ingestFixBatchResults(first.batch.id, "task-fixer-1", self(first.batch), incoming(findings));
  assert.equal(late.ok, true);
  assert.equal(fixBatchResults(first.batch.id).length, 2, "the work the container actually did is not discarded");
  assert.equal(
    getFixBatch(first.batch.id)?.state,
    "superseded",
    "a late result never promotes a superseded revision back to ingested",
  );
  assert.equal(fixBatchResults(next.batch.id).length, 0, "nor is it credited to the revision that superseded it");
  assert.equal(latestFixBatch(REVIEW)?.id, next.batch.id);
});

test("FG-639 / PRD #19: a re-decided finding changes the fingerprint even when the membership set does not", () => {
  const findings = fixNowFindings(2);
  const first = ensureFixBatch(REVIEW, "cand111", findings);
  markFixBatchDispatched(first.batch.id, "task-fixer-1");

  recordDisposition((findings[0] as ReviewFinding).id, {
    decision: "fix_now",
    rationale: "re-decided: also guard the reconcile path",
    operator: false,
  });

  const after = findingsForReview(REVIEW).filter((f) => f.disposition === "fix_now");
  assert.notEqual(
    batchDecisionFingerprint(first.batch),
    // Same two findings, but one carries a new rationale — the fixer's instructions changed.
    `cand111::${after.map((f) => `${f.id}@${f.decidedAt}#${f.dispositionRationale}`).join("|")}`,
  );
  const next = ensureFixBatch(REVIEW, "cand111", after);
  assert.equal(next.created, true);
  assert.equal(next.batch.revision, 2);
});

test("FG-639: a moved candidate supersedes the batch — a batch is candidate-bound", () => {
  const findings = fixNowFindings(1);
  const first = ensureFixBatch(REVIEW, "cand111", findings);
  const next = ensureFixBatch(REVIEW, "cand222", findings);
  assert.equal(next.created, true);
  assert.equal(next.batch.revision, 2);
  assert.equal(next.batch.candidateSha, "cand222");
  assert.equal(getFixBatch(first.batch.id)?.state, "superseded");
});

test("FG-639: batch creation and dispatch each emit one event naming the revision and hash", () => {
  const { batch } = ensureFixBatch(REVIEW, "cand111", fixNowFindings(1));
  markFixBatchDispatched(batch.id, "task-fixer-1");
  const kinds = eventsForRun(RUN.id).map((e) => e.eventType);
  assert.ok(kinds.includes("review.fix_batch_created"));
  assert.ok(kinds.includes("review.fix_batch_dispatched"));
  const created = eventsForRun(RUN.id).find((e) => e.eventType === "review.fix_batch_created");
  const payload = created?.payload as { revision: number; payloadSha256: string };
  assert.equal(payload.revision, 1);
  assert.equal(payload.payloadSha256, batch.payloadSha256);
});

// ─── PRD #20 — host ingestion integrity ─────────────────────────────────────

function incoming(findings: readonly ReviewFinding[], over: Record<string, unknown> = {}) {
  return findings.map((f) => ({ findingId: f.id, result: "fixed" as const, summary: "done", filesChanged: ["src/x.ts"], evidence: "test added", ...over }));
}

test("FG-639 / PRD #20: a result OMITTING an expected finding id is refused and NOTHING is applied", () => {
  const findings = fixNowFindings(3);
  const { batch } = ensureFixBatch(REVIEW, "cand111", findings);
  const partial = incoming(findings.slice(0, 2));

  const r = ingestFixBatchResults(batch.id, "task-fixer-1", self(batch), partial);
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.match(r.refusal, /omits/);
  assert.match(r.refusal, /An omitted id is never a resolution/);
  assert.match(r.refusal, /Nothing was written/);
  assert.equal(
    fixBatchResults(batch.id).length,
    0,
    "the WHOLE result is refused — applying the two ids that were present is what 'omission is never resolution' forbids",
  );
});

test("FG-639 / PRD #20: a result naming a FOREIGN finding id is refused", () => {
  const findings = fixNowFindings(2);
  const { batch } = ensureFixBatch(REVIEW, "cand111", findings);
  const r = ingestFixBatchResults(batch.id, "task-fixer-1", self(batch), [
    ...incoming(findings),
    { findingId: `${REVIEW}/RF-99`, result: "fixed", summary: "?", filesChanged: [], evidence: "?" },
  ]);
  assert.equal(r.ok, false);
  assert.match(r.ok ? "" : r.refusal, /which is not in fix batch/);
  assert.equal(fixBatchResults(batch.id).length, 0);
});

test("FG-639 / PRD #20: a result reporting the same id TWICE is refused", () => {
  const findings = fixNowFindings(2);
  const { batch } = ensureFixBatch(REVIEW, "cand111", findings);
  const dup = incoming(findings);
  const r = ingestFixBatchResults(batch.id, "task-fixer-1", self(batch), [...dup, dup[0] as never]);
  assert.equal(r.ok, false);
  assert.match(r.ok ? "" : r.refusal, /more than once — exactly one result per finding/);
});

test("FG-639 / PRD #20: a result claiming a DIFFERENT batch id is refused on identity", () => {
  const findings = fixNowFindings(1);
  const { batch } = ensureFixBatch(REVIEW, "cand111", findings);
  const r = ingestFixBatchResults(
    batch.id,
    "task-fixer-1",
    { batchId: "fix-batch-someoneelse", revision: batch.revision },
    incoming(findings),
  );
  assert.equal(r.ok, false);
  assert.match(r.ok ? "" : r.refusal, /batch identity mismatch/);
});

test("FG-639 / PRD #20: a result with the right batch id and finding ids but a STALE revision is never credited as current", () => {
  const findings = fixNowFindings(2);
  const first = ensureFixBatch(REVIEW, "cand111", findings);
  markFixBatchDispatched(first.batch.id, "task-fixer-1");

  // The operator re-decides mid-flight, so revision 2 is what is dispatched now.
  recordDisposition((findings[0] as ReviewFinding).id, {
    decision: "fix_now",
    rationale: "re-decided: guard the reconcile path too",
    operator: false,
  });
  const current = ensureFixBatch(REVIEW, "cand111", findingsForReview(REVIEW).filter((f) => f.disposition === "fix_now"));
  assert.equal(current.batch.revision, 2);

  // The in-flight container delivers against revision 2's id — right batch, right finding
  // ids — but says revision 1. That is a result about a scope that has moved.
  const r = ingestFixBatchResults(
    current.batch.id,
    "task-fixer-1",
    { batchId: current.batch.id, revision: 1 },
    incoming(findings),
  );
  assert.equal(r.ok, false, "matching finding ids do not make a stale revision current");
  if (r.ok) return;
  assert.match(r.refusal, new RegExp(current.batch.id), "the refusal names the batch");
  assert.match(r.refusal, /claims revision 1/, "and the claimed revision");
  assert.match(r.refusal, /dispatched at revision 2/, "and the dispatched revision");
  assert.equal(fixBatchResults(current.batch.id).length, 0, "nothing is credited to the current revision");
  assert.equal(getFixBatch(current.batch.id)?.state, "open", "and the current revision is not marked ingested");

  // The TE's late-result semantics: the work is recorded against the superseded revision the
  // fixer was actually bound to, rather than discarded.
  assert.match(r.refusal, /recorded against the superseded revision 1/);
  assert.equal(fixBatchResults(first.batch.id).length, 2);
  assert.equal(getFixBatch(first.batch.id)?.state, "superseded", "a late result never revives a superseded revision");
});

test("FG-639: a claimed revision that never existed is refused and nothing is written anywhere", () => {
  const findings = fixNowFindings(1);
  const { batch } = ensureFixBatch(REVIEW, "cand111", findings);
  const r = ingestFixBatchResults(batch.id, "task-fixer-1", { batchId: batch.id, revision: 7 }, incoming(findings));
  assert.equal(r.ok, false);
  assert.match(r.ok ? "" : r.refusal, /No revision 7 exists/);
  assert.match(r.ok ? "" : r.refusal, /Nothing was written/);
  assert.equal(fixBatchResults(batch.id).length, 0);
});

test("FG-639: a complete result is ingested, one row per finding, and marks the batch ingested", () => {
  const findings = fixNowFindings(3);
  const { batch } = ensureFixBatch(REVIEW, "cand111", findings);
  const r = ingestFixBatchResults(batch.id, "task-fixer-1", self(batch), incoming(findings));
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.records.length, 3);
  assert.equal(r.alreadyIngested, false);
  assert.equal(getFixBatch(batch.id)?.state, "ingested");
  assert.deepEqual(r.records[0]?.filesChanged, ["src/x.ts"]);
});

test("FG-639 / Appendix A: delivery is at-least-once, so a REPEAT ingest is idempotent", () => {
  const findings = fixNowFindings(2);
  const { batch } = ensureFixBatch(REVIEW, "cand111", findings);
  ingestFixBatchResults(batch.id, "task-fixer-1", self(batch), incoming(findings));
  const again = ingestFixBatchResults(batch.id, "task-fixer-1", self(batch), incoming(findings, { summary: "second delivery" }));

  assert.equal(again.ok, true);
  assert.equal(again.ok ? again.alreadyIngested : false, true, "the repeat is RECORDED as a repeat, not silently absorbed");
  assert.equal(fixBatchResults(batch.id).length, 2, "the same result cannot be applied twice");
  assert.equal(
    fixBatchResults(batch.id)[0]?.summary,
    "done",
    "the first application stands; a redelivery does not overwrite it",
  );
});

test("FG-639: a retry under a DIFFERENT task id records its own rows against the same batch", () => {
  const findings = fixNowFindings(1);
  const { batch } = ensureFixBatch(REVIEW, "cand111", findings);
  ingestFixBatchResults(batch.id, "task-fixer-1", self(batch), incoming(findings));
  const retry = ingestFixBatchResults(batch.id, "task-fixer-2", self(batch), incoming(findings, { summary: "retry" }));
  assert.equal(retry.ok, true);
  assert.equal(fixBatchResults(batch.id).length, 2);
  assert.equal(retry.ok ? retry.records.length : 0, 1, "the retry's own rows are reported, keyed by its task id");
});

test("FG-639: a scope_change result is stored as such — it is an outcome, not an error", () => {
  const findings = fixNowFindings(2);
  const { batch } = ensureFixBatch(REVIEW, "cand111", findings);
  const r = ingestFixBatchResults(batch.id, "task-fixer-1", self(batch), [
    { findingId: (findings[0] as ReviewFinding).id, result: "fixed", summary: "done", filesChanged: ["src/x.ts"], evidence: "test added" },
    { findingId: (findings[1] as ReviewFinding).id, result: "scope_change", summary: "needs a new table", filesChanged: [], evidence: "cannot fix without a schema change" },
  ]);
  assert.equal(r.ok, true);
  assert.deepEqual(
    fixBatchResults(batch.id).map((x) => x.result).sort(),
    ["fixed", "scope_change"],
  );
});

test("FG-639: agents never write the batch tables — ingestion is the only writer, keyed host-side", () => {
  const findings = fixNowFindings(1);
  const { batch } = ensureFixBatch(REVIEW, "cand111", findings);
  ingestFixBatchResults(batch.id, "task-fixer-1", self(batch), incoming(findings));
  const pk = getDb().prepare(`PRAGMA table_info(fix_batch_results)`).all() as { name: string; pk: number }[];
  assert.deepEqual(
    pk.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name),
    ["batch_id", "task_id", "finding_id"],
    "the composite key IS the idempotence key for at-least-once delivery",
  );
  assert.equal(latestFixBatch(REVIEW)?.id, batch.id);
});

test("FG-639: a batch cannot be created with no fix_now findings", () => {
  assert.throws(() => ensureFixBatch(REVIEW, "cand111", []), /at least one fix_now finding/);
});
