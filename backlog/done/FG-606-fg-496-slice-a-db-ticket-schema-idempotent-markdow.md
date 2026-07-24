---
id: FG-606
type: story
status: done
title: "FG-496 Slice A: DB ticket schema + idempotent Markdown import (non-authoritative shadow)"
created: 2026-07-24
closed: 2026-07-24
closed_commit: 642b952
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

The identity resolver enforces a **shared-DB `project_identity` registry with two-directional uniqueness**
(evidence → one key AND key → one evidence) and a **5-rung authority ladder** (config/registry agree → adopt →
claim → derive+claim → refuse), so two worktrees can never silently fork one project into two backlogs. The
registry claim, the guarded atomic config write, and the ticket import run in a single `BEGIN IMMEDIATE`
transaction: a config-write refusal rolls back the whole import (zero DB changes); a crash after the config
rename but before the commit leaves only an inert, portable config-only key that a retry safely re-claims.

## Scope

- Add `tickets`, `ticket_events`, `ticket_relations` tables, all keyed by `(project_key, ticket_id)`.
- Add the host-side **storage-mode** record keyed by `project_key` (default `markdown`) and the
  **id-allocation sequence** table per `(project_key, prefix)`.
- Add a **minimal durable `blocker_evidence` table** — introduced HERE, not Slice D.
- `tickets` carries an explicit `type` field (`bug` / `story` / `epic` / `idea`, open vocabulary) and status
  limited to `active` / `done` / `deferred` (DB-level `CHECK`; NO `blocked`).
- Add `forge backlog import`: reads a project's `backlog/*.md` via the existing parser and populates the DB as
  a shadow (idempotent-additive UPSERTs).
- Preserve id / type / status / title / body / created / closed / relations / full frontmatter. Map current
  file-derived types from `TYPE_DIRS` (`story`/`epic`/`idea`); reserve `bug`.
- `.forge/config.yml` gains the `project_key` field (derived/claimed on import if absent; written via a
  symlink/TOCTOU-safe atomic temp+rename).

## Legacy blocked evidence must survive the cutover (decide here, not Slice D)

- The **minimal** durable `blocker_evidence` representation is defined in THIS slice.
- Import maps a legacy `status: blocked` ticket to **`active` + a `blocker_evidence` row**, never to a plain
  active ticket.
- Slice D ENRICHES this table (readiness binding, queue projections, richer evidence kinds); it does not
  introduce it.

## Acceptance Criteria

- All ticket tables are keyed by `(project_key, ticket_id)`; a test proves `FG-123` in project A and `FG-123`
  in project B (same prefix, different `project_key`) coexist without collision.
- `project_key` is read from `.forge/config.yml` and is stable across two linked worktrees of the same project
  (same key from different real paths).
- Storage mode is stored in the DB under `project_key` (default `markdown`); no per-worktree config holds it.
- After import, DB rows for tickets **present in Markdown** equal the source for
  id/type/status/title/body/created/closed/relations/frontmatter, and re-import is idempotent-additive (UPSERTs
  without duplicating). **Reconciliation of REMOVALS** (a ticket/relation deleted from Markdown → deleted from
  the shadow, exact set equality) is **deferred to the authoritative-cutover slice (FG-608)** — the shadow is
  non-authoritative here, so append-only fidelity of present tickets is the Slice-A contract. *(Scope refined
  2026-07-24 to match the deliberate append-only decision; original wording implied removal set-equality.)*
- A legacy `status: blocked` ticket imports as `active` + a `blocker_evidence` row (never plain active).
- Legacy file-derived types mapped; `bug` type reservable.
- Re-running import is **idempotent** (no duplicate rows).
- No consumer behavior changes — nothing reads the DB yet.
- Migration is **additive-only**: `CREATE TABLE IF NOT EXISTS` in `SCHEMA_SQL`; no `DROP`, no rename, and
  **no `PRAGMA user_version` bump** (would trip the FG-568 forward gate `assertSchemaVersionSupported`).
- A `fg606-tickets-migration.integration.test.ts` proves an old-shape DB opens forward non-destructively.

## Dependencies / Relations

- Parent: FG-496. Epic: FG-593.
- Blocks: Slice B (FG-607). Removal-reconciliation deferred to Slice C (FG-608).

## Non-Goals

- No reader consumes the DB (Slice B/C). No queue rank/membership/readiness (Slice D beyond the minimal blocker
  table). No claims (Slice E). No UI/dispatcher (FG-591). No Markdown export. No removal reconciliation (FG-608).

## Acceptance Evidence

Shipped in squash merge `642b952` (PR #156). All required CI green (`test` + `test-extended`).

| AC | Evidence | Verdict |
|----|----------|---------|
| `(project_key, ticket_id)` keying + cross-project coexistence | Composite PKs/FKs in `src/store/schema.ts` (tickets/ticket_events/ticket_relations/blocker_evidence); coexistence test in `src/store/tickets.test.ts` (`FG-123` under two `project_key`s) | met |
| `project_key` read from config, stable across linked worktrees | `src/store/project-registry.ts` (converging `repositoryCheckoutIdentity`, 5-rung ladder, bidirectional-unique registry); `src/store/project-registry.test.ts`; cross-worktree CLI-spawn test `src/cli/commands/backlog-import-worktree.integration.test.ts` | met |
| Storage mode in DB under `project_key` (default markdown), not per-worktree config | `ticket_storage_mode` table in `schema.ts`; accessors in `src/store/tickets.ts`; tests | met |
| DB rows equal Markdown set for present tickets; idempotent-additive; removals deferred | Upserts in `src/store/backlog-import.ts`; `src/store/backlog-import.test.ts`; append-only by design, removals → FG-608 (refined AC) | met (refined scope) |
| Legacy `blocked` → `active` + `blocker_evidence` | `mapStatus` + import mapping in `backlog-import.ts`; test in `backlog-import.test.ts` | met |
| File-derived types mapped; `bug` reservable | Type mapping in `backlog-import.ts`; test | met |
| Re-import idempotent (no duplicates) | Deterministic `import:` event key + upserts; idempotency test in `backlog-import.test.ts` | met |
| No consumer reads the DB | Ticket tables referenced only in `schema.ts` + import + tests (grep-verified); no read path | met |
| Additive-only; no `user_version` bump | `CREATE TABLE IF NOT EXISTS` in `schema.ts`; diff carries no `user_version` change; `db.ts` untouched | met |
| Old-shape DB opens forward non-destructively | `src/store/fg606-tickets-migration.integration.test.ts` (mirrors fg523) | met |

Hardening beyond the original AC, shipped in this slice: `ticket_events` composite PK
`(project_key, ticket_id, event_key)`; DB-level `CHECK` on `tickets.status`; unrecognized-status and
malformed-file fail-closed import; config/DB commit atomicity (config write inside the txn, before commit);
symlink/TOCTOU-safe atomic config write (`O_EXCL|O_NOFOLLOW`, unpredictable temp name).
