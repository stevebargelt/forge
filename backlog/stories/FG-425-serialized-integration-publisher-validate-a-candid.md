---
id: FG-425
type: story
status: active
title: "Serialized integration publisher: validate a candidate in an isolated worktree, publish the exact tested commit via a short CAS window"
created: 2026-07-01
---

## Problem

FG-357's integration gate runs the project's full test suite on the HOST against the shared `run.projectDir` checkout, **after** the worktree merge has already landed on HEAD. Because validation happens against the publish target itself, the target sits in a merged-but-unvalidated state for the full duration of a test-suite run (~10 minutes), and forge's run locking is per-`runId`, not per-`projectDir`. Concurrent runs on the same project can interleave merges/gates against a moving HEAD.

## Goal

A run must never publish to a project's target ref a commit that was not validated exactly as published, and two runs on the same `projectDir` must not interleave merge/publish against a moving target.

## Approach — serialized integration publisher (supersedes the long-lock design, 2026-07-13)

Test first in isolation; publish the exact tested commit afterward through a tiny serialized / compare-and-swap window.

1. Capture target/base SHA `B`.
2. Build candidate `C` in a **dedicated integration worktree**.
3. Merge/rebase all task branches there.
4. Run validation, integration tests, reds, and review against **exact candidate `C`**.
5. Acquire a **short project publication lock**.
6. Confirm the target is still `B`.
7. Fast-forward / publish target to `C`.
8. If the target changed, release, rebuild on the new base, rerun gates (bounded — see AD-1).
9. Record `{ baseSha, candidateSha, publishedSha, target }` durably.
10. Finalize and clean up idempotently.

Target-kind specifics:
- **Local checked-out target:** the short lock protects ONLY the final fast-forward and the working-tree checkout update.
- **Remote target:** explicit expected-SHA lease or equivalent compare-and-swap push. Before any push, prove `candidateSha` descends from `baseSha`; the lease is only the atomic stale-base guard and is never authorization for a non-fast-forward rewrite. A naked `push --force-with-lease=<ref>:<B>` without that ancestry proof is insufficient.

## Architecture decisions (operator-recorded 2026-07-13 — binding on implementation)

**AD-1 — Bounded publication attempts.** A publication attempt is bounded to **two full validations**: the initial attempt plus ONE rebuild after a moved base. A second moved-base result **parks** with a named `publish_base_churn` reason and **preserves evidence**. No candidate batching in FG-425 v1.

> Interaction with AD-2, recorded so the bound is not later "tuned" for the wrong reason: with a FIFO integration lane, Forge-owned attempts cannot move each other's base. `publish_base_churn` therefore fires essentially only on an EXTERNAL writer (an operator pushing to the target mid-run). Repeated churn parks are a signal about external write traffic, NOT about forge-internal contention — do not respond by raising the bound.

**AD-2 — One FIFO integration lane per canonical project identity** for Forge-owned publication attempts. Worker execution stays **parallel**; candidate integration, final validation, and publication are **ordered**. CAS is still required — it protects against external writers and stale state, and is not made redundant by the lane.

The architecture pass must make "FIFO" mechanically testable rather than treating ordinary lock acquisition as ordered: define a durable enqueue-order key assigned when the publication request is recorded, preserve that order across Forge processes, expose the queued/holding attempt to the operator, and ensure an abandoned or terminal attempt can be skipped/recovered without permanently wedging the lane.

**AD-3 — A dirty local publish target is a named `dirty_publish_target` blocker.** Refuse **before** any mutation. **Never** automatically stash, reset, clean, checkout-over, or otherwise modify operator-owned dirty state.

**AD-4 — Fresh, uniquely identified integration worktree per publication attempt.** Do **not** pool it; do **not** reuse an earlier attempt's worktree after a crash or a moved-base retry. FG-356 owns eventual orphan cleanup; **cleanup is not a correctness prerequisite for publication.**

**AD-5 — Crash between ref-advance and checkout-update must have a defined recovery.** The architecture must explicitly define recovery for a crash occurring after the local target ref has advanced but before its checked-out working tree is updated. Durably record **publication intent BEFORE mutation**; recover from `baseSha`, `candidateSha`, and `currentTargetSha`. **Do not infer publication state from working-tree contents.**

**AD-6 — Validation evidence binds to the immutable `candidateSha`.** Publication must use that **recorded SHA** — never a mutable candidate branch tip, never current worktree state.

**AD-7 — No automatic gate-process reaping in FG-425.** A crashed attempt is **abandoned**; any retry uses a **new** worktree.

