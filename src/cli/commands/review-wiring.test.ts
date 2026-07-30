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

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCoordinatorDeps } from "./review-wiring.js";
import { confirmContract, validateReviewContract, type ReviewContract } from "../../v2/review-contract.js";
import type { Review } from "../../store/reviews.js";

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
