import { getDb } from "./db.js";
import type { GateDecision } from "../types/index.js";

export type GateRow = {
  id: string;
  taskId: string;
  decision: GateDecision;
  rationale?: string;
  decidedAt: string;
  decidedBy: string;
};

type Row = {
  id: string;
  task_id: string;
  decision: string;
  rationale: string | null;
  decided_at: string;
  decided_by: string;
};

function rowToGate(row: Row): GateRow {
  return {
    id: row.id,
    taskId: row.task_id,
    decision: row.decision as GateDecision,
    rationale: row.rationale ?? undefined,
    decidedAt: row.decided_at,
    decidedBy: row.decided_by,
  };
}

export function insertGate(g: GateRow): void {
  getDb()
    .prepare(
      `INSERT INTO gates (id, task_id, decision, rationale, decided_at, decided_by)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(g.id, g.taskId, g.decision, g.rationale ?? null, g.decidedAt, g.decidedBy);
}

export function gatesForTask(taskId: string): GateRow[] {
  const rows = getDb()
    .prepare(`SELECT * FROM gates WHERE task_id = ? ORDER BY decided_at ASC`)
    .all(taskId) as Row[];
  return rows.map(rowToGate);
}
