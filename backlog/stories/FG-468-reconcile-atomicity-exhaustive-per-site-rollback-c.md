---
id: FG-468
type: story
status: active
title: "reconcile atomicity: exhaustive per-site rollback coverage + make finalizeOrphanedPrimaries writer-injectable"
created: 2026-07-05
---

## Problem
FG-463 wrapped ~10 reconcileRun write+event groups in transactions and covers rollback via representative tests (fail-branch, complete-branch, Mode-A backfill). Two review pass-notes remain:
1. The other sites (provisioning-crash, recovered-from-stdout, oom_killed, orphaned_work_may_persist, fanout-parent complete/failed, run-level complete) rely on the mechanical pattern + SQL-rollback-on-any-exception rather than an individual rollback test.
2. `finalizeOrphanedPrimaries` calls the module-level markTaskFailed/logEvent (no `writers` param), so the writeThenBusyOn/writers seam cannot induce a throw in it — it is covered by inspection only.

## Severity
Low / test-coverage. The transaction wrapping is mechanically identical across sites and SQL rolls back on ANY exception in the txn, so the representative tests + FG-459's per-site write-throw tests give good coverage. This is thoroughness, not a known defect (FG-463 review passed).

## Direction
- Add a rollback test per remaining site (or a table-driven helper).
- Thread a `writers`-style seam (or injectable logEvent) into finalizeOrphanedPrimaries so its transaction wrapping is throw-testable like the others.

## Reference
src/v2/reconcile.ts (transaction groups) + src/v2/reconcile.test.ts (writeThenBusyOn). FG-463 review-loop run-review-loop-fg-463-1ad87a round-1 pass-notes.