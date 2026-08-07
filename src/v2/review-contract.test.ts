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
  SCOPELESS_CONTRACT_REFUSAL_KIND,
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
  lens_scopes: { wide: ["src/"], backend: ["src/store/"] },
};

/** FG-689: the scopes a proposal must carry to name one more lens. Spelled here rather than
 *  inlined because every widening fixture below needs it, and because a proposal that adds a
 *  lens without a scope is a DIFFERENT refusal — the tests that mean "no evidence" or
 *  "removal smuggled in" have to reach those arms, not trip over a scope-mismatch first. */
const WITH_SECURITY_SCOPE = { ...APPROVED.lens_scopes, security: ["src/util/creds.ts"] };

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
    widening: [
      {
        lens: "security",
        reason: "the diff added a credential-reading path",
        diffEvidence: ["src/util/creds.ts"],
        scopePaths: ["src/util/creds.ts"],
      },
    ],
  });
  assert.equal(c.kind, "confirmed");
  if (c.kind !== "confirmed") return;
  assert.deepEqual(c.addedLenses, ["security"]);
  assert.deepEqual(c.contract.risk_lenses, ["wide", "backend", "security"]);
  assert.equal(c.widening[0]?.reason, "the diff added a credential-reading path");
  assert.deepEqual(
    c.contract.lens_scopes.security,
    ["src/util/creds.ts"],
    "FG-689: the widened contract carries the added lens's scope, so it can be read back",
  );
});

// FG-689. The widening-only shape exists so the common case never restates the whole
// contract — but "add security" without saying what security owns produces a contract
// `validateReviewContract` will not accept, which would make the confirmation unreadable
// one stage later. Refuse it here, where the claim is made.
test("FG-689: a widening that names no scope for the added lens is refused BY NAME", () => {
  const c = confirmContract(APPROVED, {
    candidateSha: "cand1",
    widening: [{ lens: "security", reason: "a credential path appeared", diffEvidence: ["src/util/creds.ts"] }],
  });
  assert.equal(c.kind, "refused");
  assert.match(c.kind === "refused" ? c.refusal : "", /names no scope paths/);
  assert.match(c.kind === "refused" ? c.refusal : "", /Nothing was written/);
});

test("FG-639 / PRD #27: adding a lens with NO recorded evidence is refused", () => {
  const c = confirmContract(APPROVED, {
    candidateSha: "cand1",
    contract: { ...APPROVED, risk_lenses: ["wide", "backend", "security"], lens_scopes: WITH_SECURITY_SCOPE },
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
    contract: { ...APPROVED, risk_lenses: ["wide"], lens_scopes: { wide: APPROVED.lens_scopes.wide } },
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
    contract: {
      ...APPROVED,
      risk_lenses: ["wide", "security"],
      lens_scopes: { wide: APPROVED.lens_scopes.wide, security: ["src/util/creds.ts"] },
    },
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

// ---------------------------------------------------------------------------
// FG-689: authored lens-to-path scopes.
// ---------------------------------------------------------------------------

// D2. The field is required, which invalidates every contract approved before it existed —
// including FG-591's own. That is the right fail-closed direction, but an operator holding a
// contract that was valid yesterday did nothing wrong, and "invalid input" does not tell them
// what to do. The refusal has to name the skew and state the remedy.
test("FG-689 / D2: a contract that PREDATES lens_scopes is refused BY NAME, with its remedy", () => {
  const scopeless = {
    threat_model: APPROVED.threat_model,
    protected_invariants: APPROVED.protected_invariants,
    acceptance_refs: APPROVED.acceptance_refs,
    risk_lenses: APPROVED.risk_lenses,
    non_goals: APPROVED.non_goals,
  };
  const r = validateReviewContract(scopeless);
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.refusalKind, SCOPELESS_CONTRACT_REFUSAL_KIND);
  assert.match(r.refusal, /PREDATES LENS SCOPES/);
  assert.match(r.refusal, /re-approved by its approving authority/);
  assert.match(r.refusal, /wide, backend/, "the refusal names the lenses that still need a scope");
  assert.doesNotMatch(r.refusal, /review contract invalid/, "the D2 skew is not the generic parse refusal");
});

test("FG-689 / D2: the version-skew refusal is DISTINGUISHABLE from the generic parse refusal", () => {
  const skew = validateReviewContract({
    threat_model: APPROVED.threat_model,
    protected_invariants: APPROVED.protected_invariants,
    acceptance_refs: APPROVED.acceptance_refs,
    risk_lenses: APPROVED.risk_lenses,
    non_goals: APPROVED.non_goals,
  });
  const malformed = validateReviewContract({ threat_model: "x", risk_lenses: ["wide"] });
  assert.equal(skew.ok, false);
  assert.equal(malformed.ok, false);
  if (skew.ok || malformed.ok) return;
  assert.equal(malformed.refusalKind, "contract_invalid");
  assert.notEqual(skew.refusalKind, malformed.refusalKind);
  assert.notEqual(skew.refusal, malformed.refusal);
});

// A contract missing lens_scopes AND otherwise malformed is malformed — the skew arm must
// not swallow a genuinely broken contract and tell the operator to go get it re-approved.
test("FG-689 / D2: a scopeless contract that is ALSO malformed gets the generic parse refusal", () => {
  const r = validateReviewContract({ threat_model: "x", risk_lenses: ["wide"] });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.refusalKind, "contract_invalid");
  assert.match(r.refusal, /protected_invariants/);
});

test("FG-689: a selected lens with NO scope entry is refused by name", () => {
  const r = validateReviewContract({
    ...APPROVED,
    risk_lenses: ["backend", "security"],
    lens_scopes: { backend: ["src/store/"] },
  });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.refusalKind, "lens_scope_mismatch");
  assert.match(r.refusal, /security/);
  assert.match(r.refusal, /no lens_scopes entry/);
});

test("FG-689: a scope for a lens the contract does NOT select is refused by name", () => {
  const r = validateReviewContract({
    ...APPROVED,
    risk_lenses: ["backend", "security"],
    lens_scopes: { backend: ["src/store/"], security: ["src/util/creds.ts"], frontend: ["dashboard/"] },
  });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.refusalKind, "lens_scope_mismatch");
  assert.match(r.refusal, /frontend/);
  assert.match(r.refusal, /does not select/);
});

