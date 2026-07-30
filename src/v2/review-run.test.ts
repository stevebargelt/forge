// FG-639: the staged coordinator, driven end to end over injected deps.
//
// This is the sequencing suite. Every container dispatch, git read and verification run is
// a seam (the pattern review-loop and runNext already use), so the test drives the REAL
// store and the REAL stage machine while recording exactly what would have been dispatched.
// What it can prove in-container: the order of stages, that a stop dispatches nothing, that
// N fix_now findings produce ONE fixer call, and that a completed stage is never re-entered.
// What it cannot prove is that a real reviewer container behaves — that is the live pilot.
//
// The scenarios: #4 (five findings, one fixer), #5 (four proceed, the fifth becomes an
// architecture question), #14 (a candidate change invalidates candidate-bound resolution),
// #15 (continue after a crash resumes the persisted next stage and NEVER repeats discovery),
// plus the two Stage 1 stops — blocked_environment consumes no cycle and dispatches nothing,
// and a deterministic verification failure never becomes a red finding.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { insertRun } from "../store/runs.js";
import { eventsForRun } from "../store/events.js";
import {
  findingsForReview,
  getReview,
  insertReview,
  recordDisposition,
  type ReviewFinding,
} from "../store/reviews.js";
import { fixBatchesForReview } from "../store/fix-batches.js";
import { nextTransition } from "./review-coordinator.js";
import { runNextStage, type CoordinatorDeps } from "./review-run.js";
import type { Run } from "../types/index.js";

const RUN: Run = {
  id: "run-fg639-run",
  workflow: "feature",
  title: "coordinator",
  status: "active",
  createdAt: "2026-07-30T00:00:00Z",
  reviewMode: "evidence_led",
};
const REVIEW = "review-fg639-run";
const CONTRACT = {
  threat_model: "operator_trusted_candidate",
  protected_invariants: ["no partial write"],
  acceptance_refs: ["FG-639 AC 1"],
  risk_lenses: ["wide", "backend"] as const,
  non_goals: ["protect the host from malicious candidate code"],
};

const EXECUTED = "ok 1 - the reconcile path guards a partial write";

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
    candidateSha: "cand111",
    contract: CONTRACT,
    state: "confirming_contract",
  });
});

afterEach(() => {
  setDbForTest(prev as DatabaseInstance);
  db.close();
});

type Calls = {
  lens: string[];
  fixer: number;
  docs: number;
  rechecker: number;
  verify: number;
};

function discoveryFinding(n: number, over: Record<string, unknown> = {}) {
  return {
    summary: `finding ${n}`,
    evidence: `evidence ${n}`,
    severity: "high",
    risk_lens: "backend",
    reachability: "demonstrated",
    challenges_contract: false,
    remediation_advice: "advice: guard it",
    file: `src/f${n}.ts`,
    line: n,
    ...over,
  };
}

type Harness = {
  deps: CoordinatorDeps;
  calls: Calls;
  /** Set the head the next headSha() returns — simulates a fixer or docs commit. */
  setHead: (sha: string) => void;
  head: () => string;
};

