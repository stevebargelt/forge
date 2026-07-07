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
  | "container.dependency_provisioning_failed"
  // FG-437: durable phase-boundary markers around the (separate, short-lived)
  // dependency provisioner container, so a mid-provision crash is visible to
  // reconcile even though the task's own container.started hasn't fired yet.
  | "container.provision_started"
  | "container.provision_succeeded"
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
  | "campaign_item.evidence_reconciled"
  // FG-443: operator-triggered `campaign reconcile` shipped an awaiting_gate item
  // that was delivered outside the feature pipeline (re-routed lane), after
  // re-deriving delivery from durable evidence. Distinct from
  // campaign_item.evidence_reconciled — that event covers the scope-blocked
  // stale-red-fail shape; this one covers the non-pipeline/awaiting_gate shape.
  | "campaign_item.out_of_band_reconciled"
  // FG-441 red-review fix: `campaign resume`'s manually-driven awaiting_gate
  // reconcile branch found evidence incomplete and refused to ship, re-parking
  // the item. Durable counterpart to the console.error refusal message — under
  // a cron/service invocation stderr may not be captured, so this is the only
  // audit trail of the refusal decision.
  | "campaign_item.evidence_reconcile_refused"
  // FG-490 (review F7): the drive path (runNext/startRun) threw instead of
  // returning a structured failure. Durable record of the thrown error, taken
  // BEFORE the campaign is parked to 'paused' and the error is rethrown to the
  // caller — the only audit trail of the raw error under a cron/service
  // invocation where stderr may not be captured.
  | "campaign_item.drive_error";

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
