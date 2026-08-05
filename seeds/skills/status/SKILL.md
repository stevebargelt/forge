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

4. Read non-task work — host verification launches and required CI — from
   `forge status`'s `Current activity` sections, which you already have from
   step 1:

   ```bash
   forge status --read-only --json
   ```

   `Current activity` has three distinct sections: `Agents`, `Host
   verification`, and `Required CI`. A launch is never an agent task. This is
   the SAME derivation over the same persisted observations that the dashboard
   renders (FG-679), which is why the two agree; classify from it, not from a
   live probe.

   Read each launch status exactly as printed and never upgrade it: `terminated
   by SIGTERM (signal sender not recorded — origin unknown)`, a bare `exited 143
   (signal-range code, no signal evidence — origin unknown)`, `owner gone`, and
   `unknown` are four different facts, and exit 143 alone is never attribution
   evidence. `unobserved since <time>` is a fact about the OBSERVER, not about
   the work — report it as unobserved, never as running and never as terminal.
   For required CI, keep `CI not observed` (nothing has observed it), `CI not
   running` (observed, nothing pending), and a `stale` observation distinct;
   CI evidence is bound to an exact candidate sha and disappears when the
   candidate moves.

   A launch can be alive while no new task has dispatched, or finished while a
   continuation still needs to advance. State both facts.

   `forge launch list --json`, `forge launch show <launch-id>`, and `tmux
   capture-pane` are DIAGNOSTICS ONLY — reach for them to explain a specific
   launch after classifying, never as the classification source. `forge launch
   list` fans a live tmux probe over every record and knows nothing about CI, so
   classifying from it reports IDLE when the only activity is a pending required
   check — a disagreement with the dashboard by construction.

   Agreement holds only on a host whose seeds are current: `forge status` gains
   `Current activity` from the installed release, and this skill file is itself
   an installed seed. If the host has not reinstalled seeds (`forge doctor` →
   the seed-install path, FG-579 / FG-583), expect seed drift and say so rather
   than reporting a projection mismatch.

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
curl -fsS --max-time 3 http://127.0.0.1:8024/api/current-activity
```

- HTTP succeeds and task IDs agree with Forge: the dashboard backend is healthy.
  A blank browser page is then likely a stale tab, selected project/filter, or
  client-rendering problem. Say that; do not diagnose the Forge run as stopped.
- HTTP succeeds but disagrees with `forge status`: report a dashboard projection
  mismatch with the differing task IDs. `/api/current-activity` and `forge
  status` run the SAME derivation over the same persisted state, so a
  disagreement between those two is a defect worth reporting by name, not a
  presentation difference — unless the host's seeds/release are stale, which is
  the first thing to check.
- HTTP fails: report the dashboard as unavailable, while separately reporting
  whether Forge work is running. Only then may you inspect
  `forge launch list --json` (diagnostics only) and a narrowly targeted process
  listing to explain dashboard ownership. Do not restart or kill it during a
  status request.

Never use a tmux session's presence, a process grep, or dashboard visibility as
the primary source of task status.

## Classification

Classify from `Current activity` (step 4), not from `forge launch list --json`.
Lead with exactly one:

- `WORKING` — `Current activity` shows at least one relevant running agent task,
  running host verification launch, or pending required check.
- `WAITING FOR OPERATOR` — the next action is a human gate or other explicit
  operator decision.
- `NEEDS ATTENTION` — failed/orphaned work, a blocked continuation, an expired
  idle bound, or contradictory authoritative/projection state needs inspection.
- `IDLE` — `Current activity` shows no active non-session task, no running host
  verification launch, and no pending required check. An `unobserved since
  <time>` launch is not IDLE: it is unobserved, and it belongs under
  `NEEDS ATTENTION` if the run's progress depends on it.

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
