---
id: FG-423
type: story
status: done
title: Campaign items must execute workflows, not hardcoded engineer invoke
epic: FG-370
created: 2026-06-30
closed: 2026-06-30
closed_commit: 3c64075
---

## Problem

Campaign Runner currently dispatches each campaign item as a single `engineer` invoke. In `src/campaign/executor.ts`, each item creates a run with `workflow: "invoke"` and dispatches `agentRole: "engineer"`.

That made the early campaign state machine tractable, but it means campaigns cannot use Forge's normal workflow engine per item. A campaign item does not automatically get architect, tech-lead, test-engineer, reds, authoritative Shipping Reviewer, or workflow gates. As a result, campaigns are only safe for simple mechanical tickets and are not yet suitable for the kind of ordered autonomous backlog execution the Campaign Runner is meant to support.

## Goal

Allow each campaign item to execute a configured Forge workflow, defaulting to the normal `feature` workflow for mutating backlog stories, while preserving campaign-level planning, approval, readiness, blocker, pause/resume, and reporting semantics.

The desired shape is:

```text
campaign item -> start configured workflow for ticket -> runNext/gates/reviewers -> done-audit -> campaign item outcome
```

## Acceptance Criteria

- Campaign plan/start records the workflow used for campaign item execution, defaulting to `feature` unless explicitly overridden.
- Starting a campaign item creates a normal workflow run for that ticket with the required ticket/project context in run metadata.
- Campaign execution drives or monitors that workflow through `runNext` until the campaign item reaches terminal success, block, hold, or failure.
- Architect, tech-lead, engineer, reds, test/review steps, and Shipping Reviewer behavior come from workflow YAML, not hardcoded campaign logic.
- Campaign item outcome is derived from the workflow run result plus done-audit evidence, not only a single `invoke` status.
- Existing campaign semantics are preserved:
  - plan approval and stale-plan protection;
  - readiness gate before dispatch;
  - blocker/continue policy;
  - cooperative pause/resume;
  - idempotent resume that skips terminal items;
  - truthful report output and done-audit gating.
- Operator report links campaign item -> workflow run -> tasks/gates/reviewer verdicts.
- A Shipping Reviewer `blocked_by_red` or required human gate in the workflow must pause/block the campaign item with an actionable next step.
- Tests prove a campaign item can run a multi-step workflow, not only `invoke`.
- Tests prove a workflow-level Shipping Reviewer block is reflected at the campaign item/report level.
- Preserve an explicit single-agent escape hatch for simple/mechanical items, but it must be opt-in and visible in the plan/report, not the default.

## Non-Goals

- Do not add parallel campaign lanes here.
- Do not redesign workflow YAML.
- Do not weaken Shipping Reviewer, done-audit, or gate aggregation semantics.
- Do not remove the existing single-agent invoke capability; make it an explicit campaign execution mode.
- Do not build dashboard UI here, though the data model/report should support FG-395.

## Sequencing

Run this after FG-421. Do not start serious multi-ticket campaign work such as FG-357/FG-376 campaigns until this is resolved, because those tickets need architect/planning/review workflow support.

## Relations

- Blocks serious use of Campaign Runner for non-trivial backlog work.
- Related to FG-370: Campaign Runner epic.
- Related to FG-420: authoritative Shipping Reviewer should run through workflow execution.
- Related to FG-421: Shipping Reviewer review quality should be strengthened before using it on this work.
- Related to FG-357 and FG-376: these should use workflow-backed campaign items, not engineer-only invokes.
- Related to FG-395: dashboard campaign view should surface workflow-backed campaign item runs.
