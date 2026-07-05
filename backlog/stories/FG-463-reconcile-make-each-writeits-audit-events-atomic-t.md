---
id: FG-463
type: story
status: active
title: "reconcile: make each write+its-audit-events atomic (transaction) so a mid-sequence SQLITE_BUSY can't leave a status change without its task.reconciled event"
created: 2026-07-05
---

## Problem

Surfaced by the FG-459 review-loop (`run-review-loop-fg-459-800e30`, red-wide PASS-level finding on reconcile.ts). FG-459 wrapped each of reconcileRun's write+audit-event groups in a never-throw try/catch so a DB-layer throw (SQLITE_BUSY under two concurrent forge processes) no longer propagates out of reconcileRun and no longer aborts the other tasks/passes.

But the guard is COARSE: it wraps `write` + its paired `logEvent("task.completed"/"task.reconciled")` calls together. If the status write commits and a SUBSEQUENT logEvent on the same connection throws SQLITE_BUSY, the catch swallows it — leaving the task's status changed WITHOUT its paired reconciled/terminal event. That weakens the module's documented header invariant ("It NEVER silently rewrites state: every change emits a task.reconciled event alongside the normal terminal event").

## Why SEPARATE from FG-459 (scope note)

- PRE-EXISTING: the write and its events were never in a transaction together, so this partial-write-without-event window predates FG-459. The OLD code committed markTaskComplete/Failed and then propagated the throw at the later logEvent (the very bug FG-459 fixes) — the DB was already left status-changed-without-full-events. FG-459 changes the aftermath (swallow + idempotent retry) but neither introduces nor is required to fix the atomicity gap.
- FG-459's core invariant is never-throw + don't-abort-other-tasks — both delivered and tested (markTaskComplete/markTaskFailed/backfillTaskResult throw-injection + the fanout-parent pass). Audit-event atomicity is NOT required to preserve that.
- Fail-safe: the STATUS transition is still correct and idempotent; only the audit EVENT may be missing under an extreme race. No wrong-ship, data loss, or trust bypass.

## Fix direction

Wrap each (status write + its paired logEvent calls) in a single better-sqlite3 transaction (`getDb().transaction(fn)()`) so they commit all-or-nothing. A SQLITE_BUSY on any statement rolls the whole group back; the existing FG-459 outer try/catch swallows the rollback throw and a later idempotent reconcile pass re-applies the whole group cleanly (no duplicate events, since a rolled-back attempt inserts nothing). Keep fs/worktree cleanup (writeFileSync result.json, cleanupStagedAuth, removeWorktreeIfSafe) OUTSIDE the transaction — they are not DB ops and must not hold a write lock.

Sites (all in reconcile.ts): provisioning-crash fail; container-gone valid-result complete; recovered-from-stdout complete; oom_killed / orphaned_work_may_persist / orphaned fails; Mode A backfill; fanout-parent complete/failed; finalizeOrphanedPrimaries.

## Acceptance Criteria

- Each status write + its paired audit events in reconcileRun commit atomically (transaction): either the status change AND its task.reconciled/terminal event both land, or neither does.
- Still never throws out of reconcileRun and still does not abort the other tasks/passes (FG-459's guarantees preserved).
- Test: inject a writer/logEvent that throws AFTER the status write within one group and assert the status did NOT change (rolled back) and no partial event was recorded — the group is retried whole on a later pass.

## References
- FG-459 (never-throw guards, done) — this refines its coarse catch into atomic groups.
- src/v2/reconcile.ts (all reconcileRun write+event groups); src/store/db.ts (getDb transaction).
