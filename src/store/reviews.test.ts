// The review ledger's canonical subsystem suite.
//
// FG-638 shipped the rows, the ingestion and the disposition preconditions (its own
// scenarios live in the ticket-named files FG-641 owns consolidating). This file is the
// behavior-oriented home for what FG-639 added to the same tables: RESOLUTION is separate
// from disposition, a resolution is CANDIDATE-BOUND, and stage completion is recorded per
// sha so a coordinator can tell "already done" from "done against a tree that no longer
// exists".
//
// The property worth stating plainly, because two columns exist precisely to keep it true:
// deciding to fix something proves nothing about whether it is fixed. Every test here is a
// way of refusing to let those two facts collapse into one.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "./db.js";
import { insertRun } from "./runs.js";
import { eventsForRun } from "./events.js";
import {
  REVIEW_STAGES,
  findingsForReview,
  getFinding,
  getReview,
  ingestFindings,
  insertReview,
  invalidateResolutionsForCandidate,
  getDocsDispatch,
  markDocsDispatchDelivered,
  openDocsDispatch,
  pendingDocsDispatch,
  recordDisposition,
  recordResolution,
  recordStageEvidence,
  retireDocsDispatch,
  stageCompleteAt,
  summarizeReview,
  updateReview,
  type ReviewFinding,
} from "./reviews.js";
import type { Run } from "../types/index.js";

const RUN: Run = {
  id: "run-reviews",
  workflow: "feature",
  title: "review ledger",
  status: "active",
  createdAt: "2026-07-30T00:00:00Z",
  reviewMode: "evidence_led",
};
const REVIEW = "review-canonical";

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

function fixNow(n = 1): ReviewFinding[] {
  ingestFindings(
    REVIEW,
    Array.from({ length: n }, (_, i) => ({ summary: `finding ${i + 1}`, evidence: `e${i + 1}`, reachability: "demonstrated" })),
  );
  for (const f of findingsForReview(REVIEW)) {
    if (f.disposition === "untriaged") {
      recordDisposition(f.id, { decision: "fix_now", rationale: "will be remediated this cycle", operator: false });
    }
  }
  return findingsForReview(REVIEW);
}

// ─── resolution is separate from disposition ────────────────────────────────

test("a recheck result records resolution, its evidence kind, and the sha it was proven at", () => {
  const [f] = fixNow();
  const after = recordResolution((f as ReviewFinding).id, {
    resolution: "resolved",
    evidenceKind: "regression_test",
    evidence: "the reconcile path guards a partial write executed against cand111",
    resolvedSha: "cand111",
  });
  assert.equal(after.resolution, "resolved");
  assert.equal(after.resolutionEvidenceKind, "regression_test");
  assert.equal(after.resolvedSha, "cand111");
  assert.equal(after.disposition, "fix_now", "the DECISION is untouched by recording what the recheck found");
});

test("recording a resolution emits one event naming the resolution and the candidate it was proven at", () => {
  const [f] = fixNow();
  recordResolution((f as ReviewFinding).id, { resolution: "still_present", resolvedSha: "cand111" });
  const ev = eventsForRun(RUN.id).filter((e) => e.eventType === "review.finding_resolution_recorded");
  assert.equal(ev.length, 1);
  const payload = ev[0]?.payload as { resolution: string; resolvedSha: string };
  assert.equal(payload.resolution, "still_present");
  assert.equal(payload.resolvedSha, "cand111");
});

test("a fix_now finding with no resolution is UNSETTLED — deciding to fix proves nothing", () => {
  fixNow(2);
  assert.equal(summarizeReview(REVIEW)?.unsettledCount, 2);

  const [first] = findingsForReview(REVIEW);
  recordResolution((first as ReviewFinding).id, {
    resolution: "resolved",
    evidenceKind: "regression_test",
    evidence: "executed",
    resolvedSha: "cand111",
  });
  assert.equal(summarizeReview(REVIEW)?.unsettledCount, 1);
});

