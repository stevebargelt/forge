---
id: FG-621
type: story
status: active
title: "Private writable Git for mutating agents: per-task shared clone at the recorded base SHA, with Forge retaining publication authority (FG-345 implementation child)"
created: 2026-07-25
---

**Reopened 2026-07-26 by operator decision.** FG-345 recorded the call: *mutating agents get private
writable Git; Forge retains publication authority.* This ticket is the implementation child of that
decision — the writable-Git half of FG-345's default-on gate. It is no longer a deferred design option
and no longer needs an architecture exploration; FG-345 carries the architecture, the FG-559 evidence,
and the authority contract.

## Decision being implemented

- **Private commit authority (agent):** a mutating agent may commit freely on a deterministic private
  task branch, in its own repository. Those commits are untrusted checkpoints and transport artifacts.
- **Publication authority (Forge):** only Forge constructs the candidate, runs the authoritative gates,
  updates the target ref, and claims that anything shipped. Forge may squash or replace agent commit
  boundaries.

FG-340 remains correct that agents do not close, merge, publish, or treat a partial commit as the
finished artifact. Its blanket no-commit rule is superseded for isolated mutating agents only.

## Substrate

Per-task **private writable clone** created from the exact recorded base SHA, with the parent object
store exposed read-only:

- `git clone --shared` off a read-only-mounted parent `objects/` — measured during the FG-559
  experiment at **0.106s and <1MB** new storage on this repo, full depth, local commits working, parent
  unwritable (alternates point back into the parent objects).
- Own writable refs, index, and object overlay. The parent repo's refs, index, object store, and target
  branch stay unwritable from inside any container.
- **Non-mutating agents keep FG-559's read-only linked worktree unchanged.** Substrate follows
  capability; this ticket does not touch the red path except to assert it did not regress.

## Why a clone and not a scoped-write worktree (settled — do not relitigate)

Proven during the FG-559 experiment, and the reason this ticket exists at all:

- Whole parent `.git` mounted **read-write**: a container successfully created a branch in the parent
  repo. Incompatible with the red boundary (`docs/invariants.md` #9).
- **Scoped-write** (ro except `objects/` plus the task's own ref + reflog dirs): protects the ref
  namespace — `main`, `origin/*`, and packed refs all proven refused — but a writable `objects/` is a
  **deletable** `objects/`. The container can destroy the parent's history and every sibling worktree's
  basis. Four separately-scoped nested mounts, including a reflog directory that only surfaced by
  running it. Complexity with no boundary guarantee.

Stated plainly: **worktrees isolate the WORKING TREE, not the repository.** FG-559 is what exposed the
distinction, and it is why the writable path needs a separate repository rather than a finer mount.

## Scope

1. **Creation.** For a mutating task, provision a private clone at the recorded base SHA on a
   deterministic private task branch, in place of today's linked worktree. Record workspace path, base
   SHA, and branch ref on the Task row (the same state FG-351 established).
2. **Base selection.** Sequential tasks clone from the exact accepted PREDECESSOR candidate, not from
   `HEAD` and not from the run's original base. Fan-out siblings clone from the same recorded base and
   integrate through the existing ordered candidate path. (FG-345 hard constraint 2 — the trap that
   naive isolation adds a merge step to a path that never collided.)
3. **Completion capture.** On completion, Forge safety-commits any remaining dirty state — **tracked
   AND untracked** — then retrieves the agent's own commits.
4. **Merge-back re-plumbing.** The task branch no longer exists in the parent's ref namespace, so
   `mergeWorktreeBranch`'s `git merge --ff-only <branch>` (`src/v2/worktree-lifecycle.ts`) is replaced
   by `git fetch <clone> <branch>` followed by candidate construction. **This re-plumbing is the real
   cost of the ticket** and is why FG-559 rejected clone-as-default at the time.
5. **Stale contract correction.** `src/v2/worktree-lifecycle.ts:231-242` documents agent-side commit as
   the primary path with host auto-commit as the safety net. Under this decision that contract becomes
   true again for mutators — reconcile the comment to the shipped behavior rather than deleting it, and
   state explicitly which substrate each half applies to.
6. **Dependency-volume composition (verify, do not rebuild).** A clone of the same commit has a
   byte-identical `package-lock.json`, so `planDependencyVolumes`
   (`src/v2/dependency-provisioning.ts`) resolves the SAME lockfile hash and the SAME already-populated
   volume that `spawn.ts` mounts today. Confirm this holds for the clone path; the `cp -R node_modules`
   half of the proven disposable-clone workaround should be redundant. Relates FG-376.
7. **Private-clone lifecycle and recovery.** FG-621 owns cleanup for the substrate it introduces.
   Extend the existing `reconcileRun` orphan-reaper path rather than creating a second reaper. A private
   clone may be removed only after Forge proves that it owns the workspace, that no uncaptured tracked,
   untracked, or ignored output remains, and that every relevant clone commit is reachable from
   Forge-owned state. Anything not proven safe is retained with durable evidence naming the path and
   reason. FG-356's linked-worktree cleanup remains unchanged; its shipped
   `private_clone_substrate` classification is the fail-safe handoff to this implementation.

## Out of scope

- **The post-merge integration gate** (build + test the MERGED result). FG-345 hard constraint 1:
  worktrees and clones catch same-file TEXTUAL races only — a cross-file semantic break merges CLEAN
  with zero conflict. Isolation is necessary but NOT sufficient. Separate story.
- **Publication-contention serialization** across concurrent candidates (per project + target branch).
  Stays an FG-345 default-on blocker owned by the integration publisher.
- **Periodic WIP checkpointing.** A later resilience improvement, explicitly not a blocker for
  restoring private commit authority.
- **Flipping worktree/isolation default-on.** FG-356 is closed and proven. The flip remains blocked on
  this ticket plus FG-345's post-merge gate, publication serialization, remaining contracts, and
  dogfood evidence.

## Acceptance criteria

1. Two mutating agents commit concurrently in independent private repositories, and both sets of
   commits are retrievable by the host.
2. **Negative test, not a comment:** a container write to the PARENT repo's refs, index, object store,
   or target branch is refused. Cover ref creation, `main` / `origin/*` / packed-ref updates, and
   object-store deletion.
3. Uncommitted **tracked and untracked** output present at agent exit is captured by the Forge safety
   commit and appears in the candidate.
4. A sequential task's workspace is created from the exact accepted predecessor candidate SHA; a
   fan-out wave's siblings are created from the same recorded base SHA. Asserted on recorded state, not
   inferred.
5. Merge-back retrieves the agent's own commits via fetch from the private clone, with the host-side
   safety-net commit still covering the fully-uncommitted case.
6. Through the gate path that exists when this ticket starts, the tree Forge publishes is
   byte-for-byte the tree that passed those gates. This criterion requires candidate identity and
   receipt continuity; it does **not** pull FG-345's new post-merge integration gate into this ticket.
7. **Regression:** a non-mutating/red agent still reads the history it needs (`git log` / `diff` /
   `show`) and still cannot commit or update a ref — FG-559's substrate is unchanged for that class.
8. Dependency provisioning resolves the same lockfile hash and reuses the same populated volume for a
   clone as for the current worktree path.
9. An orphaned private clone is removed only when an ownership proof based on its resolved alternates
   target matches the parent object store, its status including ignored files is clean, and its HEAD,
   checked-out branch tip, and other task-relevant commits are reachable from Forge-owned state.
10. A private clone that fails any ownership, capture, cleanliness, or reachability proof is retained.
    `forge show` exposes a durable retention event with a human-readable reason and the retained path.
    A stale or misassigned workspace path cannot cause the live source checkout, an ordinary clone, or
    another task's private clone to be removed.
11. Dogfooded forge-on-forge on a real run before this ticket closes.
12. `forge-test` green; required CI checks (`test` and `test-extended`) green.

## Refs

FG-345 (parent decision + authority contract), FG-559 (read-only parent `.git` mount, and the
experiment that produced every measurement above), FG-351 (Task workspace state in DB), FG-352
(retain-on-conflict), FG-356 (shipped linked-worktree cleanup and fail-safe private-clone retention
classification), FG-376 (dependency parity), FG-340 (agents do not publish), `docs/invariants.md` #9.

## Prior art from an FG-356 review round (2026-07-26) — do not re-derive this

During FG-356's review-loop, a fixer was handed a contradictory acceptance line (since corrected) and
implemented clone reaping inside FG-356. That work was DISCARDED as outside FG-356's scope and
unvalidated — it died before any test ran, and it broke the retain-reason enum FG-356's tests and docs
depend on. Two ideas in it are worth keeping for this ticket:

1. **The alternates file is a proof of ownership a main checkout cannot forge.** Classification alone
   cannot distinguish a private clone from the operator's live source — both have a `.git` DIRECTORY.
   But a `--shared` clone's `objects/info/alternates` resolves to the PARENT's `objects` dir, and no
   repo is ever its own alternate. So: resolve `git rev-parse --git-common-dir` for both the workspace
   and `projectDir`, require they differ, then require the workspace's alternates to realpath-match the
   parent's objects dir. Everything else about a clone — layout, branch name, remote — is imitable by
   the live source; this is not. That check, not the substrate classification, is what structurally
   keeps the FG-607 live-source incident out of reach on the clone path.

2. **`gc.pid` in the common git dir is the "parent is repacking" signal.** Git writes it for the
   duration of a gc and checks it to refuse a concurrent one. A `--shared` clone's alternates point
   into the very object store being rewritten, so disposal should wait for the next pass rather than
   race it.

Also worth carrying: a clone is a FULL repo, so its branch can hold commits its `HEAD` is not sitting
on. A capture check that reads only `HEAD` (plus the parent-side branch ref) misses them — resolve the
workspace's own branch tip as a third input and de-duplicate before testing reachability.

Note the substrate asymmetry this implies for merge-back: a clone is not registered with the parent, so
`git worktree remove` has nothing to act on — the directory IS the repo and its private refs go with
it, while the parent often never held the branch at all.
