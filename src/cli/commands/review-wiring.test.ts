// FG-639: the coordinator's host wiring, at the one seam that can silently skip a check.
//
// Stage 2a confirms the approved contract AGAINST THE FINAL IMPLEMENTATION DIFF. The wiring
// used to forward the changed paths into the confirmation record and then always propose the
// unchanged contract, so the diff was recorded and never evaluated — drift classification was
// inert unless an operator typed --drift, and every candidate auto-confirmed. This suite pins
// the fail-closed replacement: an unevaluated nonempty diff refuses and surfaces its summary;
// a recorded evaluation proceeds; an empty diff confirms.
//
// It drives `proposeContract` through the REAL `confirmContract`, because the claim that
// matters is the confirmation outcome, not the shape of the proposal object in between.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Database as DatabaseInstance } from "better-sqlite3";
import {
  buildCoordinatorDeps,
  FIX_BATCH_ENVELOPE_PATH,
  FIX_BATCH_PAYLOAD_PATH,
} from "./review-wiring.js";
import { confirmContract, validateReviewContract, type ReviewContract } from "../../v2/review-contract.js";
import { makeInMemoryDb, setDbForTest } from "../../store/db.js";
import {
  findingsForReview,
  getReview,
  ingestFindings,
  insertReview,
  recordDisposition,
  type Review,
} from "../../store/reviews.js";
import { ensureFixBatch, fixBatchEnvelope, serializeFixBatchPayload } from "../../store/fix-batches.js";
import { fixBatchBundleDir } from "../../util/paths.js";
import { runNextStage, type CoordinatorDeps, type FixerContext } from "../../v2/review-run.js";
import type { InvokeArgs, InvokeResult } from "../../v2/invoke.js";

const CONTRACT = validateReviewContract({
  threat_model: "operator_trusted_candidate",
  protected_invariants: ["no partial write"],
  acceptance_refs: ["FG-639 AC 1"],
  risk_lenses: ["wide"],
  non_goals: ["protect the host from malicious candidate code"],
});
const APPROVED = (CONTRACT.ok ? CONTRACT.contract : undefined) as ReviewContract;

const REVIEW = {
  id: "review-fg639-wiring",
  reviewMode: "evidence_led",
  ticketId: "FG-639",
  baseSha: "base000",
  candidateSha: "cand111",
  contract: APPROVED,
  state: "confirming_contract",
  createdAt: "2026-07-30T00:00:00Z",
  updatedAt: "2026-07-30T00:00:00Z",
} as unknown as Review;

/** Confirm exactly as `runContractConfirmation` does: the wiring proposes, the pure module
 *  decides, and the candidate sha comes from the coordinator rather than the proposal. */
async function confirmVia(
  changedPaths: string[],
  over: { addLenses?: never[] | Parameters<typeof buildCoordinatorDeps>[0]["addLenses"]; unclassifiableDrift?: string } = {},
) {
  const deps = buildCoordinatorDeps({
    projectDir: "/nonexistent-project",
    ticketId: "FG-639",
    git: () => "",
    ...over,
  });
  const proposal = await deps.proposeContract({ review: REVIEW, candidateSha: "cand111", changedPaths });
  return confirmContract(APPROVED, { ...proposal, candidateSha: "cand111", changedPaths });
}

test("FG-639: a NONEMPTY final diff with no recorded drift evaluation refuses to auto-confirm", async () => {
  const outcome = await confirmVia(["src/store/reviews.ts", "src/v2/review-run.ts"]);

  assert.notEqual(outcome.kind, "confirmed", "silently proposing the unchanged contract is the forbidden outcome");
  const refusal = outcome.kind === "confirmed" ? "" : outcome.refusal;
  assert.match(refusal, /no drift evaluation has been recorded for the final implementation diff/);
  assert.match(refusal, /2 changed path\(s\): src\/store\/reviews\.ts, src\/v2\/review-run\.ts/, "the diff summary is surfaced");
  assert.match(refusal, /--add-lens/, "and so is the way to record an evaluation");
  assert.match(refusal, /--drift/);
});

test("FG-639: the surfaced summary names the paths it can and says how many more there are", async () => {
  const paths = Array.from({ length: 14 }, (_, i) => `src/f${i}.ts`);
  const outcome = await confirmVia(paths);
  const refusal = outcome.kind === "confirmed" ? "" : outcome.refusal;
  assert.match(refusal, /14 changed path\(s\)/);
  assert.match(refusal, /\+4 more/, "a long diff is summarized, not reproduced");
});