test("a still_present or inconclusive resolution leaves the finding unsettled", () => {
  const findings = fixNow(2);
  recordResolution((findings[0] as ReviewFinding).id, { resolution: "still_present", resolvedSha: "cand111" });
  recordResolution((findings[1] as ReviewFinding).id, { resolution: "inconclusive", resolvedSha: "cand111" });
  assert.equal(summarizeReview(REVIEW)?.unsettledCount, 2);
  assert.deepEqual(summarizeReview(REVIEW)?.countsByResolution, { still_present: 1, inconclusive: 1 });
});

// ─── a resolution is candidate-bound ────────────────────────────────────────

test("PRD #14: moving the candidate clears every resolution proven at the sha being left", () => {
  const findings = fixNow(2);
  for (const f of findings) {
    recordResolution(f.id, {
      resolution: "resolved",
      evidenceKind: "regression_test",
      evidence: "executed against cand111",
      resolvedSha: "cand111",
    });
  }

  const inv = invalidateResolutionsForCandidate(REVIEW, "moved222");
  assert.deepEqual(inv.invalidated.sort(), findings.map((f) => f.id).sort());
  assert.equal(inv.fromSha, "cand111");

  for (const f of findings) {
    const after = getFinding(f.id) as ReviewFinding;
    assert.equal(after.resolution, undefined);
    assert.equal(after.resolutionEvidenceKind, undefined);
    assert.equal(after.resolutionEvidence, undefined, "the stale evidence blob is CLEARED, not left to be misread");
    assert.equal(after.resolvedSha, undefined);
    assert.equal(after.disposition, "fix_now", "dispositions are decisions about findings, not claims about a tree");
    assert.equal(after.dispositionRationale, "will be remediated this cycle");
  }
});

test("PRD #14: a resolution already bound to the NEW candidate survives", () => {
  const [f] = fixNow();
  recordResolution((f as ReviewFinding).id, { resolution: "resolved", evidenceKind: "regression_test", evidence: "x", resolvedSha: "moved222" });
  const inv = invalidateResolutionsForCandidate(REVIEW, "moved222");
  assert.deepEqual(inv.invalidated, []);
  assert.equal((getFinding((f as ReviewFinding).id) as ReviewFinding).resolution, "resolved");
});

test("PRD #14: invalidation emits one event naming every cleared finding and why", () => {
  const [f] = fixNow();
  recordResolution((f as ReviewFinding).id, { resolution: "resolved", resolvedSha: "cand111" });
  invalidateResolutionsForCandidate(REVIEW, "moved222");
  const ev = eventsForRun(RUN.id).find((e) => e.eventType === "review.resolutions_invalidated");
  assert.ok(ev, "the clearing is auditable, not silent");
  const payload = ev?.payload as { findingIds: string[]; toSha: string; why: string };
  assert.deepEqual(payload.findingIds, [(f as ReviewFinding).id]);
  assert.equal(payload.toSha, "moved222");
  assert.match(payload.why, /candidate-bound resolution and shipping evidence no longer applies/);
});

test("invalidation with nothing to clear writes nothing and emits no event", () => {
  fixNow();
  const inv = invalidateResolutionsForCandidate(REVIEW, "moved222");
  assert.deepEqual(inv.invalidated, []);
  assert.equal(eventsForRun(RUN.id).some((e) => e.eventType === "review.resolutions_invalidated"), false);
});

// ─── stage completion is recorded per sha ───────────────────────────────────

test("a stage is complete for the sha it was recorded against, and only that sha", () => {
  recordStageEvidence(REVIEW, "verified_final", { sha: "cand111", detail: "green" });
  const review = getReview(REVIEW);
  assert.equal(stageCompleteAt(review as never, "verified_final", "cand111"), true);
  assert.equal(
    stageCompleteAt(review as never, "verified_final", "moved222"),
    false,
    "a stage recorded at another sha is history, not completion",
  );
  assert.equal(stageCompleteAt(review as never, "recheck", "cand111"), false);
});

