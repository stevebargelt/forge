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


## Architecture pass (2026-07-07, autonomous session)

Design artifact produced per the four shaping constraints (pure derivation / lineage classifier first / verdict-aggregation fold-in / seam-at-a-time adoption): `~/.forge/runs/run-fg-477-lifecycle-evaluator-architecture-f151d7/task-architecture-advisor-705984/result.json` — module boundary, full classifier decision table (primary | retry_replacement | on_reject_recovery | fanout_child | red_review), aggregation fold-in shape, ordered independently-shippable slices, migration risks+mitigations. Read against post-FG-479/481/482/483/484 code, not the review's stale line numbers. Implementation NOT started as a whole (deliberate session bound), but TWO narrowing slices have since shipped independently: (1) FG-512 (2026-07-10, merge a9fe0e2) — total dispatch provenance: every runner-minted row carries taskPackage.dispatchSource 'workflow' (invoke rows 'invoke' per FG-507), which the lineage classifier can consume directly instead of inferring provenance structurally; (2) FG-519 (2026-07-10) — the F14/F15 phase-authoritative-primary disagreement is RESOLVED: one canonical resolvePhasePrimary (latest COMPLETE parent-less row, exported from ready-queue.ts) is now consumed by deriveUpstream, computeReadyQueue, and the fanout upstream read, killing the 'latest by createdAt regardless of status' vs 'latest complete' vs 'any complete' divergence rule 2's rationale cites. The evaluator's remaining scope should absorb/replace resolvePhasePrimary rather than re-derive it. Next step: review the slice plan, then dispatch slice 1 (the classifier) as its own ticketed implementation.


