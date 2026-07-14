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

## Slice 2 of the FG-561 campaign

**Epic:** FG-561 · **PRD:** `docs/prds/durable-orchestration-continuation.md` @ `e6fd56b` (Slice 2)
**Depends on:** FG-553 + BD-14 (Slice 1) and FG-555 (Slice 1b). `forge launch wait` is **not an
independent observer** if the `forge` executable importing the source tree the supervised agent is
editing — or selecting its interpreter from the caller's PATH — can itself fail to load.

## Acceptance Criteria

> **RECONCILED 2026-07-14 against the corrected BD-4.** The original AC below demanded that every signal
> originate with an exit record, *including* `owner_gone`/`unknown`. Those two dispositions produce **no
> filesystem artifact at all** and are discovered only by reconciliation — so as written the AC required a
> **fabricated** exit record, which BD-3 forbids outright. The matching-record requirement is now scoped to
> **exit-record-driven** completion events. BD-4's actual intent is unchanged and still binding: a signal
> asserting an exit that never happened must not advance a phase.

- A controller can be notified of a launch's terminal state — success **and every failure mode**: ordinary
  non-zero exit, OS-recorded signal, owner-gone, unknown-after-restart, and persistently
  unreadable/invalid after bounded retry — **without polling on a fixed estimate.** Failure is a
  completion disposition, not silence (BD-7).
- **Atomic record commit (BD-4), both records:**
  - The **exit record** is written atomically (temp file + rename, or an equivalent proven operation), so
    a consumer never observes partially written JSON as a terminal result. *Today it is a bare
    `writeFileSync` — `src/v2/launch.ts:130`.*
  - The **meta record** is published atomically. *Today `meta.json` is written twice during `startLaunch`
    (`launch.ts:240,269-270`), so a reader in the truncate window sees a **running** launch as "no such
    launch."*
- **A reader must not treat an empty or unparseable record as terminal.** *Today the reader maps an empty
  exit file to a terminal `unknown` (`launch.ts:102,287,289`), so a launch that **exited 0** can read as
  unrecoverable.* An unreadable record is an invitation to bounded retry, not a disposition.
- **For exit-record-driven completion events:** the exit record must already be committed and readable —
  a signal asserting an exit that never happened is a defect and must not advance a phase.
- **For the reconciled dispositions (`owner_gone` / `unknown`):** they rest on **durable launch metadata
  plus independent owner evidence** and advance under their own explicit failure/blocker policy (BD-7,
  F9, F10). They must **never fabricate an exit record**, and reconciliation is **mandatory, not a
  low-cost fallback** — a watch-then-reread design structurally cannot cover a disposition that creates no
  filesystem artifact.
- **The subscribe race is closed (BD-6):** read the authoritative record → install the watcher → **reread
  immediately** → either read suffices to observe an already-terminal launch. No check-then-subscribe gap
  may strand a completed launch (F1, F2).
- **The observer is minimal.** The wait path must **not** transitively load the command registry or the
  native SQLite binding. *Today `src/cli/index.ts` eagerly imports all command modules before argv is
  parsed, pulling in `better-sqlite3` — while `readLaunch` needs only `node:fs` and the tmux binary.*
  Without this, source isolation (FG-553) still leaves the observer dead under an incompatible Node ABI.
- **Degraded/absent tmux** is a named observation input — `readLaunch` shells out to the `tmux` binary and
  is not a pure durable-record read.
- A missed/lost signal is recoverable: the controller reconstructs the **identical** outcome from durable
  state. A test proves the recovery path (F3).
- `forge launch wait <id> [--json]` returns immediately if already terminal; otherwise blocks **without
  waking a model**; emits exactly one structured terminal observation per invocation; exits successfully
  when it *observed and rendered* a disposition (the launch's own exit code is **data**, not the wait
  command's exit status); refuses an unknown launch id **distinctly** from a known launch whose status is
  `unknown`; and any timeout is an explicit `wait_timeout` result, **never a fabricated launch terminal
  state**.
- Reuses `readLaunch` / one canonical classifier — **no second status vocabulary** (BD-10).
- `forge launch` docs describe the completion contract for controllers, including the record-first and
  advisory-delivery semantics.
- The FG-425-era `Monitor`-polling workaround is no longer necessary for the orchestrator's phase chain
  (state whether it is retired or retained as a fallback).

**Every falsification test must be observed RED against its pre-fix baseline.** A test that cannot go red
does not prove the defect was covered.

## Non-scope (from the PRD)

- No generic daemon.
- No arbitrary `--on-complete <shell command>` hook in this slice.
- No campaign-specific event format.
- No phase advancement embedded in the launch wrapper.
- The durable continuation **claim** is FG-562 (Slice 3), not this slice. Notification without a claim is
  not continuation.
