// Direct better-sqlite3 reads of ~/.forge/forge.db.
//
// Row types are re-exported from forge's @forge/types so the dashboard and
// forge share the same shape. The inline `as Array<{...}>` casts in each
// query function still hardcode snake_case column names — until forge
// introduces a single source of truth for the SQL schema, those casts are
// the remaining drift surface (column rename = runtime failure, not compile
// error). Documented in docs/SCHEMA-CONTRACT.md.

import Database from "better-sqlite3";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Run, Task } from "@forge/types";
import { resolveProjectMeta } from "@forge/project-meta";
import { listProjects, sortProjects, type ProjectRecord } from "@forge/projects";

export { type ProjectRecord };

const FORGE_HOME = process.env.FORGE_HOME ?? join(homedir(), ".forge");
const DB_PATH = join(FORGE_HOME, "forge.db");
const RUNS_DIR = join(FORGE_HOME, "runs");

let _db: Database.Database | null = null;
function db(): Database.Database {
  if (_db) return _db;
  if (!existsSync(DB_PATH)) {
    throw new Error(`forge DB not found at ${DB_PATH}. Has forge run yet?`);
  }
  _db = new Database(DB_PATH, { readonly: true });
  // WAL readers don't block writers (forge uses WAL); no contention.
  return _db;
}

export type { Run, Task };

export type ActivityEntry = {
  taskId: string;
  runId: string;
  runTitle: string;
  workflow: string;
  projectDir: string | null;
  // Resolved at query time. label = basename(projectDir); color = .vscode
  // titleBar.activeBackground OR a deterministic hash fallback. Both null
  // when projectDir is null. See project-meta.ts.
  projectLabel: string | null;
  projectColor: string | null;
  agentRole: string;
  agentModel: string | null;
  phase: string;
  status: string;
  completedAt: string;
  result: unknown | null; // parsed JSON
  parentId: string | null;
};

/** Recent completed/failed agent outputs across all projects.
 *  Used for the activity feed. */
export function recentActivity(limit = 100, sinceIso?: string, projectDir?: string): ActivityEntry[] {
  let sql = `
    SELECT t.id, t.run_id, t.parent_id, t.phase, t.agent_role, t.agent_model, t.status, t.result, t.completed_at,
           r.title, r.workflow, r.project_dir
    FROM tasks t
    JOIN runs r ON r.id = t.run_id
    WHERE t.completed_at IS NOT NULL
      AND t.status IN ('complete', 'failed', 'blocked_by_red', 'awaiting_gate')
  `;
  const params: unknown[] = [];
  if (sinceIso) {
    sql += ` AND t.completed_at > ?`;
    params.push(sinceIso);
  }
  if (projectDir) {
    sql += ` AND r.project_dir = ?`;
    params.push(projectDir);
  }
  sql += ` ORDER BY t.completed_at DESC LIMIT ?`;
  params.push(limit);

  const rows = db().prepare(sql).all(...params) as Array<{
    id: string;
    run_id: string;
    parent_id: string | null;
    phase: string;
    agent_role: string;
    agent_model: string | null;
    status: string;
    result: string | null;
    completed_at: string;
    title: string;
    workflow: string;
    project_dir: string | null;
  }>;

  return rows.map((r) => {
    const meta = resolveProjectMeta(r.project_dir);
    return {
      taskId: r.id,
      runId: r.run_id,
      runTitle: r.title,
      workflow: r.workflow,
      projectDir: r.project_dir,
      projectLabel: meta?.label ?? null,
      projectColor: meta?.color ?? null,
      agentRole: r.agent_role,
      agentModel: r.agent_model,
      phase: r.phase,
      status: r.status,
      completedAt: r.completed_at,
      parentId: r.parent_id,
      result: r.result ? safeJsonParse(r.result) : null,
    };
  });
}

export type InFlightEntry = {
  runId: string;
  runTitle: string;
  workflow: string;
  projectDir: string | null;
  projectLabel: string | null;
  projectColor: string | null;
  taskId: string;
  agentRole: string;
  agentModel: string | null;
  phase: string;
  status: string;
  startedAt: string | null;
};

