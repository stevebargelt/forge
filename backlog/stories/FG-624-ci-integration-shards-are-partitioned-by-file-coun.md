---
id: FG-624
type: story
status: active
title: CI integration shards are partitioned by file count, not duration — shard 4 runs ~3x shard 1 and sits at its timeout budget
created: 2026-07-25
---

## Problem

`scripts/run-integration-tests.sh` shards with Node's `--test-shard=k/N` over a sorted file list. That
partition is by **file count**, not by duration — so shard load depends entirely on which slow files
happen to land where. The result is a badly imbalanced matrix in which one shard sits at its timeout
budget while the others idle.

Measured on run 30170202731 and main's run at `8c78e3b` (`.github/workflows/ci.yml` sets
`timeout-minutes: 6` on each integration shard):

| Shard | Duration on main | Duration on the FG-559 branch |
|---|---|---|
| integration_1 | 2m43s | 1m51s |
| integration_2 | 2m27s | 2m58s |
| integration_3 | 3m12s | 2m46s |
| **integration_4** | **5m25s (90% of budget)** | **6m06s / 6m10s — TIMED OUT, twice** |

## How it surfaced

FG-559 added one integration test file (`fg559-git-unavailable-classification.integration.test.ts`).
Because the file list is sorted and the partition is index-based, adding ONE file reshuffles the
partition and pushed shard 4 from 5m25s over the 6-minute job timeout. Its suite reported
`tests 670 / pass 670 / fail 0` and was then killed by the job timeout — so the check surfaces as
`cancelled`/`fail` with every test passing.

That failure mode is worth calling out on its own: **a timeout after a green suite looks like a test
failure in `gh pr checks` but has no failing test in the log.** Triage went down the wrong path once
already, reading the `cancelled` conclusion as matrix fail-fast rather than a budget overrun.

## The 6-minute budget stays

Raising `timeout-minutes` was considered and **rejected by the operator**: the gate exists precisely so
growth in suite time gets addressed rather than absorbed. Raising the ceiling would convert a signal
into silence and hand the same problem, larger, to whoever adds the next integration test.

So the budget is a fixed constraint of this ticket, not a variable. The shards must fit inside 6
minutes.

## Direction

Partition by measured duration rather than file index. Options worth weighing:

- Record per-file durations from a CI run and shard against that (a checked-in timing manifest, or a
  cheap heuristic keyed on known-slow files).
- Split the known-heavy files out into their own job. The release-build integration tests (FG-575) are
  the obvious suspects for shard 4's weight — confirm before assuming.
- Increase N so each shard is smaller. This helps only if no single file dominates; verify against real
  per-file timings first, because index-based partitioning with one very slow file does not improve with
  more shards.

Get per-file timings before choosing. The whole defect here is that the current split was chosen
without duration data.

## Acceptance criteria

- Integration shard durations are within a stated factor of each other (e.g. no shard more than ~1.5x
  the median), demonstrated with real CI timings, not estimated.
- Adding one ordinary integration test file cannot push a shard over its timeout.
- The timeout budget is justified by measured headroom rather than raised until it stops hurting.

## Optional scope (explicitly NOT required to close this ticket)

- Making a timed-out shard distinguishable from a shard with a failing test in the CI summary. A green
  suite killed by the job clock currently reads as a test failure, which cost one wrong triage turn.
  Worth doing, but it is an observability nicety — it does not affect whether the shards balance, and it
  must not be allowed to expand this ticket. Split it out if it grows.
