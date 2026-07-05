---
id: FG-460
type: story
status: done
title: campaign resume refuses docs-only (non_code_diff) awaiting_gate+runId items that reconcile correctly ships — unify resume/reconcile evaluation on the host-verification/lane axis
created: 2026-07-04
closed: 2026-07-05
closed_commit: fd1b5d3
---

## Problem

Surfaced by the FG-458 review-loop (run-review-loop-fg-458-5a9a92, red-wide finding on reconcile.ts). FG-458 closed the AUTHORITATIVE-OUTCOME axis of the reconcile↔resume divergence (an unresolved authoritative fail now refuses in both). But a SECOND axis remains, on host-verification / lane evidence:

For an `awaiting_gate`, no-blockerKind item WITH a runId whose closing commit is DOCS-ONLY (non_code_diff lane) and whose run has a clean/resolved authoritative outcome:
- `forge campaign reconcile` (out-of-band branch) SHIPS it — correct: the non_code_diff lane needs no host verification (FG-452).
- `forge campaign resume` (executor.ts:684-686, FG-441 reattach) REFUSES it — evaluateReconcileEvidence reports `host_verification_not_recorded` because that evaluator has no non_code_diff lane; it demands a host-verification row even for a docs-only commit.

So the two paths still ship OPPOSITE verdicts for the same row — the class FG-458's AC targets — just on the host-verification axis instead of the authoritative-outcome axis.

## Why this is a SEPARATE ticket from FG-458 (scope note)

- PRE-EXISTING: this divergence predates FG-458 and was not introduced by it. reconcile already shipped docs-only via non_code_diff; resume already refused via host_verification_not_recorded.
- RESUME-SIDE: the incorrect side is resume (executor.ts's evaluator choice), NOT reconcile.ts. FG-458 is a reconcile-side ticket ('campaign reconcile: route awaiting_gate+runId...'). FG-458's fix deliberately did NOT fold host-verification into reconcile's events-aware check, because doing so would deadlock the code-touching capture path (a not-yet-captured item shows host_verification_not_recorded on both evaluators forever, blocking the very capture meant to resolve it).
- SAFE DIRECTION: reconcile ships correctly; resume is overly-strict (refuses a safe docs-only item). No unsafe behavior ships. Contrast FG-458's original DANGEROUS case (reconcile shipping a failed-review item resume correctly refused).
- NOT IN FG-458's BODY: FG-458 is specifically about the unresolved-authoritative-fail case (FG-441 review findings 1b+2).

## Fix direction (decide at implementation)

Make resume and reconcile use CONSISTENT evaluation for an awaiting_gate+no-blockerKind+runId item so they cannot disagree by construction. Likely: teach resume's reattach evaluation (executor.ts:684-686) to be non_code_diff-aware (use / compose the out-of-band lane evaluation for out-of-band-shaped items), so resume ships a docs-only item that reconcile ships. This WIDENS what resume ships (a trust-gate change on the resume side) — needs its own negative tests: docs-only+clean → both ship; docs-only+unresolved-authoritative-fail → both refuse; code-touching+no-host-verification → both refuse (resume must NOT start shipping un-verified code).

## Acceptance criteria

- For every awaiting_gate+no-blockerKind+runId item shape, `forge campaign resume` and `forge campaign reconcile` reach the SAME ship/refuse verdict (tested across: docs-only clean, docs-only with unresolved authoritative fail, code-touching with/without passing host-verification, no-runId).
- resume does NOT start shipping code-touching items that lack a passing host-verification row (the widening is scoped to the non_code_diff lane only).
- docs/concepts.md 'Shape 2 evidence' section reconciled to whichever unified model is chosen.

## Pointers
- src/campaign/executor.ts:684-686 (resume reattach evaluation).
- src/campaign/reconcile.ts isOutOfBand branch (FG-458 authoritative-outcome composition).
- src/campaign/reconcile-evidence.ts (evaluateReconcileEvidence, host_verification codes) vs reconcile-outofband-evidence.ts (non_code_diff lane).
- FG-458 (authoritative-outcome axis, done), FG-452 (non_code_diff lane origin), FG-441 (resume reattach).