test("stage completion against an UNDEFINED candidate is never complete", () => {
  recordStageEvidence(REVIEW, "docs", { sha: "cand111" });
  assert.equal(stageCompleteAt(getReview(REVIEW) as never, "docs", undefined), false);
});

test("every stage can be recorded, and each records one event carrying the stage and sha", () => {
  for (const stage of REVIEW_STAGES) recordStageEvidence(REVIEW, stage, { sha: "cand111", detail: `${stage} done` });
  const evidence = getReview(REVIEW)?.stageEvidence ?? {};
  assert.deepEqual(Object.keys(evidence).sort(), [...REVIEW_STAGES].sort());

  const events = eventsForRun(RUN.id).filter((e) => e.eventType === "review.stage_completed");
  assert.equal(events.length, REVIEW_STAGES.length);
  const first = events[0]?.payload as { stage: string; sha: string };
  assert.equal(first.stage, "verified_entry");
  assert.equal(first.sha, "cand111");
});

test("recording a stage twice replaces its record rather than accumulating — a stage is complete once, at one sha", () => {
  recordStageEvidence(REVIEW, "recheck", { sha: "cand111" });
  recordStageEvidence(REVIEW, "recheck", { sha: "moved222", meta: { noop: true } });
  const rec = getReview(REVIEW)?.stageEvidence?.recheck;
  assert.equal(rec?.sha, "moved222");
  assert.equal(rec?.meta?.["noop"], true);
});

test("stage evidence survives an unrelated updateReview — a patch must not erase what is complete", () => {
  recordStageEvidence(REVIEW, "discovery", { sha: "conf222" });
  updateReview(REVIEW, { candidateSha: "moved222" });
  assert.equal(getReview(REVIEW)?.stageEvidence?.discovery?.sha, "conf222");
  assert.equal(getReview(REVIEW)?.candidateSha, "moved222");
});

test("a review created with no stage evidence reads back undefined, not an empty object to guess about", () => {
  assert.equal(getReview(REVIEW)?.stageEvidence, undefined);
});

// ─── FG-655: the docs stage's durable dispatch binding ──────────────────────

test("FG-655: a docs dispatch is created OPEN, bound to the candidate, and carries no identity yet", () => {
  const b = openDocsDispatch(REVIEW, "cand111");
  assert.match(b.id, /^docs-dispatch-/);
  assert.equal(b.reviewId, REVIEW);
  assert.equal(b.candidateSha, "cand111");
  assert.equal(b.state, "open");
  assert.equal(b.taskId, undefined, "the host mints the task id; the binding does not invent one");
  assert.equal(b.runId, undefined);
  assert.deepEqual(getDocsDispatch(b.id), b, "and it is durable before anything is dispatched");
});

test("FG-655: opening twice returns the SAME live binding rather than a second one", () => {
  const first = openDocsDispatch(REVIEW, "cand111");
  const again = openDocsDispatch(REVIEW, "cand111");
  assert.equal(again.id, first.id, "a caller that reached here twice owns one binding, not two");
});

test("FG-655: marking a dispatch delivered records BOTH the task and the run that locate its delivery", () => {
  // Run AND task together: the delivery lives under the run's task dir, and a review may hold
  // no run id at dispatch time — a task id alone cannot find it.
  const b = markDocsDispatchDelivered(openDocsDispatch(REVIEW, "cand111").id, {
    taskId: "task-docs-1",
    runId: RUN.id,
  });
  assert.equal(b.state, "dispatched");
  assert.equal(b.taskId, "task-docs-1");
  assert.equal(b.runId, RUN.id);
});

