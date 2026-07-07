---
id: FG-486
type: story
status: active
title: recover --continue and reconcile misclassify invoke_chain runs as pipeline runs — quick-lane orphans are wrongly refused adoption / landed orphaned_needs_finalize (FG-481/FG-479 follow-up)
created: 2026-07-07
---

Operator review finding on the shipped FG-481/FG-479 work (2026-07-07).

## Problem

Both guards use `run.workflow === "invoke"` as the proxy for "no host-side finalize to bypass":
- src/cli/commands/recover.ts (~:106 isInvokeRun; ~:270 refusal): every non-invoke workflow is refused --continue with the pipeline-finalize rationale.
- src/v2/reconcile.ts (~:234 isInvokeRun): container-gone-with-usable-result tasks in non-invoke runs land failed/orphaned_needs_finalize.

But campaign quick lanes create `workflow: "invoke_chain"` runs (src/campaign/executor.ts:1225) whose tasks are dispatched through plain v2/invoke.ts — NO worktree merge, NO integration gate, NO reds. There is no finalize to bypass. Consequences: a recoverable quick-lane orphan is refused --continue (and --force does not override), pointed at retry --force which re-dispatches and may discard persisted work; and reconcile misclassifies its container-gone-with-result shape as orphaned_needs_finalize instead of completing it.

## Goal

One shared predicate expressing "this run's tasks have a host-side pipeline finalize" (true for every workflow EXCEPT invoke and invoke_chain), used by recover's --continue eligibility, recommendationFor, reconcile's TASK-level container-gone branches, and the show/status guidance threading. invoke_chain tasks behave exactly like invoke tasks on all those surfaces.

## Explicitly unchanged (scope boundaries)

- Reconcile's RUN-level completion stays literal `workflow === "invoke"`: an invoke_chain run mid-chain has more invokes coming that only the campaign executor knows about — reconcile must not complete the run early. Pin with a test + comment.
- Auxiliary invoke tasks attached to PIPELINE runs (e.g. in-run fixers, phase "task") stay conservatively refused — their nature is not derivable from run.workflow; classifying them is FG-477 lineage-classifier territory.

## Acceptance criteria

- [ ] Shared predicate in one module (no third copy); recover.ts and reconcile.ts task-level branches and the show/status guidance threading all consume it.
- [ ] Regression: invoke_chain run, orphaned task per CONTINUABLE_KIND -> --continue adopts (same semantics as invoke, including the shared-dir --force nuance); pipeline workflows still refused with the FG-481 message.
- [ ] Regression: invoke_chain run, container-gone task with valid result (and the stdout-recovered variant) -> reconciled COMPLETE, not orphaned_needs_finalize; pipeline workflows unchanged.
- [ ] Run-level reconcile completion still refuses invoke_chain (test + comment).
- [ ] Guidance surfaces (recommendationFor, orphanRecoveryMessage/show, status) recommend --continue for invoke_chain tasks again; pipeline guidance unchanged.
- [ ] docs/concepts.md wording reconciled where it says "any workflow other than invoke".
