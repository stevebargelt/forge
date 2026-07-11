---
id: FG-529
type: story
status: active
title: "FG-477 slice 1: task-lineage classifier + classification-only consumer migrations (ready-queue, dispatchSingleStep, finalizeOrphanedPrimaries) + FG-528 readiness fix"
created: 2026-07-11
---

## What this ticket is

The dispatch ticket for FG-477's slice 1, filed per FG-477's own next-step note ("dispatch slice 1 (the classifier) as its own ticketed implementation"). The work is on branch feat/fg-477-slice1-lineage-classifier (PR #102). FG-477 (the umbrella evaluator) stays open — its full AC is NOT this ticket's AC.

## Scope shipped

1. src/v2/lifecycle-evaluator.ts — classifyTaskLineage(workflow, tasks): pure, total, exhaustive 7-kind union (primary | retry_replacement | on_reject_recovery | red_review | fanout_child | adhoc_invoke | legacy_ambiguous_invoke), decision table per FG-477's architecture pass (provenance before lineage; rejectedTaskId marker before phase/role tests; red membership from workflow config, not the red- name prefix).
2. Classification-only migrations, byte-identical decisions: ready-queue.ts (wrappers preserved), runNext.ts dispatchSingleStep pending-row reuse, reconcile.ts finalizeOrphanedPrimaries.
3. FG-528 readiness fix (review round 1): computeReadyQueue answers "does this step still need dispatch" from ATTEMPT rows only (primary kinds + on_reject recovery); a pending red/fanout child no longer re-admits a terminally-failed phase. Regression tests for failed-primary+red-child, failed-primary+fanout-child (both not ready) and failed-primary+pending-recovery (ready, FG-476 preserved).

## Acceptance Criteria

- classifyTaskLineage exists, pure/total: seeded-generator totality (every row shape → exactly one kind) + input-order insensitivity tests.
- Decision-table unit tests rule by rule including priority collisions.
- Frozen-legacy behavior-parity tests for each migrated consumer (byte-identical decisions), including the ~3000-set parity on the dispatchSingleStep hot path.
- Flow-level integration suite through the real runner covering: gate-reject recovery pickup, replacement-row reuse, FG-507 non-adoption (+ marker-less legacy counterpart), orphan sweep sparing children, mixed-run settle parity, identical-createdAt tie, cross-phase rejectedTaskId.
- FG-528's three regression shapes pinned.
- Known non-goals recorded with owners: retry.fanoutParentOf + dispatchFanoutStep migrations → FG-527 (pinned disagreement tests in lifecycle-evaluator.test.ts); campaign executor migration → FG-477 slice 7; resolvePhasePrimary absorption → later slice (in-file rationale at its definition).

## Notes

Filed 2026-07-11. Parent: FG-477 (body records the slice). Deferred siblings: FG-527, FG-528 (fixed here — close against this PR's evidence).
