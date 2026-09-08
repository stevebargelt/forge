# Decision: External kanban projection — outbound-only architecture

**ID**: FORGE-DEC-035
**Date**: 2026-09-08
**Status**: Decided
**Decided by**: FG-785 pipeline (tech-lead plan + architecture-advisor)
**Supersedes**: N/A
**Scope**: Workspace
**Elevated from**: N/A

---

## Context

FG-785 (under epic FG-780) projects a Forge project's planning state — its backlog and operator
queue — onto an external kanban board (Trello, a GitHub Project, a self-hosted board). The
Remote Board foundation (FG-781, merged) already produces a sealed, allowlisted, redacted
projection of a project via `assembleRemoteBoard`.

Constraints that shaped the design:

- **The shared store is machine-wide.** `~/.forge/forge.db` is opened by every forge binary on
  the host; a schema change migrates on next open for *all* of them. Any new table must be
  additive-only and must not bump `PRAGMA user_version`, or an older binary is locked out
  (FG-568 forward gate).
- **The FG-781 seal must not be bypassed.** The same allowlist + redaction that protects the
  read-only Remote Board must protect the external board — so the projection, not raw store
  rows, has to be the card-data source.
- **Forge state is authoritative and must be untouchable by the projection.** External card
  movement/deletion/edits must never mutate or reorder a ticket, gate, run, or campaign (AC3,
  AC4).
- **Scope is deliberately outbound-only.** Inbound sync (external → Forge planning actions) is
  deferred to ride FG-783's authenticated, revision-bound planning-command contract. This story
  ships no inbound write path but must leave room to add one additively.

---

## Problem

Where do the durable identity/conflict state, the sync engine, and the conflict-resolution
authority live, such that the projection is idempotent and incremental, never mutates Forge, never
leaks credentials or cross-project data, keeps older binaries able to open the shared DB, and can
grow an inbound path later without reworking outbound semantics?

---

## Options Considered

### Option A: Promote the whole FG-781 projection into a core `@forge` package

Move `assembleRemoteBoard` and the `to*` mappers into core so a core sync engine can call them
directly.

**Pros**:
- Sync engine lives in core alongside the store; no cross-workspace shelling.

**Cons**:
- `assembleRemoteBoard` imports `dashboard/src/queries.ts` and `attention-inbox.ts`, which would
  drag those (and their transitive deps) into core — a large, risky layering inversion far beyond
  this story's scope.

---

### Option B: Site the sync engine in the dashboard workspace; keep store accessors in core ✅

Two additive core store tables with a core accessor module; the sync engine and the FG-781-fed
entrypoint live in the dashboard workspace and reach the store via `@forge/*` aliases; the core
CLI `forge kanban sync` shells into the dashboard entry exactly as `forge dashboard` shells into
the dashboard server.

**Pros**:
- Reuses `assembleRemoteBoard` in place — the FG-781 seal is preserved by construction.
- Mirrors the established `forge dashboard` shelling pattern; no layering inversion.
- Store tables and their authority stay in core, reachable core→core by the CLI's read/resolve
  verbs with no dashboard dependency.

**Cons**:
- A single serialization point on `dashboard/tsconfig.json` for the `@forge/*` aliases (owned by
  one plan step so the sync and inbox steps stay path-disjoint).
- The reference `fake` provider holds state in memory, so cross-process convergence is a property
  of a persistent *real* provider, not the reference run.

---

## Decision

**Chose**: Option B — dashboard-workspace sync engine, core store tables.

**Rationale**: Promoting the projection to core (Option A) would import dashboard-internal query
and inbox modules into core to move one consumer — a large, high-risk layering inversion to avoid
a shell-out that the codebase already does cleanly for `forge dashboard`. Option B reuses the
FG-781 projection exactly where it lives, so the allowlist + redaction seal protects the external
board for free, while the durable identity/conflict authority stays in core where the CLI can
reach it without any dashboard dependency.

Supporting decisions:

- **Two additive store tables** — `kanban_projection_map` (Forge→external-card identity + last
  projected hash + provenance) and `kanban_conflicts` (both-versions conflict records). Both are
  `CREATE TABLE IF NOT EXISTS` with **no `user_version` bump** and no CHECK constraints
  (enum-as-convention, FG-585), so an older binary keeps opening the shared DB. **This is the
  `architecture_changed` decision this ADR records.**
- **The store is the conflict-resolution authority; the attention inbox is an open-only
  projection.** A conflict item exists exactly while its store row is `open`; resolution is a
  store write (`resolveConflict`, via `forge kanban conflicts-resolve`), never an inbox mutation.
  The inbox holds no resolution state of its own. Last-writer-wins is not the default — a conflict
  persists until an authorized resolution, and the first resolution wins.
- **The content hash is the incremental signal.** Each projected card DTO is hashed; a card whose
  hash equals `last_projected_hash` is skipped. This is independent of any internal revision
  semantics and matches exactly what is pushed, so drift detection recomputes the same hash over
  external state.

---

## Consequences

**Positive**:
- The FG-781 seal protects the external board by construction — the sync engine takes a
  `RemoteBoard`, not the store, as its card-data source.
- No sync can mutate or reorder Forge state: the engine writes only its two tables through an
  injected port that names no lifecycle table.
- Older forge binaries keep opening the shared DB; the change is invisible to them.
- Inbound can be added later as a separate optional provider interface without touching outbound
  types.

**Negative / Trade-offs**:
- `dashboard/tsconfig.json` is a serialization point across plan steps (owned by one step).
- The reference `fake` provider proves semantics but not cross-process persistence of external
  board state.
- The plan asked the engine to reuse `@forge/retry`'s backoff, but that module is the failed-task
  retry subsystem with no generic delay primitive; the engine implements a small bounded
  injectable backoff instead (surfaced as a plan-defect note). The alias stays wired for the store
  accessors it genuinely needs.

**Risks**:
- A future real provider must honor the outbound-only contract; the `getExternalState` read path
  must never be wired to apply changes back to Forge. The adapter contract's "Extending inbound"
  note marks the seam and keeps inbound a separate, additive interface.

---

## Implementation Notes

- Store accessors: `src/store/kanban-projection.ts` (core). Adapter contract:
  `dashboard/src/kanban/adapter.ts`. Sync engine: `dashboard/src/kanban/sync.ts`. Entry the CLI
  shells into: `dashboard/src/kanban/cli-entry.ts`. CLI: `src/cli/commands/kanban.ts`.
- Credentials are read only at the CLI edge (`readProviderCredential`) from
  `FORGE_KANBAN_<PROVIDER>_TOKEN` / `FORGE_KANBAN_TOKEN`, handed to the provider factory, and
  dropped. The negative proof is `dashboard/src/kanban/credential-leak.integration.test.ts`.
- Migration safety is covered by a migrated-shape integration test (fresh + pre-migrated
  fixtures), not just a fresh-DB test.
- See [how-to-external-kanban.md](../../docs/how-to-external-kanban.md) and the
  [SCHEMA-CONTRACT adapter contract](../../docs/SCHEMA-CONTRACT.md#external-kanban-adapter-contract-fg-785).

---

## Revisit Conditions

- When inbound sync (FG-783) is implemented: this ADR's outbound-only boundary is the baseline it
  must extend additively.
- If a real (non-fake) provider is added: revisit the reference-provider limitations
  (in-memory state, cross-process convergence).
- If a future story needs a lifecycle-affecting reaction to an external change: that is a scope
  change requiring a new decision — it must not weaken the "sync never writes a lifecycle table"
  invariant.