test("FG-639: a RECORDED evaluation proceeds — the confirmation widens with its evidence", async () => {
  const outcome = await confirmVia(["src/store/reviews.ts"], {
    addLenses: [{ lens: "backend", reason: "the diff moves a store write path", diffEvidence: ["src/store/reviews.ts"] }],
  });

  assert.equal(outcome.kind, "confirmed", outcome.kind === "confirmed" ? "" : outcome.refusal);
  if (outcome.kind !== "confirmed") return;
  assert.deepEqual(outcome.addedLenses, ["backend"]);
  assert.deepEqual(outcome.changedPaths, ["src/store/reviews.ts"]);
  assert.equal(outcome.confirmedSha, "cand111");
});

test("FG-639: an EMPTY final diff confirms the approved contract unchanged", async () => {
  const outcome = await confirmVia([]);

  assert.equal(outcome.kind, "confirmed");
  if (outcome.kind !== "confirmed") return;
  assert.deepEqual(outcome.addedLenses, [], "nothing was widened and nothing was inferred");
  assert.deepEqual(outcome.contract.risk_lenses, ["wide"]);
});

test("FG-639: operator-named drift still returns to plan rather than confirming", async () => {
  const outcome = await confirmVia(["src/store/reviews.ts"], {
    unclassifiableDrift: "the diff adds a publication path I cannot map to a lens",
  });

  assert.equal(outcome.kind, "returns_to_plan");
  assert.match(
    outcome.kind === "returns_to_plan" ? outcome.refusal : "",
    /cannot map to a lens/,
    "the operator's own words survive — the fail-closed summary does not overwrite them",
  );
});

// ─── the stage, over the real base-sha path ─────────────────────────────────
//
// The cases above drive `proposeContract` directly, so they cannot see the seam BEFORE it:
// runContractConfirmation computes the changed paths itself, and it used to default them to
// [] whenever the review recorded no base sha. An empty diff is precisely what makes the
// fail-closed guard inert, so the review with no base auto-confirmed over a real change.
// These drive `runNextStage` against the real store, the real wiring and the real
// confirmation, which is the only place that defaulting is visible.

const RUN_ID = "run-fg639-wiring";
const STAGED_REVIEW = "review-fg639-wiring-staged";

let db: DatabaseInstance;
let prevDb: DatabaseInstance | null;

beforeEach(() => {
  db = makeInMemoryDb();
  prevDb = setDbForTest(db);
  db.prepare(`INSERT INTO runs (id, workflow, title, status, created_at, review_mode) VALUES (?, ?, ?, ?, ?, ?)`).run(
    RUN_ID,
    "feature",
    "wiring",
    "active",
    "2026-07-30T00:00:00Z",
    "evidence_led",
  );
});

afterEach(() => {
  setDbForTest(prevDb as DatabaseInstance);
  db.close();
});

/** A review parked exactly at Stage 2a: entry verification recorded, contract approved,
 *  nothing confirmed yet. `base` is the whole variable under test. */
function parkAtConfirmation(base: string | undefined): void {
  insertReview({
    id: STAGED_REVIEW,
    runId: RUN_ID,
    ticketId: "FG-639",
    reviewMode: "evidence_led",
    ...(base !== undefined ? { baseSha: base } : {}),
    candidateSha: "cand111",
    contract: APPROVED,
    state: "confirming_contract",
    stageEvidence: { verified_entry: { sha: "cand111", at: "2026-07-30T00:00:01Z" } },
  });
}

/** The real host wiring over a git that reports `paths` as the base..candidate diff, with
 *  the container-dispatching deps stubbed out — Stage 2a dispatches nothing, and a stage
 *  that tried to would fail loudly here rather than silently pass. */
function stagedDeps(paths: string[], over: Partial<Parameters<typeof buildCoordinatorDeps>[0]> = {}): CoordinatorDeps {
  const git = (args: string[]): string => {
    if (args[0] === "rev-parse") return "cand111\n";
    if (args[0] === "diff" && args[1] === "--name-only") return paths.join("\n");
    return "";
  };
  return {
    ...buildCoordinatorDeps({ projectDir: "/nonexistent-project", ticketId: "FG-639", git, ...over }),
    verify: () => {
      throw new Error("Stage 2a must not verify");
    },
    dispatchLens: () => {
      throw new Error("Stage 2a must not dispatch a lens");
    },
  };
}

