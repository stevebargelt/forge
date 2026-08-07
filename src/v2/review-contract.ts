// FG-639 (evidence-led review, Change 2): the review contract — validated, persisted,
// and confirmed against the final implementation diff.
//
// THE WIDENING ASYMMETRY IS THE WHOLE POINT OF THIS MODULE. An unchanged autonomous
// run must keep moving, and the coordinator must be able to BROADEN review coverage on
// its own — but it must not be able to narrow the approved contract. So exactly one
// direction is autonomous:
//
//   add a lens, with recorded diff evidence   → confirmed by the coordinator
//   evaluated, no lens change needed (no_drift,
//     with the diff examined and the statement) → confirmed by the coordinator
//   remove a lens                             → back to the approving authority
//   change threat_model / protected_invariants /
//     acceptance_refs / non_goals              → back to the approving authority
//   drift the coordinator cannot classify      → back to plan/architecture
//
// AND IT IS NOT A FILE-PATH CLASSIFIER. Nothing here reads a changed path and decides
// "this looks like frontend, add the frontend lens". The coordinator (or an operator)
// states the widening and attaches the diff evidence for it; this module checks that
// the claim is well-formed and points in the permitted direction. Inferring lenses from
// paths is explicitly out of scope for this lifecycle (PRD "Review contract"), and
// `confirmContract` is written so that changed paths alone can never move a lens.
//
// FG-689 ADDS `lens_scopes` AND DOES NOT WEAKEN THAT. The scopes say which paths each
// selected lens OWNS, so a reviewer can be handed its own surface rather than the whole
// diff — but they are AUTHORED with the contract and approved with it, never derived here.
// The direction of inference is the point: an authored scope is a human saying "security
// owns these paths"; a classifier is forge saying "this path looks like security". The
// first is a contract, the second is the thing the PRD refuses.

import { z } from "zod";

/** The fixed lens vocabulary, resolved directly by the coordinator. The PRD is explicit
 *  that shipping this lifecycle must NOT introduce a general conditional-workflow
 *  language — five names and a role map are the whole mechanism. */
export const RISK_LENSES = ["wide", "narrow", "frontend", "backend", "security"] as const;
export type RiskLens = (typeof RISK_LENSES)[number];

const LENS_ROLE: Record<RiskLens, string> = {
  wide: "red-wide",
  narrow: "red-narrow",
  frontend: "red-frontend",
  backend: "red-backend",
  security: "red-security",
};

export function lensRole(lens: RiskLens): string {
  return LENS_ROLE[lens];
}

/** The reverse map: is this red agent a risk LENS, and which one?
 *
 *  `undefined` means "not a lens" — the shipping reviewer, an integration red, anything a
 *  workflow declares that is not one of the five. Those are never lens-selected away: they
 *  are not discovery panelists, so a contract that selects two lenses has said nothing about
 *  whether the shipping review runs. */
export function lensForRole(role: string): RiskLens | undefined {
  return RISK_LENSES.find((l) => LENS_ROLE[l] === role);
}

/** THE REVIEW LIFECYCLE'S NON-LENS DISPATCH REGISTRY (FG-654).
 *
 *  These four roles cannot be derived from the lens map, so this is where each one is
 *  SPELLED — and every dispatch site READS its role from here rather than restating a
 *  literal: review-wiring's fixer/docs/rechecker dispatches, and runNext's recognition of
 *  the workflow-declared shipping reviewer. It is therefore the registry the dispatch uses,
 *  not a second copy of it, which is what lets COVERED_ROLES be derived rather than
 *  hand-maintained — `fg578-ownership-agreement.test.ts` holds the "no bare literal at a
 *  dispatch site" half. */
export const REVIEW_DISPATCH_ROLES = {
  /** review-wiring.ts dispatchFixer — the fix-batch remediation dispatch. */
  fixBatch: "engineer",
  /** review-wiring.ts dispatchDocs — the docs reconciliation phase. Since FG-655 that
   *  dispatch is bound to a durable row BEFORE it can start a container, and the coordinator
   *  — not this agent — commits what the agent DECLARES in `docs_updated`. */
  docs: "documentation-maintainer",
  /** review-wiring.ts dispatchRechecker — the evidence recheck. */
  recheck: "review-rechecker",
  /** the workflow-declared red runNext dispatches at the authoritative shipping gate. */
  shippingReview: "shipping-reviewer",
} as const;

