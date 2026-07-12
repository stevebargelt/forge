---
id: FG-535
type: story
status: active
title: Prevent unsolicited SIGTERM of agent tasks with durable launcher and Claude/Supacode attribution
created: 2026-07-12
---

## Problem

Long-running Forge commands launched by a Claude orchestrator with Bash `run_in_background: true` are being terminated with SIGTERM. The attached `docker run` then forwards SIGTERM to the agent container, which exits 143. This is causing repeated lost agent work and review-loop churn.

Evidence from Claude session `fff3e306-7c24-44db-8169-6a7fe79cc340` on Claude Code 2.1.207:

- 59 background Bash commands produced 31 completed, 17 failed, and 11 killed notifications.
- The 11 unsolicited kills ranged from 14.9s to 1262.1s, so they do not fit one fixed Forge duration cap.
- The transcript contains no `TaskStop` call.
- Ten corresponding retained agent containers had Docker exit 143, `OOMKilled=false`, empty `State.Error`, and no Forge `container.exited` event because the Forge parent disappeared first.
- Representative exact match: Claude marked background task `bu6p2quks` killed at `2026-07-11T17:42:03.275Z`; Docker finished `forge-task-engineer-874f0a` at `2026-07-11T17:42:03.704Z` with exit 143 and `OOMKilled=false`.
- A controlled reproduction proved that SIGTERM sent only to an attached host `docker run` client produces the same container signature: exit 143, `OOMKilled=false`, no Docker state error.
- Forge's own idle watchdog uses `docker kill` plus SIGKILL and records an idle-timeout event, so it does not match this signature.
- Sleep timestamps, Docker OOM evidence, and incident timing do not support laptop sleep, memory pressure, or a daemon restart as the common cause.

Two upstream signal senders remain plausible and must be separated experimentally:

1. Claude Code's background-task harness has an unlogged internal reap/stop path. Upstream issue anthropics/claude-code#76249 reports 2.1.206 killing a background task without `TaskStop`; this host runs 2.1.207.
2. The Claude session runs inside a Supacode zmx pane. Supacode-managed hooks send `busy`, `idle`, `awaiting_input`, `session_start`, and `session_end` events including the Claude PID to a Supacode Unix socket. Supacode/zmx could act on idle state or pane lifecycle, but no direct kill evidence has yet been found.

Preliminary attribution favors Claude Code, without yet excluding Supacode:

- Every killed task followed Claude's `ScheduleWakeup` and a completed turn, but so did all 31 completed and all 17 failed background tasks. The idle-gap condition is real but does not discriminate outcomes or show that Supacode idle handling caused a kill.
- Supacode's installed binary describes `idle` as a turn-level activity reset and `session_start` as an agent presence badge. The installed hook commands only write lifecycle envelopes to Supacode's Unix socket; they contain no signal or process-control command.
- Supacode was foregrounded during some kills and backgrounded during others. Application foreground state does not correlate with the incidents.
- The zmx pane and Claude session survived while individual Claude-managed background task IDs changed to `killed` and generated Claude queue notifications. A whole-pane zmx reap does not match that observed scope, though a targeted descendant kill remains technically possible because Supacode receives the Claude PID.
- Claude's transcript owns the background-task registry, `ScheduleWakeup`, queue notification, and `killed` classification, and the same unsolicited-kill behavior is reported upstream without Supacode. These facts make Claude's retire/wake or background-task management the leading suspect.

FG-455, FG-185, and FG-492 improve diagnosis and recovery after parent loss. They do not prevent an interactive orchestrator harness from owning and killing the Forge process.

## Goal

Prevent orchestrator lifecycle events from terminating Forge work, and identify whether Claude Code or Supacode/zmx sends the unsolicited SIGTERM.

## Acceptance Criteria

- Add a documented, supported durable launch path for long-running `forge invoke`, `forge next`, and `forge review-loop` commands. The process owner must survive the submitting Claude Bash tool, orchestrator turn, UI idle state, and zmx pane lifecycle where practical.
- The launch path persists command, launcher identity/PID, start time, stdout/stderr location, terminal exit status/signal, and Forge run/task ids when available.
- Claude orchestrator guidance forbids Bash `run_in_background: true` as the owner of long-running Forge commands. Use a durable supervisor such as tmux as the immediate implementation, or a Forge daemon/detached launcher if implemented.
- Validate the immediate mitigation with at least one representative long Forge task exceeding 10 minutes: no Claude killed notification, owner remains alive, container reaches a normal terminal event, and Forge records the result.
- Run an attribution A/B matrix using the same inert long-running command shape:
  - Claude CLI in iTerm outside Supacode, with `SUPACODE_*` and `ZMX_*` confirmed absent and background tasks enabled;
  - Claude inside Supacode/zmx with Supacode hooks disabled, background tasks enabled;
  - Claude inside Supacode/zmx with hooks enabled, background tasks enabled;
  - durable tmux/supervisor launch from inside Supacode.
- For every cell, capture Claude transcript notification, process parent/PGID/session, zmx pane identity, Supacode hook events, host exit status/signal, and timestamps. Do not infer the sender from exit 143 alone.
- Inspect or instrument Supacode/zmx sufficiently to determine whether receipt of `idle`, `awaiting_input`, or `session_end` causes process or pane termination. If unavailable, record attribution as unresolved rather than exonerating or blaming Supacode.
- Confirm whether `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` removes `run_in_background` on installed Claude Code 2.1.207 and document the required restart/session scope.
- Add an operator-visible classification for externally terminated launcher/parent when durable evidence supports it; preserve unknown attribution when the signal sender is not recorded.

## Additional instrumentation available (2026-07-11, complements the A/B matrix)

A SA_SIGINFO sentinel is compiled at ~/.forge/sigterm-probe/sentinel (takes a log path as argv[1]) — it records the SENDER pid/uid (si_pid/si_uid) of any SIGTERM/SIGHUP/SIGINT it receives, which removes the need to infer the sender in every matrix cell. One instance is live as a harness background task in session fff3e306 (log: sentinel.log), alongside a node-shaped decoy (node-decoy.log) and a setsid-detached 2s process-table sampler (ps-samples.log) to resolve transient sender pids. Use the same binary in each A/B cell with a distinct log path.

Related: FG-536 (in-product fix — docker-detached agent execution, results survive any owner death by construction; this ticket's durable launcher is the operational path until that lands).

## Non-Goals

- Do not reopen already-shipped orphan reconciliation and container evidence work.
- Do not claim a reboot, Docker memory increase, idle-timeout increase, or model change fixes this without a controlled result.
- Do not require exact attribution before shipping the durable-launch mitigation.

## Immediate Operational Mitigation

Set `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`, restart the Claude orchestrator session, launch long Forge commands under a durable tmux session using a short synchronous Bash call, and poll Forge durable state/logs rather than process-name matches. A controlled tmux test already showed the tmux-owned attached Docker container remained alive after the submitting command returned.

