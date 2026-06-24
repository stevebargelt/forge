---
id: FG-395
type: story
status: active
title: "Dashboard Campaign View: overnight work progress and blockers"
epic: FG-370
created: 2026-06-24
---

## Problem

A polished campaign runner needs a dashboard surface. Humans should not need to run CLI commands in the morning to understand what Forge did overnight.

## Goal

Expose campaign state in the dashboard.

## Acceptance Criteria

- Add an API endpoint for campaigns and campaign detail.
- Show campaign progress, current item, blocked items, shipped items, skipped items, and completed items.
- Link campaign items to runs/tasks and backlog tickets.
- Surface blocker reasons and requested human actions.
- Surface readiness, done-audit, Shipping Reviewer, and verification state when available.
- Surface Campaign Report checkpoints and the final Campaign Report.
- Empty/loading/error states are handled.
- Tests cover API shape and at least one dashboard rendering path.

## Non-Goals

- Do not add dashboard editing/reordering in the first version.
- Do not add Stream Deck integration here.
- Do not implement parallel lanes.