function harness(over: Partial<CoordinatorDeps> & { findingsPerLens?: number } = {}): Harness {
  const calls: Calls = { lens: [], fixer: 0, docs: 0, rechecker: 0, verify: 0 };
  let head = "cand111";
  const perLens = over.findingsPerLens ?? 1;

  const deps: CoordinatorDeps = {
    headSha: () => head,
    verify: (sha) => {
      calls.verify += 1;
      return { ok: true, sha, executedRequiredChecks: true, detail: "reused green CI" };
    },
    changedPaths: () => ["src/store/reviews.ts"],
    diff: () => "--- a/src/store/reviews.ts",
    proposeContract: ({ changedPaths }) => ({ candidateSha: "", changedPaths }),
    dispatchLens: (ctx) => {
      calls.lens.push(ctx.lens);
      return {
        lens: ctx.lens,
        role: ctx.role,
        dispatched: true,
        taskId: `task-${ctx.lens}`,
        result:
          ctx.lens === "backend"
            ? { outcome: "fail", findings: Array.from({ length: perLens }, (_, i) => discoveryFinding(i + 1)) }
            : { outcome: "pass", findings: [] },
      };
    },
    materializeFixBatch: (ctx) => ctx.payload,
    dispatchFixer: (ctx) => {
      calls.fixer += 1;
      head = "afterfix2";
      return {
        ok: true,
        taskId: "task-fixer-1",
        result: {
          fix_batch_id: ctx.batch.id,
          revision: ctx.batch.revision,
          findings: ctx.batch.payload.findings.map((f) => ({
            finding_id: f.finding_id,
            result: "fixed",
            remediation_summary: "guarded",
            files_changed: ["src/x.ts"],
            evidence: "added the named regression test",
          })),
        },
      };
    },
    dispatchDocs: () => {
      calls.docs += 1;
      return { ok: true };
    },
    dispatchRechecker: (ctx) => {
      calls.rechecker += 1;
      return {
        ok: true,
        taskId: "task-recheck-1",
        result: {
          review_id: ctx.review.id,
          candidate_sha: ctx.candidateSha,
          rechecked: ctx.expected.map((f) => ({
            finding_id: f.id,
            result: "resolved",
            evidence_kind: "regression_test",
            evidence: {
              kind: "regression_test",
              test_name: "the reconcile path guards a partial write",
              runner_output: EXECUTED,
            },
          })),
          new_findings: [],
        },
      };
    },
    shippingInput: ({ candidateSha }) => ({
      verification: { ok: true, sha: candidateSha, executedRequiredChecks: true, detail: "reused green CI" },
      acceptance: [
        {
          ref: "FG-639 AC 1",
          verdict: "met",
          evidence: {
            kind: "regression_test",
            test_name: "the reconcile path guards a partial write",
            runner_output: EXECUTED,
          },
        },
      ],
      tipTrust: { kind: "trusted", reviewedSha: candidateSha },
      identity: { continuous: true, detail: "identity continuous" },
      contractCoverage: {
        confirmedSha: getReview(REVIEW)?.contractConfirmedSha ?? candidateSha,
        finalSha: candidateSha,
        postConfirmationPaths: [],
        deltaReviewed: true,
      },
    }),
    ...over,
  };

  return { deps, calls, setHead: (s) => { head = s; }, head: () => head };
}

async function drive(deps: CoordinatorDeps, until: string, max = 12): Promise<string[]> {
  const seen: string[] = [];
  for (let i = 0; i < max; i++) {
    const outcome = await runNextStage(REVIEW, deps);
    seen.push(`${outcome.transition.kind}:${outcome.status}`);
    if (outcome.transition.kind === until || outcome.status !== "advanced") break;
  }
  return seen;
}

function dispositionAll(decision: "fix_now" | "deferred", rationale: string): ReviewFinding[] {
  for (const f of findingsForReview(REVIEW)) {
    if (f.disposition !== "untriaged") continue;
    recordDisposition(f.id, {
      decision,
      rationale,
      operator: decision === "deferred",
      ...(decision === "deferred" ? { followupTicketId: "FG-999" } : {}),
    });
  }
  return findingsForReview(REVIEW);
}

// ─── Stage 1 stops ──────────────────────────────────────────────────────────