test("FG-639: a review with NO base sha REFUSES confirmation — it cannot name the diff it would confirm against", async () => {
  parkAtConfirmation(undefined);
  const outcome = await runNextStage(STAGED_REVIEW, stagedDeps(["src/store/reviews.ts"]));

  assert.equal(outcome.transition.kind, "confirm_contract");
  assert.equal(outcome.status, "refused", "an unnameable base must not become an empty diff and an auto-confirm");
  assert.match(outcome.message, /records no base sha/);
  assert.match(outcome.message, /cannot name its base cannot confirm a contract/);
  assert.equal(getReview(STAGED_REVIEW)?.contractConfirmedSha, undefined, "nothing was confirmed");
  assert.equal(getReview(STAGED_REVIEW)?.stageEvidence?.contract_confirmed, undefined, "and no stage was recorded");
});

test("FG-639: with a base sha, a nonempty diff and NOTHING recorded still refuses through the stage", async () => {
  parkAtConfirmation("base000");
  const outcome = await runNextStage(STAGED_REVIEW, stagedDeps(["src/store/reviews.ts", "src/v2/review-run.ts"]));

  assert.equal(outcome.status, "refused");
  assert.match(outcome.message, /no drift evaluation has been recorded/);
  assert.match(outcome.message, /2 changed path\(s\)/, "the diff the stage computed from the base is the one surfaced");
  assert.equal(getReview(STAGED_REVIEW)?.contractConfirmedSha, undefined);
});

test("FG-639: a recorded no_drift evaluation ADVANCES the confirmation and is persisted with the diff it examined", async () => {
  parkAtConfirmation("base000");
  const statement = "all four paths are inside the wide lens already selected; no lens change is needed";
  const outcome = await runNextStage(
    STAGED_REVIEW,
    stagedDeps(["src/store/reviews.ts", "src/v2/review-run.ts"], { evaluatedNoDrift: statement }),
  );

  assert.equal(outcome.status, "advanced", outcome.message);
  assert.match(outcome.message, /no_drift/, "the outcome names the evaluation it rests on");

  const review = getReview(STAGED_REVIEW);
  assert.equal(review?.contractConfirmedSha, "cand111");
  const stage = review?.stageEvidence?.contract_confirmed;
  assert.equal(stage?.sha, "cand111");
  assert.match(stage?.detail ?? "", new RegExp(statement.slice(0, 30)), "the evaluator's statement is the record");
  const meta = stage?.meta as { evaluation?: string; noDrift?: { diffSummary: string; statement: string } };
  assert.equal(meta.evaluation, "no_drift");
  assert.equal(meta.noDrift?.statement, statement);
  assert.match(
    meta.noDrift?.diffSummary ?? "",
    /2 changed path\(s\): src\/store\/reviews\.ts, src\/v2\/review-run\.ts/,
    "the diff the evaluator examined is recorded beside the statement — not just that they said so",
  );
});

test("FG-639: no_drift and a widening claim in the same confirmation contradict and are refused", async () => {
  parkAtConfirmation("base000");
  const outcome = await runNextStage(
    STAGED_REVIEW,
    stagedDeps(["src/store/reviews.ts"], {
      evaluatedNoDrift: "nothing to widen",
      addLenses: [{ lens: "backend", reason: "the diff moves a store write path", diffEvidence: ["src/store/reviews.ts"] }],
    }),
  );

  assert.equal(outcome.status, "refused");
  assert.match(outcome.message, /no_drift AND proposes a contract change/);
  assert.match(outcome.message, /a diff that needs a lens is drift, not no_drift/);
});

// ─── the fixer's bundle, delivered INSIDE the container ─────────────────────
//
// The live pilot's Stage 5 defect. dispatchFixer materialized the hash-verified bundle at
// ~/.forge/reviews/<review>/<batch>/ on the HOST and then named THAT path in the prompt.
// No mount carried it, so the fixer searched every mount, honestly reported the
// authoritative handoff undelivered, and the host correctly refused its empty findings
// array. These pin the delivery: the bundle rides the task dir that already carries
// CLAUDE.md and package.md, the prompt names the in-container path and no other, and a
// payload tampered after materialization never reaches a container at all.

const FIX_REVIEW = "review-fg639-fixer";

