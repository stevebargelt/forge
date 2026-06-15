---
id: FG-136
type: story
status: done
title: Rebuild v2-aware pill row in the dashboard
---

**Closed:** 2026-05-14. Commit `277ee18`.

**Why:** v2 cutover deleted the v1 Workflow TypeScript type that `buildPhaseShape()` consumed. `src/dashboard/queries.ts` now returns `phaseShape: []` unconditionally; the run page renders zero pills. Task table still works.

**What's needed:** a `buildPhaseShape(workflow: v2.Workflow, tasks: Task[])` against `src/v2/schema`'s Workflow shape. The v1 Phase fields the dashboard consumes are: `name`, `agents[].role`, `gate`, `fanout`, `fanoutFromUpstream`, `reds`. v2's equivalent: `steps[].id`, `steps[].agent`, `steps[].gate`, `steps[].fanout`, `steps[].reds`. Mostly a renaming exercise.

**Composes with #137** — if the dashboard moves to its own repo, this work happens there instead. Decide between them before starting.

**Where to start:** `src/dashboard/phaseShape.ts` (currently stubbed to return `[]`). The old logic lives in git history at `b818f27^` if you want to compare. queries.ts:165 has the TODO marker for the rewrite point.

**Caught:** 2026-05-14 — stubbed deliberately during v2 cutover to ship the rest.