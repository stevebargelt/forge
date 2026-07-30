// forge-dashboard — review-ledger presentation logic (FG-638).
//
// Extracted from the view for the same reason verification-render.js was: badge
// selection, count formatting and "next required action" are decisions, and a
// decision that lives only inline in a JSX-ish template has no test. The dashboard
// is a read surface for an authority model — rendering "settled" over an untriaged
// finding would be a lie, not a cosmetic bug.

const DISPOSITION_BADGES = {
  untriaged: "status-awaiting_gate",
  fix_now: "status-blocked_by_red",
  accepted_risk: "status-pending",
  deferred: "status-pending",
  rejected_premise: "status-complete",
  duplicate: "status-pending",
  architecture_question: "status-awaiting_red",
};

const SEVERITY_BADGES = {
  critical: "status-failed",
  high: "status-failed",
  medium: "status-awaiting_gate",
  low: "status-pending",
};

export function dispositionBadgeClass(disposition) {
  return DISPOSITION_BADGES[disposition] ?? "status-pending";
}

export function severityBadgeClass(severity) {
  return SEVERITY_BADGES[String(severity ?? "").toLowerCase()] ?? "status-pending";
}

export function reviewStateBadgeClass(state) {
  if (state === "settled") return "status-complete";
  if (state === "failed") return "status-failed";
  if (state === "blocked_environment") return "status-environment_unavailable";
  if (state === "awaiting_disposition") return "status-awaiting_gate";
  return "status-running";
}

/** "fix_now 2, untriaged 1" — deterministic order so two renders of one review
 *  never disagree, and an em dash rather than an empty string when there is
 *  nothing to count. */
export function formatCounts(counts) {
  const entries = Object.entries(counts ?? {}).sort(([a], [b]) => a.localeCompare(b));
  return entries.length === 0 ? "—" : entries.map(([k, n]) => `${k} ${n}`).join(", ");
}

/** The single next thing this review needs, in blocking order. Mirrors the ledger
 *  rules: untriaged findings first, then open architecture questions, then fix_now
 *  work that has no proven resolution, then the stage itself. */
export function nextRequiredAction(review) {
  const counts = review?.countsByDisposition ?? {};
  const findings = review?.findings ?? [];

  if ((counts.untriaged ?? 0) > 0) {
    return `disposition ${counts.untriaged} untriaged finding(s)`;
  }
  if ((counts.architecture_question ?? 0) > 0) {
    return `settle ${counts.architecture_question} architecture question(s) with the approving authority`;
  }
  const unresolvedFixNow = findings.filter((f) => f.disposition === "fix_now" && f.resolution !== "resolved").length;
  if (unresolvedFixNow > 0) {
    return `fix and recheck ${unresolvedFixNow} finding(s)`;
  }
  if (review?.state === "settled") return "settled — no action";
  return `advance: ${review?.state ?? "unknown"}`;
}

/** Every reviewer that reported a finding, as display text. Never collapses two
 *  sources into one: source count is provenance and losing one hides who saw it. */
export function sourceLabels(sources) {
  return (sources ?? []).map((s) => {
    const who = s.redRole || s.redTaskId || s.verdictId || (s.modelFindingId ? "model-supplied id" : "unattributed");
    return s.verdictId && s.redRole ? `${who} (${s.verdictId})` : who;
  });
}

export function anchorText(finding) {
  if (!finding?.file) return null;
  const at = finding.line ? `${finding.file}:${finding.line}` : finding.file;
  return finding.quotedText ? `${at} "${finding.quotedText}"` : at;
}
