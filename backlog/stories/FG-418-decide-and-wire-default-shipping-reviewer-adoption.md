---
id: FG-418
type: story
status: active
title: Decide and wire default Shipping Reviewer adoption path
created: 2026-06-30
---

## Problem

The Shipping Reviewer is fully built, mapped, guardrail-substantiated, reachable in the dispatch path, and now documented (FG-381/383/384/388). But it is **dormant**: no default workflow lists `shipping-reviewer` in its `reds`, so it never actually runs. It is available as a role + Reviewer Context Packet + verdict-mapping, not yet adopted by any shipped workflow.

## Goal

Decide and wire a deliberate default adoption path so the Shipping Reviewer runs in at least one real default workflow, with its authority chosen on purpose rather than by omission. Start narrow and advisory; promote to authoritative only when the evidence supports it.

## Acceptance Criteria

- Identify which default workflow phase should run `shipping-reviewer`, and document the rationale.
- Wire it into exactly ONE mutating feature workflow first — not every workflow.
- The reviewer is visible in the real dispatch path for that workflow (it actually runs and its verdict is recorded), proven by an integration test that asserts the default workflow dispatches `shipping-reviewer`.
- Authority decided deliberately and recorded:
  - `gate_on_verdict: false` (advisory) first, while host-verification evidence is still unrecordable (done-audit `host_verification` is always `unknown` for real items today, so a real `ship`/`pass` is unreachable — see FG-388 docs);
  - promote to authoritative (`gate_on_verdict: true`) ONLY once a host-verification recorder exists to supply evidence, OR the workflow carries an explicit accepted-exception policy.
- Report and operator surfaces (`forge campaign report` / show / dashboard as applicable) show the shipping-reviewer result.

## Non-Goals

- Do NOT adopt the reviewer across every workflow in this ticket — one mutating feature workflow only.
- Do NOT build the host-verification recorder here (that is the separate unlock for a real done-audit `pass`); this ticket may reference it as the gate to authoritative promotion but does not implement it.
- Do NOT change `mapShippingReviewerVerdict`, the Reviewer Context Packet contract, or gate.ts aggregation — those are settled (FG-384). This is adoption/wiring + visibility, not reviewer-behavior change.

## Context

- Verdict mapping, packet, and fail-loud precondition: see `docs/concepts.md` (Shipping Reviewer section, FG-388) and `src/v2/runNext.ts` (`mapShippingReviewerVerdict`, dispatch wiring ~617-650, 888).
- Phase-3 plan tracking: `docs/campaign-runner-plan.md`.
- Follow-up dependency for authoritative promotion: a host-verification recorder (not yet filed/built).

Related: FG-384 (reviewer build), FG-388 (contract docs), FG-385 (risk-targeted reds planner), FG-372 (Shipping Reviewer epic).
