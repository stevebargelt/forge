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
// FG-566: an environment REFUSAL is not a failed verification, and the BADGE is
// where an operator scans. The producer sets `ok: false` on a refusal (literally
// true — nothing ran), so reading `ok` alone painted the refusal in the same red
// as a genuine test failure and left the distinction to a muted detail span
// nobody scans. Checked BEFORE `ok` for exactly that reason. A payload with no
// readiness field (every pre-FG-566 event) reaches none of this.
export const ENVIRONMENT_UNAVAILABLE_CLASS = "status-environment_unavailable";

export function isReadinessRefusal(p) {
  return Boolean(p && typeof p === "object" && p.readiness && typeof p.readiness === "object" && p.readiness.outcome === "refused");
}

export function verificationOutcomeClass(p) {
  if (!p || typeof p !== "object") return "status-pending";
  if (isReadinessRefusal(p)) return ENVIRONMENT_UNAVAILABLE_CLASS;
  if (typeof p.exitCode === "number") return p.exitCode === 0 ? "status-complete" : "status-failed";
  if (typeof p.ok === "boolean") return p.ok ? "status-complete" : "status-failed";
  return "status-pending";
}

/** The timeline badge's TEXT. The event type alone is byte-identical for a
 *  refusal and a genuine failure — `review_loop.verification_finished` either way
 *  — so the badge carries the classification itself, in text as well as colour.
 *  Every other event, and every pre-FG-566 payload, returns the bare event type
 *  unchanged. */
export function eventBadgeText(e) {
  return isReadinessRefusal(e && e.payload) ? `${e.eventType} · environment` : e.eventType;
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
  // FG-566: the readiness preflight's terminal events match none of the generic
  // patterns below either — "ready" contains no "complete", "refused" no
  // "failed" — so both fell through to the dim in-flight grey. A refusal is a
  // TERMINAL environment fault that stopped the path before it ran; it must not
  // read as pending.
  if (type === "host_readiness.ready") return "status-complete";
  if (type === "host_readiness.refused") return "status-failed";
  if (/failed|blocked|killed|idle_timeout|abandoned|cancelled/.test(type)) return "status-failed";
  if (/completed|complete/.test(type)) return "status-complete";
  if (/awaiting/.test(type)) return "status-awaiting_gate";
  return "status-pending";
}

// FG-566: the readiness preflight's classified outcome, carried on
// review_loop.verification_finished as `readiness: { outcome, reason? } | null`
// (src/cli/commands/review-loop.ts's verifyWithEvents). An event emitted BEFORE
// FG-566 carries no such field at all, and `null` means readiness was never
// consulted — the CI/evidence-reuse path returned before any local provisioning
// was considered. Both must render byte-identically to the pre-FG-566 line.
function readinessOf(p) {
  const r = p.readiness;
  return r && typeof r === "object" ? r : null;
}

// The whole point of this ticket, reproduced on the operator surface: a
// preparation REFUSAL is an environment fault, not a failed verification of the
// reviewed code. Rendering it through the ordinary "mode · round · command"
// detail line would tell the operator the same lie the loop used to tell the
// fixer. So a refusal gets its own line shape — leading marker, the shared
// `verification_environment_unavailable` classification token, the refusal
// reason, and the two facts an operator needs to know the loop did NOT charge
// them for this: no round consumed, no agents dispatched. The signal is carried
// by text, not by colour — the timeline renders this span dim-muted either way.
function readinessRefusedDetail(p, readiness) {
  const reason = typeof readiness.reason === "string" && readiness.reason ? readiness.reason : "unclassified";
  const parts = [`⚠ verification_environment_unavailable: ${reason}`];
  if (typeof p.round === "number") parts.push(`round ${p.round}`);
  parts.push("no round consumed — neither reviewer nor fixer ran");
  const command = readiness.command || p.command;
  if (command) parts.push(`setup: ${String(command)}`);
  return parts.join(" · ");
}

// review_loop.verification_started/finished payload (src/cli/commands/review-loop.ts's
// verifyWithEvents): round + ticketId + sha + mode ("local" | "ci_wait"), plus on finish
// ok + reusedEvidence + ciOutcome, and (AC2) checkContexts for ci_wait or command/tier
// for local, and (FG-566) readiness.
export function reviewLoopVerificationDetail(p) {
  const readiness = readinessOf(p);
  if (readiness && readiness.outcome === "refused") return readinessRefusedDetail(p, readiness);
  const parts = [];
  if (p.mode) parts.push(String(p.mode));
  if (typeof p.round === "number") parts.push(`round ${p.round}`);
  // "deps", not "evidence": `reused evidence` below is CI/host-verification
  // evidence reuse, a different fact from reusing a warm dependency assertion.
  if (readiness && readiness.outcome === "prepared") parts.push("deps prepared");
  if (readiness && readiness.outcome === "reused") parts.push("deps ready (reused)");
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
