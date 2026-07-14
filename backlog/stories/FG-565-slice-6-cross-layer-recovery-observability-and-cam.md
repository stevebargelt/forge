---
id: FG-565
type: story
status: active
title: "Slice 6 — cross-layer recovery, observability, and campaign closeout for durable continuation"
created: 2026-07-14
---

**Epic:** FG-561 · **PRD:** `docs/prds/durable-orchestration-continuation.md` @ `e6fd56b` (Slice 6)
**Depends on:** every prior slice. This is the closeout slice.

## Goal

Prove the ownership and continuation model **as one system**, then retire the temporary guidance. Each
prior slice proves its own layer; this slice proves they compose, and that the seams between them do not
lose or duplicate work.

## Scope

- The **end-to-end fault matrix** (F1–F35 plus the open in-flight/lazy-import case) exercised as one system.
- Delivery / claim / watchdog-recovery evidence exposed through an **operator surface**.
- Clear retirement — or explicit fallback status — for the hand-built `Monitor` polling workaround.
- Update the FG-542-era prose that still says `ScheduleWakeup` owns ordinary delays.
- Final documentation-maintainer consistency pass.
- A focused review against the PRD before campaign closeout.

## Operator-visible evidence (must be answerable without transcript archaeology)

- Which launch completed, and what does its durable record **prove**?
- Was the completion observation **delivered normally, or recovered** by watchdog/replay?
- Which controller/consumer **claimed** the continuation?
- What next action was selected?
- Was a run/task dispatched, and what **durable id** proves it?
- Did a duplicate event arrive, and was it ignored safely?
- Is continuation blocked, and what explicit operator action is required?

Exact event/table names are **OQ-open**; the evidence must live in **Forge-owned durable state**, not only
in a transcript or Monitor output.

## Acceptance Criteria

- **Every falsification test was observed RED against its appropriate pre-fix baseline and green after its
  slice.** A test that cannot go red does not prove the defect was covered. This is a campaign-level gate,
  audited here.
- The cross-layer matrix passes, including the seams no single slice owns:
  - **F12/F20** — the interactive session disappears → the tmux command continues; the detached container
    continues even if the Forge watcher also dies.
  - **F23/F24** — an agent makes development source syntactically invalid or creates a transient
    missing-export inconsistency → stable machine-wide Forge state readers and the launch observer still
    work, **in this and unrelated projects**.
  - **F25** — an explicit live-source command run against broken source fails **locally** without changing
    the stable runtime.
  - **F26/F27/F28** — validated promotion is atomic; an interrupted promotion leaves the previous stable
    runtime selected and usable; a promotion with an in-flight launch keeps runtime identity diagnosable
    and follows the recorded store/schema-compatibility policy. **Includes T9** (the in-flight/lazy-import
    case), which is **DECIDED IN FG-553** — this slice verifies the decision holds under the full matrix.
  - **F29/F30/F31** — the control plane runs correctly from **two incompatible PATH/Node environments**,
    invoked as bare `forge` from a shell the operator did **not** pre-sanitize. *"Fails cleanly" is not a
    pass — it must RUN.* A caller-applied PATH pin is containment, not isolation, and does not satisfy this.
  - **F35** — version-skew store compatibility: old and new Forge processes against one SQLite, under the
    **BD-15 policy decided in FG-553**.
- The `Monitor` workaround's status is explicit: retired, or retained as a named fallback adapter (the
  retirement decision itself belongs to **FG-563**; this slice confirms it was carried out).

## This slice VERIFIES decisions; it does not MAKE them

Every open question this campaign must answer is owned by the slice whose implementation it constrains. A
decision made for the first time at closeout is a decision made after the code that depends on it was
already written.

| Open question | **Decided in** | Verified here |
|---|---|---|
| **T9** — is a running process affected by a mid-flight promotion (dynamic `import()`, lazy requires, open handles)? | **FG-553** — it constrains the promotion mechanism | under the full matrix (F26–F28) |
| **BD-15 store-version policy** — concurrent Forge versions against one SQLite | **FG-553** — it constrains the promotion mechanism | F35 |
| **OQ-4** — cancelling an *observer* vs. cancelling the *work* (distinct commands, distinct audit events) | **FG-552** (the waiter's own cancel semantics) + **FG-563** (adoption) | end-to-end |
| **OQ-5** — host-reboot continuation policy (today: no exit record + no tmux session ⇒ `unknown`; may Docker/reconcile evidence refine it?) | **FG-552** (terminal classification) + **FG-562** (continuation policy on `unknown`) | after a real restart |
| **OQ-2** — the production session adapter | **FG-563** | end-to-end |
| **OQ-1** — durable continuation storage | **FG-562** | end-to-end |
| **OQ-3** — watchdog owner + interval | **FG-563** | end-to-end |
| **OQ-6** — stable-runtime packaging/promotion mechanism | **FG-553** | F26–F28 |

If this slice discovers an open question that was never decided upstream, that is a **finding against the
owning slice**, not a decision to be improvised here.
- A final reviewer **maps evidence to every binding decision and matrix row** — approving from green CI
  alone is explicitly insufficient.

## Not in scope

- New continuation features. This slice closes the campaign; it does not extend it.
