---
id: FG-606
type: story
status: active
title: "FG-496 Slice A: DB ticket schema + idempotent Markdown import (non-authoritative shadow)"
created: 2026-07-24
---

## Slice A of FG-496 — the first, safest slice (zero authority change)

Create the DB ticket schema and an idempotent Markdown import that populates it as a **non-authoritative
shadow**. No reader consumes the DB in this slice; Markdown remains the sole source of truth. This de-risks
every later slice by proving the additive-migration + type-mapping + relations-preservation groundwork before
any cutover pressure exists.

## Scope

- Add `tickets`, `ticket_events`, `ticket_relations` tables to the store.
- `tickets` carries an explicit `type` field (`bug` / `story` / `epic` / `idea`, open vocabulary for future
  workflow-specific types) and status limited to `active` / `done` / `deferred` (NO `blocked` — see FG-496
  contract; legacy `blocked` maps to active + blocker evidence in Slice D).
- Add `forge backlog import`: reads `backlog/*.md` via the existing parser and populates the DB. Pre-cutover
  this UPSERTs freely (DB is a mirror of authoritative Markdown).
- Preserve id / type / status / title / body / created / closed / relations / frontmatter. Map current
  file-derived types from `TYPE_DIRS` (`story`/`epic`/`idea`); reserve `bug`.

## Files (grounded)

- `src/store/schema.ts` — append `CREATE TABLE IF NOT EXISTS` for the three tables (additive only).
- new store accessor module alongside `src/store/*.ts` (parallel to `runs.ts` / `tasks.ts`).
- `src/cli/commands/backlog.ts` — add the `import` subcommand.
- reuse `src/backlog/structured.ts` parse/`listTickets` to enumerate source files.
- new `src/store/fgXXX-tickets-migration.integration.test.ts` — mirror `fg523-verdicts-migration.integration.test.ts`.

## Acceptance Criteria

- After import, DB rows equal the Markdown set for id/type/status/title/body/created/closed/relations/frontmatter.
- Legacy file-derived types mapped; `bug` type reservable.
- Re-running import is **idempotent** (no duplicate rows) in the pre-cutover UPSERT phase.
- No consumer behavior changes — nothing reads the DB yet.
- Migration is **additive-only**: `CREATE TABLE IF NOT EXISTS` in `SCHEMA_SQL`; no `DROP`, no rename, and
  **no `PRAGMA user_version` bump** (would trip the FG-568 forward gate `assertSchemaVersionSupported` and
  refuse older concurrent host processes — see machine-wide blast-radius risk in FG-496).
- A `fgXXX-tickets-migration.integration.test.ts` proves an old-shape DB opens forward non-destructively.

## Dependencies / Relations

- Parent: FG-496 (owns the durable primitives + canonical queries).
- Epic: FG-593.
- Blocks: Slice B (DB-backed CRUD builds on this schema).

## Non-Goals

- No reader consumes the DB (that is Slice B/C). No queue fields (Slice D). No claims (Slice E). No UI, no
  dispatcher (FG-591). No Markdown export.
