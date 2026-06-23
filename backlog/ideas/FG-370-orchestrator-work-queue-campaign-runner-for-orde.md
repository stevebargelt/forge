---
id: FG-370
type: idea
status: active
title: "Orchestrator Work Queue / Campaign Runner for ordered backlog execution"
created: 2026-06-22
---

## Problem

The human operator can identify a sensible sequence of Forge work, but today each backlog item still has to be dispatched and monitored one at a time. That keeps the human in the loop as a manual scheduler even when the desired behavior is straightforward: work through this ordered list, stop an item when it blocks, continue to the next safe item, and report back when human judgment is needed.

This will become more important as Forge gains stronger branch, PR, and worktree isolation. Once work can be isolated per backlog item, Forge should be able to execute a larger ordered program of work without requiring the human to issue every individual command.

## Naming

Final name is undecided.

Candidate names:
- Work Queue
- Campaign Runner
- Backlog Campaign
- Orchestrator Queue

The concept should stay simple enough for humans to understand: an ordered set of backlog items that Forge is responsible for advancing.

## Idea

Allow a human or orchestrator to give Forge an ordered list of backlog items, or an epic whose child stories expand into such a list. Forge creates a durable queue/campaign object and advances items according to an explicit execution plan.

The first step should not be immediate execution. Forge should return a plan:

- the proposed item order;
- whether it accepts the human-provided order or recommends a different one;
- which items must be sequential;
- which items are safe to parallelize;
- known dependencies or blockers;
- expected branch/worktree/merge strategy;
- whether each item should produce its own PR or participate in an aggregate merge.

After approval, Forge works the queue.

## Default Behavior

- Treat the provided order as strict priority order.
- The orchestrator may propose a different order, but must explain why before execution.
- Continue to the next eligible item when one item blocks.
- Do not continue into later items when the blocker affects them.
- Preserve blocked items with a clear reason and requested human action.
- Prefer one PR per backlog item by default, but keep aggregate PR behavior open for design.

## Inputs

Possible queue creation inputs:

- explicit ordered list: `FG-368 FG-363 FG-359 FG-367`;
- epic id: expand active child stories under the epic;
- mixed list: epic plus explicit additions/exclusions;
- manual notes or constraints supplied by the operator.

Epic expansion should be backlog-native, not a title/string convention. Forge should read the structured backlog relationships and show the expanded list before execution.

## Execution Model

This idea should wait until Forge has stronger git/worktree foundations.

Expected model after prerequisites:

- each queued backlog item gets an isolated branch/worktree;
- Forge records item -> run(s) -> task(s) -> branch -> worktree -> PR/merge state;
- parallel execution is allowed only when worktree isolation and merge strategy make it safe;
- conflicts are surfaced as explicit merge conflicts, not silent shared-checkout mutation;
- a merge/refinery-like process integrates completed queue items in a controlled order;
- dashboard/CLI state explains why an item is running, blocked, waiting for merge, or held behind another item.

## CLI And Dashboard Shape

CLI is acceptable, and may be the primary v1 surface, because the human will often ask an orchestrator agent to sequence the work.

Potential CLI shape:

```text
forge queue plan FG-368 FG-363 FG-359 FG-367
forge queue start <plan-id>
forge queue show <queue-id>
forge queue pause <queue-id>
forge queue resume <queue-id>
```

Dashboard support is still valuable but not required for the first implementation. A later dashboard view could show the queue as a board or timeline with item status, active runs, branches, worktrees, blockers, and PR state.

## Open Design Questions

- Final product name: Work Queue, Campaign Runner, Backlog Campaign, or something else.
- Should one queue item map to exactly one run, or can an item own multiple runs/review loops?
- Should PRs be one per backlog item by default, one per campaign, or configurable?
- How should Forge decide that a blocker affects later queued items?
- What minimum evidence is required before Forge marks two items safe to parallelize?
- How does the merge/refinery process batch, order, validate, and bisect completed queue items?
- Should queue planning be a new workflow type, a CLI/orchestrator primitive, or both?

## Dependencies / Sequencing

This should not be built before the isolation and visibility foundations are stronger.

Likely prerequisites:

- FG-367: Forge-managed project branch/commit/PR discipline.
- FG-345 and children: worktree isolation and merge semantics.
- Dashboard backlog visibility, so humans can inspect backlog state without CLI when desired.
- Dashboard or CLI visibility for branch/worktree/PR/merge state.

## Non-Goals For First Cut

- No magical autonomous reordering without a visible plan.
- No parallel execution without per-item isolation.
- No hidden merge queue.
- No assumption that every project has an upstream remote.
- No requirement that the first version be dashboard-first.
