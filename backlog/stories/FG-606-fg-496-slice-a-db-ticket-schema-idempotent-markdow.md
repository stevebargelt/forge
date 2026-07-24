---
id: FG-606
type: story
status: active
title: "FG-496 Slice A: DB ticket schema + idempotent Markdown import (non-authoritative shadow)"
created: 2026-07-24
---

## Slice A of FG-496 — the first, safest slice (zero authority change)

Create the DB ticket schema and an idempotent Markdown import that populates it as a **non-authoritative
shadow**. No reader consumes the DB in this slice; Markdown remains the sole source of truth. This is the
schema-foundation slice, so **every schema decision the epic depends on is fixed here** — project identity,
keying, host-side storage mode, id allocation, and the minimal blocker-evidence representation.

## Stable cross-worktree project identity (load-bearing — decide here, before any ticket rows exist)

The shared host DB (`~/.forge/forge.db`) holds tickets for 10–20 projects at once. Ticket rows CANNOT be keyed
by ticket id alone: `FG-123` and `MG-123` coexist, and two projects can even share the same prefix (FG-446/447
are exactly the prefix-collision problem). They ALSO cannot be keyed by canonical `projectDir`: linked
worktrees resolve to different real paths, which would defeat FG-496's central cross-worktree requirement.

- Introduce a durable **`project_key`** stored in `.forge/config.yml` — committed, so it is shared across every
  clone and linked worktree of a project.
- Key `tickets` and all ticket foreign keys by **`(project_key, ticket_id)`**.
- Store each project's **backlog storage mode in the DB, keyed by `project_key`** — NOT in each worktree's
  config — so two worktrees can never disagree about which store is authoritative.
- **ID allocation:** a transactional sequence per **`(project_key, prefix)`** allocates the next ticket id once
  Markdown is no longer authoritative (behavior lands in Slice B; the sequence table is defined here).

## Scope

- Add `tickets`, `ticket_events`, `ticket_relations` tables, all keyed by `(project_key, ticket_id)`.
- Add the host-side **storage-mode** record keyed by `project_key` (default `markdown`) and the
  **id-allocation sequence** table per `(project_key, prefix)`.
- Add a **minimal durable `blocker_evidence` table** (see below) — introduced HERE, not Slice D.
- `tickets` carries an explicit `type` field (`bug` / `story` / `epic` / `idea`, open vocabulary) and status
  limited to `active` / `done` / `deferred` (NO `blocked` — see the blocked-evidence rule below).
- Add `forge backlog import`: reads a project's `backlog/*.md` via the existing parser and populates the DB as
  a shadow. Pre-cutover this UPSERTs freely (DB mirrors authoritative Markdown).
- Preserve id / type / status / title / body / created / closed / relations / frontmatter. Map current
  file-derived types from `TYPE_DIRS` (`story`/`epic`/`idea`); reserve `bug`.
- `.forge/config.yml` gains the `project_key` field (generate one on import if absent).

## Legacy blocked evidence must survive the cutover (decide here, not Slice D)

The Slice C cutover happens BEFORE Slice D. If legacy `blocked` tickets only became active/done/deferred at
import and blocker evidence waited for Slice D, there would be a window where formerly-blocked tickets are
plain `active` tickets with **no blocker evidence** — silent state loss. Therefore:

- Define the **minimal** durable `blocker_evidence` representation in THIS slice (id/`(project_key, ticket_id)`,
  a short reason/source, created_at — enough to preserve the fact and its origin).
- Import maps a legacy `status: blocked` ticket to **`active` + a `blocker_evidence` row**, never to a plain
  active ticket.
- Slice D ENRICHES this table (readiness binding, queue projections, richer evidence kinds); it does not
  introduce it.

## Files (grounded)

- `src/store/schema.ts` — append `CREATE TABLE IF NOT EXISTS` for tickets / ticket_events / ticket_relations /
  blocker_evidence / storage-mode / id-sequence (additive only).
- new store accessor module alongside `src/store/*.ts` (parallel to `runs.ts` / `tasks.ts`).
- `src/backlog/config.ts` — add the `project_key` field to `.forge/config.yml`.
- `src/cli/commands/backlog.ts` — add the `import` subcommand.
- reuse `src/backlog/structured.ts` parse/`listTickets` to enumerate source files.
- new `src/store/fgXXX-tickets-migration.integration.test.ts` — mirror `fg523-verdicts-migration.integration.test.ts`.

## Acceptance Criteria

- All ticket tables are keyed by `(project_key, ticket_id)`; a test proves `FG-123` in project A and `FG-123`
  in project B (same prefix, different `project_key`) coexist without collision.
- `project_key` is read from `.forge/config.yml` and is stable across two linked worktrees of the same project
  (same key from different real paths).
- Storage mode is stored in the DB under `project_key` (default `markdown`); no per-worktree config holds it.
- After import, DB rows equal the Markdown set for id/type/status/title/body/created/closed/relations/frontmatter.
- A legacy `status: blocked` ticket imports as `active` + a `blocker_evidence` row (never plain active).
- Legacy file-derived types mapped; `bug` type reservable.
- Re-running import is **idempotent** (no duplicate rows) in the pre-cutover UPSERT phase.
- No consumer behavior changes — nothing reads the DB yet.
- Migration is **additive-only**: `CREATE TABLE IF NOT EXISTS` in `SCHEMA_SQL`; no `DROP`, no rename, and
  **no `PRAGMA user_version` bump** (would trip the FG-568 forward gate `assertSchemaVersionSupported`).
- A `fgXXX-tickets-migration.integration.test.ts` proves an old-shape DB opens forward non-destructively.

## Dependencies / Relations

- Parent: FG-496. Epic: FG-593.
- Blocks: Slice B (DB-backed CRUD builds on this schema + project identity + id-allocation sequence).

## Non-Goals

- No reader consumes the DB (that is Slice B/C). No queue rank/membership/readiness (Slice D beyond the minimal
  blocker table). No claims (Slice E). No UI, no dispatcher (FG-591). No Markdown export.
