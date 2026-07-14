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

## The claim must be BOUND, not merely unique — exactly-once on the WRONG phase is still wrong

A claim that is idempotent but unbound is a correctness bug wearing a safety hat. **A delayed completion
from launch A can arrive after the controller has moved on, and claim a NEWER phase B — exactly once — and
still be completely wrong.** Uniqueness of the claim does not make it *correct*.

**The claim MUST be a compare-and-set against the durable pre-transition state.** A claim is granted only
if ALL of the following still match at the moment of the write:

- **`sourceLaunchId`** — the claim is for **this** launch, not a launch the controller has since replaced.
- **`consumerKind` + `currentPhase`** — the consumer is still on the phase this completion belongs to. A
  completion for phase A must **never** advance phase B.
- **`nextAction`** — the structured action selected (**never an opaque shell string**) is the one being
  claimed.
- **The expected durable pre-transition state** — the CAS fails if the underlying state has moved at all.

If any of these has changed, the claim **fails and no state is written.** A stale completion is observed,
recorded, and **ignored** — not advanced.

### Required regression: stale-completion / phase-binding

A test in which a **late completion from launch A** arrives **after the controller has advanced to phase B**
must show that it **does not advance phase B**, writes no state, and is recorded as a stale/ignored
observation.

**⚠️ THE RED BASELINE IS THE HARD PART, AND IT IS ENFORCEABLE — READ THIS.**

**Observing the stale-completion test red against "no claim primitive exists yet" is INSUFFICIENT and does
NOT satisfy the falsification gate.** Of course it fails when nothing exists; that proves only that the
feature is unbuilt. It says nothing about whether the **binding** is what saves you.

**The red evidence must specifically FALSIFY A UNIQUENESS-ONLY CLAIM IMPLEMENTATION** — one that is
correctly exactly-once but not bound to the phase. That implementation is the plausible wrong answer, it
passes a naive duplicate-event test, and it is still wrong.

**Satisfy this in ONE of exactly two ways:**

1. **Staged implementation.** Build the **uniqueness-only** claim first; observe the stale-completion test
   **RED against it**; *then* add the `sourceLaunchId` + consumer/`currentPhase` + structured `nextAction` +
   expected-prior-state binding and observe it green. The red run must be against a claim that genuinely
   exists and is genuinely exactly-once.
2. **Mutation test.** Against the finished implementation, **remove or bypass** the binding
   (`sourceLaunchId` + consumer/`currentPhase` + structured `nextAction` + expected-prior-state) and
   **demonstrate the regression goes RED.** The mutation must isolate the binding, not the whole claim.

**The final green test must prove that a delayed completion from launch A cannot advance phase B.** **A
naive duplicate-event test is NOT substitute evidence** — it passes against the very implementation this
regression exists to reject.

## New durable state must carry BD-15 (schema/version policy)

**OQ-1 permits a new continuation/receipt table. If one is introduced, it is correctness-bearing state on
the control path, and it inherits the concurrent-version problem — it does not get a pass because it is new.**

- **The schema and its migration MUST obey the concurrent-version policy selected by FG-553 (BD-15).**
  Migrations run unconditionally on every writable DB open, and concurrent Forge processes of *different
  versions* against one store is the **default** state, not an edge case.
- **Any new state must be propagated to `docs/SCHEMA-CONTRACT.md`.** A correctness-bearing table that is not
  in the schema contract is invisible to every future change.
- **Old/new-process coverage is required**, not optional: a process running the *old* Forge must not be
  broken by the new table or its migration, and a *new* process must behave correctly against a store an old
  process is still reading. Test both directions.
- A destructive migration (cf. the existing unguarded `DROP COLUMN`, `src/store/db.ts:91`) is **not**
  acceptable for this table without the BD-15 policy explicitly permitting it.

## Not in scope

- The wait/subscription primitive itself (FG-552).
- Campaign-specific adoption (FG-564) or orchestrator adoption (FG-563) — this slice provides the
  primitive they consume.
- Any second event transport or terminal vocabulary (BD-10).