/** Tasks currently running, awaiting gate, awaiting red, or awaiting human input.
 *  Includes both primary tasks and red children. */
export function inFlight(projectDir?: string): InFlightEntry[] {
  const where = projectDir ? `AND r.project_dir = ?` : ``;
  const params = projectDir ? [projectDir] : [];
  const rows = db().prepare(`
    SELECT t.id, t.run_id, t.phase, t.agent_role, t.agent_model, t.status, t.started_at,
           r.title, r.workflow, r.project_dir
    FROM tasks t
    JOIN runs r ON r.id = t.run_id
    WHERE t.status IN ('running', 'awaiting_gate', 'awaiting_red', 'awaiting_human_input', 'blocked_by_red')
      AND r.status = 'active'
      ${where}
    ORDER BY t.started_at DESC NULLS LAST, t.created_at DESC
  `).all(...params) as Array<{
    id: string;
    run_id: string;
    phase: string;
    agent_role: string;
    agent_model: string | null;
    status: string;
    started_at: string | null;
    title: string;
    workflow: string;
    project_dir: string | null;
  }>;

  return rows.map((r) => {
    const meta = resolveProjectMeta(r.project_dir);
    return {
      runId: r.run_id,
      runTitle: r.title,
      workflow: r.workflow,
      projectDir: r.project_dir,
      projectLabel: meta?.label ?? null,
      projectColor: meta?.color ?? null,
      taskId: r.id,
      agentRole: r.agent_role,
      agentModel: r.agent_model,
      phase: r.phase,
      status: r.status,
      startedAt: r.started_at,
    };
  });
}

/** Full task detail including container.stdout.log + verdicts + gates. */
export type TaskDetail = {
  task: ActivityEntry;
  stdoutLog: string | null;
  stderrLog: string | null;
  verdicts: VerdictRow[];
  gates: GateRow[];
  events: TaskEventEntry[];   // WALK-5: lifecycle timeline
  failureKind: string | null; // WALK-5: machine-readable failure kind, if failed
  idle: IdleInfo | null;      // WALK-5: live activity, running tasks only
};

export type TaskEventEntry = {
  eventType: string;
  payload: unknown;
  createdAt: string;
};

// Live idle state for a running task. Mirrors the CLI's computeIdleCountdown
// (WALK-1); inlined here to keep the dashboard's read path self-contained.
export type IdleInfo = {
  hasOutput: boolean;
  idleMs: number;
  remainingMs: number;
  expired: boolean;
  idleTimeoutMs: number;
};

// Matches src/v2/idle-watchdog.ts DEFAULT_IDLE_TIMEOUT_MS (15m) for the fallback
// when a task's manifest predates the recorded-timeout field.
const DEFAULT_IDLE_TIMEOUT_MS = 15 * 60 * 1000;

function deriveFailureKind(events: TaskEventEntry[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (!e) continue;
    if (e.eventType === "task.completed") return null;
    if (e.eventType === "task.failed") {
      const p = e.payload as Record<string, unknown> | null;
      return p && typeof p["failure_kind"] === "string" ? (p["failure_kind"] as string) : null;
    }
  }
  return null;
}

function computeIdle(runId: string, taskId: string, status: string): IdleInfo | null {
  if (status !== "running") return null;
  const dir = join(RUNS_DIR, runId, taskId);
  let mtime: number | undefined;
  try { mtime = statSync(join(dir, "container.stdout.log")).mtimeMs; } catch { /* no output yet */ }
  let idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS;
  try {
    const m = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as { container?: { idleTimeoutMs?: unknown } };
    if (typeof m?.container?.idleTimeoutMs === "number") idleTimeoutMs = m.container.idleTimeoutMs;
  } catch { /* no/old manifest → default */ }
  if (mtime === undefined) {
    return { hasOutput: false, idleMs: 0, remainingMs: idleTimeoutMs, expired: false, idleTimeoutMs };
  }
  const idleMs = Math.max(0, Date.now() - mtime);
  const remainingMs = Math.max(0, idleTimeoutMs - idleMs);
  return { hasOutput: true, idleMs, remainingMs, expired: idleMs >= idleTimeoutMs, idleTimeoutMs };
}

