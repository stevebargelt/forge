---
id: FG-363
type: story
status: active
title: "Dashboard Backlog Viewer: browse notes, epics, stories, and ideas from the project backlog"
epic: FG-291
created: 2026-06-22
---

## Problem

Humans should rarely need to run CLI commands directly, but backlog orientation today depends on `forge backlog notes show`, `forge backlog list`, and `forge backlog show`. The backlog is now the durable planning and handoff surface for Forge work, so it should be visible in the dashboard.

## Goal

Add a read-only dashboard Backlog view for the current project.

## MVP Scope

- Show backlog notes / session handoff.
- List active epics, stories, and ideas.
- Filter by type and status.
- Search title/body.
- Open ticket detail with frontmatter and markdown body.
- Show `epic` parent relationship when present.
- Use shared backlog parsing/read logic, not dashboard-only parsing.
- Support structured backlog format first.
- Handle absent backlog cleanly.

## Non-Goals

- No editing.
- No creating tickets.
- No closing/moving tickets.
- No run creation from tickets.
- No replacement for the CLI.
- No legacy BACKLOG.md support unless trivial through existing shared parser.

## Acceptance Criteria

- A human can open the dashboard and understand active backlog state without running a CLI command.
- Notes and active tickets render correctly.
- Ticket details preserve markdown formatting.
- The dashboard and CLI agree on listed tickets.
- Read-only view performs no filesystem writes.
