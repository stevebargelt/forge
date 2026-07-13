---
id: FG-425
type: story
status: done
title: "Serialized integration publisher: validate a candidate in an isolated worktree, publish the exact tested commit via a short CAS window"
created: 2026-07-01
closed: 2026-07-13
closed_commit: 4762b1f
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
