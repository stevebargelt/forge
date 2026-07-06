---
id: FG-444
type: story
status: done
title: campaign report/show only surfaces out-of-band eligibility for the FIRST parked item; multi-item paused campaigns hide it for the rest
created: 2026-07-03
closed: 2026-07-06
closed_commit: 3f48bd6
---

## Problem
`forge campaign report` / `show` surface out-of-band completion eligibility ("<ticket> delivered out-of-band — eligible for evidence-gated completion via forge campaign reconcile") only for the FIRST parked item. `computeNextShowAction` (src/campaign/report.ts) picks a single `gateParkedItem` via `items.find(i => lifecycleStatus === 'awaiting_gate' || 'blocked_by_red')` and calls the per-item `outOfBandCompletableAction()` on just that one. In a campaign with MULTIPLE concurrently-parked items (e.g. several out-of-band deliveries), only one item's eligibility is shown; the rest are hidden — the operator can't see that the other parked items are also reconcile-eligible. Documented as a known gap at docs/concepts.md ("this out-of-band check only applies to the first parked item found ... tracked as FG-444").

## Goal
Surface out-of-band completion eligibility (and the related host-verification reconcile hint) for EVERY parked item in a paused/multi-parked campaign, not just the first — in both the JSON item rows and the human-readable `show`/`report` output — without changing the single top-level `Next action` recommendation semantics.

## Acceptance Criteria
- Each parked item (`lifecycleStatus: awaiting_gate` with no `blockerKind`, or the blocked_by_red out-of-band shape) independently carries its out-of-band eligibility in the per-item data: a per-item field (e.g. `outOfBandEligible: boolean` and/or the existing `hostVerificationReconcileHint`) computed for THAT item, exposed in `forge campaign report --json` / `show --json` item rows.
- Human-readable `show`/`report` prints the out-of-band eligibility hint for each eligible parked item (per-item line), so a campaign with N concurrently-parked eligible items shows all N, not 1.
- The single top-level `Next action` line is unchanged in shape (still one recommended next step); this ticket only broadens per-item surfacing, it does not multiply the Next action line.
- Eligibility is computed with the SAME evaluator the reconcile path uses (`evaluateOutOfBandEvidence` + the FG-458 authoritative-outcome check) — no divergence between what `report`/`show` claims eligible and what `reconcile` would actually ship.
- Tests: a campaign with ≥2 concurrently-parked out-of-band-eligible items asserts every eligible item's hint is surfaced (JSON + rendered text); a mixed case (one eligible, one not) asserts only the eligible ones are marked.

## Non-Goals
- Does not change the single `Next action` recommendation logic beyond per-item surfacing.
- Does not change reconcile/resume completion behavior — display/reporting only.

## Reference
src/campaign/report.ts (outOfBandCompletableAction:111, computeNextShowAction / gateParkedItem find:~204/318), src/cli/commands/campaign.ts:683 (hostVerificationReconcileHint per-item print). Concepts note: docs/concepts.md campaign section. Sibling of FG-460/FG-458 out-of-band model.
