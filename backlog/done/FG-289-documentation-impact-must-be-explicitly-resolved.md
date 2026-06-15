---
id: FG-289
type: story
status: done
title: Documentation impact must be explicitly resolved
---

**Closed:** 2026-06-05.

**Caught:** 2026-06-05 during Pixtron NBA routing test.

Documentation keeps getting missed or left to memory, and then goes stale. The routing policy already has `docs_impact:when=operator_behavior_changed` as an informed signal, but an informed signal is too passive: it can be noticed and then silently dropped. We need a structured docs-impact lifecycle so implementation routes close the docs question explicitly.

Proposed lifecycle:
- Detect docs impact as one of: `none`, `operator_behavior_changed`, `public_api_changed`, `workflow_changed`, `setup_changed`, `architecture_changed`.
- Resolve any non-`none` impact with exactly one outcome: `updated`, `not_needed_with_reason`, or `deferred_to_backlog`.
- Route to `documentation-maintainer` when durable docs are needed; do not force docs work for every tiny operator-visible tweak, but never skip without a stated reason.
- Verify during test/review that the claimed docs outcome matches the change.

Acceptance:
- Orchestrator guidance says `docs_impact` is not passive; it must be resolved before the run is called complete.
- Final user summary includes `Docs impact: updated / not needed: <reason> / deferred: #ticket`.
- If docs are deferred, a backlog ticket is required.
- Implementer seeds tell agents to flag docs-affecting changes in their result.
- Test/review guidance can call out missing or implausible docs-impact resolution.
- Pixtron NBA-style operator-visible changes either get a documentation-maintainer followup or an explicit "not needed" reason based on existing docs coverage.

Non-goals:
- No dashboard mutation/editing.
- No mandatory documentation-maintainer invoke for every implementation task.
- No schema change unless the implementation later needs durable tracking beyond prompts/backlog.

Relations: #273, #288, `seeds/orchestrator-template.md`, implementer seeds, reviewer/test seeds.