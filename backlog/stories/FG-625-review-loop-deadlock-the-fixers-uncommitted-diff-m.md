---
id: FG-625
type: story
status: active
title: "review-loop deadlock: the fixer's uncommitted diff makes the extended tier refuse, so a fix round can never pass verification"
created: 2026-07-25
---

## Problem

`forge review-loop` cannot complete a fix round in this repo. The loop's own sequencing deadlocks
against the release-build tests' clean-checkout precondition:

1. The reviewer returns `needs_fix` with a finding.
2. The fixer edits source. The loop does **not** commit yet — it commits only after verification passes.
3. Verification runs the extended tier against the working tree, which now carries the fixer's
   **uncommitted** changes.
4. The FG-569 / FG-575 / FG-580 release-build tests refuse to build from a dirty checkout.
5. Verification fails → the loop stops `verification_failed` → the fix is **left uncommitted**.

The fix can never be committed, no matter how correct it is.

## Evidence

Observed live on `run-review-loop-fg-559-fdc4ce` (FG-559, 2026-07-25).

The fixer's own result:

> Full `forge-test --integration` reports 3857/3897 with **39 failures, ALL in the FG-569/FG-575/FG-580
> release-build files, which refuse to build from a dirty checkout**; stashing the working tree makes
> `src/v2/release.integration.test.ts` pass 36/36, so those are an uncommitted-tree precondition, not a
> regression from this diff.

Everything else the fixer ran was green: typecheck clean, unit 2785/2785, worktree 239/239, the two
targeted integration files green, plus an anti-regression proof (stash `reconcile.ts` → the two new
tests fail; restore → they pass).

The loop reported:

```
- **stop reason:** verification_failed
- **closeable:** no
- fix left uncommitted (verification failed): docs/concepts.md, src/v2/crash-points.test.ts,
  src/v2/fg530-crash-matrix.integration.test.ts, src/v2/fg530-harness.ts,
  src/v2/fg559-git-unavailable-classification.integration.test.ts, src/v2/reconcile.ts
```

The finding itself was real and the fix was correct — it was committed by hand as `aba8d32` after the
loop gave up, which is precisely the manual relay `review-loop` exists to remove.

## Why this is new

FG-575 (shipped 2026-07-24, `9a73105`) added the assertion that the release tier never builds from a
dirty invoking checkout. That assertion is correct and should stay. But it converted a previously
tolerable condition — a dirty tree during verification — into a hard refusal, and nothing in
`review-loop` was updated to account for it.

Related, deliberately NOT reopened: FG-617 recorded the same refusal as an accepted limitation for the
operator-runs-tests case, which it is. This ticket is different scope — the refusal structurally breaks
an automated loop, which FG-617's body never considered.

## Direction (not decided)

- **Commit the fixer's work before verifying**, then verify the committed tree. Matches what a human
  does, and what had to be done by hand here. Needs a story for a round whose verification then fails —
  amend, revert, or leave the commit and stop.
- **Verify in a clean worktree** at the fixer's proposed tree rather than in the invoking checkout.
- **Have the loop's verification skip the release tier**, since a review round is not a release. Cheapest
  and most targeted, but a real coverage reduction inside the loop — the gate would no longer be the
  same gate CI runs.

Whichever is chosen, the loop must not silently discard a correct fix.

## Acceptance criteria

- A `review-loop` round that produces a correct fix in this repo reaches a committed fix and a
  `passed`/`closeable` verdict without hand-intervention. Demonstrated on a real ticket, not a fixture.
- A round whose fix is genuinely BAD still fails verification and does not land — the deadlock fix must
  not become a way to commit unverified work.
- The FG-575 clean-checkout assertion is unchanged and still passes.
- The chosen behavior is documented in `docs/how-to-testing.md` or the review-loop docs, including what
  happens to the commit when a round fails verification.
