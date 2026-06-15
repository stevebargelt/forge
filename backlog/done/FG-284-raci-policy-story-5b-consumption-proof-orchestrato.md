---
id: FG-284
type: story
status: done
title: "RACI policy Story 5b: consumption proof — orchestrator routes from generated policy (MVP proving gate)"
---

**Closed:** 2026-06-05.

**Epic:** #273. **PRD:** `docs/prds/raci-routing-policy.md`.

The gate that CLOSES the inert-artifact risk — sequenced right after Story 5 (#278), part of the MVP, NOT deferred. A validated, compiled policy that no surface reads is still inert, just checkable; the MVP is not done until one surface routes from the generated policy.

Ship `forge route explain` (with `--json`) and point the orchestrator-template at the generated policy as its routing source for at least one work-type. The orchestrator classifies a prompt, calls `forge route explain`, and routes per the structured answer — a real code path consuming the policy, not prose in an LLM's context.

Acceptance:
- `forge route explain <work-type>` and `--json` return the FULL executable route: responsible, path, command (required for `path: cli`), consulted, required_followups, informed (with conditions), classification_hints, and force_rules. A CLI route without command is under-specified.
- Orchestrator-template instructs the orchestrator to consume `forge route explain` as the routing source (at least one work-type; ideally all).
- Proof of life: editing the RACI demonstrably CHANGES the route the orchestrator takes (test: change a route in the RACI, recompile, `route explain` reflects it, orchestrator routes differently).
- Distinct from #283 (Story 10, full provider-adapter generation), which stays deferred.

Relations: #273, #278 (depends on route validate), #283 (the full-generation successor), `seeds/orchestrator-template.md`.