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

export function insertGate(g: GateRow): void {
  getDb()
    .prepare(
      `INSERT INTO gates (id, task_id, decision, rationale, decided_at, decided_by)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(g.id, g.taskId, g.decision, g.rationale ?? null, g.decidedAt, g.decidedBy);
}
