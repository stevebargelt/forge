// forge-dashboard — campaign presentation logic (FG-395).
//
// Extracted from the view for the same reason shipping-audit-render.js and
// review-ledger-render.js were: the mapping from a campaign/item state to a badge,
// and — the part that MUST be tested — the derivation of per-item git + push/PR
// evidence from the report facts, is a DECISION, and a decision inline in a
// template has no test. This layer NEVER invents evidence: an absent branch is "not
// a Forge-managed worktree", a null prUrl is "no PR", and a push state the report
// did not observe is "unavailable" — never a green, never a fabricated link.
//
// Every value read here already lives on the ReportItemRow the campaign report
// contract produces (src/campaign/report.ts). Nothing is recomputed from SQL.

// Campaign lifecycle status → an existing shell.ts .badge.status-* class. Reusing
// the shared badge palette keeps campaigns visually consistent with the queue /
// reviews surfaces rather than introducing a parallel colour vocabulary.
const CAMPAIGN_STATUS_BADGES = {
  planned: "status-pending",
  running: "status-running",
  paused: "status-awaiting_gate",
  complete: "status-complete",
  failed: "status-failed",
  abandoned: "status-pending",
};

export function campaignStatusBadgeClass(status) {
  return CAMPAIGN_STATUS_BADGES[status] ?? "status-pending";
}

const VERDICT_BADGES = {
  all_shipped: "status-complete",
  complete_with_issues: "status-awaiting_gate",
  not_complete: "status-pending",
};

const VERDICT_LABELS = {
  all_shipped: "all shipped",
  complete_with_issues: "complete with issues",
  not_complete: "not complete",
};

export function verdictBadgeClass(verdict) {
  return VERDICT_BADGES[verdict] ?? "status-pending";
}

export function verdictLabel(verdict) {
  return VERDICT_LABELS[verdict] ?? String(verdict ?? "—");
}

// Per-item lifecycle status → badge. The campaign item lifecycle uses the same
// state names the queue/task surfaces already style, so they resolve directly.
const ITEM_LIFECYCLE_BADGES = {
  pending: "status-pending",
  running: "status-running",
  awaiting_gate: "status-awaiting_gate",
  blocked_by_red: "status-blocked_by_red",
  awaiting_recovery: "status-awaiting_recovery",
  complete: "status-complete",
  failed: "status-failed",
};

export function itemLifecycleBadgeClass(lifecycleStatus) {
  return ITEM_LIFECYCLE_BADGES[lifecycleStatus] ?? "status-pending";
}

export function shortSha(sha) {
  return sha ? String(sha).slice(0, 12) : "—";
}

// The five outcome buckets the report groups into, as a compact "shipped 3 · blocked 1"
// count line. A zero bucket is omitted so the line reads at a glance; "no items" names
// the empty campaign rather than printing five zeros.
export function formatItemCounts(counts) {
  if (!counts || counts.total === 0) return "no items";
  const parts = [];
  for (const key of ["shipped", "blocked", "held", "skipped", "failed"]) {
    if (counts[key] > 0) parts.push(`${key} ${counts[key]}`);
  }
  parts.push(`total ${counts.total}`);
  return parts.join(" · ");
}

// The push state Forge OBSERVED for this item's closed commit, derived SOLELY from
// the done-audit `pushed` check already on the report (done-audit.ts records it as
// pass / fail / unknown+no_remote / unknown). We never persist or recompute a push
// state here — one source of truth. Absence of a done-audit (a non-shipped item, or
// a report with no git facts) is "unavailable", i.e. not observed, never "pushed".
export const PUSH_STATE_LABELS = {
  pushed: "pushed",
  not_pushed: "not pushed",
  no_remote: "no remote",
  unavailable: "push state unavailable",
};

function pushedCheck(item) {
  return (item?.doneAuditState?.checks || []).find((c) => c.name === "pushed") ?? null;
}

export function derivePushState(item) {
  const check = pushedCheck(item);
  if (!check) return "unavailable";
  if (check.status === "pass") return "pushed";
  if (check.status === "fail") return "not_pushed";
  if (check.status === "unknown" && check.detail && /no remote/i.test(check.detail)) return "no_remote";
  return "unavailable";
}

export function pushStateLabel(item) {
  return PUSH_STATE_LABELS[derivePushState(item)] ?? "push state unavailable";
}

// The clear operator action when Forge did not push/PR automatically. Sourced from
// the report's own facts: the no_remote text is the done-audit check's OWN detail
// string; the not-pushed action is the same `push <commit>` the done-audit
// requestedAction composes (done-audit.ts:93-99). A pushed or merely-unobserved
// state has no push action to offer, so this returns null and the UI shows none.
export function pushActionHint(item) {
  const state = derivePushState(item);
  if (state === "no_remote") return pushedCheck(item)?.detail ?? "no remote configured; push/PR unavailable";
  if (state === "not_pushed") return item?.commit ? `push ${item.commit}` : "push the commit";
  return null;
}

// The per-item git + PR evidence block (FG-367 v1 evidence layer), assembled from
// report facts only. `managed` is true ONLY when Forge recorded a branch or worktree
// for this item — otherwise the UI must say "not a Forge-managed worktree" rather
// than imply Forge managed a branch it did not. `prUrl` is always null on the current
// contract, so `pr` is always the no-PR sentinel; a fake link is never produced.
export function gitEvidence(item) {
  const branch = item?.branch ?? null;
  const worktreePath = item?.worktreePath ?? null;
  return {
    managed: Boolean(branch || worktreePath),
    branch,
    worktreePath,
    commit: item?.commit ?? null,
    commitShort: item?.commit ? shortSha(item.commit) : null,
    // prUrl is a literal null on the report contract — Forge opens no PR here.
    prUrl: item?.prUrl ?? null,
    prLabel: item?.prUrl ? String(item.prUrl) : "no PR",
    pushState: derivePushState(item),
    pushLabel: pushStateLabel(item),
    pushActionHint: pushActionHint(item),
  };
}

// The single "what needs a human" line for a blocked/held/gate-parked item, in the
// report's own words. Prefers the explicit requested action, then the report's
// host-verification reconcile hint, then the raw blocker reason. Returns null when
// the item carries no action — a shipped/running item needs nothing surfaced here.
export function itemActionText(item) {
  return (
    item?.requestedHumanAction ??
    item?.hostVerificationReconcileHint ??
    item?.reason ??
    null
  );
}
