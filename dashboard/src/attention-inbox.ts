// FG-402: the Human Attention Inbox — CONTRACT + PURE HELPERS.
//
// This module is the SOURCE-AGNOSTIC external contract for the inbox and nothing
// else. It defines the `AttentionItem` shape the dashboard and any future operator
// surface (Stream Deck) consume, the `InboxEnvelope` that wraps them, and the pure
// compose/sort/dedupe helpers. It has NO database access and imports no source enum:
// internal source types (FailureKind, OperatorWaitSource, review verdicts) are mapped
// INTO the `AttentionItemKind` union by the per-source mappers, never surfaced raw.
// That one-way mapping is the invariant that lets an internal refactor rename a
// FailureKind without breaking a client (protected_invariant #3).

/** The item kinds the inbox surfaces. Deliberately a CLOSED, source-agnostic
 *  vocabulary — the operator-facing categories from the ticket's Acceptance Criteria,
 *  never the internal enum a source happens to record. */
export type AttentionItemKind =
  | "waiting_gate"
  | "campaign_paused"
  | "blocked_by_red_or_reviewer"
  | "missing_acceptance_or_readiness"
  | "auth_setup"
  | "merge_conflict"
  | "integration_blocked_park";

/** Known priority, or null when the source recorded none. Kept as a small named
 *  vocabulary rather than a raw ordinal so a client renders a label, not a number. */
export type AttentionSeverity = "high" | "medium" | "low";

/** The inbox is an OPEN-ONLY projection (protected_invariant #2): every item it
 *  carries is live/actionable now, derived from its source's current state. There is
 *  no stored resolution flag — a resolved source simply stops producing its item — so
 *  the only openState the contract needs is `open`. The field exists so the shape can
 *  grow a `stale` reading later without a breaking change. */
export type AttentionOpenState = "open";

/** Every association id an item can carry, so a client can link to the run, task,
 *  ticket, campaign, or control-plane surface without re-deriving anything. Every
 *  field is nullable: an item links to exactly the surfaces its source knows about. */
export type AttentionLinks = {
  runId: string | null;
  taskId: string | null;
  ticketId: string | null;
  campaignId: string | null;
  itemId: string | null;
  projectDir: string | null;
  projectLabel: string | null;
};

export type AttentionItem = {
  /** Stable identity for rendering (the row key) AND the default dedup key. Never
   *  fabricated — built from the underlying source id (waitKey / task id / review id). */
  id: string;
  kind: AttentionItemKind;
  severity: AttentionSeverity | null;
  /** When the attention condition began (ISO), or null when the source recorded none.
   *  Drives the age string; never fabricated from "now". */
  startedAt: string | null;
  /** WHY this needs a human, in the operator's terms. */
  reason: string;
  /** The named next action the operator must take. */
  requestedAction: string;
  openState: AttentionOpenState;
  /** The kind of source object this was derived from — `task`, `campaign_item`,
   *  `review`, `readiness`, `gate` — carried so a reader sees the provenance without
   *  the internal enum leaking. */
  source: string;
  links: AttentionLinks;
};

export type InboxScope = {
  runId: string | null;
  projectDirs: string[] | null;
};

export type InboxEnvelope = {
  generatedAt: string;
  scope: InboxScope;
  items: AttentionItem[];
  /** True when there are no open items — the client renders the calm empty state. A
   *  DIFFERENT fact from a failed read, which never reaches this envelope (the route
   *  returns an {error} body the client resolves to unavailable). */
  empty: boolean;
  /** Per-source read failures absorbed while still returning the rest — a source that
   *  a store predating its tables cannot answer names itself here rather than taking the
   *  whole inbox down. A total failure is the route's {error} body, not this list. */
  degraded: string[];
};

// ─── Severity ─────────────────────────────────────────────────────────────────

const SEVERITY_RANK: Record<AttentionSeverity, number> = { high: 0, medium: 1, low: 2 };

/** A sortable ordinal for a severity. A KNOWN severity ranks ahead of an unknown one
 *  (null → a rank past every known value), so "severity known first" falls out of a
 *  single numeric compare. */
export function severityRank(severity: AttentionSeverity | null): number {
  return severity === null ? SEVERITY_RANK.low + 1 : SEVERITY_RANK[severity];
}

