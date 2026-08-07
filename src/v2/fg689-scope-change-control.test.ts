// FG-689 D3 / D13: `lens_scopes` IS CHANGE-CONTROLLED, PER SCOPE.
//
// The field arrived in step 1 as data. This suite is about the authority boundary around it,
// and the reason that boundary needs its own shape is that neither existing mechanism fits.
// A boundary field refuses every change. `risk_lenses` permits addition with evidence and
// refuses removal, at whole-list granularity. Scopes need BOTH directions at once and PER
// LENS: security may gain a path in the same proposal where backend loses one, and a rule
// that answers per contract cannot say that.
//
// WHY IT MATTERS MORE THAN IT LOOKS. Narrowing a lens's scope to nothing removes that lens
// without ever touching `risk_lenses` — the lens stays selected, owns no path, and lands in
// FG-689's intentionally-skipped state, which is a legitimate outcome forge records and the
// gate accepts. That would make the skip a self-service route around the rule that removing a
// lens returns to the plan gate: the same end state, reached by an unwatched door. Every test
// below that refuses a narrowing is holding that door shut.
//
// The other half is the ANTI-OMISSION property. What this replaced was a hardcoded four-name
// `BOUNDARY_FIELDS` literal that nothing checked against the schema. `lens_scopes` was not in
// it, nothing else compared the field, and so the coordinator could rewrite scopes silently —
// not because anyone decided it could, but because a field is change-controlled here only by
// being remembered. Omission meant "compare it against nothing", which is fail-open. The
// classification map is exhaustive over the schema's own shape so that the next field cannot
// arrive the same way.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CONTRACT_FIELD_CHANGE_CONTROL,
  ReviewContractSchema,
  confirmContract,
  validateReviewContract,
  type ReviewContract,
} from "./review-contract.js";

const APPROVED: ReviewContract = {
  threat_model: "operator_trusted_candidate",
  protected_invariants: ["the gate reads what the reviewer read"],
  acceptance_refs: ["FG-689 AC1", "FG-689 AC2"],
  risk_lenses: ["wide", "security"],
  non_goals: ["a path classifier of any kind"],
  lens_scopes: {
    wide: ["src/v2/", "src/cli/"],
    security: ["src/store/reviews.ts", "src/v2/review-contract.ts"],
  },
};

/** Propose an explicit contract identical to the approved one except for its scopes. */
function withScopes(lens_scopes: ReviewContract["lens_scopes"]) {
  return { candidateSha: "cand1", contract: { ...APPROVED, lens_scopes } };
}

// ─── the classification map ──────────────────────────────────────────────────

test("FG-689 / D13: every contract field is classified — the map is exhaustive over the schema", () => {
  const schemaFields = Object.keys(ReviewContractSchema.shape).sort();
  const classified = Object.keys(CONTRACT_FIELD_CHANGE_CONTROL).sort();
  assert.deepEqual(
    classified,
    schemaFields,
    "a contract field with no change-control class is change-controlled by nothing — the omission that let " +
      "lens_scopes be silently rewritable in the first place",
  );
});

test("FG-689 / D13: each field's class is the one its rule actually is", () => {
  assert.deepEqual(CONTRACT_FIELD_CHANGE_CONTROL, {
    threat_model: "boundary",
    protected_invariants: "boundary",
    acceptance_refs: "boundary",
    non_goals: "boundary",
    risk_lenses: "lens_list",
    lens_scopes: "lens_scopes",
  });
});

// ─── NARROWING returns to the approving authority ────────────────────────────

