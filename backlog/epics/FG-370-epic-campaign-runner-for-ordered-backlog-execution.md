---
id: FG-370
type: epic
status: active
title: "[EPIC] Campaign Runner for ordered backlog execution"
created: 2026-06-22
---

## Problem

The human operator can identify a sensible sequence of Forge work, but today each backlog item still has to be dispatched and monitored one at a time. That keeps the human in the loop as a manual scheduler even when the desired behavior is straightforward: work through this ordered list, stop an item when it blocks, continue to the next safe item, and report back when human judgment is needed.

Forge should be able to accept an ordered list of backlog items, or an epic whose child stories expand into a list, and advance that program of work without the human issuing every individual command.

The risk is not the loop itself. The risk is automating weak planning, weak dependency handling, and weak closeout. A campaign runner must make work more reliable, not merely make incomplete work happen faster.

## Goal

Build a durable **Campaign Runner** that can plan, execute, monitor, and summarize an ordered backlog program.

The first polished version should let an operator say, effectively:

> Work these items, or this epic, in a sensible order. Pause or skip blocked items, continue where safe, and give me a truthful campaign report.

## Naming

Working product name: **Campaign Runner**.

Acceptable aliases in CLI/docs while naming settles:

- Work Queue
- Backlog Campaign
- Orchestrator Queue

The human-facing concept should stay simple: an ordered set of backlog items Forge is responsible for advancing.

## Core Behavior

- Accept explicit ordered ticket ids, such as `FG-389 FG-382 FG-383`.
- Accept an epic id and expand its active child stories from structured backlog relationships.
- Produce a plan before execution.
- Keep planning/approval/execution as separate durable states.
- Give every executable plan a stable `plan_hash` derived from canonical plan content.
- Treat the operator-provided order as strict priority unless the planner recommends a different order and explains why.
- Run sequentially by default.
- Continue to the next eligible item when one item blocks.
- Do not continue into later items when the blocker affects them.
- Preserve blocked items with a clear reason and requested human action.
- Record durable campaign state so a restart can resume or explain what happened.
- Produce a Campaign Report with shipped, blocked, skipped, failed, and waiting items.
- Reuse Forge's existing run/task lifecycle vocabulary for campaign-item status where practical; do not create a second item-level status language unless FG-390 proves it is necessary.
- Store campaign-specific interpretation beside status as `outcome`, `blocker_kind`, `continue_policy`, reason, and requested human action.

## Planner Output

The first step should be planning, not immediate execution. The plan should include:

- resolved item list;
- proposed execution order;
- whether the provided order was accepted or a different order is recommended;
- dependency notes;
- items that must be sequential;
- items that may be parallel-safe later;
- readiness status for each item;
- expected branch/worktree/merge strategy;
- whether each item should produce its own PR or participate in an aggregate merge;
- risks that should trigger Shipping Reviewer or targeted reds.
- canonical plan content used to compute `plan_hash`.

The `plan_hash` is the approval boundary. Forge must compute it from a deterministic representation of the resolved plan, including source input, resolved item ids, order, mode, dependency/hold decisions, readiness/gate availability, branch/PR strategy, and material planner assumptions. Equivalent plans should produce the same hash; meaningful changes should produce a different hash.

The campaign planner may invoke advisory agents when the input list is complex, high-risk, or ambiguous. That does not make approval an agent decision. The approval boundary is a Forge/orchestrator control-plane transition recorded in campaign state.

Minimum approval record:

- approved status transition from `planned` to `running`;
- approved by: human operator, orchestrator acting under explicit delegation, or test fixture;
- approved at timestamp;
- approval rationale or original operator instruction;
- exact `plan_hash` approved.

If a human says "work this list overnight," the orchestrator may treat that as delegated approval only after it has produced and recorded the concrete plan it will execute. Any later reorder, scope change, mode change, resolved-item change, or material assumption change must produce a new `plan_hash` and require a new approval record.

## Execution Model

Initial execution should be conservative:

- sequential only;
- one active campaign item at a time;
- one primary Forge run per item unless request-changes/retry requires another run;
- no parallel lanes until the dependency and merge machinery is proven;
- no hidden merge queue;
- no automatic reordering after approval without recording the reason.

Later execution can add parallel lanes when worktree isolation, branch/PR discipline, dependency parity, and integration gates are strong enough.

Campaign modes should be explicit:

- `dry_run`: plan and report only; no item execution.
- `pilot`: conservative execution with extra warnings where quality gates are incomplete.
- `sequential`: one approved item at a time; first production-worthy mode.
- `parallel`: future mode only, after worktree/refinery/dependency gates are strong enough.

## Durable State

Campaign state should live in Forge host-local state, not in project git-tracked backlog notes.

Minimum durable model:

- campaign id;
- source input: explicit list, epic id, or mixed input;
- status: planned, running, paused, complete, failed, abandoned;
- operator goal / constraints;
- approval metadata: approved by, approved at, rationale/input, and approved `plan_hash`;
- created/started/completed timestamps;
- item rows with ticket id, order, status, current run id, branch/worktree/PR fields when known, outcome, blocker reason, and human action requested.

State must survive process restart and support reconcile/show.

Campaign item `status` should align with existing Forge lifecycle states as much as possible, such as `pending`, `running`, `awaiting_gate`, `blocked_by_red`, `complete`, `failed`, and `abandoned`. Campaign meaning should be captured in adjacent fields:

