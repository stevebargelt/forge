// FG-402 (d): the READINESS / REVIEW mapper.
//
// Two human-attention sources that both live in persisted ledger state:
//   - missing_acceptance_or_readiness — a LIVE (active) ticket whose readiness outcome
//     is needs_refinement/blocked and whose assessment is CURRENT (body_hash matches, so
//     it is not superseded evidence). The classification mirrors queries.readinessCellStatus.
//   - blocked_by_red_or_reviewer — an OPEN review carrying unresolved fix_now findings or
//     open architecture questions (the evidence-led ledger's own vocabulary).
//
// Pure persisted-state read (protected_invariant #1): direct SQL on the dashboard's
// read-only handle, no git/gh/tmux/docker/CLI. Bounded to live/open work: a settled
// review or a closed ticket produces nothing, so a resolved source clears itself with no
// stored flag (protected_invariant #2). Each sub-read is guarded independently so a store
// predating one of the tables degrades that source alone rather than the whole mapper —
// and a failed sub-read NAMES itself in the returned `degraded` list rather than
// swallowing to an empty items array, so the inbox never renders a read failure as a calm
// empty "no action needed" state.

import type { Database } from "better-sqlite3";
import type { AttentionItem, AttentionSeverity } from "./attention-inbox.js";
import type { InboxProjectScope } from "./attention-inbox-failures.js";

// A single source's contribution: the items it produced AND the names of any sub-source
// whose read failed. A failed read reports its name in `degraded` (never swallows to an
// empty items array), so the aggregator surfaces an explicit unavailable marker rather
// than a calm "no action needed" inbox.
export type SourceResult = { items: AttentionItem[]; degraded: string[] };

function projectDirSubquery(scope: InboxProjectScope): { clause: string; params: string[] } {
  // Readiness rows are keyed by project_key, which has no project_dir of its own. For a
  // scoped request we restrict to the project identities carried by in-scope runs — the
  // same value tickets/readiness use as project_key. Host-wide (undefined) reads all.
  if (scope === undefined) return { clause: "", params: [] };
  const dirs = typeof scope === "string" ? [scope] : [...scope];
  if (dirs.length === 0) return { clause: " AND 1 = 0", params: [] };
  return {
    clause: ` AND ra.project_key IN (SELECT DISTINCT project_identity FROM runs
                WHERE project_identity IS NOT NULL AND project_dir IN (${dirs.map(() => "?").join(", ")}))`,
    params: dirs,
  };
}

function projectDirScope(scope: InboxProjectScope, qualifier: string): { clause: string; params: string[] } {
  if (scope === undefined) return { clause: "", params: [] };
  const dirs = typeof scope === "string" ? [scope] : [...scope];
  if (dirs.length === 0) return { clause: " AND 1 = 0", params: [] };
  return { clause: ` AND ${qualifier}.project_dir IN (${dirs.map(() => "?").join(", ")})`, params: dirs };
}

function hasColumn(db: Database, table: string, column: string): boolean {
  // PRAGMA table_info returns zero rows for a missing table rather than throwing, so
  // a store whose tickets table predates body_hash reads back false here rather than
  // taking the whole read down when the staleness predicate names a column not there.
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((r) => r.name === column);
}

