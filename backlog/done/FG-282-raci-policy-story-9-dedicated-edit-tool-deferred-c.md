---
id: FG-282
type: story
status: done
title: "RACI policy Story 9: dedicated edit tool (deferred convenience)"
closed: 2026-06-19
---

**Epic:** #273. **PRD:** `docs/prds/raci-routing-policy.md`.

A CLI wizard or dashboard form that writes the RACI within guardrails, sitting on top of `forge raci validate`. DEFERRED: the orchestrator-mediated channel (Story 6) already gives a non-technical operator a safe authoring loop with zero new UI, so the standalone tool is a later convenience for direct manipulation, not a foundation piece.

Acceptance:
- Tool writes only valid RACI (every write passes `raci validate`; structurally cannot emit an unknown agent, non-human accountable, or weakened force rule).
- Picks `responsible` / `consulted` / `informed` from known vocab rather than free text.
- Form/wizard shape decided at build time (CLI wizard vs dashboard form).
- Lower priority than Stories 1-8.

Relations: #273.