// Direct better-sqlite3 reads of ~/.forge/forge.db.
//
// Row types are re-exported from forge's @forge/types so the dashboard and
// forge share the same shape. The inline `as Array<{...}>` casts in each
// query function still hardcode snake_case column names — until forge
// introduces a single source of truth for the SQL schema, those casts are
// the remaining drift surface (column rename = runtime failure, not compile
// error). Documented in docs/SCHEMA-CONTRACT.md.

import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { Run, Task } from "@forge/types";
import { resolveProjectMeta } from "@forge/project-meta";
import { listProjects, sortProjects, type ProjectRecord } from "@forge/projects";
import { repositoryCheckoutIdentity } from "@forge/repository-identity";
import { governanceView, type GovernanceView } from "@forge/governance";
import { LEGACY_BLOCKED_SOURCE, isStatusBearingEvidenceSource } from "@forge/blocked-source";
import {
  findReconcileCandidates,
  type LivenessProbe,
  type ReconcileClassification,
  type ReconcileReason,
} from "@forge/reconcile-candidate";
import {
  LAUNCH_OBSERVATION_COLUMNS,
  hasPlacementAuthority,
  rowToLaunchObservation,
  type LaunchObservationRow,
} from "@forge/launch-observations";
// FG-679: the ONE shared derivation and the ONE human rendering of the launch status
// vocabulary, imported rather than reimplemented — `statusLine` is what keeps the four
// BD-4 facts four distinct facts on this surface too.
import {
  LAUNCH_OBSERVATION_FRESH_MS,
  deriveCurrentActivity,
  isLaunchId,
  observationIsFresh,
  statusLine,
  type CurrentActivity,
  type CurrentActivityScope,
} from "@forge/current-activity";

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

// FG-609 surface (iii) of four. The DB status vocabulary is exactly
// active/done/deferred; legacy `blocked` is stored as active + a blocker_evidence
// row and reconstructed on the way out. The dashboard reconstructs it identically
// or it would render an unblocked-looking board the CLI disagrees with.
//
// This literal used to be a PRIVATE COPY here — the one exception to "hardcoded
// like every other column name", because it is not a column name but a VALUE two
// independent code paths must agree on, and each side's own tests wrote the string
// they read, so a drift in either copy stayed green on both suites. Slice D
// collapses it: the sole declaration is src/store/blocked-source.ts, a ZERO-IMPORT
// leaf reached through the @forge/blocked-source path alias. Routing it through
// src/store/tickets.ts instead was not an option — that module imports getDb, which
// would drag better-sqlite3 and the whole store handle into this typecheck.

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

// ── FG-679: Current activity — a READ-ONLY projection, and nothing else ──
//
// These entry points exist so the dashboard can answer "is something happening, or
// is this stuck?" from PERSISTED state alone. They are deliberately separate from
// `/api/in-flight`: that endpoint already `execFileSync`s `docker inspect` per
// running task through FG-290's reconcile-candidate annotation (a pre-existing,
// RECORDED exception — BD-13), so folding these in would make BD-7's
// no-outbound-call criterion unassertable. Nothing below shells out, probes tmux,
// calls `readLaunch`/`listLaunches`, or reaches for `projectPresentation` (which
// resolves its label through repositoryCheckoutIdentity → `execFileSync("git", …)`,
// the second recorded exception — BD-18). The new sections carry a weaker,
// basename-derived project label instead of acquiring a second subprocess.

export type { CurrentActivity };

function activityScope(scope: ProjectScope, runId?: string): CurrentActivityScope {
  if (runId !== undefined && runId !== "") return { runId };
  if (scope === undefined) return {};
  return { projectDirs: typeof scope === "string" ? [scope] : [...scope] };
}

/** The ONE shared derivation `forge status` also calls (BD-9). The dashboard adds
 *  no interpretation of its own — agreement is structural, not asserted. */
export function currentActivity(scope?: ProjectScope, runId?: string, nowMs: number = Date.now()): CurrentActivity {
  return deriveCurrentActivity(db(), { now: new Date(nowMs), scope: activityScope(scope, runId) });
}

/** BD-10: launch detail addressed by IDENTITY. The id is validated against the same
 *  charset `launchDir` enforces BEFORE it can become a path, and the response
 *  deliberately carries NO host filesystem path — not the cwd, not the log path, not
 *  the project dir. The operator reaches the log through `/api/launches/:id/log`,
 *  which is likewise addressed by id. */
export type LaunchDetail = {
  launchId: string;
  name: string | null;
  command: string[];
  commandLine: string;
  startedAt: string;
  observedAt: string;
  statusLabel: string;
  state: string;
  observation: "fresh" | "unobserved";
  terminal: boolean;
  associationKind: string;
  unassociated: boolean;
  runId: string | null;
  taskId: string | null;
  ticketId: string | null;
  campaignId: string | null;
  itemId: string | null;
  projectLabel: string | null;
};

export function launchDetail(launchId: string, nowMs: number = Date.now()): LaunchDetail | null {
  if (!isLaunchId(launchId)) return null;
  const row = db()
    .prepare(`SELECT ${LAUNCH_OBSERVATION_COLUMNS} FROM launch_observations WHERE launch_id = ?`)
    .get(launchId) as LaunchObservationRow | undefined;
  if (!row) return null;
  const obs = rowToLaunchObservation(row);
  const observedMs = Date.parse(obs.observedAt);
  // The SAME range predicate the shared derivation applies — a future-dated
  // observation is unusable, not maximally fresh.
  const fresh = observationIsFresh(Number.isFinite(observedMs) ? observedMs : null, nowMs, LAUNCH_OBSERVATION_FRESH_MS);
  // A terminal disposition is evidence that does not decay — it already happened.
  // Only a NON-terminal observation goes stale, and when it does it reads
  // `unobserved since <t>`: never `running`, never a fabricated terminal (BD-12).
  const stale = !obs.terminal && !fresh;
  return {
    launchId: obs.launchId,
    name: obs.name,
    command: obs.command,
    commandLine: obs.command.join(" "),
    startedAt: obs.startedAt,
    observedAt: obs.observedAt,
    statusLabel: stale ? `unobserved since ${obs.observedAt}` : statusLine(obs.status),
    state: stale ? "unknown" : obs.status.state,
    observation: stale ? "unobserved" : "fresh",
    terminal: obs.terminal,
    associationKind: obs.associationKind,
    // The DECLARED submission ids, matching the shared derivation exactly:
    // `association_kind` names which channel resolved the project home (FG-684 AC4),
    // which is a different question from whether the launch was associated at all.
    unassociated: !hasPlacementAuthority(obs),
    runId: obs.runId,
    taskId: obs.taskId,
    ticketId: obs.ticketId,
    campaignId: obs.campaignId,
    itemId: obs.itemId,
    projectLabel: obs.projectDir === null ? null : basename(obs.projectDir),
  };
}

/** The launch log is UNBOUNDED host-command output, served by a process with no
 *  authentication (dashboard/src/server.ts binds an env-overridable address, defaulting
 *  to loopback). So the response is a BOUNDED TAIL by construction — id-only addressing
 *  constrains path traversal, not content volume, and only this bound constrains the
 *  latter. The bound matches the container-log surface's discipline; it is deliberately
 *  tighter than that surface's 64 KiB because a launch log is the operator's OWN shell
 *  environment (FG-626's reproduction is literally `forge launch run -- env`). */
export const LAUNCH_LOG_TAIL_BYTES = 16 * 1024;

/** What this response IS, stated in the response itself. There is no redactor here and
 *  there will not be one: docs/redaction.md establishes ALLOWLIST discipline for this
 *  codebase, and a denylist secret-scrubber over arbitrary command output would provide
 *  false assurance rather than safety. So the surface says plainly what it renders —
 *  raw stdout/stderr of a host command, in the operator's own environment — and a
 *  reader is never left to infer that something sanitized it. */
