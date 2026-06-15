---
id: FG-92
type: story
status: done
title: Architect seed rewrite (systems-architect, not implementation-tutor)
---

**Closed:** 2026-05-09 morning, on branch `graph-view-85` (233 tests passing — seed-only change, no test deltas).
- `seeds/agents/architect/CLAUDE.md` rewritten. Role reframed to "surface what makes a feature hard/slow/expensive/impossible; decide where logic lives, who owns what state, what's authoritative for what." Explicit anti-pattern list: don't pick type names, function names, file paths, or "do X this way when both are valid." Worked example contrasting bad output (the actual line-level outputs from task-architect-c29474) against good output (boundary-risk + scaling + workflow-as-source-of-truth + prior-art references).
- New output schema: `{risks, constraints, boundaries, priorArt, openQuestions, notes}`. Empty arrays explicitly OK — "five real entries beat fifteen padded ones." Each entry should cite real evidence (file paths, real risks).
- Test for the architect's output earning its tokens: does any entry reference something the implementer wouldn't naturally see from inside the code? If not, the run was waste.
- Three workflow files updated to point at the new schema: `feature.ts`, `feature-ui-design-needed.ts`, `feature-ui-design-provided.ts`. Each `workflowAdditions` string mentions the new field set + reminds the agent that this is NOT implementation guidance.
- Dashboard `workflowSchema.ts` brief-field help copy updated.
- Reinstalled via `FORCE=1 install-seeds.sh`.
- Composite with #73 (reds-as-reviewer): same shape of category mistake — wrong job description. #73 still open as an architectural call.