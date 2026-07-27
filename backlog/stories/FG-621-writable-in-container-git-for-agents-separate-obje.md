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

---

## Operator decisions recorded at the architect gate (2026-07-26) — BINDING on the plan

The architect phase of `run-fg-621-private-writable-git-for-mutating-agents-0d5074` verified two
claims against HEAD that CONTRADICT this ticket's earlier text. Both are confirmed; the ticket text
below supersedes the older wording.

### Correction 1 — scope item 4's re-plumbing target is DEAD CODE

`mergeWorktreeBranch` (`src/v2/worktree-lifecycle.ts:306`, the `git merge --ff-only` at `:352`) has
**zero production callers** — FG-425 routed every merge through `publishIntegration`. Worse,
`src/v2/fg425-publisher-scope.test.ts:184-188` actively ASSERTS that `runNext.ts` matches neither
`mergeWorktreeBranch(` nor `mergeIntegrationBranchToHead(`. Editing that function is a no-op change,
and wiring it back into `runNext.ts` BREAKS `test-extended`.

The live seams that resolve a task branch in the parent's ref namespace are
`mergeSourceIntoCandidate` (`src/v2/integration-publisher.ts:329`), `mergeChildIntoIntegration`
(`src/v2/worktree-lifecycle.ts:865`, called at `runNext.ts:1923`), `createIntegrationWorktree`
(`worktree-lifecycle.ts:795`) and `integrationBranchExists` (`:759`).

**Do not edit `mergeWorktreeBranch` as the merge-back re-plumbing.** The boundary decision below is
what replaces it, and it requires zero edits to either live seam.

### Correction 2 — scope-fence wording

FG-357 (post-merge integration gate) and FG-425 (serialized integration publisher) are **SHIPPED
SYSTEMS**, not unfinished FG-345 work and not future work. FG-621 **integrates with them**. Do not
redesign or modify either. Where earlier text lists them under "out of scope", read that as *"not
modified by this ticket — integrate with their existing interfaces"*:
`src/v2/publication-target.ts`, `src/v2/integration-publisher.ts`, the `publication_attempts` /
`publication_lane` tables in `src/store/schema.ts`, and `src/store/publications.ts`.

### NON-NEGOTIABLE — the capture ordering (resolves the red-wide high finding)

red-wide found the fetch boundary internally inconsistent: the publisher's `autoCommitSource`
(`src/v2/integration-publisher.ts:323`) can commit into a source AFTER its branch has been fetched
and then merge the now-stale parent ref. For a linked worktree that ordering is harmless (the
worktree and the branch share one ref namespace); for a private clone they are DIFFERENT
REPOSITORIES, so a post-fetch clone-side commit advances only the clone's ref and is silently
absent from the candidate. `mergeChildIntoIntegration` (`worktree-lifecycle.ts:833-855`) has the
identical shape on the fan-out path.

The capture ordering is a CONTRACT, not an implementation detail. It must be exactly:

1. Safety-commit remaining clone state (tracked AND untracked).
2. Resolve the resulting clone branch tip.
3. Fetch that branch into the parent's ref namespace, under the deterministic
   `forge/<runId>/<taskId>` name (`worktreeBranchName`, `worktree-lifecycle.ts:28`).
4. **Verify the fetched ref EQUALS the resolved clone tip.**
5. Hand that captured ref/commit to the existing publisher.
6. Perform **no later clone-side auto-commit** that could make the fetched ref stale.

**The tech lead must explicitly define what `worktreePath` means at the publisher boundary for a
clone source.** "The publisher is unchanged" cannot coexist with `autoCommitSource()` mutating the
clone after the fetch. State the resolution; do not leave it implicit. AC 3 is the test for this.

### AC 2 / AC 11 evidence lane — DECIDED

**Do NOT add a third required CI check.** The repo has no test tier that can run a real Docker
container (agent containers have no daemon; no CI job builds or runs the image), and a
skip-capable CI test is not acceptable as the live proof of a security boundary.

**Standing automated coverage** — unit/integration assertions on the exact Docker argv:

- only `<parent>/.git/objects` is identity-mounted (host path === container path);
- that mount is `:ro`;
- NO parent refs, index, HEAD, packed-refs, or broader `.git` mount is present;
- a tampered or mismatched `objects/info/alternates` **fails closed**.

**One-time operator-run evidence**, executed host-side on macOS against the candidate
implementation and image, with the run id / output pasted into this ticket (the FG-559 precedent,
which recorded `run-fg-559-live-worktree-smoke-42c126`):

- AC 2 — the real-container negative test (parent ref creation, `main` / `origin/*` / packed-ref
  updates, object-store deletion all refused);
- AC 11 — the dogfood run proving a mutating task actually RECEIVED the private-clone substrate,
  actually COMMITTED in it, and could NOT mutate the parent.

Preserve the exact host command as a small reproducible smoke script that **exits nonzero when
Docker or the candidate image is unavailable** — never skips to green.

### Other decisions