test("FG-689 / D3: removing ONE pattern from ONE lens's scope returns to the approving authority", () => {
  const c = confirmContract(
    APPROVED,
    withScopes({ ...APPROVED.lens_scopes, security: ["src/store/reviews.ts"] }),
  );

  assert.equal(c.kind, "needs_approving_authority");
  if (c.kind !== "needs_approving_authority") return;
  assert.deepEqual(c.narrowedScopes, [{ lens: "security", removedPatterns: ["src/v2/review-contract.ts"] }]);
  assert.match(c.refusal, /NARROWS the authored scope of security/, "the refusal names the lens");
  assert.match(c.refusal, /src\/v2\/review-contract\.ts/, "and the pattern it would have lost");
  assert.match(c.refusal, /Nothing was written/);
  assert.deepEqual(c.changedFields, [], "a scope narrowing is not a boundary-field change");
  assert.deepEqual(c.removedLenses, [], "and it is not a lens removal either — it is its own class");
});

// The load-bearing one. `risk_lenses` is untouched, so every check that watches the lens list
// sees a contract that removes nothing; the lens survives owning no path at all.
test("FG-689 / D3: narrowing a scope to a SINGLE removal is caught even with risk_lenses untouched", () => {
  const c = confirmContract(APPROVED, withScopes({ ...APPROVED.lens_scopes, wide: ["src/v2/"] }));
  assert.equal(c.kind, "needs_approving_authority");
  if (c.kind !== "needs_approving_authority") return;
  assert.deepEqual(c.removedLenses, [], "the lens list is unchanged — this must not be reachable through it");
  assert.deepEqual(c.narrowedScopes, [{ lens: "wide", removedPatterns: ["src/cli/"] }]);
  assert.match(c.refusal, /removes that lens without saying so/);
});

test("FG-689 / D3: a scope narrowed to nothing is a lens removal by another route, and refuses", () => {
  // The proposal keeps `security` selected and takes every path away from it. It cannot even
  // be spelled as a valid contract — a selected lens with no scope is refused BY NAME one
  // layer down — so the route is closed at both ends. What matters is that neither end
  // CONFIRMS: an unowned lens must never reach discovery as an intentional skip.
  const emptied = confirmContract(APPROVED, withScopes({ ...APPROVED.lens_scopes, security: [] }));
  assert.equal(emptied.kind, "refused");
  assert.match(emptied.kind === "refused" ? emptied.refusal : "", /review contract invalid/);

  const dropped = confirmContract(
    APPROVED,
    withScopes({ wide: APPROVED.lens_scopes.wide } as ReviewContract["lens_scopes"]),
  );
  assert.equal(dropped.kind, "refused", "dropping a selected lens's whole entry is not an ordinary confirmation");
  assert.match(dropped.kind === "refused" ? dropped.refusal : "", /no lens_scopes entry/);
});

test("FG-689 / D3: dropping a lens AND its scope together is the lens removal it already was", () => {
  const c = confirmContract(APPROVED, {
    candidateSha: "cand1",
    contract: { ...APPROVED, risk_lenses: ["wide"], lens_scopes: { wide: APPROVED.lens_scopes.wide } },
  });
  assert.equal(c.kind, "needs_approving_authority");
  if (c.kind !== "needs_approving_authority") return;
  assert.deepEqual(c.removedLenses, ["security"]);
  assert.deepEqual(
    c.narrowedScopes,
    [],
    "the scope going with the lens says nothing extra — reporting it twice would read as two separate weakenings",
  );
});

test("FG-689 / D3: a narrowing SMUGGLED IN alongside a well-evidenced widening is still refused", () => {
  const c = confirmContract(APPROVED, {
    candidateSha: "cand1",
    contract: {
      ...APPROVED,
      lens_scopes: {
        wide: ["src/v2/", "src/cli/", "src/store/"],
        security: ["src/store/reviews.ts"],
      },
    },
    widening: [
      {
        lens: "wide",
        reason: "the diff grew a store write path the wide lens should read",
        diffEvidence: ["src/store/reviews.ts"],
        scopePaths: ["src/store/"],
      },
    ],
  });

  assert.equal(c.kind, "needs_approving_authority", "the evidenced half must not carry the unevidenced half past");
  if (c.kind !== "needs_approving_authority") return;
  assert.deepEqual(c.narrowedScopes, [{ lens: "security", removedPatterns: ["src/v2/review-contract.ts"] }]);
});

