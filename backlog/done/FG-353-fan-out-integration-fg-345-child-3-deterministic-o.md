---
id: FG-353
type: story
status: done
title: "Fan-out integration (FG-345 child 3): deterministic ordered child merges into an integration branch BEFORE parent reds"
created: 2026-06-22
closed: 2026-06-24
---

**Parent:** FG-345. **Depends on:** FG-352 (merge primitive). **This story carries the red-timing correction — write it precisely.**

Fan-out (dispatchFanoutStep, runNext.ts:705/836-889) runs up to 4 concurrent rw children, each in its own worktree. The single-primary "red-before-merge" model is WRONG here: reds reviewing isolated child snapshots MISS merge/integration defects (semantic cross-file breakage between children).

## The required flow (DECIDED)
1. All children dispatch concurrently in their own worktrees (existing Promise.all batch).
2. After `childOutcomes` are collected (~line 836, before the reds block ~line 865), **merge children sequentially in deterministic index order** into a dedicated **integration branch** (NOT directly into HEAD). Ordered merges → reproducible conflict surfaces across retries.
3. **Fan-out reds mount the INTEGRATION branch result read-only** — they review the integrated output, not any single child. This is the correction to the architect's single-primary framing (FG-355 covers the single-primary case).
4. Gate on the integrated result.
5. On gate-advance, merge the integration branch to HEAD.

## Scope
- **Fan-out merge strategy (DECIDED): deterministic ordered, likely `--no-ff`** (explicit merge commits, visible conflict surfaces). Not configurable (FG-345 decision #4).
- A child-merge conflict during integration → `merge_conflict` (reuse FG-352 failure kind), retain the integration branch + offending child worktree.
- Integration branch naming + cleanup consistent with FG-351 (e.g. `forge/<run>/<step>/integration`).

## Acceptance
- A 2+ child fan-out merges children in index order into an integration branch; fan-out reds mount that integrated result ro (verified: red's `/project` == integrated tree, not a single child).
- Induced cross-child conflict surfaces deterministically as `merge_conflict` with the integration branch retained.
- forge-test green incl. ordered-merge + integrated-red-mount tests.

Refs: runNext.ts:705/836-889/618-629, FG-352, FG-355.
