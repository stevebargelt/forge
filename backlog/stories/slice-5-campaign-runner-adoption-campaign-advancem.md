---
id: FG-564
type: story
status: active
title: "Slice 5 — campaign-runner adoption: campaign advancement consumes the same completion primitive and terminal vocabulary"
created: 2026-07-14
---

**Epic:** FG-561 · **PRD:** `docs/prds/durable-orchestration-continuation.md` @ `e6fd56b` (Slice 5)
**Depends on:** FG-552 (wait primitive), FG-562 (durable claim).

## Problem

**BD-10 ("one primitive, multiple consumers") is a GOAL, not a preserved property.** Verified against the
FG-425-merged tree: the launch module is imported by exactly one module — the launch CLI. **The campaign
executor has zero coupling to launch records.** So there is no shared primitive to preserve yet; this
slice creates the second consumer without creating a second mechanism.

The risk this slice exists to prevent: the orchestrator and the campaign runner growing **different event
transports or different interpretations of launch truth**.

## Scope

- Reuse the Slice 2 wait/subscription primitive. **Do not build a second watcher, a second terminal
  classifier, or a campaign-only event table** unless a documented storage boundary genuinely requires it
  (and then say so explicitly).
- Map completion into the existing durable campaign/item state and the Slice 3 claim semantics.
- Preserve campaign blocker and continue-policy behavior.

## FG-425 constraints a continuation claim MUST preserve

These are not incidental — they are settled publisher/campaign semantics, and a claim that ignores them
will fight the publisher (**F21** must assert the claim *preserves* them, not merely that "the same
classifier is used"):

- **The `awaiting_recovery` park stamps a deliberately SHARED `git_state` blocker** while a publication is
  unresolved. The publish target is shared across campaign items, so an unsettled window genuinely impairs
  the others. The blocker is cleared at the **centralized ship transition**. Do **not** "simplify" this
  into a non-shared park kind — the defect that was fixed was its **lifetime**, not its kind.
- **A cancel is terminal and wins.** Recovery never resurrects a cancelled task — **but the operator must
  still be told when a cancelled task's candidate DID land.**
- **Bounded resume convergence** (`CONVERGE_LIMIT = 2`, `src/campaign/executor.ts:670`). `forge campaign
  resume` converges a lost publication window through the AD-5 convergence authority before parking.
- **A terminal refusal may NEVER stand over an attempt still recorded `publishing`.**

## Acceptance Criteria

- **F21**: the campaign consumes launch completion through the **same** classifier and primitive as the
  orchestrator; existing campaign policy is preserved.
- The campaign runner has **no second event transport, no second terminal vocabulary, and no
  campaign-only completion table** (or a documented storage boundary justifying one).
- A continuation claim on a campaign item preserves each of the four FG-425 constraints above —
  demonstrated by test, not asserted.
- Campaign ordering, gates, cancellation, recovery, and publication states do not introduce a continuation
  constraint that the primitive cannot express. If they do, that is a finding against FG-562, not a local
  workaround here.
- Duplicate/lost completion events against a campaign item are safe (BD-5).

## Not in scope

- Redesigning FG-425's integration publisher, lane, mutex, recovery, or worktrees. **The publisher
  architecture is SETTLED** — no PID probing, signalling, identity nonces, zombie classification, or
  reaping; validation stays inside the lane turn.
- Parallel campaign lanes (FG-396).