export const LAUNCH_LOG_CONTENT_NOTICE =
  "raw stdout/stderr of a host command, unredacted — it may contain environment variables, tokens or other secrets the command printed";

export type LaunchLogTail = {
  launchId: string;
  text: string;
  bytes: number;
  truncated: boolean;
  /** Always `raw`. A field rather than prose so a consumer must handle it. */
  content: "raw";
  notice: string;
  /** The tail bound in bytes, so a reader knows WHAT it is looking at without
   *  reverse-engineering it from `bytes` vs `text.length`. */
  maxBytes: number;
};

export function launchLogTail(launchId: string, maxBytes = LAUNCH_LOG_TAIL_BYTES): LaunchLogTail | null {
  if (!isLaunchId(launchId)) return null;
  // The id has no separator and no `..` (isLaunchId), so this can only ever name a
  // direct child of the launches dir. FORGE_HOME is resolved PER CALL (FG-616), never
  // snapshotted at module eval.
  const logPath = join(forgeHome(), "launches", launchId, "out.log");
  if (!existsSync(logPath)) return null;
  const size = statSync(logPath).size;
  const start = Math.max(0, size - maxBytes);
  const length = size - start;
  const buf = Buffer.alloc(length);
  const fd = openSync(logPath, "r");
  try {
    readSync(fd, buf, 0, length, start);
  } finally {
    closeSync(fd);
  }
  return {
    launchId,
    text: buf.toString("utf8"),
    bytes: size,
    truncated: start > 0,
    content: "raw",
    notice: LAUNCH_LOG_CONTENT_NOTICE,
    maxBytes,
  };
}

// ─── FG-591: the operator work queue board (GET /api/queue) ──────────────────
//
// THE FIVE VIEWS ARE PROJECTIONS OVER ORTHOGONAL DURABLE FIELDS, NOT FIVE
// COMPETING STATUSES. Exactly three durable facts are read per ticket — the
// lifecycle status (active | done | deferred), the nullable stack rank
// (tickets.priority_rank) and queue membership (queue_membership) — and
// everything else on a row is DERIVED on this read:
//   in progress — dispatch evidence with a non-terminal task, OR a live claim
//                 that has stamped its launch identity but whose first task has
//                 not spawned yet (see LAUNCHING below).
//   blocked     — blocker_evidence, by the SAME wide predicate the queue's own
//                 isQueueBlocked uses: status-bearing legacy evidence OR an
//                 enriched row whose queue_projection is 'blocked'.
//   done        — the lifecycle status, verbatim.
// Nothing here stores or writes any of it, and no column named in_progress or
// blocked exists to store.
//
// LAUNCHING — the window this projection would otherwise render as nothing.
// ticket_dispatch_evidence is written in exactly one place (src/v2/spawn.ts) when
// a spawned TASK carries a ticketId, so a queue-launched run only reads as in
// progress once its FIRST task spawns. Between the claim's launch stamp and that
// spawn a container is starting and the board would show an idle queue entry. So
// executionState carries `launching` beside `running`, from the RESERVATION's own
// launch_id — and the two stay distinguishable rather than collapsed.
//
// RESERVATION vs EXECUTION. queue_claims is authoritative for the reservation and
// the run/task record for the execution; they are read by SEPARATE queries and
// never joined in one, and neither is derived from the other. The payload keeps
// them as separate fields for the same reason.
//
// A SCHEDULING WAIT IS NOT A BLOCKER. "FG-123 is holding the worktree lane" is
// per-evaluation dispatcher scan evidence that evaporates when the active set
// changes; it lives in dispatcher_evaluations.scan_evidence and is read here as a
// `scheduling` wait on a row that stays in the QUEUED view. It is never
// blocker_evidence — that table is durable, per-ticket and partly container-visible,
// and a scheduling wait written there would silently reinterpret the ticket's status
// for every agent container.
//
// READ-ONLY, DIRECT SQL, NO OUTBOUND CALL. Same handle and same drift caveat as the
// rest of this file: column names are hardcoded here and the store modules own the
// writes. The literals that are VALUES rather than column names (the order-affecting
// queue event types, the terminal task statuses, the policy defaults, the content
// hash) are pinned against their single declarations by
// fg591-queue-projection.test.ts, because each side's own tests would otherwise write
// the string they read and drift stays green on both.

/** The order-affecting queue event types — the version a reorder is submitted
 *  against (D11). Mirrors QUEUE_ORDER_EVENT_TYPES in src/store/queue.ts, which
 *  cannot be imported here (it reaches getDb). Pinned by test. */
const QUEUE_ORDER_EVENT_TYPES = ["rank", "unrank", "enqueue", "dequeue", "reorder"] as const;

/** Mirrors TERMINAL_TASK_STATUSES in src/store/queue.ts: everything else —
 *  running, awaiting_gate, awaiting_red, blocked_by_red, awaiting_recovery — is
 *  work still in flight, which is what makes a ticket read as in progress. */
const TERMINAL_TASK_STATUSES = ["complete", "failed"] as const;

/** The queue projection value that means "this evidence blocks execution". The
 *  other value the column carries, 'not_ready', is a readiness hint and is
 *  deliberately not blocking. Mirrors QUEUE_BLOCKING_PROJECTION in queue.ts. */
const QUEUE_BLOCKING_PROJECTION = "blocked";

/** The readiness outcomes that permit an enqueue (QUEUEABLE_OUTCOMES in queue.ts).
 *  `exploratory` is deliberately included — a spike is queueable without ACs. */
const QUEUEABLE_READINESS_OUTCOMES = new Set(["ready", "exploratory"]);

/** dispatcher_policy defaults, mirroring src/store/dispatcher-policy.ts. `armed`
 *  is fail-closed: an absent row, a NULL column and an explicit 0 all read as
 *  false, so a store that has never seen an operator arm it never reads as armed. */
const DISPATCHER_POLICY_DEFAULTS = {
  maxActiveRuns: 1,
  capacityScope: "host" as "host" | "project",
  leaseTtlMs: 15 * 60_000,
  heartbeatMs: 5 * 60_000,
  defaultWorkflow: "feature",
};

/** The exclusive board columns. `backlog`, `queued`, `in_progress`, `blocked` and
 *  `done` are the five the ticket names; `executing_not_queued` is the sixth state
 *  the schema anticipated and the projection had no name for — an operator dequeue
 *  never releases a live claim (D4), so a dequeued item whose container is still
 *  running is a REAL, reachable state. Rendering it as a gap is how a live container
 *  becomes a phantom on the board. */
export const QUEUE_BOARD_VIEWS = [
  "backlog",
  "queued",
  "in_progress",
  "blocked",
  "done",
  "executing_not_queued",
] as const;

export type QueueBoardView = (typeof QUEUE_BOARD_VIEWS)[number];

/** running — a non-terminal task exists for this ticket. launching — the claim
 *  stamped its launch identity and no task has spawned yet. idle — neither. */
export type QueueExecutionState = "idle" | "launching" | "running";

/** WHY A QUEUED ITEM IS NOT RUNNING. The kinds are deliberately distinct: a
 *  genuine blocker and a temporary scheduling incompatibility are different facts
 *  with different durability, different owners and different operator actions. */