/** Every role the review lifecycle dispatches: the lens half DERIVED from the lens role
 *  map above, the non-lens half DERIVED from the dispatch registry beside it. Each is one
 *  the Forge-owned agent protocol covers (FG-654). */
export const COVERED_ROLES: readonly string[] = [
  ...RISK_LENSES.map((l) => lensRole(l)),
  ...Object.values(REVIEW_DISPATCH_ROLES),
];

export function isCoveredRole(role: string): boolean {
  return COVERED_ROLES.includes(role);
}

/** FG-640 / scenario #16: RISK-TARGETED SELECTION. A migrated workflow still DECLARES every
 *  discipline red it might need — the declaration is the menu, not the panel — and the
 *  plan-gate-approved contract picks from it.
 *
 *  FAIL-CLOSED MEANS WIDER HERE, and that direction is deliberate. With no approved contract
 *  there is nothing that legitimately narrows the panel, so every declared red runs: an
 *  unreviewed surface is the failure this lifecycle exists to prevent, and an extra reviewer
 *  costs a container. The narrow answer is only ever reached from an approved contract.
 *
 *  It is NOT a path classifier either (PRD "Review contract"): nothing here reads the diff.
 *  The contract names the lenses; this filters the declared reds to them. */
export function selectRedsForContract<T extends { agent: string }>(
  reds: readonly T[],
  contract: unknown,
): { selected: T[]; skipped: T[]; reason: string } {
  const validated = validateReviewContract(contract);
  if (!validated.ok) {
    return {
      selected: [...reds],
      skipped: [],
      reason: `no approved review contract to select from — every declared red runs (fail closed, wider)`,
    };
  }
  const wanted = new Set<RiskLens>(validated.contract.risk_lenses);
  const selected: T[] = [];
  const skipped: T[] = [];
  for (const red of reds) {
    const lens = lensForRole(red.agent);
    if (lens === undefined || wanted.has(lens)) selected.push(red);
    else skipped.push(red);
  }
  return {
    selected,
    skipped,
    reason:
      `the approved contract selects risk lens(es) ${validated.contract.risk_lenses.join(", ")}` +
      (skipped.length > 0 ? `; ${skipped.map((r) => r.agent).join(", ")} not selected` : ""),
  };
}

const nonEmpty = z.string().trim().min(1);

/** FG-689: ONE authored lens-to-path scope pattern — a literal repo-relative path, or a
 *  directory prefix. AUTHORED ONLY. Nothing in forge derives one of these from a filename,
 *  a directory name or an extension; the not-a-path-classifier statement above holds for
 *  scopes exactly as it holds for lenses, and this module still never reads a diff.
 *
 *  THERE IS DELIBERATELY NO NEGATION FORM (FG-689 D5). An exclusion list is a path
 *  classifier by another name: "everything under src/ EXCEPT the generated bits" is a rule
 *  about what filenames mean, which is the one thing the PRD puts out of scope. A generated
 *  or vendored artifact gets an owner like any other path, and the cost is accepted. */
const scopePattern = nonEmpty
  .refine((p) => !p.startsWith("!"), {
    message:
      "a scope pattern has no negation form — an exclusion list is a path classifier by another name (FG-689 D5)",
  })
  .refine((p) => !p.startsWith("/"), { message: "a scope pattern is repo-relative, not absolute" })
  .refine((p) => !p.split("/").includes(".."), { message: "a scope pattern may not contain a `..` segment" });

/** The authored map from a selected risk lens to the paths that lens owns. Partial over the
 *  vocabulary on purpose: a contract carries an entry for exactly the lenses it selects, and
 *  `validateReviewContract` refuses either half of that being untrue. */
export const LensScopesSchema = z.partialRecord(z.enum(RISK_LENSES), z.array(scopePattern).min(1));

export type LensScopes = z.infer<typeof LensScopesSchema>;

/** The five fields a contract carried before FG-689 added `lens_scopes`. Kept so a contract
 *  that predates scopes can be RECOGNISED rather than merely rejected — see
 *  `SCOPELESS_CONTRACT_REFUSAL_KIND`. */
