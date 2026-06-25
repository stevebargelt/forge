---
id: FG-391
type: story
status: done
title: "Campaign planner: explicit lists, epic expansion, and proposed order"
epic: FG-370
created: 2026-06-24
closed: 2026-06-25
closed_commit: 933ded1
---

## Problem

Campaign execution should not start blindly. Forge needs to resolve the requested work, expand epics using structured backlog relationships, and show an execution plan before mutating anything.

## Goal

Implement a campaign planner that accepts explicit ticket lists and epic ids, then produces a durable plan.

## Acceptance Criteria

- Accept explicit ordered ticket ids.
- Accept an epic id and expand active child stories through structured backlog metadata.
- When expanding an epic, use explicit ordering metadata from the epic if present; otherwise fall back to created date when available, then ticket id for deterministic order.
- Support mixed input with explicit additions and exclusions if feasible; otherwise document as deferred.
- Preserve operator-provided priority order unless the planner recommends a different order with a reason.
- Mark items with planner recommendations such as sequential, held, needs refinement, or later-parallel-candidate without mutating their execution status.
- Record proposed campaign mode: `dry_run`, `pilot`, `sequential`, or future `parallel`.
- Include readiness-preflight status when FG-382 is available, or an explicit unavailable/pilot note if not.
- Produce a plan that can be inspected before execution.
- Produce canonical plan content and a stable `plan_hash` from that content.
- Include source input, resolved item ids, proposed order, mode, dependency/hold decisions, readiness/gate availability, branch/PR strategy, and material planner assumptions in the hash input.
- Equivalent plans produce the same `plan_hash`; meaningful changes produce a different `plan_hash`.
- Record whether advisory agents were used during planning, and summarize their recommendation if they were.
- Do not start execution from `plan`; execution must require an explicit approval/start transition.
- Tests cover explicit list planning, epic expansion, missing ticket, empty epic, order preservation, stable hash for equivalent plans, and changed hash when order/scope/mode changes.

## Non-Goals

- Do not execute the campaign.
- Do not infer deep code dependencies from touched files yet.
- Do not parallelize.
