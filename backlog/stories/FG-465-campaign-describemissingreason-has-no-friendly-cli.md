---
id: FG-465
type: story
status: active
title: "campaign: describeMissingReason has no friendly CLI text for lane_evidence_missing / run_evidence:<code> refusal reasons (fall through to raw code)"
created: 2026-07-05
---

## Problem

Surfaced by the FG-460 review-loop (run-review-loop-fg-460-362206, red-wide round-2 minor finding). `describeMissingReason` (src/campaign/reconcile-evidence.ts) renders friendly explanatory CLI text for `host_verification_not_recorded` and `host_verification_recorded_but_failed`, but has NO case for the other refusal reason codes that the out-of-band composition surfaces: `lane_evidence_missing` (FG-452) and the `run_evidence:<code>` prefixed authoritative-outcome codes (FG-458). Those fall through to the default branch and render as the raw code on the human-readable `forge campaign reconcile` / `show` / `report` surfaces.

## Why SEPARATE from FG-460 (scope note)

- PRE-EXISTING: `lane_evidence_missing` predates FG-460 (FG-452); `run_evidence:` predates it (FG-458). FG-460 neither introduced nor regressed this.
- NOT in FG-460's AC. FG-460 unifies the resume/reconcile EVALUATION so they can't disagree; the operator-visible *phrasing* of the shared reason codes is a separate polish item.
- Fail-safe: the raw code still renders (nothing breaks); it's just less friendly than the host_verification codes.

## Acceptance Criteria

- `describeMissingReason` returns friendly explanatory text for `lane_evidence_missing` (docs-only lane not satisfied AND no covering passing host-verification row) and for a `run_evidence:<code>` prefixed code (the run's own authoritative review is unresolved), consistent in tone with the existing host_verification cases.
- Unrecognized codes still pass through unchanged.
- Test covers each new case.

## References
- src/campaign/reconcile-evidence.ts (describeMissingReason). FG-460 (evaluation unification, done), FG-452 (lane_evidence_missing), FG-458 (run_evidence:).