- **Existing clone directory on re-dispatch/retry → REFUSE and surface.** Never silently reuse a
  workspace an agent has already written to (`createCandidateWorktree`'s create-only posture at
  `integration-publisher.ts:266-271` is the precedent).
- **The fan-out INTEGRATION worktree is fenced OUT.** AC 4 governs fan-out SIBLINGS. Whether
  `createIntegrationWorktree` should also take a recorded base SHA is FG-353/FG-425 territory, not
  this ticket's.
- **Linux hard-fail is INHERITED** (`preflightWorktreeGate`, `worktree-lifecycle.ts:63`). AC 2 and
  AC 11 evidence is therefore macOS-only, and that is accepted FOR THIS TICKET.
  **Qualification:** this means FG-621 alone cannot justify a universal default-on flip. At FG-345
  closeout the choice is either a macOS-first default or lifting the Linux gate — each with its own
  test burden. **Do not smuggle Linux support into FG-621.**
- **Reachability authority.** `isAncestorOfHead` (`worktree-lifecycle.ts:605`) asks reachability
  from `projectDir` HEAD, but the publish target may be `remote:<remote>#<branch>`, which never
  advances `projectDir` HEAD — every clone would then fail the capture proof and be retained
  forever. AC 9's "Forge-owned state" is the recorded publication receipt
  (`publication_attempts.published_sha`). If the HEAD proxy is kept, the remote-target case must be
  an explicit, NAMED retain rather than a silent forever-retain.
- **`WorkspaceRetainReason` changes must be ADDITIVE and land with their docs in the same step** —
  the enum is a published contract surface (`docs/SCHEMA-CONTRACT.md:114`, `docs/concepts.md:327-334`,
  `docs/invariants.md:32`) proven complete by `fg356-reaper-evidence.integration.test.ts:389`. The
  discarded FG-356 clone-reaping code died on exactly this.

### AC 6 evidence requirement — gate amendment recorded at the plan gate (2026-07-27)

The plan phase decomposed FG-621 into four steps with correct disjoint file boundaries, but AC 6 is
referenced in none of them. AC 6 is structurally addressed — omitting `worktreePath` for a clone
source removes the only new candidate-identity hazard FG-621 introduces, and FG-425 already owns and
tests the rest — but "structurally addressed" is not cited evidence, and this ticket does not close
on an acceptance criterion that has none.

This is a gate AMENDMENT, not a re-plan: the omission is precise, bounded, and alters neither the
decomposition nor the architecture. Add to step 1's test coverage:

> For a clone source, assert `CandidateSource.worktreePath` is absent; the gate observes candidate
> C; the publication receipt records `candidateSha === publishedSha`; and the published target's Git
> tree equals `C^{tree}`.

**The test must CAPTURE the SHA and tree actually observed by the gate**, and compare against that
captured value. Do NOT infer the property after the fact from `candidateSha === publishedSha` alone
— that comparison is self-consistent even if the gate observed a different tree, which is precisely
the failure mode AC 6 exists to exclude.

### Operator evidence lane (AC 2 / AC 11) — how to actually run it

The live proof is a one-time operator-run script, host-side on macOS, against the FINAL stable
candidate SHA and image:

```
./scripts/fg621-clone-boundary-smoke.sh [--project-dir DIR] [--image IMAGE]
```

`--project-dir` is the PARENT repo to prove unwritable (defaults to the repo it runs in);
`--image` is the candidate agent image (defaults to `$FORGE_AGENT_IMAGE` /
`agent-dev-worker:latest`). It fails closed — a missing Docker daemon, a missing image, or any
missing prerequisite exits NONZERO, never a skip-to-green. It requires this repo's `node_modules`,
because it builds its fixture through forge's OWN `createTaskClone` rather than hand-rolling a
clone: that is deliberate, so the script proves the PRODUCT supplies what an agent needs instead of
supplying it on the product's behalf (it previously injected `GIT_AUTHOR_*` and `safe.directory`,
which would have reported SUCCESS while real dispatch failed).

It prints a copy-pasteable evidence block; paste that into this ticket's Acceptance Evidence grid
for AC 2 and AC 11, citing the candidate SHA and image it ran against. **Re-run it if relevant code
changes afterward** — acceptance evidence against a superseded SHA is worse than none, because it
reads as proof.

### Documentation gaps the docs phase MUST close (raised by the verify phase, 2026-07-27)

Both are real, both are operator-facing, and neither was written by the implementers that flagged
`operator_behavior_changed`:

1. **The new hard dispatch refusal is undocumented.** A project dir that IS a shared clone with an
   unverifiable `objects/info/alternates` now REFUSES to dispatch instead of silently dispatching a
   history-blind container. Nothing in `docs/` mentions this refusal, the alternates verification,
   or `CANONICAL_PROJECT_DIR`. An operator who hits it has no documentation to land on.
2. **The evidence lane is undiscoverable.** `scripts/fg621-clone-boundary-smoke.sh` is named in no
   markdown in the repo — not `docs/`, not `README`. An evidence lane an operator cannot discover
   is one AC 11 will not get run through.
