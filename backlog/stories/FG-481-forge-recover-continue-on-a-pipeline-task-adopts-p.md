---
id: FG-481
type: story
status: active
title: forge recover --continue on a PIPELINE task adopts persisted work as complete, skipping merge/integration-gate/reds — decide whether the operator-explicit path needs the FG-479 guard too
created: 2026-07-07
---

Discovered while implementing FG-479 (reconcile no longer completes pipeline tasks from container-gone recovery; recover --continue deliberately refuses the new orphaned_needs_finalize kind).

(Note: originally filed as FG-480 during the FG-479 session, but that file was removed by a review-loop tree restore before it was committed and the number was re-allocated to the fanoutWaveRecoveryMessage cosmetic follow-up. The FG-479 PR #53 body and commit efa0d9b reference "FG-480" for THIS ticket — those references are stale.)

## Gap

performContinue (src/cli/commands/recover.ts) adopts persisted work and marks a failed task complete for CONTINUABLE_KINDS (orphaned / orphaned_work_may_persist / oom_killed) via markTaskRecovered. For a PIPELINE task in one of those kinds, adoption completes the step without the host-side finalize (worktree merge -> integration gate -> reds -> gates) ever running — the same bypass class FG-479 closed on the silent reconcile path, but here behind an explicit, flag-gated operator decision (--continue, sometimes --force).

## Considerations

- This is operator-trust-boundary territory (like forge record-host-verification): the operator explicitly says "adopt this work". FG-479's rationale for refusing orphaned_needs_finalize was that adoption would recreate the bypass silently; --continue on an orphaned pipeline task is a deliberate act.
- But the operator may not realize adoption skips reds/integration gate for a pipeline step — today nothing in the --continue output says so.
- Options: (a) refuse --continue for pipeline-run tasks entirely (force retry --force re-drive); (b) allow but require --force with an explicit skipped-gates warning; (c) allow and re-drive the finalize sequence over the adopted work (heavier, FG-477 territory); (d) document-only.

## Acceptance criteria

- [ ] A decision is recorded (ticket comment or ADR if it changes behavior) on which option applies, with rationale referencing the FG-479 invariant (no completion without host-side finalize) vs the operator-trust boundary.
- [ ] If behavior changes: tests covering a pipeline task adopted via --continue (or refused), including the --force path.
- [ ] If document-only: the --continue docs/help output state explicitly that adoption on a pipeline task skips merge/integration-gate/reds.
