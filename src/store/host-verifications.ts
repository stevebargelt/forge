import path from "node:path";
import { getDb } from "./db.js";

// FG-431: LOOKUP exact-matches project_dir, but callers (the CLI recorder, the
// reconcile-time auto-capture writer) may hand in a relative or otherwise
// non-canonical path. Canonicalizing to the same absolute form on both the
// insert and the lookup side means a row recorded with an equivalent-but-not-
// identical path string is still found by reconcile — without loosening any
// other match dimension (ticket_id, gate_name, commit_sha stay exact).
function canonicalizeProjectDir(projectDir: string): string {
  return path.resolve(projectDir);
}

export type HostVerificationRow = {
  id?: number;
  ticketId: string;
  projectDir: string;
  commitSha: string;
  gateName: string;
  command: string;
  exitCode: number;
  runId?: string | null;
  recordedAt: string;
};

type DbRow = {
  id: number;
  ticket_id: string;
  project_dir: string;
  commit_sha: string;
  gate_name: string;
  command: string;
  exit_code: number;
  run_id: string | null;
  recorded_at: string;
};

function rowToVerification(row: DbRow): HostVerificationRow {
  return {
    id: row.id,
    ticketId: row.ticket_id,
    projectDir: row.project_dir,
    commitSha: row.commit_sha,
    gateName: row.gate_name,
    command: row.command,
    exitCode: row.exit_code,
    runId: row.run_id,
    recordedAt: row.recorded_at,
  };
}

function runInsert(v: Omit<HostVerificationRow, "id">, runId: string | null): void {
  getDb()
    .prepare(
      `INSERT INTO host_verifications (ticket_id, project_dir, commit_sha, gate_name, command, exit_code, run_id, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(v.ticketId, v.projectDir, v.commitSha, v.gateName, v.command, v.exitCode, runId, v.recordedAt);
}

// run_id references runs(id) — a run row pruned between dispatch and this write
// leaves run_id dangling, and that must not cost us a REAL gate result. Retry
// exactly once, with run_id nulled, but ONLY when the failure is specifically
// that FK violation; any other DB error (bad column, disk full, etc.) is a real
// error and must surface, not be silently assumed away.
function isDanglingRunIdForeignKeyError(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return code === "SQLITE_CONSTRAINT_FOREIGNKEY";
}

export function insertHostVerification(v: Omit<HostVerificationRow, "id">): void {
  const canonical = { ...v, projectDir: canonicalizeProjectDir(v.projectDir) };
  try {
    runInsert(canonical, canonical.runId ?? null);
  } catch (err) {
    if (canonical.runId && isDanglingRunIdForeignKeyError(err)) {
      runInsert(canonical, null);
      return;
    }
    throw err;
  }
}

export function queryHostVerificationRows(
  ticketId: string,
  projectDir: string,
  commitSha: string,
  gateName: string
): HostVerificationRow[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM host_verifications
       WHERE ticket_id = ? AND project_dir = ? AND commit_sha = ? AND gate_name = ?
       ORDER BY recorded_at ASC`
    )
    .all(ticketId, canonicalizeProjectDir(projectDir), commitSha, gateName) as DbRow[];
  return rows.map(rowToVerification);
}

// FG-440: unfiltered by commit_sha — reconcile-collect.ts's ancestry-based
// coverage check needs every recorded row for this ticket+project+gate so it
// can test each row's commit_sha for ancestry, not just an exact-sha match.
export function queryHostVerificationRowsForGate(
  ticketId: string,
  projectDir: string,
  gateName: string
): HostVerificationRow[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM host_verifications
       WHERE ticket_id = ? AND project_dir = ? AND gate_name = ?
       ORDER BY recorded_at ASC`
    )
    .all(ticketId, canonicalizeProjectDir(projectDir), gateName) as DbRow[];
  return rows.map(rowToVerification);
}
