---
id: FG-91
type: story
status: done
title: Reconcile bypasses gate=human on recovery
---

**Closed:** 2026-05-12 on commit `91f9e17`. **First end-to-end forge feature run that landed real spine code on forge itself.** Architect agent caught two material errors in the original brief (the fix needed to branch on `gate !== "auto"` not `gate === "human"` to also cover `gate: "verdict"`; and needed `markTaskAwaitingGate` not bare `setTaskStatus` to preserve the result payload for human review). Shipped fix:
- `src/spine/reconcile.ts`: orphan blue recovery now branches on phase.gate — `auto` → `markTaskComplete`, otherwise → `markTaskAwaitingGate`. Red-task path unchanged (guarded by `!task.parentId`).
- 3 new tests cover gate=auto, gate=human, gate=verdict paths; 2 pre-existing tests fixed to pin `gate: "auto"` so they actually exercise the auto branch (they were silently relying on the old broken behavior).
**Item 3 (reds-during-reconcile)** split out as #107 — separate design question.