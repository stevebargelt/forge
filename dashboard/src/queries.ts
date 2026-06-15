// Direct better-sqlite3 reads of ~/.forge/forge.db.
//
// Row types are re-exported from forge's @forge/types so the dashboard and
// forge share the same shape. The inline `as Array<{...}>` casts in each
// query function still hardcode snake_case column names — until forge
// introduces a single source of truth for the SQL schema, those casts are
// the remaining drift surface (column rename = runtime failure, not compile
// error). Documented in docs/SCHEMA-CONTRACT.md.

import Database from "better-sqlite3";
import { existsSync, readFileSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Run, Task } from "@forge/types";
import { resolveProjectMeta } from "@forge/project-meta";
import { listProjects, sortProjects, type ProjectRecord } from "@forge/projects";
import { governanceView, type GovernanceView } from "@forge/governance";
import {
  findReconcileCandidates,
  type LivenessProbe,
  type ReconcileClassification,
  type ReconcileReason,
} from "@forge/reconcile-candidate";

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
  /** Wall-clock run-time (started_at → completed_at) in ms; null if either is missing. */
  durationMs: number | null;
  result: unknown | null; // parsed JSON
  parentId: string | null;
};

/** Recent completed/failed agent outputs across all projects.
 *  Used for the activity feed. */
