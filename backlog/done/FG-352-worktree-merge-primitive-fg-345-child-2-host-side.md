---
id: FG-352
type: story
status: done
title: "Worktree merge primitive (FG-345 child 2): host-side sequential --ff-only merge-back, merge_conflict failure_kind, retain-branch-on-conflict"
created: 2026-06-22
closed: 2026-06-23
---

**Parent:** FG-345. **Depends on:** FG-351 (foundation). Covers the SINGLE-PRIMARY (sequential) merge path; fan-out ordering is FG-353.

Add the reconcile/merge step forge does not have today. The merge runs **host-side** (`git merge` via child_process against the main repo), **after reds + gate**, as the last action before `markTaskComplete` (runNext.ts dispatchSingleStep, after the reds block ~line 407, before finalizePrimary ~line 409).

## Scope
- **Sequential merge strategy (DECIDED): `--ff-only`.** Because the wave model only dispatches step B after step A is `complete`, and this merge lands on `HEAD` synchronously before `complete` fires, `HEAD` is the authoritative tip when B's worktree is created — so a fast-forward is always valid. No new "current tip ref" DB field needed for the sequential case.
- **New failure state (DECIDED): `merge_conflict` in `src/v2/failure-kind.ts`.** "Agent succeeded, reds passed, gate resolved, but git merge conflicted" has no current home. Task transitions to `failed` with this kind; write the conflicting files / `git status` into the task dir for inspection; the run is terminal (complete-with-failed-tasks per existing run-status model).
- **Retain branch on conflict (DECIDED):** the `forge/<run>/<task>` branch + worktree are NOT deleted on `merge_conflict` — retained for debugging. Deleted only on successful `--ff-only` merge.
- Merge is host-orchestrator-owned (not a container, not a new agent type) — both worktree and main repo are host-side.

## Acceptance
- A clean single-primary step merges `--ff-only` to HEAD before completing; worktree+branch removed.
- An induced conflict produces `failure_kind: merge_conflict`, retains the branch/worktree, writes conflict artifacts to the task dir, marks the task failed.
- forge-test green incl. a forced-conflict negative-path test.

Refs: runNext.ts:363/370-406/407-409, src/v2/failure-kind.ts, src/v2/reconcile.ts.
