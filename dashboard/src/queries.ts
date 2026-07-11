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
import { listProjects, sortProjects, deriveGithubUrl, type ProjectRecord } from "@forge/projects";
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

/** Tasks currently running, awaiting gate, awaiting red, or blocked by red.
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
    WHERE t.status IN ('running', 'awaiting_gate', 'awaiting_red', 'blocked_by_red')
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
  resultSizeBytes: number | null; // raw result JSON byte length; null if no result
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
  // FG-487: verification phase-boundary events are RUN-scoped (task_id is never
  // set — the loop's verification happens between tasks; reconcile gates have no
  // task at all), so a strict task_id match would never show them. Fold the
  // task's run's verification events into its timeline; they render with the
  // verification badge/detail helpers in the client.
  const eventRows = db().prepare(`
    SELECT event_type, payload, created_at
    FROM events
    WHERE task_id = ?
       OR (run_id = ? AND task_id IS NULL AND event_type IN (
            'review_loop.verification_started', 'review_loop.verification_finished',
            'campaign_item.host_gate_started', 'campaign_item.host_gate_finished'))
    ORDER BY created_at ASC, id ASC
  `).all(taskId, taskRow.run_id) as Array<{ event_type: string; payload: string | null; created_at: string }>;
  const events: TaskEventEntry[] = eventRows.map((e) => ({
    eventType: e.event_type,
    payload: e.payload ? safeJsonParse(e.payload) : null,
    createdAt: e.created_at,
  }));
  const failureKind = deriveFailureKind(events);
  const idle = computeIdle(taskRow.run_id, taskId, taskRow.status, taskRow.started_at);

  const resultSizeBytes = taskRow.result ? Buffer.byteLength(taskRow.result, "utf8") : null;

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
    resultSizeBytes,
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
  // FG-438: attach each project's canonical GitHub URL (derived from its repo
  // remotes) so the Projects view can link out. Confined to the dashboard so the
  // `forge projects` CLI and other listProjects() callers don't pay the git cost.
  return sortProjects(listProjects(), "activity").map((p) => {
    const githubUrl = deriveGithubUrl(p.projectDir);
    return githubUrl ? { ...p, githubUrl } : p;
  });
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

// FG-359: four-section WorkbenchPanel replaces the flat GovernancePanel.
// source=RACI file in force; derived=compiled policy health; effective=routes+diff;
// recorded=audit log. Backed by the same governanceView() core.

export type WorkbenchHealth =
  | "ok"
  | "uncompiled-override"
  | "stale-drift"
  | "compile-error"
  | "policy-not-found";

export type WorkbenchPanel = {
  source: { kind: "project" | "host"; raciPath: string };
  derived: {
    policyPath: string;
    health: WorkbenchHealth;
    findings?: Extract<GovernanceView, { ok: false }>["findings"];
    accountable?: string;
  };
  effective: {
    routes: Extract<GovernanceView, { ok: true }>["routes"];
    diff?: Extract<GovernanceView, { ok: true }>["diff"];
  } | null;
  recorded: { entries: RaciAuditEntry[] };
};

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

export function routingGovernance(projectDir?: string): WorkbenchPanel {
  const view = governanceView({ projectDir });

  const raciPath =
    view.source === "project" && projectDir !== undefined
      ? join(projectDir, ".forge", "forge-raci.md")
      : join(FORGE_HOME, "forge-raci.md");

  let health: WorkbenchHealth;
  let findings: WorkbenchPanel["derived"]["findings"];
  let accountable: string | undefined;

  if (!view.ok) {
    findings = view.findings;
    const codes = view.findings.map((f) => f.code);
    if (codes.includes("override_not_compiled")) health = "uncompiled-override";
    else if (codes.includes("raci_compile_error")) health = "compile-error";
    else health = "policy-not-found";
  } else {
    accountable = view.accountable;
    if (view.drift && view.drift.length > 0) {
      findings = view.drift as WorkbenchPanel["derived"]["findings"];
      health = view.drift.some((f) => f.code === "raci_compile_error") ? "compile-error" : "stale-drift";
    } else {
      health = "ok";
    }
  }

  const effective = view.ok
    ? { routes: view.routes, ...(view.diff ? { diff: view.diff } : {}) }
    : null;

  return {
    source: { kind: view.source, raciPath },
    derived: {
      policyPath: view.path,
      health,
      ...(findings ? { findings } : {}),
      ...(accountable !== undefined ? { accountable } : {}),
    },
    effective,
    recorded: { entries: recentRaciAudit(8) },
  };
}

// ── FG-487: host-side verification visibility ──────────────────────────────
//
// Host verification (review-loop's CI-wait/local verification phases, campaign
// reconcile's real-exec gates) runs OUTSIDE the task/container lifecycle the
// rest of this file reads — minutes of host-side activity with no task row
// while it's in flight. The producing side (src/store/events.ts and its two
// emitters) writes durable start/finish event pairs keyed by a per-invocation
// `attemptId` (a crash-restarted round or CI-wait retry can legitimately
// produce two starts at the same round/ticket/sha identity — pairing MUST be
// by attemptId, never "latest unmatched start by key"). Everything below is
// derived at query time from `events` + `host_verifications` — no new
// lifecycle/state table (FG-477 constraint discipline).
//
// Event contract (documented fully in docs/SCHEMA-CONTRACT.md):
//   review_loop.verification_started  { attemptId, round, ticketId, sha, mode? }
//   review_loop.verification_finished { attemptId, ...outcome }
//   campaign_item.host_gate_started   { attemptId, campaignId?, itemId, ticketId, command|gate, testedSha, runId }
//   campaign_item.host_gate_finished  { attemptId, exitCode, ...outcome }
// Payload field READS below are deliberately tolerant (e.g. command ?? gate)
// since the producing side is a separate build step against the same contract
// doc — a single canonical key is documented, but a reasonable alias is not
// treated as a hard failure.

// Query-time staleness heuristic (NOT a watchdog/sweep) so a crashed forge
// process doesn't show as perpetually "in progress". Kept in sync BY HAND with
// the producing side's own timeouts — these are upper bounds, not the
// authoritative timeout values (which are env-overridable there).
// Mirrors src/cli/commands/review-loop.ts's DEFAULT_CI_WAIT_TIMEOUT_SECONDS.
const REVIEW_LOOP_VERIFICATION_STALE_MS = 20 * 60 * 1000;
// Mirrors src/campaign/reconcile-collect.ts's HOST_GATE_TIMEOUT_MS_DEFAULT.
const CAMPAIGN_HOST_GATE_STALE_MS = 10 * 60 * 1000;
// FG-487 incident fix: a past-cutoff unmatched start used to be dropped
// entirely, so a crashed/hung verification vanished instead of being flagged
// — the exact gap this ticket was filed over. Past-cutoff starts are now
// INCLUDED with stale: true, bounded by this lookback so ancient rows (a
// process that crashed days ago) don't accumulate forever.
const STALE_LOOKBACK_MS = 24 * 60 * 60 * 1000;

type VerificationEventRow = {
  run_id: string | null;
  task_id: string | null;
  event_type: string;
  payload: string | null;
  created_at: string;
};

// sinceMs bounds the scan to events created at/after that instant, pushed
// down into SQL so it can use idx_events_type_created (event_type, created_at)
// instead of a full-table scan — this is called 4x per dashboard poll tick
// (2x here, 2x from reviewLoopRunPhases below) by every open tab.
function readEventsByType(types: readonly string[], sinceMs?: number): VerificationEventRow[] {
  const placeholders = types.map(() => "?").join(",");
  const sinceClause = sinceMs !== undefined ? `AND created_at >= ?` : ``;
  const params: unknown[] = [...types];
  if (sinceMs !== undefined) params.push(new Date(sinceMs).toISOString());
  return db()
    .prepare(
      `SELECT run_id, task_id, event_type, payload, created_at
       FROM events WHERE event_type IN (${placeholders}) ${sinceClause}
       ORDER BY created_at ASC, id ASC`
    )
    .all(...params) as VerificationEventRow[];
}

function runProjectDir(runId: string | null): string | null {
  if (!runId) return null;
  const row = db().prepare(`SELECT project_dir FROM runs WHERE id = ?`).get(runId) as
    | { project_dir: string | null }
    | undefined;
  return row?.project_dir ?? null;
}

function campaignProjectDir(campaignId: string | null): string | null {
  if (!campaignId) return null;
  const row = db().prepare(`SELECT project_dir FROM campaigns WHERE id = ?`).get(campaignId) as
    | { project_dir: string | null }
    | undefined;
  return row?.project_dir ?? null;
}

function parseEventPayload(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const p: unknown = JSON.parse(raw);
    return p !== null && typeof p === "object" ? (p as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function readAttemptId(payload: Record<string, unknown>): string | null {
  return typeof payload.attemptId === "string" ? payload.attemptId : null;
}

const VERIFICATION_START_TYPES = ["review_loop.verification_started", "campaign_item.host_gate_started"] as const;
const VERIFICATION_FINISH_TYPES = ["review_loop.verification_finished", "campaign_item.host_gate_finished"] as const;

export type InProgressVerification =
  | {
      kind: "review_loop_verification";
      attemptId: string;
      runId: string | null;
      ticketId: string | null;
      sha: string | null;
      mode: string | null;
      round: number | null;
      startedAt: string;
      stale: boolean;
    }
  | {
      kind: "campaign_reconcile_gate";
      attemptId: string;
      runId: string | null;
      campaignId: string | null;
      itemId: string | null;
      ticketId: string | null;
      command: string | null;
      testedSha: string | null;
      startedAt: string;
      stale: boolean;
    };

/** Every start event whose attemptId has no matching finish yet, minus any
 *  past its type's staleness cutoff. Pairing is by attemptId — never "latest
 *  unmatched start by key" — so a same-identity double-start (e.g. two starts
 *  at the same round/ticketId/sha with different attemptIds, only one
 *  finished) reports exactly the one attempt that's actually still open, not
 *  zero or two. */
