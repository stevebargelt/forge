---
id: FG-122
type: story
status: done
title: Dashboard request-changes doesn't auto-dispatch the replacement task
---

**Closed:** 2026-05-25. Obsolete — the dashboard is read-only now; all gate decisions go through the orchestrator session, not dashboard clicks. There is no "request changes" button left to fix.

**Why:** Caught 2026-05-13 during System Map (#105) planner iteration. Workflow: click "Request changes" with rationale on the planner output. Spine inserts a new pending task for the same phase per `gate.ts:173-179` (re-queue with rationale injected as `inputs.requestedChanges`). Expected: dashboard automatically dispatches the new task (same way #108 chained gate-advance into `forge next`). Actual: the new task sits at `pending` until the human clicks "Run Next" a second time. Two clicks for what should be one action.

**Why this is a real bug, not a UX preference:** Request-changes IS the human's "redo this" decision. There's no second decision pending; nothing else the human reasonably wants to do between "request changes" and "dispatch the redo." The two-click pattern adds friction without adding choice.

**How to apply:** Look at how #108 wired advance auto-dispatch — same hook, same pattern. The dashboard's `/api/gate/:taskId` handler returns `nextTasks` from `gate()`; for advance, the dashboard chains into `next()`. The request-changes branch returns the replacement task in `nextTasks` too but the dashboard doesn't follow up. Probably 5-10 lines in the dashboard's gate handler — same auto-dispatch hook, just trigger on request-changes too.

**Doesn't apply to:**
- `reject` — that loops to a *different* phase via `onReject`; auto-dispatching could surprise the human (different phase, different agent, may want to pause).
- `advance` — already auto-dispatches per #108.
- `request-changes` to a manual phase — these throw at the spine layer per `gate.ts:152-157` so they can't reach this path.

**Composite with #115** (middle pane misses task.created): if #122 ships first, the request-changes flow becomes "click, see new task running" — which only works correctly if the middle pane actually shows the new task. #115 fixes the rendering gap; #122 closes the auto-dispatch gap. Both needed for the flow to feel right end-to-end.

**Not relevant for #116:** in the YAML orchestrator, request-changes is probably just a step-re-spawn, not a separate task-row insertion + dispatch. This is a v1 patch.

**Caught:** 2026-05-13 — after iterating planner output three times on System Map run.