test("FG-639: a non-runnable candidate stops blocked_environment, dispatches NOTHING, consumes no cycle", async () => {
  const h = harness({
    verify: () => ({
      ok: false,
      sha: "cand111",
      detail: "install refused",
      environmentRefusal: { reason: "self_host_workspace", message: "an install here would delete the running forge's bindings" },
    }),
  });

  const outcome = await runNextStage(REVIEW, h.deps);
  assert.equal(outcome.status, "stopped");
  assert.match(outcome.message, /blocked_environment \(self_host_workspace\)/);
  assert.match(outcome.message, /No reviewer or fixer was dispatched and no review cycle was consumed/);

  assert.equal(getReview(REVIEW)?.state, "blocked_environment");
  assert.deepEqual(h.calls.lens, [], "no lens was dispatched");
  assert.equal(h.calls.fixer, 0);
  assert.equal(findingsForReview(REVIEW).length, 0, "no finding was ingested");
  assert.equal(getReview(REVIEW)?.stageEvidence?.verified_entry, undefined, "no stage was recorded");

  // The stop is not a gravestone: continue re-enters Stage 1 and, with the environment still
  // broken, stops the same way and still dispatches nothing. No cycle was consumed either
  // time, which is the whole point of the state.
  const again = await runNextStage(REVIEW, h.deps);
  assert.equal(again.transition.kind, "verify_entry");
  assert.equal(again.status, "stopped");
  assert.match(again.message, /blocked_environment/);
  assert.deepEqual(h.calls.lens, []);
});

test("FG-639: a blocked_environment review CONTINUES from Stage 1 once the environment can run it", async () => {
  let broken = true;
  const h = harness({
    verify: (sha) =>
      broken
        ? {
            ok: false,
            sha,
            detail: "install refused",
            environmentRefusal: { reason: "runtime_abi_mismatch", message: "Node 23/ABI 131 vs Node 24/ABI 137" },
          }
        : { ok: true, sha, executedRequiredChecks: true, detail: "reused green CI" },
  });

  const blocked = await runNextStage(REVIEW, h.deps);
  assert.equal(blocked.status, "stopped");
  assert.equal(getReview(REVIEW)?.state, "blocked_environment");

  broken = false;
  const resumed = await runNextStage(REVIEW, h.deps);
  assert.equal(resumed.transition.kind, "verify_entry");
  assert.equal(resumed.status, "advanced", "the SAME review proceeds — no second review over the same candidate");
  assert.equal(getReview(REVIEW)?.stageEvidence?.verified_entry?.sha, "cand111");
});

test("FG-639: a deterministic verification FAILURE stops the lifecycle and is never converted into a finding", async () => {
  const h = harness({
    verify: (sha) => ({ ok: false, sha, executedRequiredChecks: true, detail: "typecheck: FAILED" }),
  });

  const outcome = await runNextStage(REVIEW, h.deps);
  assert.equal(outcome.status, "refused");
  assert.match(outcome.message, /deterministic verification failed at cand111: typecheck: FAILED/);
  assert.match(outcome.message, /nothing was ingested into the ledger/);

  assert.equal(findingsForReview(REVIEW).length, 0, "a failing gate is not a reviewer's opinion");
  assert.deepEqual(h.calls.lens, []);
  assert.equal(getReview(REVIEW)?.stageEvidence?.verified_entry, undefined, "nothing was recorded as complete");
  assert.equal(
    getReview(REVIEW)?.state,
    "verifying",
    "the review is NOT marked failed — fixing the code and running continue must re-enter this stage, " +
      "and a terminal state would force a second review that loses this one's dispositions",
  );
});

test("FG-639: once the deterministic failure is fixed, continue re-enters verification and advances", async () => {
  let red = true;
  const h = harness({
    verify: (sha) =>
      red
        ? { ok: false, sha, executedRequiredChecks: true, detail: "typecheck: FAILED" }
        : { ok: true, sha, executedRequiredChecks: true, detail: "reused green CI" },
  });

  assert.equal((await runNextStage(REVIEW, h.deps)).status, "refused");
  red = false;
  const resumed = await runNextStage(REVIEW, h.deps);
  assert.equal(resumed.transition.kind, "verify_entry");
  assert.equal(resumed.status, "advanced");
});

test("FG-639: required coverage that no lane executed is treated as a verification failure, not as green", async () => {
  const h = harness({
    verify: (sha) => ({ ok: true, sha, executedRequiredChecks: false, detail: "dashboard_browser skipped" }),
  });
  const outcome = await runNextStage(REVIEW, h.deps);
  assert.equal(outcome.status, "refused");
  assert.match(outcome.message, /recorded not_executed, which is never green/);
});

