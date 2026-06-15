---
id: FG-288
type: story
status: done
title: "RACI routing: distinguish architectural novelty from precedent-driven multi-file implementation"
---

**Closed:** 2026-06-05.

**Epic:** #273. **Caught:** 2026-06-05 during Pixtron NBA routing test.

The global RACI currently nudges `implementation_full` for "multi-file" / "cross-cutting" work and `implementation_quick` for "small" / "targeted" work. Pixtron exposed a better discriminator: a task can be multi-file and cross-cutting, yet still not need architect + tech-lead if it is a direct precedent application with an existing concrete plan. The NBA work spans Go, migrations, and web-admin, but mirrors existing WNBA/MLB patterns and already has `NBA-PLAN.md`; forcing the full feature pipeline would add ceremony without reducing risk.

Decision to encode: full pipeline is for architectural novelty, unclear boundaries, missing implementation plan, new integration shape, or risk that needs architect/tech-lead decomposition. Quick chain can handle precedent-driven multi-file work when the pattern is established, the implementation plan is concrete, and mandatory test-engineer followup remains in force. Documentation followup still applies when operator behavior changes.

Scope:
- Update `seeds/forge-raci.md` routing guidance for `implementation_full` vs `implementation_quick` so "multi-file" alone does not force the full workflow.
- Refine `classification_hints` if useful: `implementation_full` should emphasize architectural novelty / unclear plan / high-risk decomposition; `implementation_quick` should include precedent-based implementation / existing plan / clear bounded change.
- Keep the compiled policy shape unchanged unless hint wording changes require recompile; this is primarily global routing guidance.
- Add or update a test/fixture if the orchestrator-template route examples encode full-vs-quick language.

Acceptance:
- A real-project case like Pixtron NBA (multi-file, precedent-based, existing plan) routes to `implementation_quick` unless the human explicitly wants the full pipeline.
- Full pipeline still clearly handles genuinely novel, ambiguous, high-risk, or architecture-affecting implementation.
- The guidance preserves mandatory `test-engineer` followup on quick implementation.
- Operator-visible changes still trigger `docs_impact` informed handling; quick does not mean "no docs."

Relations: #273, #287, `seeds/forge-raci.md`.