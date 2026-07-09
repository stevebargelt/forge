---
id: FG-503
type: story
status: done
title: "reap failures on successful tasks are silent and unsweepable: callers ignore reap_failed; ops reap-containers scans failed tasks only"
created: 2026-07-09
closed: 2026-07-09
closed_commit: 1b96936f5ba28a8fd73d1ed2525b088b00e5fbf7
---

## Problem

FG-492 (PR #78/#82) replaced `docker run --rm` with explicit outcome-keyed reaping. `finalizeContainerRetention` (src/v2/docker-exec.ts:142) correctly returns `reap_failed` when `docker rm -f -v` errors, but every production caller ignores the return value — src/v2/invoke.ts:678, src/v2/runNext.ts:680, src/v2/gate.ts:178. `forge ops reap-containers` (src/cli/commands/ops.ts:82) only scans `t.status = 'failed'` tasks. Net: a SUCCESSFUL task whose explicit cleanup fails leaves its stopped container and anonymous shadow volume (DEC-019) behind with no durable event, no dashboard surface, and no later reap candidate — a silent, unrecoverable leak on the success path. (Operator review finding, 2026-07-09, post-FG-492-merge.)

## Goal

Reap failure on a successful task is observable and sweepable: durable evidence when it happens, and the age-based sweeper covers completed tasks with unreaped containers.

## Acceptance Criteria

- [ ] When `finalizeContainerRetention(..., true)` returns `reap_failed`, the caller records durable evidence — a `container.reap_failed` event (or equivalent) carrying containerName and taskId — on all three call paths (invoke, runNext post-reds, gate advance-to-complete).
- [ ] `forge ops reap-containers` also scans COMPLETED tasks that have a `container.started` event and either a `container.reap_failed` event or no successful-reap marker, so a leaked successful container is sweepable by age like a retained failed one.
- [ ] `forge ops check` (or the reap-containers listing) can surface the condition so it is dashboard/operator-visible rather than silent.
- [ ] The `retained`/`reaped` outcomes stay behaviorally unchanged (no new events on the happy path — event only on failure).
- [ ] Tests: a reap failure on a completed task emits the event on each call path (fakes); reap-containers lists/removes a completed-task leak past the age threshold and does NOT touch a live/running task's container; happy-path completion emits no new event.

## Non-Goals

- No retry-on-failure loop inside finalizeContainerRetention (the sweep is the recovery path).
- No change to failed-task retention semantics.
