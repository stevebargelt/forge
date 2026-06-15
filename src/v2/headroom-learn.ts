import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getDb } from "../store/db.js";
import { taskDir } from "../util/paths.js";
import type { Task, TaskPackage } from "../types/index.js";

export type FailedRunRow = {
  task: Task;
  runId: string;
  agentRole: string;
  completedAt: string | null;
  error: string | null;
  projectDir: string | null;
};

type TaskDbRow = {
  id: string;
  run_id: string;
  agent_role: string;
  status: string;
  task_package: string;
  result: string | null;
  completed_at: string | null;
  error: string | null;
};


export function detectFailedRuns(opts: {
  agentRole?: string;
  sinceMs?: number;
  limit?: number;
}): FailedRunRow[] {
  const db = getDb({ readOnly: true });

  let sql = `
    SELECT t.id, t.run_id, t.agent_role, t.status, t.task_package, t.result,
           t.completed_at, t.error, r.project_dir
    FROM tasks t
    JOIN runs r ON r.id = t.run_id
    WHERE t.status = 'failed'
  `;
  const params: (string | number)[] = [];

  if (opts.agentRole) {
    sql += ` AND t.agent_role = ?`;
    params.push(opts.agentRole);
  }
  if (opts.sinceMs !== undefined) {
    const iso = new Date(opts.sinceMs).toISOString();
    sql += ` AND t.completed_at >= ?`;
    params.push(iso);
  }

  sql += ` ORDER BY t.completed_at DESC`;

  if (opts.limit !== undefined) {
    sql += ` LIMIT ?`;
    params.push(opts.limit);
  }

  const rows = db.prepare(sql).all(...params) as Array<TaskDbRow & { project_dir: string | null }>;

  return rows.map((row) => ({
    task: {
      id: row.id,
      runId: row.run_id,
      phase: "",
      agentRole: row.agent_role,
      status: "failed" as const,
      taskPackage: JSON.parse(row.task_package) as TaskPackage,
      result: row.result ? (JSON.parse(row.result) as unknown) : undefined,
      completedAt: row.completed_at ?? undefined,
      error: row.error ?? undefined,
      createdAt: "",
    },
    runId: row.run_id,
    agentRole: row.agent_role,
    completedAt: row.completed_at,
    error: row.error,
    projectDir: row.project_dir,
  }));
}

export type FailureLogs = {
  taskId: string;
  agentRole: string;
  error: string | null;
  resultJson: unknown | null;
  stderr: string | null;
};

export function extractFailureLogs(row: FailedRunRow): FailureLogs {
  const dir = taskDir(row.runId, row.task.id);
  let resultJson: unknown | null = null;
  let stderr: string | null = null;

  const resultPath = resolve(dir, "result.json");
  if (existsSync(resultPath)) {
    try { resultJson = JSON.parse(readFileSync(resultPath, "utf8")); } catch { /* malformed, leave null */ }
  }

  const stderrPath = resolve(dir, "stderr.log");
  if (existsSync(stderrPath)) {
    stderr = readFileSync(stderrPath, "utf8").slice(-8000); // last 8KB
  }

  return {
    taskId: row.task.id,
    agentRole: row.agentRole,
    error: row.error,
    resultJson,
    stderr,
  };
}

export type HeadroomLearnResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

export function runHeadroomLearn(opts: {
  projectDir: string;
  apply?: boolean;
  model?: string;
}): HeadroomLearnResult {
  const args = ["learn", "--project", opts.projectDir];
  if (opts.apply) args.push("--apply");
  if (opts.model) { args.push("--model", opts.model); }

  const result = spawnSync("headroom", args, {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });

  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    exitCode: result.status ?? 1,
  };
}

export type SeedCorrection = {
  file: string;
  summary: string;
};

export function parseSeedCorrections(learnOutput: string): SeedCorrection[] {
  // headroom learn prints the files it updated or would update.
  // Lines like: "  Writing CLAUDE.md" or "  Would write CLAUDE.md" indicate proposed changes.
  const corrections: SeedCorrection[] = [];
  const lines = learnOutput.split("\n");
  for (const line of lines) {
    const writeMatch = line.match(/(?:Writing|Would write|Updated|Would update)\s+(.+\.md)/i);
    if (writeMatch?.[1]) {
      corrections.push({ file: writeMatch[1].trim(), summary: line.trim() });
    }
  }
  return corrections;
}

export function projectDirsFromFailedRuns(rows: FailedRunRow[]): string[] {
  const seen = new Set<string>();
  for (const row of rows) {
    if (row.projectDir) seen.add(row.projectDir);
  }
  return [...seen];
}
