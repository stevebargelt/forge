import { getDb } from "./db.js";
import { nowIso } from "../util/ids.js";

export type EventType =
  | "run.created"
  | "run.completed"
  | "run.reactivated"
  | "run.reconciled"
  | "run.cancelled"
  | "run.abandoned"
  | "task.created"
  | "task.started"
  | "task.completed"
  | "task.failed"
  | "task.cancelled"
  | "task.blocked_by_red"
  | "task.awaiting_red"
  | "task.awaiting_gate"
  | "task.retried"
  | "task.reconciled"
  | "task.progress"
  | "task.artifact"
  | "task.decision"
  | "verdict.received"
  | "verdict.findings_dropped"
  | "gate.decided"
  | "container.started"
  | "container.exited"
  | "container.killed"
  | "container.idle_timeout"
  | "auth.profile_applied"
  | "auth.profile_failed"
  // AWN-7 model resolution (policy mode). profile_resolved: a task resolved to a
  // profile/model. profile_unavailable: fail-loud — resolved auth has no working
  // credentials. fallback_applied: a same-capability lower-cost substitution was
  // made (vocabulary reserved for Walk/Run; not emitted in Crawl).
  | "model.profile_resolved"
  | "model.profile_unavailable"
  | "model.fallback_applied"
  // #202/#203: an orchestrator-declared checkpoint (forge notify milestone). The
  // orchestrator owns *meaning*; forge owns delivery/dedupe/policy. Always
  // recorded (audit trail) regardless of whether a push was sent.
  | "orchestrator.milestone"
  // FG-353: worktree integration git mutation events for forge show / dashboard.
  | "integration.worktree_created"
  | "integration.child_merged"
  | "integration.merged_to_head"
  // FG-428: operator-triggered `campaign reconcile` shipped a wedged item after
  // re-deriving its outcome from durable evidence. Distinct from run.reconciled /
  // task.reconciled (crash-recovery) — this is a trust-gate write, not a crash repair.
  | "campaign_item.evidence_reconciled";

export type Event = {
  id: number;
  runId: string | null;
  taskId: string | null;
  eventType: EventType;
  payload: unknown;
  createdAt: string;
};

type EventRow = {
  id: number;
  run_id: string | null;
  task_id: string | null;
  event_type: string;
  payload: string | null;
  created_at: string;
};

function rowToEvent(row: EventRow): Event {
  return {
    id: row.id,
    runId: row.run_id,
    taskId: row.task_id,
    eventType: row.event_type as EventType,
    payload: row.payload !== null ? (JSON.parse(row.payload) as unknown) : null,
    createdAt: row.created_at,
  };
}

export function eventsForTask(taskId: string): Event[] {
  const rows = getDb({ readOnly: true })
    .prepare(`SELECT * FROM events WHERE task_id = ? ORDER BY created_at ASC, id ASC`)
    .all(taskId) as EventRow[];
  return rows.map(rowToEvent);
}

export function eventsForRun(runId: string): Event[] {
  const rows = getDb({ readOnly: true })
    .prepare(`SELECT * FROM events WHERE run_id = ? ORDER BY created_at ASC, id ASC`)
    .all(runId) as EventRow[];
  return rows.map(rowToEvent);
}

export function logEvent(
  eventType: EventType,
  opts: { runId?: string; taskId?: string; payload?: unknown } = {}
): void {
  getDb()
    .prepare(
      `INSERT INTO events (run_id, task_id, event_type, payload, created_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(
      opts.runId ?? null,
      opts.taskId ?? null,
      eventType,
      opts.payload ? JSON.stringify(opts.payload) : null,
      nowIso()
    );
}
