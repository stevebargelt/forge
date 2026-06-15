---
id: FG-185
type: story
status: active
title: Reaper for tasks orphaned when the parent forge process is killed (#173 Tier-2, hit live)
---

**Hit live 2026-05-29** running a parallel red panel wrapped in `timeout 600 bash -c "forge invoke ... & ... & wait"`. The wall-clock timeout killed the parent forge processes mid-review. The `docker run --rm` containers were torn down (verified: no forge-* container running or exited afterward), but the killed task stayed `status=running` forever — the dashboard/`forge status` showed it "running for an hour" when nothing was actually running.

**Root cause:** the idle-watchdog is in-process (#173 Tier 0+1). When the parent forge process dies (SIGKILL/SIGTERM from an external `timeout`, a crash, a closed terminal), the watchdog dies with it, so nothing transitions the in-flight task to a terminal state. `forge sweep` doesn't catch it (it only closes runs whose tasks are ALL terminal; a stuck `running` task isn't terminal). `forge retry` only resets `failed` tasks. There's no CLI to fail/reap a stuck-`running` task — had to mark it via the store accessors directly (markTaskFailed + updateRunStatus("abandoned")).

This is the #173 Tier-2 "dead-container / parent-died orphan" case that was explicitly deferred (schema-gated on tasks.container_id). The deferral reasoning holds, but this is a concrete recurrence worth a lightweight fix.

**Options:**
- A reaper pass (extend `forge sweep`): for runs that are `active` with a task `running` whose container (by name `forge-<taskId>`) is absent from `docker ps`, mark the task failed + run abandoned. Needs the container-name → docker-ps check (no schema change required — derive the name).
- Persist a heartbeat/PID per running task; sweep reaps tasks whose owning PID is dead.
- A `forge cancel <task-or-run>` / `forge sweep --running-orphans` CLI verb so this doesn't require poking the DB by hand.

**Operational note:** don't wrap `forge invoke` in an external `timeout` — rely on the per-agent idle-watchdog (10m) instead; an external timeout that kills the parent orphans the task. For parallel panels, launch and let the idle-watchdog bound each agent.

Relates to #173 (idle-watchdog, closed).