- `outcome`: `shipped`, `blocked`, `skipped`, `held`, `needs_refinement`, or `failed`;
- `blocker_kind`: `scope`, `readiness`, `tests`, `merge_conflict`, `auth`, `dependency`, `git_state`, `infrastructure`, `campaign_system`, or `human_decision`;
- `continue_policy`: `continue_allowed`, `hold_dependents`, or `hold_campaign`;
- `reason` and `human_action_requested`.

## Quality Gates

The campaign runner depends on truthful per-item gates:

- Readiness preflight before starting each item.
- Done audit before marking an item shipped.
- Shipping Reviewer acceptance review before final shipped/done claims.
- Required host verification for mutating code work.
- Clean git/commit/push/PR discipline according to project policy.

The campaign runner should not bypass these gates. If the gate is unavailable, the campaign must say so and either pause or run in explicit pilot mode.

## CLI And Dashboard Shape

CLI is acceptable for the first version because the human will often ask an orchestrator agent to sequence the work.

Potential CLI shape:

```text
forge campaign plan FG-389 FG-382 FG-383
forge campaign plan --epic FG-372
forge campaign start <plan-id>
forge campaign show <campaign-id>
forge campaign pause <campaign-id>
forge campaign resume <campaign-id>
forge campaign abandon <campaign-id>
```

Dashboard support is required for the polished version, because humans should not need to run CLI commands to understand overnight work.

Dashboard should eventually show:

- campaign progress;
- current item;
- blocked/skipped/shipped items;
- run/task links;
- branch/worktree/PR state;
- readiness and done-audit state;
- campaign report checkpoints and final campaign report.

## Campaign Report Contract

A campaign report is the generic summary for a finished, paused, or checkpointed campaign. It is not specifically a "morning" or "overnight" report.

Minimum report fields:

- campaign id, source input, goal, and execution mode;
- campaign status and whether Forge believes it is safe to continue;
- item table with ticket id, title, status, run id, branch/PR/commit when known, verification state, done-audit state, and reviewer result;
- item outcome, blocker kind, continue policy, reason, and requested human action when applicable;
- shipped items;
- blocked items with requested human action;
- held items and why they were not started;
- skipped items and why they were skipped;
- failed items and failure kind;
- dirty git state or uncommitted intended changes, if any;
- deferred scope and linked follow-up tickets;
- next recommended operator action.

The report should distinguish "campaign complete because all items shipped" from "campaign complete with blocked/skipped/held items reported truthfully." JSON output must preserve that distinction for dashboard and orchestrator consumption.

## Dependencies / Sequencing

Strongly preferred prerequisites before trusting unattended overnight work:

- FG-389: remove legacy `BACKLOG.md` support so campaign planning has one backlog model.
- FG-382: readiness preflight for backlog items.
- FG-383: done-audit mechanical closeout checks.
- FG-367: branch/commit/PR discipline for Forge-managed projects.
- FG-376: agent worktree dependency parity, so reviewers and test engineers can run real tests.
- FG-357: post-merge integration gate for merged worktree output.

Sequential pilot work can start before every prerequisite is perfect, but it must label itself as pilot mode and keep scope conservative.

## Open Design Questions

- Should campaign planning be a workflow, a CLI/orchestrator primitive, or both?
- What exact approval modes are allowed: explicit human approval only, delegated orchestrator approval, or both?
- Should one campaign item map to exactly one run, or can an item own multiple runs/review loops?
- Should PRs default to one per backlog item, one per campaign, or project-configurable?
- What minimum evidence is required before Forge marks two items safe to parallelize?
- How should Forge decide that a blocker affects later queued items?
- How should merge/refinery behavior batch, order, validate, and bisect completed queue items?
- How should campaigns interact with future dashboard approvals and operator notifications?

## Non-Goals For First Cut

- No parallel execution.
- No magical autonomous reordering without a visible plan.
- No hidden merge queue.
- No assumption that every project has an upstream remote.
- No dashboard-first requirement for the MVP.
- No automatic conflict resolution beyond existing worktree/merge semantics.

## Child Story Split

- **FG-390 — Campaign Data Model:** durable campaign and campaign-item state.
- **FG-391 — Campaign Planner:** explicit lists, epic expansion, order proposal, dependency/readiness notes.
- **FG-392 — Sequential Campaign MVP:** execute approved campaigns one item at a time.
- **FG-393 — Blocker And Continue Semantics:** pause/skip/continue rules and durable blocker records.
- **FG-394 — Campaign CLI Status And Summary:** show/pause/resume/abandon and final report.
- **FG-395 — Dashboard Campaign View:** operator-visible progress, blockers, runs, branches, and audit state.
- **FG-396 — Parallel Campaign Lanes:** later worktree-backed parallelism and merge/refinery behavior.

## Acceptance Criteria

Epic-level design acceptance:

- Define the campaign state model and lifecycle.
- Define planner inputs and outputs for explicit lists and epic expansion.
- Define conservative sequential execution semantics.
- Define blocker handling and when the campaign may continue.
- Define how readiness preflight, done audit, Shipping Reviewer, and targeted reds fit into campaign execution.
- Define CLI and dashboard surfaces.
- Define what is explicitly deferred to parallel-lane work.
- Include examples for explicit list campaigns and epic-expanded campaigns.
- Include examples where one item blocks but later independent items continue.
- Include examples where a blocker prevents later dependent items from running.
- Define the Campaign Report contract for checkpoint and final summaries.