const LegacyReviewContractSchema = z
  .object({
    threat_model: nonEmpty,
    protected_invariants: z.array(nonEmpty),
    acceptance_refs: z.array(nonEmpty),
    risk_lenses: z.array(z.enum(RISK_LENSES)).min(1),
    non_goals: z.array(nonEmpty),
  })
  .strict();

export const ReviewContractSchema = z
  .object({
    threat_model: nonEmpty,
    protected_invariants: z.array(nonEmpty),
    acceptance_refs: z.array(nonEmpty),
    risk_lenses: z.array(z.enum(RISK_LENSES)).min(1),
    non_goals: z.array(nonEmpty),
    lens_scopes: LensScopesSchema,
  })
  .strict();

export type ReviewContract = z.infer<typeof ReviewContractSchema>;

/** FG-689 D2. Making `lens_scopes` required invalidates every already-approved contract,
 *  which is the correct fail-closed direction — a scopeless contract cannot satisfy the
 *  every-path-covered guarantee — but it must never surface as an unreadable parse error.
 *
 *  Modelled on `STALE_PROTOCOL_FAILURE_KIND`: a version skew is a NAMED refusal that states
 *  its remedy, because the operator reading it did nothing wrong and the fix is not "correct
 *  your JSON". It matters more here than usual: the plan-step prompt that teaches agents to
 *  author `lens_scopes` lives in `seeds/workflows/feature.yml`, a separate deployment surface
 *  reached only through `forge upgrade` (FG-654's precedent), so a host can legitimately be
 *  running new code against contracts authored under the old prompt. */
export const SCOPELESS_CONTRACT_REFUSAL_KIND = "contract_predates_lens_scopes";

/** Why a contract was refused. `contract_invalid` is the generic parse refusal;
 *  `contract_predates_lens_scopes` is D2's version skew; `lens_scope_mismatch` is a
 *  well-formed contract whose scopes and lenses disagree. */
export type ContractRefusalKind =
  | "contract_invalid"
  | typeof SCOPELESS_CONTRACT_REFUSAL_KIND
  | "lens_scope_mismatch";

export type ContractValidation =
  | { ok: true; contract: ReviewContract }
  | { ok: false; refusal: string; refusalKind: ContractRefusalKind };

function normalizeLensScopes(scopes: LensScopes): LensScopes {
  const out: LensScopes = {};
  for (const lens of RISK_LENSES) {
    const patterns = scopes[lens];
    if (patterns === undefined) continue;
    out[lens] = [...new Set(patterns)].sort();
  }
  return out;
}

/** Validate and normalize a contract. Duplicate lenses collapse (a lens is selected or
 *  it is not), and each lens's scope patterns dedupe and sort for the same reason — a
 *  pattern is in a scope or it is not, and a stable order is what makes a derivation
 *  digest over the scopes reproducible. Everything else is taken as authored: a contract
 *  is never reconstructed from prompts after the fact, so a malformed one is a refusal,
 *  not a repair. */