export function inProgressVerifications(nowMs: number = Date.now(), projectDir?: string): InProgressVerification[] {
  // A finish event for an attempt whose start survives the lookback cutoff is
  // itself always created at/after that start (finish can't precede its own
  // start), so bounding both reads by the same cutoff is safe — it can't drop
  // a finish that would otherwise unmatch a still-relevant start.
  const sinceMs = nowMs - STALE_LOOKBACK_MS;
  const finishedAttemptIds = new Set<string>();
  for (const row of readEventsByType(VERIFICATION_FINISH_TYPES, sinceMs)) {
    const attemptId = readAttemptId(parseEventPayload(row.payload));
    if (attemptId) finishedAttemptIds.add(attemptId);
  }

  const out: InProgressVerification[] = [];
  for (const row of readEventsByType(VERIFICATION_START_TYPES, sinceMs)) {
    const payload = parseEventPayload(row.payload);
    const attemptId = readAttemptId(payload);
    if (!attemptId || finishedAttemptIds.has(attemptId)) continue;

    const ageMs = nowMs - new Date(row.created_at).getTime();
    if (ageMs > STALE_LOOKBACK_MS) continue;
    if (row.event_type === "review_loop.verification_started") {
      // Project filter matches inFlight()'s strict-equality semantics: the
      // loop's eager run row carries project_dir; campaign gates resolve via
      // their campaign row (item.runId is frequently null).
      if (projectDir && runProjectDir(row.run_id) !== projectDir) continue;
      out.push({
        kind: "review_loop_verification",
        attemptId,
        runId: row.run_id,
        ticketId: typeof payload.ticketId === "string" ? payload.ticketId : null,
        sha: typeof payload.sha === "string" ? payload.sha : null,
        mode: typeof payload.mode === "string" ? payload.mode : null,
        round: typeof payload.round === "number" ? payload.round : null,
        startedAt: row.created_at,
        stale: ageMs > REVIEW_LOOP_VERIFICATION_STALE_MS,
      });
    } else {
      const campaignId = typeof payload.campaignId === "string" ? payload.campaignId : null;
      if (projectDir && campaignProjectDir(campaignId) !== projectDir) continue;
      out.push({
        kind: "campaign_reconcile_gate",
        attemptId,
        runId: row.run_id,
        campaignId,
        itemId: typeof payload.itemId === "string" ? payload.itemId : null,
        ticketId: typeof payload.ticketId === "string" ? payload.ticketId : null,
        command:
          typeof payload.command === "string" ? payload.command : typeof payload.gate === "string" ? payload.gate : null,
        testedSha: typeof payload.testedSha === "string" ? payload.testedSha : null,
        startedAt: row.created_at,
        stale: ageMs > CAMPAIGN_HOST_GATE_STALE_MS,
      });
    }
  }
  return out;
}