## Why this deletes the process-supervision machinery

The load-bearing point, recorded so it is not re-derived: gate process supervision was only ever necessary **because the gate ran against the publish target**. An orphaned gate process group mattered only because it could still be mutating the thing about to be published.

Once validation runs in a throwaway integration worktree, a forge crash that orphans a gate process group is a **resource leak, not a correctness hazard** — the orphan churns inside a worktree whose candidate cannot reach the target without a fresh CAS check at publish time, and (AD-6) publication uses the recorded immutable SHA regardless of what that worktree now contains. A stale candidate simply loses the CAS and is abandoned (AD-7).

Therefore this design removes the need for ALL of:
- long-held integration locks
- gate PGID sidecars
- PID-reuse detection
- zombie-leader classification
- automatic orphan reaping before merge
- process identity nonces

Orphaned gate process groups become a **cleanup/GC concern** (FG-356), never a correctness gate. **Do not reintroduce pre-merge reaping as a safety mechanism.**

## Salvage from the abandoned branch

Branch `fix/fg425-project-gate-locking` (`ce22024`, pushed, DELIBERATELY UNMERGED — do not delete, do not merge) contains reusable work:
- **Canonical project identity** — `projectIntegrationLockKey`: realpath-canonicalized `projectDir` → stable lock path (symlink / trailing-slash / relative spellings collapse to one identity). This is the key AD-2's FIFO lane and the publication lock are both keyed on.
- **Contention visibility** — the operator-visible waiting line (`describeWait`): names the holding run, project, elapsed wait, and next action. Reusable for the lane queue and the short publication window.
- **Cross-process publication tests** — the multi-process harness in `project-integration-lock.integration.test.ts` / `fg425-project-gate-lock.worktree.test.ts` exercises real cross-process contention; retarget it at CAS publish rather than long-lock exclusion.

DISCARD: the long-gate locking and the entire process-supervision layer (`GateGroupRecord` sidecars, `leaderCommandOf` / `LeaderProbe`, `terminateProcessGroup`, `reapResidualGateGroup`, the leader nonce in `integration-gate.ts`).

## Remaining design question for the architecture pass

- Integration-worktree lifecycle mechanics under AD-4: naming/identity scheme for the per-attempt worktree, and how its creation/teardown interacts with FG-345 (git worktrees for ALL agents) and FG-356 (orphan worktree cleanup). AD-4 settles the policy (fresh per attempt, never pooled, cleanup non-blocking); the mechanics are open.

## Acceptance Criteria

- Validation (tests / integration gate / reds / review) runs against a candidate commit `C` built in a dedicated integration worktree — never against the publish target.
- The commit published to the target is byte-identical to the commit that was validated (`publishedSha === candidateSha`), resolved from the recorded immutable SHA and not from a branch tip or worktree state (AD-6).
- Publication is compare-and-swap against the captured base: if the target moved off `B`, the publish is refused and the candidate is rebuilt on the new base with gates rerun — bounded to ONE such rebuild, after which the run parks with `publish_base_churn` and preserves evidence (AD-1).
- Forge-owned publication attempts for one canonical project identity are FIFO-ordered across candidate integration, final validation, and publication; worker execution remains parallel (AD-2).
- FIFO order derives from a durable publication-request enqueue key and is honored across Forge processes; queued/holding state is operator-visible, and an abandoned or terminal lane entry cannot permanently wedge later attempts.
- The publication lock is held only across the compare-and-swap + fast-forward (+ working-tree checkout update for a local target) — NOT across validation.
- A dirty local publish target is refused with a named `dirty_publish_target` blocker BEFORE any mutation; no automatic stash/reset/clean of operator-owned state (AD-3).
- Every publication attempt uses a fresh, uniquely identified integration worktree; no pooling, no reuse after crash or moved-base retry (AD-4).
- Publication intent is durably recorded BEFORE target mutation; a crash between advancing the local target ref and updating its checked-out worktree is recoverable from `{ baseSha, candidateSha, currentTargetSha }` without inspecting working-tree contents (AD-5).
- Remote targets publish via an explicit expected-SHA lease / CAS push only after proving `candidateSha` descends from `baseSha`; a lease must never permit a non-fast-forward target rewrite.
- `{ baseSha, candidateSha, publishedSha, target }` is durably recorded per publication attempt and visible to the operator.
- Finalize/cleanup is idempotent (safe to re-run after a crash at any step); worktree cleanup is never a precondition for a correct publication.
- No regression to independent runs targeting DIFFERENT `projectDir`s — they proceed fully in parallel.
- A test demonstrates two runs on the same `projectDir` cannot interleave publication, and that a run whose base moved rebuilds once rather than publishing an unvalidated merge.
- No gate process-group supervision (sidecar / nonce / reap) is required for correctness (AD-7).
- A `learnings/decisions/` ADR lands with the implementation, documenting the serialized integration publisher and explicitly superseding the abandoned long-lock/process-supervision design.