// ─── WIDENING is autonomous, WITH recorded evidence ──────────────────────────

test("FG-689 / D3: adding a pattern with a recorded reason and diff evidence CONFIRMS", () => {
  const c = confirmContract(APPROVED, {
    candidateSha: "cand1",
    contract: {
      ...APPROVED,
      lens_scopes: { ...APPROVED.lens_scopes, security: [...APPROVED.lens_scopes.security!, "src/util/creds.ts"] },
    },
    widening: [
      {
        lens: "security",
        reason: "the final diff added a credential-reading path inside security's surface",
        diffEvidence: ["src/util/creds.ts (new file)"],
        scopePaths: ["src/util/creds.ts"],
      },
    ],
  });

  assert.equal(c.kind, "confirmed", c.kind === "confirmed" ? "" : c.refusal);
  if (c.kind !== "confirmed") return;
  assert.deepEqual(
    c.widenedScopes,
    [{ lens: "security", addedPatterns: ["src/util/creds.ts"] }],
    "the added patterns are RECORDED with the confirmation — a broadening nobody can read back is unrecorded",
  );
  assert.deepEqual(c.addedLenses, [], "widening a scope is not adding a lens");
  assert.ok(c.contract.lens_scopes.security?.includes("src/util/creds.ts"));
});

test("FG-689 / D3: the SAME addition with no recorded evidence is refused for being unevidenced", () => {
  const c = confirmContract(
    APPROVED,
    withScopes({ ...APPROVED.lens_scopes, security: [...APPROVED.lens_scopes.security!, "src/util/creds.ts"] }),
  );

  assert.equal(c.kind, "refused");
  if (c.kind !== "refused") return;
  assert.match(c.refusal, /no recorded diff evidence/);
  assert.match(c.refusal, /security/, "the refusal names the lens whose scope grew");
  assert.match(c.refusal, /src\/util\/creds\.ts/, "and the pattern that arrived unclaimed");
  assert.match(c.refusal, /Nothing was written/);
});

test("FG-689 / D3: a widening claim with an empty reason or empty evidence is refused for scopes too", () => {
  const grown = { ...APPROVED.lens_scopes, security: [...APPROVED.lens_scopes.security!, "src/util/creds.ts"] };
  for (const claim of [
    { lens: "security" as const, reason: "   ", diffEvidence: ["src/util/creds.ts"] },
    { lens: "security" as const, reason: "a real reason", diffEvidence: [] },
    { lens: "security" as const, reason: "a real reason", diffEvidence: ["  "] },
  ]) {
    const c = confirmContract(APPROVED, { ...withScopes(grown), widening: [claim] });
    assert.equal(c.kind, "refused", `${JSON.stringify(claim)} must be refused`);
    assert.match(c.kind === "refused" ? c.refusal : "", /needs both a reason and non-empty diff evidence/);
  }
});

test("FG-689: a widening claim that broadens NOTHING is refused rather than passing silently", () => {
  const c = confirmContract(APPROVED, {
    candidateSha: "cand1",
    widening: [
      {
        lens: "security",
        reason: "restating what security already owns",
        diffEvidence: ["src/store/reviews.ts"],
        scopePaths: ["src/store/reviews.ts"],
      },
    ],
  });
  assert.equal(c.kind, "refused");
  assert.match(c.kind === "refused" ? c.refusal : "", /whose authored scope is unchanged/);
});

// ─── a REWRITE is neither, and forge will not pick a half ────────────────────