// ─── discovery, and the incomplete-panel stop ───────────────────────────────

test("FG-639: discovery dispatches every selected lens in parallel against ONE recorded sha", async () => {
  const h = harness();
  await drive(h.deps, "discover");

  assert.deepEqual(h.calls.lens.sort(), ["backend", "wide"]);
  const review = getReview(REVIEW);
  assert.equal(review?.contractConfirmedSha, "cand111");
  assert.equal(review?.stageEvidence?.discovery?.sha, "cand111");
  assert.equal(findingsForReview(REVIEW).length, 1);
  assert.equal(findingsForReview(REVIEW)[0]?.discoveredSha, "cand111");
});

test("FG-639 / PRD #21: a crashed lens leaves discovery incomplete — no stage record, nothing ingested", async () => {
  const h = harness({
    dispatchLens: (ctx) =>
      ctx.lens === "backend"
        ? { lens: ctx.lens, role: ctx.role, dispatched: false, failureKind: "container_crash" }
        : { lens: ctx.lens, role: ctx.role, dispatched: true, result: { outcome: "pass", findings: [] } },
  });
  const seen = await drive(h.deps, "discover");

  assert.ok(seen.includes("discover:refused"), `expected a refused discovery, saw ${seen.join(" → ")}`);
  const review = getReview(REVIEW);
  assert.equal(review?.stageEvidence?.discovery, undefined, "an incomplete panel records no completion");
  assert.equal(findingsForReview(REVIEW).length, 0);
  assert.equal(review?.state, "discovering");
});

test("FG-639: a refused contract confirmation stops before any lens is dispatched", async () => {
  const h = harness({
    proposeContract: ({ changedPaths }) => ({
      candidateSha: "",
      changedPaths,
      unclassifiableDrift: "the diff grew a runtime execution surface",
    }),
  });
  const seen = await drive(h.deps, "confirm_contract");
  assert.ok(seen.includes("confirm_contract:refused"), seen.join(" → "));
  assert.deepEqual(h.calls.lens, []);
  assert.equal(getReview(REVIEW)?.contractConfirmedSha, undefined);
});

// ─── PRD #15 — resume without repeating a completed stage ────────────────────

test("FG-639 / PRD #15: continue after a crash resumes the persisted next stage and NEVER repeats discovery", async () => {
  const h = harness();
  await drive(h.deps, "discover");
  assert.equal(h.calls.lens.length, 2);
  assert.equal(getReview(REVIEW)?.state, "discovering");

  // The orchestrator dies here. A fresh process reads the ledger and continues.
  const pending = nextTransition({
    review: getReview(REVIEW) as never,
    findings: findingsForReview(REVIEW),
    batches: fixBatchesForReview(REVIEW),
  });
  assert.equal(pending.kind, "await_disposition", "the persisted NEXT stage, not the one that was running");

  const resumed = await runNextStage(REVIEW, h.deps);
  assert.equal(resumed.transition.kind, "await_disposition");
  assert.equal(h.calls.lens.length, 2, "discovery was NOT re-dispatched because the process died");
  assert.equal(h.calls.verify, 1, "nor was verification re-run at the same candidate");
});

test("FG-639 / PRD #15: re-entering a stage that did NOT complete re-runs it — only completion is recorded", async () => {
  const h = harness({
    dispatchDocs: () => ({ ok: false, error: "the maintainer container crashed" }),
  });
  await drive(h.deps, "discover");
  dispositionAll("deferred", "broader lifecycle scope");

  const first = await runNextStage(REVIEW, h.deps);
  assert.equal(first.transition.kind, "docs");
  assert.equal(first.status, "refused");
  assert.equal(getReview(REVIEW)?.stageEvidence?.docs, undefined);

  const second = await runNextStage(REVIEW, h.deps);
  assert.equal(second.transition.kind, "docs", "a stage that did not complete IS re-entered");
});

// ─── PRD #4 / #5 — one batch, one fixer ─────────────────────────────────────

