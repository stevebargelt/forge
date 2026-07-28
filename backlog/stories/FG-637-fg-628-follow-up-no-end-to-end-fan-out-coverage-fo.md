---
id: FG-637
type: story
status: active
title: "FG-628 follow-up: no end-to-end fan-out coverage for a red that produced no review (path is correct by construction, composition untested)"
created: 2026-07-28
---

**Found 2026-07-28** by the FG-628 review-loop (round 10), and deliberately deferred rather than fixed:
it is test coverage on a path that is correct by construction, not a defect.

## The gap

FG-628 made a synthesized (forge-fabricated) `inconclusive` block the gate orthogonally to authority.
Every test it shipped drives the **single-step** dispatch path (`dispatchSingleStep` →
`runRedsAgainst` → `landBlockedByRed`). The **fan-out** path is separate production code:
`dispatchFanoutStep` → `runFanoutRedsAgainst` → its own `landFanoutBlockedByRed` transition, and it
dispatches its reds against the fan-out *integration candidate* rather than the primary's tree.

There is no end-to-end test asserting that a fan-out wave whose red produces no review blocks the
**parent** and persists the same distinction.

## Why this was deferred, not fixed

The decision logic is genuinely shared, so the behavior is already right:

- `runFanoutRedsAgainst` (`src/v2/runNext.ts` ~2302) calls the **same** `dispatchReds` as the
  single-step path, with `primaryTaskId: parentId`.
- It converts the result through the **same** `redRejection(redAggregate)` helper.
- `reviewMissing` is set at the single synthesis point inside `runOneRed` and consumed inside
  `dispatchReds`, both upstream of the split.

So the only fan-out-specific code is the landing transition, and *that* is already covered for its
mechanics by `fg482-blocked-by-red-atomicity.test.ts`'s fan-out cases (happy path, forced-event-failure
rollback, and the CAS-loses-a-race case on the parent).

What is genuinely untested is the **composition** — the two halves together, end to end, on the fan-out
path. A refactor that changed how the aggregate reaches `landFanoutBlockedByRed`, or that gave the
fan-out path its own red dispatch, would not be caught.

## Acceptance criteria

1. An end-to-end fan-out test: a wave whose red returns no review (synthesized `inconclusive`) blocks the
   **parent** task at `blocked_by_red`, against a **specialist** red with `gate_on_verdict: false` — the
   weakest rank, so a regression that reintroduced an authority dependency fails the test.
2. The persisted distinction is asserted on the fan-out path too: the synthetic high-severity
   "produced NO review" finding on the parent's verdict, and the `verdict.review_missing` event carrying
   its diagnostics.
3. Cover the publisher interaction where it applies — a fan-out under worktree mode dispatches its reds
   against the integration candidate, so assert that a review-missing block REFUSES the publication and
   the target does not move (the FG-425 contract), rather than only checking the task row.
4. The negative direction on the fan-out path as well: a genuine reviewer-authored `inconclusive` from a
   fan-out red still does NOT block, so this cannot silently become "any fan-out red failure blocks".
5. Prove each new test bites — revert the FG-628 marker in a scratch copy and confirm the fan-out tests
   fail, the same differential discipline FG-628's own tests used.
6. `forge-test` green; required CI checks (`test` and `test-extended`) green.

## Non-scope

Not a behavior change. If this work reveals that the fan-out path is NOT in fact correct, that is a
defect and belongs on its own ticket with its own reproduction — do not silently repair it here.

Refs: FG-628 (the provenance rule and its single-step coverage), FG-482 (fan-out `blocked_by_red`
transition mechanics, already covered), FG-425 (publication refusal on red rejection),
`src/v2/runNext.ts` `runFanoutRedsAgainst` / `landFanoutBlockedByRed`.
