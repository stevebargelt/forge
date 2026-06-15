---
id: FG-232
type: story
status: active
title: forge invoke retry orphans the task when the failed attempt already auto-closed the run
---

Hit during the AWN-7 Pixtron regression Test 1. Sequence:
1. `forge invoke engineer` — attempt 1 idle_timeout'd (task failed).
2. A `forge invoke` run auto-closes when its lone top-level task terminates (closeRunIfIdle in invoke.ts fires on complete OR failed). So the failed attempt flipped the run to `complete`.
3. A subsequent `forge retry` created a PENDING task against that now-complete run, and `forge next` refused to dispatch it (run is terminal) → the retry task is orphaned (pending forever, never runs).
4. Workaround that worked: a fresh `forge invoke` (new run) succeeded in 50s — so the underlying hang was transient (typecheck), not the retry path.

Bug: retry must not strand a task. Either (a) `forge retry` should reactivate the run (run.status -> active) when it attaches a retry task to a terminal run — mirroring invoke.ts #201's reactivation on attach; or (b) `forge next` should reactivate a complete run that has a fresh pending task; or (c) retrying the sole task of an auto-closed invoke run is disallowed with a clear message pointing at re-invoke.

Likely interaction between the invoke auto-close (closeRunIfIdle) and AWN-3 retry (retry creates a primary task). Relates to AWN-2/AWN-3 run-state + #201 reactivation. Repro is reliable: idle_timeout (or any failure) a single-task invoke run, then `forge retry` it.