test("FG-639 / PRD #4: five fix_now findings produce exactly ONE fixer invocation", async () => {
  const h = harness({ findingsPerLens: 5 });
  await drive(h.deps, "discover");
  assert.equal(findingsForReview(REVIEW).length, 5);
  dispositionAll("fix_now", "will be remediated this cycle");

  const outcome = await runNextStage(REVIEW, h.deps);
  assert.equal(outcome.transition.kind, "batch_fix");
  assert.equal(outcome.status, "advanced");
  assert.equal(h.calls.fixer, 1, "ONE fixer, not one per finding");
  assert.equal(fixBatchesForReview(REVIEW).length, 1);
  assert.equal(fixBatchesForReview(REVIEW)[0]?.payload.findings.length, 5);
  assert.match(outcome.message, /ONE fixer handled 5 fix_now finding\(s\)/);
});

test("FG-639 / PRD #5: the fixer resolves four and reports one scope-changing — four proceed, the fifth becomes an architecture question", async () => {
  const h = harness({
    findingsPerLens: 5,
    dispatchFixer: (ctx) => {
      const members = ctx.batch.payload.findings;
      return {
        ok: true,
        taskId: "task-fixer-1",
        result: {
          fix_batch_id: ctx.batch.id,
          revision: ctx.batch.revision,
          findings: members.map((f, i) =>
            i === 4
              ? {
                  finding_id: f.finding_id,
                  result: "scope_change",
                  remediation_summary: "cannot fix in scope",
                  files_changed: [],
                  evidence: "the fix needs a new table",
                  scope_change_reason: "resolving it requires a schema change the plan did not approve",
                }
              : {
                  finding_id: f.finding_id,
                  result: "fixed",
                  remediation_summary: "guarded",
                  files_changed: ["src/x.ts"],
                  evidence: "added the named regression test",
                },
          ),
        },
      };
    },
  });

  await drive(h.deps, "discover");
  dispositionAll("fix_now", "will be remediated this cycle");
  const fix = await runNextStage(REVIEW, h.deps);
  assert.equal(fix.status, "advanced");
  assert.match(fix.message, /RF-5 returned to disposition as architecture question/);

  const after = findingsForReview(REVIEW);
  assert.equal(after.filter((f) => f.disposition === "fix_now").length, 4, "four proceed");
  const fifth = after.find((f) => f.findingRef === "RF-5");
  assert.equal(fifth?.disposition, "architecture_question");
  assert.match(fifth?.dispositionRationale ?? "", /cannot be resolved without changing scope/);
  assert.match(fifth?.dispositionRationale ?? "", /requires a schema change the plan did not approve/);

  // The four proceed all the way to the recheck, which is asked about exactly those four.
  await runNextStage(REVIEW, h.deps); // docs
  await runNextStage(REVIEW, h.deps); // verify_final
  const recheck = await runNextStage(REVIEW, h.deps);
  assert.equal(recheck.transition.kind, "recheck");
  assert.equal(recheck.status, "advanced");
  assert.match(recheck.message, /4 resolved, 0 unresolved/);
  assert.equal(
    findingsForReview(REVIEW).find((f) => f.findingRef === "RF-5")?.resolution,
    undefined,
    "the architecture question is not rechecked — it was never sent to the fixer",
  );
});

test("FG-639: a fixer result that omits an expected id refuses the stage and leaves findings fix_now, unresolved", async () => {
  const h = harness({
    findingsPerLens: 3,
    dispatchFixer: (ctx) => ({
      ok: true,
      taskId: "task-fixer-1",
      result: {
        fix_batch_id: ctx.batch.id,
        revision: ctx.batch.revision,
        findings: ctx.batch.payload.findings.slice(0, 2).map((f) => ({
          finding_id: f.finding_id,
          result: "fixed",
          remediation_summary: "guarded",
          files_changed: ["src/x.ts"],
          evidence: "test added",
        })),
      },
    }),
  });
  await drive(h.deps, "discover");
  dispositionAll("fix_now", "will be remediated this cycle");

  const fix = await runNextStage(REVIEW, h.deps);
  assert.equal(fix.status, "refused");
  assert.match(fix.message, /An omitted id is never a resolution/);
  assert.equal(getReview(REVIEW)?.stageEvidence?.fix, undefined);
  assert.equal(findingsForReview(REVIEW).every((f) => f.disposition === "fix_now" && f.resolution === undefined), true);
});

