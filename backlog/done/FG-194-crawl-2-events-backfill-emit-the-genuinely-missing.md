---
id: FG-194
type: story
status: done
title: "Crawl 2 — events-backfill: emit the genuinely-missing lifecycle events"
---

**Closed:** 2026-05-30.

Crawl milestone, step 2 of 5 (docs/observability.md, Crawl §2). Depends on Crawl 1 (read path) so the new events are actually visible.

**Only backfill what's genuinely missing.** Already emitted today (do NOT re-add): run.created, run.completed, run.cancelled, task.created, task.started, task.completed, task.failed, task.cancelled (#186), task.awaiting_red, task.blocked_by_red, gate.decided, verdict.received.

**The real gap to fill:**
- run.abandoned — NOT in the EventType union at all; add it. forge abandons runs (cancel/reaper) but emits no abandon event.
- task.awaiting_gate — emitted nowhere; add on the awaiting-gate transition.
- container.started / container.exited / container.killed / container.idle_timeout — none exist.
- auth.profile_applied / auth.profile_failed — the #176 auth epic emits ZERO events; add when forge stages auth state (applied) and when AuthProfileError throws (failed).
- Remove the DEAD enum values task.idle_timeout and task.crashed from EventType — they're in the union (events.ts:13-14) but no logEvent call ever fires them. Their meaning moves to failure_kind (Crawl 3).

**Naming decision (settled):** container.idle_timeout is the INFRA event (watchdog fired, container killed). The TASK outcome stays task.failed carrying failure_kind: idle_timeout (Crawl 3). Likewise container.exited(nonzero)+no result → task.failed + failure_kind: container_crash. Do not emit a separate task.idle_timeout/task.crashed event — failure_kind carries the distinction.

**Land mine — container.* events emit from the CALLER, not the executor.** src/v2/docker-exec.ts (DockerExecFn) has no taskId/runId and is on the do-not-touch-without-a-learnings-entry list. Emit from src/v2/invoke.ts and src/v2/runNext.ts which hold runId+taskId: container.started before the exec call, container.exited/killed/idle_timeout after, deriving idle from the existing IDLE_TIMEOUT_EXIT_CODE the executor returns.

**Acceptance:** every status transition emits an event; forge cancel, idle timeout, gate decisions, auth failures, red blocks all visible via Crawl 1's forge show timeline.