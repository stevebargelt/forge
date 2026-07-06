---
id: FG-477
type: story
status: active
title: "Workflow run lifecycle evaluator: centralize task/run state semantics so ready-queue, run completion, gate recovery, campaign resume, reconcile, and operator surfaces cannot drift"
created: 2026-07-06
---

## Problem

Forge's workflow task/run lifecycle semantics are currently under-specified and split across several modules:

- `src/v2/ready-queue.ts` decides what can dispatch next.
- `src/v2/runNext.ts` decides when a run should complete.
- `src/v2/gate.ts` mutates task state and creates recovery work after human decisions.
- `src/campaign/executor.ts` maps terminal run state to campaign item state.
- Reconcile/show/report surfaces independently interpret parked, terminal, failed, and recoverable states.

This has repeatedly produced narrow follow-up bugs where tightening one layer exposes a mismatch in another. Recent examples:

- FG-475: a gate-rejected step with no `on_reject` could leave a run active forever because run completion did not understand permanently unreachable downstream steps.
- FG-476: an `on_reject` recovery task targeting an already-complete phase exists as a pending task, but the ready queue does not dispatch it because the target phase already has a complete primary.
- FG-475 review finding: campaign terminal-outcome classification currently risks using one failed primary task instead of aggregating all failed primary task blocker classes.
- FG-475 review finding: the new zero-ready settled-run finalization path needs the same abandoned-run guard as the later completion path.

The root issue is that task identity and lineage are implicit. `parentId`, `phase`, and task-package inputs are doing too much: fanout children, red-review children, retry attempts, and `on_reject` recovery attempts are all inferred differently by different modules.

## Goal

Create a single workflow run lifecycle evaluator that is the source of truth for:

- step state,
- run state,
- ready work,
- terminal blockers,
- task lineage/attempt kind,
- and operator-facing "why no work can run" explanations.

Existing modules should consume this evaluator instead of re-deriving lifecycle semantics locally.

## Proposed Shape

Introduce explicit task attempt kind / lineage semantics. The exact storage/API shape should be designed during the architecture phase, but the model should be able to distinguish at least:

- `primary`
- `retry`
- `on_reject_recovery`
- `fanout_child`
- `red_review`
- integration/check tasks if they remain task-like

The shared evaluator should return structured state such as:

- Step state:
  - `not_started`
  - `dispatchable`
  - `running`
  - `awaiting_gate`
  - `awaiting_red`
  - `blocked_by_red`
  - `complete`
  - `failed_terminal`
  - `unreachable`
  - `recovery_pending`
- Run state:
  - `active_dispatchable`
  - `active_waiting`
  - `terminal_success`
  - `terminal_failed`
  - `abandoned`
- Ready work:
  - the exact step/task attempt(s) to dispatch next.
- Terminal blockers:
  - all relevant failure kinds,
  - their campaign blocker classes,
  - and whether any shared blocker wins over local blockers.
- Operator reason:
  - why the run is waiting, blocked, terminal, or dispatchable.

## Acceptance Criteria

- `computeReadyQueue` becomes a thin wrapper over the evaluator's ready-work result, or is otherwise made impossible to drift from the evaluator.
- `runNext` uses the evaluator for both dispatch decisions and run-completion decisions.
- `gate` uses the evaluator after `advance`, `reject`, and `request-changes` rather than bespoke finalization logic.
- Campaign resume uses evaluator-derived terminal blocker state instead of scanning task rows ad hoc.
- `on_reject` recovery tasks targeting already-complete phases dispatch correctly.
- Mixed failed-primary runs classify conservatively: any shared blocker wins over local blockers.
- Abandoned/cancel races cannot be overwritten by completion on any run-finalization path.
- Reconcile/show/report operator surfaces consume the same lifecycle explanation or an explicitly derived view of it.
- Tests cover a lifecycle matrix across:
  - primary success/failure,
  - retry replacement,
  - `on_reject` recovery to a new phase,
  - `on_reject` recovery to an already-complete phase,
  - fanout child,
  - red-review child,
  - awaiting human gate,
  - blocked-by-red,
  - abandoned/cancel race,
  - mixed local/shared failed primaries.

## Non-goals

- Do not rewrite the workflow runner wholesale.
- Do not change campaign policy semantics except where the evaluator exposes an existing divergence.
- Do not add new operator verbs unless a concrete lifecycle state requires them.

## Notes

This should follow the immediate bug fixes for FG-475 and FG-476. The intent is to stop future lifecycle fixes from adding one-off interpretations in `gate.ts`, `runNext.ts`, or `executor.ts`; new lifecycle behavior should extend the shared evaluator.
