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
- Tickets have an explicit `type` field in the DB schema, not just a directory convention. Initial supported types include at least `bug`, `story`, `epic`, and `idea`, with room for future workflow-specific types.
- Existing markdown imports preserve the current file/frontmatter-derived type (`story`, `epic`, `idea`) and can map future bug files or imported external issues to `bug`.
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
- This story does not require GitHub Issues or Jira integration.

## Design Notes

Suggested model:

- `tickets`: id, type, status, title, body, priority/order fields, created_at, updated_at, closed_at, source/import metadata.
- `ticket_events`: append-only ticket lifecycle events for file/edit/close/import/migration.
- `ticket_relations`: blocks, related, parent/epic, discovered-from, supersedes, or similar relationships.

Important product decision already made: do not make markdown export a core requirement. The dashboard needs to show backlog items, but it should do that through Forge's DB/API.

## Relations

- FG-380: host-local operational state for handoff/orient/session notes.
- FG-474 / FG-495: verification speed work depends on durable backlog coordination for autonomous runs.
- FG-498: GitHub Issues ingestion into the DB-backed backlog.
- Gas City / Beads lesson: the active work item should be a durable store primitive, not whichever markdown file exists in the current worktree.

## Operator Queue Contract (binding acceptance extension, 2026-07-18)

FG-496 must establish the durable primitives for an operator-curated work queue. This is not a numeric severity scale and it is not another campaign-item status language.

### Orthogonal state model

- Ticket lifecycle remains distinct from planning and execution. `active` means open; `done` means closed; `deferred` means intentionally ineligible. The legacy `blocked` ticket status migrates to an active ticket plus durable blocker evidence.
- `priority_rank` is nullable and is a stack-rank across open tickets, not a 1–5/P0–P4 score. Unranked tickets remain valid backlog items.
- Queue membership is explicit and independent of rank. A queued ticket is an operator-selected subset of the backlog; the executable queue is queued tickets sorted by `priority_rank`.
- Use one canonical rank, not a separate backlog priority and queue position that can drift.
- `in_progress` is derived from live Forge run/campaign state. `blocked` is derived from readiness, dependency, campaign, or run evidence. Neither becomes a second mutable ticket status.
- A queued ticket that becomes blocked retains its rank. Resolving the blocker returns it to the same queue position. A done ticket leaves the active queue while its queue history remains auditable.

### Queue eligibility and readiness

- Enqueue requires an active ticket and a revision-bound readiness result of `ready`, or `exploratory` for explicitly exploratory work.
- Reuse FG-382 / `forge readiness`; do not invent an unrelated readiness vocabulary. Mechanical readiness checks problem/goal/expected behavior, acceptance criteria where applicable, scope, and dependencies.
- Readiness is stored against the ticket revision/body hash. Editing the ticket invalidates the assessment until it is checked again.
- Semantic refinement may be performed by a small bounded ticket-refiner/readiness agent, but the agent is not the authority that declares its own work ready. The deterministic readiness gate reruns after refinement.

### Required DB/API behavior

- Persist nullable stack rank, explicit queue membership, readiness outcome + assessed ticket revision, and append-only enqueue/dequeue/reorder/readiness events.
- Enqueue, dequeue, and reorder are atomic and safe under concurrent operators/controllers.
- Provide one canonical ordered-queue query for CLI, campaign planning, autonomous execution, and dashboard consumers.
- Persist atomic queue claims with owner, lease/heartbeat, claimed ticket revision, launch/run identity, and release/terminal outcome so a dispatcher can recover without duplicate execution.
- Support an atomic claim-next operation that scans canonical rank order, applies caller-supplied deterministic eligibility/compatibility constraints, and cannot exceed the configured active-run capacity under concurrent dispatchers.
- Persist enough scheduling evidence to distinguish blocked, readiness-ineligible, already claimed/in progress, and temporarily incompatible-with-active-runs without changing canonical rank.
- Migration preserves current active/done/deferred state and converts legacy blocked tickets to durable blocker evidence without silently making them executable.
- Tests cover ranked and unranked backlog items, explicit queue membership, reorder, readiness invalidation after edit, a blocked queued item retaining rank, temporary compatibility bypass without rank mutation, concurrent claim/capacity races, expired-lease recovery, and done removal from the active queue.

The interactive Kanban/dashboard and capacity-limited dispatcher are a dependent operator-surface story; FG-496 owns the source-of-truth primitives they consume. A campaign may read backlog tickets, but ordinary queue dispatch does not require a campaign snapshot.
