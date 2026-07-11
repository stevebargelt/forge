---
id: FG-410
type: story
status: done
title: updateCampaignItem read-merge-write is lost-update-unsafe under parallel execution (FG-396 prerequisite)
created: 2026-06-25
closed: 2026-07-11
closed_commit: 75be30b
---

## Problem

src/store/campaigns.ts updateCampaignItem does read-then-merge-then-write: getCampaignItem(id) → { ...existing, ...update } → full-row UPDATE. Two concurrent callers each read before either writes, so the second write silently clobbers the first's fields. Surfaced by the FG-392 red-backend review (low severity, residual risk).

## Why deferred, not fixed in FG-392

NOT reachable in the FG-392 sequential MVP — the executor processes items strictly one at a time, so there is no concurrent updateCampaignItem. It becomes a real lost-update hazard only when parallel campaign lanes (FG-396) run items concurrently.

## Acceptance Criteria

- Replace read-merge-write with a targeted UPDATE that sets only the columns present in the update object (no full-row read-then-write), OR add row-level guarding.
- Must land BEFORE / as part of FG-396 parallel execution — parallel lanes must not silently lose item-state writes.
- Test: two concurrent updates to disjoint fields of the same item both persist.

## Notes
Filed from FG-392 red-backend finding #5 (disposition: residual_risk). Relates to FG-396.

## Close evidence (2026-07-10, PR #99, merge 75be30b)

All three writers (updateCampaignItem + the FG-428 paused / FG-441 running CAS variants) now build the SET clause from own-property key presence via buildItemUpdateSet (src/store/campaigns.ts:236-278); the pre-read merge is gone; CAS WHERE clauses unchanged. Explicit `undefined` still clears to NULL (executor reset paths depend on it); absent keys leave columns untouched.

**Host stress-loop (house rule):** harness = two OS processes, each with its own better-sqlite3 connection on a temp FORGE_HOME DB, racing N disjoint-field updates (`branch` vs `pr_url`) on one campaign item with a synchronized start.
- Command: `npx tsx <scratchpad>/fg410-stress.mts 500` (coordinator spawns 2 workers; asserts both writers' final values persisted)
- OLD code (stashed pre-fix campaigns.ts): lost update on the first 500-iteration run — `pr_url` ended at `pr-val-437`, expected `pr-val-500` → harness provably detects the bug.
- NEW code: 5 consecutive runs × 500 iterations (2,500 racing writer-pairs) — zero lost updates, both fields at their writer's final value every run.

**Tests:** 13 unit store tests (statement-shape proof that the emitted UPDATE names only passed columns — fails under old code; clear-via-undefined; CAS guards; empty-update semantics) + 7 mutation-verified integration tests (executor reset flows via resumeCampaign; interleaved two-connection lanes in the FG-396 shape; reconcile-shape CAS refusal with whole-row no-mutation assertion). Each integration test proven to fail against three deliberately broken implementations including the original full-row clobber.

**Gates:** review-loop passed + closeable (run-review-loop-fg-410-cc868c; reviewed tip = remote head); CI green at head e65e8a4 (`test` + `test-extended`), evidence reused by the loop. Docs impact: none (internal store mechanics; engineer and test-engineer docs_impact_check concur).

Follow-up filed (new scope, not this ticket's AC): FG-520 — forge-test stale/broken /tmp/forge-work scratch reuse, surfaced twice during this work.
