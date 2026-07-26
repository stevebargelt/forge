---
id: FG-356
type: story
status: done
title: "Orphan worktree cleanup (FG-345 child 6): reconcileRun removes stale worktrees alongside cleanupStagedAuth"
created: 2026-06-22
closed: 2026-07-26
closed_commit: f88de02
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

## Scope boundary — submodules are NOT a reachable risk here (2026-07-26, verified)

Three consecutive review rounds produced escalating submodule findings (probe submodules for ignored
output; then a regression that fix caused in `cleanupFailedWorktreeSetup`; then
`submodule.<name>.ignore=all` hiding a committed submodule change). Before accepting the third, the
premise was checked:

- **`createWorktree` runs plain `git worktree add <path> -b <branch>`** — it never runs
  `git submodule update --init`. A forge task worktree therefore has ZERO initialized submodules; the
  directories exist but `git submodule status` reports them uninitialized.
- **The forge repo itself has no `.gitmodules`** — the dogfood path has no submodules at all.

For round 3's scenario to occur you need a submodule-using project, PLUS something initializing
submodules forge never initializes, PLUS `submodule.<name>.ignore=all`, PLUS an agent committing inside
that submodule. That is not a reachable path; it is an esoteric edge case, and the fixes for it were
becoming riskier than the bug (round 2 existed only because round 1 broke stale-registration recovery).

**Resolution — one conservative rule replaces the machinery:** a workspace containing ANY checked-out
submodule is RETAINED, never reaped. No recursion, no per-submodule porcelain, no per-submodule
reachability. It is a no-op on forge's real path (nothing is ever initialized, so it never fires) and it
fires only in the uncertain case, where retaining is the correct answer. The whole class becomes
structurally impossible rather than patched.

**Do not reopen this by adding submodule probing back.** If forge ever starts initializing submodules in
task worktrees, THAT change is what must revisit this rule — and it should carry its own ticket. Until
then, a submodule finding against the reaper is out of scope by construction.

## Acceptance Evidence