export type VerdictRow = {
  id: string;
  taskId: string;
  redTaskId: string;
  redRole: string;
  verdict: string;
  confidence: number;
  authority: string;
  findings: unknown;
};

export type GateRow = {
  id: string;
  taskId: string;
  decision: string;
  rationale: string | null;
  decidedAt: string;
  decidedBy: string;
};

export function taskDetail(taskId: string): TaskDetail | null {
  const taskRow = db().prepare(`
    SELECT t.id, t.run_id, t.parent_id, t.phase, t.agent_role, t.agent_model, t.status, t.result, t.completed_at,
           t.error,
           r.title, r.workflow, r.project_dir
    FROM tasks t
    JOIN runs r ON r.id = t.run_id
    WHERE t.id = ?
  `).get(taskId) as
    | {
        id: string;
        run_id: string;
        parent_id: string | null;
        phase: string;
        agent_role: string;
        agent_model: string | null;
        status: string;
        result: string | null;
        completed_at: string | null;
        error: string | null;
        title: string;
        workflow: string;
        project_dir: string | null;
      }
    | undefined;
  if (!taskRow) return null;

  const taskMeta = resolveProjectMeta(taskRow.project_dir);
  const task: ActivityEntry = {
    taskId: taskRow.id,
    runId: taskRow.run_id,
    runTitle: taskRow.title,
    workflow: taskRow.workflow,
    projectDir: taskRow.project_dir,
    projectLabel: taskMeta?.label ?? null,
    projectColor: taskMeta?.color ?? null,
    agentRole: taskRow.agent_role,
    agentModel: taskRow.agent_model,
    phase: taskRow.phase,
    status: taskRow.status,
    completedAt: taskRow.completed_at ?? "",
    parentId: taskRow.parent_id,
    result: taskRow.result ? safeJsonParse(taskRow.result) : null,
  };

  const stdoutPath = join(RUNS_DIR, taskRow.run_id, taskId, "container.stdout.log");
  const stderrPath = join(RUNS_DIR, taskRow.run_id, taskId, "container.stderr.log");
  const stdoutLog = existsSync(stdoutPath) ? readFileSync(stdoutPath, "utf8") : null;
  const stderrLog = existsSync(stderrPath) ? readFileSync(stderrPath, "utf8") : null;

  const verdicts = db().prepare(`
    SELECT id, task_id, red_task_id, red_role, verdict, confidence, authority, findings
    FROM verdicts WHERE task_id = ? ORDER BY created_at ASC
  `).all(taskId) as Array<{
    id: string;
    task_id: string;
    red_task_id: string;
    red_role: string;
    verdict: string;
    confidence: number;
    authority: string;
    findings: string;
  }>;

  const gates = db().prepare(`
    SELECT id, task_id, decision, rationale, decided_at, decided_by
    FROM gates WHERE task_id = ? ORDER BY decided_at ASC
  `).all(taskId) as Array<{
    id: string;
    task_id: string;
    decision: string;
    rationale: string | null;
    decided_at: string;
    decided_by: string;
  }>;

  // WALK-5: lifecycle timeline from the events table (write-only until Crawl).
  const eventRows = db().prepare(`
    SELECT event_type, payload, created_at
    FROM events WHERE task_id = ? ORDER BY created_at ASC, id ASC
  `).all(taskId) as Array<{ event_type: string; payload: string | null; created_at: string }>;
  const events: TaskEventEntry[] = eventRows.map((e) => ({
    eventType: e.event_type,
    payload: e.payload ? safeJsonParse(e.payload) : null,
    createdAt: e.created_at,
  }));
  const failureKind = deriveFailureKind(events);
  const idle = computeIdle(taskRow.run_id, taskId, taskRow.status);

  return {
    task,
    stdoutLog,
    stderrLog,
    verdicts: verdicts.map((v) => ({
      id: v.id,
      taskId: v.task_id,
      redTaskId: v.red_task_id,
      redRole: v.red_role,
      verdict: v.verdict,
      confidence: v.confidence,
      authority: v.authority,
      findings: safeJsonParse(v.findings),
    })),
    gates: gates.map((g) => ({
      id: g.id,
      taskId: g.task_id,
      decision: g.decision,
      rationale: g.rationale,
      decidedAt: g.decided_at,
      decidedBy: g.decided_by,
    })),
    events,
    failureKind,
    idle,
  };
}

