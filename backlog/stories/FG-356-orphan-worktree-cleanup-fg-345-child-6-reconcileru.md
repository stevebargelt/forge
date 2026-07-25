---
id: FG-356
type: story
status: active
title: "Orphan worktree cleanup (FG-345 child 6): reconcileRun removes stale worktrees alongside cleanupStagedAuth"
created: 2026-06-22
---

**Parent:** FG-345. **Depends on:** FG-351 (needs Task.worktreePath in DB).

`reconcileRun` (src/v2/reconcile.ts:65-96) finalizes orphaned tasks (marks failed, calls `cleanupStagedAuth`) but has no filesystem side-effect. A crashed/orphaned task leaves a ~12MB worktree behind; on a long-lived host these accumulate silently and eventually break `git gc` / worktree ops.

## Scope
- When `reconcileRun` finalizes an orphaned task, also `git worktree remove --force <task.worktreePath>` (and delete its branch), looked up from the Task row — no filesystem scanning.
- **Respect FG-352's retain-on-conflict:** do NOT remove worktrees/branches belonging to tasks that failed with `merge_conflict` (those are retained for inspection by design). Only orphan/crash artifacts.
- Idempotent: removing an already-gone worktree is a no-op, not an error.

## Acceptance
- An orphaned/crashed task's worktree+branch are removed on the next `reconcileRun`.
- A `merge_conflict`-failed task's worktree+branch are preserved.
- Idempotent across repeated reconciles. forge-test green.

Refs: src/v2/reconcile.ts:65-96, FG-351, FG-352.


## Concrete leak evidence from the FG-530 crash matrix (2026-07-11)

The worktree-tier crash lane (src/v2/fg530-crash-worktree.worktree.test.ts) demonstrated the leak precisely: killing at finalizePrimary:between-complete-status-and-event writes the terminal `complete` status but dies before removeWorktreeIfSafe — recovery sees a terminal task, nothing sweeps the leftover worktree, and the tree + its branch leak permanently, one per such crash. Deliberately NOT pinned as an invariant violation there (a leak is the opposite failure from a discard); this ticket owns the reaper. When implementing, flip that scenario into a positive cleanup assertion in the lane.

## Priority bump + locked-worktree hardening (2026-07-24)

**Promoted:** this is the last substantive blocker to making worktree mode the default, and the default being off is
what allowed the FG-607 live-source incident (see FG-612). Take it directly after FG-607.

**Removal must survive a LOCKED worktree.** `removeWorktree` (src/v2/worktree-lifecycle.ts:203) runs
`git worktree remove --force` — a SINGLE force, which still fails on a worktree git considers locked. Any tool that
adopts and locks a worktree (Supacode does this for worktrees it adopts under its tracked repo roots) therefore
wedges cleanup permanently, and the reaper this ticket adds would inherit the same failure. Use `git worktree unlock`
first, or `-f -f`, and treat "already unlocked" as a no-op.

Current mitigation making this narrow rather than urgent: forge creates agent worktrees under
`WORKTREES_DIR` = `~/.forge/worktrees/<runId>/<taskId>` (src/util/paths.ts:11, :133), outside `~/code` where
Supacode tracks repos — so adoption should not occur for agent worktrees in normal operation. Verified 2026-07-24:
no locked worktrees present on the forge repo. Harden the removal path anyway; it is one flag.
