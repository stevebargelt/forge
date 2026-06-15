---
id: FG-214
type: story
status: done
title: "AWN-1 lifecycle-recovery: reconcile active/running state after host crash, Docker races, interrupted commands"
---

**Closed:** 2026-05-30. Commit `2d29b4e`.

docs/agentic-workflow-next-steps.md §1. Make active/running state trustworthy after crashes.

UMBRELLA over #185 (reaper for orphaned-running tasks — hit live 2026-05-29) and related to #173 (idle-watchdog), #112/#109 (transactional dispatch). The reaper becomes one case of a general reconciliation pass.

Scope:
- Reconciliation path on first lifecycle-touching command (status/show/next/cancel).
- Detect: runs active with no live runnable work; tasks running whose container is gone; tasks with result files but unfinalized DB state; active-run-with-no-work.
- Emit reconciliation EVENTS (new event type, e.g. task.reconciled / run.reconciled) — never silently rewrite state. Idempotent.

Acceptance:
- Simulated host crash with a running task reconciles into a truthful terminal/resumable state.
- forge show <run> explains what reconciliation changed and why.
- Re-running reconciliation emits no duplicate terminal transitions.
- Tests: container-gone, container-still-running, result-present-unfinalized, active-run-no-work.

Subsumes #185 when it lands. First of the lifecycle-foundation trio (AWN-1/2/3).