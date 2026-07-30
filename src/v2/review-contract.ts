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

const nonEmpty = z.string().trim().min(1);

export const ReviewContractSchema = z
  .object({
    threat_model: nonEmpty,
    protected_invariants: z.array(nonEmpty),
    acceptance_refs: z.array(nonEmpty),
    risk_lenses: z.array(z.enum(RISK_LENSES)).min(1),
    non_goals: z.array(nonEmpty),
  })
  .strict();

export type ReviewContract = z.infer<typeof ReviewContractSchema>;

export type ContractValidation =
  | { ok: true; contract: ReviewContract }
  | { ok: false; refusal: string };

/** Validate and normalize a contract. Duplicate lenses collapse (a lens is selected or
 *  it is not); everything else is taken as authored. A contract is never reconstructed
 *  from prompts after the fact, so a malformed one is a refusal, not a repair. */
export function validateReviewContract(raw: unknown): ContractValidation {
  const parsed = ReviewContractSchema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    return {
      ok: false,
      refusal:
        `review contract invalid: ${detail}. Required: threat_model, protected_invariants, ` +
        `acceptance_refs, risk_lenses (one or more of ${RISK_LENSES.join(", ")}), non_goals.`,
    };
  }
  const contract = parsed.data;
  return { ok: true, contract: { ...contract, risk_lenses: [...new Set(contract.risk_lenses)] } };
}

/** A widening claim: the coordinator wants ONE more lens, and says which diff evidence
 *  made it necessary. `diffEvidence` is the recorded justification — changed paths, a
 *  diff excerpt, a named new surface. It is required because "recorded evidence" is
 *  what separates a broadened contract from an unexplained one. */
export type LensWidening = {
  lens: RiskLens;
  reason: string;
  diffEvidence: string[];
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

/** The boundary fields — every contract field except `risk_lenses`. Changing any of them
 *  is a change to what reviewers are allowed to conclude, so it returns to whoever
 *  approved it. */
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
  // claimed lenses — so the common case never has to restate the whole contract.
  let proposed: ReviewContract;
  if (proposal.contract === undefined) {
    proposed = { ...approved, risk_lenses: [...new Set([...approved.risk_lenses, ...widening.map((w) => w.lens)])] };
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