export type ReviewLoopPhase = "verifying" | "waiting-on-ci" | "reviewing" | "fixing";

export type ReviewLoopRunPhaseEntry = {
  runId: string;
  runTitle: string;
  workflow: string;
  projectDir: string | null;
  projectLabel: string | null;
  projectColor: string | null;
  phase: ReviewLoopPhase;
  phaseStartedAt: string;
  ticketId: string | null;
  round: number | null;
};

/** Review-loop runs currently mid-phase, including the launch-to-first-round
 *  window BEFORE any reviewer/fixer task row exists — the exact gap FG-487
 *  reports (a watcher can't tell "verifying" from "hung" because inFlight()'s
 *  task JOIN returns nothing for a run that has no task yet). A run counts as
 *  a "review-loop run" purely by having ever emitted a
 *  review_loop.verification_started event — no workflow-name assumption, so
 *  this stays correct even if the run's `workflow` column is a generic
 *  "invoke" sentinel. Phase per run is whichever is more recent: the latest
 *  running reviewer/fixer task, or the latest still-open verification start
 *  (same attemptId pairing as inProgressVerifications). */
export function reviewLoopRunPhases(nowMs: number = Date.now(), projectDir?: string): ReviewLoopRunPhaseEntry[] {
  // Track the LATEST verification_started per run for its ticketId/round/mode
  // context (kept even once finished — a "reviewing"/"fixing" phase driven by
  // a task row still wants to display which ticket/round it belongs to), plus
  // separately whether that latest start is still open (unmatched by a finish
  // event) — that's what actually makes it a candidate phase on its own.
  // Same lookback bound as inProgressVerifications, for the same reason: a
  // review-loop run whose latest verification_started event is this old has
  // either long since finished or hung well past any phase worth displaying.
  const sinceMs = nowMs - STALE_LOOKBACK_MS;
  const finishedAttemptIds = new Set<string>();
  for (const row of readEventsByType(["review_loop.verification_finished"], sinceMs)) {
    const attemptId = readAttemptId(parseEventPayload(row.payload));
    if (attemptId) finishedAttemptIds.add(attemptId);
  }

  type LatestStart = { attemptId: string; ticketId: string | null; round: number | null; mode: string | null; startedAt: string; open: boolean };
  const latestStartByRun = new Map<string, LatestStart>();
  for (const row of readEventsByType(["review_loop.verification_started"], sinceMs)) {
    if (!row.run_id) continue;
    const payload = parseEventPayload(row.payload);
    const attemptId = readAttemptId(payload);
    if (!attemptId) continue;
    // rows are ASC by created_at — later rows overwrite earlier ones, so the
    // map ends up holding the latest start per run.
    latestStartByRun.set(row.run_id, {
      attemptId,
      ticketId: typeof payload.ticketId === "string" ? payload.ticketId : null,
      round: typeof payload.round === "number" ? payload.round : null,
      mode: typeof payload.mode === "string" ? payload.mode : null,
      startedAt: row.created_at,
      open: !finishedAttemptIds.has(attemptId),
    });
  }
  if (latestStartByRun.size === 0) return [];

  const where = projectDir ? `AND r.project_dir = ?` : ``;
  const params = projectDir ? [projectDir] : [];
  const runRows = db()
    .prepare(`SELECT id, title, workflow, project_dir FROM runs r WHERE r.status = 'active' ${where}`)
    .all(...params) as Array<{ id: string; title: string; workflow: string; project_dir: string | null }>;
  const candidateRuns = runRows.filter((r) => latestStartByRun.has(r.id));
  if (candidateRuns.length === 0) return [];

  const runIdsPlaceholder = candidateRuns.map(() => "?").join(",");
  const taskRows = db()
    .prepare(
      `SELECT run_id, agent_role, started_at, created_at
       FROM tasks WHERE run_id IN (${runIdsPlaceholder}) AND status = 'running'
       ORDER BY COALESCE(started_at, created_at) DESC`
    )
    .all(...candidateRuns.map((r) => r.id)) as Array<{
    run_id: string;
    agent_role: string;
    started_at: string | null;
    created_at: string;
  }>;
  const latestTaskByRun = new Map<string, (typeof taskRows)[number]>();
  for (const t of taskRows) {
    if (!latestTaskByRun.has(t.run_id)) latestTaskByRun.set(t.run_id, t); // rows are DESC — first hit per run is the latest
  }

  const out: ReviewLoopRunPhaseEntry[] = [];
  for (const run of candidateRuns) {
    const task = latestTaskByRun.get(run.id);
    const start = latestStartByRun.get(run.id)!;
    const taskStartedAt = task ? task.started_at ?? task.created_at : null;

    let phase: ReviewLoopPhase | null = null;
    let phaseStartedAt: string | null = null;
    if (task && taskStartedAt && (!start.open || taskStartedAt > start.startedAt)) {
      phase = task.agent_role === "engineer" ? "fixing" : "reviewing";
      phaseStartedAt = taskStartedAt;
    } else if (start.open) {
      phase = start.mode === "ci-wait" || start.mode === "ci_wait" ? "waiting-on-ci" : "verifying";
      phaseStartedAt = start.startedAt;
    }
    if (!phase || !phaseStartedAt) continue;

    const meta = resolveProjectMeta(run.project_dir);
    out.push({
      runId: run.id,
      runTitle: run.title,
      workflow: run.workflow,
      projectDir: run.project_dir,
      projectLabel: meta?.label ?? null,
      projectColor: meta?.color ?? null,
      phase,
      phaseStartedAt,
      ticketId: start.ticketId,
      round: start.round,
    });
  }
  return out;
}

