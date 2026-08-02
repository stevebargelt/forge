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
import { basename, join } from "node:path";
import type { Run, Task } from "@forge/types";
import { resolveProjectMeta } from "@forge/project-meta";
import { listProjects, sortProjects, type ProjectRecord } from "@forge/projects";
import { repositoryCheckoutIdentity } from "@forge/repository-identity";
import { governanceView, type GovernanceView } from "@forge/governance";
import {
  findReconcileCandidates,
  type LivenessProbe,
  type ReconcileClassification,
  type ReconcileReason,
} from "@forge/reconcile-candidate";

export { type ProjectRecord };

/** Undefined means all projects, a string is an exact operational checkout,
 * and an array is the complete set of observed paths for one repository. */
export type ProjectScope = string | readonly string[] | undefined;

function scopeSql(column: string, scope: ProjectScope): { clause: string; params: string[] } {
  if (scope === undefined) return { clause: "", params: [] };
  if (typeof scope === "string") return { clause: `AND ${column} = ?`, params: [scope] };
  if (scope.length === 0) return { clause: "AND 0 = 1", params: [] };
  return { clause: `AND ${column} IN (${scope.map(() => "?").join(",")})`, params: [...scope] };
}

function scopeIncludes(scope: ProjectScope, projectDir: string | null): boolean {
  if (scope === undefined) return true;
  if (projectDir === null) return false;
  return typeof scope === "string" ? projectDir === scope : scope.includes(projectDir);
}

// FG-616: resolved PER CALL, never snapshotted at module eval. ESM evaluates a
// static import before the importing module's body, so a module-eval snapshot
// binds whatever FORGE_HOME happened to be set at import time — the exact shape
// of the FG-607 store-path bug, where the dashboard read one host's store while
// the process had settled on another. Latent in the single-home production
// dashboard; not latent for a long-running process whose home is assigned after
// its imports, which is every integration harness that boots this server.
function forgeHome(): string {
  return process.env.FORGE_HOME ?? join(homedir(), ".forge");
}
function dbPath(): string {
  return join(forgeHome(), "forge.db");
}
function runsDir(): string {
  return join(forgeHome(), "runs");
}

