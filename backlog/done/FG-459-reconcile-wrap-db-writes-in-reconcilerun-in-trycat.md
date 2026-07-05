---
id: FG-459
type: story
status: done
title: "reconcile: wrap DB writes in reconcileRun in try/catch to honor the documented never-throw invariant (SQLITE_BUSY under concurrent forge processes)"
created: 2026-07-04
closed: 2026-07-05
closed_commit: 193220b
---

## Problem

FG-455 p4 red-wide review (LOW finding, confidence 0.4, residual_risk) noted: in reconcileRun, DB-write calls (markTaskComplete / markTaskFailed / backfillTaskResult) are NOT wrapped in try/catch, so a DB-layer throw (SQLITE_BUSY under concurrent forge processes both reconciling — e.g. `forge status` + `forge next` — disk-full, etc.) would propagate out of reconcileRun. The module comments state reconcileRun must NEVER throw; the file/docker READ side already honors this (every read safe-denies on error), but the WRITE side does not.

This is a PRE-EXISTING pattern (all reconcileRun DB writes are unwrapped), not an FG-455 p4 regression — which is why p4 did not partial-fix only its own backfillTaskResult call (that would be inconsistent). Tracking a holistic fix here.

## Acceptance Criteria

- reconcileRun's DB-write calls (markTaskComplete, markTaskFailed, backfillTaskResult, and any others in the function) are wrapped so a DB-layer throw does not propagate out of reconcileRun — consistent with the never-throw invariant the module documents and the read side already upholds.
- A throw from a DB write during one task's reconcile does not abort reconcile of the other tasks/passes in the same run (fanout-parent pass, run-completion check still run).
- Test: inject a DB accessor that throws (SQLITE_BUSY-shaped) on a write and assert reconcileRun does not throw and still processes remaining tasks.

## Pointers
- src/v2/reconcile.ts — reconcileRun DB writes (backfillTaskResult call ~line 442; markTaskComplete/markTaskFailed throughout the container-gone branch).
- Surfaced by FG-455 p4 review (run-fg-455-p4-oom-classification-mode-a-backfill-f86dbe, red-wide task-red-wide-16447f, finding 6).