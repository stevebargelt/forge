---
id: FG-479
type: story
status: done
title: "reconcile: task-level container_gone_result_present falsely completes crashed PIPELINE tasks, bypassing reds/integration gate/human gates/worktree merge-back"
created: 2026-07-07
closed: 2026-07-07
closed_commit: de566fd
---

Source: independent engineering review 2026-07-06 (notes/forge-engineering-review-2026-07-06.md, finding F1 — CRITICAL). Review of main @ fbb070c.

## Problem

reconcile.ts:370-384 completes ANY `running` task whose container is gone and whose result.json parses (`container_gone_result_present`), with no workflow/reds/gate guard. The run-level completion IS correctly gated to `run.workflow === "invoke"` (reconcile.ts:650), but the task-level path is not. The controlling comment (reconcile.ts:335-336, "the work finished but the DB write was lost") is only true for single-step invoke runs.

In a pipeline, the task stays `running` through the entire post-container host-side sequence in dispatchSingleStep (runNext.ts:518-620): persistence check -> mergeWorktreeBranch (:535) -> runIntegrationGate (:546, runs npm test, minutes) -> awaiting_red (:579-580) -> reds -> finalizePrimary.

A crash/SIGTERM of the forge process anywhere in that window (the harness ~10-min kill is a known regular event) leaves `running` + valid result.json + gone --rm container. The next `forge status`, `forge show --reconcile`, or `forge next` reconciles the task straight to `complete`. For feature.yml that skips: the shipping-reviewer red + verdict gate on build (feature.yml:72,88), human gates on architect/plan/verify (:37,59,119), and in worktree mode the merge-back — so the "completed" step's work isn't even in the tree the next phase reads. If the crash landed while the integration gate was about to fail, reconcile completes a tree that failed its own gate. This converts the exact crash this subsystem exists to survive into a silent trust-gate bypass.

Related: F8 (same review) — reconcile from status/show holds no run lock, so the same bypass can happen with no crash at all while forge next is in the post-container window. Largely defanged once this fix lands.

## Fix direction (from the review)

Gate task-level `container_gone_result_present` completion to `run.workflow === "invoke"` (mirroring :650). For pipeline runs, reconcile must NOT terminally complete the task; it should land in a fail-safe, operator-visible state that can be re-driven through the REAL merge -> integration gate -> reds -> finalize path (or re-dispatched via the existing retry surface). NOTE: adding a new tasks.status value is a schema change + ADR per house rules — prefer an outcome that uses existing statuses/failure-kind classification unless the design genuinely demands a new status.

## Acceptance criteria

- [ ] Task-level container_gone_result_present completion applies ONLY to invoke-workflow runs; a pipeline task in that shape is never reconciled to `complete`.
- [ ] Pipeline task in that shape lands in a fail-safe non-complete outcome with the result.json evidence preserved and a clear operator next-action (retry/recover path documented in the reconcile output).
- [ ] Regression test: reconcileRun over a feature-workflow-shaped run with a `running` build task, reds defined in the workflow, valid result.json on disk, container gone — assert task NOT completed, reds NOT skipped, and the chosen fail-safe outcome + events are written. (reconcile.test.ts covers only invoke-shaped tasks today.)
- [ ] Invoke-shaped behavior unchanged (existing reconcile tests stay green).
- [ ] Run-level guard at reconcile.ts:650 and task-level guard share the same predicate (no second drift-prone copy of "is this an invoke run").