export type QueueWaitKind =
  /** Durable blocker evidence. The row is in the derived Blocked view. */
  | "blocker"
  /** TEMPORARY and self-clearing: the candidate cannot safely overlap the current
   *  active set. Stays QUEUED with the explanation. Never Blocked. */
  | "scheduling"
  /** The ceiling was full. `holders` on the capacity panel names who held the slots. */
  | "capacity"
  /** No assessment, a stale one, or an outcome outside ready|exploratory. */
  | "readiness"
  /** A queue member with no rank: the queue is ordered BY rank, so it has no position. */
  | "unranked"
  /** Ranked and a member, execution-ineligible by lifecycle (FG-609 D5). */
  | "deferred"
  /** A live claim held by someone — the reservation exists, the launch has not
   *  been stamped (or was released) yet. */
  | "claimed"
  /** Autonomous dispatch is disarmed. Queue membership is planning intent, and
   *  never execution authorization. */
  | "disarmed"
  /** No durable evaluation covers this ticket. Reported as such rather than
   *  guessed at — an unrecorded reason is not an answer. */
  | "not_evaluated";

export type QueueBoardWait = {
  kind: QueueWaitKind;
  /** Operator-readable, and concrete: the dispatcher's own reason string where
   *  there is one ("waiting for FG-123 to finish"), never a bare boolean. */
  reason: string;
  /** Where the answer came from, so a reader can tell a durable per-ticket fact
   *  from a per-evaluation observation that will evaporate. */
  source: "blocker_evidence" | "dispatcher_evaluation" | "queue_state" | "dispatcher_policy";
  /** When the dispatcher observed it (ISO). Null for a durable queue-state fact. */
  observedAt: string | null;
};

export type QueueBoardBlocker = {
  source: string;
  kind: string | null;
  reason: string | null;
  detail: string | null;
  queueProjection: string | null;
  createdAt: string | null;
  /** True when THIS row is what makes the queue projection blocked. */
  blocking: boolean;
};

export type QueueBoardReadiness = {
  outcome: string;
  gaps: string[];
  refinementProposal: string | null;
  revision: number | null;
  evaluatedAt: string;
  /** A body-hash mismatch against the ticket's CURRENT content. There is no other
   *  definition of stale, and a stale assessment is operator-actionable — the
   *  dispatcher never silently re-evaluates it (D7). */
  stale: boolean;
  /** The assessment permits an enqueue AND still describes the current revision. */
  queueable: boolean;
};

/** The RESERVATION half. Never joined to the execution half in one query. */
export type QueueBoardReservation = {
  claimId: string;
  owner: string;
  generation: number;
  ticketRevision: number;
  launchId: string | null;
  runId: string | null;
  leaseExpiresAtMs: number;
  heartbeatAtMs: number;
  /** The lease is strictly expired on the STORE clock — recoverable by takeover.
   *  An expired lease proves the owner stopped heartbeating; it proves NOTHING
   *  about the container, which is why the launch identity is durable. */
  leaseExpired: boolean;
  claimedAt: string;
};

export type QueueBoardRow = {
  ticketId: string;
  title: string;
  type: string;
  /** The lifecycle status verbatim (active | done | deferred). NOT a projection. */
  status: string;
  /** DURABLE FACT 1 — the one canonical stack rank. Null is a perfectly valid
   *  backlog item, not a deprioritized one. */
  rank: number | null;
  /** DURABLE FACT 2 — operator queue membership, orthogonal to rank and lifecycle. */
  queued: boolean;
  enqueuedAt: string | null;
  enqueuedBy: string | null;
  note: string | null;
  /** DERIVED. Never stored. */
  blocked: boolean;
  blockers: QueueBoardBlocker[];
  /** DERIVED. Never stored. */
  inProgress: boolean;
  executionState: QueueExecutionState;
  reservation: QueueBoardReservation | null;
  readiness: QueueBoardReadiness | null;
  /** The exclusive board column this row renders in. */
  view: QueueBoardView;
  /** Why it is not running, when it is not. Null for a row that IS running, is
   *  done, or is a plain backlog item the operator has not queued. */
  wait: QueueBoardWait | null;
  /** The dispatcher's own per-candidate verdict from the last evaluation that
   *  scanned this ticket — queue-claims' ScanReason vocabulary verbatim, never a
   *  second one. Null when the last evaluation did not reach this candidate. */
  scanReason: string | null;
  scanDetail: string | null;
};

export type QueueCapacityHolder = {
  claimId: string;
  projectKey: string;
  /** The registry label for that project, when the holder is resolvable to one.
   *  Null rather than a guess — but projectKey is always present, which is what
   *  makes a HOST-scoped refusal readable from a single project's board. */
  projectLabel: string | null;
  ticketId: string;
  owner: string;
  launchId: string | null;
  runId: string | null;
  /** False means ANOTHER project holds this slot. */
  thisProject: boolean;
};

export type QueueCapacity = {
  scope: "host" | "project";
  limit: number;
  /** REPORTED at read time from live claim rows. The ENFORCED count is taken
   *  inside claimNextEligible's write transaction and is the only one that bounds
   *  admission; this number is an observation of the same rows a moment later. */
  queueOwnedActive: number;
  holders: QueueCapacityHolder[];
  otherProjectHolders: number;
  /** THE STATED CAPACITY POLICY. The ceiling bounds QUEUE-OWNED runs only.
   *  Operator-initiated runs, campaign items and review loops carry no claim row,
   *  are structurally invisible to the enforced count, and are reported here
   *  beside it rather than subtracted from it — a dispatcher-side subtraction
   *  would read as a guarantee and be a guess. */
  notCounted: {
    /** Non-terminal tasks host-wide, counted independently of any claim row. */
    activeTasks: number;
    policy: string;
  };
  /** The last evaluation the ceiling actually refused, with the holder list AS IT
   *  WAS at refusal time — by the time an operator looks, the holder may have
   *  finished, and "who held the slot when I was refused" is the question. */
  lastRefusal: {
    evaluatedAt: string;
    scope: string | null;
    limit: number | null;
    used: number | null;
    holders: QueueCapacityHolder[];
  } | null;
};

/** The six answers that must stay DISTINGUISHABLE rather than collapsing into
 *  "nothing is running", plus the two honest unknowns. Every value is read from a
 *  durable record — the policy row, the lease row, the evaluation row — and never
 *  inferred from the absence of activity. */
export type DispatcherPanelState =
  | "dispatching"
  | "disarmed"
  | "no_capacity"
  | "no_eligible_work"
  | "incompatible_only"
  | "lost"
  | "stale_dispatcher"
  | "no_dispatcher"
  | "not_evaluated";

export type DispatcherPanel = {
  armed: boolean;
  /** False when NO host policy row has ever been written: every value below is a
   *  default rather than an operator choice, and the surface says so instead of
   *  presenting a default as a decision. */
  configured: boolean;
  maxActiveRuns: number;
  capacityScope: "host" | "project";
  leaseTtlMs: number;
  heartbeatMs: number;
  defaultWorkflow: string;
  updatedAt: string | null;
  updatedBy: string | null;
  lease: {
    owner: string;
    generation: number;
    leaseExpiresAtMs: number;
    heartbeatAtMs: number;
    host: string | null;
    pid: number | null;
    createdAt: string;
    updatedAt: string;
  } | null;
  /** The lease has not expired on the store clock — the owner is still authorized. */
  leaseLive: boolean;
  leaseExpired: boolean;
  /** How long since the owner was last actually ALIVE. "Nothing to do" and "the
   *  dispatcher died four hours ago" must be distinguishable, and only the
   *  heartbeat column can say so. */
  msSinceHeartbeatMs: number | null;
  lastEvaluation: {
    reason: string;
    detail: string | null;
    evaluatedAt: string;
    evaluatedAtMs: number;
    wakeKind: string | null;
    claimedTicketId: string | null;
    capacityScope: string | null;
    capacityLimit: number | null;
    capacityUsed: number | null;
    scannedCount: number | null;
  } | null;
  nextWatchdogAtMs: number | null;
  pendingWakes: number;
  state: DispatcherPanelState;
  stateDetail: string;
  /** Arming autonomous dispatch and setting the ceiling are CLI-only in this
   *  story (D2): an unauthenticated localhost POST that authorizes unattended
   *  container execution is a materially larger capability than the read surface
   *  this route is. Stated in the payload so the board renders an affordance
   *  rather than a disabled button. */
  controlSurface: "cli-only";
};

