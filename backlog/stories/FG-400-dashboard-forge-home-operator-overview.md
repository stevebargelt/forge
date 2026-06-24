---
id: FG-400
type: story
status: active
title: Dashboard Forge Home / Operator Overview
epic: FG-291
created: 2026-06-24
---

## Problem

Forge has many useful dashboard tabs, but the operator still lacks one first screen that answers "what needs my attention right now?" Without that overview, humans have to inspect runs, backlog, gates, logs, git state, and campaign state separately.

Claude Deck's dashboard overview validates the need for a local command-center surface, but Forge should implement it around Forge-native objects: projects, runs, tasks, gates, campaigns, backlog items, reviews, receipts, and unsafe state.

## Goal

Add a dashboard Forge Home / Operator Overview that summarizes current Forge health and attention needs across the active project or known projects.

## Acceptance Criteria

- Dashboard has a clear home/overview route.
- Overview shows active runs and their current lifecycle state.
- Overview shows blocked work, waiting gates, red/reviewer blocks, and human-action-needed items.
- Overview shows recent failures and recent completions with links to the relevant run/task/backlog item.
- Overview shows campaign status when Campaign Runner exists, or an explicit unavailable/deferred state before then.
- Overview shows project-level unsafe state when known, such as dirty git state, auth/setup problems, missing dependencies, or unavailable runtime/provider capability.
- Overview links to the more detailed surfaces rather than duplicating them: Run Map, backlog viewer, RACI/config views, campaign detail, and logs/artifacts.
- Empty state is useful for a new/quiet install.
- Tests cover the overview API/query shape and rendering for active, blocked, and empty states.

## Non-Goals

- Do not implement campaign execution here.
- Do not replace detailed run/task/backlog pages.
- Do not add config editing.
- Do not add Stream Deck integration.

## Notes

- Origin: Claude Deck competitive research visibility section.
- Related: FG-291, FG-348, FG-349, FG-363, FG-370, FG-395.
