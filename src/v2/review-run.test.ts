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
  type ReviewStage,
} from "../store/reviews.js";
import { fixBatchesForReview, getFixBatch, serializeFixBatchPayload } from "../store/fix-batches.js";
import { nextTransition, type TransitionKind } from "./review-coordinator.js";
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

function harness(over: Partial<CoordinatorDeps> & { findingsPerLens?: number; initialHead?: string } = {}): Harness {
  const calls: Calls = { lens: [], fixer: 0, docs: 0, rechecker: 0, verify: 0 };
  // `initialHead` is what a FRESH process sees: the orchestrator that died held the head in
  // a variable, so a resuming process starts from wherever the repository actually is.
  let head = over.initialHead ?? "cand111";
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

/** The next transition as a fresh process would read it: from the persisted rows only. */
function pending() {
  return nextTransition({
    review: getReview(REVIEW) as never,
    findings: findingsForReview(REVIEW),
    batches: fixBatchesForReview(REVIEW),
  });
}

/** Drive stages until the PERSISTED next transition is `target`, applying the operator's
 *  disposition whenever the machine stops for one. Leaves the review parked exactly at that
 *  boundary with the target stage not yet run — the state a crash would leave behind. */
async function parkAt(deps: CoordinatorDeps, target: TransitionKind): Promise<void> {
  for (let i = 0; i < 16; i++) {
    if (pending().kind === target) return;
    if (pending().kind === "await_disposition") {
      dispositionAll("fix_now", "will be remediated this cycle");
      continue;
    }
    const outcome = await runNextStage(REVIEW, deps);
    assert.notEqual(
      outcome.status,
      "refused",
      `parking at ${target}: ${outcome.transition.kind} refused — ${outcome.message}`,
    );
  }
  assert.fail(`never reached ${target}`);
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

// Every stage boundary, not just the discovery one. The fixture per stage is the PERSISTED
// LEDGER itself: the review is driven to the boundary by the real machine, then a FRESH
// harness — zeroed call counters, head read from where the repository actually is — stands
// in for the process that replaced the one that died. So each case asserts three things a
// crash must not disturb: the one valid next transition comes out of the rows, the resumed
// stage is the only thing that dispatches a container, and no already-recorded stage is
// re-recorded.
const RESUME_BOUNDARIES: Array<{ completed: string; target: TransitionKind; expect: Calls }> = [
  { completed: "stage 1 verification entry", target: "confirm_contract", expect: { lens: [], fixer: 0, docs: 0, rechecker: 0, verify: 0 } },
  { completed: "stage 2 contract confirmation", target: "discover", expect: { lens: ["wide", "backend"], fixer: 0, docs: 0, rechecker: 0, verify: 0 } },
  { completed: "stage 3 discovery", target: "await_disposition", expect: { lens: [], fixer: 0, docs: 0, rechecker: 0, verify: 0 } },
  { completed: "stage 4 the disposition decision", target: "batch_fix", expect: { lens: [], fixer: 1, docs: 0, rechecker: 0, verify: 0 } },
  { completed: "stage 5 the batch fix", target: "docs", expect: { lens: [], fixer: 0, docs: 1, rechecker: 0, verify: 0 } },
  { completed: "stage 6 docs reconciliation", target: "verify_final", expect: { lens: [], fixer: 0, docs: 0, rechecker: 0, verify: 1 } },
  { completed: "stage 7 final verification", target: "recheck", expect: { lens: [], fixer: 0, docs: 0, rechecker: 1, verify: 0 } },
  { completed: "stage 8 the recheck", target: "shipping_review", expect: { lens: [], fixer: 0, docs: 0, rechecker: 0, verify: 0 } },
  { completed: "stage 9 the shipping review", target: "settled", expect: { lens: [], fixer: 0, docs: 0, rechecker: 0, verify: 0 } },
];

for (const boundary of RESUME_BOUNDARIES) {
  test(`FG-639 / PRD #15: a crash after ${boundary.completed} resumes at ${boundary.target} and re-dispatches nothing already done`, async () => {
    const warm = harness();
    await parkAt(warm.deps, boundary.target);
    const before = getReview(REVIEW)?.stageEvidence ?? {};

    const first = pending();
    assert.equal(first.kind, boundary.target, "the persisted next stage, not the one that was running");
    assert.deepEqual(pending(), first, "reading it again is stable — there is exactly ONE valid next transition");

    // The orchestrator died here. A fresh process picks the review up.
    const cold = harness({ initialHead: getReview(REVIEW)?.candidateSha });
    const resumed = await runNextStage(REVIEW, cold.deps);

    assert.equal(resumed.transition.kind, boundary.target);
    assert.notEqual(resumed.status, "refused", resumed.message);
    assert.deepEqual(cold.calls, boundary.expect, "only the resumed stage dispatched anything");

    const after = getReview(REVIEW)?.stageEvidence ?? {};
    for (const stage of Object.keys(before) as ReviewStage[]) {
      assert.deepEqual(after[stage], before[stage], `resuming re-recorded the completed ${stage} stage`);
    }
  });
}

test("FG-639 / PRD #15: resuming twice at the same boundary drives the stage once, not once per attempt", async () => {
  const warm = harness();
  await parkAt(warm.deps, "recheck");

  const cold = harness({ initialHead: getReview(REVIEW)?.candidateSha });
  const firstResume = await runNextStage(REVIEW, cold.deps);
  assert.equal(firstResume.transition.kind, "recheck");
  assert.equal(cold.calls.rechecker, 1);

  // A second process, dispatched because nobody was sure the first one landed.
  const colder = harness({ initialHead: getReview(REVIEW)?.candidateSha });
  const secondResume = await runNextStage(REVIEW, colder.deps);
  assert.equal(secondResume.transition.kind, "shipping_review", "the recheck is complete for this candidate");
  assert.equal(colder.calls.rechecker, 0, "a completed recheck is never re-dispatched");
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

test("FG-639: an undeliverable bundle leaves the batch OPEN and the SAME revision retryable", async () => {
  // The live-pilot shape: the wiring refuses before any container exists, so there is no
  // task to name. Marking the batch dispatched against an empty id would record a delivery
  // that never happened — and the retry must re-enter revision 1, not supersede it.
  const h = harness({
    dispatchFixer: () => ({ ok: false, taskId: "", error: "the fix batch bundle could not be delivered" }),
  });
  await drive(h.deps, "discover");
  dispositionAll("fix_now", "will be remediated this cycle");

  const refused = await runNextStage(REVIEW, h.deps);
  assert.equal(refused.status, "refused");
  const batches = fixBatchesForReview(REVIEW);
  assert.equal(batches.length, 1);
  assert.equal(batches[0]?.state, "open", "nothing was dispatched, so nothing is recorded as dispatched");
  assert.equal(batches[0]?.dispatchTaskId, undefined);

  const retried = await runNextStage(REVIEW, harness().deps);
  assert.equal(retried.status, "advanced", retried.message);
  const after = fixBatchesForReview(REVIEW);
  assert.equal(after.length, 1, "the retry re-entered the same batch rather than superseding it");
  assert.equal(after[0]?.revision, 1);
  assert.equal(after[0]?.payloadSha256, batches[0]?.payloadSha256);
});

test("FG-639: the OTHER side of the empty-taskId sentinel — a named task marks the batch dispatched against it", async () => {
  const h = harness();
  await drive(h.deps, "discover");
  dispositionAll("fix_now", "will be remediated this cycle");

  const fix = await runNextStage(REVIEW, h.deps);
  assert.equal(fix.status, "advanced", fix.message);
  assert.equal(fixBatchesForReview(REVIEW)[0]?.dispatchTaskId, "task-fixer-1");
});

test("FG-639 / RF-8: a resolution an EARLIER cycle proved survives a scope_change in a later one", async () => {
  // The wipe used to run over the whole batch payload, unconditionally, BEFORE the
  // scope_change arm re-dispositioned anything. So a finding cycle 1 proved `resolved`,
  // re-carried by cycle 2's payload and reported scope_change ("already fixed, cannot touch
  // without changing scope"), had its proof cleared and then — as an architecture question —
  // was absent from every later recheck's `expected`. Resolution NULL, nothing mechanical to
  // re-establish it: ledger data loss.
  //
  // RED baseline: drop the `result !== "scope_change"` or the surviving-fix_now exclusion from
  // the invalidation ingestFixBatchResults runs, and the resolution assertion below reads
  // undefined.
  let cycle = 0;
  const h = harness({
    findingsPerLens: 2,
    dispatchFixer: (ctx) => {
      cycle += 1;
      return {
        ok: true,
        taskId: `task-fixer-${cycle}`,
        result: {
          fix_batch_id: ctx.batch.id,
          revision: ctx.batch.revision,
          findings: ctx.batch.payload.findings.map((f, i) =>
            cycle >= 2 && i === 0
              ? {
                  finding_id: f.finding_id,
                  result: "scope_change",
                  remediation_summary: "already fixed in cycle 1",
                  files_changed: [],
                  evidence: "already fixed; touching it again would change scope",
                  scope_change_reason: "the remaining work is a schema change the plan did not approve",
                }
              : {
                  finding_id: f.finding_id,
                  result: "fixed",
                  remediation_summary: `cycle ${cycle}`,
                  files_changed: ["src/x.ts"],
                  evidence: `cycle ${cycle}: added the named regression test`,
                },
          ),
        },
      };
    },
    dispatchRechecker: (ctx) => ({
      ok: true,
      taskId: `task-recheck-${cycle}`,
      result: {
        review_id: ctx.review.id,
        candidate_sha: ctx.candidateSha,
        // RF-1 is PROVEN resolved by cycle 1's recheck; RF-2 comes back still_present.
        rechecked: ctx.expected.map((f) =>
          f.findingRef === "RF-1"
            ? {
                finding_id: f.id,
                result: "resolved",
                evidence_kind: "regression_test",
                evidence: {
                  kind: "regression_test",
                  test_name: "the reconcile path guards a partial write",
                  runner_output: EXECUTED,
                },
              }
            : { finding_id: f.id, result: "still_present", evidence_kind: "anchored_verification", evidence: {} },
        ),
        new_findings: [],
      },
    }),
  });

  await drive(h.deps, "discover");
  dispositionAll("fix_now", "will be remediated this cycle");
  await parkAt(h.deps, "recheck");
  await runNextStage(REVIEW, h.deps);

  const proven = findingsForReview(REVIEW).find((f) => f.findingRef === "RF-1") as ReviewFinding;
  const unresolved = findingsForReview(REVIEW).find((f) => f.findingRef === "RF-2") as ReviewFinding;
  assert.equal(proven.resolution, "resolved");
  assert.equal(proven.resolvedSha, h.head());
  assert.equal(unresolved.resolution, "still_present");

  // RF-2's re-decision opens cycle 2, whose payload still carries RF-1 (fixNowFindings filters
  // on disposition, and RF-1 is still fix_now).
  recordDisposition(unresolved.id, {
    decision: "fix_now",
    rationale: "second attempt on RF-2: guard the early return itself",
    operator: false,
  });
  const secondFix = await runNextStage(REVIEW, h.deps);
  assert.equal(secondFix.status, "advanced", secondFix.message);
  assert.match(secondFix.message, /RF-1 returned to disposition as architecture question/);

  const after = findingsForReview(REVIEW).find((f) => f.findingRef === "RF-1") as ReviewFinding;
  assert.equal(after.disposition, "architecture_question");
  assert.equal(
    after.resolution,
    "resolved",
    "a cycle that demonstrably changed nothing for RF-1 may not wipe the proof an earlier one recorded",
  );
  assert.equal(after.resolutionEvidenceKind, "regression_test", "and the evidence behind it survives with it");

  // The finding the cycle DID work on is still invalidated — its pre-cycle verdict is a claim
  // about pre-fix code, and the recheck below re-proves it.
  assert.equal(
    findingsForReview(REVIEW).find((f) => f.findingRef === "RF-2")?.resolution,
    undefined,
    "the surviving fix_now finding's stale verdict is still cleared",
  );

  await parkAt(h.deps, "recheck");
  const recheck = await runNextStage(REVIEW, h.deps);
  assert.equal(recheck.status, "advanced", recheck.message);
  assert.equal(
    findingsForReview(REVIEW).find((f) => f.findingRef === "RF-1")?.resolution,
    "resolved",
    "RF-1 is not in `expected` any more, so only the un-wiped proof can still be there",
  );
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

/** The live-pilot sequence, verbatim: two findings, cycle 1 COMMITS, and RF-2 comes back
 *  `inconclusive`. The harness the two RF-11 tests below share. */
function inconclusiveOnSecondFinding(): Harness {
  let cycle = 0;
  const h: Harness = harness({
    findingsPerLens: 2,
    dispatchFixer: (ctx) => {
      cycle += 1;
      h.setHead(`afterfix${cycle}`);
      return {
        ok: true,
        taskId: `task-fixer-${cycle}`,
        result: {
          fix_batch_id: ctx.batch.id,
          revision: ctx.batch.revision,
          findings: ctx.batch.payload.findings.map((f) => ({
            finding_id: f.finding_id,
            result: "fixed",
            remediation_summary: `cycle ${cycle}`,
            files_changed: ["src/x.ts"],
            evidence: `cycle ${cycle}: committed a guard`,
          })),
        },
      };
    },
    dispatchRechecker: (ctx) => {
      h.calls.rechecker += 1;
      return {
        ok: true,
        taskId: `task-recheck-${h.calls.rechecker}`,
        result: {
          review_id: ctx.review.id,
          candidate_sha: ctx.candidateSha,
          rechecked: ctx.expected.map((f) =>
            f.findingRef === "RF-2"
              ? { finding_id: f.id, result: "inconclusive", evidence_kind: "bounded_inspection", evidence: {} }
              : {
                  finding_id: f.id,
                  result: "resolved",
                  evidence_kind: "regression_test",
                  evidence: { kind: "regression_test", test_name: "the reconcile path guards a partial write", runner_output: EXECUTED },
                },
          ),
          new_findings: [],
        },
      };
    },
  });
  return h;
}

test("FG-639 / RF-11: a re-affirmed fix_now whose new cycle INGESTED goes to that cycle's RECHECK, not back to the disposition stop", async () => {
  // The live-pilot deadlock (review-29d1000750b0). RF-2 rechecked `inconclusive` in cycle 1,
  // was re-dispositioned fix_now, and revision 2 carrying it was dispatched and INGESTED —
  // and Stage 4 still blocked on "RF-2 (fix_now/inconclusive)", so `forge review continue`
  // returned the same stop forever. The verdict was about cycle 1; Stage 4 read it as a
  // verdict on the decision cycle 2 had just consumed, and blocked AHEAD of the Stage 8
  // recheck that was the only thing that could have replaced it.
  //
  // RED baseline: read `decisionCoveredByIngestedBatch` in dispositionBlockers instead of
  // `decisionCoveredByRecheckedCycle` and the lost-write half below reads await_disposition.
  const h = inconclusiveOnSecondFinding();
  await drive(h.deps, "discover");
  dispositionAll("fix_now", "will be remediated this cycle");
  await parkAt(h.deps, "recheck");
  await runNextStage(REVIEW, h.deps);

  const rf2 = findingsForReview(REVIEW).find((f) => f.findingRef === "RF-2") as ReviewFinding;
  assert.equal(rf2.resolution, "inconclusive");
  assert.deepEqual(pending().blockingFindings, ["RF-2"], "cycle 1's verdict holds the review — that part is #28");

  recordDisposition(rf2.id, {
    decision: "fix_now",
    rationale: "second attempt: guard the early return itself, not the caller",
    operator: false,
  });
  assert.equal(pending().kind, "batch_fix", "a fresh decision earns a new batch revision");

  const secondFix = await runNextStage(REVIEW, h.deps);
  assert.equal(secondFix.status, "advanced", secondFix.message);
  assert.equal(fixBatchesForReview(REVIEW).at(-1)?.state, "ingested");
  assert.equal(
    findingsForReview(REVIEW).find((f) => f.findingRef === "RF-2")?.resolution,
    undefined,
    "the ingest invalidated the verdict recorded before the cycle it just ran",
  );

  // And the gate does not DEPEND on that invalidation having landed. Put the stale verdict
  // back — exactly the row state a coordinator dying between the ingest and a separate
  // invalidation transaction used to leave — and the review still walks to the recheck.
  db.prepare(`UPDATE review_findings SET resolution = 'inconclusive' WHERE finding_ref = 'RF-2'`).run();
  assert.equal(pending().kind, "docs", pending().reason);

  await parkAt(h.deps, "recheck");
  assert.match(pending().reason, /a further fix cycle ran|known finding id\(s\) to recheck/);
  const rechecksBefore = h.calls.rechecker;
  const secondRecheck = await runNextStage(REVIEW, h.deps);
  assert.equal(secondRecheck.status, "advanced", secondRecheck.message);
  assert.equal(h.calls.rechecker, rechecksBefore + 1, "the new cycle earned its own recheck");
});

test("FG-639 / RF-11: an inconclusive with NO fresh decision still blocks, however many times continue runs", async () => {
  // The negative that keeps #28 intact. Nothing about the fix may let a rechecked-and-still-
  // inconclusive finding walk past the disposition gate on its own.
  const h = inconclusiveOnSecondFinding();
  await drive(h.deps, "discover");
  dispositionAll("fix_now", "will be remediated this cycle");
  await parkAt(h.deps, "recheck");
  await runNextStage(REVIEW, h.deps);

  const fixerCallsBefore = h.calls.fixer;
  for (let i = 0; i < 3; i++) {
    const stop = await runNextStage(REVIEW, h.deps);
    assert.equal(stop.transition.kind, "await_disposition", `continue #${i + 1} must still stop`);
    assert.match(stop.message, /RF-2 \(fix_now\/inconclusive\)/);
  }
  assert.equal(h.calls.fixer, fixerCallsBefore, "and no automatic fixer");
  assert.equal(getReview(REVIEW)?.state, "awaiting_disposition");
});

test("FG-639: a SECOND fix cycle at an UNMOVED candidate gets its own recheck — the review is not trapped at disposition", async () => {
  // The trap: the fixer completes without committing, so the candidate never moves. The
  // recheck record from the FIRST cycle still matches that sha, so Stage 8 was skipped and
  // the finding kept its stale `inconclusive` — which is itself a disposition blocker, so
  // every re-decision looped straight back to the fixer and the review could never settle.
  let cycle = 0;
  let rechecks = 0;
  const h = harness({
    dispatchFixer: (ctx) => {
      cycle += 1;
      return {
        ok: true,
        taskId: `task-fixer-${cycle}`,
        result: {
          fix_batch_id: ctx.batch.id,
          revision: ctx.batch.revision,
          findings: ctx.batch.payload.findings.map((f) => ({
            finding_id: f.finding_id,
            result: "fixed",
            remediation_summary: `cycle ${cycle}`,
            files_changed: ["src/x.ts"],
            evidence: `cycle ${cycle}: fixed without a commit`,
          })),
        },
      };
    },
    dispatchRechecker: (ctx) => ({
      ok: true,
      taskId: `task-recheck-${++rechecks}`,
      result: {
        review_id: ctx.review.id,
        candidate_sha: ctx.candidateSha,
        rechecked: ctx.expected.map((f) =>
          cycle >= 2
            ? {
                finding_id: f.id,
                result: "resolved",
                evidence_kind: "regression_test",
                evidence: {
                  kind: "regression_test",
                  test_name: "the reconcile path guards a partial write",
                  runner_output: EXECUTED,
                },
              }
            : { finding_id: f.id, result: "inconclusive", evidence_kind: "bounded_inspection", evidence: {} },
        ),
        new_findings: [],
      },
    }),
  });

  await drive(h.deps, "discover");
  dispositionAll("fix_now", "will be remediated this cycle");
  await runNextStage(REVIEW, h.deps); // batch_fix — cycle 1, no commit
  await runNextStage(REVIEW, h.deps); // docs
  await runNextStage(REVIEW, h.deps); // verify_final
  const firstRecheck = await runNextStage(REVIEW, h.deps);

  assert.equal(firstRecheck.status, "advanced");
  assert.equal(h.head(), "cand111", "the fixer committed nothing — the candidate never moved");
  const stale = findingsForReview(REVIEW).find((f) => f.findingRef === "RF-1");
  assert.equal(stale?.resolution, "inconclusive");
  assert.equal(pending().kind, "await_disposition", "an inconclusive fix_now holds the review, as it should");

  // The operator re-decides with a NEW rationale — the one mechanical path the lifecycle
  // offers out of this stop.
  recordDisposition(stale?.id as string, {
    decision: "fix_now",
    rationale: "second attempt: guard the early return itself, not the caller",
    operator: false,
  });
  assert.equal(pending().kind, "batch_fix", "a new decision earns a new batch revision");

  const secondFix = await runNextStage(REVIEW, h.deps);
  assert.equal(secondFix.status, "advanced");
  assert.equal(cycle, 2, "the second cycle really ran");
  assert.equal(h.head(), "cand111", "and again committed nothing");
  assert.equal(
    findingsForReview(REVIEW).find((f) => f.findingRef === "RF-1")?.resolution,
    undefined,
    "the verdict from the cycle BEFORE this one is not evidence about it",
  );

  assert.equal(
    pending().kind,
    "recheck",
    "the new fix cycle needs its own recheck even though the candidate sha is unchanged",
  );
  assert.match(pending().reason, /a further fix cycle ran at candidate cand111 since the last recheck/);

  const secondRecheck = await runNextStage(REVIEW, h.deps);
  assert.equal(secondRecheck.status, "advanced");
  assert.match(secondRecheck.message, /1 resolved, 0 unresolved/);
  assert.equal(rechecks, 2, "one recheck per fix cycle, not one per candidate sha");

  const settled = await runNextStage(REVIEW, h.deps);
  assert.equal(settled.transition.kind, "shipping_review");
  assert.equal(settled.status, "advanced", settled.message);
  assert.equal(getReview(REVIEW)?.state, "settled", "the review reaches a mechanical resolution");
});

test("FG-639 / RF-6: a WITHDRAWN fix cycle does not re-open a recheck that already completed at that sha", async () => {
  // The other direction of the same key. `ensureFixBatch` marks the prior batch `superseded`
  // the moment a new revision is created, so a key counting only `ingested` batches SHRANK
  // when a second cycle was created and then never ingested — and a shrunken key mismatches
  // exactly like a grown one, re-entering a completed recheck at the same sha with no cycle
  // having ingested anything since. That is not a harmless repeat: `expected` is empty by then
  // but the candidate has moved off the confirmed sha, so recheckIsNoOp is false and a real
  // rechecker is dispatched, whose new findings land as duplicate untriaged rows and bounce a
  // review one step from shipping back to Stage 4.
  //
  // RED baseline: filter fixCycleKey back to `b.state === "ingested"` alone and the final
  // assertions fail — pending() reads `recheck` again and a second rechecker is dispatched.
  let cycle = 0;
  let rechecks = 0;
  const h: Harness = harness({
    dispatchFixer: (ctx) => {
      cycle += 1;
      if (cycle === 2) {
        // The second dispatch reaches a container and fails, so nothing is ingested: batch 2
        // is a cycle that was WITHDRAWN, not one that ran.
        return { ok: false, taskId: "task-fixer-2", error: "the fixer container died" };
      }
      // Cycle 1 COMMITS, so the candidate leaves the confirmed sha. That is what makes the
      // wrongly re-entered recheck below dispatch a real rechecker rather than record a no-op.
      h.setHead("afterfix2");
      return {
        ok: true,
        taskId: "task-fixer-1",
        result: {
          fix_batch_id: ctx.batch.id,
          revision: ctx.batch.revision,
          findings: ctx.batch.payload.findings.map((f) => ({
            finding_id: f.finding_id,
            result: "fixed",
            remediation_summary: "cycle 1",
            files_changed: ["src/x.ts"],
            evidence: "cycle 1: committed a guard",
          })),
        },
      };
    },
    dispatchRechecker: (ctx) => ({
      ok: true,
      taskId: `task-recheck-${++rechecks}`,
      result: {
        review_id: ctx.review.id,
        candidate_sha: ctx.candidateSha,
        rechecked: ctx.expected.map((f) => ({
          finding_id: f.id,
          result: "still_present",
          evidence_kind: "anchored_verification",
          evidence: {},
        })),
        new_findings: [],
      },
    }),
  });

  await drive(h.deps, "discover");
  dispositionAll("fix_now", "will be remediated this cycle");
  await parkAt(h.deps, "recheck");
  const firstRecheck = await runNextStage(REVIEW, h.deps);
  assert.equal(firstRecheck.status, "advanced");
  assert.equal(rechecks, 1);
  assert.equal(h.head(), "afterfix2", "the candidate moved off the confirmed sha");

  const f = findingsForReview(REVIEW).find((x) => x.findingRef === "RF-1") as ReviewFinding;
  assert.equal(f.resolution, "still_present");
  assert.equal(pending().kind, "await_disposition");

  // A re-decision opens revision 2, which SUPERSEDES revision 1 — and then the dispatch dies,
  // so revision 2 never reaches `ingested`.
  recordDisposition(f.id, { decision: "fix_now", rationale: "second attempt: guard the caller", operator: false });
  const secondFix = await runNextStage(REVIEW, h.deps);
  assert.equal(secondFix.status, "refused", secondFix.message);
  assert.equal(cycle, 2);
  const batches = fixBatchesForReview(REVIEW);
  assert.equal(batches.length, 2);
  assert.equal(batches[0]?.state, "superseded", "revision 1 lost its `ingested` marker to supersession");
  assert.notEqual(batches[1]?.state, "ingested", "revision 2 never ingested — the cycle was withdrawn");

  // The operator stops asking for a fix, so Stage 5 is vacuously satisfied and the review
  // walks forward. Stage 8 must read as COMPLETE: no cycle has ingested anything since the
  // recheck that ran at this very sha.
  const accepted = recordDisposition(f.id, {
    decision: "accepted_risk",
    rationale: "withdrawing the second attempt; the residual risk is accepted",
    operator: true,
  });
  assert.equal(accepted.ok, true, accepted.ok ? "" : accepted.refusal);

  assert.equal(
    pending().kind,
    "shipping_review",
    "a withdrawn cycle is not a further cycle that ran — the completed recheck stands",
  );
  await runNextStage(REVIEW, h.deps);
  assert.equal(rechecks, 1, "no second rechecker was dispatched for a cycle that ingested nothing");
});

test("FG-639: a crash-resume at an UNCHANGED fix cycle still never repeats the recheck", async () => {
  const h = harness();
  await drive(h.deps, "discover");
  dispositionAll("fix_now", "will be remediated this cycle");
  await parkAt(h.deps, "recheck");
  await runNextStage(REVIEW, h.deps);
  const rechecksAfterFirst = h.calls.rechecker;

  // A fresh process reads the same rows: the candidate matches AND so does the fix-cycle
  // key, so the stage is complete and the next transition is the one after it.
  assert.equal(pending().kind, "shipping_review");
  await runNextStage(REVIEW, h.deps);
  assert.equal(h.calls.rechecker, rechecksAfterFirst, "a completed recheck is not re-entered on resume");
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

// ─── the skip-evidence rule, through the coordinator's own ingestion ─────────
//
// The unit suites prove `validateResolutionEvidence` and `ingestRecheck` refuse a skipped
// test. These drive the same refusal through Stage 8 as the coordinator actually runs it,
// because the thing that must not happen is a review SETTLING on a skipped test — and that
// is a property of the whole stage: what gets written to the finding, what state the review
// lands in, and whether the shipping stage is ever reachable.

const TEST_NAME = "the reconcile path guards a partial write";
const SKIPPED = `ok 1 - ${TEST_NAME} # SKIP no chrome binary in this container`;

/** Drive to Stage 8 with one fix_now finding and the given rechecker. */
async function driveToRecheck(h: Harness) {
  await drive(h.deps, "discover");
  dispositionAll("fix_now", "will be remediated this cycle");
  await runNextStage(REVIEW, h.deps); // batch_fix
  await runNextStage(REVIEW, h.deps); // docs
  await runNextStage(REVIEW, h.deps); // verify_final
  return runNextStage(REVIEW, h.deps); // recheck
}

function recheckerCiting(evidence: (candidateSha: string) => unknown): Partial<CoordinatorDeps> {
  return {
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
          evidence: evidence(ctx.candidateSha),
        })),
        new_findings: [],
      },
    }),
  };
}

test("FG-639 / PRD #29: a recheck resolving a finding on a SKIPPED test is rejected with a named reason and returns to disposition", async () => {
  const h = harness(recheckerCiting(() => ({ kind: "regression_test", test_name: TEST_NAME, runner_output: SKIPPED })));
  const recheck = await driveToRecheck(h);

  assert.equal(recheck.status, "advanced", "the stage ran; what it recorded is the point");
  assert.match(recheck.message, /0 resolved, 1 unresolved \(RF-1=inconclusive\)/);

  const f = findingsForReview(REVIEW)[0] as ReviewFinding;
  assert.equal(f.resolution, "inconclusive", "a skipped test is never evidence — and never silence either");
  assert.equal(f.resolutionEvidenceKind, "not_executed", "the coverage outcome is recorded, never green");
  assert.match(f.resolutionEvidence ?? "", /SKIPPED in the cited runner output/);
  assert.match(f.resolutionEvidence ?? "", /a skipped test is never evidence/);
  assert.match(f.resolutionEvidence ?? "", /unnamed "covered elsewhere" is refused/);

  assert.equal(getReview(REVIEW)?.state, "awaiting_disposition");
  const next = await runNextStage(REVIEW, h.deps);
  assert.equal(next.transition.kind, "await_disposition");
  assert.deepEqual(next.transition.blockingFindings, ["RF-1"]);
  assert.equal(getReview(REVIEW)?.stageEvidence?.shipping, undefined, "nothing ships on a skipped test");
});

test("FG-639 / PRD #29: the same skipped test resolves once a MANDATORY LANE names the sha and the executed assertion", async () => {
  const h = harness(
    recheckerCiting((candidateSha) => ({
      kind: "regression_test",
      test_name: TEST_NAME,
      runner_output: SKIPPED,
      alternate_lane: {
        lane: "dashboard-browser",
        candidate_sha: candidateSha,
        executed_assertion: TEST_NAME,
        runner_output: EXECUTED,
      },
    })),
  );
  const recheck = await driveToRecheck(h);

  assert.match(recheck.message, /1 resolved, 0 unresolved/);
  const f = findingsForReview(REVIEW)[0] as ReviewFinding;
  assert.equal(f.resolution, "resolved");
  assert.equal(f.resolutionEvidenceKind, "regression_test");
  assert.match(f.resolutionEvidence ?? "", /mandatory lane 'dashboard-browser' executed/);
  assert.equal(f.resolvedSha, "afterfix2", "resolved AT the candidate the lane named");

  const shipping = await runNextStage(REVIEW, h.deps);
  assert.equal(shipping.transition.kind, "shipping_review");
  assert.equal(shipping.status, "advanced");
});

test("FG-639 / PRD #29: an alternate lane at ANOTHER candidate is refused by name and the finding stays unresolved", async () => {
  const h = harness(
    recheckerCiting(() => ({
      kind: "regression_test",
      test_name: TEST_NAME,
      runner_output: SKIPPED,
      alternate_lane: {
        lane: "dashboard-browser",
        candidate_sha: "somethingelse7",
        executed_assertion: TEST_NAME,
        runner_output: EXECUTED,
      },
    })),
  );
  const recheck = await driveToRecheck(h);

  assert.match(recheck.message, /0 resolved, 1 unresolved \(RF-1=inconclusive\)/);
  const f = findingsForReview(REVIEW)[0] as ReviewFinding;
  assert.equal(f.resolution, "inconclusive");
  assert.match(f.resolutionEvidence ?? "", /names candidate somethingelse7, not this review's candidate afterfix2/);
  assert.equal(getReview(REVIEW)?.state, "awaiting_disposition");
});

test("FG-639 / PRD #29: an alternate lane named with NO execution record leaves the finding unresolved", async () => {
  const h = harness(
    recheckerCiting((candidateSha) => ({
      kind: "regression_test",
      test_name: TEST_NAME,
      runner_output: SKIPPED,
      alternate_lane: { lane: "dashboard-browser", candidate_sha: candidateSha, executed_assertion: TEST_NAME },
    })),
  );
  const recheck = await driveToRecheck(h);

  assert.match(recheck.message, /0 resolved, 1 unresolved \(RF-1=inconclusive\)/);
  const f = findingsForReview(REVIEW)[0] as ReviewFinding;
  assert.equal(f.resolution, "inconclusive");
  assert.match(f.resolutionEvidence ?? "", /carries no execution record/);
  assert.equal(getReview(REVIEW)?.state, "awaiting_disposition");
});

test("FG-639 / PRD #20: a fixer result claiming a stale REVISION refuses the stage and credits nothing", async () => {
  const h = harness({
    dispatchFixer: (ctx) => ({
      ok: true,
      taskId: "task-fixer-1",
      result: {
        fix_batch_id: ctx.batch.id,
        // Right batch, right finding ids, a revision this batch was never dispatched at.
        revision: ctx.batch.revision + 1,
        findings: ctx.batch.payload.findings.map((f) => ({
          finding_id: f.finding_id,
          result: "fixed",
          remediation_summary: "guarded",
          files_changed: ["src/x.ts"],
          evidence: "added the named regression test",
        })),
      },
    }),
  });
  await drive(h.deps, "discover");
  dispositionAll("fix_now", "will be remediated this cycle");

  const fix = await runNextStage(REVIEW, h.deps);
  assert.equal(fix.status, "refused");
  assert.match(fix.message, /claims revision 2/);
  assert.match(fix.message, /dispatched at revision 1/);

  const batch = fixBatchesForReview(REVIEW)[0] as NonNullable<ReturnType<typeof getFixBatch>>;
  assert.notEqual(getFixBatch(batch.id)?.state, "ingested", "a stale revision is never credited as current");
  assert.equal(
    findingsForReview(REVIEW).every((f) => f.disposition === "fix_now" && f.resolution === undefined),
    true,
    "the findings stay fix_now and unresolved",
  );
  assert.equal(pending().kind, "batch_fix", "the stage was not stepped over");
});

test("FG-639 / PRD #29: the shipping review refuses an acceptance criterion whose only evidence is a SKIPPED test", async () => {
  const base = harness();
  const h = harness({
    shippingInput: async (ctx) => {
      const input = await base.deps.shippingInput(ctx);
      return {
        ...input,
        acceptance: [
          {
            ref: "FG-639 AC 1",
            verdict: "met",
            evidence: { kind: "regression_test", test_name: TEST_NAME, runner_output: SKIPPED },
          },
        ],
      };
    },
  });

  await parkAt(h.deps, "shipping_review");
  const shipping = await runNextStage(REVIEW, h.deps);

  assert.equal(shipping.status, "refused");
  assert.match(shipping.message, /acceptance_mapped: 1 acceptance criteria are unmet\/unproven/);
  assert.match(shipping.message, /SKIPPED in the cited runner output/);
  assert.equal(shipping.shipping?.acceptance[0]?.verdict, "unproven");
  assert.equal(getReview(REVIEW)?.stageEvidence?.shipping, undefined);
  assert.notEqual(getReview(REVIEW)?.state, "settled");
});

// ─── PRD #8 — a demonstrated invariant violation stops before shipping ───────

test("FG-639 / PRD #8: a demonstrated data-loss path against a protected invariant stops at disposition and can never reach shipping", async () => {
  const h = harness({
    dispatchLens: (ctx) => ({
      lens: ctx.lens,
      role: ctx.role,
      dispatched: true,
      taskId: `task-${ctx.lens}`,
      result:
        ctx.lens === "backend"
          ? {
              outcome: "fail",
              findings: [
                discoveryFinding(1, {
                  summary: "the reconcile path writes the ledger row and returns before the receipt, losing the receipt on crash",
                  severity: "critical",
                  reachability: "demonstrated",
                  file: "src/store/reviews.ts",
                  line: 88,
                  invariant_ref: "no partial write",
                }),
              ],
            }
          : { outcome: "pass", findings: [] },
    }),
  });

  const seen = await drive(h.deps, "settled");
  assert.deepEqual(
    seen,
    ["verify_entry:advanced", "confirm_contract:advanced", "discover:advanced", "await_disposition:stopped"],
    "the lifecycle stops at Stage 4 — a demonstrated invariant violation is never driven past it",
  );

  const f = findingsForReview(REVIEW)[0] as ReviewFinding;
  assert.equal(f.reachability, "demonstrated");
  assert.equal(f.invariantRef, "no partial write");
  assert.ok(
    (CONTRACT.protected_invariants as readonly string[]).includes(f.invariantRef as string),
    "the invariant it violates is one the confirmed contract protects",
  );
  assert.equal(f.disposition, "untriaged");

  // No amount of continuing gets past the operator: every attempt lands on the same stop.
  for (let i = 0; i < 3; i++) {
    const again = await runNextStage(REVIEW, h.deps);
    assert.equal(again.transition.kind, "await_disposition");
    assert.deepEqual(again.transition.blockingFindings, ["RF-1"]);
  }
  assert.equal(h.calls.fixer, 0);
  assert.equal(h.calls.docs, 0);
  assert.equal(h.calls.rechecker, 0);
  assert.equal(getReview(REVIEW)?.stageEvidence?.shipping, undefined);
});

// ─── FixBatch integrity under adversity ─────────────────────────────────────

test("FG-639 / PRD #20: a fixer result naming a FOREIGN finding id is refused at host ingestion and nothing is recorded", async () => {
  const h = harness({
    dispatchFixer: (ctx) => ({
      ok: true,
      taskId: "task-fixer-1",
      result: {
        fix_batch_id: ctx.batch.id,
        revision: ctx.batch.revision,
        findings: [
          {
            finding_id: "rf-from-some-other-review",
            result: "fixed",
            remediation_summary: "guarded",
            files_changed: ["src/x.ts"],
            evidence: "added the named regression test",
          },
        ],
      },
    }),
  });
  await drive(h.deps, "discover");
  dispositionAll("fix_now", "will be remediated this cycle");

  const fix = await runNextStage(REVIEW, h.deps);
  assert.equal(fix.status, "refused");
  assert.match(fix.message, /rf-from-some-other-review, which is not in fix batch/);
  assert.match(fix.message, /Nothing was written/);
  assert.equal(getReview(REVIEW)?.stageEvidence?.fix, undefined);
  assert.equal(fixBatchesForReview(REVIEW)[0]?.state, "dispatched", "the batch never reaches ingested");
  const f = findingsForReview(REVIEW)[0] as ReviewFinding;
  assert.equal(f.disposition, "fix_now");
  assert.equal(f.resolution, undefined);
});

test("FG-639 / PRD #19: a disposition re-decided WHILE the fixer runs leaves that task bound to its revision and gives the next dispatch a new one", async () => {
  const dispatched: Array<{ id: string; revision: number; payload: string; candidate: string }> = [];
  let n = 0;
  const h = harness({
    findingsPerLens: 2,
    dispatchFixer: (ctx) => {
      n += 1;
      dispatched.push({
        id: ctx.batch.id,
        revision: ctx.batch.revision,
        payload: ctx.payload,
        candidate: ctx.batch.candidateSha,
      });
      if (n === 1) {
        // The operator changes their mind about RF-1 while THIS container is running. The
        // head deliberately does not move, so the only thing that differs for the next
        // dispatch is the decision — not the candidate.
        const rf1 = findingsForReview(REVIEW).find((f) => f.findingRef === "RF-1") as ReviewFinding;
        recordDisposition(rf1.id, {
          decision: "fix_now",
          rationale: "re-decided mid-flight: guard the reconcile path too",
          operator: false,
        });
      }
      return {
        ok: true,
        taskId: `task-fixer-${n}`,
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
  });

  await drive(h.deps, "discover");
  dispositionAll("fix_now", "will be remediated this cycle");

  const firstFix = await runNextStage(REVIEW, h.deps);
  assert.equal(firstFix.status, "advanced");
  const rev1 = fixBatchesForReview(REVIEW)[0] as NonNullable<ReturnType<typeof getFixBatch>>;
  assert.equal(rev1.revision, 1);
  assert.equal(rev1.dispatchTaskId, "task-fixer-1");
  assert.equal(
    serializeFixBatchPayload(rev1.payload),
    dispatched[0]?.payload,
    "the payload the running container was dispatched with is byte-identical after the operator's change",
  );

  // The re-decided finding is not covered by what the ingested batch carried, so the machine
  // returns to the fix stage — with revision 2, never a mutated revision 1.
  const secondFix = await runNextStage(REVIEW, h.deps);
  assert.equal(secondFix.transition.kind, "batch_fix");
  assert.equal(secondFix.status, "advanced");
  assert.equal(n, 2, "the second dispatch is a second fixer, not a mutation of the first");

  const batches = fixBatchesForReview(REVIEW);
  assert.equal(batches.length, 2);
  const rev2 = batches[1] as NonNullable<ReturnType<typeof getFixBatch>>;
  assert.equal(rev2.revision, 2);
  assert.equal(rev2.supersedesBatchId, rev1.id);
  assert.equal(rev2.candidateSha, "cand111", "the new revision came from the DECISION, not from a moved candidate");
  assert.notEqual(rev2.payloadSha256, rev1.payloadSha256);
  assert.equal(rev2.dispatchTaskId, "task-fixer-2");
  assert.equal(getFixBatch(rev1.id)?.state, "superseded");
  assert.equal(
    serializeFixBatchPayload(getFixBatch(rev1.id)?.payload as never),
    dispatched[0]?.payload,
    "superseding revision 1 did not rewrite it",
  );
  assert.match(
    dispatched[1]?.payload ?? "",
    /re-decided mid-flight: guard the reconcile path too/,
    "the second dispatch carries the NEW decision",
  );
});

// ─── PRD #2 / #3 — dedup across lenses, at the stage that ingests ───────────

const SHARED_ANCHOR = { file: "src/store/reviews.ts", line: 88 };

function bothLensesReport(invariantFor: (lens: string) => string): Partial<CoordinatorDeps> {
  return {
    dispatchLens: (ctx) => ({
      lens: ctx.lens,
      role: ctx.role,
      dispatched: true,
      taskId: `task-${ctx.lens}`,
      result: {
        outcome: "fail",
        findings: [
          discoveryFinding(1, {
            ...SHARED_ANCHOR,
            summary: `the ${ctx.lens} lens reports the ledger write is not atomic`,
            risk_lens: ctx.lens,
            invariant_ref: invariantFor(ctx.lens),
          }),
        ],
      },
    }),
  };
}

test("FG-639 / PRD #2: two lenses reporting the same mechanism AND invariant become ONE ledger finding carrying both sources", async () => {
  const h = harness(bothLensesReport(() => "no partial write"));
  await drive(h.deps, "discover");

  const findings = findingsForReview(REVIEW);
  assert.equal(findings.length, 1, "one finding, not one per reviewer");
  assert.deepEqual(
    findings[0]?.sources.map((s) => s.redRole),
    ["red-wide", "red-backend"],
    "both reviewers survive as provenance",
  );
  assert.deepEqual(findings[0]?.sources.map((s) => s.redTaskId), ["task-wide", "task-backend"]);
  assert.equal(findings[0]?.severity, "high", "a correlated agreement is not an escalation");
  const merges = getReview(REVIEW)?.stageEvidence?.discovery?.meta?.["merges"] as unknown[];
  assert.equal(merges.length, 1);
});

test("FG-639 / PRD #3: the same two lenses at the same anchor naming DIFFERENT invariants stay TWO findings", async () => {
  const h = harness(bothLensesReport((lens) => (lens === "wide" ? "no partial write" : "only forge publishes")));
  await drive(h.deps, "discover");

  const findings = findingsForReview(REVIEW);
  assert.equal(findings.length, 2, "same mechanism, different promises — merging them would hide one defect");
  assert.deepEqual(findings.map((f) => f.invariantRef), ["no partial write", "only forge publishes"]);
  assert.deepEqual(findings.map((f) => f.sources.length), [1, 1]);
  assert.equal((getReview(REVIEW)?.stageEvidence?.discovery?.meta?.["merges"] as unknown[]).length, 0);
  assert.deepEqual(pending().blockingFindings, ["RF-1", "RF-2"]);
});
