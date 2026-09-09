# Decision: Remote Board bounded planning mutations

**ID**: FORGE-DEC-035
**Date**: 2026-09-08
**Status**: Decided
**Decided by**: FG-783 (Remote Board bounded authenticated planning mutations)
**Supersedes**: N/A
**Scope**: Workspace
**Elevated from**: N/A

---

## Context

FG-781 shipped the Remote Board as a read-only, project-scoped, loopback-bound surface with a
fail-closed verified-identity interface; FG-782 wired the first transport (Tailscale Serve,
whois-confirmed identity). FG-783 turns that read surface into a **bounded write** surface:
exactly four planning actions — change canonical stack rank, enqueue/dequeue through the
readiness gates, reorder the operator queue, and append a bounded planning annotation — and
nothing else.

The surface is off-host and fronted by a proxy, so the write path faces adversaries the local
dashboard does not: CSRF from a page in the operator's browser, request-shape forgery of an
excluded action, replay/double-apply (especially across a restart), scope confusion, and stale
preconditions overwriting a board that moved. Four decisions were load-bearing enough to record
here so a later change does not re-litigate or quietly undo them.

---

## Problem

How does the Remote Board apply a remote planning mutation **atomically, idempotently, and
without any path to an unbounded verb** — while keeping FG-781/FG-782's read path and
loopback/fail-closed guarantees byte-for-byte intact?

---

## Options Considered

### Option A: Shell the `forge` CLI for each planning action (mirror the dashboard's local queue-mutation path)

The local dashboard already writes by shelling `forge queue …` (FORGE-DEC-015: dashboards don't
bypass the CLI). The remote handler could do the same.

**Pros**:
- Reuses FORGE-DEC-015's single-entrypoint discipline verbatim.
- No new writer module.

**Cons**:
- **Cannot be atomic with the ledger + audit.** A shelled `forge` process holds its own DB
  connection; its commit and the handler's ledger/audit write are two commits in two processes.
  A crash between them lets a redelivery double-apply — precisely the replay hazard FG-783 must
  close. The idempotency-across-restart requirement is unsatisfiable through a process boundary.

### Option B: In-process store authority, one atomic transaction ✅

A new `src/store/remote-planning.ts` (`applyRemotePlanningCommand`) is the only writer of the two
new tables and the single atomic owner of ledger + precondition + mutation + audit, reusing the
exact `src/store/queue.ts` accessors local operations use. The HTTP handler only delegates; it
never writes a Forge table itself.

**Pros**:
- **One `writeTransaction` (`BEGIN IMMEDIATE`)** covers the replay short-circuit, the precondition
  check, the mutation, and the ledger+audit row — no cross-process double-apply window, and
  idempotency survives a restart (a reopened DB replays the recorded outcome).
- Still honors FORGE-DEC-015's *intent*: the store authority is a single authoritative entrypoint
  running the same validation/precondition/event logic; the handler delegates rather than writing
  tables. The queue-write authority is shared with the CLI — only the *transport* to it differs.

**Cons**:
- A narrow, documented departure from the CLI-shell path — the write authority now has two
  callers (the CLI and the in-process store authority) rather than one.

---

## Decision

**Chose**: Option B — in-process store authority in one atomic transaction. Plus three supporting
decisions below.

**Rationale**: Atomicity of ledger + precondition + mutation + audit is the whole point of the
replay-resistance requirement, and only an in-process transaction can provide it. FORGE-DEC-015's
goal (no table writes straight from a UI handler; one authoritative entrypoint) is preserved — the
handler delegates to a store authority that reuses the CLI's own queue accessors.

The four load-bearing decisions recorded by this ADR:

