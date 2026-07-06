---
id: FG-431
type: story
status: done
title: "campaign reconcile: improve inconclusive-supersession refusal label + canonicalize project_dir between host-verification recording and lookup (FG-428 red-wide lows)"
created: 2026-07-02
closed: 2026-07-06
closed_commit: 4cd28cb
---

## Problem

FG-428 shipped the evidence-gated `forge campaign reconcile <campaign-id>` recovery path and resolved the wrong-ship-capable review findings. Red-wide re-check still found two low-severity follow-ups that are fail-safe but worth cleaning up:

1. When supersession fails because the latest authoritative verdict is `inconclusive` rather than `fail`, the refusal reason still uses the fail-oriented label. The item is correctly refused; the operator-facing reason is imprecise.
2. Host-verification lookup exact-matches `project_dir`, while the recording path can accept a relative or otherwise non-canonical project path. Legitimate host-verification evidence may then be unmatchable by reconcile, causing a false `host_verification_missing_or_not_all_exit_zero` refusal.

Both issues fail closed: they can prevent recovery or make a refusal confusing, but they do not allow an item to be marked shipped without durable evidence.

## Goal

Polish FG-428 reconcile follow-ups so false refusals and misleading refusal reasons are reduced, without weakening the evidence gate or expanding into FG-427 automatic reconciliation.

## Acceptance Criteria

- Supersession refusal reasons distinguish at least these cases:
  - no authoritative verdict or qualifying force-advance event exists
  - latest authoritative verdict is `fail` with no later pass or qualifying force-advance
  - latest authoritative verdict is `inconclusive` with no later pass or qualifying force-advance
- Existing fail-safe behavior is preserved: `inconclusive` does NOT qualify as shipped evidence.
- Tests cover the inconclusive-latest-authoritative case and assert the new/refined missing reason.
- Host-verification recording and lookup use a consistent canonical `projectDir` representation, so evidence recorded with a relative path or equivalent path resolves the same way reconcile lookup expects.
- Tests cover project-dir normalization on both sides of host-verification evidence: a row recorded through the public recorder path with a non-canonical/equivalent project path is discoverable by reconcile for the campaign project.
- No operator-provided evidence string, force flag, or manual mark-shipped path is introduced.

## Non-Goals

- Does not change the FG-428 shipped evidence threshold.
- Does not implement FG-427 automatic normal-path reconciliation.
- Does not make host verification looser; it only canonicalizes identity so legitimate evidence is not missed.

## Priority / Disposition

Follow-up, not campaign-blocking. These findings are fail-safe lows: they can over-refuse or mislabel a refusal, but cannot wrongly ship an item.

## Relations

- Follow-up from FG-428 red-wide lows.
- Related to FG-419 trust-gate evidence discipline.
- Related to FG-427 only conceptually; do not fold automatic reconciliation into this ticket.