export type QueueBoard = {
  /** null = this repository has no ticket truth (never imported / not registered). */
  projectKey: string | null;
  storageMode: "db" | "markdown" | null;
  /** The operator queue is a DB-store concept; a markdown-mode project has none. */
  queueAvailable: boolean;
  unavailableReason: string | null;
  /** The version a reorder must carry (D11) — the id of the project's most recent
   *  order-affecting queue event, 0 for a queue that has never moved. */
  version: number;
  /** THE COMPLETE BACKLOG (AC1): every non-done ticket, ranked or not, deferred
   *  ones visible and marked execution-ineligible — plus the done tickets the
   *  queue has actually touched (ranked, a member, or claimed at some point), so
   *  the Done column has content without becoming the entire closed backlog. */
  rows: QueueBoardRow[];
  /** The exclusive partition of `rows` into board columns, in canonical order. */
  views: Record<QueueBoardView, string[]>;
  dispatcher: DispatcherPanel;
  capacity: QueueCapacity;
  nowMs: number;
  /** Named reads that could not be answered (a store whose last writable open
   *  predates these tables). Empty is the normal case; a non-empty entry means a
   *  section is UNKNOWN rather than empty. */
  degraded: string[];
};

/** A fresh, unshared empty column set. Returned by a function rather than held as
 *  a shared constant: a spread would copy the record and alias every array. */
function emptyBoardViews(): Record<QueueBoardView, string[]> {
  return { backlog: [], queued: [], in_progress: [], blocked: [], done: [], executing_not_queued: [] };
}

/** THE COLUMN, decided from the orthogonal facts alone.
 *
 *  Precedence, and why: lifecycle `done` first (a finished ticket is not waiting
 *  on anything); then execution, because a running container is the most urgent
 *  true statement about a row and is what makes the not-a-member-but-executing
 *  state visible at all; then blocked, which only applies to queue MEMBERS — a
 *  non-member blocked ticket stays in Backlog carrying `blocked: true`, because
 *  the Blocked column is the operator's queue seen through a blocker, not a view
 *  of every impeded ticket in the repository. */
export function classifyQueueBoardView(facts: {
  status: string;
  queued: boolean;
  blocked: boolean;
  executionState: QueueExecutionState;
}): QueueBoardView {
  if (facts.status === "done") return "done";
  if (facts.executionState !== "idle") return facts.queued ? "in_progress" : "executing_not_queued";
  if (facts.blocked && facts.queued) return "blocked";
  if (facts.queued) return "queued";
  return "backlog";
}

/** WHY THIS ITEM IS NOT RUNNING — pure over already-hydrated facts.
 *
 *  The ordering is durable-facts-first: what the store knows about the TICKET
 *  (lifecycle, membership, rank, blockers, readiness) is a better answer than what
 *  the dispatcher observed about a PASS, and it does not evaporate. Only when the
 *  ticket itself is fine do we fall through to the per-evaluation scan evidence,
 *  which is where a temporary scheduling incompatibility lives — and it produces a
 *  `scheduling` wait, never a blocker. */
export function deriveQueueWait(facts: {
  status: string;
  queued: boolean;
  rank: number | null;
  blocked: boolean;
  blockerReason: string | null;
  executionState: QueueExecutionState;
  reservation: { owner: string } | null;
  readiness: QueueBoardReadiness | null;
  armed: boolean;
  scan: { reason: string; detail: string | null } | null;
  evaluation: { reason: string; evaluatedAt: string; detail: string | null } | null;
}): QueueBoardWait | null {
  if (facts.status === "done") return null;
  if (facts.executionState !== "idle") return null;
  const observedAt = facts.evaluation?.evaluatedAt ?? null;

  if (facts.status === "deferred") {
    return {
      kind: "deferred",
      reason: "deferred — it keeps its rank, its membership and its history, and is execution-ineligible until it is reactivated.",
      source: "queue_state",
      observedAt: null,
    };
  }
  if (facts.blocked) {
    return {
      kind: "blocker",
      reason: facts.blockerReason ?? "blocker evidence is recorded against this ticket.",
      source: "blocker_evidence",
      observedAt: null,
    };
  }
  if (!facts.queued) return null;
  if (facts.reservation) {
    return {
      kind: "claimed",
      reason: `claimed by ${facts.reservation.owner}; the container has not stamped a launch yet.`,
      source: "queue_state",
      observedAt: null,
    };
  }
  if (facts.rank === null) {
    return {
      kind: "unranked",
      reason: "queued without a rank, so the queue has no position for it. Rank it to give it one.",
      source: "queue_state",
      observedAt: null,
    };
  }
  if (!facts.readiness || !facts.readiness.queueable) {
    const detail = !facts.readiness
      ? "no readiness assessment has been recorded."
      : facts.readiness.stale
        ? `the '${facts.readiness.outcome}' assessment describes an older revision — the ticket was edited after it was recorded.`
        : `it evaluates '${facts.readiness.outcome}'${facts.readiness.refinementProposal ? `: ${facts.readiness.refinementProposal}` : "."}`;
    return { kind: "readiness", reason: detail, source: "queue_state", observedAt: null };
  }

  if (facts.scan) {
    switch (facts.scan.reason) {
      case "incompatible":
        return {
          kind: "scheduling",
          // TEMPORARY and self-clearing. Rendered in the QUEUED column with this
          // explanation — mislabeling it Blocked is the defect the AC names.
          reason: facts.scan.detail ?? "it cannot safely overlap the current active set.",
          source: "dispatcher_evaluation",
          observedAt,
        };
      case "capacity":
        return {
          kind: "capacity",
          reason: facts.scan.detail ?? "the capacity ceiling was full when it was scanned.",
          source: "dispatcher_evaluation",
          observedAt,
        };
      case "already_claimed":
        return {
          kind: "claimed",
          reason: facts.scan.detail ?? "another dispatcher holds a live claim on it.",
          source: "dispatcher_evaluation",
          observedAt,
        };
      case "eligible":
        // It WAS selectable. If the pass still granted nothing, the pass-level
        // reason is the honest answer.
        if (facts.evaluation?.reason === "no_capacity") {
          return {
            kind: "capacity",
            reason: facts.evaluation.detail ?? "the capacity ceiling was full.",
            source: "dispatcher_evaluation",
            observedAt,
          };
        }
        return null;
      default:
        return {
          kind: "not_evaluated",
          reason: `the dispatcher passed it over as '${facts.scan.reason}'${facts.scan.detail ? `: ${facts.scan.detail}` : "."}`,
          source: "dispatcher_evaluation",
          observedAt,
        };
    }
  }

  if (!facts.armed) {
    return {
      kind: "disarmed",
      reason: "autonomous dispatch is disarmed — queue membership is planning intent, never execution authorization. Arm it with `forge queue dispatcher arm`.",
      source: "dispatcher_policy",
      observedAt: null,
    };
  }
  return {
    kind: "not_evaluated",
    reason: facts.evaluation
      ? `the last dispatcher evaluation (${facts.evaluation.reason}) did not reach this candidate.`
      : "no dispatcher evaluation has been recorded for this project yet.",
    source: "dispatcher_evaluation",
    observedAt,
  };
}

/** THE CONTENT BASIS, mirroring ticketContentHash in src/store/tickets.ts — the
 *  fallback for a row written before `tickets.body_hash` existed. A stamped
 *  body_hash is used as-is; this recomputes the identical value for one that is
 *  NULL, exactly as queue.ts's ticketBodyHash does. Pinned by test. */