export function recentActivity(limit = 100, sinceIso?: string, projectDir?: string): ActivityEntry[] {
  let sql = `
    SELECT t.id, t.run_id, t.parent_id, t.phase, t.agent_role, t.agent_model, t.status, t.result, t.started_at, t.completed_at,
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
    started_at: string | null;
    completed_at: string;
    title: string;
    workflow: string;
    project_dir: string | null;
  }>;

  return rows.map((r) => {
    const meta = resolveProjectMeta(r.project_dir);
    const durationMs = r.started_at
      ? Math.max(0, new Date(r.completed_at).getTime() - new Date(r.started_at).getTime())
      : null;
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
      durationMs,
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
  /** #290: non-null only when this running task's container is GONE — the DB row
   *  is stale and needs reconciliation. The dashboard badges it as a reconcile
   *  candidate instead of ordinary running. Null for healthy/non-running tasks.
   *  Read-only: derived from a docker + result.json probe, never reconciled here. */
  reconcile: { classification: ReconcileClassification; reason: ReconcileReason } | null;
};

/** Tasks currently running, awaiting gate, awaiting red, or awaiting human input.
 *  Includes both primary tasks and red children.
 *
 *  Running tasks are additionally classified against container liveness (#290):
 *  a `running` row whose container is gone is annotated as a reconcile candidate
 *  so the dashboard stops faithfully showing stale `running`. The probe is
 *  injectable for tests; the classifier only docker-probes running+containerized
 *  tasks. Detection is read-only — the dashboard never calls reconcileRun. */
export function inFlight(projectDir?: string, probe?: LivenessProbe): InFlightEntry[] {
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

  // #290: classify running+containerized tasks by liveness once, map by taskId.
  // Only `reconcile_candidate` (container gone) becomes an annotation; alive,
  // liveness_unknown, and anomalous tasks render as ordinary running.
  const candidates = new Map(
    findReconcileCandidates(db(), { projectDir }, probe)
      .filter((c) => c.classification === "reconcile_candidate")
      .map((c) => [c.taskId, { classification: c.classification, reason: c.reason }])
  );

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
      reconcile: candidates.get(r.id) ?? null,
    };
  });
}

/** Full task detail including container log tails + verdicts + gates. */
export type TaskDetail = {
  task: ActivityEntry;
  stdoutLog: string | null;  // bounded TAIL (last LOG_TAIL_BYTES), not the whole file
  stderrLog: string | null;
  stdoutBytes: number;       // true on-disk size, so the UI can label honestly
  stderrBytes: number;
  verdicts: VerdictRow[];
  gates: GateRow[];
  events: TaskEventEntry[];   // WALK-5: lifecycle timeline
  failureKind: string | null; // WALK-5: machine-readable failure kind, if failed
  idle: IdleInfo | null;      // WALK-5: live activity, running tasks only
};

// The dashboard polls running-task detail every 3s; reading whole multi-MB
// stream-json logs each tick would undo the bounded-tail discipline elsewhere.
// Read only the trailing window (most-recent activity); report the true size.
const LOG_TAIL_BYTES = 64 * 1024;

function readLogTail(path: string): { text: string | null; bytes: number } {
  let bytes: number;
  try { bytes = statSync(path).size; } catch { return { text: null, bytes: 0 }; }
  if (bytes === 0) return { text: "", bytes: 0 };
  const readBytes = Math.min(bytes, LOG_TAIL_BYTES);
  const buf = Buffer.alloc(readBytes);
  const fd = openSync(path, "r");
  try { readSync(fd, buf, 0, readBytes, bytes - readBytes); } finally { closeSync(fd); }
  return { text: buf.toString("utf8"), bytes };
}

export type TaskEventEntry = {
  eventType: string;
  payload: unknown;
  createdAt: string;
};

// Live idle state for a running task. Mirrors the CLI's computeIdleCountdown
// (WALK-1); inlined here to keep the dashboard's read path self-contained. The
// watchdog measures idle from the last stdout write, falling back to spawn time
// when no stdout has arrived — so a hung agent still counts down and expires.
export type IdleInfo = {
  hasOutput: boolean;
  idleMs: number;
  remainingMs: number;
  expired: boolean;
  idleTimeoutMs: number;
  measured: boolean;
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

function computeIdle(runId: string, taskId: string, status: string, startedAt: string | null): IdleInfo | null {
  if (status !== "running") return null;
  const dir = join(RUNS_DIR, runId, taskId);
  let mtime: number | undefined;
  try { mtime = statSync(join(dir, "container.stdout.log")).mtimeMs; } catch { /* no output yet */ }
  let idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS;
  try {
    const m = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as { container?: { idleTimeoutMs?: unknown } };
    if (typeof m?.container?.idleTimeoutMs === "number") idleTimeoutMs = m.container.idleTimeoutMs;
  } catch { /* no/old manifest → default */ }
  const startedAtMs = startedAt ? new Date(startedAt).getTime() : undefined;
  const baseline = mtime ?? startedAtMs;
  const hasOutput = mtime !== undefined;
  if (baseline === undefined || Number.isNaN(baseline)) {
    return { hasOutput, idleMs: 0, remainingMs: idleTimeoutMs, expired: false, idleTimeoutMs, measured: false };
  }
  const idleMs = Math.max(0, Date.now() - baseline);
  const remainingMs = Math.max(0, idleTimeoutMs - idleMs);
  return { hasOutput, idleMs, remainingMs, expired: idleMs >= idleTimeoutMs, idleTimeoutMs, measured: true };
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
           t.error, t.started_at,
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
        started_at: string | null;
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
    durationMs: taskRow.started_at && taskRow.completed_at
      ? Math.max(0, new Date(taskRow.completed_at).getTime() - new Date(taskRow.started_at).getTime())
      : null,
    parentId: taskRow.parent_id,
    result: taskRow.result ? safeJsonParse(taskRow.result) : null,
  };

  const stdoutPath = join(RUNS_DIR, taskRow.run_id, taskId, "container.stdout.log");
  const stderrPath = join(RUNS_DIR, taskRow.run_id, taskId, "container.stderr.log");
  const stdout = readLogTail(stdoutPath);
  const stderr = readLogTail(stderrPath);

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
  const idle = computeIdle(taskRow.run_id, taskId, taskRow.status, taskRow.started_at);

  return {
    task,
    stdoutLog: stdout.text,
    stderrLog: stderr.text,
    stdoutBytes: stdout.bytes,
    stderrBytes: stderr.bytes,
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

// RUN-3: operations metrics for the dashboard ops view. Mirrors the CLI's
// `forge metrics` (src/v2/metrics.ts) shape, computed via the dashboard's
// read-only db() to keep the dashboard self-contained. Distinct from usage
// (token/cost).
export type OpsMetrics = {
  runs: { total: number; active: number; terminal: number; clean: number; withFailures: number; successRate: number };
  taskCount: number;
  failureKinds: Array<{ kind: string; count: number }>;
  durations: Array<{ dimension: string; count: number; medianMs: number }>;
  counts: { idleKills: number; cancels: number; retries: number; redBlocks: number };
};

function opsCutoff(since: string): string | null {
  if (since === "all") return null;
  const m = since.match(/^(\d+)d$/);
  return m?.[1] ? new Date(Date.now() - parseInt(m[1], 10) * 86400_000).toISOString() : null;
}

function opsMedian(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? Math.round((s[mid - 1]! + s[mid]!) / 2) : s[mid]!;
}

export function opsMetrics(since: string, projectDir?: string): OpsMetrics {
  const cutoff = opsCutoff(since);
  // Window clause + params, applied to a `runs r` alias in each query.
  const win = (): { clause: string; params: unknown[] } => {
    const params: unknown[] = [];
    let clause = "";
    if (cutoff) { clause += " AND r.created_at >= ?"; params.push(cutoff); }
    if (projectDir) { clause += " AND r.project_dir = ?"; params.push(projectDir); }
    return { clause, params };
  };

  // Success rate is terminal-only: an active (in-flight) run has no outcome yet,
  // so counting it as clean would inflate the KPI while long work is running.
  // clean = completed with no failed top-level task.
  const rw = win();
  const runRows = db().prepare(`
    SELECT r.id, r.status AS status,
      (SELECT COUNT(*) FROM tasks t WHERE t.run_id = r.id AND t.parent_id IS NULL AND t.status = 'failed') AS failed
    FROM runs r WHERE 1 = 1 ${rw.clause}
  `).all(...rw.params) as Array<{ id: string; status: string; failed: number }>;
  const total = runRows.length;
  const terminalRows = runRows.filter((r) => r.status === "complete" || r.status === "abandoned");
  const terminal = terminalRows.length;
  const active = total - terminal;
  const clean = terminalRows.filter((r) => r.status === "complete" && r.failed === 0).length;
  const withFailures = terminal - clean;

  const tw = win();
  const taskCount = (db().prepare(`
    SELECT COUNT(*) AS c FROM tasks t JOIN runs r ON r.id = t.run_id
    WHERE t.parent_id IS NULL ${tw.clause}
  `).get(...tw.params) as { c: number }).c;

  // Latest failure_kind per failed top-level task in the window.
  const fw = win();
  const failedKindRows = db().prepare(`
    SELECT e.payload AS payload
    FROM events e
    JOIN tasks t ON t.id = e.task_id
    JOIN runs  r ON r.id = t.run_id
    WHERE e.event_type = 'task.failed'
      AND t.parent_id IS NULL AND t.status = 'failed'
      AND e.created_at = (SELECT MAX(e2.created_at) FROM events e2 WHERE e2.task_id = e.task_id AND e2.event_type = 'task.failed')
      ${fw.clause}
  `).all(...fw.params) as Array<{ payload: string | null }>;
  const kindCounts = new Map<string, number>();
  for (const row of failedKindRows) {
    let kind = "unknown";
    try { const p = row.payload ? JSON.parse(row.payload) : null; if (p && typeof p.failure_kind === "string") kind = p.failure_kind; } catch { /* keep unknown */ }
    kindCounts.set(kind, (kindCounts.get(kind) ?? 0) + 1);
  }
  const failureKinds = [...kindCounts.entries()].map(([kind, count]) => ({ kind, count })).sort((a, b) => b.count - a.count);

  // Median task duration by phase.
  const dw = win();
  const durRows = db().prepare(`
    SELECT t.phase AS phase, t.started_at AS started, t.completed_at AS completed
    FROM tasks t JOIN runs r ON r.id = t.run_id
    WHERE t.parent_id IS NULL AND t.started_at IS NOT NULL AND t.completed_at IS NOT NULL ${dw.clause}
  `).all(...dw.params) as Array<{ phase: string; started: string; completed: string }>;
  const byPhase = new Map<string, number[]>();
  for (const r of durRows) {
    const ms = new Date(r.completed).getTime() - new Date(r.started).getTime();
    if (ms >= 0) { const arr = byPhase.get(r.phase) ?? []; arr.push(ms); byPhase.set(r.phase, arr); }
  }
  const durations = [...byPhase.entries()].map(([dimension, arr]) => ({ dimension, count: arr.length, medianMs: opsMedian(arr) })).sort((a, b) => b.count - a.count);

  // Operational counts from the event stream.
  const cw = win();
  const countRows = db().prepare(`
    SELECT e.event_type AS et, COUNT(*) AS c
    FROM events e JOIN runs r ON r.id = e.run_id
    WHERE e.event_type IN ('task.cancelled','run.cancelled','task.retried','task.blocked_by_red') ${cw.clause}
    GROUP BY e.event_type
  `).all(...cw.params) as Array<{ et: string; c: number }>;
  const countOf = (t: string) => countRows.find((r) => r.et === t)?.c ?? 0;
  const counts = {
    idleKills: failureKinds.find((f) => f.kind === "idle_timeout")?.count ?? 0,
    cancels: countOf("task.cancelled") + countOf("run.cancelled"),
    retries: countOf("task.retried"),
    redBlocks: countOf("task.blocked_by_red"),
  };

  return {
    runs: { total, active, terminal, clean, withFailures, successRate: terminal > 0 ? clean / terminal : 0 },
    taskCount,
    failureKinds,
    durations,
    counts,
  };
}

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

// FG-321: compression metrics derived from compression.verification events.
// Event payload: { agent_compressed, orchestrator_compressed, fields_compressed,
//   original_size_bytes?, compressed_size_bytes?, compression_ratio?, method? }
// Size/ratio fields are optional — older events lack them; queries use COALESCE.

function compressionCutoff(since: string): string | null {
  if (since === "all") return null;
  // Try Nd shorthand first.
  const m = since.match(/^(\d+)d$/);
  if (m?.[1]) return new Date(Date.now() - parseInt(m[1], 10) * 86400_000).toISOString();
  // Fall back to treating it as a raw ISO date string.
  const d = new Date(since);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export type CompressionSummary = {
  totalEvents: number;
  agentCompressed: number;
  orchestratorCompressed: number;
  totalOriginalBytes: number;
  totalCompressedBytes: number;
  bytesSaved: number;
  avgCompressionRatio: number;
};

export function compressionSummary(since = "30d", projectDir?: string): CompressionSummary {
  const cutoff = compressionCutoff(since);
  const params: unknown[] = [];
  let sinceClause = "";
  if (cutoff) { sinceClause = "AND e.created_at >= ?"; params.push(cutoff); }
  let projectClause = "";
  if (projectDir) { projectClause = "AND r.project_dir = ?"; params.push(projectDir); }

  const rows = db().prepare(`
    SELECT e.payload
    FROM events e
    JOIN tasks t ON t.id = e.task_id
    JOIN runs  r ON r.id = t.run_id
    WHERE e.event_type = 'compression.verification'
      ${sinceClause}
      ${projectClause}
  `).all(...params) as Array<{ payload: string | null }>;

  let agentCompressed = 0;
  let orchestratorCompressed = 0;
  let totalOriginalBytes = 0;
  let totalCompressedBytes = 0;
  let ratioSum = 0;
  let ratioCount = 0;

  for (const row of rows) {
    if (!row.payload) continue;
    let p: Record<string, unknown>;
    try { p = JSON.parse(row.payload) as Record<string, unknown>; } catch { continue; }
    if (p["agent_compressed"] === true) agentCompressed++;
    if (p["orchestrator_compressed"] === true) orchestratorCompressed++;
    if (typeof p["original_size_bytes"] === "number") totalOriginalBytes += p["original_size_bytes"];
    if (typeof p["compressed_size_bytes"] === "number") totalCompressedBytes += p["compressed_size_bytes"];
    if (typeof p["compression_ratio"] === "number") { ratioSum += p["compression_ratio"]; ratioCount++; }
  }

  return {
    totalEvents: rows.length,
    agentCompressed,
    orchestratorCompressed,
    totalOriginalBytes,
    totalCompressedBytes,
    bytesSaved: totalOriginalBytes - totalCompressedBytes,
    avgCompressionRatio: ratioCount > 0 ? ratioSum / ratioCount : 0,
  };
}

export type CompressionTimeSeriesRow = {
  date: string;
  events: number;
  agentCompressed: number;
  orchestratorCompressed: number;
  bytesSaved: number;
};

export function compressionTimeSeries(since = "30d", projectDir?: string): CompressionTimeSeriesRow[] {
  const cutoff = compressionCutoff(since);
  const params: unknown[] = [];
  let sinceClause = "";
  if (cutoff) { sinceClause = "AND e.created_at >= ?"; params.push(cutoff); }
  let projectClause = "";
  if (projectDir) { projectClause = "AND r.project_dir = ?"; params.push(projectDir); }

  const rows = db().prepare(`
    SELECT date(e.created_at) AS day, e.payload
    FROM events e
    JOIN tasks t ON t.id = e.task_id
    JOIN runs  r ON r.id = t.run_id
    WHERE e.event_type = 'compression.verification'
      ${sinceClause}
      ${projectClause}
    ORDER BY day ASC
  `).all(...params) as Array<{ day: string; payload: string | null }>;

  const byDay = new Map<string, { events: number; agentCompressed: number; orchestratorCompressed: number; bytesSaved: number }>();
  for (const row of rows) {
    const entry = byDay.get(row.day) ?? { events: 0, agentCompressed: 0, orchestratorCompressed: 0, bytesSaved: 0 };
    entry.events++;
    if (row.payload) {
      let p: Record<string, unknown>;
      try { p = JSON.parse(row.payload) as Record<string, unknown>; } catch { byDay.set(row.day, entry); continue; }
      if (p["agent_compressed"] === true) entry.agentCompressed++;
      if (p["orchestrator_compressed"] === true) entry.orchestratorCompressed++;
      const orig = typeof p["original_size_bytes"] === "number" ? p["original_size_bytes"] : 0;
      const comp = typeof p["compressed_size_bytes"] === "number" ? p["compressed_size_bytes"] : 0;
      entry.bytesSaved += orig - comp;
    }
    byDay.set(row.day, entry);
  }

  return [...byDay.entries()].map(([date, v]) => ({ date, ...v }));
}

export type CompressionByRoleRow = {
  agentRole: string;
  events: number;
  agentCompressed: number;
  orchestratorCompressed: number;
  bytesSaved: number;
  avgCompressionRatio: number;
};

export function compressionByRole(since = "30d", projectDir?: string, limit = 50): CompressionByRoleRow[] {
  const cutoff = compressionCutoff(since);
  const params: unknown[] = [];
  let sinceClause = "";
  if (cutoff) { sinceClause = "AND e.created_at >= ?"; params.push(cutoff); }
  let projectClause = "";
  if (projectDir) { projectClause = "AND r.project_dir = ?"; params.push(projectDir); }
  params.push(limit);

  const rows = db().prepare(`
    SELECT COALESCE(t.agent_role, '(unknown)') AS agent_role, e.payload
    FROM events e
    JOIN tasks t ON t.id = e.task_id
    JOIN runs  r ON r.id = t.run_id
    WHERE e.event_type = 'compression.verification'
      ${sinceClause}
      ${projectClause}
    ORDER BY e.created_at DESC
    LIMIT ?
  `).all(...params) as Array<{ agent_role: string; payload: string | null }>;

  const byRole = new Map<string, { events: number; agentCompressed: number; orchestratorCompressed: number; bytesSaved: number; ratioSum: number; ratioCount: number }>();
  for (const row of rows) {
    const entry = byRole.get(row.agent_role) ?? { events: 0, agentCompressed: 0, orchestratorCompressed: 0, bytesSaved: 0, ratioSum: 0, ratioCount: 0 };
    entry.events++;
    if (row.payload) {
      let p: Record<string, unknown>;
      try { p = JSON.parse(row.payload) as Record<string, unknown>; } catch { byRole.set(row.agent_role, entry); continue; }
      if (p["agent_compressed"] === true) entry.agentCompressed++;
      if (p["orchestrator_compressed"] === true) entry.orchestratorCompressed++;
      const orig = typeof p["original_size_bytes"] === "number" ? p["original_size_bytes"] : 0;
      const comp = typeof p["compressed_size_bytes"] === "number" ? p["compressed_size_bytes"] : 0;
      entry.bytesSaved += orig - comp;
      if (typeof p["compression_ratio"] === "number") { entry.ratioSum += p["compression_ratio"]; entry.ratioCount++; }
    }
    byRole.set(row.agent_role, entry);
  }

  return [...byRole.entries()]
    .map(([agentRole, v]) => ({
      agentRole,
      events: v.events,
      agentCompressed: v.agentCompressed,
      orchestratorCompressed: v.orchestratorCompressed,
      bytesSaved: v.bytesSaved,
      avgCompressionRatio: v.ratioCount > 0 ? v.ratioSum / v.ratioCount : 0,
    }))
    .sort((a, b) => b.events - a.events);
}

export type CompressionMethodRow = {
  method: string;
  count: number;
};

export function compressionMethods(since = "30d", projectDir?: string): CompressionMethodRow[] {
  const cutoff = compressionCutoff(since);
  const params: unknown[] = [];
  let sinceClause = "";
  if (cutoff) { sinceClause = "AND e.created_at >= ?"; params.push(cutoff); }
  let projectClause = "";
  if (projectDir) { projectClause = "AND r.project_dir = ?"; params.push(projectDir); }

  const rows = db().prepare(`
    SELECT e.payload
    FROM events e
    JOIN tasks t ON t.id = e.task_id
    JOIN runs  r ON r.id = t.run_id
    WHERE e.event_type = 'compression.verification'
      ${sinceClause}
      ${projectClause}
  `).all(...params) as Array<{ payload: string | null }>;

  const methodCounts = new Map<string, number>();
  for (const row of rows) {
    let method = "(unknown)";
    if (row.payload) {
      try {
        const p = JSON.parse(row.payload) as Record<string, unknown>;
        if (typeof p["method"] === "string") method = p["method"];
      } catch { /* keep unknown */ }
    }
    methodCounts.set(method, (methodCounts.get(method) ?? 0) + 1);
  }

  return [...methodCounts.entries()]
    .map(([method, count]) => ({ method, count }))
    .sort((a, b) => b.count - a.count);
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

// #285: read-only routing/governance read model for the dashboard panel. Backed
// by the SAME governanceView() core as `forge route governance --json`, so the
// dashboard can't drift from the CLI's view of routing. Augments it with the tail
// of the host RACI audit log so policy changes are visible without reading the
// file. Read-only: there is no write counterpart.
const AUDIT_LOG_PATH = join(FORGE_HOME, "raci-audit.log");

export type RaciAuditEntry = {
  timestamp: string;
  action: string;
  current_raci: string;
  candidate: string;
  routes_added: string[];
  routes_removed: string[];
  routes_modified: string[];
  validation: { raci: boolean; route: boolean };
};

export type GovernancePanel = GovernanceView & { recentAudit: RaciAuditEntry[] };

/** Tail of the host-global RACI audit log (newest first). Tolerates a missing
 *  file (no changes yet) and skips any unparseable line. */
function recentRaciAudit(limit: number): RaciAuditEntry[] {
  if (!existsSync(AUDIT_LOG_PATH)) return [];
  const lines = readFileSync(AUDIT_LOG_PATH, "utf8").split("\n").filter((l) => l.trim() !== "");
  const out: RaciAuditEntry[] = [];
  for (const line of lines.slice(-limit)) {
    try {
      out.push(JSON.parse(line) as RaciAuditEntry);
    } catch {
      /* skip a corrupt line rather than fail the whole panel */
    }
  }
  return out.reverse();
}

export function routingGovernance(projectDir?: string): GovernancePanel {
  return { ...governanceView({ projectDir }), recentAudit: recentRaciAudit(8) };
}