## Relations

- Follow-up to FG-357 (post-merge integration gate).
- Supersedes the process-supervision design carried on `fix/fg425-project-gate-locking`.
- Merging FG-425 is the prerequisite that clears the FG-396 (parallel campaign lanes) integration-lock blocker. NOTE: AD-2's FIFO lane orders *publication*, not execution — FG-396's parallel lanes stay parallel through worker execution and serialize only at integration/publish. FG-410 already closed.
- FG-356 owns orphan worktree cleanup (AD-4 depends on it existing eventually, but not for correctness). FG-345 owns the broader worktree model.
- FG-548 (store deferred-write-txn SQLITE_BUSY under multi-process WAL) was surfaced by this ticket's cross-process harness; it is independent of this redesign and now lives on main.

---

## REOPENED 2026-07-13 — targeted corrective changes (request-changes on the landed implementation)

The binding architecture is CORRECT and is NOT up for redesign. The landed implementation has two blocking correctness defects, one AD-3 preflight defect, and documentation that contradicts the implementation.

**Settled — do not re-litigate, do not "harden":** the lane provides ORDERING and spans candidate integration + full validation + publication; the short mutex + CAS + ancestry proof + immutable `candidateSha` binding provide CORRECTNESS; validation stays inside the exclusive lane turn and outside the short mutex window; the lane is a renewable durable lease — NO PID probing, signalling, nonces, zombie classification, or reaping; remote publication requires BOTH ancestry proof AND an explicit expected-SHA lease; publication worktrees stay fresh/create-only/per-attempt (never routed through prune-then-create lifecycle helpers); publisher state stays under FORGE_HOME, never projectDir; the four publication call sites and candidate-mounted reds are preserved.

### AC1 (BLOCKER) — no target mutation after mutex ownership is lost
`src/v2/publication-target.ts` `syncCheckout`'s catch block performs an unguarded `update-ref <ref> <baseSha> <candidateSha>` even when the failure was mutex-renewal discovering another publisher owns the mutex. Race: A advances ref B→C; A's mutex expires; B acquires it and AD-5-recovers index/worktree to C; A resumes, renewal fails, A's catch rolls the ref back to B without ownership → ref=B while index/worktree=C (target dirty and divergent).

Invariant (absolute): once a publisher discovers it no longer owns the mutex it executes NO target-mutating command — not `update-ref`, `read-tree`, `checkout`, `reset`, or cleanup. A checkout failure may be rolled back ONLY while ownership has been successfully renewed/pre-extended for that rollback operation. If ownership cannot be confirmed: do not roll back, do not touch the target — preserve the durable publishing intent so the current/new mutex owner converges it through AD-5 recovery from the recorded `baseSha`, `candidateSha`, and target ref.

Regression test must use an ACTIVE thief (not a thief that takes the mutex and does nothing): A advances the ref → B takes the expired mutex → B runs recovery and synchronizes the tree → A resumes and observes lost ownership. Assert: A performs no later target mutation; final ref, index, and worktree all converge on C; the durable attempt record truthfully reflects the result. Keep the existing simpler lost-mutex test — it is not sufficient alone.

### AC2 (BLOCKER) — recovery is idempotent w.r.t. terminal attempt records
`src/v2/integration-publisher.ts` `recoverPublicationAttempt` re-derives and rewrites attempts regardless of stored state. Race: A publishes; B publishes on top of A; recovering A finds the ref is neither A's base nor A's candidate and rewrites A from `published` to parked/`publish_base_churn`, claiming nothing from A was published — corrupting durable publication history.

Only an UNFINISHED attempt in the `publishing` state may undergo ref-derived AD-5 convergence. Terminal records are IMMUTABLE. Recovering a published attempt returns its recorded published result without changing the record. Recovering parked / failed / refused-equivalent / abandoned attempts returns their stable recorded disposition or reports not-recoverable — without mutating them.

Regression test: publish A, publish B, recover A → A remains semantically byte-for-byte unchanged as published (including `publishedSha` and terminal state). Add coverage for EVERY other terminal state proving recovery performs no state transition.

