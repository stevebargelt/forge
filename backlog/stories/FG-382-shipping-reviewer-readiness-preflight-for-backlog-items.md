---
id: FG-382
type: story
status: active
title: "Shipping Reviewer readiness preflight for backlog items"
epic: FG-372
created: 2026-06-23
---

## Problem

Forge can start implementation on backlog items that are not actually runnable: missing acceptance criteria, vague goals, contradictory scope, or latest operator instructions that never made it into the ticket. That burns tokens and produces work that later needs human correction.

## Goal

Before implementation starts, classify backlog readiness and pause when the item is not ready.

Readiness outcomes:

- `ready`
- `needs_refinement`
- `blocked`
- `exploratory`

## Acceptance Criteria

- Define the readiness preflight input contract.
- Check for clear problem, goal/expected behavior, acceptance criteria, scope limits, dependencies, and latest operator instruction reconciliation.
- Pause with `needs_refinement` when acceptance criteria are missing or too vague for closeout review.
- Allow `exploratory` for explicit research/spike/idea work with lighter criteria.
- Produce a concrete refinement proposal instead of starting implementation when not ready.
- Do not require humans to run CLI commands; the orchestrator output must surface the gap.
- Tests cover a runnable item, an item missing acceptance criteria, and an exploratory item.

## Non-Goals

- Do not enforce perfect acceptance criteria.
- Do not block pure advisory conversation.
- Do not implement the final done audit.

## Relations

- Child of FG-372.
- Complements FG-381.