// ─── Kind precedence (dedup tie-break) ──────────────────────────────────────────
//
// When two items collapse onto one underlying blocker, the more actionable/severe
// kind wins. Lower index = higher precedence. A hard block (a red/reviewer wall, a
// merge conflict, a park, an auth wall) outranks a readiness gap, which outranks the
// softer "waiting on a decision" waits.
const KIND_PRECEDENCE: AttentionItemKind[] = [
  "blocked_by_red_or_reviewer",
  "merge_conflict",
  "integration_blocked_park",
  "auth_setup",
  "missing_acceptance_or_readiness",
  "campaign_paused",
  "waiting_gate",
];

export function kindPrecedence(kind: AttentionItemKind): number {
  const idx = KIND_PRECEDENCE.indexOf(kind);
  // An unknown kind sorts LAST rather than throwing — the contract stays forward
  // tolerant of a kind a newer producer adds.
  return idx === -1 ? KIND_PRECEDENCE.length : idx;
}

// ─── Sort ───────────────────────────────────────────────────────────────────────

function startedAtMs(item: AttentionItem): number {
  if (item.startedAt === null) return Number.POSITIVE_INFINITY; // unknown age sorts last
  const ms = Date.parse(item.startedAt);
  return Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY;
}

/** Severity-known-first, then by severity ordinal, then age-descending (oldest first).
 *  A pure, total order: ties break on the stable id so the sort is deterministic. */
export function sortAttentionItems(items: AttentionItem[]): AttentionItem[] {
  return [...items].sort((a, b) => {
    const bySeverity = severityRank(a.severity) - severityRank(b.severity);
    if (bySeverity !== 0) return bySeverity;
    const byAge = startedAtMs(a) - startedAtMs(b); // ascending ms = oldest first = age-desc
    if (byAge !== 0) return byAge;
    return a.id.localeCompare(b.id);
  });
}

// ─── Dedup ────────────────────────────────────────────────────────────────────
//
// One underlying blocker must surface as ONE row. A run carrying two concurrent
// attention reasons — say a red-blocked task AND an open reviewer finding on the same
// run — collapses to a single item by kind precedence. Items sharing no run collapse
// only when they share their own id, so two distinct tickets' readiness gaps stay two
// rows. This extends FG-734's waitKey convention: the wait's identity is its id, and a
// run-scoped item's collapse key is its run.

function dedupeKey(item: AttentionItem): string {
  return item.links.runId !== null && item.links.runId !== "" ? `run:${item.links.runId}` : `id:${item.id}`;
}

/** Collapse items that share an underlying blocker, keeping the highest-precedence
 *  kind (then the most severe, then the earliest id) for each. Pure and order-stable. */
export function dedupeAttentionItems(items: AttentionItem[]): AttentionItem[] {
  const winner = new Map<string, AttentionItem>();
  for (const item of items) {
    const key = dedupeKey(item);
    const current = winner.get(key);
    if (current === undefined) {
      winner.set(key, item);
      continue;
    }
    winner.set(key, preferItem(current, item));
  }
  return [...winner.values()];
}

function preferItem(a: AttentionItem, b: AttentionItem): AttentionItem {
  const byKind = kindPrecedence(a.kind) - kindPrecedence(b.kind);
  if (byKind !== 0) return byKind < 0 ? a : b;
  const bySeverity = severityRank(a.severity) - severityRank(b.severity);
  if (bySeverity !== 0) return bySeverity < 0 ? a : b;
  return a.id.localeCompare(b.id) <= 0 ? a : b;
}

// ─── Compose ────────────────────────────────────────────────────────────────────

export type ComposeMeta = {
  generatedAt: string;
  scope: InboxScope;
  degraded?: string[];
};

/** The ONE assembly point: flatten every source's items, collapse duplicates, sort,
 *  and wrap in the stable envelope. Pure — every input is already-derived data. */
export function composeInbox(sources: AttentionItem[][], meta: ComposeMeta): InboxEnvelope {
  const flattened = sources.flat();
  const items = sortAttentionItems(dedupeAttentionItems(flattened));
  return {
    generatedAt: meta.generatedAt,
    scope: meta.scope,
    items,
    empty: items.length === 0,
    degraded: meta.degraded ?? [],
  };
}
