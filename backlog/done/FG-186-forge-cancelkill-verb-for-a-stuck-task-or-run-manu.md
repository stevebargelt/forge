---
id: FG-186
type: story
status: done
title: forge cancel/kill verb for a stuck task or run (manual reaper)
---

**Closed:** 2026-05-29.

**From the #185 discussion.** There's no CLI to terminate a task stuck in a non-terminal state or to kill its container. When a task orphaned (parent died, see #185), the only way to clear it was poking the DB directly via store accessors (markTaskFailed + updateRunStatus). `gate` only handles awaiting_gate; `retry` only resets failed; `sweep` only closes runs whose tasks are ALL terminal.

Add a `forge cancel <task-id|run-id>` (or `forge sweep --running-orphans`) that: docker-kills `forge-<taskId>` if present, marks the task failed, and abandons the run. This is the manual counterpart to #185's automatic reaper — file alongside it. No schema change.

Relates to #185 (parent-died orphan reaper), #173 (idle-watchdog).