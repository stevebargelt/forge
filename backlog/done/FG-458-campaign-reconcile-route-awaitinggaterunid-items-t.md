---
id: FG-458
type: story
status: done
title: "campaign reconcile: route awaiting_gate+runId items through the events-aware evaluator so reconcile and resume cannot disagree"
created: 2026-07-04
closed: 2026-07-05
closed_commit: 18f68fb
---

Surfaced by the FG-441 red-wide review (run-fg-441-red-wide-review-79c86f, findings 1b + 2).

For an item shape of `lifecycleStatus=awaiting_gate, no blockerKind, runId present`, two evidence evaluators can reach OPPOSITE verdicts:
- `forge campaign resume` (FG-441) uses the events-AWARE evaluateReconcileEvidence (FG-428): an unresolved authoritative FAIL on the run (a red block that was never superseded by a later pass or a qualifying force-advance) → refuses to ship.
- `forge campaign reconcile` (FG-443 isOutOfBand branch, reconcile.ts:98 — no runId check) uses evaluateOutOfBandEvidence, which DELIBERATELY ignores run events → can ship the same item if the ticket is done + closedCommit reachable + host-verification passing, never consulting the unresolved authoritative fail.

report.ts's operator next-action hint (outOfBandCompletableAction ~102-113, outOfBandHostVerificationHint ~147-165) points the operator at `forge campaign reconcile` for exactly this shape. Net risk: resume refuses a failed-review item, but the operator is guided to `forge campaign reconcile` which ships it anyway — within the same session.

This is a PRE-EXISTING FG-443 seam (reconcile.ts unmodified by FG-441); FG-441 correctly does the events-aware thing on the resume path and deepens reliance on the inconsistency without closing it.

Fix direction: when an awaiting_gate/no-blockerKind item HAS a runId, route reconcile.ts (and report.ts's hint) through evaluateReconcileEvidence (events-aware) — or require the item to ALSO pass it — before the out-of-band evaluator, so resume and reconcile cannot ship opposite verdicts for the same row. An item with NO runId keeps the pure out-of-band path.

Non-goal: do not weaken the legitimate out-of-band delivery case (item genuinely delivered outside any run, no runId).