// The handle is cached against the path it was opened on. A resolved path that
// no longer matches means the process now has a DIFFERENT store, and continuing
// to answer from the old connection is how a reader silently serves another
// host's tickets. Forge's own cache is keyed on dbGeneration(); this second,
// independent read-only handle is invisible to it, so it needs its own
// invalidation or a long-running dashboard would never observe a mode flip.
let _db: { path: string; handle: Database.Database } | null = null;
function db(): Database.Database {
  const path = dbPath();
  if (_db) {
    if (_db.path === path) return _db.handle;
    _db.handle.close();
    _db = null;
  }
  if (!existsSync(path)) {
    throw new Error(`forge DB not found at ${path}. Has forge run yet?`);
  }
  // WAL readers don't block writers (forge uses WAL); no contention.
  _db = { path, handle: new Database(path, { readonly: true }) };
  return _db.handle;
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
  checkoutBranch: string | null;
  checkoutName: string | null;
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
export function recentActivity(limit = 100, sinceIso?: string, scope?: ProjectScope): ActivityEntry[] {
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
  const project = scopeSql("r.project_dir", scope);
  sql += ` ${project.clause}`;
  params.push(...project.params);
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
    const meta = projectPresentation(r.project_dir);
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
      // Historical run rows do not capture branch. Never relabel an old run
      // with whichever branch this path happens to contain today.
      checkoutBranch: null,
      checkoutName: r.project_dir ? basename(r.project_dir) : null,
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
  checkoutBranch: string | null;
  checkoutName: string | null;
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
export function inFlight(scope?: ProjectScope, probe?: LivenessProbe): InFlightEntry[] {
  const project = scopeSql("r.project_dir", scope);
  const rows = db().prepare(`
    SELECT t.id, t.run_id, t.phase, t.agent_role, t.agent_model, t.status, t.started_at,
           r.title, r.workflow, r.project_dir
    FROM tasks t
    JOIN runs r ON r.id = t.run_id
    WHERE t.status IN ('running', 'awaiting_gate', 'awaiting_red', 'blocked_by_red', 'awaiting_recovery')
      AND r.status = 'active'
      ${project.clause}
    ORDER BY t.started_at DESC NULLS LAST, t.created_at DESC
  `).all(...project.params) as Array<{
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
  const reconcileRows = scope === undefined
    ? findReconcileCandidates(db(), {}, probe)
    : (typeof scope === "string" ? [scope] : scope).flatMap((projectDir) =>
      findReconcileCandidates(db(), { projectDir }, probe));
  const candidates = new Map(
    reconcileRows
      .filter((c) => c.classification === "reconcile_candidate")
      .map((c) => [c.taskId, { classification: c.classification, reason: c.reason }])
  );

  return rows.map((r) => {
    const meta = projectPresentation(r.project_dir);
    return {
      runId: r.run_id,
      runTitle: r.title,
      workflow: r.workflow,
      projectDir: r.project_dir,
      projectLabel: meta?.label ?? null,
      projectColor: meta?.color ?? null,
      checkoutBranch: meta?.branch ?? null,
      checkoutName: r.project_dir ? basename(r.project_dir) : null,
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
  const dir = join(runsDir(), runId, taskId);
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

  const taskMeta = projectPresentation(taskRow.project_dir);
  const task: ActivityEntry = {
    taskId: taskRow.id,
    runId: taskRow.run_id,
    runTitle: taskRow.title,
    workflow: taskRow.workflow,
    projectDir: taskRow.project_dir,
    projectLabel: taskMeta?.label ?? null,
    projectColor: taskMeta?.color ?? null,
    checkoutBranch: null,
    checkoutName: taskRow.project_dir ? basename(taskRow.project_dir) : null,
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

  const stdoutPath = join(runsDir(), taskRow.run_id, taskId, "container.stdout.log");
  const stderrPath = join(runsDir(), taskRow.run_id, taskId, "container.stderr.log");
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
            'campaign_item.host_gate_started', 'campaign_item.host_gate_finished',
            -- FG-566: the readiness preflight is emitted RUN-scoped from the review
            -- loop (the loop's verification happens between tasks, so there is no
            -- task_id to attach), and its refusal payload — workspace, command,
            -- exitStatus, stderrTail — is the ONLY place those facts exist. Omitted
            -- from this whitelist it had no dashboard surface at all: an operator
            -- saw a stopped loop and no reason for it.
            'host_readiness.ready', 'host_readiness.refused'))
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

export function opsMetrics(since: string, scope?: ProjectScope): OpsMetrics {
  const cutoff = opsCutoff(since);
  // Window clause + params, applied to a `runs r` alias in each query.
  const win = (): { clause: string; params: unknown[] } => {
    const params: unknown[] = [];
    let clause = "";
    if (cutoff) { clause += " AND r.created_at >= ?"; params.push(cutoff); }
    const project = scopeSql("r.project_dir", scope);
    clause += ` ${project.clause}`;
    params.push(...project.params);
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
  const terminalRows = runRows.filter(
    (r) => r.status === "complete" || r.status === "failed" || r.status === "abandoned",
  );
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

// FG-648: average agent runtime over time, overall and by role. Distinct from
// opsMetrics's median-by-phase table, which is a single point-in-time roll-up:
// this one buckets the same durations over a window so a trend is visible.
export type AgentRuntimeWindow = "1d" | "7d" | "30d" | "90d" | "all";
export type AgentRuntimeResolution = "hour" | "day" | "week";

/** `averageMs` is null exactly when `sampleCount` is 0 — an empty bucket is
 *  reported as an observed gap, never fabricated as a zero-duration sample. */
export type AgentRuntimeBucket = {
  bucketStart: string;
  averageMs: number | null;
  sampleCount: number;
  partial: boolean;
};

export type AgentRuntimeRoleSeries = { role: string; buckets: AgentRuntimeBucket[] };
export type AgentRuntimeRoleSummary = { role: string; averageMs: number; sampleCount: number };

export type AgentRuntimeTrends = {
  window: AgentRuntimeWindow;
  resolution: AgentRuntimeResolution;
  bucketMs: number;
  rangeStart: string | null;
  rangeEnd: string;
  overall: AgentRuntimeBucket[];
  byRole: AgentRuntimeRoleSeries[];
  roleSummary: AgentRuntimeRoleSummary[];
};

export const AGENT_RUNTIME_WINDOWS = ["1d", "7d", "30d", "90d", "all"] as const;

export function isAgentRuntimeWindow(value: string): value is AgentRuntimeWindow {
  return (AGENT_RUNTIME_WINDOWS as readonly string[]).includes(value);
}

const AGENT_RUNTIME_RESOLUTION: Record<AgentRuntimeWindow, AgentRuntimeResolution> = {
  "1d": "hour",
  "7d": "day",
  "30d": "day",
  "90d": "week",
  all: "week",
};

const RESOLUTION_MS: Record<AgentRuntimeResolution, number> = {
  hour: 3_600_000,
  day: 86_400_000,
  week: 604_800_000,
};

// Buckets are aligned to UTC boundaries so the same observation always lands in
// the same bucket regardless of the reader's timezone. Epoch day 0 is a Thursday,
// hence the +3 to reach the preceding Monday.
function floorToResolution(ms: number, resolution: AgentRuntimeResolution): number {
  if (resolution === "week") {
    const dayIndex = Math.floor(ms / 86_400_000);
    return (dayIndex - ((dayIndex + 3) % 7)) * 86_400_000;
  }
  const step = RESOLUTION_MS[resolution];
  return Math.floor(ms / step) * step;
}

// FG-662: the events the process supervising a container logs at the instant it
// observed that container stop — the same set reconcile.ts calls
// `hasContainerExited`. Their timestamp is when the AGENT stopped, independent of
// whatever later rewrote completed_at. `container.killed` is deliberately NOT
// here: `forge cancel` logs it around a blind best-effort `docker kill`, so it
// records when an operator cancelled, not that an agent was still running.
const AGENT_OBSERVED_EXIT_EVENTS = [
  "container.exited",
  "container.idle_timeout",
  "container.dependency_provisioning_failed",
  "container.git_unavailable",
] as const;

// FG-662: failure kinds whose task.failed row is written by a process that was
// NOT supervising the agent's container — `forge cancel`, `forge gate --reject`,
// and the reconcile / ops-repair sweeps. For these completed_at records when the
// terminal was NOTICED, so completed_at − started_at is wall-clock-until-noticed
// rather than runtime. Every other kind is classified by the supervising process
// at the agent's own exit and keeps counting in full — idle_timeout above all.
const ADMINISTRATIVE_TERMINAL_KINDS = new Set([
  "cancelled",                            // cli/commands/cancel.ts
  "gate_rejected",                        // v2/gate.ts
  "orphaned",                             // v2/reconcile.ts, ops/repair.ts
  "orphaned_work_may_persist",            // v2/reconcile.ts
  "orphaned_needs_finalize",              // v2/reconcile.ts
  "fanout_wave_orphaned",                 // v2/reconcile.ts
  "oom_killed",                           // v2/reconcile.ts — the attached-exit oom_killed carries an exit event and never reaches here
  "pre_container_crash",                  // v2/reconcile.ts — no container ever ran
  "verification_environment_unavailable", // v2/reconcile.ts
]);

type AgentRuntimeRow = {
  role: string;
  started: string;
  completed: string;
  status: string;
  agentExit: string | null;
  failedPayload: string | null;
  reconciledPayloads: string | null;
};

// group_concat separator for the task.reconciled payloads below. JSON.stringify
// escapes control characters, so a literal 0x1E can never occur inside one.
const RECONCILED_SEPARATOR = "\u001e";

function payloadObject(payload: string | null): Record<string, unknown> | null {
  if (!payload) return null;
  try {
    const parsed = JSON.parse(payload) as unknown;
    return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function failureKindOf(payload: string | null): string | null {
  const parsed = payloadObject(payload);
  return typeof parsed?.["failure_kind"] === "string" ? (parsed["failure_kind"] as string) : null;
}

/** FG-662: true when a process that was NOT supervising the agent's container
 *  moved this task INTO `complete` — reconcile's container-gone sweeps and
 *  `forge recover --continue`, which call markTaskComplete / markTaskRecovered
 *  with nowIso() and audit the transition on task.reconciled. This is the
 *  success-side twin of ADMINISTRATIVE_TERMINAL_KINDS, and layer 1 can never
 *  rescue these rows: reconcile's container-gone branch runs only BECAUSE no
 *  attached-exit event exists. Every audit row is inspected rather than only the
 *  latest, so a subsequent same-status one (complete_empty_result_backfilled,
 *  which writes a result and never touches completed_at) cannot mask the
 *  transition that rewrote it. */
function reconciledIntoComplete(payloads: string | null): boolean {
  if (!payloads) return false;
  return payloads.split(RECONCILED_SEPARATOR).some((payload) => {
    const parsed = payloadObject(payload);
    return parsed?.["to"] === "complete" && parsed["from"] !== "complete";
  });
}

/** FG-662: when the agent actually stopped, or null when nothing on the record
 *  says. An attached-exit event is the agent-observed end and wins over
 *  completed_at outright, because a cancel, a sweep or a gate rejection can
 *  rewrite completed_at long after the container died. With no such event — the
 *  measured attempt logged none, or every one it has predates its started_at
 *  (clock skew, a prior attempt's exit) — completed_at is the end only if the
 *  terminal was not written administratively, on either the failure side (an
 *  administrative failure_kind) or the success side (a sweep that completed the
 *  task); otherwise the row has no defensible end and contributes nothing. */
function agentObservedEndMs(row: AgentRuntimeRow): number | null {
  if (row.agentExit !== null) {
    const exitedMs = Date.parse(row.agentExit);
    if (Number.isFinite(exitedMs)) return exitedMs;
  }
  const kind = row.status === "failed" ? failureKindOf(row.failedPayload) : null;
  if (kind !== null && ADMINISTRATIVE_TERMINAL_KINDS.has(kind)) return null;
  if (reconciledIntoComplete(row.reconciledPayloads)) return null;
  const completedMs = Date.parse(row.completed);
  return Number.isFinite(completedMs) ? completedMs : null;
}

export function agentRuntimeTrends(
  window: AgentRuntimeWindow,
  scope?: ProjectScope,
  nowMs: number = Date.now(),
): AgentRuntimeTrends {
  const resolution = AGENT_RUNTIME_RESOLUTION[window];
  const bucketMs = RESOLUTION_MS[resolution];
  const floor = (ms: number) => floorToResolution(ms, resolution);

  // The window cutoff is the aligned start of the bucket the raw cutoff falls
  // in, so the leading bucket covers a whole period rather than a truncated one.
  const windowDays = window === "all" ? null : parseInt(window, 10);
  const cutoffStart = windowDays === null ? null : floor(nowMs - windowDays * 86_400_000);

  const params: unknown[] = [];
  let clause = "";
  if (cutoffStart !== null) {
    clause += " AND t.completed_at >= ?";
    params.push(new Date(cutoffStart).toISOString());
  }
  // Every window ends at now. A completed_at in the future (clock skew, a bad
  // backfill) is outside every window, so it is excluded here rather than left
  // to stretch the grid past the window the operator asked for — and excluding
  // it in SQL keeps the chart, the role summary and the sample note agreeing.
  clause += " AND t.completed_at <= ?";
  params.push(new Date(nowMs).toISOString());
  const project = scopeSql("r.project_dir", scope);
  clause += ` ${project.clause}`;
  params.push(...project.params);

  // `t.phase IS 'session'` — SQLite's null-safe equality. With plain `=` a NULL
  // phase makes the whole NOT(...) NULL, which drops the row instead of keeping it.
  // FG-662: `agentExit`, `failedPayload` and `reconciledPayloads` are correlated
  // subqueries in the shape opsMetrics already uses for its failure-kind mix — the
  // earliest attached-exit event of the attempt being measured, the payload of its
  // latest task.failed, and every task.reconciled audit row it carries.
  // `markTaskRunning` re-dispatches a task IN PLACE: started_at moves to the new
  // attempt while the previous attempt's events stay on the stream, so each
  // subquery is bounded at or after started_at rather than taken globally —
  // a prior attempt's exit is not this attempt's end, and a prior attempt's
  // task.failed does not classify this attempt's terminal. Ordering on julianday
  // rather than the raw TEXT also drops an unparseable created_at (NULL, so the
  // comparison is never true) instead of letting it sort below — or, for a
  // latest-wins pick, above — a valid sibling and mask it.
  const exitEvents = AGENT_OBSERVED_EXIT_EVENTS.map((e) => `'${e}'`).join(",");
  const rows = db().prepare(`
    SELECT t.agent_role AS role, t.started_at AS started, t.completed_at AS completed, t.status AS status,
      (SELECT x.created_at FROM events x
        WHERE x.task_id = t.id AND x.event_type IN (${exitEvents})
          AND julianday(x.created_at) >= julianday(t.started_at)
        ORDER BY julianday(x.created_at), x.id LIMIT 1) AS agentExit,
      (SELECT f.payload FROM events f
        WHERE f.task_id = t.id AND f.event_type = 'task.failed'
          AND julianday(f.created_at) >= julianday(t.started_at)
        ORDER BY julianday(f.created_at) DESC, f.id DESC LIMIT 1) AS failedPayload,
      (SELECT group_concat(c.payload, char(30)) FROM events c
        WHERE c.task_id = t.id AND c.event_type = 'task.reconciled'
          AND julianday(c.created_at) >= julianday(t.started_at)) AS reconciledPayloads
    FROM tasks t JOIN runs r ON r.id = t.run_id
    WHERE t.agent_role IS NOT NULL
      AND t.started_at IS NOT NULL
      AND t.completed_at IS NOT NULL
      AND NOT (t.agent_role = 'orchestrator' AND t.phase IS 'session')
      ${clause}
  `).all(...params) as AgentRuntimeRow[];

  type Observation = { role: string; completedMs: number; durationMs: number };
  const observations: Observation[] = [];
  let earliest = Infinity;
  for (const row of rows) {
    const completedMs = Date.parse(row.completed);
    const startedMs = Date.parse(row.started);
    // FG-662: completed_at places the observation, so a row whose completed_at
    // PREDATES its started_at is not describing the attempt being measured —
    // markTaskRunning re-dispatches in place without clearing completed_at, so a
    // retry still in flight carries the previous attempt's terminal. Its own exit
    // event would hand that live attempt a positive duration, plotted into a
    // bucket the earlier attempt's completion owns.
    if (!(completedMs >= startedMs)) continue;
    // The observation still sits in the bucket its completed_at falls in; only the
    // DURATION comes off the agent-observed end.
    const endMs = agentObservedEndMs(row);
    if (endMs === null) continue;
    const durationMs = endMs - startedMs;
    if (!(durationMs >= 0)) continue;
    observations.push({ role: row.role, completedMs, durationMs });
    if (completedMs < earliest) earliest = completedMs;
  }

  // "all" has no fixed start: it begins at the earliest observation actually in
  // scope. With nothing in scope there is no range at all, and no grid to draw.
  const gridStart = cutoffStart ?? (observations.length > 0 ? floor(earliest) : null);
  const rangeEnd = new Date(nowMs).toISOString();
  if (gridStart === null) {
    return { window, resolution, bucketMs, rangeStart: null, rangeEnd, overall: [], byRole: [], roleSummary: [] };
  }

  // The grid ends at the bucket containing now — the same bucket the partial flag
  // sits on — so the trailing bucket is always the current one, in every window.
  const partialStart = floor(nowMs);
  const bucketStarts: number[] = [];
  for (let start = gridStart; start <= partialStart; start += bucketMs) bucketStarts.push(start);

  const series = (subset: Observation[]): AgentRuntimeBucket[] => {
    const sums = new Array<number>(bucketStarts.length).fill(0);
    const counts = new Array<number>(bucketStarts.length).fill(0);
    for (const obs of subset) {
      const index = Math.floor((obs.completedMs - gridStart) / bucketMs);
      if (index < 0 || index >= bucketStarts.length) continue;
      sums[index] = sums[index]! + obs.durationMs;
      counts[index] = counts[index]! + 1;
    }
    return bucketStarts.map((start, index) => ({
      bucketStart: new Date(start).toISOString(),
      averageMs: counts[index]! > 0 ? Math.round(sums[index]! / counts[index]!) : null,
      sampleCount: counts[index]!,
      partial: start === partialStart,
    }));
  };

  const byRoleObservations = new Map<string, Observation[]>();
  for (const obs of observations) {
    const bucket = byRoleObservations.get(obs.role) ?? [];
    bucket.push(obs);
    byRoleObservations.set(obs.role, bucket);
  }

  const roleSummary = [...byRoleObservations.entries()]
    .map(([role, subset]) => ({
      role,
      averageMs: Math.round(subset.reduce((total, obs) => total + obs.durationMs, 0) / subset.length),
      sampleCount: subset.length,
    }))
    .sort((a, b) => b.sampleCount - a.sampleCount || a.role.localeCompare(b.role));

  return {
    window,
    resolution,
    bucketMs,
    rangeStart: new Date(gridStart).toISOString(),
    rangeEnd,
    overall: series(observations),
    byRole: roleSummary.map(({ role }) => ({ role, buckets: series(byRoleObservations.get(role)!) })),
    roleSummary,
  };
}

export function usageRollup(groupBy: GroupBy, since: string, scope?: ProjectScope, limit = 50): UsageRollupRow[] {
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
  const project = scopeSql("r.project_dir", scope);
  const projectClause = project.clause;
  params.push(...project.params);
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

export function usageTimeSeries(since = "30d", scope?: ProjectScope): UsageTimeSeriesRow[] {
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
  const project = scopeSql("r.project_dir", scope);
  const projectClause = project.clause;
  params.push(...project.params);

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

export function usageModelMix(groupBy: GroupBy, since: string, scope?: ProjectScope): ModelMixBucket[] {
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
  const project = scopeSql("r.project_dir", scope);
  const projectClause = project.clause;
  params.push(...project.params);

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
  const now = Date.now();
  if (projectCache && now - projectCache.at < PROJECT_CACHE_MS) return projectCache.projects;
  const projects = presentationRegistry(sortProjects(listProjects(), "activity"));
  projectCache = { at: now, projects };
  return projects;
}

// FG-595: presentation-only view over the canonical ProjectRecord aggregate.
// A checkout is a stale artifact — a deleted scratchpad, a removed temp clone —
// only when it is simultaneously gone from disk (exists===false), carries no
// in-flight work (inFlightCount===0), and hosts no live session
// (liveSessions===0); those are suppressed so the Projects view and checkout
// scope controls stop surfacing dead paths. A present checkout (even if idle),
// or a missing one that still has active work or a live session, stays visible
// — the client labels a surviving missing checkout truthfully rather than as an
// unknown branch. The record's aggregate runCount/inFlightCount/liveSessions/
// lastRunAt and its full historical projectDirs array are passed through
// untouched, so canonical projectKey scope still queries every historical
// feed/usage/run record. A project is omitted only when no visible checkout
// remains after suppression.
export function presentationRegistry(projects: ProjectRecord[]): ProjectRecord[] {
  const out: ProjectRecord[] = [];
  for (const project of projects) {
    const checkouts = project.checkouts.filter(
      (checkout) => checkout.exists || checkout.inFlightCount > 0 || checkout.liveSessions > 0,
    );
    if (checkouts.length === 0) continue;
    out.push({ ...project, checkouts });
  }
  return out;
}

// Registry discovery executes bounded Git commands for every observed checkout.
// Keep it aligned with the dashboard's slow-poll cadence so one canonical
// selection fans out to feed/in-flight/usage/etc. without re-scanning between
// simultaneous requests. DB rows themselves are still queried on every call.
const PROJECT_CACHE_MS = 30_000;
let projectCache: { at: number; projects: ProjectRecord[] } | null = null;

/** Resolve HTTP selection into either one exact checkout or every observed
 * member path of a canonical repository. Unknown keys intentionally match
 * nothing instead of falling back to an unscoped cross-project query. */
export function resolveProjectScope(projectKey?: string, projectDir?: string): ProjectScope {
  if (projectDir) return projectDir;
  if (!projectKey) return undefined;
  return projectsForDashboard().find((project) => project.key === projectKey)?.projectDirs ?? [];
}

// ─── backlog ticket truth (FG-608, FG-496 Slice C) ──────────────────────────
//
// Tickets are HOST-WIDE truth keyed by project_key, not branch-local files.
// Every checkout of one repository — canonical, feature branch, linked worktree,
// clone — answers with the SAME rows, because they all resolve to the same
// project_key. The dashboard's old canonical-main/master ticket-source
// resolution is gone with the branch concept it encoded.
//
// The project_key is DERIVED, never accepted. `backlogTruthForProject` takes a
// resolved ProjectRecord (the dashboard's own registry resolution) and looks its
// repository EVIDENCE key up in project_identity — the same durable arbiter
// src/store/project-registry.ts writes and src/backlog/storage-mode.ts reads.
// Taking a ProjectRecord rather than a key string is the point: a request
// parameter cannot be forged into one, so a client cannot name a project_key the
// dashboard's own resolution does not authorize. The dashboard stays a
// PER-PROJECT board (cross-project aggregation is FG-591, not here).
//
// A repository with no project_identity row has never been imported: it has no
// ticket truth at all, and that is reported as projectKey: null rather than
// papered over with a branch-local Markdown read. Same for a mismatched evidence
// key (a repo registered before it gained a remote) — the operator repair is
// host-side `forge backlog reidentify`, never a read-path fallback.

/** Reconstructed shape of `forge backlog list` — mirrors StructuredTicket in
 *  src/backlog/structured.ts so the dashboard and the CLI describe one ticket
 *  the same way. No checkoutDir/checkoutBranch: a ticket belongs to a project,
 *  not to a checkout. */
export type BacklogTicket = {
  id: string;
  type: string;
  status: string;
  title: string;
  body: string;
  epic?: string;
  created?: string;
  closed?: string;
  closedCommit?: string;
  related?: string[];
};

export type BacklogTruth = {
  /** null = this repository has no ticket truth (never imported / not registered). */
  projectKey: string | null;
  /** Which store is AUTHORITATIVE for those rows. `markdown` means the rows are
   *  an imported shadow the project has not cut over to yet; null when there is
   *  no project_key at all. */
  storageMode: "db" | "markdown" | null;
  tickets: BacklogTicket[];
};

const NO_TICKET_TRUTH: BacklogTruth = { projectKey: null, storageMode: null, tickets: [] };

// src/store/tickets.ts:309. The DB status vocabulary is exactly
// active/done/deferred; legacy `blocked` is stored as active + a blocker_evidence
// row and reconstructed on the way out (src/backlog/structured.ts:519). The
// dashboard reconstructs it identically or it would render an unblocked-looking
// board the CLI disagrees with. Hardcoded like every other column name here —
// the schema-contract drift surface documented at the top of this file.
const LEGACY_BLOCKED_SOURCE = "import-legacy-blocked";

/** Host-wide ticket truth for one resolved project. Throws if the store cannot
 *  be read — the caller decides what a failed read means to its payload. */
export function backlogTruthForProject(project: ProjectRecord): BacklogTruth {
  const identity = db()
    .prepare(`SELECT project_key FROM project_identity WHERE repo_evidence_key = ?`)
    .get(project.key) as { project_key: string } | undefined;
  if (!identity) return NO_TICKET_TRUTH;
  const projectKey = identity.project_key;

  const mode = db()
    .prepare(`SELECT mode FROM ticket_storage_mode WHERE project_key = ?`)
    .get(projectKey) as { mode: string } | undefined;

  const rows = db().prepare(`
    SELECT ticket_id, type, status, title, body, created, closed, closed_commit, epic
    FROM tickets WHERE project_key = ?
  `).all(projectKey) as Array<{
    ticket_id: string;
    type: string;
    status: string;
    title: string;
    body: string;
    created: string | null;
    closed: string | null;
    closed_commit: string | null;
    epic: string | null;
  }>;

  // Two set-wide queries instead of two per ticket: a board with several hundred
  // tickets is a normal size and this route is polled.
  const related = new Map<string, string[]>();
  for (const rel of db().prepare(`
    SELECT ticket_id, related_id FROM ticket_relations
    WHERE project_key = ? AND rel_type = 'related' ORDER BY related_id ASC
  `).all(projectKey) as Array<{ ticket_id: string; related_id: string }>) {
    const list = related.get(rel.ticket_id) ?? [];
    list.push(rel.related_id);
    related.set(rel.ticket_id, list);
  }

  const blocked = new Set(
    (db().prepare(`SELECT ticket_id FROM blocker_evidence WHERE project_key = ? AND source = ?`)
      .all(projectKey, LEGACY_BLOCKED_SOURCE) as Array<{ ticket_id: string }>).map((r) => r.ticket_id),
  );

  const tickets = rows.map((row): BacklogTicket => {
    const rel = related.get(row.ticket_id);
    return {
      id: row.ticket_id,
      type: row.type,
      status: blocked.has(row.ticket_id) && row.status === "active" ? "blocked" : row.status,
      title: row.title,
      body: row.body,
      ...(rel && rel.length > 0 ? { related: rel } : {}),
      ...(row.created ? { created: row.created } : {}),
      ...(row.closed ? { closed: row.closed } : {}),
      ...(row.closed_commit ? { closedCommit: row.closed_commit } : {}),
      ...(row.epic ? { epic: row.epic } : {}),
    };
  });
  tickets.sort((a, b) => compareTicketIds(a.id, b.id));

  return { projectKey, storageMode: mode?.mode === "db" ? "db" : "markdown", tickets };
}

/** Mirrors compareTicketIds in src/backlog/structured.ts:628 — FG-100 sorts
 *  before FG-99, which a lexical ORDER BY would invert. */
function compareTicketIds(a: string, b: string): number {
  const ma = a.match(/^([A-Za-z]+)-(\d+)$/);
  const mb = b.match(/^([A-Za-z]+)-(\d+)$/);
  if (ma && mb) {
    if (ma[1] !== mb[1]) return ma[1]!.localeCompare(mb[1]!);
    return parseInt(ma[2]!, 10) - parseInt(mb[2]!, 10);
  }
  return a.localeCompare(b);
}

type ProjectPresentation = { label: string; color: string; branch?: string };

const PROJECT_PRESENTATION_CACHE_MS = 5_000;
const projectPresentationCache = new Map<string, { at: number; value: ProjectPresentation | null }>();

function projectPresentation(projectDir: string | null): ProjectPresentation | null {
  if (!projectDir) return null;
  const now = Date.now();
  const cached = projectPresentationCache.get(projectDir);
  if (cached && now - cached.at < PROJECT_PRESENTATION_CACHE_MS) return cached.value;
  const identity = repositoryCheckoutIdentity(projectDir);
  if (!identity.exists) {
    const canonical = projectsForDashboard().find((project) => project.projectDirs.includes(projectDir));
    if (canonical) {
      const value = { label: canonical.label, color: canonical.color };
      projectPresentationCache.set(projectDir, { at: now, value });
      return value;
    }
  }
  const fallbackLabel = !identity.exists
    ? "Unknown repository"
    : identity.remoteName
    ? identity.remoteName.charAt(0).toUpperCase() + identity.remoteName.slice(1)
    : undefined;
  const meta = resolveProjectMeta(projectDir, { fallbackLabel, colorKey: identity.key });
  const value = meta ? {
    label: meta.label,
    color: meta.color,
    ...(identity.branch ? { branch: identity.branch } : {}),
  } : null;
  projectPresentationCache.set(projectDir, { at: now, value });
  return value;
}

// #285: read-only routing/governance read model for the dashboard panel. Backed
// by the SAME governanceView() core as `forge route governance --json`, so the
// dashboard can't drift from the CLI's view of routing. Augments it with the tail
// of the host RACI audit log so policy changes are visible without reading the
// file. Read-only: there is no write counterpart.
function auditLogPath(): string {
  return join(forgeHome(), "raci-audit.log");
}

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
  const path = auditLogPath();
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf8").split("\n").filter((l) => l.trim() !== "");
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
      : join(forgeHome(), "forge-raci.md");

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

function runScopeInfo(runId: string | null): { projectDir: string | null; status: string | null } | null {
  if (!runId) return null;
  const row = db().prepare(`SELECT project_dir, status FROM runs WHERE id = ?`).get(runId) as
    | { project_dir: string | null; status: string | null }
    | undefined;
  if (!row) return null;
  return { projectDir: row.project_dir ?? null, status: row.status ?? null };
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
export function inProgressVerifications(nowMs: number = Date.now(), scope?: ProjectScope): InProgressVerification[] {
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
      // FG-594: an unmatched start only counts as in-progress while its owning
      // run is still active. A terminal run (complete/failed/abandoned) or a
      // missing run means the verification is over — a finish event may have
      // been lost, but the run outcome is authoritative. Fail closed: no run
      // row, or any non-active status, drops the start.
      const runInfo = runScopeInfo(row.run_id);
      if (!runInfo || runInfo.status !== "active") continue;
      // Repository scopes include every observed member checkout; exact-path
      // scopes retain the previous operational filtering semantics. The
      // loop's eager run row carries project_dir; campaign gates resolve via
      // their campaign row (item.runId is frequently null).
      if (!scopeIncludes(scope, runInfo.projectDir)) continue;
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
      if (!scopeIncludes(scope, campaignProjectDir(campaignId))) continue;
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
  checkoutBranch: string | null;
  checkoutName: string | null;
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
export function reviewLoopRunPhases(nowMs: number = Date.now(), scope?: ProjectScope): ReviewLoopRunPhaseEntry[] {
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

  const project = scopeSql("r.project_dir", scope);
  const runRows = db()
    .prepare(`SELECT id, title, workflow, project_dir FROM runs r WHERE r.status = 'active' ${project.clause}`)
    .all(...project.params) as Array<{ id: string; title: string; workflow: string; project_dir: string | null }>;
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

    const meta = projectPresentation(run.project_dir);
    out.push({
      runId: run.id,
      runTitle: run.title,
      workflow: run.workflow,
      projectDir: run.project_dir,
      projectLabel: meta?.label ?? null,
      projectColor: meta?.color ?? null,
      checkoutBranch: meta?.branch ?? null,
      checkoutName: run.project_dir ? basename(run.project_dir) : null,
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
export function hostVerificationsForTicket(ticketId: string, scope?: ProjectScope, limit = 100): HostVerificationEvidenceRow[] {
  const project = scopeSql("project_dir", scope);
  const params: unknown[] = [ticketId];
  params.push(...project.params);
  params.push(limit);
  const rows = db()
    .prepare(`SELECT * FROM host_verifications WHERE ticket_id = ? ${project.clause} ORDER BY recorded_at DESC LIMIT ?`)
    .all(...params) as HostVerificationDbRow[];
  return rows.map(rowToHostVerification);
}

/** Same evidence, scoped by campaign item. host_verifications has no item_id
 *  column (FG-477: no new lifecycle/evidence table) — this resolves the
 *  item's ticketId and its campaign's project_dir via campaign_items →
 *  campaigns, then delegates to the ticket-scoped lookup. Returns [] for an
 *  unknown item id rather than throwing. */
export function hostVerificationsForCampaignItem(itemId: string, scope?: ProjectScope): HostVerificationEvidenceRow[] {
  const item = db()
    .prepare(
      `SELECT ci.ticket_id AS ticket_id, c.project_dir AS project_dir
       FROM campaign_items ci JOIN campaigns c ON c.id = ci.campaign_id
       WHERE ci.id = ?`
    )
    .get(itemId) as { ticket_id: string; project_dir: string | null } | undefined;
  if (!item) return [];
  if (!scopeIncludes(scope, item.project_dir)) return [];
  return hostVerificationsForTicket(item.ticket_id, item.project_dir ?? undefined);
}

/** Unscoped, most-recent-first — the AC5 breadcrumb: a completed
 *  orchestrator-run bare gate (e.g. `npm run test:all` invoked directly, no
 *  review-loop/reconcile wrapper) has no in-flight window to catch, but its
 *  recorded row is still discoverable here after the fact. */
export function recentHostVerifications(limit = 50, scope?: ProjectScope): HostVerificationEvidenceRow[] {
  const project = scopeSql("project_dir", scope);
  const rows = db().prepare(`SELECT * FROM host_verifications WHERE 1 = 1 ${project.clause} ORDER BY recorded_at DESC LIMIT ?`)
    .all(...project.params, limit) as HostVerificationDbRow[];
  return rows.map(rowToHostVerification);
}

// ─── FG-638: the review ledger (read-only) ──────────────────────────────────
//
// The dashboard presents the review ledger as the managed object: a summary per
// review plus its findings rows. This is the first release, so it is READ-ONLY —
// disposition controls stay on the CLI until that surface is proven.
//
// Note the shape: findings are embedded in their review rather than fetched by a
// second round trip. A review's findings are the review, and a panel that renders
// a summary whose counts disagree with the rows below it is the exact failure this
// avoids — both come from one query pair, at one instant.

export type ReviewLedgerSource = {
  verdictId?: string;
  redTaskId?: string;
  redRole?: string;
  authority?: string;
  modelFindingId?: string;
  note?: string;
};

export type ReviewLedgerFinding = {
  id: string;
  findingRef: string;
  summary: string;
  severity: string | null;
  riskLens: string | null;
  reachability: string | null;
  file: string | null;
  line: number | null;
  quotedText: string | null;
  acceptanceRef: string | null;
  invariantRef: string | null;
  sources: ReviewLedgerSource[];
  disposition: string;
  dispositionRationale: string | null;
  decidedBy: string | null;
  duplicateOf: string | null;
  followupTicketId: string | null;
  resolution: string | null;
  resolutionEvidenceKind: string | null;
  resolutionEvidence: string | null;
};

export type ReviewLedgerEntry = {
  id: string;
  runId: string | null;
  subjectTaskId: string | null;
  ticketId: string | null;
  projectDir: string | null;
  baseSha: string | null;
  contractConfirmedSha: string | null;
  candidateSha: string | null;
  trustedRemoteSha: string | null;
  reviewMode: string;
  state: string;
  riskLenses: string[];
  createdAt: string;
  updatedAt: string;
  settledAt: string | null;
  countsByDisposition: Record<string, number>;
  countsByResolution: Record<string, number>;
  findings: ReviewLedgerFinding[];
};

type ReviewDbRow = {
  id: string;
  run_id: string | null;
  subject_task_id: string | null;
  ticket_id: string | null;
  project_dir: string | null;
  base_sha: string | null;
  contract_confirmed_sha: string | null;
  candidate_sha: string | null;
  trusted_remote_sha: string | null;
  contract_json: string | null;
  review_mode: string;
  state: string;
  created_at: string;
  updated_at: string;
  settled_at: string | null;
};

type ReviewFindingDbRow = {
  id: string;
  review_id: string;
  finding_ref: string;
  summary: string;
  severity: string | null;
  risk_lens: string | null;
  reachability: string | null;
  file: string | null;
  line: number | null;
  quoted_text: string | null;
  acceptance_ref: string | null;
  invariant_ref: string | null;
  sources_json: string;
  disposition: string;
  disposition_rationale: string | null;
  decided_by: string | null;
  duplicate_of: string | null;
  followup_ticket_id: string | null;
  resolution: string | null;
  resolution_evidence_kind: string | null;
  resolution_evidence: string | null;
};

function rowToReviewFinding(row: ReviewFindingDbRow): ReviewLedgerFinding {
  return {
    id: row.id,
    findingRef: row.finding_ref,
    summary: row.summary,
    severity: row.severity,
    riskLens: row.risk_lens,
    reachability: row.reachability,
    file: row.file,
    line: row.line,
    quotedText: row.quoted_text,
    acceptanceRef: row.acceptance_ref,
    invariantRef: row.invariant_ref,
    sources: JSON.parse(row.sources_json) as ReviewLedgerSource[],
    disposition: row.disposition,
    dispositionRationale: row.disposition_rationale,
    decidedBy: row.decided_by,
    duplicateOf: row.duplicate_of,
    followupTicketId: row.followup_ticket_id,
    resolution: row.resolution,
    resolutionEvidenceKind: row.resolution_evidence_kind,
    resolutionEvidence: row.resolution_evidence,
  };
}

function riskLensesOf(contractJson: string | null): string[] {
  if (contractJson === null) return [];
  const contract = JSON.parse(contractJson) as { risk_lenses?: unknown };
  return Array.isArray(contract.risk_lenses) ? contract.risk_lenses.map(String) : [];
}

/** Reviews (most recently touched first) with their findings, scoped through the
 *  owning run's project_dir. A review with no run is unscoped and always listed. */
export function reviewLedger(scope?: ProjectScope, limit = 25): ReviewLedgerEntry[] {
  const project = scopeSql("runs.project_dir", scope);
  const reviews = db()
    .prepare(
      `SELECT reviews.*, runs.project_dir AS project_dir
         FROM reviews LEFT JOIN runs ON runs.id = reviews.run_id
        WHERE 1 = 1 ${project.clause}
        ORDER BY reviews.updated_at DESC, reviews.id DESC
        LIMIT ?`,
    )
    .all(...project.params, limit) as ReviewDbRow[];
  if (reviews.length === 0) return [];

  const placeholders = reviews.map(() => "?").join(", ");
  const findings = db()
    .prepare(`SELECT * FROM review_findings WHERE review_id IN (${placeholders}) ORDER BY review_id ASC, ordinal ASC`)
    .all(...reviews.map((r) => r.id)) as ReviewFindingDbRow[];

  return reviews.map((r) => {
    const own = findings.filter((f) => f.review_id === r.id).map(rowToReviewFinding);
    const countsByDisposition: Record<string, number> = {};
    const countsByResolution: Record<string, number> = {};
    for (const f of own) {
      countsByDisposition[f.disposition] = (countsByDisposition[f.disposition] ?? 0) + 1;
      const resolution = f.resolution ?? "unresolved";
      countsByResolution[resolution] = (countsByResolution[resolution] ?? 0) + 1;
    }
    return {
      id: r.id,
      runId: r.run_id,
      subjectTaskId: r.subject_task_id,
      ticketId: r.ticket_id,
      projectDir: r.project_dir,
      baseSha: r.base_sha,
      contractConfirmedSha: r.contract_confirmed_sha,
      candidateSha: r.candidate_sha,
      trustedRemoteSha: r.trusted_remote_sha,
      reviewMode: r.review_mode,
      state: r.state,
      riskLenses: riskLensesOf(r.contract_json),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      settledAt: r.settled_at,
      countsByDisposition,
      countsByResolution,
      findings: own,
    };
  });
}
