---
id: FG-429
type: story
status: done
title: "Orchestrator: resolve route from policy; do not ask operator to adjudicate route when policy is decisive"
created: 2026-07-01
closed: 2026-07-06
closed_commit: 1e0d65f
---

## Problem

The orchestrator asked the operator to choose between `implementation_quick` and `implementation_full` for a change where the routing policy had a decisive answer (a trust-gate write path that can mark a campaign item shipped, a campaign-state mutation, done-audit/audit-boundary semantics, cross-cutting reconciliation behavior, and spoofing risk -> `implementation_full`). Route-key selection is a policy-derived decision, not an operator preference. Asking the operator to adjudicate it adds friction and undercuts the routing policy that exists precisely to make this call.

## Goal

The orchestrator resolves the route from the compiled routing policy and the RACI routing-guidance discriminators (novelty + plan-certainty + risk), then proceeds — surfacing the resolved route and rationale (Step 3). It asks the operator only when the route is genuinely ambiguous under policy, or when scope/product intent is unclear.

## Acceptance Criteria

- Orchestrator operating guidance (seed / orchestrator template) states explicitly: resolve the route from policy and proceed; do NOT ask the operator to choose the route key when the policy discriminators give a decisive answer. Surface the resolved route + rationale rather than posing route selection as an operator choice.
- The quick-vs-full discriminator is applied by the orchestrator itself (per the RACI routing guidance); the operator is asked only on genuine ambiguity or unclear scope/product intent.
- Documented with a positive example (decisive -> resolve + proceed, surface rationale) and the ambiguous case (ask).

## Non-Goals

- Does NOT remove operator confirmation of the PLAN / scope / product intent — that stays. This is specifically about not outsourcing route-key selection when policy is decisive.

## Relations

- Orchestrator template routing steps (#287 / #297: resolve route before dispatch, carry the resolved key).
- RACI routing guidance (quick-vs-full discriminator).