test("FG-689 / D3: a scope whose pattern is REPLACED is refused BY NAME, never silently confirmed", () => {
  const c = confirmContract(APPROVED, {
    candidateSha: "cand1",
    contract: {
      ...APPROVED,
      lens_scopes: { ...APPROVED.lens_scopes, security: ["src/store/reviews.ts", "src/util/creds.ts"] },
    },
    widening: [
      {
        lens: "security",
        reason: "a credential path appeared",
        diffEvidence: ["src/util/creds.ts"],
        scopePaths: ["src/util/creds.ts"],
      },
    ],
  });

  assert.equal(c.kind, "refused");
  if (c.kind !== "refused") return;
  assert.match(c.refusal, /REWRITES the authored lens scope of security/, "the refusal names the lens");
  assert.match(c.refusal, /adds src\/util\/creds\.ts/, "and what it adds");
  assert.match(c.refusal, /removes src\/v2\/review-contract\.ts/, "and what it removes");
  assert.match(c.refusal, /neither a widening .* nor a narrowing/);
  assert.match(c.refusal, /Nothing was written/);
});

test("FG-689 / D3: a rewrite is not rescued by ANY amount of recorded evidence", () => {
  // The claim is impeccable on the half that grew. That is exactly why the refusal must not
  // read the evidence and confirm: the removal it carries has no evidence that could justify
  // it, because narrowing is not a thing evidence authorizes.
  const c = confirmContract(APPROVED, {
    candidateSha: "cand1",
    contract: { ...APPROVED, lens_scopes: { ...APPROVED.lens_scopes, wide: ["src/v2/", "src/store/"] } },
    widening: [
      {
        lens: "wide",
        reason: "the store surface grew and wide should read it",
        diffEvidence: ["src/store/reviews.ts", "src/store/schema.ts"],
        scopePaths: ["src/store/"],
      },
    ],
  });
  assert.equal(c.kind, "refused");
  assert.match(c.kind === "refused" ? c.refusal : "", /REWRITES the authored lens scope of wide/);
});

// ─── the anti-classifier locks, restated for scopes ──────────────────────────

test("FG-689: changed file paths ALONE never widen a scope — there is no path classifier", () => {
  const c = confirmContract(APPROVED, {
    candidateSha: "cand1",
    changedPaths: [
      "src/util/creds.ts",
      "src/auth/token-store.ts",
      "dashboard/src/App.tsx",
      "docker/Dockerfile",
    ],
  });
  assert.equal(c.kind, "confirmed");
  if (c.kind !== "confirmed") return;
  assert.deepEqual(c.widenedScopes, [], "a security-shaped path in the diff must not join security's scope");
  assert.deepEqual(c.contract.lens_scopes, APPROVED.lens_scopes, "the scopes come back exactly as authored");
});

// D5's grammar lives in the zod schema, which the widening-only proposal shape never reaches:
// it builds the proposed contract from the approved one instead of parsing a new one. That
// door has to enforce the grammar itself, or `--add-lens` becomes the one way to write an
// exclusion pattern into a confirmed contract.
test("FG-689 / D5: a negation pattern cannot enter through the widening door either", () => {
  for (const bad of ["!src/generated/", "/etc/passwd", "src/../../elsewhere"]) {
    const c = confirmContract(APPROVED, {
      candidateSha: "cand1",
      widening: [
        {
          lens: "backend",
          reason: "the diff moved a store path",
          diffEvidence: ["src/store/reviews.ts"],
          scopePaths: [bad],
        },
      ],
    });
    assert.equal(c.kind, "refused", `${bad} must not become an authored scope pattern`);
    assert.match(c.kind === "refused" ? c.refusal : "", /not authorable/);
    assert.match(c.kind === "refused" ? c.refusal : "", /path classifier by another name/);
  }
});

// ─── widening-only proposals carry scopes correctly ──────────────────────────

test("FG-689: a widening-only claim UNIONS into an existing scope — it never replaces it", () => {
  const c = confirmContract(APPROVED, {
    candidateSha: "cand1",
    widening: [
      {
        lens: "security",
        reason: "a credential path appeared inside security's surface",
        diffEvidence: ["src/util/creds.ts"],
        scopePaths: ["src/util/creds.ts"],
      },
    ],
  });

  assert.equal(c.kind, "confirmed", c.kind === "confirmed" ? "" : c.refusal);
  if (c.kind !== "confirmed") return;
  assert.deepEqual(
    c.contract.lens_scopes.security,
    ["src/store/reviews.ts", "src/util/creds.ts", "src/v2/review-contract.ts"],
    "every approved pattern survives — a union, deduped and sorted, so the derivation digest is stable",
  );
  assert.deepEqual(c.widenedScopes, [{ lens: "security", addedPatterns: ["src/util/creds.ts"] }]);
});

