---
id: FG-241
type: story
status: done
title: "Docs drift — Walk: docs_impact / operator_behavior_changed on task contracts"
---

**Closed:** 2026-06-02. Commit `e98b2d5`.

Add docs_impact (none|operator|architecture|migration|api|examples) and/or operator_behavior_changed:bool to AWN-4 task contracts. Depends on Crawl 1-3.

- Default-inferred from changed paths (src/cli, seeds, docs, learnings/decisions, runtimes, auth/model/notify code); orchestrator can override explicitly.
- Auto-suggest documenter (Crawl 1) invocation when those surfaces change.
- Start COARSE: operator_behavior_changed:bool is the gate input. Let the 6-way enum emerge from real usage rather than over-specifying up front (premature precision).