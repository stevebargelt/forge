---
id: FG-33
type: story
status: done
title: Resolve workflowAdditions vs base output schema conflict
closed: 2026-06-21
---

**Why:** Hit a real failure: framer's base CLAUDE.md says output `{claims, experiments}` while `codebase-assessment.scope.workflowAdditions` says output `{lenses, priorities}`. The composed prompt had both schemas — the agent saw two contradictory contracts and asked for clarification instead of obeying either.
**How to apply:** Two design options to discuss before implementing:
1. `workflowAdditions` explicitly replaces the base schema. `composeSystemPrompt` emits a marker that overrides the base — agent obeys the most-specific schema.
2. Make workflows reference roles whose base CLAUDE.md already matches the workflow's schema (e.g. don't reuse `framer` for scoping if its schema is investigation-shaped).
Lean toward (1).