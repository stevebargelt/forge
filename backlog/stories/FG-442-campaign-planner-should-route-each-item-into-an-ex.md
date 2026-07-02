---
id: FG-442
type: story
status: active
title: Campaign planner should route each item into an execution lane instead of defaulting to full feature
created: 2026-07-02
---

## Problem

Campaign Runner currently treats campaign items as either the default full `feature` workflow or an explicit low-level `invoke` escape hatch. That is too coarse. Running every campaign item through the full architect -> tech-lead -> engineer -> test-engineer -> docs/review pipeline makes campaigns too expensive for small fixes, docs updates, test-only work, review passes, research, and mechanical backlog cleanup.

FG-423 correctly moved campaign items away from a hardcoded engineer invoke and into workflow-backed execution, but it overshoots as a default model: full feature is now the normal lane for mutating stories, rather than one lane selected by routing/sizing.

## Goal

Make campaign planning dispatch each item through Forge's normal routing/sizing layer. A campaign plan should classify each item, propose an execution lane with rationale, include that lane in the approved plan hash, and execute each item according to the lane. Full feature remains available, but it is one lane, not the silent default for every item.

Candidate lanes:

- `full_feature`: architect -> tech-lead -> engineer -> test-engineer -> docs/review gates.
- `quick_implementation`: engineer -> test-engineer, with docs-impact resolution.
- `docs_only`: documentation-maintainer.
- `test_only`: test-engineer.
- `review_only`: read-only reviewer/red agent.
- `research_only`: research-specialist, no implementation gates.
- `ticketing_only`: backlog/routing update, no implementation pipeline.
- `manual`: explicit human-handled item.

The exact lane names can change if implementation finds better names, but the planner must represent the distinction explicitly.

## Desired Campaign Flow

1. Expand the requested ticket set.
2. Classify each item through Forge's routing/sizing policy.
3. Propose the execution lane per item with a short rationale.
4. Get human approval of the whole campaign plan.
5. Dispatch each item using its approved lane.
6. Pause or escalate if an item outgrows its lane.

## Safety Rule

Allow automatic escalation, not silent downgrade.

If a `quick_implementation`, `docs_only`, `test_only`, or other narrow-lane item reveals architecture uncertainty, broad blast radius, schema/API contract changes, unclear acceptance criteria, trust-boundary risk, or other full-feature signals, the campaign must pause and request approval to re-plan that item as `full_feature` or another stronger lane.

The campaign must never silently downgrade an approved item from `full_feature` to a cheaper lane after approval. Any material lane change changes the plan hash and requires a new approval record.

## Acceptance Criteria

- Campaign planning shows each item's proposed execution lane and why it was chosen.
- Campaign planning uses Forge's routing/sizing policy rather than a hardcoded "everything is full feature" rule.
- The approved campaign `plan_hash` includes item order plus execution lane and material lane assumptions, so a campaign cannot silently change from quick to full or full to quick after approval.
- Campaign execution dispatches by lane:
  - `full_feature` uses the normal feature workflow.
  - `quick_implementation` uses an engineer + test-engineer invoke chain, with docs-impact resolution.
  - `docs_only`, `test_only`, `research_only`, and `review_only` items use the appropriate single-purpose agent/workflow invocation.
  - `ticketing_only` items do not start an implementation pipeline.
  - `manual` items are recorded as requiring explicit human handling and do not dispatch an agent pipeline.
- If an item exceeds its approved lane, the campaign pauses with a clear `needs_refinement` or `scope` blocker and asks for human approval to escalate/re-plan that item.
- The campaign report includes lane, lane rationale, outcome, blockers, human decisions, escalations, and any lane changes per item.
- Existing `workflow` / `invoke` execution-mode support is either evolved into lanes or mapped cleanly under the lane model; the old escape hatch must remain visible in plan/report if still used.
- Tests cover at least: full-feature item, quick implementation item, docs-only item, ticketing-only item, and an item that escalates from quick to full rather than silently continuing in the wrong lane.

## Non-Goals

- Does not add parallel campaign execution.
- Does not weaken readiness, done-audit, Shipping Reviewer, or host-verification gates for lanes that require them.
- Does not remove full feature; it makes full feature explicit and policy-selected.
- Does not silently auto-approve lane changes after campaign approval.

## Relations

- Child/follow-up of FG-370 Campaign Runner.
- Refines FG-423: campaign items execute workflows/configured lanes, not a one-size-fits-all full feature workflow.
- Related to FG-429 and FG-439: orchestrator/campaign should resolve policy-derived routing decisions instead of asking the operator for routine process choices.
- Related to FG-422: workflow skills may provide operator-facing affordances for campaign lanes.
- Related to FG-433: lane-aware runs should still carry ticket/campaign metadata for reviewers.