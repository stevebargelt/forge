---
id: FG-563
type: story
status: active
title: "Slice 4 — interactive orchestrator adoption: replace Monitor-polling and fixed-estimate wakeups with the launch-wait primitive"
created: 2026-07-14
---

**Epic:** FG-561 · **PRD:** `docs/prds/durable-orchestration-continuation.md` @ `e6fd56b` (Slice 4)
**Depends on:** FG-552 (wait primitive), FG-562 (durable claim).

## Problem

The orchestrator's happy path today is a hand-built `Monitor` polling `forge launch show` every 20s, plus
a `ScheduleWakeup` sized from a **guessed job duration**. Every controller hand-rolls its own watcher, the
poll interval is arbitrary, and a lost signal has no durable evidence.

**This contradicts BD-9 in the *installed policy itself*** — not merely in unbuilt code. The installed
orchestrator policy prescribes duration-estimated `ScheduleWakeup` as the ordinary wait path, while BD-9
says timers are watchdogs only and "must not be sized from a guessed job duration." That is a live
contradiction with a shipped artifact, and it is this slice's job to remove it.

Evidence the hand-built watcher is a real hazard, not a theoretical one: during this campaign's own audit,
an orchestrator Monitor used `declare -A` (bash 4) on a host running bash 3.2. The script died on its
first line, wrote to stderr — which the Monitor tool does not surface as an event — and sat armed and
**silent** for a full hour while the work it was watching had already completed. The durable records were
correct the whole time. **A watcher whose failure mode is silence is indistinguishable from "still
running."**

## Scope

- The orchestrator launches long work **only** through `forge launch`.
- A **disposable** session adapter waits via `forge launch wait` and wakes on **every** terminal
  disposition (BD-7: exit 0, ordinary non-zero, OS signal, owner-gone, unknown-after-restart, and
  persistently-unreadable-after-bounded-retry).
- On wake: reread the launch record and controller state, **claim** the next action (FG-562), advance once.
- `ScheduleWakeup` is demoted to a **low-frequency lost-signal watchdog** — a health bound, never a job-duration estimate (**OQ-3**).
- A watchdog recovery **records durable evidence that the event path was missed** — "did the signal get
  lost?" must have an answer that is not transcript archaeology.
- **OQ-2 must be answered, not assumed:** name the *production* session adapter that converts
  `forge launch wait` completion into a session wake when `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`
  disables ordinary Bash background dispatch, and state its restart behavior. Do not assume
  `<task-notification>` can be emitted externally.

## Propagation surfaces — update the SOURCE, not just the current checkout

- `seeds/orchestrator-template.md` — **the canonical policy source.**
- The marker-managed orchestrator block in `CLAUDE.md`, regenerated deterministically via `forge upgrade`.
- `docs/quick-start.md`, `docs/concepts.md`, `docs/autonomous-run-prompt.md`.
- Init/upgrade/template regression tests.
- Any installed host skill that independently prescribes launch waiting.

**Ownership note (FG-347):** `seeds/orchestrator-template.md` and the `CLAUDE.md` marker block are
**orchestrator-policy surfaces**. The documentation-maintainer must **not** hand-edit them — the
orchestrator authors the seed and re-renders via `forge upgrade`.

## Acceptance Criteria

- No routine phase transition in the orchestrator's chain waits on a fixed-estimate wakeup (**F19**: a
  happy-path job that runs longer than any estimate produces **no** model wake until completion, and no
  fairness/timeout inference from duration).
- The orchestrator wakes on every terminal disposition, including the failure shapes — **failure is a
  completion disposition, not silence** (BD-7).
- **F22**: with the operator sending **no messages at all**, a routine chain reaches its next genuine
  decision or blocker on its own.
- **F12**: the listener/Monitor is swept → the tmux command and the Docker agent continue; a
  watchdog/restart reattaches.
- A lost signal recovered by watchdog is **durably recorded as such** (no false lost-signal claim when the
  normal event already advanced — F18).
- Seed → generated `CLAUDE.md` block → installed-surface parity is **tested**, not assumed.
- The BD-9 contradiction is gone from the installed policy, not merely from the PRD.

## Not in scope

- The wait primitive (FG-552) or the claim primitive (FG-562).
- Campaign adoption (FG-564).
