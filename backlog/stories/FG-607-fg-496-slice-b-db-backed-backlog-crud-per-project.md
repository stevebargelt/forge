---
id: FG-607
type: story
status: active
title: "FG-496 Slice B: DB-backed backlog CRUD + per-project storage mode (behind the structured.ts seam)"
created: 2026-07-24
---

## Slice B of FG-496 — DB-backed CRUD behind the seam (still default-markdown)

Reimplement the `src/backlog/structured.ts` function surface to operate on the DB when a project's storage
mode is `db`, keeping Markdown behavior for `markdown` mode. Because nearly every consumer imports
`readTicket` / `listTickets` / `ticketExists` / `writeTicket` / `closeTicket` / `retitle` / `move` /
`fillClosedCommit` from this **single seam**, one dual-mode implementation migrates them all at once. Default
mode stays `markdown` in this slice, so live behavior is unchanged until an operator opts a project into `db`.

## Scope

- Dual-mode dispatch behind the **unchanged** structured.ts signatures (every existing caller compiles/passes).
- Per-project storage mode in `.forge/config.yml`: values `markdown` | `db`. The mode is authoritative — NO
  silent read-through blending of DB + Markdown (that reintroduces split-truth).
- CLI `file` / `edit` / `close` / `show` / `list` work with **no `backlog/` dir present** in db mode.
- CLI surfaces the active storage mode on every invocation (operators can always tell which store they read).
- Filing / editing / closing no longer dirties project `git status` in db mode.

## Files (grounded)

- `src/backlog/structured.ts` — the seam; dual-mode behind unchanged signatures.
- `src/backlog/config.ts` — add the per-project storage-mode field.
- `src/cli/commands/backlog.ts` — mode banner; drop the `existsSync('backlog')` hard requirement (~line 196).
- `src/store/db.ts` — `BEGIN IMMEDIATE` / writeTxn for atomic DB writes (replaces the `withBacklogLock` fs lock).

## Acceptance Criteria

- **FG-495 shape:** create a ticket in db mode, then read it from a clean secondary worktree/checkout with NO
  Markdown file present — Forge still finds it via the DB.
- A project with no `backlog/` dir supports full CRUD (file/edit/close/show/list) in db mode.
- `git status` stays clean after file/edit/close in db mode.
- CLI clearly prints whether it read legacy Markdown or the DB.
- Every existing structured.ts caller (see FG-496 consumer inventory) compiles and passes unchanged.
- Additive schema only; no `user_version` bump.

## Dependencies / Relations

- Parent: FG-496. Epic: FG-593.
- Depends on: Slice A (FG-606, the schema).
- Blocks: Slice C (the cutover), Slice D (queue fields).

## Non-Goals

- Does NOT flip the default authority to the DB (that is Slice C). No queue primitives, claims, UI, or
  dispatcher. No Markdown export.

## Open decision (surface at planning)

- Ticket-ID allocation once Markdown is no longer authoritative: a per-prefix DB sequence is the proposed
  default; confirm before implementing (changes id semantics).
