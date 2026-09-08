# External kanban projection (outbound only)

Forge can project a project's planning state — its backlog and operator queue — **one way**
onto an external kanban board (a Trello board, a GitHub Project, a self-hosted board). Forge
stays the source of truth; the external board is a **downstream projection** of it.

> **One-way is the only mode this release.** Nothing here reads the external board back into
> Forge. An external card that is moved, edited, or deleted out of band is **never applied** to
> any Forge state — it is recorded as a *conflict* for a host operator to resolve. Inbound sync
> (external board → Forge planning actions) is a later, deliberately-deferred addition that must
> ride FG-783's authenticated, revision-bound planning-command contract; **no inbound write path
> ships in this release.**

## What gets projected

The card data comes **exclusively** from the FG-781 Remote Board projection
(`assembleRemoteBoard`) for the selected project — never from raw store queries. This is
deliberate: the same allowlist + redaction seal that protects the read-only [Remote
Board](SCHEMA-CONTRACT.md#remote-board-fg-781) protects the external board, so no host path,
cross-project row, ticket body, or credential can reach a card that could not already reach the
Remote Board. One card is projected per backlog ticket:

- **Identity** — the opaque Forge `(projectKey, ticketId)` pair, and only that pair. A card's
  lane, title, labels, and column position are *presentation*, never identity, so a renamed or
  moved card is never treated as a new one.
- **Lane** — the ticket's operator-queue column when it has one, otherwise its status.
- **Title** — the ticket title, already redacted by the FG-781 seal.
- **Labels** — the ticket type and status.
- **Body** — deliberately empty: the FG-781 seal excludes ticket bodies from the remote
  projection, so there is none to carry.

## Operator commands

All four verbs are host-operator-only. There is no remote or browser surface for any of them.

```bash
forge kanban sync     --project <key> [--provider <name>]   # run a one-way outbound projection
forge kanban status   --project <key> [--provider <name>] [--json]   # list the projection map
forge kanban conflicts [--project <key>] [--provider <name>] [--json] # list OPEN conflicts
forge kanban conflicts-resolve <conflictId> [--by <actor>] [--note <text>] [--json]
```

`--provider` defaults to `fake` — the deterministic in-memory reference provider, the only
adapter that ships this release (see [Providers](#providers) below). `forge kanban` with no
subcommand prints the group help, which restates the one-way / no-inbound guarantee.

### `sync` — project the board outbound

```bash
forge kanban sync --project my-project
```

`sync` assembles the sealed Remote Board for the project and pushes each **changed** card to the
provider. It is:

- **Incremental** — each projected card is hashed; a card whose hash equals the last projected
  hash is skipped. A repeat sync with no planning change pushes nothing.
- **Idempotent** — every outbound operation carries a stable idempotency key derived from
  `(provider, kind, project, ticket, revision)`, so a retried or duplicated delivery collapses to
  one effect. A repeated sync never mints a duplicate card.
- **Retryable + rate-limited** — transient provider faults and rate-limit signals are retried
  under a bounded exponential backoff that honors a provider-requested `retryAfterMs` floor.
- **Convergent** — a partial failure (some cards land, others error) is recorded; the next sync
  re-attempts only the outstanding cards and converges.
- **Non-mutating to Forge** — the sync engine writes **only** its own two tables
  (`kanban_projection_map`, `kanban_conflicts`). It touches no Forge lifecycle table, so a sync
  can never reorder, mutate, or delete a ticket, gate, run, or campaign.

A ticket that has left the board is **archived** on the external board (its identity row is kept
so a later sync never re-creates it).

### `status` — inspect the projection map

```bash
forge kanban status --project my-project
```

Lists the durable Forge→external-card map: for each projected ticket, the external card id, the
projection state (`active` / `archived`), a truncated content hash, and the write provenance
(who projected it, and when). `--json` emits the full structured rows.

### `conflicts` and `conflicts-resolve` — the external-change workflow

When a sync detects that a previously-projected card was changed on the external board — moved
to a different lane, edited, or deleted — it records a **conflict** carrying *both versions*
(Forge's canonical projection and the observed external state) and **skips** that card for the
sync. It never repairs or applies the external change.

```bash
forge kanban conflicts                       # list all open conflicts (both versions recorded)
forge kanban conflicts --project my-project  # scope to one project
forge kanban conflicts-resolve <id> --by alice --note "restored card to the correct lane"
```

Open conflicts also surface through the [attention inbox](concepts.md) as an **open-only
projection** of the conflict rows: a conflict item exists exactly while its store row is open,
and it disappears from the inbox on the next projection once the row is resolved. The inbox holds
no resolution state of its own — the store is the single authority.

`conflicts-resolve` is the **only** path that closes a conflict, and it is a local, host-operator
store write. **Last-writer-wins is not the default:** a conflict persists until an operator
explicitly resolves it, and the first resolution wins (a second resolve of the same conflict is a
reported no-op). Resolving a conflict records who resolved it, when, and the rationale, and clears
the matching attention-inbox item on the next projection.

## Providers

A **provider** is a concrete external-board adapter. The contract is provider-neutral: no
provider-specific concept (a Trello list id, a GitHub column node id, an API base URL) ever
reaches Forge, and the only provider fact Forge persists is an opaque `name` string in the
projection-map row — never in a lifecycle table.

This release ships exactly one provider: **`fake`**, a deterministic, in-memory, fault-injectable
reference adapter used to prove the sync semantics (create/update/archive, retry after a transient
failure, rate-limit backoff, duplicate-delivery idempotency, partial-failure convergence). A real
provider (Trello, GitHub Projects, …) is a later addition. Because the fake holds board state in
memory, a `forge kanban sync --provider fake` reference run projects into a fresh in-memory board
each process; the **durable** identity and conflict tables persist across runs regardless.

A provider declares, explicitly, what it does **not** support (rather than silently pretending).
An operation targeting an unsupported capability — e.g. an archive against a board with no archive
concept — is reported as an explicit `unsupported` outcome, never a fabricated success or a silent
no-op. See the [adapter contract](SCHEMA-CONTRACT.md#external-kanban-adapter-contract-fg-785) for
the full capability model.

## Credentials

Provider credentials are read **only** at the host CLI edge, from the host environment:

| Variable | Meaning |
|---|---|
| `FORGE_KANBAN_<PROVIDER>_TOKEN` | Provider-specific credential (`<PROVIDER>` is the upper-cased provider name). |
| `FORGE_KANBAN_TOKEN` | Generic fallback credential. |

The credential is read into a local at the edge, handed to the provider factory, and dropped. It
**never** appears in a persisted map/conflict row, a log line, an error message, a run/task
artifact, an exported debug bundle, the browser, or an agent prompt. This is enforced by a
negative test (`dashboard/src/kanban/credential-leak.integration.test.ts`) that seeds a sentinel
credential, drives a full sync plus the CLI surface, and asserts the sentinel is absent from every
surface the sync touches. The reference `fake` provider ignores the credential entirely.

## Why the sync lives in the dashboard workspace

The FG-781 projection (`assembleRemoteBoard` and its `to*` mappers) is dashboard-workspace
internal — it imports `dashboard/src/queries.ts` and `attention-inbox.ts`, which are not core
modules. Rather than invert the package layering by promoting all of that into core, `forge kanban
sync` **shells into** the dashboard entry (`dashboard/src/kanban/cli-entry.ts`) exactly as `forge
dashboard` shells into the dashboard server. The `status`, `conflicts`, and `conflicts-resolve`
verbs are core→core: they read and write the store accessors directly, with no dashboard
dependency. See the [ADR](../learnings/decisions/2026-09-08_external-kanban-projection-outbound.md)
for the full rationale.