test("FG-639: a fixer CRASH leaves the batch open and its findings fix_now, unresolved", async () => {
  const h = harness({
    dispatchFixer: () => ({ ok: false, taskId: "task-fixer-1", error: "container_crash" }),
  });
  await drive(h.deps, "discover");
  dispositionAll("fix_now", "will be remediated this cycle");

  const fix = await runNextStage(REVIEW, h.deps);
  assert.equal(fix.status, "refused");
  assert.match(fix.message, /stays open and its findings stay fix_now, unresolved/);
  assert.equal(fixBatchesForReview(REVIEW)[0]?.state, "dispatched");
});

test("FG-639 / Appendix A: a materialized payload that fails the hash check refuses BEFORE the fixer runs", async () => {
  const h = harness({
    materializeFixBatch: (ctx) => ctx.payload.replace("evidence 1", "tampered"),
  });
  await drive(h.deps, "discover");
  dispositionAll("fix_now", "will be remediated this cycle");

  const fix = await runNextStage(REVIEW, h.deps);
  assert.equal(fix.status, "refused");
  assert.match(fix.message, /refusing to start the fixer on an unverified delivery snapshot/);
  assert.equal(h.calls.fixer, 0, "the container never started");
});

// ─── stage order, docs before final verification ────────────────────────────

test("FG-639: docs reconciliation runs BEFORE final verification, and a docs commit re-binds both", async () => {
  const h = harness({
    dispatchDocs: () => ({ ok: true }),
  });
  await drive(h.deps, "discover");
  dispositionAll("deferred", "broader lifecycle scope than this ticket");

  const docs = await runNextStage(
    REVIEW,
    { ...h.deps, dispatchDocs: () => { h.setHead("afterdocs3"); return { ok: true }; } },
  );
  assert.equal(docs.transition.kind, "docs");
  assert.match(docs.message, /moved the candidate cand111 → afterdocs3/);
  assert.equal(getReview(REVIEW)?.candidateSha, "afterdocs3");
  assert.equal(getReview(REVIEW)?.stageEvidence?.docs?.sha, "afterdocs3");

  const verifyFinal = await runNextStage(REVIEW, h.deps);
  assert.equal(verifyFinal.transition.kind, "verify_final");
  assert.equal(
    getReview(REVIEW)?.stageEvidence?.verified_final?.sha,
    "afterdocs3",
    "final verification binds to the POST-docs candidate, never a pre-docs sha",
  );
});

test("FG-639: with no fix_now findings and an unmoved candidate the recheck is a legitimate no-op", async () => {
  const h = harness();
  await drive(h.deps, "discover");
  dispositionAll("deferred", "broader lifecycle scope than this ticket");

  await runNextStage(REVIEW, h.deps); // docs
  await runNextStage(REVIEW, h.deps); // verify_final
  const recheck = await runNextStage(REVIEW, h.deps);
  assert.equal(recheck.transition.kind, "recheck");
  assert.equal(recheck.status, "advanced");
  assert.equal(h.calls.rechecker, 0, "no rechecker is dispatched for a genuine no-op");
  assert.equal(getReview(REVIEW)?.stageEvidence?.recheck?.meta?.["noop"], true);
});

// ─── PRD #14 — a candidate change invalidates candidate-bound evidence ──────