test("FG-655: a delivered dispatch with no explicit run falls back to the REVIEW's run", () => {
  const b = markDocsDispatchDelivered(openDocsDispatch(REVIEW, "cand111").id, { taskId: "task-docs-1" });
  assert.equal(b.runId, RUN.id);
});

test("FG-655: the pending read is keyed on the REVIEW, so a candidate that moved under it is still found", () => {
  // The crash window between the candidate advance and the stage record moves the candidate
  // out from under a live binding. A per-candidate read would find nothing there and dispatch
  // a second docs agent over the coordinator's own commit.
  const b = markDocsDispatchDelivered(openDocsDispatch(REVIEW, "cand111").id, { taskId: "task-docs-1" });
  updateReview(REVIEW, { candidateSha: "afterdocs2" });
  const live = pendingDocsDispatch(REVIEW);
  assert.equal(live?.id, b.id);
  assert.equal(live?.candidateSha, "cand111", "and it still says which candidate it was dispatched for");
});

test("FG-655: a retired dispatch is no longer pending, and a fresh one may then be opened", () => {
  const first = markDocsDispatchDelivered(openDocsDispatch(REVIEW, "cand111").id, { taskId: "task-docs-1" });
  const retired = retireDocsDispatch(first.id, "stage 6 completed at cand111");
  assert.equal(retired.state, "retired");
  assert.equal(retired.retiredReason, "stage 6 completed at cand111");
  assert.notEqual(retired.retiredAt, undefined);
  assert.equal(pendingDocsDispatch(REVIEW), undefined, "a spent binding does not short-circuit re-entry");

  const second = openDocsDispatch(REVIEW, "cand111");
  assert.notEqual(second.id, first.id, "and a dead delivery's replacement is a NEW binding, not a revived one");
  assert.equal(pendingDocsDispatch(REVIEW)?.id, second.id);
});

test("FG-655 RF-4: the STORE refuses a second live binding for a review — the invariant is not call-site ordering", () => {
  // `openDocsDispatch` reads for a live binding and then inserts, and the two are not one
  // atomic step: two concurrent `forge review continue` processes can each observe none and
  // each create one, then each dispatch a docs agent. The raw insert below is that losing
  // process's — it is what the read-then-insert degenerates to under concurrency.
  const live = openDocsDispatch(REVIEW, "cand111");
  assert.throws(
    () =>
      db
        .prepare(
          `INSERT INTO review_docs_dispatches (id, review_id, candidate_sha, state, created_at)
           VALUES ('docs-dispatch-racer', ?, 'cand111', 'open', '2026-08-05T00:00:00Z')`,
        )
        .run(REVIEW),
    /UNIQUE constraint failed/,
    "at most one live binding per review, enforced by the DB",
  );
  assert.equal(pendingDocsDispatch(REVIEW)?.id, live.id, "and the winner's binding is untouched");

  // A `dispatched` row collides with an `open` one too — both are LIVE. Only retirement frees
  // the slot, and retired rows are history: many per review, so the index is partial.
  markDocsDispatchDelivered(live.id, { taskId: "task-docs-1" });
  assert.throws(
    () =>
      db
        .prepare(
          `INSERT INTO review_docs_dispatches (id, review_id, candidate_sha, state, created_at)
           VALUES ('docs-dispatch-racer2', ?, 'cand111', 'open', '2026-08-05T00:00:00Z')`,
        )
        .run(REVIEW),
    /UNIQUE constraint failed/,
  );
  retireDocsDispatch(live.id, "stage 6 completed at cand111");
  const second = openDocsDispatch(REVIEW, "cand111");
  retireDocsDispatch(second.id, "stage 6 completed again");
  assert.equal(openDocsDispatch(REVIEW, "cand111").state, "open", "retired rows accumulate freely");
});

test("FG-655: a review with no docs dispatch reads back undefined, not a fabricated one", () => {
  assert.equal(pendingDocsDispatch(REVIEW), undefined);
  assert.equal(getDocsDispatch("docs-dispatch-nope"), undefined);
});