// ── host_verifications evidence (dashboard read path) ───────────────────────
//
// The trust evidence FG-440/FG-483/FG-474 ship decisions rest on, rendered
// here rather than requiring sqlite access. Read via direct SQL against the
// dashboard's own read-only handle (this file's established convention —
// see the module header) rather than importing src/store/host-verifications.ts:
// that module's exported lookups (queryHostVerificationRows /
// queryHostVerificationRowsForGate) are single-gate/single-sha lookups built
// for the reuse-check call sites, not "everything recorded for this ticket",
// which is what an evidence VIEW needs.

export type HostVerificationEvidenceRow = {
  id: number;
  ticketId: string;
  projectDir: string;
  commitSha: string;
  gateName: string;
  command: string;
  exitCode: number;
  runId: string | null;
  recordedAt: string;
  source: "host" | "ci";
  ciUrl: string | null;
};

type HostVerificationDbRow = {
  id: number;
  ticket_id: string;
  project_dir: string;
  commit_sha: string;
  gate_name: string;
  command: string;
  exit_code: number;
  run_id: string | null;
  recorded_at: string;
  source: string;
  ci_url: string | null;
};

function rowToHostVerification(row: HostVerificationDbRow): HostVerificationEvidenceRow {
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
    source: row.source === "ci" ? "ci" : "host",
    ciUrl: row.ci_url,
  };
}

