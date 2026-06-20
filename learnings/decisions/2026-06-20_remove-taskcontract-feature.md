# Decision: Remove the TaskContract feature (AWN-4 phase 1)

**ID**: FORGE-DEC-021
**Date**: 2026-06-20
**Status**: Decided
**Decided by**: Steven
**Supersedes**: N/A (reverses AWN-4 phase 1, ticket #217; closes FG-223 unbuilt)
**Scope**: forge

---

## Context

AWN-4 phase 1 (ticket #217) shipped an explicit task-contract primitive:

- A `TaskContract` schema in `src/v2/contract.ts`
- A `forge invoke --contract <file>` flag that reads a contract file and attaches it to the task
- Contract data carried into the task package and persisted to the run manifest under `manifest.contract`
- `forge show` rendering of the contract fields

AWN-4 phase 2 (ticket FG-223) was planned to extend this with contract-satisfaction recording (agents reporting which checks passed), workflow-YAML contract blocks, and orchestrator preference for tasks that declare contracts.

The design was motivated by the hypothesis that structured task contracts improve agent reliability — giving agents explicit acceptance criteria and giving reviewers objective pass/fail signals.

---

## Problem

The feature was built on a theory that was never validated:

- No workflow definition references a contract.
- No seed or orchestrator-template path passes `--contract`.
- No contract has ever been recorded in any manifest in production or in tests.
- The feature is reachable only by an operator explicitly passing `--contract <file>` to `forge invoke` — a path that nothing in the system calls.

Pre-launch, with zero users, the discipline is to remove unvalidated speculative surface rather than carry it forward. Every line of dead schema, dead CLI surface, and dead manifest field is a reader tax and a maintenance burden with no corresponding benefit.

---

## Decision

**Remove the TaskContract feature**: the `--contract` flag on `forge invoke`, the `TaskContract` schema, contract carry into the task package, and manifest storage and rendering.

Close FG-223 unbuilt. The phase-2 work (contract-satisfaction recording, workflow-YAML contracts, orchestrator contract preference) is not pursued.

---

## Rationale

- **Zero adoption.** Unlike the gate `request_changes` verb (which has live consumers in regeneration gates), no workflow, seed, or orchestrator path has ever passed a contract. A feature with no call sites is dead surface.
- **Theory never validated.** The premise — that explicit task contracts improve agent reliability — may be correct, but it was never tested in practice. Carrying dead code to preserve an untested theory inverts the right order: ship, observe, keep.
- **Pre-launch is the right moment.** With no external users, removing this now costs nothing. Post-launch, every removed flag is a breaking change and a migration.
- **The surface is narrow, so removal is clean.** The `--contract` flag appears in one CLI command; the schema is one file; the manifest field is one key. No downstream consumer reads `manifest.contract` for anything other than docs-impact inference (see important nuance below).

---

## Important Nuance: `src/v2/contract.ts` is Mixed

The module `src/v2/contract.ts` is **not** removed wholesale. It contains two separate concerns:

1. **TaskContract** — the feature being removed (`TaskContract` type, `--contract` flag handling, manifest storage). This half is deleted.

2. **Operator-surfaces / docs-impact helpers** — `OPERATOR_SURFACES`, `loadOperatorSurfaces`, `inferOperatorBehaviorChanged`, `operatorSurfacesTouched`, `docsImpactSuggestion`. These are actively used by the docs-impact lifecycle and are **retained**.

Additionally, `inferOperatorBehaviorChanged` previously read `manifest.contract.operator_behavior_changed` as one signal when inferring whether a change had operator-visible impact. That single signal is dropped (the contract field will no longer exist on manifests). The docs-impact logic retains all its other signals and remains functional.

---

## Consequences

**Positive**:
- Dead CLI surface removed: `forge invoke --contract` no longer exists.
- Dead schema removed: `TaskContract` type and its fields gone.
- Manifest `contract` key no longer written; manifests are leaner.
- `forge show` has one fewer rendering branch.
- FG-223 scope (contract-satisfaction recording, workflow YAML blocks, orchestrator preference) is retired — no follow-on work needed.

**Negative / Trade-offs**:
- If a future use case validates the task-contract hypothesis, the feature must be re-introduced. The design in `agentic-workflow-next-steps.md` (section 4, "Task Contract Schema") and the original #217 implementation serve as reference points.
- `inferOperatorBehaviorChanged` loses the `manifest.contract.operator_behavior_changed` signal. In practice this signal was never set (no contract was ever recorded), so behavior is unchanged.

---

## Revisit Conditions

- A concrete use case emerges where agents demonstrably perform better with explicit structured contracts than with well-written task prompts alone. At that point, re-introduce with evidence, and prefer a lightweight form (a YAML block in the workflow definition) over a separate file flag.
