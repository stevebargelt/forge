---
id: FG-532
type: story
status: active
title: forge gate reject discards the rejected task's persisted result — failTask() called without result, losing the audit record
created: 2026-07-11
---

## Problem

Found by the FG-530 crash-point matrix (id FG-530-B): `forge gate <id> reject`'s branch in src/v2/gate.ts calls failTask() WITHOUT the task's existing `result`, nulling the persisted result of the rejected task. The adjacent request-changes branch passes the result through deliberately. The rejected artifact is the audit record for WHY it was rejected — discarding it violates the "persisted work never discarded" invariant and destroys review evidence.

Pinned as a known-failure matrix cell in src/v2/fg530-crash-matrix.integration.test.ts (id FG-530-B) — flip it when fixing.

## Acceptance Criteria

- Rejecting a task preserves its persisted result (match the request-changes branch's handling).
- Regression test: reject a task with a result → result survives on the failed row; on_reject recovery still receives rejectedRationale/rejectedTaskId as today.
- The FG-530-B matrix cell flips from todo/known-failure to a passing invariant assertion.

## Notes

Filed 2026-07-11 from the FG-530 crash matrix. Small, isolated fix; candidate for the next quick queue.
