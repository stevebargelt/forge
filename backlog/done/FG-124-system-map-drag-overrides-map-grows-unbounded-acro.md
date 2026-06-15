---
id: FG-124
type: story
status: done
title: System Map drag-overrides Map grows unbounded across run switches
---

**Closed:** 2026-05-23. Commit `post-v2-dashboard-split`.

**Why:** Caught 2026-05-13 by red-build-337afd during System Map (#105) red review (severity: low). Module-level `dragOverrides = new Map()` is keyed by runId — opening the System Map on run A, dragging some nodes, closing, opening on run B, repeat — each runId accumulates its own inner Map of `{taskId → {x,y}}` and never gets cleaned up. Across a long dashboard session viewing many runs, the outer Map grows. Functionally fine: entries are tiny objects, no perceptible memory pressure even with hundreds of runs. But it's bounded-by-the-user's-patience, not bounded-by-anything-meaningful.
**How to apply:** A few options worth weighing:
- Cap the Map to N most-recently-used runs (10? 20?) with a simple LRU. Cheap.
- Clear entries on `loadRunDetail` for runs other than the current one. Simpler — only the current run keeps its drag state. Slightly worse UX (switching back to a run you previously organized loses your layout).
- Persist drag positions to DB per-run instead of in-memory. Counter to the explicit "drag-stable per-run-while-viewing only" decision in #105's PRD. Not the right move.
Lean LRU at 10 runs. Caps without forcing UX loss.
**Caught:** 2026-05-13 — red review of System Map build.