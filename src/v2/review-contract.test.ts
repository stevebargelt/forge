// FG-639: the review contract — validation and the WIDENING ASYMMETRY.
//
// The asymmetry is the property worth testing, and it has three sides: widening with
// recorded evidence is autonomous, narrowing anything is not, and unclassifiable drift
// stops rather than guesses. The fourth test in each group is the one that matters most —
// that changed FILE PATHS, on their own, can never move a lens. Forge deliberately has no
// file-path risk classifier, and a test that only checks the happy widening path would
// pass just as well against an implementation that quietly grew one.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assessContractCoverage,
  confirmContract,
  lensRole,
  validateReviewContract,
  type ReviewContract,
} from "./review-contract.js";

const APPROVED: ReviewContract = {
  threat_model: "operator_trusted_candidate",
  protected_invariants: ["candidate tree equals gated tree", "only Forge publishes the target branch"],
  acceptance_refs: ["FG-639 AC 1", "FG-639 AC 2"],
  risk_lenses: ["wide", "backend"],
  non_goals: ["protect the host from deliberately malicious candidate test code"],
};

test("FG-639: a contract missing a required field is refused, naming what is required", () => {
  const r = validateReviewContract({ threat_model: "x", risk_lenses: ["wide"] });
  assert.equal(r.ok, false);
  assert.match(r.ok ? "" : r.refusal, /protected_invariants/);
  assert.match(r.ok ? "" : r.refusal, /acceptance_refs/);
});

test("FG-639: an unknown risk lens is refused — the vocabulary is fixed, not free text", () => {
  const r = validateReviewContract({ ...APPROVED, risk_lenses: ["wide", "vibes"] });
  assert.equal(r.ok, false);
});

test("FG-639: a contract with no lenses at all is refused", () => {
  const r = validateReviewContract({ ...APPROVED, risk_lenses: [] });
  assert.equal(r.ok, false);
});

test("FG-639: every lens resolves to a red role — the coordinator needs no workflow language", () => {
  assert.equal(lensRole("wide"), "red-wide");
  assert.equal(lensRole("security"), "red-security");
});

test("FG-639: an unchanged contract confirms autonomously against the candidate", () => {
  const c = confirmContract(APPROVED, { candidateSha: "cand1" });
  assert.equal(c.kind, "confirmed");
  if (c.kind !== "confirmed") return;
  assert.equal(c.confirmedSha, "cand1");
  assert.deepEqual(c.addedLenses, []);
});

test("FG-639 / PRD #27: the coordinator MAY add a lens with recorded diff evidence", () => {
  const c = confirmContract(APPROVED, {
    candidateSha: "cand1",
    widening: [{ lens: "security", reason: "the diff added a credential-reading path", diffEvidence: ["src/util/creds.ts"] }],
  });
  assert.equal(c.kind, "confirmed");
  if (c.kind !== "confirmed") return;
  assert.deepEqual(c.addedLenses, ["security"]);
  assert.deepEqual(c.contract.risk_lenses, ["wide", "backend", "security"]);
  assert.equal(c.widening[0]?.reason, "the diff added a credential-reading path");
});

test("FG-639 / PRD #27: adding a lens with NO recorded evidence is refused", () => {
  const c = confirmContract(APPROVED, {
    candidateSha: "cand1",
    contract: { ...APPROVED, risk_lenses: ["wide", "backend", "security"] },
  });
  assert.equal(c.kind, "refused");
  assert.match(c.kind === "refused" ? c.refusal : "", /no recorded diff evidence/);
});

test("FG-639 / PRD #27: a widening claim with an empty reason or empty evidence is refused", () => {
  const noReason = confirmContract(APPROVED, {
    candidateSha: "cand1",
    widening: [{ lens: "security", reason: "  ", diffEvidence: ["src/util/creds.ts"] }],
  });
  assert.equal(noReason.kind, "refused");

  const noEvidence = confirmContract(APPROVED, {
    candidateSha: "cand1",
    widening: [{ lens: "security", reason: "a real reason", diffEvidence: [] }],
  });
  assert.equal(noEvidence.kind, "refused");
});

test("FG-639 / PRD #27: REMOVING a lens returns to the original approving authority", () => {
  const c = confirmContract(APPROVED, {
    candidateSha: "cand1",
    contract: { ...APPROVED, risk_lenses: ["wide"] },
  });
  assert.equal(c.kind, "needs_approving_authority");
  if (c.kind !== "needs_approving_authority") return;
  assert.deepEqual(c.removedLenses, ["backend"]);
  assert.match(c.refusal, /only ADD lenses/);
  assert.match(c.refusal, /Nothing was written/);
});

