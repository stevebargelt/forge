import { getDb } from "./db.js";
import { nowIso } from "../util/ids.js";

export type EventType =
  | "run.created"
  | "run.completed"
  | "task.created"
  | "task.started"
  | "task.completed"
  | "task.failed"
  | "task.crashed"
  | "task.idle_timeout"
  | "task.blocked_by_red"
  | "task.awaiting_red"
  | "task.submitted"
  | "task.retried"
  | "verdict.received"
  | "gate.decided";

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
