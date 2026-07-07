---
id: FG-481
type: story
status: active
title: forge recover --continue on a PIPELINE task adopts persisted work as complete, skipping merge/integration-gate/reds — decide whether the operator-explicit path needs the FG-479 guard too
created: 2026-07-07
---

Discovered while implementing FG-479 (reconcile no longer completes pipeline tasks from container-gone recovery; recover --continue deliberately refuses the new orphaned_needs_finalize kind).

## DECISION (operator, 2026-07-07 — implement this)

**Option (a): refuse `--continue` for pipeline-run tasks entirely.** A task whose run's workflow is not `invoke` is never continuable — `performContinue` refuses with a clear message pointing at `forge retry <id> --force` (the re-drive-through-real-finalize path). `--force` does NOT override this refusal (it continues to override only the shared-projectDir ambiguity for invoke tasks): no operator command may recreate "complete without merge/gate/reds" until Forge can re-drive finalize safely (FG-477 territory). Operator rationale: don't allow an operator command to recreate the exact bypass FG-479 closed on the silent path.

## Problem

performContinue (src/cli/commands/recover.ts) adopts persisted work and marks a failed task complete for CONTINUABLE_KINDS (orphaned / orphaned_work_may_persist / oom_killed) via markTaskRecovered. For a PIPELINE task in one of those kinds, adoption completes the step without the host-side finalize (worktree merge -> integration gate -> reds -> gates) ever running — the same bypass class FG-479 closed on the silent reconcile path, but here behind an explicit, flag-gated operator decision.

## Goal

`forge recover --continue` can never complete a pipeline step whose host-side finalize did not run: pipeline-run tasks are refused (no writes, --force does not override) with guidance to `forge retry <id> --force`; invoke-run tasks keep today's adoption behavior exactly.

## Acceptance criteria

- [ ] performContinue refuses (no writes) any task whose run workflow is not `invoke`, regardless of failure kind and regardless of --force; the refusal message names the pipeline-finalize rationale and points at `forge retry <id> --force`.
- [ ] Invoke-run tasks keep today's --continue behavior exactly (existing recover tests stay green).
- [ ] Negative tests: pipeline task in each CONTINUABLE_KIND (orphaned / orphaned_work_may_persist / oom_killed) with --continue and with --continue --force — assert refused, task status unchanged, no markTaskRecovered write, no events beyond the refusal path.
- [ ] `forge recover <runId>` run-level listing and single-task view still SURFACE pipeline tasks (FG-479 behavior unchanged); only adoption is refused.
- [ ] docs/concepts.md --continue bullet states the pipeline refusal and why.
