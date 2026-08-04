// FG-609 (FG-496 Slice D): the STATUS-BEARING EVIDENCE predicate, and the legacy
// blocked source literal it is defined over.
//
// ZERO IMPORTS, DELIBERATELY. This module is load-bearing as a LEAF, not as a
// style preference: src/store/tickets.ts:12 imports getDb from ./db.js, so a
// dashboard import routed through tickets.ts would drag better-sqlite3 and the
// whole store handle into the dashboard's typecheck and bundle. Four separate
// surfaces derive "is this ticket blocked" and they must agree; the only way they
// can share one declaration is if the declaration depends on nothing.
//
// WHY THIS EXISTS AT ALL (the FG-609 defect it closes). Before Slice D,
// blocker_evidence carried exactly one kind of row, so two of the four blocked
// derivations got away with no source filter:
//   src/backlog/structured.ts        — filtered on the legacy source (correct)
//   src/backlog/container-authority.ts — SELECT 1 FROM blocker_evidence ... (unfiltered)
//   dashboard/src/queries.ts          — filtered on a PRIVATE COPY of the literal
//   docker/forge-backlog-reader.mjs   — SELECT 1 FROM blocker_evidence ... (unfiltered)
// Slice D adds dependency / campaign / run-derived evidence kinds. The FIRST such
// row would have flipped every container to reporting that ticket as status
// 'blocked' while the host seam still called it active — a silent reinterpretation
// of the container-visible status vocabulary, shipped on the next publish, with no
// code change in the container path.
//
// THE RULE: only the LEGACY kind is status-bearing. The richer kinds feed the
// operator QUEUE PROJECTION and are excluded from every blocked derivation and
// from the published snapshot's evidence copy. Making a new kind container-visible
// as 'blocked' is a deliberate change to the container status vocabulary and is a
// one-line change HERE, which is the point of collapsing four predicates into one.
//
// docker/forge-backlog-reader.mjs runs inside the agent container with no
// TypeScript build and structurally CANNOT import this module. Its copy of the
// literal is pinned to this one by test (see fg609-blocked-predicate-parity).

/** The evidence source both legacy writers use for a `status: blocked` ticket:
 *  the Markdown import, and the FG-607 seam writing a ticket with status
 *  'blocked' in db mode. The ONLY declaration in the repo. */
export const LEGACY_BLOCKED_SOURCE = "import-legacy-blocked";

/** Evidence kinds. Free TEXT in the column (enum-as-convention, FG-585) so a new
 *  kind never needs a migration, and so an older binary's inserts can never fight
 *  a CHECK this binary added. */
export type BlockerEvidenceKind = "legacy_blocked" | "dependency" | "campaign" | "run_derived";

/** The value a pre-FG-609 row reads back as, via the column DEFAULT. A Slice A
 *  legacy row therefore classifies correctly with no backfill. */
export const LEGACY_BLOCKED_KIND: BlockerEvidenceKind = "legacy_blocked";

/** THE predicate. A row is STATUS-BEARING when its presence alone is allowed to
 *  make a ticket read back as status 'blocked' on every surface. Consumed by all
 *  four derivations; nothing else may decide this independently. */
export function isStatusBearingEvidenceSource(source: string): boolean {
  return source === LEGACY_BLOCKED_SOURCE;
}

// ─── discriminating source identities for the enriched kinds ─────────────────
//
// blocker_evidence's natural key is UNIQUE (project_key, ticket_id, source) and
// Slice D does NOT change it (no constraint-shape change, no table rebuild). So
// every enriched kind folds its DISCRIMINATING IDENTITY into the source value:
// two distinct dependency blockers on one ticket must be two rows, not one row
// silently overwriting the other on the second UPSERT.

/** Blocked by another ticket. */
export function dependencyBlockerSource(dependencyTicketId: string): string {
  return `queue-dependency:${dependencyTicketId}`;
}

/** Blocked by a campaign that owns the ticket's execution. */
export function campaignBlockerSource(campaignId: string): string {
  return `queue-campaign:${campaignId}`;
}

/** Blocked by an observed run outcome (a failed/parked run against this ticket). */
export function runDerivedBlockerSource(runId: string): string {
  return `queue-run:${runId}`;
}
