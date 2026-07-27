---
id: FG-635
type: story
status: active
title: Run completes with a guaranteed workflow phase never dispatched — an ad-hoc task completing satisfies the run-completion evaluator while the docs phase is still pending
created: 2026-07-27
---

**Found live 2026-07-27** on `run-fg-566-shared-host-side-verification-readiness-contract-0f7edc`.

## What happens

The `feature` workflow's final phase is `docs` (`~/.forge/workflows/feature.yml:133`), declared
`depends_on: [verify]`, `gate: auto`, and deliberately unconditional. Its own comment states the
intent:

> Docs is a guaranteed phase (#257), not an orchestrator afterthought. Forge's docs-impact assessment
> is advisory-only — it warns, it never blocks — so feature runs silently shipped without doc updates.
> A phase the documentation-maintainer runs every time can't be skipped.

On this run it was **never dispatched**, and the run marked itself `complete` anyway. There is no
`docs | documentation-maintainer` task row in the run at all.

## Sequence

```
21:25:29  gate.decided   task-verify-de1382   (verify advanced)
21:25:29  task.completed task-verify-de1382
21:25:14  task.started   task-engineer-baadbb (AD-HOC forge invoke, phase="task")
21:44:19  task.completed task-engineer-baadbb
21:44:50  run.completed
```

The verify gate was advanced but no `forge next` had yet dispatched the following wave — `forge next`
dispatches one wave and must be re-run to advance. In that window an **ad-hoc** task (a
`forge invoke engineer` fixer attached to the run with `--run`, phase `task`, not a workflow step)
completed. Its completion drove the run-completion evaluation, which concluded the run was done while
a guaranteed workflow phase sat undispatched.

A `forge next` issued 24 seconds later found nothing to do — the run was already terminal.

## Why it matters

This is a false completion of the same family as FG-585, but on the read side of phase coverage
rather than task status: the run is reported `complete` and `succeeded`, so every downstream consumer
(operator summary, campaign progression, done-audit, the dashboard) sees a fully-executed feature
run. Nothing anywhere records that `docs` never ran.

The specific irony is that `docs` was made a guaranteed phase precisely *because* docs-impact was
advisory and runs "silently shipped without doc updates". This path silently ships without doc
updates again, through a different door — and unlike the advisory it replaced, it emits no warning at
all.

Ad-hoc tasks attached to a run with `--run` are the normal, documented way an orchestrator fixes a
`blocked_by_red` build (there is no in-phase re-review), so this window is routinely open on exactly
the runs that needed the most intervention.

## Acceptance criteria

1. Reproduce RED: a run with an undispatched non-terminal workflow phase must not be markable
   complete by an ad-hoc task's completion. Assert against this run's shape — verify advanced, docs
   never created, ad-hoc task completes, run goes `complete`.
2. Run completion requires every non-skipped workflow phase to have reached a terminal state. A phase
   that was never dispatched is not terminal.
3. An ad-hoc task (`phase: "task"`, dispatched via `forge invoke --run`) completing must not by itself
   drive a run to `complete`. Ad-hoc work is attached to a run for provenance; it is not workflow
   progress.
4. If a run is nonetheless finalized with an undispatched phase for some legitimate reason, that fact
   is recorded and visible — not inferable only by diffing the task list against the workflow
   definition.
5. Verify the fix does not wedge the inverse case: a run whose remaining phases are genuinely skipped
   by condition must still complete normally.
6. `forge-test` green; required CI checks green.

## Non-scope

Not a change to `forge next`'s one-wave-per-call semantics, and not a change to how ad-hoc tasks
attach to runs. This is about what the completion evaluator counts as progress.

Refs: `feature.yml:133` (the docs phase and its #257 rationale), the run-completion evaluator, FG-585
(the `failed` RunStatus / false-completion work), FG-477 (workflow run lifecycle evaluator —
centralizing exactly these semantics so ready-queue, completion, resume and reconcile cannot drift;
this is a concrete instance of that drift).

Recovery used on the affected run: dispatched the documentation-maintainer as an ad-hoc invoke on the
same run with the docs phase's brief, since the phase itself was no longer dispatchable.
