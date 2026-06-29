---
id: FG-413
type: story
status: done
title: Wire readiness preflight into the campaign runner (populate report readiness; hold not-ready items at start)
created: 2026-06-26
closed: 2026-06-29
closed_commit: 925967d
---

## Problem

FG-382 ships a mechanical readiness evaluator + CLI, but the campaign runner does not consume it yet: campaign report's readiness field is still null/unavailable, and campaign start/resume will dispatch an item regardless of its readiness. This is the campaign-side half of FG-382 (Option B), and the Phase-3 campaign-runner-plan exit criterion 'readiness is checked before starting each campaign item'.

## Goal

Integrate the FG-382 readiness evaluator into campaign execution.

## Acceptance Criteria

- campaign report populates the readiness field per item using the FG-382 evaluator (replacing the current null/unavailable).
- campaign start/resume evaluates readiness before dispatching each item: an item that is needs_refinement or blocked is NOT dispatched — it is HELD (reuse FG-393 hold semantics: outcome=held, a clear reason e.g. 'held because not ready: <gaps>', and the refinement proposal surfaced) rather than burning implementation tokens.
- exploratory items are allowed to proceed (lighter criteria).
- show/report surface the readiness state + refinement proposal + next operator action (refine the ticket, then resume).
- This must compose cleanly with FG-393 blocker/continue + the campaignBlocker/default-deny consistency invariants (a not-ready item is a pre-dispatch hold, distinct from a post-dispatch blocker).
- Tests: a campaign with a not-ready item holds it (not dispatched) with the refinement reason; a ready item proceeds; an exploratory item proceeds; report readiness field populated.

## Non-Goals

- Do not change the FG-382 evaluator semantics here (consume it).
- Do not implement done-audit (FG-383) or reviewer (FG-384).

## Relations
- Depends on FG-382 (the evaluator). Child of FG-372 / campaign Phase 3. Interacts with FG-393 hold semantics.