Shipped in `f88de02` (PR #163, squash of 12 commits). Required CI green at the reviewed tip
`d9acfea` — all nine jobs including both required checks `test` and `test-extended`. Bounded
review-loop reported `closeable` (reviewer pass, verification green, reviewed tip equal to the fetched
remote head) after seven loops and five reachable-path defects found and fixed. All tests live in
`src/v2/fg356-workspace-reaper.worktree.test.ts`, `src/v2/fg356-reaper-drive.worktree.test.ts`,
`src/v2/fg356-reaper-evidence.integration.test.ts` and the FG-530 worktree lane.

| AC | Evidence | Verdict |
|---|---|---|
| An orphaned/crashed task's worktree+branch are removed on the next `reconcileRun` | `fg356: an ORPHANED task's worktree and branch are gone after the next reconcileRun`; `fg356 drive: a crashed running task is finalized AND its captured workspace reaped in the same reconcile pass`; `fg356: a duplicate primary this same reconcile finalizes is reaped by this same reconcile — not deferred to a next pass that may never come` (the ordering fix moving `finalizeOrphanedPrimaries` before the sweep, `src/v2/reconcile.ts`) | met |
| A `merge_conflict`-failed task's worktree+branch are preserved | `fg356: a merge_conflict-failed task's worktree and branch are PRESERVED (FG-352 retain-on-conflict)`; `fg356 evidence: every kind in RETAIN_WORKSPACE_FAILURE_KINDS is exercised by the drive lane` — all seven retain-by-design kinds proven on clean AND fully-merged fixtures, with four control kinds reaped over the identical fixture so the KIND is what retains, plus a parity test that fails if a kind is added to the production set without a drive-lane case | met |
| Idempotent across repeated reconciles; `forge-test` green | `fg356: repeated reconciles are idempotent — reaping an already-gone workspace is a no-op, and retention is recorded once`; `fg356 drive: one pass over a run of mixed dispositions settles all of them, and the second pass is a fixpoint`; `fg356 evidence: a retain event survives a store close + reopen, and the reopened process does not re-record it`. Suite green at `d9acfea`: unit 2785, worktree 291, integration 3904 (1 pre-existing environment-gated skip), typecheck clean — and all nine CI jobs green | met |
| A private clone is CLASSIFIED as its own substrate and RETAINED with reason `private_clone_substrate` — never silently unhandled, never removed by this reaper *(corrected criterion — see the Added acceptance note)* | `fg356: a mutating agent's PRIVATE CLONE is an explicit no-op, not an unhandled path (FG-621 owns clone reaping)`; `fg356 evidence: a private clone is retained for its SUBSTRATE even when its tree is clean and its commits are captured`. **Clone REAPING is deliberately not implemented here and this AC does not claim it is** — FG-621 owns that substrate, and FG-345's default-on gate is not closed by this ticket | met |
| A crashed task whose work was never captured is RETAINED, with durable evidence naming the workspace path and branch | `fg356: a crashed task with UNCOMMITTED work is retained, and the evidence names the workspace path and branch`; `fg356: a crashed task whose COMMITS were never captured is retained — a clean tree is not proof the work landed`; and four adversarial drive-lane cases over `complete` tasks (the status the old FG-530 invariant EXEMPTED): uncaptured commits, uncommitted work, merged-then-rolled-back, and a workspace HEAD advanced past the merged branch tip. Every disposition in the drive lane is additionally held to `assertNoWorkDestroyed` — if a workspace is gone, every file it held must be in `projectDir` byte for byte | met |
| Ignored files count as unrecovered work; a probe without `--ignored` is insufficient | `fg356: a crashed task whose only output is GIT-IGNORED is retained — ignored files are unrecovered work, not noise`. Non-vacuous by construction: the test asserts plain `git status --porcelain` is EMPTY first, so `--ignored` is provably the only thing standing between that output and removal (`uncommittedFiles`, `src/v2/worktree-lifecycle.ts`) | met |
| A locked worktree is unlocked (or `-f -f`) and removed rather than wedging the reaper | `fg356: a LOCKED worktree is unlocked and removed rather than wedging the reaper` — the fixture asserts a single `--force` genuinely refuses first, so it cannot pass vacuously. `forceRemoveWorktree` unlocks (already-unlocked is a no-op) then uses the double-force form | met |
| Both substrates covered; the not-yet-implemented one is an asserted no-op, not an unhandled path | The private-clone no-op test above, plus `fg356: a workspace with an UNINITIALIZED submodule entry still reaps — the shape git worktree add actually produces` (pins that the submodule retain rule is a no-op on forge's real path) and `fg356: a workspace with a CHECKED-OUT submodule is retained` | met |

### Additional hardening the review surfaced, beyond the written AC

- **Workspace ownership is verified before removal.** A stale or misassigned `worktree_path` pointing at
  another clean worktree of the SAME repository passed every capture check trivially — clean tree, HEAD
  already reachable — so the reaper would have deleted a tree it was never asked about and then deleted
  the task's branch. Now the workspace's git common dir must match `projectDir` AND its checked-out ref
  must be the task's deterministic branch. Tests: `fg356 drive: a row pointing at ANOTHER task's
  worktree of the SAME repo retains`, `a worktree of ANOTHER repository is never removed`, `a MAIN
  CHECKOUT can never be reaped`, `reconciling one run never touches another run's workspaces`.
- **A completed removal is distinguished from a vanished path.** `forceRemoveWorktree` returned
  `!existsSync(path)`, conflating "git succeeded" with "the directory is gone" — which come apart when
  `git worktree remove` fails and the tree is gone anyway, leaving a stale `$GIT_DIR/worktrees`
  registration. It now returns `{gitRemoved, pathAbsent}` and prunes whenever removal did not cleanly
  succeed; the outcome carries `removal: "git_removed" | "path_vanished"` onto the event. Fixed at the
  source across all five call sites rather than per-call-site. Tests: `a removal git DECLINES whose tree
  is gone anyway is reaped honestly — the registration is pruned, not reported as a clean removal`.
- **A transient branch-delete failure no longer strands a ref.** Tests: `fg356 drive: a branch deletion
  that failed on the reaping pass is retried on a later one`, and `a branch its workspace outlived but
  git will not delete is left alone across passes — never -D`.
- **The retain/reap evidence is readable by a human.** `forge show`'s timeline rendered payload KEY
  NAMES truncated after three, so the event that exists to say where unrecovered work lives named none
  of it. Now rendered as values, asserted end-to-end by a real `forge show` subprocess against a real
  store: `fg356 evidence: forge show names the retained path, branch and reason as VALUES`.

### FG-530 lane

The leak cell at `finalizePrimary:between-complete-status-and-event` is now a positive cleanup
assertion. `assertWorktreeSurvived` became `assertWorktreeDisposition`: every tree must land in one of
two DELIBERATE outcomes — retained (work, row reference, branch and recorded reason intact) or reaped
(tree+branch gone, every file it held present in `projectDir`, disposal recorded once). The shared
invariant-4 checker no longer EXEMPTS a removal on `complete` status; it CHECKS the capture claim, which
is strictly more teeth. Five cells flipped retained → reaped, all of them trees the agent never wrote
into.

**Docs impact: updated** — `docs/concepts.md` (Reaping an orphaned workspace; corrected orphan-recovery
guidance that used to send an operator to a directory reconcile may legitimately have removed),
`docs/SCHEMA-CONTRACT.md` (`task.workspace_reaped` / `task.workspace_retained` payloads and per-(task,
reason) dedupe; `worktree_path` is RECORDED, not live), `docs/invariants.md` #17 (a workspace is
disposed of only against proof of capture; where reap and retain disagree, retain wins).
