---
id: FG-562
type: story
status: active
title: "Slice 3 — durable continuation claim: observing a launch terminal state cannot duplicate or lose the next action"
created: 2026-07-14
---

**Epic:** FG-561 · **PRD:** `docs/prds/durable-orchestration-continuation.md` @ `e6fd56b` (Slice 3)
**Depends on:** FG-552 (Slice 2 — the wait primitive). Notification without a durable claim is not continuation.

## Problem

A completion event tells a controller that a launch finished. It does **not** make a multi-phase chain
safe. Today there is **no continuation state at all**: no claim, no idempotency key, no dispatch receipt.
The only durable linkage is a nullable `campaign_items.run_id`. An ad-hoc orchestrator chain has nothing.

So: a duplicate wake can dispatch a phase twice; a controller crash after observing completion but before
dispatching can lose the transition; a crash after dispatch but before recording the run id can duplicate
it on recovery.

**BD-5 is UNMET and has no primitive to stand on.** "Exactly once" applies to the successful **claim of
the next transition** — not to physical event delivery, which is at-least-once and may be lost.

## Scope

- Select or reuse durable controller state (**OQ-1**: can existing run/task/campaign rows represent every
  claim and crash window, or is a small generic continuation/receipt table required? The answer must cover
  the **ad-hoc interactive chain**, not only campaigns).
- Transactional / idempotent claim semantics.
- A **dispatch receipt or idempotency mechanism** for the claim-to-dispatch crash window.
- Replay after controller restart.
- Duplicate and racing-wake tests.

Conceptual state (the PRD's minimum; exact schema is OQ-1): `continuationId`, `sourceLaunchId`,
`consumerKind` (orchestrator | campaign), `currentPhase`, `nextAction` (**structured, never an opaque
shell string**), `state` (awaiting_completion | ready | dispatching | advanced | blocked), `claimOwner`,
`claimExpiresAt` (only if renewable/recoverable), `dispatchedRunId`/`taskId`, `lastObservedStatus`,
timestamps.

May be split into a generic primitive plus consumer adapters **only if** the plan proves that is the
smallest reviewable shape.

## Acceptance Criteria

Every crash window below is a **binding acceptance case**, and each test must be **observed red against
its pre-fix baseline** — a test that cannot go red proves nothing:

- **Crash before observing completion** → replay from the launch record (F1–F3).
- **Crash after observing completion, before claiming** → another controller may claim (F15).
- **Crash after claim, before dispatch** → the claim expires/recovers or remains **visibly blocked**; it
  cannot silently disappear (F16).
- **Crash after dispatch, before recording the run/task id** → recovery **adopts the original dispatch**
  via an idempotency key or dispatch receipt; it does **not** dispatch a duplicate agent/run (F17).
- **Duplicate event after advancement** → observe `advanced`, perform no action (F13).
- **Two controllers race one completion** → one wins the durable claim; the loser observes claimed/advanced
  state (F14).
- **Watchdog fires after a normal event already advanced** → no duplicate action, and no false
  lost-signal claim recorded (F18).
- **A claim is only ever granted on a canonical classification supported by authoritative durable
  evidence (BD-3).** Note carefully: that evidence is **not always an exit record.** `owner_gone` and
  `unknown` produce **no exit record at all** — they are reconciled from durable launch metadata plus
  independent owner evidence, and they are legitimate terminal dispositions a claim may advance on, under
  their own failure/blocker policy (BD-7, F9, F10). **A claim must never require, nor fabricate, an exit
  record for a reconciled disposition** — the corrected BD-4 scopes the matching-record requirement to
  exit-record-driven completion events. What is forbidden is granting a claim on a disposition the
  authoritative evidence does not support — e.g. a signal asserting an exit that never happened.
- **OQ-5 (with FG-552):** FG-552 decides the post-reboot *terminal classification*; this slice decides the
  *continuation policy* that consumes it — what a controller is permitted to do with an `unknown` after a
  host restart, and whether it may advance, must block, or must surface an operator blocker.

## Not in scope

- The wait/subscription primitive itself (FG-552).
- Campaign-specific adoption (FG-564) or orchestrator adoption (FG-563) — this slice provides the
  primitive they consume.
- Any second event transport or terminal vocabulary (BD-10).