function ticketContentHashLocal(t: {
  type: string;
  status: string;
  title: string;
  body: string;
  created: string | null;
  closed: string | null;
  closedCommit: string | null;
  epic: string | null;
}): string {
  const canonical = JSON.stringify([
    t.type,
    t.status,
    t.title,
    t.body,
    t.created ?? null,
    t.closed ?? null,
    t.closedCommit ?? null,
    t.epic ?? null,
  ]);
  return createHash("sha256").update(canonical).digest("hex");
}

/** A read whose TABLE or COLUMN does not exist on this store — a legitimate state
 *  (a read-only open never migrates one into existence), not a server fault. It is
 *  reported by name in `degraded` rather than silently answered as empty: an empty
 *  section and an unreadable one are different facts. Any other error propagates. */
function tolerantRead<T>(read: () => T, fallback: T, label: string, degraded: string[]): T {
  try {
    return read();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/no such table|no such column/i.test(message)) {
      const note = `${label}: ${message}`;
      // One entry per named read: two queries over the same missing table are one
      // unreadable section, not two.
      if (!degraded.includes(note)) degraded.push(note);
      return fallback;
    }
    throw err;
  }
}

/** The STORE's own clock, the same expression storeNowMs (src/store/publications.ts)
 *  evaluates. Lease expiry and heartbeat staleness are compared against it and never
 *  against this process's clock — two processes with skewed clocks must not disagree
 *  about whether a dispatcher is alive. */
function storeNowMsRead(): number {
  const row = db()
    .prepare(`SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) AS ms`)
    .get() as { ms: number };
  return row.ms;
}

type ClaimDbRow = {
  id: string;
  project_key: string;
  ticket_id: string;
  owner: string;
  generation: number;
  ticket_revision: number;
  lease_expires_at_ms: number;
  heartbeat_at_ms: number;
  launch_id: string | null;
  run_id: string | null;
  claimed_at: string;
};

const CLAIM_BOARD_COLUMNS = `id, project_key, ticket_id, owner, generation, ticket_revision,
  lease_expires_at_ms, heartbeat_at_ms, launch_id, run_id, claimed_at`;

/** THE BOARD. One project's queue as five projections over orthogonal durable
 *  fields, plus the dispatcher panel and the host-scoped capacity context.
 *
 *  `projects` is the dashboard's own registry, passed in rather than re-scanned, and
 *  used for ONE thing: naming which OTHER project holds a capacity slot. Under a
 *  host-scoped ceiling a per-project board cannot otherwise explain its own refusal. */