function safeJsonParse(s: string): unknown {
  try { return JSON.parse(s); }
  catch { return s; }
}

export type GroupBy = "role" | "workflow" | "project" | "model" | "alias";

export type UsageRollupRow = {
  bucket: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  requests: number;
};

export type UsageTimeSeriesRow = {
  date: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  requests: number;
};

export function usageRollup(groupBy: GroupBy, since: string, projectDir?: string, limit = 50): UsageRollupRow[] {
  const groupExpr: Record<GroupBy, string> = {
    role:     "COALESCE(t.agent_role, '(unknown role)')",
    workflow: "COALESCE(r.workflow,   '(unknown workflow)')",
    project:  "COALESCE(r.project_dir,'(unknown project)')",
    model:    "COALESCE(mc.model,     '(unknown model)')",
    alias:    "COALESCE(mc.alias,     '(no alias)')",
  };
  const params: unknown[] = [];
  let sinceClause = "";
  if (since !== "all") {
    const m = since.match(/^(\d+)d$/);
    if (m?.[1]) {
      const cutoff = new Date(Date.now() - parseInt(m[1], 10) * 86400_000).toISOString();
      sinceClause = "AND mc.created_at >= ?";
      params.push(cutoff);
    }
  }
  let projectClause = "";
  if (projectDir) {
    projectClause = "AND r.project_dir = ?";
    params.push(projectDir);
  }
  params.push(limit);

  const sql = `
    SELECT
      ${groupExpr[groupBy]} AS bucket,
      SUM(mc.input_tokens)          AS in_tok,
      SUM(mc.output_tokens)         AS out_tok,
      SUM(mc.cache_read_tokens)     AS read_tok,
      SUM(mc.cache_creation_tokens) AS create_tok,
      COUNT(*) AS req_count
    FROM model_calls mc
    LEFT JOIN tasks t ON t.id = mc.task_id
    LEFT JOIN runs  r ON r.id = t.run_id
    WHERE 1 = 1
      ${sinceClause}
      ${projectClause}
    GROUP BY bucket
    ORDER BY (SUM(mc.input_tokens) + SUM(mc.cache_creation_tokens) + SUM(mc.cache_read_tokens) + SUM(mc.output_tokens)) DESC
    LIMIT ?
  `;

  const rows = db().prepare(sql).all(...params) as Array<{
    bucket: string;
    in_tok: number;
    out_tok: number;
    read_tok: number;
    create_tok: number;
    req_count: number;
  }>;

  return rows.map((r) => ({
    bucket: r.bucket,
    inputTokens: r.in_tok ?? 0,
    outputTokens: r.out_tok ?? 0,
    cacheReadTokens: r.read_tok ?? 0,
    cacheCreationTokens: r.create_tok ?? 0,
    requests: r.req_count ?? 0,
  }));
}