test("FG-689: scope patterns dedupe and SORT per lens — the same authored set has one identity", () => {
  const r = validateReviewContract({
    ...APPROVED,
    risk_lenses: ["wide"],
    lens_scopes: { wide: ["src/store/", "src/v2/", "src/store/", "docs/"] },
  });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(r.contract.lens_scopes.wide, ["docs/", "src/store/", "src/v2/"]);
});

// D5. An exclusion list is a path classifier by another name, so the pattern grammar has no
// way to spell one. This is the anti-classifier lock for scopes, matching the one below for
// lenses: a future refactor that adds `!generated/` has to delete this test to do it.
test("FG-689 / D5: a scope pattern has NO negation form and no exclusion syntax", () => {
  const r = validateReviewContract({
    ...APPROVED,
    risk_lenses: ["wide"],
    lens_scopes: { wide: ["src/", "!src/generated/"] },
  });
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.refusalKind, "contract_invalid");
  assert.match(r.refusal, /negation/);
});

test("FG-689: a scope pattern is repo-relative — absolute paths and `..` escapes are refused", () => {
  for (const bad of ["/etc/passwd", "../outside/", "src/../../elsewhere"]) {
    const r = validateReviewContract({ ...APPROVED, risk_lenses: ["wide"], lens_scopes: { wide: [bad] } });
    assert.equal(r.ok, false, `${bad} must be refused`);
  }
});

test("FG-689: a lens with an EMPTY scope list is refused — a scope entry names at least one path", () => {
  const r = validateReviewContract({ ...APPROVED, risk_lenses: ["wide"], lens_scopes: { wide: [] } });
  assert.equal(r.ok, false);
});

// The scopes counterpart of the anti-classifier test below: validation must return exactly
// what was authored. Nothing in this module reads a diff, so there is no path by which a
// filename could produce, extend or reorder an ownership claim.
test("FG-689: scopes come back AS AUTHORED — validation never derives one from a filename", () => {
  const r = validateReviewContract({
    ...APPROVED,
    risk_lenses: ["wide", "security"],
    lens_scopes: { wide: ["src/v2/"], security: ["src/util/creds.ts"] },
  });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(
    r.contract.lens_scopes.frontend,
    undefined,
    "a dashboard-shaped path in some diff cannot conjure a frontend scope — this module never sees a diff",
  );
  assert.deepEqual(r.contract.lens_scopes, { wide: ["src/v2/"], security: ["src/util/creds.ts"] });
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