export function queueBoard(project: ProjectRecord | null, projects: readonly ProjectRecord[] = []): QueueBoard {
  const degraded: string[] = [];
  const nowMs = storeNowMsRead();

  const identity = project
    ? (db()
        .prepare(`SELECT project_key FROM project_identity WHERE repo_evidence_key = ?`)
        .get(project.key) as { project_key: string } | undefined)
    : undefined;
  const projectKey = identity?.project_key ?? null;

  const mode = projectKey
    ? (db().prepare(`SELECT mode FROM ticket_storage_mode WHERE project_key = ?`).get(projectKey) as
        | { mode: string }
        | undefined)
    : undefined;
  const storageMode: "db" | "markdown" | null = projectKey ? (mode?.mode === "db" ? "db" : "markdown") : null;

  // Every project's project_key ↔ repo evidence key, so a host-scope holder in
  // ANOTHER project can be named. Read once; the list is one row per registered
  // project.
  const labelByProjectKey = new Map<string, string>();
  for (const row of tolerantRead(
    () =>
      db().prepare(`SELECT project_key, repo_evidence_key FROM project_identity`).all() as Array<{
        project_key: string;
        repo_evidence_key: string;
      }>,
    [],
    "project_identity",
    degraded,
  )) {
    const record = projects.find((entry) => entry.key === row.repo_evidence_key);
    if (record) labelByProjectKey.set(row.project_key, record.label);
  }

  const policy = readDispatcherPolicy(projectKey, degraded);
  const capacity = readCapacity(projectKey, policy, labelByProjectKey, degraded);
  const lease = projectKey ? readDispatcherLease(projectKey, degraded) : null;
  const evaluation = projectKey ? readLatestEvaluation(projectKey, degraded) : null;
  const pendingWakes = projectKey
    ? tolerantRead(
        () =>
          (db()
            .prepare(`SELECT COUNT(*) AS n FROM dispatcher_wakes WHERE project_key = ? AND state = 'pending'`)
            .get(projectKey) as { n: number }).n,
        0,
        "dispatcher_wakes",
        degraded,
      )
    : 0;

  const dispatcher = dispatcherPanel(policy, lease, evaluation, pendingWakes, nowMs);

  if (!projectKey || storageMode !== "db") {
    return {
      projectKey,
      storageMode,
      queueAvailable: false,
      unavailableReason: !projectKey
        ? "this repository has no ticket truth in the host store — it has never been imported (`forge backlog migrate`)."
        : "the operator queue is a DB-store concept and this project's ticket truth is still Markdown. Cut it over with `forge backlog migrate`.",
      version: 0,
      rows: [],
      views: emptyBoardViews(),
      dispatcher,
      capacity,
      nowMs,
      degraded,
    };
  }

  const version = tolerantRead(
    () =>
      (db()
        .prepare(
          `SELECT MAX(id) AS version FROM queue_events
            WHERE project_key = ? AND event_type IN (${QUEUE_ORDER_EVENT_TYPES.map(() => "?").join(", ")})`,
        )
        .get(projectKey, ...QUEUE_ORDER_EVENT_TYPES) as { version: number | null } | undefined)?.version ?? 0,
    0,
    "queue_events",
    degraded,
  );

  const ticketRows = tolerantRead(
    () =>
      db()
        .prepare(
          `SELECT t.ticket_id, t.type, t.status, t.title, t.body, t.created, t.closed, t.closed_commit,
                  t.epic, t.priority_rank, t.revision, t.body_hash,
                  m.enqueued_at, m.enqueued_by, m.note
             FROM tickets t
             LEFT JOIN queue_membership m
               ON m.project_key = t.project_key AND m.ticket_id = t.ticket_id
            WHERE t.project_key = ?`,
        )
        .all(projectKey) as Array<{
        ticket_id: string;
        type: string;
        status: string;
        title: string;
        body: string;
        created: string | null;
        closed: string | null;
        closed_commit: string | null;
        epic: string | null;
        priority_rank: number | null;
        revision: number | null;
        body_hash: string | null;
        enqueued_at: string | null;
        enqueued_by: string | null;
        note: string | null;
      }>,
    [],
    "tickets/queue_membership",
    degraded,
  );

  // Set-wide reads rather than per-ticket ones: a board with several hundred
  // tickets is a normal size and this route is polled.
  const blockersByTicket = new Map<string, QueueBoardBlocker[]>();
  for (const row of tolerantRead(
    () =>
      db()
        .prepare(
          `SELECT ticket_id, source, kind, reason, detail, queue_projection, created_at
             FROM blocker_evidence WHERE project_key = ?`,
        )
        .all(projectKey) as Array<{
        ticket_id: string;
        source: string;
        kind: string | null;
        reason: string | null;
        detail: string | null;
        queue_projection: string | null;
        created_at: string | null;
      }>,
    [],
    "blocker_evidence",
    degraded,
  )) {
    const list = blockersByTicket.get(row.ticket_id) ?? [];
    list.push({
      source: row.source,
      kind: row.kind,
      reason: row.reason,
      detail: row.detail,
      queueProjection: row.queue_projection,
      createdAt: row.created_at,
      // The SAME wide predicate isQueueBlocked uses: status-bearing legacy
      // evidence OR an enriched row whose stored queue_projection blocks. The
      // narrow, container-visible ticket-status predicate is a different one and
      // enriched evidence never moves it.
      blocking:
        isStatusBearingEvidenceSource(row.source) || row.queue_projection === QUEUE_BLOCKING_PROJECTION,
    });
    blockersByTicket.set(row.ticket_id, list);
  }

  const readinessByTicket = new Map<
    string,
    { bodyHash: string; outcome: string; gaps: string[]; refinementProposal: string | null; revision: number | null; evaluatedAt: string }
  >();
  for (const row of tolerantRead(
    () =>
      db()
        .prepare(
          `SELECT ticket_id, body_hash, outcome, gaps_json, refinement_proposal, revision, evaluated_at
             FROM readiness_assessments WHERE project_key = ?`,
        )
        .all(projectKey) as Array<{
        ticket_id: string;
        body_hash: string;
        outcome: string;
        gaps_json: string;
        refinement_proposal: string | null;
        revision: number | null;
        evaluated_at: string;
      }>,
    [],
    "readiness_assessments",
    degraded,
  )) {
    readinessByTicket.set(row.ticket_id, {
      bodyHash: row.body_hash,
      outcome: row.outcome,
      gaps: (safeJsonParse(row.gaps_json) as string[] | undefined) ?? [],
      refinementProposal: row.refinement_proposal,
      revision: row.revision,
      evaluatedAt: row.evaluated_at,
    });
  }

  // THE EXECUTION HALF — dispatch evidence with a non-terminal task. Its own
  // query, never joined to the reservation half.
  const running = new Set(
    tolerantRead(
      () =>
        db()
          .prepare(
            `SELECT DISTINCT e.ticket_id
               FROM ticket_dispatch_evidence e
               JOIN tasks t ON t.id = e.task_id
              WHERE e.project_key = ?
                AND t.status NOT IN (${TERMINAL_TASK_STATUSES.map(() => "?").join(", ")})`,
          )
          .all(projectKey, ...TERMINAL_TASK_STATUSES) as Array<{ ticket_id: string }>,
      [],
      "ticket_dispatch_evidence",
      degraded,
    ).map((r) => r.ticket_id),
  );

  // THE RESERVATION HALF — live claims of THIS project. Its own query.
  const reservationByTicket = new Map<string, QueueBoardReservation>();
  for (const row of tolerantRead(
    () =>
      db()
        .prepare(`SELECT ${CLAIM_BOARD_COLUMNS} FROM queue_claims WHERE project_key = ? AND state = 'live'`)
        .all(projectKey) as ClaimDbRow[],
    [],
    "queue_claims",
    degraded,
  )) {
    reservationByTicket.set(row.ticket_id, {
      claimId: row.id,
      owner: row.owner,
      generation: row.generation,
      ticketRevision: row.ticket_revision,
      launchId: row.launch_id,
      runId: row.run_id,
      leaseExpiresAtMs: row.lease_expires_at_ms,
      heartbeatAtMs: row.heartbeat_at_ms,
      leaseExpired: row.lease_expires_at_ms < nowMs,
      claimedAt: row.claimed_at,
    });
  }

  // Every ticket the queue has EVER claimed, so a done one the queue actually ran
  // still has a place in the Done column.
  const everClaimed = new Set(
    tolerantRead(
      () =>
        db()
          .prepare(`SELECT DISTINCT ticket_id FROM queue_claims WHERE project_key = ?`)
          .all(projectKey) as Array<{ ticket_id: string }>,
      [],
      "queue_claims",
      degraded,
    ).map((r) => r.ticket_id),
  );

  const scanByTicket = new Map<string, { reason: string; detail: string | null }>();
  for (const entry of evaluation?.scanEvidence ?? []) {
    if (typeof entry?.ticketId === "string") {
      scanByTicket.set(entry.ticketId, { reason: String(entry.reason), detail: entry.detail ?? null });
    }
  }

  const rows: QueueBoardRow[] = [];
  for (const row of ticketRows) {
    const queued = row.enqueued_at !== null;
    const rank = row.priority_rank;
    if (row.status === "done" && !queued && rank === null && !everClaimed.has(row.ticket_id)) continue;

    const blockers = blockersByTicket.get(row.ticket_id) ?? [];
    const blocked = blockers.some((b) => b.blocking);
    const stored = readinessByTicket.get(row.ticket_id);
    const currentHash =
      row.body_hash ??
      ticketContentHashLocal({
        type: row.type,
        status: row.status,
        title: row.title,
        body: row.body,
        created: row.created,
        closed: row.closed,
        closedCommit: row.closed_commit,
        epic: row.epic,
      });
    const readiness: QueueBoardReadiness | null = stored
      ? {
          outcome: stored.outcome,
          gaps: stored.gaps,
          refinementProposal: stored.refinementProposal,
          revision: stored.revision,
          evaluatedAt: stored.evaluatedAt,
          stale: stored.bodyHash !== currentHash,
          queueable: stored.bodyHash === currentHash && QUEUEABLE_READINESS_OUTCOMES.has(stored.outcome),
        }
      : null;

    const reservation = reservationByTicket.get(row.ticket_id) ?? null;
    const inProgress = running.has(row.ticket_id);
    const executionState: QueueExecutionState = inProgress
      ? "running"
      : reservation && reservation.launchId !== null
        ? "launching"
        : "idle";
    const view = classifyQueueBoardView({ status: row.status, queued, blocked, executionState });
    const scan = scanByTicket.get(row.ticket_id) ?? null;
    const blockingReasons = blockers.filter((b) => b.blocking).map((b) => b.reason ?? b.source);

    rows.push({
      ticketId: row.ticket_id,
      title: row.title,
      type: row.type,
      status: row.status,
      rank,
      queued,
      enqueuedAt: row.enqueued_at,
      enqueuedBy: row.enqueued_by,
      note: row.note,
      blocked,
      blockers,
      inProgress,
      executionState,
      reservation,
      readiness,
      view,
      wait: deriveQueueWait({
        status: row.status,
        queued,
        rank,
        blocked,
        blockerReason: blockingReasons.length > 0 ? blockingReasons.join("; ") : null,
        executionState,
        reservation,
        readiness,
        armed: policy.armed,
        scan,
        evaluation: evaluation
          ? { reason: evaluation.reason, evaluatedAt: evaluation.evaluatedAt, detail: evaluation.detail }
          : null,
      }),
      scanReason: scan?.reason ?? null,
      scanDetail: scan?.detail ?? null,
    });
  }

  // CANONICAL ORDER, total: ranked first by rank then ticket id (the store's own
  // `ORDER BY priority_rank ASC, ticket_id ASC`), unranked after, by ticket id.
  rows.sort((a, b) => {
    if (a.rank !== null && b.rank !== null && a.rank !== b.rank) return a.rank - b.rank;
    if (a.rank !== null && b.rank === null) return -1;
    if (a.rank === null && b.rank !== null) return 1;
    return compareTicketIds(a.ticketId, b.ticketId);
  });

  const views = emptyBoardViews();
  for (const row of rows) views[row.view].push(row.ticketId);

  return {
    projectKey,
    storageMode,
    queueAvailable: true,
    unavailableReason: null,
    version,
    rows,
    views,
    dispatcher,
    capacity,
    nowMs,
    degraded,
  };
}

type BoardPolicy = {
  armed: boolean;
  configured: boolean;
  maxActiveRuns: number;
  capacityScope: "host" | "project";
  leaseTtlMs: number;
  heartbeatMs: number;
  defaultWorkflow: string;
  updatedAt: string | null;
  updatedBy: string | null;
};

/** ONE TABLE, TWO ROW SHAPES. The `host` row is the singleton carrying the ceiling
 *  and the cadences; an optional per-project row carries only default_workflow and
 *  NEVER a ceiling — two dispatchers holding different ceilings while enforcing
 *  against one shared count would make the effective ceiling whichever ran last. */