### AC3 (MEDIUM) — AD-3 untracked-collision detection must be prefix-aware
`src/v2/publication-target.ts` `untrackedCollisions` uses exact path equality and misses git file/directory collisions: candidate adds tracked `foo` while target holds untracked `foo/bar`; candidate adds tracked `foo/bar` while target holds untracked file `foo`. Both must be detected BEFORE any target mutation and classified `dirty_publish_target`. Use git path semantics including ancestor/descendant conflicts. Never delete, stash, move, or overwrite operator-owned files.

Tests for BOTH directions, each asserting: `dirty_publish_target` returned; target ref never changes; index and tracked worktree unchanged; the operator's untracked content byte-for-byte unchanged; no fallback `publication_refused`/`CheckoutSyncError`.

### AC4 — correct the binding ADR and operator docs in the SAME change
`learnings/decisions/serialized-integration-publisher.md` "The shape" puts enqueueing AFTER candidate construction and validation, contradicting AD-2 and the implementation. Record the correct order: record/enqueue the attempt on the project lane → once it owns the active lane turn, capture the base, create the fresh candidate worktree, integrate, run the COMPLETE validation set → still within that lane turn, enter the short publication mutex window for final target checks, CAS/ancestry protection, ref update/push, and local checked-out-tree sync → a moved-base rebuild and its full revalidation remain within the SAME lane turn → release the mutex after the publication window; release/complete the lane after the attempt's publication disposition is durable.

State the layering in substance: the lane provides ordering; the mutex + CAS + ancestry proof + `candidateSha` binding provide correctness; the lane may be approximate because an erroneous skip costs fairness, never publication correctness. Do NOT describe the ref update as the only serialized operation — distinguish lane serialization from the short mutex window. Correct the checkout-failure discussion that says rollback is safe because "we hold the mutex": rollback is permitted only when ownership is CURRENTLY PROVEN; a process that lost ownership performs no mutation.

`docs/concepts.md` must describe the same ordering and mutex scope, and its claim that `dirty_publish_target`, `publish_base_churn`, `publication_refused`, and `lane_taken_over` fall through to `campaign_system` must be corrected — the implementation maps the first three to `git_state` and `lane_taken_over` to `scope`.

### Validation
- Each regression test must FAIL against merged FG-425 commit `4762b1f` before the fix and PASS after (falsification-first — a test that cannot go red proves nothing).
- Run all focused FG-425 publication / recovery / FIFO / CAS / target / failure-policy tests, plus typecheck, the normal suite, and `test:extended`. Report exact `tests_run` evidence.
- Confirm the four call sites and every settled decision above are unchanged.
- NOT complete while any documentation still contradicts the implemented ordering or the ownership invariants.

### AC5 (BLOCKER — folded in 2026-07-13, was wrongly classified a follow-up) — one truthful final disposition after a lost mutex

**No unreachability defense.** `MutexLostMidPublishError` is REACHABLE in production: any deschedule longer than the mutex lease TTL (laptop suspend, SIGSTOP, container pause, swap thrash, a long IO/GC stall) opens the window between operations. Do NOT attempt to close this by arguing it cannot happen.

**The contradiction (must be eliminated, not documented):** today `publishLocal` throws `MutexLostMidPublishError`; `abandonedMidWindow` returns a TERMINAL `refused` while the attempt row remains `publishing`; `runNext` maps that to `publication_refused` and marks the task FAILED. A later AD-5 recovery converges the attempt to `published` — but `recoverUnfinishedPublications` does not reconcile the already-failed task/run/campaign. Result: two durable records that contradict each other, with the failed one advising a RETRY of work that already landed.

**Invariant: a terminal refusal may never be returned over an attempt that remains `publishing`.** A lost mutex after the ref advance must resolve to exactly ONE truthful final disposition.

Acceptable shapes (pick one and justify it): a distinct non-terminal `recovery_pending` outcome/state, or an in-run wait/reconciliation path that converges and then reports the TRUE disposition. NOT acceptable: returning a terminal refusal while preserving a `publishing` attempt.

**Production-boundary regression must prove, through the real path (publishIntegration → runNext → the durable task/run rows), that a lost mutex AFTER the ref advance yields:**
- NO premature `publication_refused` / task failure while the attempt is still `publishing`;
- recovery converges ref, index, AND worktree;
- the publication attempt becomes `published`;
- the owning task/run/campaign reaches the matching truthful state, OR remains in an explicit RECOVERABLE non-terminal state until that reconciliation occurs;
- NO operator surface says "nothing was published" or "the target is unchanged" when the ref carries the candidate;
- NO retry can duplicate already-published work.

FG-425 does NOT merge while this task-versus-publication contradiction stands.