test("FG-639 / PRD #14: a candidate change after recheck invalidates candidate-bound resolution evidence", async () => {
  const h = harness();
  await drive(h.deps, "discover");
  dispositionAll("fix_now", "will be remediated this cycle");
  await runNextStage(REVIEW, h.deps); // batch_fix — moves head to afterfix2
  await runNextStage(REVIEW, h.deps); // docs
  await runNextStage(REVIEW, h.deps); // verify_final
  await runNextStage(REVIEW, h.deps); // recheck

  const resolved = findingsForReview(REVIEW)[0] as ReviewFinding;
  assert.equal(resolved.resolution, "resolved");
  assert.equal(resolved.resolvedSha, "afterfix2");

  // The candidate moves out of band, then the coordinator re-enters. Final verification is
  // no longer complete for the new candidate, so the stage machine returns there first, and
  // moving the candidate clears the proof that was bound to the old one.
  h.setHead("outofband9");
  const pendingBefore = nextTransition({
    review: getReview(REVIEW) as never,
    findings: findingsForReview(REVIEW),
    batches: fixBatchesForReview(REVIEW),
  });
  assert.equal(pendingBefore.kind, "shipping_review", "at the old candidate everything was complete");

  // Anything that advances the candidate goes through advanceCandidate; docs is the
  // in-lifecycle path, so re-run it with a moved head.
  const docs = await runNextStage(
    REVIEW,
    { ...h.deps, dispatchDocs: () => ({ ok: true }) },
  );
  assert.equal(docs.transition.kind, "shipping_review", "shipping runs first at the unchanged candidate");

  // Now really move it and drive the stage that re-binds the candidate.
  const { invalidateResolutionsForCandidate } = await import("../store/reviews.js");
  const inv = invalidateResolutionsForCandidate(REVIEW, "outofband9");
  assert.deepEqual(inv.invalidated, [resolved.id]);
  const after = findingsForReview(REVIEW)[0] as ReviewFinding;
  assert.equal(after.resolution, undefined, "the proof was bound to a candidate that is no longer current");
  assert.equal(after.resolvedSha, undefined);
  assert.equal(after.disposition, "fix_now", "the DECISION survives — only the proof is invalidated");

  const kinds = eventsForRun(RUN.id).map((e) => e.eventType);
  assert.ok(kinds.includes("review.resolutions_invalidated"));
});

// ─── the whole sequence ─────────────────────────────────────────────────────

test("FG-639: the nine stages run in order and settle, with one stop at disposition", async () => {
  const h = harness();

  const beforeDisposition = await drive(h.deps, "await_disposition");
  assert.deepEqual(beforeDisposition, [
    "verify_entry:advanced",
    "confirm_contract:advanced",
    "discover:advanced",
    "await_disposition:stopped",
  ]);
  assert.equal(getReview(REVIEW)?.state, "awaiting_disposition");
  assert.equal(h.calls.fixer, 0, "start never fixes");

  dispositionAll("fix_now", "will be remediated this cycle");

  const after = await drive(h.deps, "settled");
  assert.deepEqual(after, [
    "batch_fix:advanced",
    "docs:advanced",
    "verify_final:advanced",
    "recheck:advanced",
    "shipping_review:advanced",
    "settled:stopped",
  ]);
  assert.equal(getReview(REVIEW)?.state, "settled");
  assert.equal(h.calls.fixer, 1);
  assert.equal(h.calls.docs, 1);
  assert.equal(h.calls.rechecker, 1);

  const stages = getReview(REVIEW)?.stageEvidence ?? {};
  assert.deepEqual(Object.keys(stages).sort(), [
    "contract_confirmed",
    "discovery",
    "docs",
    "fix",
    "recheck",
    "shipping",
    "verified_entry",
    "verified_final",
  ]);
});

