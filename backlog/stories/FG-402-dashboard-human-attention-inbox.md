---
id: FG-402
type: story
status: active
title: Dashboard Human Attention Inbox
epic: FG-291
created: 2026-06-24
---

## Problem

Forge can block on gates, reds, reviewer findings, missing acceptance criteria, auth problems, merge conflicts, campaign pauses, and setup issues. These are human-attention events, but today they are spread across logs, task status, backlog notes, and CLI output.

Claude Deck's Agent Mail validates the value of a visible inbox, but Forge should not start by building general agent chat. It should first expose Forge-native attention items.

## Goal

Add a dashboard Human Attention Inbox that lists actionable items requiring operator judgment or intervention.

## Acceptance Criteria

- Inbox aggregates current human-action-needed items from Forge state.
- Initial item types include waiting gate, blocked by red/reviewer, missing acceptance criteria/readiness failure, merge conflict, auth/setup problem, campaign paused/blocked, and context/operator question when available.
- Each item shows source object, severity/priority when known, age, reason, requested action, and links to the relevant run/task/backlog/campaign/config surface.
- Items distinguish active/open from resolved/stale when Forge has enough information.
- Inbox does not invent chat semantics; it renders existing Forge state and typed attention records.
- Empty state explains that no human action is currently needed.
- JSON/API output is stable enough for dashboard and future operator-surface addons such as Stream Deck.
- Tests cover aggregation and rendering for at least gate wait, reviewer/red block, missing acceptance criteria, and auth/setup problem.

## Non-Goals

- Do not build general agent-to-agent mail.
- Do not implement arbitrary chat threads.
- Do not send notifications/SMS here.
- Do not implement Stream Deck integration.

## Notes

- Origin: Claude Deck competitive research visibility and Agent Mail sections.
- Related: FG-291, FG-372, FG-381, FG-384, FG-386, FG-393, FG-395, FG-387.
