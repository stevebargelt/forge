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
8. If the target changed, release, rebuild on the new base, rerun gates (**bounded retry** — see open design questions).
9. Record `{ baseSha, candidateSha, publishedSha, target }` durably.
10. Finalize and clean up idempotently.

Target-kind specifics:
- **Local checked-out target:** the short lock protects ONLY the final fast-forward and the working-tree checkout update.
- **Remote target:** explicit expected-SHA lease or equivalent compare-and-swap push (e.g. `push --force-with-lease=<ref>:<B>`).

## Why this deletes the process-supervision machinery

The load-bearing point, recorded so it is not re-derived: gate process supervision was only ever necessary **because the gate ran against the publish target**. An orphaned gate process group mattered only because it could still be mutating the thing about to be published.

Once validation runs in a throwaway integration worktree, a forge crash that orphans a gate process group is a **resource leak, not a correctness hazard** — the orphan churns inside a worktree whose candidate cannot reach the target without a fresh CAS check at publish time. A stale candidate simply loses the CAS and is rebuilt.

Therefore this design removes the need for ALL of:
- long-held integration locks
- gate PGID sidecars
- PID-reuse detection
- zombie-leader classification
- automatic orphan reaping before merge
- process identity nonces

Orphaned gate process groups become a **cleanup/GC concern** (reclaim the worktree, reap the strays on a best-effort basis), never a correctness gate. Do not reintroduce pre-merge reaping as a safety mechanism.

## Salvage from the abandoned branch

Branch `fix/fg425-project-gate-locking` (`ce22024`, pushed, DELIBERATELY UNMERGED — do not delete, do not merge) contains reusable work:
- **Canonical project identity** — `projectIntegrationLockKey`: realpath-canonicalized `projectDir` → stable lock path (symlink / trailing-slash / relative spellings collapse to one identity). Directly reusable for the publication lock.
- **Contention visibility** — the operator-visible waiting line (`describeWait`): names the holding run, project, elapsed wait, and next action. Reusable for the short publication window.
- **Cross-process publication tests** — the multi-process harness in `project-integration-lock.integration.test.ts` / `fg425-project-gate-lock.worktree.test.ts` exercises real cross-process contention; retarget it at CAS publish rather than long-lock exclusion.

DISCARD: the long-gate locking and the entire process-supervision layer (`GateGroupRecord` sidecars, `leaderCommandOf` / `LeaderProbe`, `terminateProcessGroup`, `reapResidualGateGroup`, the leader nonce in `integration-gate.ts`).

## Open design questions (settle in the architecture pass, before implementation)

1. **Bounded retry on a moved base.** Step 8 is a retry loop; each rebuild re-runs a ~10-minute suite. Under steady merge traffic a run can starve. Decide the bound (N attempts → actionable failure) and whether candidate batching is ever warranted at forge's concurrency.
2. **Dirty target working tree.** The publication window is only "tiny" if the target checkout is clean. Decide whether publish refuses on a dirty target working tree or stashes — a dirty target otherwise converts the short window into a blocking operator question.
3. Whether the integration worktree is per-run-ephemeral or pooled/reused, and how it interacts with FG-345 (git worktrees for ALL agents) and FG-356 (orphan worktree cleanup).

## Acceptance Criteria

- Validation (tests / integration gate / reds / review) runs against a candidate commit `C` built in a dedicated integration worktree — never against the publish target.
- The commit published to the target is byte-identical to the commit that was validated (`publishedSha === candidateSha`).
- Publication is compare-and-swap against the captured base: if the target moved off `B`, the publish is refused, the candidate is rebuilt on the new base, and gates rerun (bounded).
- The publication lock is held only across the compare-and-swap + fast-forward (+ working-tree checkout update for a local target) — NOT across validation.
- Remote targets publish via an explicit expected-SHA lease / CAS push.
- `{ baseSha, candidateSha, publishedSha, target }` is durably recorded per publish attempt and visible to the operator.
- Finalize/cleanup is idempotent (safe to re-run after a crash at any step).
- No regression to independent runs targeting DIFFERENT `projectDir`s — they proceed fully in parallel.
- A test demonstrates two runs on the same `projectDir` cannot interleave publication, and that a run whose base moved rebuilds rather than publishing an unvalidated merge.
- No gate process-group supervision (sidecar / nonce / reap) is required for correctness.

## Relations

- Follow-up to FG-357 (post-merge integration gate).
- Supersedes the process-supervision design carried on `fix/fg425-project-gate-locking`.
- Merging FG-425 is the prerequisite that clears the FG-396 (parallel campaign lanes) integration-lock blocker. FG-410 already closed.
- Touches FG-345 / FG-356 (worktree lifecycle + orphan cleanup).
- FG-548 (store deferred-write-txn SQLITE_BUSY under multi-process WAL) was surfaced by this ticket's cross-process harness.
