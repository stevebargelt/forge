---
id: FG-205
type: story
status: done
title: "WALK-2 watch-activity: forge watch --json emits structured task-activity + failure-kind events"
---

**Closed:** 2026-05-30. Commit `1dc3815`.

Observability WALK stage, §1 surface + trace-shape (docs/observability.md:326, 349).

Today `forge watch` emits one JSON event per state CHANGE (run/task status
transitions). WALK adds live ACTIVITY signal between transitions so a consumer
(orchestrator, dashboard, script) can see a running task is alive and progressing,
not just "still running".

Scope:
- `forge watch --json` should emit task-activity records for running tasks:
  last-output time, idle duration, idle countdown (reuse WALK-1 computation).
- Failure transitions in the stream should carry failure_kind (already in the
  task.failed event payload from Crawl) so a watcher branches on kind without
  parsing prose.
- Adopt the trace-shape fields opportunistically: include runId, taskId, and
  spanKind (run|task|docker|model|tool|auth|gate|red-review) on emitted records
  where applicable, per §3 Trace Shape (observability.md:349). This keeps an OTel
  export path open later (WALK/RUN-otel) without a rewrite now.

Depends on WALK-1 (#204) for the activity computation. Does NOT require agent
cooperation — derives everything from container lifecycle + log mtimes.

Acceptance:
- `forge watch --json` surfaces failure_kind on failure events.
- Running tasks emit periodic activity records (last-output age + idle countdown).
- Records carry runId/taskId and a spanKind where meaningful.