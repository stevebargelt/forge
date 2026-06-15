---
id: FG-210
type: story
status: done
title: "RUN-2 metrics: forge metrics — aggregate durations, failures, cancels, retries, red blocks"
---

**Closed:** 2026-05-30. Commit `b15d57a`.

Observability RUN stage §3 (docs/observability.md). Reliability/management metrics, distinct from forge usage (which is token/cost). Aggregate over runs/tasks/events:
- run success rate
- task failure kinds (counts by kind)
- median task duration by workflow/phase/role
- idle kills, cancel count, retry count, red block rate
- gate wait time

Command:
  forge metrics --since 30d
  forge metrics --by workflow|phase|role
  forge metrics --json

Notes:
- Median durations from task started_at/completed_at. failure_kind counts from task.failed event payloads. cancels from run.cancelled events / abandoned runs. retries from task.retried events. red blocks from task.blocked_by_red.
- No schema change. Pure aggregation helpers (testable) + thin CLI. Don't duplicate forge usage's token rollups — link to it.
- Depends conceptually on RUN-1's window/scan helpers; share them.