---
id: FG-552
type: story
status: active
title: "forge launch: push completion events so a controller can advance phases without fixed-estimate wakeups (durable event-driven continuation)"
created: 2026-07-14
---

## Problem

`forge launch` (FG-535) made long forge commands survive the harness's SIGTERM sweep by moving them under a durable tmux owner. It persists a rich terminal record (`~/.forge/launches/<id>/`: command, session, start time, log, OS-reported exit record, forge run/task ids) — but it **only supports PULL**. Nothing is signalled when a launch reaches a terminal state.

The consequence for the orchestrator, which is the actual consumer (see the orchestrator-is-the-actor principle): the controller driving a multi-phase chain (engineer → test-engineer → documentation-maintainer → review-loop → CI → merge) has no completion event to react to. It is forced into one of two bad shapes:

1. **Fixed-estimate wakeups** — guess how long the phase takes, wake, poll. Wrong in both directions: too early burns a turn, too late leaves the phase idle. The operator named this directly (2026-07-13): "fixed estimated wakeups should not be our steady-state orchestration mechanism."
2. **Re-entering the harness's tracked-background set** to get its `<task-notification>` completion event — which is exactly the mechanism FG-535 exists to avoid, because the harness SIGTERM-sweeps its own registered background tasks (si_pid-proven) and an attached `docker run` forwards that into the agent container.

So the only push-completion channel available today is welded to the mechanism that kills the work. That is a harness limitation. But the half forge owns — a launch that reaches a terminal state and tells nobody — is a **forge design gap**, and it is the half we can close.

**Interim workaround in use (2026-07-13, FG-425 corrective run):** an out-of-band `Monitor` process polls `forge launch show <id>` every 20s and emits one line on any terminal state, waking the controller. It owns none of the work, so it can be swept harmlessly. ScheduleWakeup is demoted to a watchdog for a lost signal. This works, but every controller has to hand-roll it, the poll interval is arbitrary, and the "did the signal get lost?" question has no durable answer.

## Goal

A launch's terminal state is **pushed**, not polled: any controller (orchestrator session, campaign runner, future daemon) can subscribe to launch completion and advance a phase immediately, without owning the work and without re-entering the harness's tracked-background set.

## Design questions (decide at plan time — do NOT assume one)

- **Signal mechanism.** Candidates: a completion hook (`forge launch run --on-complete <cmd>`), an event row in the store the controller can wait on, a `forge launch wait <id>` that blocks with a real terminal condition (still pull, but bounded and honest), a fifo/unix-socket, or a `notify`-style dispatch reusing the existing `forge notify` delivery. The consumer is the orchestrator, so prefer whatever composes with an event stream the harness can surface.
- **Who observes the tmux pane's exit?** The launch record already captures the OS exit record — establish exactly where that write happens and whether a signal can be emitted in the same place (atomically with the record, so a signal can never claim a terminal state the record doesn't have).
- **Lost-signal semantics.** The signal must be a fast path, never the source of truth: the durable launch record stays authoritative, and a controller that missed a signal must be able to reconstruct the same conclusion from the record. Fail-closed: a signal that fires without a matching terminal record is a bug, not a completion.
- **Does the campaign runner want the same primitive?** It drives phases too; a shared completion event is likely the right shape rather than two mechanisms.

## Acceptance Criteria

- A controller can be notified of a launch's terminal state (success AND every failure mode: non-zero exit, signal, unknown/owner-gone) without polling on a fixed estimate.
- The signal is emitted from the same place the durable exit record is written, and cannot report a terminal state the record does not carry.
- A missed/lost signal is recoverable: the controller reconstructs the identical outcome from the durable launch record. A test proves the recovery path.
- `forge launch` docs describe the completion contract for controllers.
- The FG-425-era `Monitor`-polling workaround is no longer necessary for the orchestrator's phase chain (state whether it is retired or retained as a fallback).
