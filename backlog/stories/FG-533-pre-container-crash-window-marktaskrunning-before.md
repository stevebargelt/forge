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

Permanent wedge, same family as FG-531 (awaiting_red crash window). Found by FG-530's write-surface guard during development. The shipped harness carries NO deferred gap entries (DEFERRED_GAPS = 0): the window is probed at runContainer's pre-container span and pinned as an FG-533 known-failure matrix cell (both documented in docs/how-to-testing.md). Surfaced in the operator's 2026-07-11 review, filed on their direction.

## Acceptance Criteria

- The pre-container `running`-with-no-container.started shape has a recovery path that does NOT break the invoke/manual host-side exemption reconcile's comment defends (e.g. an age-gated sweep for runner-dispatched rows — dispatchSource 'workflow' per FG-512 — with no container.started and no live container; or a probe-time marker distinguishing "container launch attempted").
- Regression test through the real reconcile path: crash-shaped fixture (running, no container.started, runner-dispatched) → recovered/failed with a retryable kind, not skipped forever; an invoke host-side task in the same shape stays untouched.
- The FG-530 matrix registers this window as a known-failure cell (FG-533) until fixed, then flips it to a passing assertion.

## Notes

Filed 2026-07-11 during FG-530 + operator review finding 1. Siblings: FG-531, FG-532 (same crash-window family).


