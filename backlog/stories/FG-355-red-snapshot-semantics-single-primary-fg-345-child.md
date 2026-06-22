---
id: FG-355
type: story
status: active
title: "Red snapshot semantics — single-primary (FG-345 child 5): reds mount the primary task's worktree read-only"
created: 2026-06-22
---

**Parent:** FG-345. **Depends on:** FG-351 (needs Task.worktreePath). **Single-primary path ONLY** — fan-out red timing is owned by FG-353 (integration branch). Keep the boundary explicit so the two don't collide.

For a single-primary step, reds must mount the PRIMARY's worktree read-only — the frozen snapshot of exactly what the primary produced — not `run.projectDir` (which may be mid-merge from a concurrent/sequential neighbor). This is the existing red read-only mount principle applied to the worktree.

## Scope
- `dispatchReds` looks up the primary task's `worktreePath` and passes it as `projectDir` to `runOneRed` with `projectMode: 'ro'` (runNext.ts:618-629, currently passes `args.projectDir`).
- Ordering: for single-primary, reds run BEFORE the FG-352 merge (the worktree still exists). The merge is the last action after reds+gate.

## Acceptance
- A single-primary step's red container's `/project:ro` == the primary's worktree tree (verified), not main HEAD.
- forge-test green; a test asserts the red sees the primary's uncommitted-to-main changes.

Refs: runNext.ts:618-629, FG-353 (fan-out counterpart), red read-only mount principle.
