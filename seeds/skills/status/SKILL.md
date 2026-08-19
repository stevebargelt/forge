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

   `Current activity` has six sections: `Agents`, `Host verification`,
   `Launch activity`, `Required CI`, `CI waits`, and `Waiting on operator`. A launch is never an agent task. Only
   a launch that DECLARED `--purpose host_verification` at submission (FG-700)
   ever renders under `Host verification`; every other placed launch —
   `agent_invoke`, `review`, `campaign`, `dashboard`, `generic`, and any
   legacy row recorded before the field existed — renders in full under
   `Launch activity` instead. Treat `Launch activity` as diagnostic only: it
   exists so an associated launch is never silently dropped, not as a second
   WORKING signal — the agent task or review it belongs to already carries
   that. This is the SAME derivation over the same persisted observations
   that the dashboard renders (FG-679), which is why the two agree; classify
   from it, not from a live probe.

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

   `CI waits` is a distinct, fifth surface (FG-731): a **registered** Forge-owned
   CI wait — `pr_checks`, `push_actions`, or `workflow_dispatch` — created by
   `forge ci-wait register`/`forge ci-wait wait` *before* polling starts. Unlike
   host verification and required CI, a non-terminal wait's mere presence forces
   `WORKING`, never `IDLE`, independent of how stale its last observation is: a
   dead-waiter wait is recovered by re-observation, not dropped. Read its label
   exactly as printed and keep the four states distinct — `CI running m/n`
   (fresh, still going), `no CI is running` (`no_runs`: a fresh look found
   nothing pending), `CI state unavailable` (the state could not be determined,
   or the last observation is too old to trust — distinct from `no_runs`, never
   reported as either idle or a fabricated `running`), and `CI completed —
   awaiting advance` (`completed_awaiting_advance`: the run finished but a
   `forge advance`/`forge continue` is still owed — report the pending advance,
   never treat this as done). `(no CI wait registered)` means exactly that — no
   registered wait, not that CI is idle. `forge ci-wait` is the supported
   surface for registering and waiting on this kind of CI (replacing bare `gh
   run watch` or ad-hoc `gh` polling); a status/diagnosis request only READS
   this section and never registers, cancels, or otherwise mutates a wait.

   `Waiting on operator` is a distinct, sixth surface (FG-734), reported
   separately from `CI waits`: a **derived** entry for each live thing Forge
   has intentionally stopped and is waiting on a HUMAN to decide — never
   inferred from log text, an agent's own message, or elapsed time. Only two
   durable sources produce a row: `human_gate` (a task parked at
   `awaiting_gate` whose *workflow step* gate resolves to `human` — a
   `verdict`/`auto`/`none`-gated step is the orchestrator's own call and never
   appears here), and `campaign_hard_stop` (a campaign item that recorded a
   `requested_human_action` — an autonomous run that stopped itself and named
   the authority and action it needs). A human gate and a campaign hard stop
   naming the same run report as ONE entry, never two. Multiple, unrelated
   waits are never collapsed into a single line — report the count and, for
   each, its ticket or run id, reason, and requested action. Like `CI waits`,
   an entry's mere presence is the WAITING signal on its own, independent of
   every other section; `(nothing waiting on operator)` means exactly that. A
   task sitting in `awaiting_red`, `blocked_by_red`, or `awaiting_recovery` is
   not this — those are automated recovery states and belong under `NEEDS
   ATTENTION`, not here, unless the task has specifically landed at a
   human-gated step.

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
  running host verification launch, pending required check, or a registered
  non-terminal CI wait (`CI waits`). A CI wait counts by its mere presence in
  `CI waits`, whatever its current label — including `CI state unavailable` or
  `CI completed — awaiting advance` — since a non-terminal wait is never IDLE.
- `WAITING FOR OPERATOR` — `Current activity`'s `Waiting on operator` section
  lists at least one entry: a task parked at a workflow step whose gate
  resolves `human` (`human_gate`), or a campaign item that recorded a
  `requested_human_action` hard stop (`campaign_hard_stop`). Report each
  entry's reason and requested action; when there is more than one, report the
  count and each entry's ticket or run id rather than naming only one. A step
  gated `verdict`/`auto`/`none` is not this — classify a task parked there from
  its ordinary task/phase state instead.
- `NEEDS ATTENTION` — failed/orphaned work, a blocked continuation, an expired
  idle bound, or contradictory authoritative/projection state needs inspection.
  A `CI waits` entry reading `CI completed — awaiting advance` belongs here (or
  under `WORKING` if you are about to drive the advance yourself) rather than
  being reported as finished. A task sitting in `awaiting_red`, `blocked_by_red`,
  or `awaiting_recovery` belongs here too, not under `WAITING FOR OPERATOR` —
  those are automated recovery states, not a parked human-gated step, unless it
  has specifically landed in `Waiting on operator`.
- `IDLE` — `Current activity` shows no active non-session task, no running host
  verification launch, no pending required check, no registered CI wait
  (`CI waits` reads `(no CI wait registered)`), and nothing in
  `Waiting on operator` (reads `(nothing waiting on operator)`). An `unobserved
  since <time>` launch is not IDLE: it is unobserved, and it belongs under
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