export function validateReviewContract(raw: unknown): ContractValidation {
  const parsed = ReviewContractSchema.safeParse(raw);
  if (!parsed.success) {
    // D2: an otherwise well-formed contract that simply predates the field is a version
    // skew, not malformed input. Say so, and say what fixes it.
    if (
      typeof raw === "object" &&
      raw !== null &&
      !Object.prototype.hasOwnProperty.call(raw, "lens_scopes") &&
      LegacyReviewContractSchema.safeParse(raw).success
    ) {
      return {
        ok: false,
        refusalKind: SCOPELESS_CONTRACT_REFUSAL_KIND,
        refusal:
          `this review contract PREDATES LENS SCOPES: it is well-formed in every other respect but carries no ` +
          `lens_scopes, and without it forge cannot tell which paths each selected lens owns. The contract must ` +
          `be re-approved by its approving authority with a lens_scopes entry for each of ` +
          `${[...new Set((raw as { risk_lenses: RiskLens[] }).risk_lenses)].join(", ")}. Forge will not infer ` +
          `scopes from file paths.`,
      };
    }
    const detail = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    return {
      ok: false,
      refusalKind: "contract_invalid",
      refusal:
        `review contract invalid: ${detail}. Required: threat_model, protected_invariants, ` +
        `acceptance_refs, risk_lenses (one or more of ${RISK_LENSES.join(", ")}), non_goals, ` +
        `lens_scopes (authored owned paths, one entry per selected lens).`,
    };
  }
  const contract = parsed.data;
  const lenses = [...new Set(contract.risk_lenses)];
  const scopes = normalizeLensScopes(contract.lens_scopes);

  const unscoped = lenses.filter((l) => scopes[l] === undefined);
  if (unscoped.length > 0) {
    return {
      ok: false,
      refusalKind: "lens_scope_mismatch",
      refusal:
        `review contract invalid: risk lens ${unscoped.join(", ")} has no lens_scopes entry — every selected ` +
        `lens must be given the paths it owns, because a lens with no authored scope is a reviewer nobody ` +
        `assigned a surface to. Forge does not infer scopes from file paths.`,
    };
  }
  const unselected = RISK_LENSES.filter((l) => scopes[l] !== undefined && !lenses.includes(l));
  if (unselected.length > 0) {
    return {
      ok: false,
      refusalKind: "lens_scope_mismatch",
      refusal:
        `review contract invalid: lens_scopes names ${unselected.join(", ")}, which the contract does not select ` +
        `in risk_lenses — a scope for a lens nobody dispatches assigns paths to a reviewer that will never read ` +
        `them. Select the lens or drop the scope.`,
    };
  }

  return { ok: true, contract: { ...contract, risk_lenses: lenses, lens_scopes: scopes } };
}

/** A widening claim: the coordinator wants ONE more lens, and says which diff evidence
 *  made it necessary. `diffEvidence` is the recorded justification — changed paths, a
 *  diff excerpt, a named new surface. It is required because "recorded evidence" is
 *  what separates a broadened contract from an unexplained one.
 *
 *  `scopePaths` is the added lens's authored scope (FG-689). Adding a lens without saying
 *  what it owns is not a smaller version of adding a lens — it is a reviewer with no
 *  surface, which every-path-covered cannot be checked against. */
export type LensWidening = {
  lens: RiskLens;
  reason: string;
  diffEvidence: string[];
  scopePaths?: string[];
};

/** The recorded evaluation that the final diff needs NO lens change — the third recorded
 *  outcome beside a widening claim and named drift.
 *
 *  Without it "I evaluated the diff and nothing needs to change" and "nobody looked" are
 *  the same proposal object, so a fail-closed confirmation has to refuse both. The
 *  forbidden outcome was only ever the SILENT unevaluated auto-confirm; an evaluation that
 *  concludes no_drift is a legitimate result and advances, because it is recorded. */
export type NoDriftEvaluation = {
  /** The diff the evaluator actually examined. */
  diffSummary: string;
  /** The evaluator's statement that no lens change is needed. */
  statement: string;
};

export type ContractProposal = {
  /** The contract the coordinator proposes for discovery. Omit to confirm unchanged. */
  contract?: unknown;
  /** Evidence for each lens being ADDED relative to the approved contract. */
  widening?: LensWidening[];
  /** The recorded `no_drift` evaluation. Confirms unchanged, WITH its evidence. */
  noDrift?: NoDriftEvaluation;
  /** Set when the coordinator cannot classify the drift it observed. Returns to
   *  plan/architecture rather than guessing. */
  unclassifiableDrift?: string;
  /** The sha the confirmation is about — becomes contract_confirmed_sha. */
  candidateSha: string;
  /** Changed paths in the final implementation diff. RECORDED, never classified:
   *  this module reads it only to put it in the confirmation record. */
  changedPaths?: string[];
};

export type ContractConfirmation =
  | {
      kind: "confirmed";
      contract: ReviewContract;
      confirmedSha: string;
      addedLenses: RiskLens[];
      widening: LensWidening[];
      changedPaths: string[];
      /** Present when the confirmation rests on a recorded `no_drift` evaluation rather
       *  than on an empty diff. Persisted with the stage record. */
      noDrift?: NoDriftEvaluation;
    }
  | {
      kind: "needs_approving_authority";
      changedFields: string[];
      removedLenses: RiskLens[];
      refusal: string;
    }
  | { kind: "returns_to_plan"; refusal: string }
  | { kind: "refused"; refusal: string };

function sameStringSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const left = [...a].sort();
  const right = [...b].sort();
  return left.every((v, i) => v === right[i]);
}

/** The boundary fields — every contract field except the two lens-shaped ones,
 *  `risk_lenses` and `lens_scopes`. Changing any of them is a change to what reviewers are
 *  allowed to conclude, so it returns to whoever approved it. */
const BOUNDARY_FIELDS = ["threat_model", "protected_invariants", "acceptance_refs", "non_goals"] as const;

/** Confirm the approved contract against the final implementation diff.
 *
 *  Order matters and is deliberate: unclassifiable drift short-circuits FIRST (an
 *  uncertain coordinator must not get as far as reasoning about lenses), then boundary
 *  changes and lens removals — which are refusals whichever way the widening claim is
 *  shaped — then the widening claim itself. */
export function confirmContract(approved: ReviewContract, proposal: ContractProposal): ContractConfirmation {
  if (proposal.unclassifiableDrift !== undefined && proposal.unclassifiableDrift.trim() !== "") {
    return {
      kind: "returns_to_plan",
      refusal:
        `the implementation drift could not be classified safely (${proposal.unclassifiableDrift.trim()}) — ` +
        `returning to plan/architecture rather than guessing which lenses cover it. ` +
        `Forge does not infer risk lenses from file paths.`,
    };
  }

  const changedPaths = proposal.changedPaths ?? [];
  const widening = proposal.widening ?? [];
  const noDrift = proposal.noDrift;

  if (noDrift !== undefined) {
    if (noDrift.diffSummary.trim() === "" || noDrift.statement.trim() === "") {
      return {
        kind: "refused",
        refusal:
          `a no_drift evaluation needs BOTH the diff summary that was examined and the statement that no lens ` +
          `change is needed — an empty one is the silent auto-confirm it exists to replace. Nothing was written.`,
      };
    }
    if (proposal.contract !== undefined || widening.length > 0) {
      return {
        kind: "refused",
        refusal:
          `the confirmation records no_drift AND proposes a contract change ` +
          `(${widening.length > 0 ? `widening to ${widening.map((w) => w.lens).join(", ")}` : "a replacement contract"}) — ` +
          `a diff that needs a lens is drift, not no_drift. Nothing was written.`,
      };
    }
  }

  if (proposal.contract === undefined && widening.length === 0) {
    return {
      kind: "confirmed",
      contract: approved,
      confirmedSha: proposal.candidateSha,
      addedLenses: [],
      widening: [],
      changedPaths,
      ...(noDrift !== undefined ? { noDrift } : {}),
    };
  }

  // A widening-only proposal (no explicit contract) is the approved contract plus the
  // claimed lenses — so the common case never has to restate the whole contract. FG-689:
  // it is also plus the claimed lenses' SCOPES, because a selected lens with no scope is
  // not a contract this module will validate, and a confirmation must not hand the rest of
  // the lifecycle a contract that cannot be read back.
  let proposed: ReviewContract;
  if (proposal.contract === undefined) {
    const scopes: LensScopes = { ...approved.lens_scopes };
    for (const w of widening) {
      if (approved.risk_lenses.includes(w.lens)) continue;
      const paths = (w.scopePaths ?? []).filter((p) => p.trim() !== "");
      if (paths.length === 0) {
        return {
          kind: "refused",
          refusal:
            `widening to ${w.lens} names no scope paths — a lens added without the paths it owns is a reviewer ` +
            `with no surface, and every-path-covered cannot be checked against it. Nothing was written.`,
        };
      }
      scopes[w.lens] = paths;
    }
    proposed = {
      ...approved,
      risk_lenses: [...new Set([...approved.risk_lenses, ...widening.map((w) => w.lens)])],
      lens_scopes: scopes,
    };
  } else {
    const validated = validateReviewContract(proposal.contract);
    if (!validated.ok) return { kind: "refused", refusal: validated.refusal };
    proposed = validated.contract;
  }

  const changedFields: string[] = [];
  for (const field of BOUNDARY_FIELDS) {
    const before = approved[field];
    const after = proposed[field];
    const same = Array.isArray(before) && Array.isArray(after) ? sameStringSet(before, after) : before === after;
    if (!same) changedFields.push(field);
  }
  const removedLenses = approved.risk_lenses.filter((l) => !proposed.risk_lenses.includes(l));

  if (changedFields.length > 0 || removedLenses.length > 0) {
    const parts: string[] = [];
    if (removedLenses.length > 0) parts.push(`removes risk lens ${removedLenses.join(", ")}`);
    if (changedFields.length > 0) parts.push(`changes ${changedFields.join(", ")}`);
    return {
      kind: "needs_approving_authority",
      changedFields,
      removedLenses,
      refusal:
        `contract confirmation ${parts.join(" and ")} — the coordinator may only ADD lenses. ` +
        `Weakening the approved contract returns to the original approving authority. Nothing was written.`,
    };
  }

  const addedLenses = proposed.risk_lenses.filter((l) => !approved.risk_lenses.includes(l));
  const claimed = new Set(widening.map((w) => w.lens));
  const unevidenced = addedLenses.filter((l) => !claimed.has(l));
  if (unevidenced.length > 0) {
    return {
      kind: "refused",
      refusal:
        `widening to ${unevidenced.join(", ")} carries no recorded diff evidence — a lens may be added only ` +
        `with the evidence and reason that made it necessary. Nothing was written.`,
    };
  }

  for (const w of widening) {
    if (!addedLenses.includes(w.lens)) {
      return {
        kind: "refused",
        refusal:
          `widening names ${w.lens}, which is not being added (the approved contract already selects it ` +
          `or the proposal omits it). Nothing was written.`,
      };
    }
    if (w.reason.trim() === "" || w.diffEvidence.length === 0 || w.diffEvidence.every((e) => e.trim() === "")) {
      return {
        kind: "refused",
        refusal:
          `widening to ${w.lens} needs both a reason and non-empty diff evidence. ` +
          `An unexplained broader panel is still an unrecorded contract change. Nothing was written.`,
      };
    }
  }

  return {
    kind: "confirmed",
    contract: proposed,
    confirmedSha: proposal.candidateSha,
    addedLenses,
    widening,
    changedPaths,
  };
}

