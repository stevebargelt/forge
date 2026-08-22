// FG-402 (c): the FAILURE / PARK mapper.
//
// Reads failed / blocked_by_red tasks on ACTIVE runs and maps the ones that need a
// HUMAN — auth/setup walls, merge conflicts, ordered-fanout integration parks, and
// red/reviewer blocks — into inbox items. It is a PURE persisted-state read: no git,
// gh, tmux, docker, or CLI subprocess (protected_invariant #1). The failure_kind is
// resolved from the newest `task.failed` event (there is no failure_kind column), and
// an item is emitted ONLY while its run is still active and the failed task is the
// current terminal state — a re-dispatched task flips its status away from failed, so
// reading the LIVE status IS the currency gate (mirrors FG-694).
//
// Transient, forge-auto-recoverable failures (container_crash, idle_timeout, the
// awaiting_recovery states, etc.) are deliberately NOT surfaced: they map to no inbox
// kind, so the switch below drops them. Only the four typed human-action blockers the
// Acceptance Criteria name are emitted.

import type { Database } from "better-sqlite3";
import { basename } from "node:path";
import { redactSecrets } from "../../src/v2/host-readiness.js";
import { retryPolicy } from "../../src/v2/retry-policy.js";
import type { AttentionItem, AttentionItemKind } from "./attention-inbox.js";

/** Same shape as queries.ProjectScope, redeclared so this module needs no import from
 *  queries.ts (which imports this module — a cycle we do not want at type level). */
export type InboxProjectScope = string | readonly string[] | undefined;

type FailedTaskRow = {
  task_id: string;
  run_id: string;
  status: string;
  started_at: string | null;
  project_dir: string | null;
  ticket_id: string | null;
  failure_kind: string | null;
};

function hasColumn(db: Database, table: string, column: string): boolean {
  // PRAGMA table_info returns zero rows for a missing table rather than throwing, so
  // a store whose runs table predates the metadata column reads back false here rather
  // than taking the whole read down when json_extract names a column that is not there.
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return rows.some((r) => r.name === column);
}

function projectDirScope(scope: InboxProjectScope, qualifier: string): { clause: string; params: string[] } {
  if (scope === undefined) return { clause: "", params: [] };
  const dirs = typeof scope === "string" ? [scope] : [...scope];
  if (dirs.length === 0) return { clause: " AND 1 = 0", params: [] };
  return { clause: ` AND ${qualifier}.project_dir IN (${dirs.map(() => "?").join(", ")})`, params: dirs };
}

/** failure_kind / task status → the inbox kind, or null when the failure is not a
 *  human-action blocker (transient / auto-recoverable / out of the initial typed set).
 *  A blocked_by_red STATUS is a reviewer block regardless of any recorded kind. */
function itemKindFor(status: string, failureKind: string | null): AttentionItemKind | null {
  if (status === "blocked_by_red") return "blocked_by_red_or_reviewer";
  switch (failureKind) {
    case "auth_missing":
    case "auth_expired":
    case "auth_injection_failed":
      return "auth_setup";
    case "merge_conflict":
      return "merge_conflict";
    case "integration_blocked":
      return "integration_blocked_park";
    case "red_blocked":
    case "blocked_by_red":
      return "blocked_by_red_or_reviewer";
    default:
      return null;
  }
}

/** The retry-policy KEY to explain the failure. A blocked_by_red status carries no
 *  failure_kind of its own, so it is explained through the red_blocked policy. */
function policyKindFor(status: string, failureKind: string | null): string {
  if (status === "blocked_by_red") return failureKind ?? "red_blocked";
  return failureKind ?? "unknown";
}

export function failureAttentionItems(db: Database, scope: InboxProjectScope, _now: number): AttentionItem[] {
  const metadataPresent = hasColumn(db, "runs", "metadata");
  const ticketSelect = metadataPresent
    ? `COALESCE(json_extract(r.metadata, '$.inputs.ticketId'), json_extract(r.metadata, '$.ticketId'))`
    : `NULL`;
  const project = projectDirScope(scope, "r");
  const rows = db
    .prepare(
      `SELECT t.id AS task_id, t.run_id AS run_id, t.status AS status, t.started_at AS started_at,
              r.project_dir AS project_dir,
              ${ticketSelect} AS ticket_id,
              (SELECT json_extract(e.payload, '$.failure_kind') FROM events e
                 WHERE e.task_id = t.id AND e.event_type = 'task.failed'
                 ORDER BY e.id DESC LIMIT 1) AS failure_kind
         FROM tasks t JOIN runs r ON r.id = t.run_id
        WHERE r.status = 'active' AND t.status IN ('failed', 'blocked_by_red')${project.clause}
        ORDER BY t.started_at ASC, t.id ASC`,
    )
    .all(...project.params) as FailedTaskRow[];

  const items: AttentionItem[] = [];
  for (const row of rows) {
    const kind = itemKindFor(row.status, row.failure_kind);
    if (kind === null) continue;
    const disposition = retryPolicy(policyKindFor(row.status, row.failure_kind), row.task_id);
    const requestedAction = disposition.advice ?? `inspect the failed task (\`forge show ${row.task_id}\`)`;
    // The auth item text is routed through redactSecrets whether or not the curated
    // policy strings carry a secret — the mandate is unconditional, and redactSecrets
    // is idempotent, so a clean string passes through untouched.
    const redact = kind === "auth_setup";
    items.push({
      id: `task:${row.task_id}`,
      kind,
      severity: "high",
      startedAt: row.started_at,
      reason: redact ? redactSecrets(disposition.reason) : disposition.reason,
      requestedAction: redact ? redactSecrets(requestedAction) : requestedAction,
      openState: "open",
      source: "task",
      links: {
        runId: row.run_id,
        taskId: row.task_id,
        ticketId: row.ticket_id,
        campaignId: null,
        itemId: null,
        projectDir: row.project_dir,
        projectLabel: row.project_dir ? basename(row.project_dir) : null,
      },
    });
  }
  return items;
}
