---
id: FG-482
type: story
status: active
title: blocked_by_red is a non-atomic 4-write sequence that transits through awaiting_gate — crash mid-sequence lets an authoritative red block be advanced without --force (review F3)
created: 2026-07-07
---

Source: independent engineering review 2026-07-06 (notes/forge-engineering-review-2026-07-06.md, finding F3 — CRITICAL). Review of main @ fbb070c.

## Problem

runNext.ts:598-604 — setTaskStatus(blocked_by_red) -> logEvent -> markTaskAwaitingGate(taskId, result) (status becomes awaiting_gate) -> setTaskStatus(blocked_by_red) again, with the in-code admission "markTaskAwaitingGate just wrote status=awaiting_gate; restore the block." Not wrapped in getDb().transaction() (the verdict insert directly above, :816-833, IS transactional). The fanout variant (runNext.ts ~:1538-1540) is a DIFFERENT shape with the same crash window: markTaskAwaitingGate(parentId, parentResult) -> setTaskStatus(blocked_by_red) -> logEvent — a crash between those two writes persists awaiting_gate. (The source review's F3 text claimed 'same shape'; a red-architect review of this ticket disproved that against fbb070c — same fix applies to both sites regardless.)

A crash between writes 3 and 4 persists the task as awaiting_gate with its result set — indistinguishable from a legitimately gate-ready task. reconcile.ts only repairs `running` tasks, so it is never corrected. gate.ts's non-force verdict re-check (:103-120) only throws on authoritative fail when step.gate === "verdict" — for a gate: auto/human step the red's authoritative fail is not re-checked, so the operator (or the campaign's auto-advance) advances straight over an authoritative block.

## Fix direction (from the review)

A single-transaction markTaskBlockedByRed(id, result) in the store layer that writes status + result in one UPDATE and never passes through awaiting_gate; use it at both sites (single-step and fanout).

## Goal

A task can never be observed in `awaiting_gate` while becoming `blocked_by_red`: the transition is one atomic store-layer write (status + result together), used by both the single-step and fanout sites, so no crash window exists in which an authoritative red block is advanceable without --force.

## Acceptance criteria

- [ ] One store-layer write (single UPDATE or one transaction) moves a task to blocked_by_red with its result; the task is never observable as awaiting_gate at any point in that transition.
- [ ] Both call sites (runNext.ts single-step ~:598-604 and fanout ~:1519-1523) use it; the "restore the block" double-write shape is gone.
- [ ] Fault-injection test: a throw after the first write of the old sequence's shape cannot leave the task awaiting_gate — with the new write, a throw leaves the task in its PRIOR state (running/awaiting_red), never a half-transition.
- [ ] Regression: a blocked_by_red task still refuses non-force advance at the gate; events (task.blocked_by_red or equivalent) still emitted exactly once.
- [ ] gate.ts's authoritative-fail re-check is made UNCONDITIONAL (applies to gate: auto/human steps, not only step.gate === 'verdict') so an awaiting_gate row carrying an authoritative-fail verdict — from any past or future source — refuses non-force advance. (F3's second half per the review's why-it-matters; architect openQuestion 1 answered YES. Narrow: do NOT fold in F16's full verdict-aggregation unification.)
- [ ] No data-repair pass: host audited 2026-07-07, zero awaiting_gate rows carrying an authoritative-fail verdict exist (architect openQuestion 2 answered: out of scope, evidence-based).
