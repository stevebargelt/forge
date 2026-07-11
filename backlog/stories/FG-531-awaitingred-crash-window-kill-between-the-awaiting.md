---
id: FG-531
type: story
status: active
title: "awaiting_red crash window: kill between the awaiting_red status write and the reds' terminal write wedges the task permanently (no sweep, no re-admit, no operator verb)"
created: 2026-07-11
---

## Problem

Found by the FG-530 crash-point matrix (kill point FG-530-A): a crash between dispatchSingleStep's `awaiting_red` status write and the reds' terminal write leaves the task at `awaiting_red` with no exit: reconcile won't sweep it (not `running`), the ready queue won't re-admit the phase (a non-pending attempt row exists), and neither `forge gate` nor `forge retry` accepts an `awaiting_red` task. Permanent wedge — violates the "every non-terminal state has an enabled transition or a named operator verb" invariant.

Pinned as a known-failure matrix cell in src/v2/fg530-crash-matrix.integration.test.ts (id FG-530-A) — flip it to a passing assertion when fixing.

## Acceptance Criteria

- The awaiting_red crash window has a recovery path: reconcile detects the container-gone/never-dispatched-reds shape and re-drives or fails it with a retryable kind, OR an operator verb accepts the state — deliberate design choice, documented.
- The FG-530-A matrix cell flips from todo/known-failure to a passing invariant assertion.
- No new status value without an ADR (house rule).

## Fanout-parent variant (2026-07-11, FG-530 matrix)

The same window exists on the fanout path: a crash between dispatchFanoutStep's awaiting_red status write and its reds' terminal write wedges the PARENT at awaiting_red with dead red children — the wave's completed children are stranded behind it. Pinned as a second FG-530-A known-failure cell. The fix must cover both the single-step and fanout-parent shapes (flip both cells).

## Notes

Filed 2026-07-11 from the FG-530 crash matrix. Relates: FG-477 (lifecycle evaluator), FG-479 (orphaned_needs_finalize precedent for preserved-work recovery kinds).