function parkAtFix(): FixerContext {
  insertReview({
    id: FIX_REVIEW,
    runId: RUN_ID,
    ticketId: "FG-639",
    reviewMode: "evidence_led",
    baseSha: "base000",
    candidateSha: "cand111",
    contract: APPROVED,
    state: "fixing",
  });
  const observed = ingestFindings(FIX_REVIEW, [
    {
      summary: "the reconcile path can write partially",
      evidence: "line 42 writes before the guard",
      riskLens: "backend",
      reachability: "demonstrated",
    },
  ])[0]!;
  const disposed = recordDisposition(observed.id, {
    decision: "fix_now",
    rationale: "in scope this cycle",
    operator: false,
  });
  assert.equal(disposed.ok, true);
  const { batch } = ensureFixBatch(FIX_REVIEW, "cand111", findingsForReview(FIX_REVIEW));
  return {
    review: getReview(FIX_REVIEW) as Review,
    batch,
    envelope: fixBatchEnvelope(batch),
    payload: serializeFixBatchPayload(batch.payload),
  };
}

function capturingInvoke(): { invokeFn: (a: InvokeArgs) => Promise<InvokeResult>; calls: InvokeArgs[] } {
  const calls: InvokeArgs[] = [];
  return {
    calls,
    invokeFn: async (a: InvokeArgs): Promise<InvokeResult> => {
      calls.push(a);
      return { runId: RUN_ID, taskId: "task-fixer-1", status: "complete", result: {} };
    },
  };
}

function fixerDeps(invokeFn: (a: InvokeArgs) => Promise<InvokeResult>): CoordinatorDeps {
  return buildCoordinatorDeps({
    projectDir: "/nonexistent-project",
    ticketId: "FG-639",
    git: () => "",
    invokeFn,
  });
}

test("FG-639: the fixer's bundle is DELIVERED into the container, byte for byte", async () => {
  const ctx = parkAtFix();
  const { invokeFn, calls } = capturingInvoke();
  const deps = fixerDeps(invokeFn);

  await deps.materializeFixBatch(ctx);
  const out = await deps.dispatchFixer(ctx);

  assert.equal(out.ok, true);
  assert.equal(calls.length, 1);
  const files = calls[0]?.taskFiles ?? {};
  assert.equal(
    files["fix-batch/payload.json"],
    ctx.payload,
    "the hash-verified bytes ride the task dir — the mount the container already has",
  );
  assert.equal(
    JSON.parse(files["fix-batch/envelope.json"] ?? "{}").payload_sha256,
    ctx.batch.payloadSha256,
    "the envelope rides along so the fixer can re-verify in-container",
  );
});

test("FG-639: the fixer prompt names the IN-CONTAINER path and never the host bundle dir", async () => {
  const ctx = parkAtFix();
  const { invokeFn, calls } = capturingInvoke();
  const deps = fixerDeps(invokeFn);

  await deps.materializeFixBatch(ctx);
  await deps.dispatchFixer(ctx);

  const task = calls[0]?.task ?? "";
  assert.equal(task.includes(FIX_BATCH_PAYLOAD_PATH), true, "the payload is named where the fixer can open it");
  assert.equal(task.includes(FIX_BATCH_ENVELOPE_PATH), true);
  assert.equal(
    task.includes(fixBatchBundleDir(FIX_REVIEW, ctx.batch.id)),
    false,
    "a host path no mount delivers is exactly what made the pilot's fixer report the handoff undelivered",
  );
});

test("FG-639: a payload tampered AFTER materialization refuses BEFORE the container starts", async () => {
  const ctx = parkAtFix();
  const { invokeFn, calls } = capturingInvoke();
  const deps = fixerDeps(invokeFn);

  await deps.materializeFixBatch(ctx);
  const payloadPath = join(fixBatchBundleDir(FIX_REVIEW, ctx.batch.id), "payload.json");
  writeFileSync(payloadPath, readFileSync(payloadPath, "utf8").replace("line 42", "line 43"));

  const out = await deps.dispatchFixer(ctx);

  assert.equal(out.ok, false);
  assert.equal(calls.length, 0, "the bytes it would have delivered are the bytes it re-hashed");
  assert.match(out.error ?? "", /refusing to start the fixer on an unverified delivery snapshot/);
  assert.equal(out.taskId, "", "a refusal from before the container names no task");
});
