---
id: FG-496
type: story
status: active
title: "DB-backed active backlog: stop using git-tracked markdown files as the live work-queue source of truth"
created: 2026-07-07
---

## Problem

Forge's active backlog is currently represented as git-tracked markdown files under `backlog/`. That has become unreliable as Forge now runs campaigns, review-loops, detached agents, and isolated worktrees:

- A new ticket can exist only as an untracked local file, so another Forge worktree or clean checkout says the ticket does not exist.
- Review-loop tree restore, stash/reset flows, or branch switches can discard or hide backlog intent.
- Filing/editing/closing backlog items dirties the project repository even when the change is operational coordination, not product code.
- Campaigns and autonomous runs depend on whichever checkout's `backlog/` files they happen to see.
- Handoff/orient can report stale or incomplete backlog state because the live queue is split across git files, local dirtiness, and pushed state.

Recent concrete example: FG-495 was visible in the current working tree but untracked. `forge backlog show FG-495` worked locally, while another Forge run/worktree correctly reported that FG-495 did not exist until the file was committed and pushed.

Git-tracked markdown is useful for migration, audit, or optional human-readable snapshots, but it is a poor live coordination store.

## Goal

Move Forge's active backlog/work queue to Forge DB-backed storage. The DB becomes the source of truth for backlog CRUD, campaign planning, review-loop ticket lookup, autonomous runs, and dashboard backlog views. Markdown backlog files become legacy/import compatibility only, not the required runtime representation.

## Acceptance Criteria

- `forge backlog file`, `edit`, `close`, `show`, and `list` operate on DB-backed tickets, not on `backlog/*.md` files as the source of truth.
- Backlog CRUD works in a project with no `backlog/` directory present.
- Existing repo-backed markdown backlog files can be imported/migrated into the DB with at least id, type, status, title, body, created date, closed date, relations, and relevant frontmatter preserved where present.
- Campaign planning reads ticket definitions from the DB-backed backlog.
- Review-loop and shipping-reviewer ticket lookup read from the DB-backed backlog.
- Autonomous runs and handoff/orient read the same DB-backed backlog state across Forge worktrees.
- Dashboard backlog views read from Forge's DB/API, not by scanning markdown files.
- Filing, editing, or closing a backlog item no longer dirties project `git status` by default.
- The CLI surfaces the active backlog storage mode clearly during migration, so operators can tell whether they are still reading legacy markdown or the DB store.
- Migration is idempotent: re-running import does not duplicate tickets or lose newer DB edits without an explicit conflict decision.
- Tests cover the FG-495 shape: create a ticket, then read it from a clean secondary worktree/checkout where no markdown file exists; Forge still finds it through the DB-backed store.
- Tests cover a project with no `backlog/` directory: backlog CRUD, campaign planning, and dashboard/API listing still work.

## Non-Goals

- Markdown export is not required for the first cut. If human-readable snapshots are wanted later, make export an explicit optional command.
- This story does not solve multi-machine remote synchronization beyond the existing Forge DB/host model. It must make same-host multi-worktree behavior reliable first.
- This story does not move operational handoff/orient/session notes; FG-380 owns host-local operational state. This story owns active backlog/work-queue source of truth.
- This story does not require GitHub Issues/Jira integration.

## Design Notes

Suggested model:

- `tickets`: id, type, status, title, body, priority/order fields, created_at, updated_at, closed_at, source/import metadata.
- `ticket_events`: append-only ticket lifecycle events for file/edit/close/import/migration.
- `ticket_relations`: blocks, related, parent/epic, discovered-from, supersedes, or similar relationships.

Important product decision already made: do not make markdown export a core requirement. The dashboard needs to show backlog items, but it should do that through Forge's DB/API.

## Relations

- FG-380: host-local operational state for handoff/orient/session notes.
- FG-474 / FG-495: verification speed work depends on durable backlog coordination for autonomous runs.
- Gas City / Beads lesson: the active work item should be a durable store primitive, not whichever markdown file exists in the current worktree.

