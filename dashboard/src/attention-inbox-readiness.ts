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
// predating one of the tables degrades that source alone rather than the whole mapper.

import type { Database } from "better-sqlite3";
import type { AttentionItem, AttentionSeverity } from "./attention-inbox.js";
import type { InboxProjectScope } from "./attention-inbox-failures.js";

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

function readinessItems(db: Database, scope: InboxProjectScope): AttentionItem[] {
  const sub = projectDirSubquery(scope);
  let rows: ReadinessRow[];
  try {
    rows = db
      .prepare(
        `SELECT ra.ticket_id AS ticket_id, ra.outcome AS outcome, ra.gaps_json AS gaps_json,
                ra.evaluated_at AS evaluated_at, t.title AS title
           FROM readiness_assessments ra
           JOIN tickets t ON t.project_key = ra.project_key AND t.ticket_id = ra.ticket_id
          WHERE t.status = 'active'
            AND ra.outcome IN ('needs_refinement', 'blocked')
            AND ra.body_hash = t.body_hash${sub.clause}
          ORDER BY ra.ticket_id ASC`,
      )
      .all(...sub.params) as ReadinessRow[];
  } catch {
    // An old store with no readiness_assessments/tickets tables: this source degrades
    // to nothing rather than taking the reviews source down with it.
    return [];
  }
  return rows.map((row) => {
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

function reviewItems(db: Database, scope: InboxProjectScope): AttentionItem[] {
  const project = projectDirScope(scope, "runs");
  let rows: OpenReviewRow[];
  try {
    rows = db
      .prepare(
        `SELECT reviews.id AS id, reviews.run_id AS run_id, reviews.subject_task_id AS subject_task_id,
                reviews.ticket_id AS ticket_id, runs.project_dir AS project_dir, reviews.updated_at AS updated_at,
                (SELECT COUNT(*) FROM review_findings f WHERE f.review_id = reviews.id
                   AND f.disposition = 'fix_now' AND (f.resolution IS NULL OR f.resolution != 'resolved')) AS fix_now,
                (SELECT COUNT(*) FROM review_findings f WHERE f.review_id = reviews.id
                   AND f.disposition = 'architecture_question') AS arch_questions
           FROM reviews LEFT JOIN runs ON runs.id = reviews.run_id
          WHERE reviews.state NOT IN ('settled', 'failed')${project.clause}
          ORDER BY reviews.updated_at DESC, reviews.id DESC`,
      )
      .all(...project.params) as OpenReviewRow[];
  } catch {
    return [];
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
  return items;
}

export function readinessAttentionItems(db: Database, scope: InboxProjectScope, _now: number): AttentionItem[] {
  return [...readinessItems(db, scope), ...reviewItems(db, scope)];
}
