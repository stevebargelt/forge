---
id: FG-227
type: story
status: done
title: "Workflow-step vocabulary is Claude/legacy-shaped: deprecate step runtime:, rename model: -> activity:/capability:"
---

**Closed:** 2026-06-01. Commit `e0c3384`.

Surfaced by the AWN-7 Walk mixed-provider smoke: a workflow step that routes to Codex via policy still literally reads `runtime: claude`. The smoke proves policy wins, but the step YAML vocabulary is provider/legacy-shaped and confusing.

Two fields in StepSchema (src/v2/schema.ts) are the problem:

1. `runtime: NameSchema.default("claude")` — used ONLY in legacy mode (resolveModelForTask). In policy mode the resolver derives the runtime from the (provider, effective_auth) binding and IGNORES this field entirely. So `runtime: claude` on a step that runs on Codex is dead, misleading config.

2. `model: z.string().optional()` — despite the name it holds a CAPABILITY ALIAS (e.g. "review", "reasoning"), threaded as `stepAlias` (pass-1 capability intent), NOT a concrete model. The ADR's pass-1 vocabulary is "capability"/"activity" (cf. `defaults.activity`), so this should be `activity:` (or `capability:`).

Proposed direction (align to vocabulary forge already chose):
- Rename step `model:` -> `activity:` (matches `defaults.activity` and the ADR's capability pass).
- Deprecate step `runtime:`: meaningless in policy mode. Either drop it once legacy mode retires, or rename to `legacy_runtime:` and document it as the no-policy escape hatch only.

Back-compat is the real work (cross-cutting — every workflow YAML uses these):
- Loader accepts old names with a deprecation warning and maps old->new; do NOT hard-break existing seed/per-project/~/.forge workflows.
- Update all seed workflows (seeds/workflows/*) + docs (how-to-new-workflow, concepts, how-to-model-policy) in the same change.

Scope: schema + loader alias layer + seed workflows + docs. Medium, cross-cutting, reversible. No DB schema change. Tie-in: ADR learnings/decisions/2026-05-30_provider-resolution.md (capability vs profile vocabulary).