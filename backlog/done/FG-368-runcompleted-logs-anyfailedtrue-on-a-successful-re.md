---
id: FG-368
type: story
status: done
title: run.completed logs anyFailed:true on a successful request-changes retry run (telemetry inaccuracy)
created: 2026-06-22
closed: 2026-06-23
---

**Found:** 2026-06-22, red-backend confirmation of the FG-364 hardening.

**Issue:** After FG-364, a request-changes retry that ultimately SUCCEEDS still leaves the superseded old parent in `failed` status (correct — it's an audit record). But the `run.completed` event logs `anyFailed: true` because a failed task exists in the run, even though the run completed successfully. The run STATUS is correct (`complete`); only the event-payload `anyFailed` flag is misleading.

**Impact:** telemetry/observability only — dashboards or log consumers reading `anyFailed` on `run.completed` would over-report failures for any run that went through a successful request-changes retry. No correctness/state-machine impact.

**Fix sketch:** when computing `anyFailed` for the `run.completed` event, exclude tasks that were superseded by a request-changes replacement (e.g. a task that is `failed` but has a later pending/complete replacement primary for the same phase, or tag superseded tasks so the rollup ignores them).

**Also (low, from same review):**
- `updateTaskPackageInputs` silently no-ops if the task vanished; the subsequent `getTask(...)!` is unchecked — add a guard.
- FG-364 fan-out `requestedChanges` rationale lives on the parent package but is not forwarded into children's inputs. AC was satisfied (parent OR children), but forwarding to children would give retry workers the specific guidance directly. Optional enhancement.

**Scope:** small, isolated to the run-completion event rollup (+ two minor guards). Relates to FG-364.
