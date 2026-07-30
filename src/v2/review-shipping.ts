// FG-639 (evidence-led review, Change 2): Stage 9 — the shipping review's seven checks.
//
// Each check is a separate named row on purpose. A single boolean "shippable" tells an
// operator nothing about WHY a review is withheld, and a shipping review that cannot say
// which check failed is the same rubber stamp the lifecycle replaced. `unmet` or
// `unproven` acceptance criteria BLOCK — including when the ledger has no open findings
// at all, because a clean ledger is not a proof that the work was done.
//
// Check 2 runs acceptance evidence through the same executed-test rule as a resolution
// (src/v2/review-evidence.ts): a criterion whose only evidence is a skipped test is
// `unproven`, and any claimed alternate-lane coverage has to name the lane, the candidate
// sha, and the executed assertion. That is the PRD's eighth bullet, enforced where the
// mapping is actually decided rather than as a separate box to tick.

import { assessAcceptanceClaims, type AcAssessment, type AcClaim } from "./review-evidence.js";
import { assessContractCoverage, type ContractCoverage } from "./review-contract.js";
import type { ReviewFinding } from "../store/reviews.js";

export type ShippingCheckId =
  | "verification_green"
  | "acceptance_mapped"
  | "findings_settled"
  | "fix_now_resolved"
  | "tip_equality"
  | "identity_continuity"
  | "contract_covers_diff";

export type ShippingCheck = {
  id: ShippingCheckId;
  ok: boolean;
  detail: string;
};

/** Deterministic verification, as Stage 7 recorded it. `executedRequiredChecks: false`
 *  is the not-executed case — required coverage no mandatory lane ran is `not_executed`,
 *  which is not green. */
export type VerificationState = {
  ok: boolean;
  sha?: string;
  /** Every required check actually executed rather than skipped. */
  executedRequiredChecks: boolean;
  detail: string;
};

/** Continuity of the identity chain around the candidate. Supplied by the caller from the
 *  existing candidate/gate/receipt/publication records — this module checks, it does not
 *  re-derive a second identity model. */
export type IdentityContinuity = {
  continuous: boolean;
  detail: string;
};

export type TipTrustState = {
  /** FG-514: EQUALITY with the freshly-fetched remote head, not ancestry. */
  kind: "trusted" | "local_only" | "remote_ahead" | "diverged" | "remote_unavailable";
  reviewedSha?: string;
  remoteSha?: string;
  detail?: string;
};

export type ShippingInput = {
  candidateSha: string;
  findings: readonly ReviewFinding[];
  verification: VerificationState;
  acceptance: readonly AcClaim[];
  tipTrust: TipTrustState;
  identity: IdentityContinuity;
  contractCoverage: ContractCoverage;
  /** Findings raised free-form during the shipping review itself. They return to
   *  disposition; they are never settled by the shipping reviewer. */
  newFindings?: readonly { summary: string }[];
};

export type ShippingAssessment = {
  ok: boolean;
  checks: ShippingCheck[];
  acceptance: AcAssessment[];
  /** True when the review must go back to Stage 4 rather than simply being blocked —
   *  an unsettled finding or a free-form new finding. */
  returnsToDisposition: boolean;
  blocking: string[];
};

function isSettled(f: ReviewFinding): boolean {
  if (f.disposition === "untriaged" || f.disposition === "architecture_question") return false;
  if (f.disposition === "fix_now") return f.resolution === "resolved";
  return true;
}

export function assessShippingReview(input: ShippingInput): ShippingAssessment {
  const acceptance = assessAcceptanceClaims(input.acceptance, input.candidateSha);
  const checks: ShippingCheck[] = [];

  // 1 — deterministic verification green at the CURRENT candidate, every required check
  // executed rather than skipped.
  const verificationSha = input.verification.sha;
  const shaMatches = verificationSha === undefined || verificationSha === input.candidateSha;
  checks.push({
    id: "verification_green",
    ok: input.verification.ok && input.verification.executedRequiredChecks && shaMatches,
    detail: !shaMatches
      ? `verification recorded at ${verificationSha}, not the current candidate ${input.candidateSha}`
      : !input.verification.ok
        ? `deterministic verification is not green: ${input.verification.detail}`
        : !input.verification.executedRequiredChecks
          ? `required coverage was not executed (recorded not_executed, which is not green): ${input.verification.detail}`
          : input.verification.detail,
  });

  // 2 — every AC met/unmet/unproven with cited, EXECUTED evidence.
  const unproven = acceptance.filter((a) => a.verdict !== "met");
  const missingClaims = input.acceptance.length === 0;
  checks.push({
    id: "acceptance_mapped",
    ok: !missingClaims && unproven.length === 0,
    detail: missingClaims
      ? `no acceptance criteria were mapped — a clean ledger is not evidence that the work was done`
      : unproven.length === 0
        ? `${acceptance.length} acceptance criteria met on executed evidence`
        : `${unproven.length} acceptance criteria are unmet/unproven: ${unproven
            .map((a) => `${a.ref} (${a.verdict}: ${a.detail})`)
            .join("; ")}`,
  });

  // 3 — every finding settled.
  const unsettled = input.findings.filter((f) => !isSettled(f));
  checks.push({
    id: "findings_settled",
    ok: unsettled.length === 0,
    detail:
      unsettled.length === 0
        ? `${input.findings.length} finding(s) settled`
        : `${unsettled.length} unsettled: ${unsettled.map((f) => `${f.findingRef} (${f.disposition})`).join(", ")}`,
  });

  // 4 — every fix_now EXPLICITLY resolved.
  const fixNow = input.findings.filter((f) => f.disposition === "fix_now");
  const unresolved = fixNow.filter((f) => f.resolution !== "resolved");
  checks.push({
    id: "fix_now_resolved",
    ok: unresolved.length === 0,
    detail:
      unresolved.length === 0
        ? `${fixNow.length} fix_now finding(s) resolved on executed evidence`
        : `${unresolved.length} fix_now finding(s) not resolved: ${unresolved
            .map((f) => `${f.findingRef} (${f.resolution ?? "no recheck result"})`)
            .join(", ")}`,
  });

  // 5 — reviewed sha EQUALS the trusted remote head.
  checks.push({
    id: "tip_equality",
    ok: input.tipTrust.kind === "trusted",
    detail:
      input.tipTrust.kind === "trusted"
        ? `reviewed tip ${input.tipTrust.reviewedSha ?? input.candidateSha} equals the fetched remote head`
        : `reviewed-tip trust is ${input.tipTrust.kind}${input.tipTrust.detail !== undefined ? `: ${input.tipTrust.detail}` : ""}`,
  });

  // 6 — candidate/gate/receipt/publication identity continuity.
  checks.push({
    id: "identity_continuity",
    ok: input.identity.continuous,
    detail: input.identity.detail,
  });

  // 7 — the final diff is plausibly covered by the confirmed contract.
  const coverage = assessContractCoverage(input.contractCoverage);
  checks.push({ id: "contract_covers_diff", ok: coverage.ok, detail: coverage.detail });

  const newFindings = input.newFindings ?? [];
  const blocking = checks.filter((c) => !c.ok).map((c) => `${c.id}: ${c.detail}`);
  if (newFindings.length > 0) {
    blocking.push(
      `${newFindings.length} free-form finding(s) raised during shipping review return to disposition: ` +
        newFindings.map((f) => f.summary).join("; "),
    );
  }

  return {
    ok: blocking.length === 0,
    checks,
    acceptance,
    returnsToDisposition: unsettled.length > 0 || newFindings.length > 0,
    blocking,
  };
}
