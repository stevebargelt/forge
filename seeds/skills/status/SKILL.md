---
name: status
description: Report current Forge progress from authoritative run, task, launch, and continuation state. Use when the operator says `/status`, "status," "what is running?", "what is Forge doing?", "I see nothing running on the dashboard," "is this stuck?", or asks whether the dashboard is broken. Diagnose read-only and keep dashboard health separate from execution state.
---

# Forge status

Report what Forge is doing without changing it. Treat the Forge ledger as
authoritative; the dashboard is a read-only projection and its process is not
evidence that agent work is running or stopped.

## Read-only status procedure

1. Read the current workspace first:

   ```bash
   forge status --read-only --json
   ```

   Consider active non-`orchestrator` runs current work. An orchestrator session
   by itself means the interactive session is open, not that an agent task is
   progressing.

2. If the workspace has no current work, distinguish idle from work elsewhere:

   ```bash
   forge status --read-only --all --json
   ```

   Do not summarize the historical completed-run list. Select active runs only.

3. Inspect each relevant active run and ask Forge for its next action:

   ```bash
   forge status <run-id> --read-only --json
   forge advise <run-id>
   ```

   Report running roles/models, phase, start time, and `idleCountdown` when
   present. A running task with a measured, unexpired idle countdown is not
   stuck merely because its dashboard card has not changed. Name
   `awaiting_gate`, `blocked_by_red`, failures, and pending work exactly; do not
   flatten them into "not running."

4. Check durable command ownership independently of task state:

   ```bash
   forge launch list --json
   ```

   For a relevant running or unexpectedly terminal launch, use:

   ```bash
   forge launch show <launch-id>
   ```

   A launch can be alive while no new task has dispatched, or finished while a
   continuation still needs to advance. State both facts.

5. Only when progress appears stranded after the preceding checks, inspect the
   durable controller:

   ```bash
   forge continuation list --consumer-kind orchestrator --json
   ```

   Use `forge continuation show <continuation-id>` for a relevant blocked or
   non-advanced slot. Use
   `forge lost-signals --consumer-kind orchestrator --json` only when a launch
   completed but its expected continuation did not advance. Do not grep
   transcripts to reconstruct state already recorded here.

## Dashboard check

Check the dashboard only after establishing execution truth:

```bash
curl -fsS --max-time 3 http://127.0.0.1:8024/api/in-flight
```

- HTTP succeeds and task IDs agree with Forge: the dashboard backend is healthy.
  A blank browser page is then likely a stale tab, selected project/filter, or
  client-rendering problem. Say that; do not diagnose the Forge run as stopped.
- HTTP succeeds but disagrees with `forge status`: report a dashboard projection
  mismatch with the differing task IDs.
- HTTP fails: report the dashboard as unavailable, while separately reporting
  whether Forge work is running. Only then may you inspect
  `forge launch list --json` and a narrowly targeted process listing to explain
  dashboard ownership. Do not restart or kill it during a status request.

Never use a tmux session's presence, a process grep, or dashboard visibility as
the primary source of task status.

## Classification

Lead with exactly one:

- `WORKING` — at least one relevant task or durable launch is actively running.
- `WAITING FOR OPERATOR` — the next action is a human gate or other explicit
  operator decision.
- `NEEDS ATTENTION` — failed/orphaned work, a blocked continuation, an expired
  idle bound, or contradictory authoritative/projection state needs inspection.
- `IDLE` — no active non-session task and no relevant running launch exists.

Then use this compact shape:

```text
Forge status: WORKING
Current work:
- FG-123 — test-engineer, running since ...; idle countdown healthy
Next/operator action:
- None; two tasks are still running.
Dashboard:
- Healthy and consistent with Forge.
```

Name uncertainty. If two surfaces disagree, report both and identify which is
authoritative rather than inventing a cause.

## Mutation boundary

A status request authorizes no mutation.

- Always pass `--read-only` to `forge status`; the writable form reconciles.
- Do not use `forge show --reconcile`.
- Do not run `next`, `gate`, `retry`, `recover --continue`, `cancel`, `sweep`,
  `ops repair`, dashboard start/restart, container removal, or tmux kill.
- When Forge recommends a mutating command, present it as the next action and
  wait for operator authorization.

This is a host/orchestrator skill. Containerized agents do not discover or read
user-global Claude skills.