1. **Atomic in-process store authority — never a handler-side ledger.** As above.
2. **Two additive store tables, no `user_version` bump.** `remote_planning_commands` (the durable
   request-id ledger *and* the audit row in one; `PRIMARY KEY (project_key, request_id)` is the
   idempotency key — a composite key, not `request_id` alone, because a request id is unique only
   within the identity that minted it and a global key would let one project's id collision read
   or suppress another project's outcome; see the RF-1 remediation below)
   and `ticket_planning_annotations` (the free-standing operator planning-annotation primitive
   that did not exist — FG-703's `ops.adjudicated` is an event, and queue/backlog `--note`
   annotates a membership). Both are `CREATE TABLE IF NOT EXISTS` appended to `SCHEMA_SQL` with
   `PRAGMA user_version` / `SCHEMA_VERSION` untouched (FG-568/BD-15 forward-gate contract; a new
   table needs no additive-column-list entry). Fresh + aged/migrated PRAGMA parity is proven in
   `fg608-migration-parity.test.ts`. Preconditions key off `queueVersion` / order fingerprint /
   `ticket_revision` — **never** a rank value, which is renumbered on every move.
3. **CSRF origin pinned to the Serve hostname from serve-state.** `guardRemotePlanningRequest`
   requires a non-simple content type (`application/json`), a same-origin/none `Sec-Fetch-Site`,
   and an `Origin`/`Host` that matches the Serve-fronted public hostname read from Forge-owned
   serve-state (`readServeState().serveHost`/`.url`) — **never** the request `Host`,
   `X-Forwarded-Host`, or the loopback bind. Absent serve-state fails closed (nothing to pin to →
   refuse). This defeats DNS-rebind and forged-Host attacks the loopback bind alone cannot.
4. **AC7 migrated from "no non-GET branch" to "closed registry".** Through FG-781/FG-782 "no
   remote mutation" was the structural *absence* of a POST route. FG-783 adds exactly one POST
   route (`/api/plan`) and re-states the guarantee as a **closed command registry of exactly four
   actions**, asserted over data (the FG-591 `QUEUE_MUTATION_FORGE_VERBS` precedent) and proven by
   a source guard that no excluded verb (completion/closure/gate/override/run/campaign/merge/
   publish/review/disposition/terminal/cleanup/credential/RACI/model-policy/arbitrary-CLI) is a
   key, an authority, or reachable anywhere in the registry.

---

## Consequences

**Positive**:
- Replay-resistant across restarts by construction; no double-apply window.
- Every excluded mutation is unreachable *by construction*, proven by a source guard rather than a
  runtime denylist that could drift.
- Schema stays additive and forward-gate-safe; old and new binaries coexist.
- The read path and loopback/fail-closed guarantees are untouched for any identity without `plan`.

**Negative / Trade-offs**:
- The queue-write authority now has two callers (CLI shell + in-process store authority). Both run
  the same accessors, but a future change to queue-write semantics must consider both.
- The request-id ledger is **unbounded** — one row per command (applied or refused), no GC/retention
  in this ticket. Acceptable because volume is a human on a board, but a later retention story may
  be warranted.

**Risks**:
- If a future action is added to the registry without a matching precondition, it could apply against
  stale state. Mitigation: the registry maps each action to its precondition as data, and the store
  authority switches over the action union exhaustively (an unhandled action is a compile error).

---

## Implementation Notes

- `applyRemotePlanningCommand` (`src/store/remote-planning.ts`) is the ONLY writer of the two
  tables and the single atomic owner; do not add a second writer or a handler-side write.
- The replay short-circuit sits in **front** of every action inside the same transaction, so a
  redelivery re-runs no enqueue readiness. A refusal also commits its ledger row (`outcome='refused'`)
  — a genuine retry after re-reading is a **new** `requestId`, not a re-send.
- Server-authoritative fields (`actor`/`subject`/`transport`/`projectKey`/`projectDir`/`timestamp`)
  are on the envelope's `FORBIDDEN_BODY_KEYS` denylist and are unrepresentable in `PlanningEnvelope`;
  the server attaches them from the bound resolver. Never take them from the body.
- Resolved by the RF-2 remediation (below): the remote backlog/queue projection DTOs now carry the
  ticket's monotonic `revision` (null on a row that has none), so the client reads the real
  annotation precondition instead of guessing. The `0` fallback in the client remains only for a
  row that genuinely carries no revision; a superseded revision still refuses server-side with a
  safe summary rather than clobbering.

---

## Addendum: review remediation (2026-09-08)

A review pass on this same change surfaced four fixes, folded in before merge rather than as a
follow-up ticket, because each closes a gap in a guarantee this ADR already claims:

- **RF-1 — project-scope the replay ledger.** `remote_planning_commands` moved from a bare
  `request_id` PRIMARY KEY to a composite `PRIMARY KEY (project_key, request_id)`. A request id is
  unique only within the identity that minted it; keyed globally, one project's id collision could
  read — or silently suppress — another project's recorded outcome, a cross-project leak the
  read-side allowlist says can never happen. The replay lookup is now scoped to the committing
  project, and a same-project id reused for a genuinely different command (mismatched actor,
  action, target, or precondition) refuses with zero mutation instead of replaying an unrelated
  outcome. RF-1 also added `GET /api/plan/audit`, gated on `read`, so an identity can see its own
  project's planning history without needing `plan`.
- **RF-2 — carry ticket `revision` onto the projection, and gate planning affordances on capability.**
  `RemoteBacklogTicket` and `RemoteQueueRow` now carry the ticket's monotonic `revision` (closing the
  "known plan defect" and the matching Revisit Condition originally recorded here), and the
  `RemoteBoardEnvelope` now carries the verified identity's `capabilities` so the client shows
  planning controls only to an identity actually granted `plan`, rather than always offering them
  and relying solely on the server to refuse.
- **RF-3 — a persistent applied-outcome announcement.** The client's success confirmation now lives
  in a screen-reader live region outside the board mount, so it survives the dialog close and the
  board's non-optimistic re-read instead of being wiped with the dialog's own status region.
- **RF-4 — fail planning closed with no secure random source.** The client's idempotency key
  generator no longer falls back to an all-zero constant when neither `crypto.randomUUID` nor
  `crypto.getRandomValues` exists; planning affordances are hidden entirely on such a browser
  (an explicit "unsupported" note), because a constant id would make every subsequent command read
  as a replay of the first.

## Revisit Conditions

- If the request-id ledger volume becomes a concern (add retention/GC).
- If a second write authority (beyond the CLI and this store authority) is proposed — reconsider
  the FORGE-DEC-015 reconciliation.
- If a transport other than Tailscale Serve fronts the board (FG-784 Cloudflare): confirm the CSRF
  origin pin generalizes to that transport's serve-state equivalent.