function readDispatcherPolicy(projectKey: string | null, degraded: string[]): BoardPolicy {
  const scopeKeys = projectKey === null ? ["host"] : ["host", projectKey];
  const rows = tolerantRead(
    () =>
      db()
        .prepare(
          `SELECT scope_key, armed, max_active_runs, capacity_scope, lease_ttl_ms, heartbeat_ms,
                  default_workflow, updated_at, updated_by
             FROM dispatcher_policy WHERE scope_key IN (${scopeKeys.map(() => "?").join(", ")})`,
        )
        .all(...scopeKeys) as Array<{
        scope_key: string;
        armed: number | null;
        max_active_runs: number | null;
        capacity_scope: string | null;
        lease_ttl_ms: number | null;
        heartbeat_ms: number | null;
        default_workflow: string | null;
        updated_at: string | null;
        updated_by: string | null;
      }>,
    [],
    "dispatcher_policy",
    degraded,
  );
  const host = rows.find((r) => r.scope_key === "host");
  const projectRow = projectKey ? rows.find((r) => r.scope_key === projectKey) : undefined;
  const scope = host?.capacity_scope === "project" ? "project" : DISPATCHER_POLICY_DEFAULTS.capacityScope;
  return {
    armed: host?.armed === 1,
    configured: host !== undefined,
    maxActiveRuns: host?.max_active_runs ?? DISPATCHER_POLICY_DEFAULTS.maxActiveRuns,
    capacityScope: scope,
    leaseTtlMs: host?.lease_ttl_ms ?? DISPATCHER_POLICY_DEFAULTS.leaseTtlMs,
    heartbeatMs: host?.heartbeat_ms ?? DISPATCHER_POLICY_DEFAULTS.heartbeatMs,
    defaultWorkflow:
      projectRow?.default_workflow ?? host?.default_workflow ?? DISPATCHER_POLICY_DEFAULTS.defaultWorkflow,
    updatedAt: host?.updated_at ?? null,
    updatedBy: host?.updated_by ?? null,
  };
}

type BoardLease = {
  owner: string;
  generation: number;
  leaseExpiresAtMs: number;
  heartbeatAtMs: number;
  host: string | null;
  pid: number | null;
  createdAt: string;
  updatedAt: string;
};

