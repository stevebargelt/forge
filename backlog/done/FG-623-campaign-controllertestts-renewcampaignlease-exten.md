---
id: FG-623
type: story
status: done
title: campaign-controller.test.ts 'renewCampaignLease extends a live lease' is a 1ms knife-edge against a live clock — ~2% flake rate on an idle host
created: 2026-07-25
closed: 2026-07-28
closed_commit: 612e481f
---

## Problem

`src/store/campaign-controller.test.ts:127` — *"renewCampaignLease extends a live lease across a long
drive; wrong generation is fenced"* — fails intermittently. Observed red on CI (PR #161, run
30167674417, job `test`) on a branch that cannot affect it.

```
AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:
false !== true
    at TestContext.<anonymous> (src/store/campaign-controller.test.ts:127:12)
```

## Root cause — measured, not inferred

The assertion is `assert.equal(renewCampaignLease(cid, ownerA, 1, TTL), true)`. The test acquires a
lease at clock offset 0, sets the test clock offset to **TTL-1**, and asserts the owner can still renew
— i.e. the lease is nominally live by exactly **1 millisecond**.

`renewCampaignLease`'s UPDATE carries `WHERE ... AND lease_expires_at_ms >= ?` bound to `storeNowMs()`.
`storeNowMs()` is `SELECT julianday('now')` truncated to integer ms **plus** the test clock offset — a
REAL, ticking wall clock, not a frozen one. Acquire stamps expiry at `T0 + TTL`; renew compares against
`T1 + TTL - 1`. The renewal therefore succeeds only if `T1 - T0 <= 1` — at most ONE millisecond of real
wall-clock time may elapse between the acquire and the renew. `TTL` is 300000ms, so the test leaves a
1ms margin against a live clock.

**Measured distribution** (400-iteration probe against the real store functions, idle container): the
value of `(now_at_renew - lease_expiry)` came out `{-1: 385, 0: 10, +1: 5}`, and `renewCampaignLease`
returned `false` on **8 of 400 runs (~2%)**. Values <= 0 pass, > 0 fail. A loaded CI runner simply lands
on the wrong side of the 1ms window more often.

Note that a naive re-run check is not sufficient evidence here: 20 iterations pass 20/20 roughly 67% of
the time at a 2% rate, so "I ran it 20 times and it passed" does not distinguish flake from fixed. The
margin has to be measured directly.

## Not caused by FG-559

Confirmed during the FG-559 branch's CI triage. That branch touches exactly one file under `src/store/`
— `src/store/events.ts` — and the diff is purely a new `EventType` string-literal union member plus
comments. It is a TYPE-ONLY change, erased at runtime, and `campaign-controller.ts` does not consume
`EventType`. No other file in that diff is reachable from `campaign-controller.test.ts`.

## Direction

Give the renewal real headroom: set the clock offset to something meaningfully less than `TTL` rather
than `TTL-1`, so the test asserts "a live lease can be renewed" rather than "a lease with 1ms remaining
can be renewed within 1ms of wall clock".

If the 1ms boundary itself is worth testing, it needs a frozen/injected clock, not a live one — but that
is a different test with a different name, and the existing test's stated intent ("extends a live lease
across a long drive") is clearly the headroom case.

While in the file, check the sibling lease tests for the same pattern — any other assertion that pins
`storeNowMs()` to a sub-millisecond margin has the same defect whether or not it has flaked yet.

## Acceptance criteria

- The test asserts the intended behavior (a live lease renews) without depending on sub-millisecond
  wall-clock timing.
- Demonstrated non-flaky by a margin measurement, not only by a passing run count — show that the
  passing condition has headroom well beyond observed scheduling jitter.
- The generation-fencing half of the test (wrong generation is refused) is preserved.
- Sibling lease tests audited for the same live-clock knife-edge.

## Sighting log

- **2026-07-28 (impact escalation).** This flake **failed a `forge review-loop` verification gate** on
  FG-345, stopping the loop with `verification_failed` and withholding `closeable` — on a change that
  touches neither leases nor clocks. Reproduced immediately afterwards at **1 failure in 5 runs** of
  `campaign-controller.test.ts` alone on an otherwise idle host, well above the ~2% this ticket records.
  That reclassifies it: it is no longer only a cosmetic CI annoyance, it can halt a review loop and
  costs a full re-run each time it fires. Worth prioritising accordingly.


- **2026-07-28** (third recorded sighting) — hit once during FG-636's implementation, on the FIRST
  full unit-tier run inside the engineer's container; did not recur across 4 subsequent full-tier runs
  or 8 isolated runs of the file. Causally unrelated to that diff (the file uses an in-memory DB and a
  fake clock offset, and reads no `FORGE_*` variable). Consistent with the ~2% idle-host flake rate
  this ticket already records, and independent corroboration that the knife-edge is timing, not
  environment.

## Acceptance Evidence

Shipped in `612e481f` (PR #172, squash of `877b3c85`). Renewal offset changed from `TTL-1` to `TTL/2`
in `src/store/campaign-controller.test.ts` — a 4-insertion/2-deletion diff in that one file.

| AC | Evidence | Verdict |
|----|----------|---------|
| Test asserts live-lease renewal without sub-millisecond wall-clock timing | `setPublicationClockOffsetForTest(TTL / 2)` at src/store/campaign-controller.test.ts:127 (was `TTL - 1`); renewal now has ~150,000 ms of clock headroom (`612e481f`) | met |
| Non-flakiness demonstrated by margin measurement, not only pass count | 400-iteration probe replicating the test's exact sequence against the real store functions: before, margin {-1: 385, 0: 10, +1: 5} with 2/400 renew failures (reproducing the ticket's knife-edge); after, margin min=149999ms max=150000ms with 0/400 failures — 5 orders of magnitude beyond observed jitter. Corroborated (not substituted) by 50/50 green isolated runs of the file and two full unit-tier runs at 2845/2845 | met |
| Generation-fencing half preserved | `assert.equal(renewCampaignLease(cid, ownerA, 99, TTL), false)` at src/store/campaign-controller.test.ts:133 unchanged and passing in all runs; the TTL+1 liveness check also retains ~150s margin (renewal stamps expiry at 1.5×TTL) | met |
| Sibling lease tests audited for the same knife-edge | All 10 other tests in the file inspected: every other `setPublicationClockOffsetForTest` site is offset 0 or TTL+1 in the expiry direction, where elapsed wall time strengthens the assertion (monotone-safe); the AC10 linkage block uses no clock offset. Exactly one occurrence of the pattern existed — the fixed test | met |

Verification: review-loop `run-review-loop-fg-623-5eb9a1` — stop reason `passed`, closeable, reviewed
tip `877b3c85` equal to remote head; CI at `877b3c85` green on both required checks (`test`,
`test-extended` — all four integration shards, worktree, dashboard_integration pass). Docs impact: none
(test-only change).
