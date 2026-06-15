---
id: FG-279
type: story
status: done
title: "RACI policy Story 6: orchestrator-mediated authoring (primary edit channel)"
---

**Closed:** 2026-06-05.

**Epic:** #273. **PRD:** `docs/prds/raci-routing-policy.md`.

Wire the conversation-driven edit loop as the PRIMARY way a human changes routing: the operator says what they want in plain language, the orchestrator translates it to a concrete RACI edit, gated by the validator. This is the channel that makes the non-technical-human-within-guardrails goal real with zero new UI.

Acceptance:
- Flow: propose -> `raci validate` -> compile -> `route validate` -> show the operator the rendered diff -> human confirms -> commit.
- Never a silent self-edit: changing governance always requires explicit human confirmation of the diff (the orchestrator would be editing the rules it operates by — a self-modification loop).
- Every change is audited (commit / logged entry), reviewable after the fact.
- The validator structurally prevents an invalid write (unknown agent, non-human accountable, weakened force rule).
- Tests/fixtures cover an accepted edit, a rejected (invalid) proposed edit, and the confirm-gate.

Relations: #273, `seeds/orchestrator-template.md`.