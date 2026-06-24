---
id: FG-394
type: story
status: active
title: "Campaign CLI: status, campaign report, pause, resume, and abandon"
epic: FG-370
created: 2026-06-24
---

## Problem

Until the dashboard campaign view exists, humans and orchestrator agents need a clear CLI surface to inspect, control, and report on campaigns.

## Goal

Add the first campaign CLI surface.

## Acceptance Criteria

- Provide commands for plan, start, show, pause, resume, and abandon.
- `show` reports campaign status, item lifecycle status, outcome, active run, blockers, shipped items, skipped items, and next action.
- Add a `report` or equivalent output mode for checkpoint and final Campaign Reports.
- Campaign Report includes shipped/blocked/held/skipped/failed items, commits or PRs when known, verification state, done-audit state, reviewer result, dirty git state when known, and human actions needed.
- CLI output has a JSON mode suitable for dashboard and orchestrator consumption.
- JSON report output includes campaign id, source input, goal, mode, campaign status, approved `plan_hash`, current `plan_hash` when known, safety-to-continue, item rows, shipped/blocked/held/skipped/failed groupings, dirty git state, deferred scope, follow-up tickets, and next recommended operator action.
- Item rows include ticket id, title, lifecycle status, outcome, blocker kind, continue policy, run id, branch/worktree/PR/commit when known, verification state, done-audit state, reviewer result, reason, and requested human action.
- Report output distinguishes all-items-shipped from complete-with-blocked-or-skipped-items.
- Commands do not write project-tracked files just to show status.
- Tests cover human output, JSON output, and final/checkpoint Campaign Report shape.

## Non-Goals

- Do not build the dashboard here.
- Do not implement parallel lanes.
