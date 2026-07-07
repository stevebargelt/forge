---
id: FG-488
type: story
status: active
title: "campaign driveWorkflowItem no-progress bound: active run + zero dispatch + unchanged state returns recovery_needed instead of spinning (review F2b)"
created: 2026-07-07
---

Source: independent engineering review 2026-07-06 (notes/forge-engineering-review-2026-07-06.md), finding F2b / backlog rec #7. Sibling of the shipped FG-476 fix (F2a); this is the class-level backstop.

## Problem

`driveWorkflowItem`'s drive loop (`src/campaign/executor.ts` ~503-641) is a `while (true)` with no iteration bound, no sleep, and no no-progress detection. When the item's run is active but nothing is dispatchable — e.g. a pending-but-undispatchable task shape, or any future lifecycle bug of the FG-476 family — the loop falls through to `runNextFn`, which returns without dispatching, and spins at 100% CPU until the process tree is killed. This was observed live during the FG-475/FG-476 incident: `forge campaign resume` over a wedged run burned a core.

FG-476 fixed the one known producer of this shape (on_reject recovery task invisible to the ready queue). The loop itself remains unbounded, so the next projection mismatch between "run is active" and "nothing can dispatch" becomes a spin again instead of a recoverable pause.

## Goal

The drive loop detects lack of progress and returns a bounded `recovery_needed` outcome instead of iterating forever. The campaign pauses cooperatively with actionable operator guidance; no manual DB edits, no process-tree kill.

## Acceptance criteria

- [ ] `driveWorkflowItem` detects the no-progress condition — run still active, zero tasks dispatched this iteration, run not settled, and no observable run/task state change since the previous iteration — and returns a `recovery_needed`-class outcome instead of looping.
- [ ] The campaign transitions to `paused` with the item in a recoverable (non-terminal) state and the pause reason names the run so the operator can inspect it.
- [ ] Regression test: drive over a run seeded with a pending-but-undispatchable task asserts a bounded return (loop exits within a small fixed number of iterations), campaign resumable — not a spin. Test must go through the real drive path with an injected/stubbed `runNextFn` that dispatches nothing.
- [ ] Normal progress is unaffected: existing drive-loop tests (dispatch, gate parking, terminal classification) stay green.