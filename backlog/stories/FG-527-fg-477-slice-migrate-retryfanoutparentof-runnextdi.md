---
id: FG-527
type: story
status: active
title: "FG-477 slice: migrate retry.fanoutParentOf + runNext.dispatchFanoutStep to the lineage classifier (deliberate behavior changes: shipping-reviewer red-prefix misclassification, missing ad-hoc exclusion)"
created: 2026-07-11
---

## Problem

FG-477 slice 1 (the lineage classifier) migrated three consumers with byte-identical behavior. Two were DEFERRED under the migration-freeze rule because the classifier and the legacy heuristic genuinely disagree on reachable shapes — both disagreements are pinned by tests in src/v2/lifecycle-evaluator.test.ts (the "recorded disagreements" section), so this ticket is executing a recorded decision, not rediscovering it.

1. **retry.ts fanoutParentOf** — legacy identifies a red child by the `red-` role-name prefix. feature.yml's `build` fanout step includes the `shipping-reviewer` red (no `red-` prefix), so legacy calls a failed shipping-reviewer a fanout child and refuses `forge retry` with FanoutChildRetryError; the classifier calls it red_review and would allow the retry. Reachable today (dispatchReds pre-fails shipping-reviewer on missing required context). The classifier's answer is correct; migrating CHANGES operator-visible retry behavior — deliberately.

2. **runNext.ts dispatchFanoutStep** — (a) same `red-` prefix bug in its child filters (activeWithChildren / pendingHasChildren / childTasksForCleanup); decisions coincide today by accident (reds have no worktreePath to clean up). (b) its existingParent lookup lacks dispatchSingleStep's FG-507 ad-hoc exclusion: on a workflow whose FANOUT step is named `task`, a pending invoke row would be adopted as the fanout parent. The classifier excludes it.

## Acceptance Criteria

- Both sites classify through classifyTaskLineage / the exported single-row primitives; the `red-` prefix convention is dead in both.
- The retry behavior change is explicit: a failed shipping-reviewer (or any non-`red-`-prefixed red) on a fanout step is retryable as red_review, with a test; FanoutChildRetryError still fires for real fanout children.
- The dispatchFanoutStep ad-hoc exclusion is tested with the FG-507 shape (pending invoke row on a workflow whose fanout step is named `task`).
- The pinned disagreement tests in lifecycle-evaluator.test.ts flip from documenting divergence to asserting agreement.

## Notes

Filed 2026-07-10 from the FG-477 slice-1 engineer report (run-fg-477-slice-1-lineage-classifier-060342). Parent: FG-477 (do not close it on this ticket either — later slices remain).
