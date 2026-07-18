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

### Live F22 reproduction — meatgeekv2 synchronous invoke stalls autonomous continuation (2026-07-18)

An orchestrator in the `meatgeekv2` project dispatched an engineer for MG-19 with direct,
synchronous `forge invoke`. The caller's Bash tool hit its two-minute limit and exited 143 while the
invocation was still running. FG-536's detached-container work held: run
`run-mg-19-fix-ci-pipeline-b154ec` remained `active`, task `task-engineer-a97d77` remained `running`,
the Docker container was still `Up`, and the task's `result.json` was correctly still zero bytes because
the engineer had not finished. No work was lost and re-invoking would have duplicated it.

The control chain nevertheless stopped. The orchestrator had no completion wake or durable continuation
claim, ended its turn, and told the operator to "give me a nudge (or just say check) in a few minutes."
With the operator silent, the completed engineer could not advance to verification, CI, or the next genuine
decision. This is a live pre-fix reproduction of **F22**, not another FG-535 container-kill incident:
execution durability survived, but autonomous kickoff-to-continuation did not.

The reproduction also shows why prose that distinguishes "short" from "long" invokes is not a reliable
control boundary. The installed policy says direct `forge invoke` is synchronous and that the Bash call
returns when the agent completes (`seeds/orchestrator-template.md:240`), and its ordinary examples dispatch
agents directly (`:149`, `:167-171`). Only later does it require `forge launch run` for "long-running work,"
including `forge invoke` (`:415`). Agent duration is not knowable at dispatch time, so the orchestrator is
asked to choose between contradictory happy paths. FG-563 must remove that duration guess from the adopted
orchestrator path; this evidence does not add a new acceptance criterion or a second transport.

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
- **OQ-3 is answered here:** which durable component schedules lost-signal recovery, and how recovery
  evidence is recorded. The interval is a **health bound**, not a guessed task duration.
- **OQ-4 (with FG-552):** FG-552 decides the waiter's own cancel semantics; this slice decides the
  **adoption** half — how an operator cancels the orchestrator's *observation* of a launch without
  cancelling the tmux-owned *work*, as distinct commands with distinct audit events.
- **The `Monitor`-polling workaround's fate is decided HERE** — retired, or explicitly retained as a named
  fallback adapter. FG-552 supplies the primitive but builds no consumer and cannot make this call;
  FG-565 only confirms the decision was carried out.

## Propagation surfaces — update the SOURCE, not just the current checkout

- `seeds/orchestrator-template.md` — **the canonical policy source.**
- The marker-managed orchestrator block in `CLAUDE.md`, regenerated deterministically via `forge-dev upgrade`
  (**not** stable `forge upgrade` — since FG-577 the installer renders the EXECUTING forge's template, so from a
  promoted release `forge upgrade` renders the RELEASE's block and a checkout seed edit silently does not land).
- `docs/quick-start.md`, `docs/concepts.md`, `docs/autonomous-run-prompt.md`.
- Init/upgrade/template regression tests.
- Any installed host skill that independently prescribes launch waiting.

**Ownership note (FG-347):** `seeds/orchestrator-template.md` and the `CLAUDE.md` marker block are
**orchestrator-policy surfaces**. The documentation-maintainer must **not** hand-edit them — the
orchestrator authors the seed and re-renders via `forge-dev upgrade` (FG-577: stable `forge upgrade` renders the
executing release's template, not your checkout edit).

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

## Handoff obligation — flag memory this slice invalidates

This slice **changes what is true** about `ScheduleWakeup` and the `Monitor` workaround. Any project or
session memory asserting the old behavior becomes **actively misleading** the moment this lands — and a
stale memory is worse than no memory, because it is trusted.

**At Slice 4 handoff:**

- **Flag every project/session memory whose `ScheduleWakeup` or `Monitor` claims this implementation
  invalidated.** Name each one.
- **Propose a one-line correction** for each.

**Hard limits — this is a handoff obligation, NOT an expansion of implementation scope:**

- **Do NOT edit memory automatically.**
- **NEVER write a `reviewed` stamp.**
- Do not treat this as licence to audit memory generally — only memories *this slice's own changes*
  invalidated.

The orchestrator (or operator) applies the corrections. The slice's job is to **surface** the drift it
caused, not to silently repair it.

## Falsification

**Every new regression test must be observed RED against its pre-fix baseline** (campaign rule). A test that
cannot go red does not prove the defect was covered.

Specifically: **F19** (a happy-path job outrunning any estimate produces no model wake) and **F22** (a routine
chain reaching its next decision with the operator sending **no messages at all**) must both be demonstrated
against the *current* fixed-estimate/Monitor-polling behavior first — otherwise the tests are asserting a
property the old code already accidentally satisfies on a lucky timing, and prove nothing.

## Not in scope

- The wait primitive (FG-552) or the claim primitive (FG-562).
- Campaign adoption (FG-564).
