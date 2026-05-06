import { getDb } from "./db.js";
import type { VerdictRow, Finding, RedAuthority } from "../types/index.js";

type Row = {
  id: string;
  task_id: string;
  red_task_id: string;
  red_role: string;
  verdict: string;
  confidence: number;
  authority: string;
  findings: string;
  created_at: string;
};

function rowToVerdict(row: Row): VerdictRow {
  return {
    id: row.id,
    taskId: row.task_id,
    redTaskId: row.red_task_id,
    redRole: row.red_role,
    verdict: row.verdict as VerdictRow["verdict"],
    confidence: row.confidence,
    authority: row.authority as RedAuthority,
    findings: JSON.parse(row.findings) as Finding[],
    createdAt: row.created_at,
  };
}

export function insertVerdict(v: VerdictRow): void {
  getDb()
    .prepare(
      `INSERT INTO verdicts (id, task_id, red_task_id, red_role, verdict, confidence, authority, findings, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      v.id,
      v.taskId,
      v.redTaskId,
      v.redRole,
      v.verdict,
      v.confidence,
      v.authority,
      JSON.stringify(v.findings),
      v.createdAt
    );
}

export function verdictsForTask(taskId: string): VerdictRow[] {
  const rows = getDb()
    .prepare(`SELECT * FROM verdicts WHERE task_id = ? ORDER BY created_at ASC`)
    .all(taskId) as Row[];
  return rows.map(rowToVerdict);
}