/** All host_verifications rows recorded for a ticket (optionally narrowed to
 *  one project_dir), most-recent-first. Unscoped by gate/sha — an evidence
 *  view shows everything recorded, not one gate lookup at a time. */
export function hostVerificationsForTicket(ticketId: string, projectDir?: string, limit = 100): HostVerificationEvidenceRow[] {
  const where = projectDir ? `AND project_dir = ?` : ``;
  const params: unknown[] = [ticketId];
  if (projectDir) params.push(projectDir);
  params.push(limit);
  const rows = db()
    .prepare(`SELECT * FROM host_verifications WHERE ticket_id = ? ${where} ORDER BY recorded_at DESC LIMIT ?`)
    .all(...params) as HostVerificationDbRow[];
  return rows.map(rowToHostVerification);
}

/** Same evidence, scoped by campaign item. host_verifications has no item_id
 *  column (FG-477: no new lifecycle/evidence table) — this resolves the
 *  item's ticketId and its campaign's project_dir via campaign_items →
 *  campaigns, then delegates to the ticket-scoped lookup. Returns [] for an
 *  unknown item id rather than throwing. */
export function hostVerificationsForCampaignItem(itemId: string): HostVerificationEvidenceRow[] {
  const item = db()
    .prepare(
      `SELECT ci.ticket_id AS ticket_id, c.project_dir AS project_dir
       FROM campaign_items ci JOIN campaigns c ON c.id = ci.campaign_id
       WHERE ci.id = ?`
    )
    .get(itemId) as { ticket_id: string; project_dir: string | null } | undefined;
  if (!item) return [];
  return hostVerificationsForTicket(item.ticket_id, item.project_dir ?? undefined);
}

/** Unscoped, most-recent-first — the AC5 breadcrumb: a completed
 *  orchestrator-run bare gate (e.g. `npm run test:all` invoked directly, no
 *  review-loop/reconcile wrapper) has no in-flight window to catch, but its
 *  recorded row is still discoverable here after the fact. */
export function recentHostVerifications(limit = 50): HostVerificationEvidenceRow[] {
  const rows = db().prepare(`SELECT * FROM host_verifications ORDER BY recorded_at DESC LIMIT ?`).all(limit) as HostVerificationDbRow[];
  return rows.map(rowToHostVerification);
}