/** Stage 9 check 7: is the final diff plausibly covered by the confirmed contract?
 *
 *  "Plausibly covered" is deliberately weak — this is not a classifier either. What it
 *  can decide mechanically is whether the diff GREW after the sha discovery reviewed:
 *  paths touched between the confirmed sha and the final candidate that discovery never
 *  saw are post-confirmation drift, and the PRD requires that drift be reviewed or
 *  returned for amendment rather than assumed benign. */
export type ContractCoverage = {
  confirmedSha: string;
  finalSha: string;
  /** Paths changed between confirmedSha and finalSha. Empty ⇒ no drift. */
  postConfirmationPaths: string[];
  /** Whether the bounded delta review covered that drift (Stage 8 ran at finalSha). */
  deltaReviewed: boolean;
};

export function assessContractCoverage(coverage: ContractCoverage): { ok: boolean; detail: string } {
  if (coverage.confirmedSha === coverage.finalSha) {
    return { ok: true, detail: `final candidate is the confirmed sha ${coverage.finalSha}` };
  }
  if (coverage.postConfirmationPaths.length === 0) {
    return { ok: true, detail: `no paths changed between ${coverage.confirmedSha} and ${coverage.finalSha}` };
  }
  if (coverage.deltaReviewed) {
    return {
      ok: true,
      detail:
        `${coverage.postConfirmationPaths.length} path(s) changed after contract confirmation and were ` +
        `covered by the bounded remediation-delta review at ${coverage.finalSha}`,
    };
  }
  return {
    ok: false,
    detail:
      `${coverage.postConfirmationPaths.length} path(s) changed after contract confirmation ` +
      `(${coverage.postConfirmationPaths.slice(0, 5).join(", ")}) with no bounded delta review at ` +
      `${coverage.finalSha} — the drift must be reviewed or the contract returned for amendment`,
  };
}
