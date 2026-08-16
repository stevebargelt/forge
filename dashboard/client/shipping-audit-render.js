// forge-dashboard — shipping-audit presentation logic (FG-386).
//
// Extracted from the panel for the same reason review-ledger-render.js was: the
// mapping from an audit status to a badge and a human label is a DECISION, and a
// decision that lives only inline in a template has no test. The read surface must
// never render absence as a pass, so the not_observed → dim-neutral mapping in
// particular is pinned here.

const AUDIT_STATUS_BADGES = {
  passed: "audit-passed",
  failed: "audit-failed",
  running: "audit-running",
  needs_human: "audit-needs_human",
  stale: "audit-stale",
  not_observed: "audit-not_observed",
};

const AUDIT_STATUS_LABELS = {
  passed: "passed",
  failed: "failed",
  running: "running",
  needs_human: "needs human",
  stale: "stale",
  not_observed: "not observed",
};

export function auditBadgeClass(status) {
  return AUDIT_STATUS_BADGES[status] ?? "audit-not_observed";
}

export function auditStatusLabel(status) {
  return AUDIT_STATUS_LABELS[status] ?? "not observed";
}

export function shortSha(sha) {
  return sha ? String(sha).slice(0, 12) : "—";
}

/** The one-line reason a row demands attention, in the same blocking order the
 *  ledger uses. Absence is stated as "not observed yet", never implied clean. */
export function auditReason(row) {
  const readiness = row?.readiness ?? null;
  const review = row?.review ?? null;
  if (!readiness && !review) return "no readiness or review evidence — not observed yet";
  if (review?.stale) return "review evidence superseded — a newer candidate exists";
  if (readiness?.stale) return "readiness stale — the ticket body changed since it was assessed";
  if ((review?.openArchitectureQuestions ?? 0) > 0) {
    return `${review.openArchitectureQuestions} open architecture question(s) — needs a human`;
  }
  if ((review?.unresolvedFixNow ?? 0) > 0) return `${review.unresolvedFixNow} unresolved fix-now finding(s)`;
  if (readiness && readiness.status === "failed") return `readiness ${readiness.outcome}: ${readiness.gaps.length} gap(s)`;
  if (readiness && readiness.status === "needs_human") return `readiness ${readiness.outcome} — needs a human`;
  if (!review) return "no shipping review observed yet";
  if (review.state === "settled") return "review settled — no action";
  return `review ${review.state}`;
}
