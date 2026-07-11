---
id: FG-533
type: story
status: active
title: "pre-container crash window: markTaskRunning before container.started leaves a running task invisible to reconcile and ops sweeps — permanent wedge"
created: 2026-07-11
---

## Problem

src/v2/runNext.ts (runContainer, ~:2100) calls markTaskRunning + logs task.started BEFORE the container launches and container.started is logged. That span covers image pull, auth staging, and dependency provisioning — minutes. A crash inside it leaves a task `running` with NO container.started event, and every rescue path gates on exactly that event:

- reconcile.ts:472 — `if (!hasContainerStarted) continue` (deliberate: invoke/manual host-side tasks never launch containers, so container.started is the authoritative "forge launched a container" signal)
- src/ops/reconcile-candidate.ts's SQL gates on the same event
- `forge retry` refuses a non-failed task

Permanent wedge, same family as FG-531 (awaiting_red crash window). Found by FG-530's write-surface guard (documented in the guard's GAP allowlist entry, fg530-probe-inertness.test.ts ~:900); surfaced in the operator's 2026-07-11 review (finding 1), filed on their direction.

## Acceptance Criteria

- The pre-container `running`-with-no-container.started shape has a recovery path that does NOT break the invoke/manual host-side exemption reconcile's comment defends (e.g. an age-gated sweep for runner-dispatched rows — dispatchSource 'workflow' per FG-512 — with no container.started and no live container; or a probe-time marker distinguishing "container launch attempted").
- Regression test through the real reconcile path: crash-shaped fixture (running, no container.started, runner-dispatched) → recovered/failed with a retryable kind, not skipped forever; an invoke host-side task in the same shape stays untouched.
- The FG-530 matrix registers this window as a known-failure cell (FG-533) until fixed, then flips it to a passing assertion.

## Notes

Filed 2026-07-11 from the FG-530 write-surface guard + operator review finding 1. Siblings: FG-531, FG-532 (same crash-window family). NOTE: an earlier same-day filing of this ticket briefly collided with sticky number FG-530 because the crash-simulator's ticket file lived only on PR #103's branch — corrected by landing FG-530's file on main and re-filing; concrete evidence for FG-496 (DB-backed backlog).

