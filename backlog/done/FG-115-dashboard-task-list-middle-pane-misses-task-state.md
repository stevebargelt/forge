---
id: FG-115
type: story
status: done
title: Dashboard task list middle pane misses task-state transitions (smart-refresh gap)
---

**Closed:** 2026-05-23. Commit `post-v2-dashboard-split`.

**Why:** Caught 2026-05-12 during the System Map (#105) forge run. Two distinct cases, same underlying gap:

1. **Status transition.** Clicked "Run Next", architect task transitioned pending → running. Task pane (right) showed running correctly; task list (middle) stayed at `pending`.
2. **New downstream task.** Gate-advanced the architect, next-phase task was created via `createPhaseTasks` (gate.ts:120). Task pane reflected the new task; task list (middle) didn't show it until hard refresh.

Both self-correct on Cmd+R. DB state is honest; the middle pane's smart-refresh (#72) is dropping at least two event classes: `task.started` and `task.created`.
**How to apply:** Audit the middle pane's event subscriptions / render trigger. Likely one of:
- Smart-refresh only listens for run-level events (run.created / run.completed), not task lifecycle
- `task.started` + `task.created` events are emitted but the SSE/poll-derived state-update doesn't reach the middle-pane render path
- The middle pane renders from a snapshot computed once at run-open time; subsequent task list changes don't invalidate the snapshot
The two cases share a root cause — the middle pane isn't subscribed to the task-list-changed signal. Fix the subscription, both cases resolve.
**Composite with #77:** exactly the failure mode #77 (Preact + htm) calls out — html.ts hand-rolling reactive primitives, missing edges between event and re-render. Fixing in place is fine; eventually #77 makes this class of bug structurally impossible.
**Caught:** 2026-05-12 — during the #105 forge run.