function readDispatcherLease(projectKey: string, degraded: string[]): BoardLease | null {
  const row = tolerantRead(
    () =>
      db()
        .prepare(
          `SELECT owner, generation, lease_expires_at_ms, heartbeat_at_ms, host, pid, created_at, updated_at
             FROM dispatcher_leases WHERE project_key = ?`,
        )
        .get(projectKey) as
        | {
            owner: string;
            generation: number;
            lease_expires_at_ms: number;
            heartbeat_at_ms: number;
            host: string | null;
            pid: number | null;
            created_at: string;
            updated_at: string;
          }
        | undefined,
    undefined,
    "dispatcher_leases",
    degraded,
  );
  if (!row) return null;
  return {
    owner: row.owner,
    generation: row.generation,
    leaseExpiresAtMs: row.lease_expires_at_ms,
    heartbeatAtMs: row.heartbeat_at_ms,
    host: row.host,
    pid: row.pid,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

type BoardEvaluation = {
  reason: string;
  detail: string | null;
  claimedTicketId: string | null;
  capacityScope: string | null;
  capacityLimit: number | null;
  capacityUsed: number | null;
  capacityHolders: Array<{ claimId: string; projectKey: string; ticketId: string; owner: string; launchId: string | null; runId: string | null }> | null;
  scanEvidence: Array<{ ticketId: string; rank: number | null; reason: string; detail: string | null }> | null;
  wakeKind: string | null;
  nextWatchdogAtMs: number | null;
  evaluatedAtMs: number;
  evaluatedAt: string;
};

const EVALUATION_BOARD_COLUMNS = `reason, detail, claimed_ticket_id, capacity_scope, capacity_limit,
  capacity_used, capacity_holders, scan_evidence, wake_kind, next_watchdog_at_ms, evaluated_at_ms, evaluated_at`;

type EvaluationBoardDbRow = {
  reason: string;
  detail: string | null;
  claimed_ticket_id: string | null;
  capacity_scope: string | null;
  capacity_limit: number | null;
  capacity_used: number | null;
  capacity_holders: string | null;
  scan_evidence: string | null;
  wake_kind: string | null;
  next_watchdog_at_ms: number | null;
  evaluated_at_ms: number;
  evaluated_at: string;
};

function toBoardEvaluation(row: EvaluationBoardDbRow): BoardEvaluation {
  return {
    reason: row.reason,
    detail: row.detail,
    claimedTicketId: row.claimed_ticket_id,
    capacityScope: row.capacity_scope,
    capacityLimit: row.capacity_limit,
    capacityUsed: row.capacity_used,
    capacityHolders: row.capacity_holders === null ? null : (safeJsonParse(row.capacity_holders) as BoardEvaluation["capacityHolders"]) ?? null,
    scanEvidence: row.scan_evidence === null ? null : (safeJsonParse(row.scan_evidence) as BoardEvaluation["scanEvidence"]) ?? null,
    wakeKind: row.wake_kind,
    nextWatchdogAtMs: row.next_watchdog_at_ms,
    evaluatedAtMs: row.evaluated_at_ms,
    evaluatedAt: row.evaluated_at,
  };
}

/** THE DURABLE ANSWER TO "WHY DID NOTHING START" — the latest evaluation pass,
 *  including the passes that granted nothing. That is the whole point of the row:
 *  an idle queue that leaves no record of why is the operator blindness this
 *  surface exists to close. */
function readLatestEvaluation(projectKey: string, degraded: string[]): BoardEvaluation | null {
  const row = tolerantRead(
    () =>
      db()
        .prepare(
          `SELECT ${EVALUATION_BOARD_COLUMNS} FROM dispatcher_evaluations
            WHERE project_key = ? ORDER BY id DESC LIMIT 1`,
        )
        .get(projectKey) as EvaluationBoardDbRow | undefined,
    undefined,
    "dispatcher_evaluations",
    degraded,
  );
  return row ? toBoardEvaluation(row) : null;
}

/** The latest pass the CEILING actually refused, whatever has happened since. */
function readLatestCapacityRefusal(projectKey: string, degraded: string[]): BoardEvaluation | null {
  const row = tolerantRead(
    () =>
      db()
        .prepare(
          `SELECT ${EVALUATION_BOARD_COLUMNS} FROM dispatcher_evaluations
            WHERE project_key = ? AND reason = 'no_capacity' ORDER BY id DESC LIMIT 1`,
        )
        .get(projectKey) as EvaluationBoardDbRow | undefined,
    undefined,
    "dispatcher_evaluations",
    degraded,
  );
  return row ? toBoardEvaluation(row) : null;
}

/** THE CAPACITY CONTEXT. The ceiling is HOST-scoped by default, so this reads the
 *  live claims of EVERY project and names the holder of each slot — without that,
 *  a refusal caused by another project's work is unreadable from this board
 *  ("my queue is stalled and nothing of mine is running"). */
function readCapacity(
  projectKey: string | null,
  policy: BoardPolicy,
  labelByProjectKey: Map<string, string>,
  degraded: string[],
): QueueCapacity {
  const scoped =
    policy.capacityScope === "host"
      ? tolerantRead(
          () => db().prepare(`SELECT ${CLAIM_BOARD_COLUMNS} FROM queue_claims WHERE state = 'live'`).all() as ClaimDbRow[],
          [],
          "queue_claims",
          degraded,
        )
      : projectKey
        ? tolerantRead(
            () =>
              db()
                .prepare(`SELECT ${CLAIM_BOARD_COLUMNS} FROM queue_claims WHERE project_key = ? AND state = 'live'`)
                .all(projectKey) as ClaimDbRow[],
            [],
            "queue_claims",
            degraded,
          )
        : [];

  const holders: QueueCapacityHolder[] = scoped.map((row) => ({
    claimId: row.id,
    projectKey: row.project_key,
    projectLabel: labelByProjectKey.get(row.project_key) ?? null,
    ticketId: row.ticket_id,
    owner: row.owner,
    launchId: row.launch_id,
    runId: row.run_id,
    thisProject: row.project_key === projectKey,
  }));

  // REPORTED, NEVER COUNTED. A separate query over the task record, deliberately
  // not joined to the claim ledger and deliberately not subtracted from the
  // ceiling: the only count that bounds admission is the one taken inside
  // claimNextEligible's write transaction, and it counts claims.
  const activeTasks = tolerantRead(
    () =>
      (db()
        .prepare(
          `SELECT COUNT(*) AS n FROM tasks WHERE status NOT IN (${TERMINAL_TASK_STATUSES.map(() => "?").join(", ")})`,
        )
        .get(...TERMINAL_TASK_STATUSES) as { n: number }).n,
    0,
    "tasks",
    degraded,
  );

  const refusal = projectKey ? readLatestCapacityRefusal(projectKey, degraded) : null;

  return {
    scope: policy.capacityScope,
    limit: policy.maxActiveRuns,
    queueOwnedActive: holders.length,
    holders,
    otherProjectHolders: holders.filter((h) => !h.thisProject).length,
    notCounted: {
      activeTasks,
      policy:
        "The ceiling is a hard bound on QUEUE-OWNED concurrent runs only, counted as live queue_claims " +
        "rows inside claimNextEligible's write transaction. Operator-initiated runs (`forge new`, " +
        "`forge invoke`), campaign items and review loops carry no claim row, are structurally invisible " +
        "to that count, and are reported here beside the ceiling rather than subtracted from it — a " +
        "dispatcher-side subtraction would read as a guarantee and be a guess.",
    },
    lastRefusal: refusal
      ? {
          evaluatedAt: refusal.evaluatedAt,
          scope: refusal.capacityScope,
          limit: refusal.capacityLimit,
          used: refusal.capacityUsed,
          holders: (refusal.capacityHolders ?? []).map((h) => ({
            claimId: h.claimId,
            projectKey: h.projectKey,
            projectLabel: labelByProjectKey.get(h.projectKey) ?? null,
            ticketId: h.ticketId,
            owner: h.owner,
            launchId: h.launchId ?? null,
            runId: h.runId ?? null,
            thisProject: h.projectKey === projectKey,
          })),
        }
      : null,
  };
}

/** THE PANEL, and the six distinguishable no-run answers.
 *
 *  A DEAD OR STALE DISPATCHER OUTRANKS THE LAST EVALUATION. An expired lease means
 *  nobody is looking at this queue at all, and the most recent evaluation — however
 *  reasonable it reads — describes a pass that happened before the owner stopped.
 *  Reporting "no eligible work" in that state is exactly how a correct-looking board
 *  hides a dead controller. */
function dispatcherPanel(
  policy: BoardPolicy,
  lease: BoardLease | null,
  evaluation: BoardEvaluation | null,
  pendingWakes: number,
  nowMs: number,
): DispatcherPanel {
  const leaseLive = lease !== null && lease.leaseExpiresAtMs >= nowMs;
  const leaseExpired = lease !== null && lease.leaseExpiresAtMs < nowMs;
  const msSinceHeartbeatMs = lease ? nowMs - lease.heartbeatAtMs : null;

  let state: DispatcherPanelState;
  let stateDetail: string;
  if (!policy.armed) {
    state = "disarmed";
    stateDetail =
      "autonomous dispatch is disarmed. Existing claims keep running and keep being heartbeated — " +
      "disarming is an admission test consulted before claiming, never a reaper.";
  } else if (lease === null) {
    state = "no_dispatcher";
    stateDetail =
      "dispatch is armed but no dispatcher holds a lease on this project — nothing is looking at this " +
      "queue. Start one with `forge queue dispatcher run`.";
  } else if (leaseExpired) {
    state = "stale_dispatcher";
    stateDetail =
      `the dispatcher lease held by ${lease.owner} expired ${formatMs(nowMs - lease.leaseExpiresAtMs)} ago ` +
      `(last heartbeat ${formatMs(msSinceHeartbeatMs ?? 0)} ago). A successor may take it over; until one ` +
      `does, nothing is evaluating this queue.`;
  } else if (!evaluation) {
    state = "not_evaluated";
    stateDetail = `${lease.owner} holds the lease but has recorded no evaluation yet.`;
  } else {
    switch (evaluation.reason) {
      case "granted":
        state = "dispatching";
        stateDetail = `last pass claimed ${evaluation.claimedTicketId ?? "a ticket"} at ${evaluation.evaluatedAt}.`;
        break;
      case "no_capacity":
        state = "no_capacity";
        stateDetail =
          `the ceiling was full at ${evaluation.evaluatedAt} — ${evaluation.capacityUsed ?? "?"}/` +
          `${evaluation.capacityLimit ?? policy.maxActiveRuns} live claims in ${evaluation.capacityScope ?? policy.capacityScope} scope` +
          (evaluation.capacityHolders && evaluation.capacityHolders.length > 0
            ? `, held by ${evaluation.capacityHolders.map((h) => `${h.ticketId} (${h.projectKey})`).join(", ")}.`
            : ".");
        break;
      case "incompatible_only":
        state = "incompatible_only";
        stateDetail =
          `every otherwise-eligible candidate was temporarily incompatible with the active set at ` +
          `${evaluation.evaluatedAt}. This is a scheduling wait and self-clears — the items stay queued.`;
        break;
      case "lost":
        state = "lost";
        stateDetail =
          `a claim attempt lost its re-validation at ${evaluation.evaluatedAt} — a concurrent dispatcher ` +
          `won, or a durable fact moved under the scan. Nothing was written.`;
        break;
      case "disabled":
        // The policy row says armed and the last recorded pass says disabled: the
        // pass predates the arm. Reported as the honest ordering, not as a state.
        state = "not_evaluated";
        stateDetail = `the last recorded pass (${evaluation.evaluatedAt}) ran while dispatch was disarmed; no pass has been recorded since it was armed.`;
        break;
      default:
        state = "no_eligible_work";
        stateDetail =
          `the last pass at ${evaluation.evaluatedAt} selected nothing: no queue member was ranked, ` +
          `active, unblocked, ready and unclaimed.`;
        break;
    }
  }

  return {
    armed: policy.armed,
    configured: policy.configured,
    maxActiveRuns: policy.maxActiveRuns,
    capacityScope: policy.capacityScope,
    leaseTtlMs: policy.leaseTtlMs,
    heartbeatMs: policy.heartbeatMs,
    defaultWorkflow: policy.defaultWorkflow,
    updatedAt: policy.updatedAt,
    updatedBy: policy.updatedBy,
    lease,
    leaseLive,
    leaseExpired,
    msSinceHeartbeatMs,
    lastEvaluation: evaluation
      ? {
          reason: evaluation.reason,
          detail: evaluation.detail,
          evaluatedAt: evaluation.evaluatedAt,
          evaluatedAtMs: evaluation.evaluatedAtMs,
          wakeKind: evaluation.wakeKind,
          claimedTicketId: evaluation.claimedTicketId,
          capacityScope: evaluation.capacityScope,
          capacityLimit: evaluation.capacityLimit,
          capacityUsed: evaluation.capacityUsed,
          scannedCount: evaluation.scanEvidence?.length ?? null,
        }
      : null,
    nextWatchdogAtMs: evaluation?.nextWatchdogAtMs ?? null,
    pendingWakes,
    state,
    stateDetail,
    controlSurface: "cli-only",
  };
}

function formatMs(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 90) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes}m`;
  return `${Math.round(minutes / 60)}h`;
}
