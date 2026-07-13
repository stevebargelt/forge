// Pure decision logic for the host-verification views (main.js), split out so
// it can be unit-tested with the node test runner — same pattern as
// verification-label.js. FG-487 review finding: this logic (badge class
// selection, detail-line construction, row grouping) previously lived only
// inline in main.js with zero test coverage — exactly where a producer/
// renderer field mismatch (ciOutcome.kind checked against "passed", a value
// the producer never emits; tier/checkContexts/reused never set) hid behind
// a green suite.
import { verificationRowLabel } from "./verification-label.js";

// review_loop.verification_finished carries `ok` (src/cli/commands/review-loop.ts's
// verifyWithEvents); campaign_item.host_gate_finished carries `exitCode`
// (src/campaign/reconcile-collect.ts). Check both — never a "passed" kind or a
// bare `passed` field, neither of which either producer emits.
export function verificationOutcomeClass(p) {
  if (!p || typeof p !== "object") return "status-pending";
  if (typeof p.exitCode === "number") return p.exitCode === 0 ? "status-complete" : "status-failed";
  if (typeof p.ok === "boolean") return p.ok ? "status-complete" : "status-failed";
  return "status-pending";
}

export function eventBadgeClass(e) {
  const type = e.eventType;
  if (/verification_started|host_gate_started/.test(type)) return "status-running";
  if (/verification_finished|host_gate_finished/.test(type)) return verificationOutcomeClass(e.payload);
  // FG-425's publisher events are TERMINAL but match none of the generic patterns
  // below — "published", "refused" and "parked" contain no "complete" and no
  // "failed". They fell through to status-pending, rendering a landed publication
  // in the same dim grey as an in-flight one: an operator could not tell a
  // publication that shipped from one that is stuck. They are named explicitly.
  //
  // integration.published is the RUN-level outcome and carries `outcome` in its
  // payload (published | refused | parked | validation_failed | merge_failed) — the
  // event fires whatever happened, so the badge must read the payload, not the name.
  if (type === "integration.published") {
    return e.payload && e.payload.outcome === "published" ? "status-complete" : "status-failed";
  }
  if (type === "publication.published") return "status-complete";
  if (type === "publication.refused" || type === "publication.parked") return "status-failed";
  if (type === "publication.recovered") return "status-complete";
  if (/failed|blocked|killed|idle_timeout|abandoned|cancelled/.test(type)) return "status-failed";
  if (/completed|complete/.test(type)) return "status-complete";
  if (/awaiting/.test(type)) return "status-awaiting_gate";
  return "status-pending";
}

// review_loop.verification_started/finished payload (src/cli/commands/review-loop.ts's
// verifyWithEvents): round + ticketId + sha + mode ("local" | "ci_wait"), plus on finish
// ok + reusedEvidence + ciOutcome, and (AC2) checkContexts for ci_wait or command/tier
// for local.
export function reviewLoopVerificationDetail(p) {
  const parts = [];
  if (p.mode) parts.push(String(p.mode));
  if (typeof p.round === "number") parts.push(`round ${p.round}`);
  if (p.command) parts.push(String(p.command));
  if (p.tier) parts.push(String(p.tier));
  if (Array.isArray(p.checkContexts) && p.checkContexts.length > 0) parts.push(p.checkContexts.join(", "));
  if (p.reusedEvidence) parts.push("reused evidence");
  if (p.ciOutcome && typeof p.ciOutcome === "object" && typeof p.ciOutcome.kind === "string") {
    parts.push(p.ciOutcome.kind);
  }
  if (Array.isArray(p.steps)) {
    const failed = p.steps.filter((s) => s && s.ok === false).map((s) => s.name);
    if (failed.length > 0) parts.push(`failed: ${failed.join(", ")}`);
  }
  return parts.join(" · ");
}

// campaign_item.host_gate_started/finished payload: ticketId, item id, gate
// command, testedSha (src/campaign/reconcile-collect.ts).
export function hostGateDetail(p) {
  const parts = [];
  // The producer sets `gate` and `command` to the same string — render once.
  if (p.gate && p.gate !== p.command) parts.push(String(p.gate));
  if (p.command) parts.push(String(p.command));
  if (typeof p.exitCode === "number") parts.push(`exit ${p.exitCode}`);
  return parts.join(" · ");
}

// VerificationsView's split of GET /api/verifications/in-progress rows into
// the two sections it renders under separate headings.
export function groupVerificationRows(rows) {
  const list = rows || [];
  return {
    loop: list.filter((v) => v.kind === "review_loop_verification"),
    gate: list.filter((v) => v.kind === "campaign_reconcile_gate"),
  };
}

// VerificationRow's badge: `stale` (dashboard/src/queries.ts's inProgressVerifications
// past-cutoff-but-within-lookback flag) always overrides the plain in-progress
// label/class, regardless of kind/mode.
export function verificationRowBadge(v) {
  const label = verificationRowLabel(v);
  return v.stale
    ? { class: "status-failed", text: `stale · ${label}` }
    : { class: "status-running", text: label };
}

// Pure empty-state selector for a rows-or-null evidence result (VerificationsView's
// lookup panel) and a plain rows list (recent host_verifications / EvidenceTable).
export function evidenceState(rows) {
  if (rows === null) return "prompt";
  return rows.length === 0 ? "empty" : "rows";
}
