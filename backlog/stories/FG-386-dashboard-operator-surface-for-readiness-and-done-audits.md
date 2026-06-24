---
id: FG-386
type: story
status: active
title: "Dashboard/operator surface for readiness and done audits"
epic: FG-372
created: 2026-06-23
---

## Problem

The operator goal is that humans rarely run CLI commands. If readiness or done-audit checks fail, the information gap should be visible in Forge output and eventually the dashboard, not buried in local logs or implied by command-line rituals.

## Goal

Design the dashboard/operator surface for Shipping Reviewer readiness and done-audit results.

## Acceptance Criteria

- Define the minimum data model for readiness status, done-audit status, blocking checks, and reviewer outcome.
- Dashboard can show whether a backlog item/run is `ready`, `needs_refinement`, `blocked`, or `exploratory`.
- Dashboard can show final done-audit outcome: `ship`, `ship_with_named_deferrals`, `needs_fix`, or `needs_human`.
- Dashboard can show failed checks with actionable messages and links to relevant tasks/commits/backlog items.
- Dashboard can distinguish mechanical failures from LLM reviewer findings.
- Dashboard can show accepted deferrals and linked follow-up tickets.
- CLI/orchestrator output remains sufficient before the dashboard work lands.
- Tests cover rendering or query behavior for at least one readiness failure and one done-audit blocker.

## Non-Goals

- Do not require humans to edit readiness state manually in the first cut.
- Do not build a full backlog editor here.
- Do not replace `forge show` or CLI output.

## Relations

- Child of FG-372.
- Related to FG-291 dashboard baseline work and FG-363 dashboard backlog viewer.

