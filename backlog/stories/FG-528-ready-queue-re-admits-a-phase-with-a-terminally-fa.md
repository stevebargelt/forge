---
id: FG-528
type: story
status: active
title: ready-queue re-admits a phase with a terminally-failed primary while a non-primary child is pending — dispatchSingleStep mints a fresh primary and re-runs the step
created: 2026-07-11
---

## Problem

computeReadyQueue's "is any row pending" check (src/v2/ready-queue.ts:~105) runs over all non-adhoc rows — red/fanout/recovery children included. So a phase shaped [terminally FAILED primary + pending red child] falls through to the deps check and goes READY; dispatchSingleStep finds no pending workflow-primary row to reuse and mints a FRESH primary, silently re-running a failed step.

Verified empirically by the FG-477 slice-1 test-engineer BOTH against the migrated ready-queue and against `git show HEAD:src/v2/ready-queue.ts` — pre-existing, not a slice-1 regression (with a COMPLETE red child both correctly return []). Deliberately NOT pinned by a test (pinning would enshrine it).

It contradicts the classifier's thesis (only primaries drive a phase's dispatch decision) — exactly what FG-477 exists to make true.

## Acceptance Criteria

- A phase with a terminally failed primary is not re-admitted by pending non-primary children; the failed primary's recovery goes through the existing verbs (retry / gate on_reject), never a silently minted fresh primary.
- Regression test for [failed primary + pending red child] → not ready; [failed primary + pending recovery row] keeps today's recovery-dispatch behavior.
- Behavior change is deliberate and documented (this is a state-derivation change — out of slice-1's classification-only scope by design).

## Notes

Filed 2026-07-10 from the FG-477 slice-1 test-engineer report (run-fg-477-slice-1-lineage-classifier-060342, task-task-6fc14f, FINDING 1). Parent umbrella: FG-477; sibling: FG-527.