export function usageTimeSeries(since = "30d", projectDir?: string): UsageTimeSeriesRow[] {
  const params: unknown[] = [];
  let sinceClause = "";
  if (since !== "all") {
    const m = since.match(/^(\d+)d$/);
    if (m?.[1]) {
      const cutoff = new Date(Date.now() - parseInt(m[1], 10) * 86400_000).toISOString();
      sinceClause = "AND mc.created_at >= ?";
      params.push(cutoff);
    }
  }
  let projectClause = "";
  if (projectDir) {
    projectClause = "AND r.project_dir = ?";
    params.push(projectDir);
  }

  const sql = `
    SELECT
      date(mc.created_at) AS day,
      SUM(mc.input_tokens)          AS in_tok,
      SUM(mc.output_tokens)         AS out_tok,
      SUM(mc.cache_read_tokens)     AS read_tok,
      SUM(mc.cache_creation_tokens) AS create_tok,
      COUNT(*) AS req_count
    FROM model_calls mc
    LEFT JOIN tasks t ON t.id = mc.task_id
    LEFT JOIN runs  r ON r.id = t.run_id
    WHERE 1 = 1
      ${sinceClause}
      ${projectClause}
    GROUP BY day
    ORDER BY day ASC
  `;

  const rows = db().prepare(sql).all(...params) as Array<{
    day: string;
    in_tok: number;
    out_tok: number;
    read_tok: number;
    create_tok: number;
    req_count: number;
  }>;

  return rows.map((r) => ({
    date: r.day,
    inputTokens: r.in_tok ?? 0,
    outputTokens: r.out_tok ?? 0,
    cacheReadTokens: r.read_tok ?? 0,
    cacheCreationTokens: r.create_tok ?? 0,
    requests: r.req_count ?? 0,
  }));
}

export type ModelMixBucket = {
  bucket: string;
  models: Array<{ model: string; weightedTokens: number; requests: number }>;
};

export function usageModelMix(groupBy: GroupBy, since: string, projectDir?: string): ModelMixBucket[] {
  const groupExpr: Record<GroupBy, string> = {
    role:     "COALESCE(t.agent_role, '(unknown role)')",
    workflow: "COALESCE(r.workflow,   '(unknown workflow)')",
    project:  "COALESCE(r.project_dir,'(unknown project)')",
    model:    "COALESCE(mc.model,     '(unknown model)')",
    alias:    "COALESCE(mc.alias,     '(no alias)')",
  };
  const params: unknown[] = [];
  let sinceClause = "";
  if (since !== "all") {
    const m = since.match(/^(\d+)d$/);
    if (m?.[1]) {
      const cutoff = new Date(Date.now() - parseInt(m[1], 10) * 86400_000).toISOString();
      sinceClause = "AND mc.created_at >= ?";
      params.push(cutoff);
    }
  }
  let projectClause = "";
  if (projectDir) {
    projectClause = "AND r.project_dir = ?";
    params.push(projectDir);
  }

  const sql = `
    SELECT
      ${groupExpr[groupBy]} AS bucket,
      mc.model,
      SUM(mc.input_tokens + 1.25*mc.cache_creation_tokens + 0.1*mc.cache_read_tokens + 5*mc.output_tokens) AS weighted,
      COUNT(*) AS requests
    FROM model_calls mc
    LEFT JOIN tasks t ON t.id = mc.task_id
    LEFT JOIN runs  r ON r.id = t.run_id
    WHERE 1 = 1
      ${sinceClause}
      ${projectClause}
    GROUP BY bucket, mc.model
    ORDER BY bucket, weighted DESC
  `;

  const rows = db().prepare(sql).all(...params) as Array<{
    bucket: string;
    model: string;
    weighted: number;
    requests: number;
  }>;

  const map = new Map<string, ModelMixBucket>();
  for (const row of rows) {
    if (!map.has(row.bucket)) map.set(row.bucket, { bucket: row.bucket, models: [] });
    map.get(row.bucket)!.models.push({
      model: row.model ?? "(unknown model)",
      weightedTokens: row.weighted ?? 0,
      requests: row.requests ?? 0,
    });
  }
  return [...map.values()];
}

// #154: project registry for the dashboard Projects view.
// Delegates to the shared listProjects() (#152) so the dashboard sees the
// same union of DB-derived + filesystem-scanned projects as `forge projects
// list`, plus live-session counts from `~/.forge/orchestrators/` (#153).
//
// NB: this opens a second SQLite handle inside the dashboard process (the
// shared store/db.ts cache is per-module and separate from queries.ts's
// readonly handle above). On a fresh install with no DB, getDb() will create
// the schema; on a real install it's a no-op. Acceptable cost.
export function projectsForDashboard(): ProjectRecord[] {
  return sortProjects(listProjects(), "activity");
}
