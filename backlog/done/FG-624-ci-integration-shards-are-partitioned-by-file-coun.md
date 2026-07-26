---
id: FG-624
type: story
status: done
title: CI integration shards are partitioned by file count, not duration — shard 4 runs ~3x shard 1 and sits at its timeout budget
created: 2026-07-25
closed: 2026-07-26
closed_commit: 4ad20e8
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

## If 6 minutes proves impossible with the current tests

Operator direction (2026-07-25): do NOT stall on this. If balancing cannot fit the work inside the
existing budget with the tests as they stand, **record what the measurements show, leave this ticket
open, and move on** — do not raise `timeout-minutes` as a consolation, and do not weaken tests to fit.
The follow-on conversation is whether the integration tests themselves should be reshaped, which is a
larger design question than partitioning.

The arithmetic says balancing alone should be sufficient, so this caveat is a backstop rather than the
expected outcome: measured shard totals on main were 2m43 + 2m27 + 3m12 + 5m25 = **13m47 across four
shards, i.e. ~3m27 average**. An even partition lands every shard near half the budget. The only way
that fails is a single file that alone approaches or exceeds 6 minutes — which is precisely why the
per-file measurement in Step 1 has to happen before any design, and why a file over ~90s is called out
for reporting.

If such a file exists, name it here with its measured time. That is the input to the reshape
conversation.

---

## Acceptance Evidence (merged as `4ad20e8`, PR #162)

| AC | Evidence | Verdict |
|---|---|---|
| Integration shard durations within a stated factor of each other, demonstrated with real CI timings, not estimated | Real CI on PR #162 (run 30173109931): 3m50s / 2m55s / 2m02s / 2m47s / 2m37s. Worst-to-median ≈ 1.4x, inside the ~1.5x target. Before: 6m10s / 2m53s / 2m36s / 1m51s — worst shard TIMED OUT. Planner: greedy longest-processing-time over `scripts/integration-timings.json`, projecting 135.0s on every shard (`src/test-shards.ts`) | met |
| Adding one ordinary integration test file cannot push a shard over its timeout | Demonstrated live: FG-559's `fg559-git-unavailable-classification.integration.test.ts` was unmeasured, took the pessimistic p75 default weight, and its shard came in at 4m24s — inside the 6-minute ceiling. `planShards()` iterates the DISCOVERED file list and uses the manifest only as a weight lookup, so an unmanifested file is weighted, never dropped (`src/test-shards.test.ts`) | met |
| The timeout budget is justified by measured headroom rather than raised until it stops hurting | `timeout-minutes: 6` is UNCHANGED on every shard job; the only such line in the diff is `integration_5` inheriting the same 6. Headroom is ~2m10s on the worst real shard. Operator explicitly rejected raising the ceiling; the ticket records that as a fixed constraint | met |
| (optional scope) timed-out shard distinguishable from a failing shard in the CI summary | Not built — explicitly marked optional and not required to close | n/a |

Anti-drop check, the one that matters: unsharded 3781 tests; shards 595+583+1593+520+490 = 3781 exactly.
`src/v2/ci-workflow.test.ts` updated to require the 1/5..5/5 selector set, `test-extended` needing all
seven jobs, and `timeout-minutes: 6` on every one.

Reported, not fixed: `src/cli/commands/campaign.integration.test.ts` is 108.6s — 16.1% of the whole
tier and a hard floor on whichever shard holds it. No partition can put a shard below it. Not a
blocker today (~2.5 min projected); becomes real only if the tier grows again.
