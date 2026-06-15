---
id: FG-204
type: story
status: done
title: "WALK-1 live-task-activity: show running task last-output time + idle countdown in status/show/watch"
---

**Closed:** 2026-05-30. Commit `6cd3a5d`.

Observability WALK stage, §1 (docs/observability.md:309). Make ACTIVE tasks
inspectable while still running — the Crawl work made completed/failed work
explainable; this makes in-flight work observable.

For a running task, surface:
- startedAt
- last stdout/stderr output time (we have getLastOutputMtime in show.ts already)
- idle duration (now - last output)
- idle timeout threshold (now recorded per-task in manifest.json — see Crawl
  idle-timeout fix; use the recorded value, fall back to default)
- container name
- current status
- last lifecycle event

Surfaces (this ticket = the CLI read surfaces; dashboard split to WALK-5):
- `forge show <task-id>` — already shows last-output + idle timeout for any task;
  extend to show a live idle COUNTDOWN (time remaining before idle kill) when
  status=running.
- `forge status` — add per-running-task last-output age + idle countdown column.

Builds on: idle watchdog, live log streaming, the Crawl show.ts diagnostic
helpers (getLastOutputMtime, formatTimeAgo, getManifestIdleTimeoutMs).

Acceptance:
- A running task's `forge show` shows "idle Xs / timeout Ym (Zs left)".
- `forge status` shows last-output age for running tasks so a stalled task is
  obvious without opening show.
- Pure-function-friendly so the countdown math is unit-testable.