### Slice plan (pasted from the architecture artifact for durability — FG-486 review finding 2)
**Module boundary:** {"location": "src/v2/lifecycle-evaluator.ts (new file, alongside ready-queue.ts/gate.ts/runNext.ts) \u2014 NOT under src/campaign/. Campaign's BlockerKind vocabulary (src/campaign/policy.ts) is a translation layer over the evaluator's output and must stay there; folding it into the evaluator would smuggle campaign policy into a module every non-campaign consumer (ready-queue, gate, runNext, reconcile) also depends on.", "surface": ["classifyTaskLineage(workflow, tasks) -> Map<taskId, LineageKind> \u2014 pure, total, no DB/IO. LineageKind = 'primary' | 'retry_replacement' | 'on_reject_recovery'

**Classifier decision table:**
{'inputs': "task.parentId, task.phase, task.status, task.createdAt, task.agentRole, task.taskPackage.inputs['rejectedTaskId'], workflow.steps[phase].reds[].agent, workflow.steps[phase].fanout, workflow.steps[phase].on_reject", 'rules_in_priority_order': ["1. parentId === undefined AND no earlier (by createdAt) task with parentId===undefined exists in the same phase => primary. (Covers fresh dispatch, manual steps, and the first row of a fanout parent's phase. A fanout parent is simply a 'primary' whose step declares `fanout` — no separate marker needed; today's gate.ts inputs.fanout-object check and reconcile.ts's container.started-absence check both collapse into this one workflow lookup.)", "2. parentId === undefined AND an earlier parentId===undefined task DOES exist in the same phase => retry_replacement. Structural, not marker-based: this deliberately unifies forge-retry replacements (marked via inputs.previous_failure) and gate request-changes replacements (marked via inputs.requestedChanges) into one kind, since both are dispatch-identical today (both fresh pending rows with parentId undefined in the same phase) and F15 already names 'latest primary by createdAt' vs 'latest complete' vs 'any complete' as three of its four incompatible heuristics for exactly this question.", "3. parentId !== undefined AND inputs.rejectedTaskId !== undefined => on_reject_recovery. Checked BEFORE any phase/role test, preserving today's isOnRejectRecoveryTask priority exactly — this is the one existing heuristic that is already correct, including the schema-legal but rare self-referencing on_reject case (on_reject === step.id), where the recovery task's phase equals its rejecting task's phase and would otherwise collide with rule 4.", "4. parentId !== undefined AND workflow.steps[task.phase].reds contains an entry with agent === task.agentRole => red_review. This REPLACES the 'red-' role-name-prefix string convention used today in retry.ts, runNext.ts, and recover.ts with a looku

**Ordered slices:**
1. Add lifecycle-evaluator.ts with classifyTaskLineage only — files: ['src/v2/lifecycle-evaluator.ts (new)', 'src/v2/lifecycle-evaluator.test.ts (new)']
2. Migrate ready-queue.ts's internal predicates to the classifier — files: ['src/v2/ready-queue.ts', 'src/v2/ready-queue.test.ts']
3. Migrate retry.ts's fanoutParentOf and reconcile.ts's fanout-parent-orphan detection — files: ['src/v2/retry.ts', 'src/v2/reconcile.ts', 'src/v2/retry.test.ts', 'src/v2/reconcile.integration.test.ts']
4. Migrate runNext.ts's dispatch-time pending-row-reuse sites — files: ["src/v2/runNext.ts (dispatchSingleStep, dispatchManualStep, dispatchFanoutStep's existingParent/activeWithChildren/pendingHasChildren)", 'src/v2/runNext.integration.test.ts', 'src/v2/runNext-spec.test.ts', 'worktree/integration fg-suites exercising fanout+manual+reject']
5. Fold verdict/gate aggregation into the evaluator — files: ['src/v2/lifecycle-evaluator.ts (add aggregateStepVerdicts)', 'src/v2/gate.ts (aggregateVerdicts call site)', "src/v2/runNext.ts (dispatchReds authoritative-fail loop only — separate region from slice 3's changes)"]
6. Migrate gate.ts's isFanoutParent to workflow.steps[phase].fanout — files: ['src/v2/gate.ts']
7. Migrate campaign's terminal-outcome and authoritative-outcome derivations — files: ["src/campaign/executor.ts (reconcileTerminalOutcome's failedPrimaries derivation)", "src/campaign/reconcile-evidence.ts (evaluateAuthoritativeOutcome's per-task bucketing, now calling aggregateStepVerdicts)", 'their tests']
8. cli/commands/recover.ts's isFanoutParent / fanoutParentRecoverable — files: ['src/cli/commands/recover.ts']

**Aggregation fold-in:** aggregateStepVerdicts(step, verdicts) becomes the ONE place that reads `gate_on_verdict`, and it always reads it from `step.reds[].gate_on_verdict` (workflow config resolved via the verdict row's redRole/redTaskId) — never from a field persisted onto VerdictRow. Today's split is: runNext.ts's dispatchReds inline loop reads `r.red.gate_on_verdict` off the in-memory RedDef at dispatch time (correct, has the config); gate.ts's aggregateVerdicts has no such field on VerdictRow and ignores gate_on_verdict entirely at gate-time (the F16 divergence). Since gate.ts already calls `loadWorkflow`/`findSt

**Top migration risks:**
- high: Slice 3 (runNext dispatch hot path) is where a wrong lineage classification does the most damage — mitigation: Ship slice 3 only after slices 1-2 have run through the full worktree+integration test tier with zero regressions. Keep the old heuristics compiled but dead (not deleted) for one release so a revert i
- medium: Slice 4's verdict-aggregation convergence is a real behavior change for at least one workflow shape, not a pure refactor — mitigation: Audit shipped workflow YAMLs (security-audit.yml, feature-ui-design-needed.yml, feature.yml, and any other seeds/workflows/*.yml with authoritative reds) for gate_on_verdict:false + authority:authorit
- medium: During the multi-slice migration window, the four-heuristics problem is temporarily FIVE heuristics (old x4 + new x1), and a new lineage bug fix landed mid-migration could get patched into a legacy site about to be delet — mitigation: Freeze new lineage-heuristic edits to the legacy call sites for the migration's duration — route any new lineage-adjacent bug fix through classifyTaskLineage immediately, even out of the planned slice


## Slice-7 addendum (2026-07-07, FG-485 closeout)

FG-485 (merge dc7d725) added one more executor.ts call site for slice 7 to absorb: the liveness-first probe ahead of evaluateInvokeLaneEligibility in driveRemainingItems' awaiting_gate reattach branch. It deliberately reuses the pure primitives (computeReadyQueue + taskHasPipelineFinalize + the existing getRun/status check) and invents no new lineage/state vocabulary, per this ticket's migration-freeze guidance — when the evaluator lands, redirect that probe to the evaluator's run-liveness/dispatchability derivation.


## SUPERSESSION NOTE for the architecture artifact above (2026-07-11, slice 1 shipped)

The "Classifier decision table" and "Ordered slices" sections above are the 2026-07-07 architecture ARTIFACT, preserved as a point-in-time record — they are NO LONGER the authoritative spec. The shipped classifier (src/v2/lifecycle-evaluator.ts, PR #102) supersedes them in three ways:

1. **Provenance precedes lineage.** The shipped decision table checks taskPackage.dispatchSource FIRST (rule 0), before any parentId/marker/phase rule — the artifact's table omits provenance entirely (it predates FG-512 landing).
2. **Two additional kinds.** The shipped union is 7 kinds: the artifact's five PLUS adhoc_invoke (dispatchSource==='invoke' rows, FG-507) and legacy_ambiguous_invoke (marker-less rows in run-kind.ts's legacy_ambiguous_phase shape, preserved as workflow-primary-compatible to keep legacy decisions byte-identical).
3. **Slice 1 shipped bundled.** The artifact's slice 1 was classifier-only; the shipped slice 1 (FG-529) bundles the classification-only migrations of ready-queue.ts, runNext dispatchSingleStep, and reconcile finalizeOrphanedPrimaries, plus the FG-528 readiness fix from review round 1. The artifact's slices 2-4 are therefore PARTIALLY consumed; the remainder (dispatchFanoutStep, retry) is FG-527.

The authoritative decision table is the code + its tests (src/v2/lifecycle-evaluator.ts / lifecycle-evaluator.test.ts).

## Slice 1 SHIPPED (2026-07-10, autonomous session — classifier + 3 classification-only consumer migrations)

`src/v2/lifecycle-evaluator.ts` landed: `classifyTaskLineage(workflow, tasks)` — pure, total, exhaustive 7-kind union (`primary | retry_replacement | on_reject_recovery | red_review | fanout_child | adhoc_invoke | legacy_ambiguous_invoke`), decision table per the architecture pass with provenance (dispatchSource, FG-512) checked before lineage. Seeded-generator totality + order-insensitivity properties; frozen-legacy parity oracles per migrated consumer.

Consumers migrated (classification only, byte-identical decisions): ready-queue.ts (wrappers preserved for gate.ts imports), runNext.ts dispatchSingleStep pending-row reuse (the architecture's top-risk hot path — ~3000-set parity), reconcile.ts finalizeOrphanedPrimaries.

Deferred WITH pinned disagreement tests → **FG-527**: retry.ts fanoutParentOf and runNext dispatchFanoutStep — the legacy `red-` prefix heuristic misclassifies shipping-reviewer reds (blocks their retry), and dispatchFanoutStep lacks the FG-507 ad-hoc exclusion; the classifier is right, so migrating is a deliberate behavior change owned by that ticket. resolvePhasePrimary deliberately NOT absorbed yet (in-file reason at ready-queue.ts:145-152: threading the workflow would narrow unfiltered-caller row universes — a behavior change for deriveUpstream/fanout-upstream).

**Design note for slice 5 (verdict aggregation fold-in):** the architecture artifact's shape ("gate_on_verdict always read from workflow config, never persisted on VerdictRow") is SUPERSEDED by FG-523 (merge 283d7c0), which persisted gate_on_verdict on verdict rows per operator direction — dispatch and aggregateVerdicts already share one predicate (verdictBlocksGate) reading the persisted flag, NULL fail-closed. Slice 5 should absorb that predicate as-is, not re-derive from config.

Remaining slices: 2-of-4 dispatchFanoutStep sites (FG-527), gate.ts isFanoutParent, campaign terminal-outcome derivations, recover.ts, aggregation fold-in, and the run/step-state evaluator proper.