test("FG-689: a widening-only claim that ADDS a lens gives it a scope, and the result validates", () => {
  const c = confirmContract(APPROVED, {
    candidateSha: "cand1",
    widening: [
      {
        lens: "frontend",
        reason: "the final diff added a rendered operator surface",
        diffEvidence: ["dashboard/src/ShardPlan.tsx (new file)"],
        scopePaths: ["dashboard/src/ShardPlan.tsx"],
      },
    ],
  });

  assert.equal(c.kind, "confirmed", c.kind === "confirmed" ? "" : c.refusal);
  if (c.kind !== "confirmed") return;
  assert.deepEqual(c.addedLenses, ["frontend"]);
  assert.deepEqual(c.contract.lens_scopes.frontend, ["dashboard/src/ShardPlan.tsx"]);
  assert.deepEqual(c.widenedScopes, [], "a lens added with its scope is a lens addition, not a scope widening");
  assert.equal(
    validateReviewContract(c.contract).ok,
    true,
    "the confirmed contract must read back — every selected lens still has a scope",
  );
});

test("FG-689: widening to a lens with no scope paths refuses BY NAME, for both shapes", () => {
  const added = confirmContract(APPROVED, {
    candidateSha: "cand1",
    widening: [{ lens: "frontend", reason: "a rendered surface appeared", diffEvidence: ["dashboard/src/X.tsx"] }],
  });
  assert.equal(added.kind, "refused");
  assert.match(added.kind === "refused" ? added.refusal : "", /reviewer with no surface/);

  const grown = confirmContract(APPROVED, {
    candidateSha: "cand1",
    widening: [{ lens: "security", reason: "something moved", diffEvidence: ["src/x.ts"], scopePaths: ["  "] }],
  });
  assert.equal(grown.kind, "refused");
  assert.match(grown.kind === "refused" ? grown.refusal : "", /already selected/);
});

// ─── the pre-existing guarantees, still asserted ─────────────────────────────

test("FG-639: boundary-field refusals are unchanged by the third change-control class", () => {
  for (const patch of [
    { threat_model: "nothing much can go wrong" },
    { protected_invariants: ["something else"] },
    { acceptance_refs: [] },
    { non_goals: ["a path classifier of any kind", "and one more"] },
  ]) {
    const c = confirmContract(APPROVED, { candidateSha: "cand1", contract: { ...APPROVED, ...patch } });
    assert.equal(c.kind, "needs_approving_authority", `${JSON.stringify(patch)} must return to authority`);
    if (c.kind !== "needs_approving_authority") continue;
    assert.deepEqual(c.narrowedScopes, [], "a boundary change is not a scope narrowing");
    assert.equal(c.changedFields.length, 1);
  }
});

test("FG-639: unclassifiable drift still short-circuits ahead of every scope comparison", () => {
  const c = confirmContract(APPROVED, {
    candidateSha: "cand1",
    unclassifiableDrift: "a surface with no precedent in the plan",
    contract: { ...APPROVED, lens_scopes: { ...APPROVED.lens_scopes, security: ["src/store/reviews.ts"] } },
  });
  assert.equal(c.kind, "returns_to_plan", "an uncertain coordinator never gets as far as reasoning about scopes");
});

test("FG-639: an unchanged contract still confirms, and reports no scope movement", () => {
  const c = confirmContract(APPROVED, { candidateSha: "cand1" });
  assert.equal(c.kind, "confirmed");
  if (c.kind !== "confirmed") return;
  assert.deepEqual(c.widenedScopes, []);
  assert.deepEqual(c.addedLenses, []);
});
