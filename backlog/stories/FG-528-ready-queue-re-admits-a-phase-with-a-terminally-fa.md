---
id: FG-528
type: story
status: active
title: ready-queue re-admits a phase with a terminally-failed primary while a non-primary child is pending — dispatchSingleStep mints a fresh primary and re-runs the step
created: 2026-07-11
---

## Problem

computeReadyQueue's "is any row pending" check (src/v2/ready-queue.ts:~105) ran over all non-adhoc rows — red/fanout/recovery children included. So a phase shaped [terminally FAILED primary + pending red child] fell through to the deps check and went READY; dispatchSingleStep found no pending workflow-primary row to reuse and minted a FRESH primary, silently re-running a failed step.

Found by the FG-477 slice-1 test-engineer (verified pre-existing on HEAD, both against the migrated ready-queue and `git show HEAD:src/v2/ready-queue.ts`); independently re-found by the FG-477/FG-529 review-loop reviewer (round 1), whose fixer applied the fix in the same round.

## Status: FIXED in PR #102 (branch feat/fg-477-slice1-lineage-classifier, commit 04b3706)

computeReadyQueue now answers "does this step still need dispatch" from ATTEMPT rows only — the classifier's primary kinds plus on_reject recovery; red/fanout children are not attempts. Regression tests pinned in src/v2/ready-queue.test.ts:
- failed primary + pending red child → NOT ready (FG-528)
- failed primary + pending fanout child → NOT ready (FG-528)
- failed primary + pending on_reject recovery → ready (FG-476 preserved)

## Acceptance Criteria

- [met] A phase with a terminally failed primary is not re-admitted by pending non-primary children; recovery goes through the existing verbs — enforced by the attempts filter, pinned by the two NOT-ready regressions.
- [met] Regression test for [failed primary + pending red child] → not ready; [failed primary + pending recovery row] keeps recovery-dispatch behavior — the three tests above.
- [met] Behavior change deliberate and documented — the FG-528-numbered comment block at the fix site + review round 1 record (run-review-loop-fg-477-09a484).

Close against PR #102's merge commit once it lands.

## Notes

Filed 2026-07-10 from the FG-477 slice-1 test-engineer report. Parent umbrella: FG-477; siblings: FG-527, FG-529.
