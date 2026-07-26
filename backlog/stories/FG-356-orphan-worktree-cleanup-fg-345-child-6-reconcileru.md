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

## Scope widened by the FG-345 decision (2026-07-26)

FG-345 recorded the operator decision: **mutating agents get private writable Git; Forge retains
publication authority.** Under that decision the workspace substrate follows capability, so there are
now TWO kinds of per-task workspace to reap, not one:

- **Linked worktrees** — non-mutating agents (reds/reviewers), FG-559's read-only parent `.git` mount.
  Removed with `git worktree remove` as this ticket already specifies.
- **Private `--shared` clones** — mutating agents, being built in FG-621. A clone is NOT a registered
  worktree: `git worktree remove` does not apply and `git worktree list` will never show it. Reaping it
  is a directory removal plus disposal of its private branch/refs, and the clone's alternates point back
  into the parent object store, so removal must not be attempted while the parent is mid-`gc`.

**This ticket owns the reaper for BOTH.** FG-621 explicitly does not implement a second one. Whichever
child lands first should leave the other substrate's hook as a stated, tested no-op rather than an
unhandled case.

Recovery half, carried down from FG-345's default-on acceptance list:

- **A crash must leave a RECOVERABLE private workspace/branch plus durable evidence; cleanup cannot
  silently discard it.** This is the direct tension in this ticket — the reaper exists to stop leaks,
  and the recovery contract exists to stop discards. Retain-on-`merge_conflict` (FG-352) is the existing
  precedent for the retain side; a mutator's private clone holding uncommitted or unfetched commits is
  the new case. Removal must be provably safe before it runs, not best-effort.
- `forge ops check` currently reports every historical orphan forever (FG-549). Do not read a clean
  `ops check` as proof this reaper works; assert on the filesystem and on Task rows.

## Added acceptance

- **CORRECTED 2026-07-26 — this line originally demanded that a mutating task's private clone and its
  branch be REMOVED on the next `reconcileRun`, which contradicted this same ticket's scope note (and
  FG-621's) requiring the clone path to be an explicit, tested no-op. The orchestrator wrote both; the
  reviewer caught the contradiction. The decided scope stands: FG-621 owns clone reaping.** What FG-356
  must prove is that a private clone is CLASSIFIED as its own substrate and RETAINED with reason
  `private_clone_substrate` — never silently fall through an unhandled path, and never be removed by
  this ticket's reaper.
- A crashed task whose work was never captured is RETAINED, with durable evidence naming the workspace
  path and branch. This holds for every substrate, and it is the half of the contract that must not
  regress when FG-621 implements clone removal.
- **Ignored files count as unrecovered work.** A clean tracked tree is not proof of capture: a
  workspace holding only git-ignored output an agent produced must be RETAINED, not reaped. A capture
  probe that reads `git status --porcelain` without `--ignored` is insufficient.
- A locked worktree is unlocked (or `-f -f`) and removed rather than wedging the reaper permanently.
- Both substrates covered; the not-yet-implemented one is an asserted no-op, not an unhandled path.