test("FG-639 / PRD #27: changing the threat model returns to the original approving authority", () => {
  const c = confirmContract(APPROVED, {
    candidateSha: "cand1",
    contract: { ...APPROVED, threat_model: "untrusted_candidate" },
  });
  assert.equal(c.kind, "needs_approving_authority");
  assert.deepEqual(c.kind === "needs_approving_authority" ? c.changedFields : [], ["threat_model"]);
});

test("FG-639: changing protected_invariants, acceptance_refs or non_goals all return to authority", () => {
  for (const patch of [
    { protected_invariants: ["something else"] },
    { acceptance_refs: ["FG-639 AC 1"] },
    { non_goals: [] },
  ]) {
    const c = confirmContract(APPROVED, { candidateSha: "cand1", contract: { ...APPROVED, ...patch } });
    assert.equal(c.kind, "needs_approving_authority", `${JSON.stringify(patch)} must return to authority`);
  }
});

test("FG-639: a removal SMUGGLED IN alongside a well-evidenced addition is still refused", () => {
  const c = confirmContract(APPROVED, {
    candidateSha: "cand1",
    contract: { ...APPROVED, risk_lenses: ["wide", "security"] },
    widening: [{ lens: "security", reason: "credential path", diffEvidence: ["src/util/creds.ts"] }],
  });
  assert.equal(c.kind, "needs_approving_authority");
  assert.deepEqual(c.kind === "needs_approving_authority" ? c.removedLenses : [], ["backend"]);
});

test("FG-639 / PRD #23: unclassifiable drift returns to plan/architecture rather than guessing", () => {
  const c = confirmContract(APPROVED, {
    candidateSha: "cand1",
    unclassifiableDrift: "the diff grew a runtime execution surface with no precedent in the plan",
    changedPaths: ["src/v2/runtime-exec.ts"],
  });
  assert.equal(c.kind, "returns_to_plan");
  assert.match(c.kind === "returns_to_plan" ? c.refusal : "", /does not infer risk lenses from file paths/);
});

test("FG-639 / PRD #23: unclassifiable drift wins over a widening claim in the same proposal", () => {
  const c = confirmContract(APPROVED, {
    candidateSha: "cand1",
    unclassifiableDrift: "cannot classify",
    widening: [{ lens: "security", reason: "r", diffEvidence: ["e"] }],
  });
  assert.equal(c.kind, "returns_to_plan");
});

// THE ANTI-CLASSIFIER TEST. This is what stops a future refactor from adding the
// path-based risk classifier the PRD puts out of scope: frontend- and security-shaped
// paths in the diff must NOT produce a lens on their own.
test("FG-639 / PRD #23: changed file paths ALONE never add a lens — there is no path classifier", () => {
  const c = confirmContract(APPROVED, {
    candidateSha: "cand1",
    changedPaths: [
      "dashboard/src/components/UsageTable.tsx",
      "src/util/creds.ts",
      "src/auth/token-store.ts",
      "docker/Dockerfile",
    ],
  });
  assert.equal(c.kind, "confirmed");
  if (c.kind !== "confirmed") return;
  assert.deepEqual(c.addedLenses, [], "a frontend/security-shaped diff must not silently widen the panel");
  assert.deepEqual(c.contract.risk_lenses, ["wide", "backend"]);
  assert.deepEqual(c.changedPaths, [
    "dashboard/src/components/UsageTable.tsx",
    "src/util/creds.ts",
    "src/auth/token-store.ts",
    "docker/Dockerfile",
  ], "the paths are RECORDED with the confirmation — recorded is not classified");
});

test("FG-639: contract coverage passes when the final candidate is the confirmed sha", () => {
  const r = assessContractCoverage({
    confirmedSha: "a1",
    finalSha: "a1",
    postConfirmationPaths: [],
    deltaReviewed: false,
  });
  assert.equal(r.ok, true);
});

test("FG-639: post-confirmation drift with no bounded delta review fails contract coverage", () => {
  const r = assessContractCoverage({
    confirmedSha: "a1",
    finalSha: "b2",
    postConfirmationPaths: ["src/store/reviews.ts"],
    deltaReviewed: false,
  });
  assert.equal(r.ok, false);
  assert.match(r.detail, /must be reviewed or the contract returned for amendment/);
});

test("FG-639: post-confirmation drift COVERED by the bounded delta review passes", () => {
  const r = assessContractCoverage({
    confirmedSha: "a1",
    finalSha: "b2",
    postConfirmationPaths: ["src/store/reviews.ts"],
    deltaReviewed: true,
  });
  assert.equal(r.ok, true);
});
