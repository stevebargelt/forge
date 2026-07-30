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
  resolveReviewBase,
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
import { ensureFixBatch, renderFixBatchEnvelope, serializeFixBatchPayload } from "../../store/fix-batches.js";
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
    "the envelope rides along naming the batch identity the fixer's result is validated against",
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

// FG-639 F3: the bundle rides /task, which the agent can write. The prompt must not sell
// those copies as a tamper-proof record — what actually holds is that the HOST's batch is
// authoritative and the result is validated against it either way.
test("FG-639: the fixer prompt claims no tamper-evidence and names the host record as authoritative", async () => {
  const ctx = parkAtFix();
  const { invokeFn, calls } = capturingInvoke();
  const deps = fixerDeps(invokeFn);

  await deps.materializeFixBatch(ctx);
  await deps.dispatchFixer(ctx);

  const task = calls[0]?.task ?? "";
  assert.match(task, /AUTHORITATIVE handoff is the batch the HOST has persisted/);
  assert.match(task, /not a tamper-proof\s+record/);
  assert.match(task, /validated against the[\s\S]*host's expected finding set/);
  assert.doesNotMatch(task, /sha256sum/, "inviting re-verification implies the copies are evidence of something");
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

// FG-639 F2: the envelope is not trusted from disk either. It carries the batch identity the
// fixer reports back under, so an envelope rewritten after materialization would point a real
// fixer at a revision the host will not validate its result against. Verified byte-for-byte
// against a rendering re-derived from the row.
const ENVELOPE_TAMPERS: { label: string; from: string | RegExp; to: string }[] = [
  { label: "the revision", from: `"revision": 1`, to: `"revision": 2` },
  { label: "the payload hash", from: /"payload_sha256": "[0-9a-f]+"/, to: `"payload_sha256": "${"0".repeat(64)}"` },
  { label: "the batch id", from: /"fix_batch_id": "[^"]+"/, to: `"fix_batch_id": "fb-somebody-elses"` },
];

for (const tamper of ENVELOPE_TAMPERS) {
  test(`FG-639: an envelope with ${tamper.label} rewritten on disk refuses BEFORE the container starts`, async () => {
    const ctx = parkAtFix();
    const { invokeFn, calls } = capturingInvoke();
    const deps = fixerDeps(invokeFn);

    await deps.materializeFixBatch(ctx);
    const envelopePath = join(fixBatchBundleDir(FIX_REVIEW, ctx.batch.id), "envelope.json");
    const rewritten = readFileSync(envelopePath, "utf8").replace(tamper.from, tamper.to);
    assert.notEqual(rewritten, readFileSync(envelopePath, "utf8"), "the tamper must actually change the bytes");
    writeFileSync(envelopePath, rewritten);

    const out = await deps.dispatchFixer(ctx);

    assert.equal(out.ok, false);
    assert.equal(calls.length, 0, "no container starts on an envelope the store does not vouch for");
    assert.match(out.error ?? "", /the materialized envelope does not match the persisted batch/);
    assert.equal(out.taskId, "", "a refusal from before the container names no task");
  });
}

test("FG-639: the untampered envelope the wiring delivers IS the row-derived rendering", async () => {
  const ctx = parkAtFix();
  const { invokeFn, calls } = capturingInvoke();
  const deps = fixerDeps(invokeFn);

  await deps.materializeFixBatch(ctx);
  const out = await deps.dispatchFixer(ctx);

  assert.equal(out.ok, true);
  assert.equal(
    calls[0]?.taskFiles?.["fix-batch/envelope.json"],
    renderFixBatchEnvelope(ctx.batch),
    "one rendering for delivery and verification — two would drift while both looked verified",
  );
});

// ─── FG-649: the fix cycle's COMMIT, which the coordinator now owns ─────────
//
// The live FG-649 loop: the orchestrator committed the fixer's output AFTER the coordinator
// process exited, so Stage 5's `headSha()` read was a guaranteed no-op, the fix stage recorded
// the PRE-fix candidate, and the rechecker was handed a tree without the fixes it was
// rechecking — it honestly reported still_present forever. The commit is the coordinator's now,
// which makes the post-fix sha one forge CREATED. These pin the scope guard and the refusals;
// the end-to-end evidence against a real repository is
// src/v2/fg649-fix-cycle-candidate.integration.test.ts.

/** A git seam that records every invocation and answers `status`/`rev-parse` from a script.
 *
 *  `rev-parse` answers the CANDIDATE until a commit lands and the new head after — the two reads
 *  commitFixCycle makes are about different moments, and collapsing them into one answer would
 *  hide whichever of them was wrong. */
function scriptedGit(script: { status?: string; preHead?: string; head?: string; failOn?: string }) {
  const calls: string[][] = [];
  let committed = false;
  const git = (args: string[]): string => {
    calls.push(args);
    if (script.failOn !== undefined && args[0] === script.failOn) {
      throw new Error(`git ${args[0]} exited 1: nothing to commit`);
    }
    if (args[0] === "commit") committed = true;
    if (args[0] === "status") return script.status ?? "";
    if (args[0] === "rev-parse") return `${committed ? (script.head ?? "postfix9") : (script.preHead ?? "cand111")}\n`;
    return "";
  };
  return { git, calls };
}

function commitDeps(git: (args: string[]) => string): CoordinatorDeps {
  return buildCoordinatorDeps({ projectDir: "/nonexistent-project", ticketId: "FG-639", git, invokeFn: async () => {
    throw new Error("a fix-cycle commit dispatches no container");
  } });
}

function commitCtx(declaredFiles: string[]) {
  const fixCtx = parkAtFix();
  return { review: fixCtx.review, batch: fixCtx.batch, results: [], declaredFiles };
}

test("FG-649: the fix-cycle commit stages ONLY the declared paths and names the batch, never the ticket", async () => {
  // RED baseline: there is no commitFixCycle dep before this change — Stage 5 read
  // deps.headSha() (review-run.ts:470) and committed nothing.
  const { git, calls } = scriptedGit({
    status: "M  src/a.ts\0?? src/a.test.ts\0",
    head: "committed7",
  });
  const commit = await commitDeps(git).commitFixCycle(commitCtx(["src/a.ts", "src/a.test.ts"]));

  assert.equal(commit.kind, "committed");
  assert.equal(commit.kind === "committed" ? commit.sha : "", "committed7", "the sha the commit CREATED");
  const add = calls.find((c) => c[0] === "add");
  assert.deepEqual(add, ["add", "--", ":/src/a.ts", ":/src/a.test.ts"], "never `git add -A`, and root-relative");
  const message = calls.find((c) => c[0] === "commit")?.[2] ?? "";
  assert.match(message, /^fix\(review\): fix batch .+ revision 1$/);
  // THE SUBJECT IS AN INTERFACE: resolveCommitRange infers a later review's base from the
  // OLDEST commit whose subject references the ticket. A ticket id here would make a later
  // review's base its own remediation commit, and a review with no usable base can never
  // confirm its contract.
  assert.doesNotMatch(message, /FG-639/, "the subject must not reference the ticket");
});

test("FG-649: a tree that moved OUTSIDE the declared set is named, never swept into the commit", async () => {
  const { git, calls } = scriptedGit({ status: "M  src/a.ts\0 M docs/unrelated.md\0" });
  const commit = await commitDeps(git).commitFixCycle(commitCtx(["src/a.ts"]));

  assert.equal(commit.kind, "refused");
  assert.equal(commit.kind === "refused" ? commit.reason : "", "fix_cycle_tree_dirty_outside_declared_scope");
  assert.match(commit.kind === "refused" ? commit.detail : "", /docs\/unrelated\.md/);
  assert.equal(calls.some((c) => c[0] === "add" || c[0] === "commit"), false, "nothing was staged or committed");
});

test("FG-649: results that declare files against a CLEAN tree refuse — the fixer's claim contradicts the tree", async () => {
  const { git, calls } = scriptedGit({ status: "" });
  const commit = await commitDeps(git).commitFixCycle(commitCtx(["src/a.ts"]));

  assert.equal(commit.kind, "refused");
  assert.equal(commit.kind === "refused" ? commit.reason : "", "fix_cycle_declared_changes_absent");
  assert.equal(calls.some((c) => c[0] === "commit"), false);
});

test("FG-649: a cycle that declares NOTHING against a clean tree is a legitimate no_change", async () => {
  const { git, calls } = scriptedGit({ status: "" });
  const commit = await commitDeps(git).commitFixCycle(commitCtx([]));

  assert.equal(commit.kind, "no_change");
  assert.equal(commit.kind === "no_change" ? commit.sha : "", "cand111", "the candidate legitimately does not move");
  assert.equal(calls.some((c) => c[0] === "commit"), false);
});

test("FG-649: a git commit that fails is a NAMED refusal, not a thrown stack trace", async () => {
  const { git } = scriptedGit({ status: "M  src/a.ts\0", failOn: "commit" });
  const commit = await commitDeps(git).commitFixCycle(commitCtx(["src/a.ts"]));

  assert.equal(commit.kind, "refused");
  assert.equal(commit.kind === "refused" ? commit.reason : "", "fix_cycle_commit_failed");
  assert.match(commit.kind === "refused" ? commit.detail : "", /nothing to commit/);
});

test("FG-649: a head that is NOT the candidate refuses BEFORE anything is staged", async () => {
  // The fix cycle is a WRITE now, so the HEAD-vs-candidate comparison has to be made again at
  // the moment of the write: a commit authored on a foreign head would give the review a
  // candidate whose parent is not the tree it reviewed, and mis-anchor the whole ledger
  // silently instead of stopping. Same name as the verify-stage refusal, on purpose.
  const { git, calls } = scriptedGit({ status: "M  src/a.ts\0", preHead: "somebodyelse4" });
  const commit = await commitDeps(git).commitFixCycle(commitCtx(["src/a.ts"]));

  assert.equal(commit.kind, "refused");
  assert.equal(commit.kind === "refused" ? commit.reason : "", "candidate_not_checked_out");
  assert.match(commit.kind === "refused" ? commit.detail : "", /is on somebodyelse4, not the candidate cand111/);
  assert.equal(calls.some((c) => c[0] === "add" || c[0] === "commit"), false, "nothing was staged or committed");
});

test("FG-649: the porcelain reader survives a path with a space and stages both halves of a rename", async () => {
  // -z, so no C-quoting to un-quote: a scope guard that mis-parses a path is a scope guard that
  // commits the wrong file. A rename reports its ORIGINAL path in the next field, and staging
  // the new name without it would leave the deletion uncommitted.
  const { git, calls } = scriptedGit({ status: "M  src/a file.ts\0R  src/new.ts\0src/old.ts\0" });
  const commit = await commitDeps(git).commitFixCycle(commitCtx(["src/a file.ts", "src/new.ts", "src/old.ts"]));

  assert.equal(commit.kind, "committed", commit.kind === "refused" ? commit.detail : "");
  assert.deepEqual(calls.find((c) => c[0] === "add"), [
    "add",
    "--",
    ":/src/a file.ts",
    ":/src/new.ts",
    ":/src/old.ts",
  ]);
});

// ─── the comparison base, resolved AT OPEN ──────────────────────────────────
//
// Stage 2 refuses a review that records no base sha, and no verb supplies one afterwards or
// removes the row — so a review opened without a base was permanently stuck at contract
// confirmation. These pin the resolution that moved to open time: --since names the base,
// otherwise it is inferred from the ticket's landed range, and when neither can produce one
// the refusal happens BEFORE the row exists.

/** A git that answers only what resolveReviewBase asks: the subject log, the span count, and
 *  rev-parse for the revisions the fixture says exist.
 *
 *  IT MODELS REAL GIT'S PERMISSIVENESS ON PURPOSE. Bare `rev-parse <40-hex>` echoes the sha
 *  back with exit 0 without consulting the object store — demonstrated in a real repo — while
 *  `rev-parse --verify <rev>^{commit}` consults it and fails for a non-commit. A fake that
 *  simply threw for every unknown rev is what let the missing commit-ness check ship. */
function logGit(commits: Array<[string, string]>, resolvable: Record<string, string>) {
  return (args: string[]): string => {
    if (args[0] === "log" && args[1] === "--format=%H %s") {
      return commits.map(([sha, subject]) => `${sha} ${subject}`).join("\n");
    }
    if (args[0] === "log" && args[1] === "--format=%H") {
      return commits.map(([sha]) => sha).join("\n");
    }
    if (args[0] === "rev-parse") {
      const verify = args[1] === "--verify";
      const rev = (verify ? args[2] : args[1]) as string;
      const bare = rev.replace(/\^\{commit\}$/, "");
      const sha = resolvable[bare];
      if (sha !== undefined) return `${sha}\n`;
      if (!verify && /^[0-9a-f]{40}$/.test(bare)) return `${bare}\n`;
      throw new Error(`fatal: Needed a single revision`);
    }
    throw new Error(`unexpected git ${args.join(" ")}`);
  };
}

test("FG-639: with no --since the base is INFERRED from the oldest commit referencing the ticket", () => {
  const base = resolveReviewBase({
    projectDir: "/repo",
    ticketId: "FG-700",
    git: logGit(
      [
        ["cccccccccccccccccccccccccccccccccccccccc", "FG-700: the second half"],
        ["bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "FG-700: the first half"],
      ],
      { "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb^": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
    ),
  });

  assert.equal(base.ok, true, base.ok ? "" : base.refusal);
  if (!base.ok) return;
  assert.equal(base.baseSha, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "the parent of the oldest ticket commit");
  assert.equal(base.inferredFrom, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
  assert.equal(base.spansUnmatched, false);
});

test("FG-639: an inferred range that spans unrelated commits is reported, not hidden", () => {
  const base = resolveReviewBase({
    projectDir: "/repo",
    ticketId: "FG-700",
    git: logGit(
      [
        ["cccccccccccccccccccccccccccccccccccccccc", "FG-700: the second half"],
        ["dddddddddddddddddddddddddddddddddddddddd", "chore: an unrelated commit in between"],
        ["bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "FG-700: the first half"],
      ],
      { "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb^": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
    ),
  });

  assert.equal(base.ok, true, base.ok ? "" : base.refusal);
  assert.equal(base.ok ? base.spansUnmatched : undefined, true, "the confirmation diff will include them");
});

test("FG-639: NO commit referencing the ticket refuses AT OPEN, naming --since", () => {
  const base = resolveReviewBase({
    projectDir: "/repo",
    ticketId: "FG-700",
    git: logGit([["cccccccccccccccccccccccccccccccccccccccc", "chore: something else"]], {}),
  });

  assert.equal(base.ok, false, "a review that cannot name its base must never be opened");
  if (base.ok) return;
  assert.match(base.refusal, /no commit subject in \/repo references FG-700/);
  assert.match(base.refusal, /--since <sha>/);
  assert.match(base.refusal, /Nothing was written/);
});

test("FG-639: a ticket range starting at a ROOT commit refuses rather than opening unusably", () => {
  const base = resolveReviewBase({
    projectDir: "/repo",
    ticketId: "FG-700",
    // No `<oldest>^` in the resolvable set — the oldest ticket commit is the root.
    git: logGit([["bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "FG-700: the whole thing"]], {}),
  });

  assert.equal(base.ok, false);
  assert.match(base.ok ? "" : base.refusal, /has no parent/);
  assert.match(base.ok ? "" : base.refusal, /--since <sha>/);
});

test("FG-639: an unreadable git log refuses AT OPEN instead of leaving a stuck review behind", () => {
  const base = resolveReviewBase({
    projectDir: "/not-a-repo",
    ticketId: "FG-700",
    git: () => {
      throw new Error("fatal: not a git repository");
    },
  });

  assert.equal(base.ok, false);
  assert.match(base.ok ? "" : base.refusal, /could not be read \(fatal: not a git repository\)/);
  assert.match(base.ok ? "" : base.refusal, /--since <sha>/);
});

test("FG-639: --since is RESOLVED to a full sha, and an unresolvable one is refused", () => {
  const git = logGit([], { "v1.2.0": "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" });
  const named = resolveReviewBase({ projectDir: "/repo", ticketId: "FG-700", since: "v1.2.0", git });
  assert.equal(named.ok, true, named.ok ? "" : named.refusal);
  assert.equal(named.ok ? named.baseSha : "", "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", "a tag is stored as its sha");
  assert.equal(named.ok ? named.inferredFrom : "unset", undefined, "an explicitly named base is not an inference");

  const bogus = resolveReviewBase({ projectDir: "/repo", ticketId: "FG-700", since: "nope", git });
  assert.equal(bogus.ok, false);
  assert.match(bogus.ok ? "" : bogus.refusal, /--since nope does not name a commit/);
});

// RF-7: the second input into the permanently-stuck review class RF-2 closed. `git rev-parse
// <40-hex>` echoes any 40-hex string back with exit 0 without consulting the object store, so
// a sha rebased away, gc'd, or pasted from another repo passed the --since branch, the row was
// inserted with it, and Stage 2's `git diff --name-only <base>..<candidate>` then threw a raw
// stack trace out of execFileSync — with no verb to supply a base afterwards and none to
// remove the review.
//
// RED baseline: revert revParseCommit to bare `["rev-parse", rev]` and this test fails,
// because logGit models git's echo exactly.
test("FG-639 / RF-7: a 40-hex --since that is NOT a commit in this repo is refused AT OPEN, not echoed through", () => {
  const git = logGit([["cccccccccccccccccccccccccccccccccccccccc", "FG-700: landed"]], {
    "cccccccccccccccccccccccccccccccccccccccc": "cccccccccccccccccccccccccccccccccccccccc",
  });
  const gone = "0000000000000000000000000000000000000000";

  assert.equal(git(["rev-parse", gone]).trim(), gone, "the fake echoes bare rev-parse, exactly as real git does");

  const base = resolveReviewBase({ projectDir: "/repo", ticketId: "FG-700", since: gone, git });
  assert.equal(base.ok, false, "a base that no diff can name must never reach the insert");
  if (base.ok) return;
  assert.match(base.refusal, /--since 0{40} does not name a commit in \/repo/);
  assert.match(base.refusal, /Nothing was written/);
});

test("FG-639 / RF-7: commit-ness is required of the INFERRED parent too, not just of --since", () => {
  // The oldest ticket commit's parent resolves as an object but is not a commit — a tag or a
  // tree. Inferring it would open the same stuck review by the other door.
  const git = (args: string[]): string => {
    if (args[0] === "log") {
      return args[1] === "--format=%H %s"
        ? "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb FG-700: the whole thing"
        : "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    }
    if (args[0] === "rev-parse" && args[1] === "--verify") {
      throw new Error("fatal: Needed a single revision");
    }
    if (args[0] === "rev-parse") return "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n";
    throw new Error(`unexpected git ${args.join(" ")}`);
  };

  const base = resolveReviewBase({ projectDir: "/repo", ticketId: "FG-700", git });
  assert.equal(base.ok, false);
  assert.match(base.ok ? "" : base.refusal, /has no parent/);
  assert.match(base.ok ? "" : base.refusal, /--since <sha>/);
});

test("FG-639 / RF-7: the commit-ness idiom is the one real git honors — `rev-parse --verify <rev>^{commit}`", () => {
  const asked: string[][] = [];
  const git = (args: string[]): string => {
    asked.push(args);
    if (args[0] === "rev-parse") return "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee\n";
    throw new Error(`unexpected git ${args.join(" ")}`);
  };

  const base = resolveReviewBase({ projectDir: "/repo", ticketId: "FG-700", since: "v1.2.0", git });
  assert.equal(base.ok, true, base.ok ? "" : base.refusal);
  assert.deepEqual(
    asked[0],
    ["rev-parse", "--verify", "v1.2.0^{commit}"],
    "bare rev-parse consults no object store; --verify <rev>^{commit} does, and requires a commit",
  );
});