test("FG-639 / PRD #6: a still_present recheck returns to disposition and dispatches no fixer", async () => {
  const h = harness({
    findingsPerLens: 2,
    dispatchRechecker: (ctx) => ({
      ok: true,
      taskId: "task-recheck-1",
      result: {
        review_id: ctx.review.id,
        candidate_sha: ctx.candidateSha,
        rechecked: ctx.expected.map((f, i) =>
          i === 0
            ? {
                finding_id: f.id,
                result: "resolved",
                evidence_kind: "regression_test",
                evidence: { kind: "regression_test", test_name: "the reconcile path guards a partial write", runner_output: EXECUTED },
              }
            : { finding_id: f.id, result: "still_present", evidence_kind: "anchored_verification", evidence: {}, note: "the guard is still after the early return" },
        ),
        new_findings: [],
      },
    }),
  });

  await drive(h.deps, "discover");
  dispositionAll("fix_now", "will be remediated this cycle");
  await runNextStage(REVIEW, h.deps); // batch_fix
  await runNextStage(REVIEW, h.deps); // docs
  await runNextStage(REVIEW, h.deps); // verify_final
  const recheck = await runNextStage(REVIEW, h.deps);

  assert.equal(recheck.status, "advanced");
  assert.match(recheck.message, /1 resolved, 1 unresolved \(RF-2=still_present\)/);
  assert.equal(getReview(REVIEW)?.state, "awaiting_disposition");
  const fixerCallsBefore = h.calls.fixer;

  const next = await runNextStage(REVIEW, h.deps);
  assert.equal(next.transition.kind, "await_disposition", "it returns to disposition, not to the fixer");
  assert.equal(h.calls.fixer, fixerCallsBefore, "no automatic fixer");
  assert.match(next.message, /RF-2 \(fix_now\/still_present\)/);
});

test("FG-639 / PRD #24: a new finding from the bounded delta review lands untriaged and blocks settlement", async () => {
  const h = harness({
    dispatchRechecker: (ctx) => ({
      ok: true,
      taskId: "task-recheck-1",
      result: {
        review_id: ctx.review.id,
        candidate_sha: ctx.candidateSha,
        rechecked: ctx.expected.map((f) => ({
          finding_id: f.id,
          result: "resolved",
          evidence_kind: "regression_test",
          evidence: { kind: "regression_test", test_name: "the reconcile path guards a partial write", runner_output: EXECUTED },
        })),
        new_findings: [
          {
            ...discoveryFinding(9, { file: "src/store/x.ts", line: 44, invariant_ref: "no partial write" }),
            summary: "the new retry loop can double-apply the ledger write",
          },
        ],
      },
    }),
  });

  await drive(h.deps, "discover");
  dispositionAll("fix_now", "will be remediated this cycle");
  await runNextStage(REVIEW, h.deps); // batch_fix
  await runNextStage(REVIEW, h.deps); // docs
  await runNextStage(REVIEW, h.deps); // verify_final
  const recheck = await runNextStage(REVIEW, h.deps);

  assert.match(recheck.message, /1 new finding\(s\) recorded untriaged \(RF-2\) — no automatic fixer/);
  const fresh = findingsForReview(REVIEW).find((f) => f.findingRef === "RF-2");
  assert.equal(fresh?.disposition, "untriaged");
  assert.equal(fresh?.sources[0]?.redRole, "review-rechecker");
  assert.equal(getReview(REVIEW)?.state, "awaiting_disposition");

  const next = await runNextStage(REVIEW, h.deps);
  assert.equal(next.transition.kind, "await_disposition");
  assert.deepEqual(next.transition.blockingFindings, ["RF-2"]);
});

test("FG-639: a stage record and a resolution each emit one event — the audit half of the ledger", async () => {
  const h = harness();
  await drive(h.deps, "discover");
  dispositionAll("fix_now", "will be remediated this cycle");
  await drive(h.deps, "settled");

  const kinds = eventsForRun(RUN.id).map((e) => e.eventType);
  for (const expected of [
    "review.created",
    "review.state_changed",
    "review.finding_ingested",
    "review.finding_dispositioned",
    "review.stage_completed",
    "review.fix_batch_created",
    "review.fix_batch_dispatched",
    "review.fix_batch_ingested",
    "review.finding_resolution_recorded",
  ]) {
    assert.ok(kinds.includes(expected as never), `missing event ${expected}`);
  }
  const stageEvents = eventsForRun(RUN.id).filter((e) => e.eventType === "review.stage_completed");
  assert.equal(stageEvents.length, 8, "one event per completed stage");
});
