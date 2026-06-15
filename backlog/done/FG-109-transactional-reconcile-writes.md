---
id: FG-109
type: story
status: done
title: Transactional reconcile writes
---

**Closed:** 2026-05-12 on branch `transactional-writes-109` → merged to main. Test suite 341/341 (+3 reconcile tests). Scoped to reconcile only; dispatch + gate split out to #112.
- `src/spine/reconcile.ts`: per-task write batch wrapped in `getDb().transaction(...)`. Rollback on throw leaves the task in `running`; the next reconcile call re-attempts cleanly. Catch logs to stderr (not the DB — the failure may itself be a DB write failure).
- Added a test-only `_setReconcileFaultForTest(step, error)` hook + named fault points (`after-mark-blue`, `after-log-completed`, `after-insert-verdict`, `after-log-verdict`). Lets fault-injection tests verify rollback without monkey-patching the store module.
- 3 new tests: rollback on mid-sequence fault (after mark-blue) + rollback of both writes (verdict insert + parent transition) + retry-pin (subsequent reconcile succeeds).
**Unblocked by #111** — needed in-container test runs to do fault-injection work end-to-end.