function safeParseGaps(json: string | null): string[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

type ReadinessRow = {
  ticket_id: string;
  outcome: string;
  gaps_json: string | null;
  evaluated_at: string | null;
  title: string | null;
};

function readinessItems(db: Database, scope: InboxProjectScope): SourceResult {
  const sub = projectDirSubquery(scope);
  // Staleness (superseded-evidence) filtering needs tickets.body_hash. It exists in the
  // real schema, but a minimal store (e.g. the browser-tier fixture) can seed tickets
  // without it — naming t.body_hash there throws SqliteError and fails the whole read.
  // Guard it: keep the staleness match when the column is present, omit it (treat the
  // assessment as current) when it is absent, rather than referencing a column not there.
  let rows: ReadinessRow[];
  try {
    // The schema probe runs INSIDE the try: a DB error from its PRAGMA (e.g. a closed
    // connection) must degrade this source and name itself in `degraded`, exactly like a
    // failure of the readiness read below — never escape and crash the derivation.
    const staleness = hasColumn(db, "tickets", "body_hash") ? " AND ra.body_hash = t.body_hash" : "";
    rows = db
      .prepare(
        `SELECT ra.ticket_id AS ticket_id, ra.outcome AS outcome, ra.gaps_json AS gaps_json,
                ra.evaluated_at AS evaluated_at, t.title AS title
           FROM readiness_assessments ra
           JOIN tickets t ON t.project_key = ra.project_key AND t.ticket_id = ra.ticket_id
          WHERE t.status = 'active'
            AND ra.outcome IN ('needs_refinement', 'blocked')${staleness}${sub.clause}
          ORDER BY ra.ticket_id ASC`,
      )
      .all(...sub.params) as ReadinessRow[];
  } catch (err) {
    // A read failure here (an old store with no readiness_assessments/tickets tables,
    // or a genuine read error) degrades THIS source alone rather than taking reviews
    // down with it — but it names itself in `degraded` so the inbox renders an explicit
    // unavailable marker, never a calm empty "no action needed" state (invariant #4).
    console.error("readinessAttentionItems: reading readiness items failed:", err);
    return { items: [], degraded: ["readiness"] };
  }
  const items: AttentionItem[] = rows.map((row) => {
    const blocked = row.outcome === "blocked";
    const gaps = safeParseGaps(row.gaps_json);
    const severity: AttentionSeverity = blocked ? "high" : "medium";
    const reason = blocked
      ? `Readiness is blocked${gaps.length ? `: ${gaps.join("; ")}` : "."}`
      : gaps.length
        ? `Acceptance criteria need refinement: ${gaps.join("; ")}`
        : "Acceptance criteria need refinement.";
    return {
      id: `readiness:${row.ticket_id}`,
      kind: "missing_acceptance_or_readiness",
      severity,
      startedAt: row.evaluated_at,
      reason,
      requestedAction: blocked
        ? "resolve the recorded blocker on the ticket, then re-run readiness"
        : "refine the ticket's acceptance criteria, then re-run readiness",
      openState: "open",
      source: "readiness",
      links: {
        runId: null,
        taskId: null,
        ticketId: row.ticket_id,
        campaignId: null,
        itemId: null,
        projectDir: null,
        projectLabel: null,
      },
    };
  });
  return { items, degraded: [] };
}

type OpenReviewRow = {
  id: string;
  run_id: string | null;
  subject_task_id: string | null;
  ticket_id: string | null;
  project_dir: string | null;
  updated_at: string | null;
  fix_now: number;
  arch_questions: number;
};

function reviewItems(db: Database, scope: InboxProjectScope): SourceResult {
  const project = projectDirScope(scope, "runs");
  let rows: OpenReviewRow[];
  try {
    rows = db
      .prepare(
        // Bounded-to-live (invariant #2): a review item is OPEN only while its parent RUN
        // is still active — mirrors the failure mapper's `r.status = 'active'` gate. The
        // INNER JOIN + active filter drops a review whose run has completed (or a review
        // with no run at all, which carries no liveness signal), so an open finding on a
        // finished run stops surfacing without a stored resolution flag.
        `SELECT reviews.id AS id, reviews.run_id AS run_id, reviews.subject_task_id AS subject_task_id,
                reviews.ticket_id AS ticket_id, runs.project_dir AS project_dir, reviews.updated_at AS updated_at,
                (SELECT COUNT(*) FROM review_findings f WHERE f.review_id = reviews.id
                   AND f.disposition = 'fix_now' AND (f.resolution IS NULL OR f.resolution != 'resolved')) AS fix_now,
                (SELECT COUNT(*) FROM review_findings f WHERE f.review_id = reviews.id
                   AND f.disposition = 'architecture_question') AS arch_questions
           FROM reviews JOIN runs ON runs.id = reviews.run_id
          WHERE reviews.state NOT IN ('settled', 'failed')
            AND runs.status = 'active'${project.clause}
          ORDER BY reviews.updated_at DESC, reviews.id DESC`,
      )
      .all(...project.params) as OpenReviewRow[];
  } catch (err) {
    // Same contract as readinessItems: a read failure degrades the review source alone
    // and names itself in `degraded` rather than swallowing to a calm empty inbox.
    console.error("readinessAttentionItems: reading review items failed:", err);
    return { items: [], degraded: ["review"] };
  }
  const items: AttentionItem[] = [];
  for (const row of rows) {
    if (row.fix_now === 0 && row.arch_questions === 0) continue;
    const parts: string[] = [];
    if (row.fix_now > 0) parts.push(`${row.fix_now} unresolved fix-now finding${row.fix_now === 1 ? "" : "s"}`);
    if (row.arch_questions > 0) parts.push(`${row.arch_questions} open architecture question${row.arch_questions === 1 ? "" : "s"}`);
    items.push({
      id: `review:${row.id}`,
      kind: "blocked_by_red_or_reviewer",
      severity: "high",
      startedAt: row.updated_at,
      reason: `Review is blocked — ${parts.join(", ")}.`,
      requestedAction:
        row.arch_questions > 0
          ? "answer the open architecture question(s), then continue the review"
          : "resolve the fix-now finding(s), then continue the review",
      openState: "open",
      source: "review",
      links: {
        runId: row.run_id,
        taskId: row.subject_task_id,
        ticketId: row.ticket_id,
        campaignId: null,
        itemId: null,
        projectDir: row.project_dir,
        projectLabel: null,
      },
    });
  }
  return { items, degraded: [] };
}

export function readinessAttentionItems(db: Database, scope: InboxProjectScope, _now: number): SourceResult {
  const readiness = readinessItems(db, scope);
  const reviews = reviewItems(db, scope);
  return { items: [...readiness.items, ...reviews.items], degraded: [...readiness.degraded, ...reviews.degraded] };
}
