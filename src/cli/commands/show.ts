import type { Command } from "commander";
import { statSync, readFileSync, openSync, readSync, closeSync } from "node:fs";
import { join } from "node:path";
import { getTask, tasksForRun } from "../../store/tasks.js";
import { getRun } from "../../store/runs.js";
import { verdictsForTask } from "../../store/verdicts.js";
import { getDb } from "../../store/db.js";
import { ensureForgeDirs, taskDir } from "../../util/paths.js";
import { eventsForTask, eventsForRun } from "../../store/events.js";
import type { Event } from "../../store/events.js";
import type { Task, Run, VerdictRow } from "../../types/index.js";
import { resolveIdleTimeoutMs } from "../../v2/idle-watchdog.js";
import { failureKindFromEvents as getFailureKindFromEvents, getOrphanEvidenceFromEvents, getFanoutWaveEvidenceFromEvents, type OrphanEvidence, type FanoutWaveEvidence } from "../../v2/failure-kind.js";
import { reconcileRun, type ContainerAlive } from "../../v2/reconcile.js";
import { getManifestRuntime } from "../../v2/task-manifest.js";
import { findReconcileCandidates, type ReconcileReason, type LivenessProbe, type ResultProbe } from "../../ops/reconcile-candidate.js";
import { docsImpactSuggestion, loadOperatorSurfaces } from "../../v2/contract.js";
import { summarizeFindings, gatherRunReviews } from "../../v2/review-quality.js";

export type ShowResult =
  | { kind: "task"; task: Task; verdicts: VerdictRow[]; events: Event[] }
  | { kind: "run"; run: Run; events: Event[]; tasks: Task[] }
  | { kind: "not-found"; id: string };

export function performShow(id: string): ShowResult {
  const task = getTask(id);
  if (task) {
    return { kind: "task", task, verdicts: verdictsForTask(task.id), events: eventsForTask(id) };
  }
  const run = getRun(id);
  if (run) {
    return { kind: "run", run, events: eventsForRun(id), tasks: tasksForRun(id) };
  }
  return { kind: "not-found", id };
}

// #298: the read-vs-reconcile decision for `forge show`, split out from rendering
// so it's testable with an injected liveness probe. Plain show is READ-ONLY: it
// never calls reconcileRun and only surfaces a reconcile-candidate reason (#290)
// for a running target. `--reconcile` is the explicit mutating path (the lifecycle
// commands next/status/gate are the other intentional reconcilers). Deps are
// injectable for tests; production uses the real docker probe.
export type RunReconcileCandidate = { taskId: string; reason: ReconcileReason };

export function showReconcileStep(
  id: string,
  opts: { reconcile?: boolean },
  deps: { containerAlive?: ContainerAlive; probe?: LivenessProbe; resultPresent?: ResultProbe } = {},
): { reconciled: boolean; candidateReason: ReconcileReason | null; runCandidates: RunReconcileCandidate[] } {
  const targetTask = getTask(id);
  if (opts.reconcile) {
    reconcileRun(targetTask ? targetTask.runId : id, deps.containerAlive);
    return { reconciled: true, candidateReason: null, runCandidates: [] };
  }
  const db = getDb({ readOnly: true });
  if (targetTask) {
    // Task target: surface the candidate reason for a running task.
    const reason = targetTask.status === "running"
      ? (findReconcileCandidates(db, { taskId: targetTask.id }, deps.probe, deps.resultPresent)
          .find((c) => c.classification === "reconcile_candidate")?.reason ?? null)
      : null;
    return { reconciled: false, candidateReason: reason, runCandidates: [] };
  }
  // Run target (#298 run-path): surface candidates across the run's running
  // tasks — so `forge show <runId>` doesn't list a stale task as ordinary running.
  const runCandidates = findReconcileCandidates(db, { runId: id }, deps.probe, deps.resultPresent)
    .filter((c) => c.classification === "reconcile_candidate")
    .map((c) => ({ taskId: c.taskId, reason: c.reason }));
  return { reconciled: false, candidateReason: null, runCandidates };
}

// ─── Pure helpers, exported for testing ─────────────────────────────────────

// The failure-kind scan lives in the neutral failure-kind module (single source
// of truth, also consumed by the notification layer). Imported + re-exported
// here under its long-standing name so forge show / watch importers and tests
// stay stable.
export { getFailureKindFromEvents, getOrphanEvidenceFromEvents, getFanoutWaveEvidenceFromEvents };

export function classifyResultFile(filePath: string): "missing" | "empty" | "malformed" | "valid" {
  let content: string;
  try {
    content = readFileSync(filePath, "utf8");
  } catch {
    return "missing";
  }
  if (content.trim().length === 0) return "empty";
  try {
    JSON.parse(content);
    return "valid";
  } catch {
    return "malformed";
  }
}

function formatDurationMs(ms: number): string {
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  return remMins > 0 ? `${hours}h ${remMins}m` : `${hours}h`;
}

export function computeElapsed(startedAt?: string, completedAt?: string, now = Date.now()): string {
  if (!startedAt) return "—";
  const start = new Date(startedAt).getTime();
  const end = completedAt ? new Date(completedAt).getTime() : now;
  return formatDurationMs(end - start);
}

// Live idle state for a RUNNING task: how long since its last activity, and how
// much of its idle-timeout budget remains before the watchdog kills it. The
// watchdog (idle-watchdog.ts) starts its timer at SPAWN and bumps on stdout —
// so idle time runs from the last stdout write, or from spawn when no stdout has
// arrived yet. A hung agent that never emits stdout must still count down (and
// expire), not sit at a full budget forever. Pure — the caller supplies the
// last-output mtime, a spawn baseline (task.startedAt), the effective timeout,
// and now. WALK-1.
export type IdleCountdown = {
  hasOutput: boolean;     // whether the container has written any stdout yet
  idleMs: number;         // ms since last activity (output, else spawn)
  remainingMs: number;    // ms left before idle kill (clamped at 0)
  expired: boolean;       // idle budget exhausted — a kill is imminent/overdue
  measured: boolean;      // false only when neither output nor a spawn baseline exists
};

export function computeIdleCountdown(
  lastOutputMtime: number | undefined,
  idleTimeoutMs: number,
  now = Date.now(),
  startedAtMs?: number,
): IdleCountdown {
  // Mirror the watchdog: measure idle from the last stdout write, falling back
  // to spawn time when nothing has been written. Only when we have neither is
  // the countdown unmeasurable.
  const baseline = lastOutputMtime ?? startedAtMs;
  const hasOutput = lastOutputMtime !== undefined;
  if (baseline === undefined) {
    return { hasOutput, idleMs: 0, remainingMs: idleTimeoutMs, expired: false, measured: false };
  }
  const idleMs = Math.max(0, now - baseline);
  const remainingMs = Math.max(0, idleTimeoutMs - idleMs);
  return { hasOutput, idleMs, remainingMs, expired: idleMs >= idleTimeoutMs, measured: true };
}

export function formatIdleCountdown(c: IdleCountdown): string {
  const budget = formatDurationMs(c.remainingMs + c.idleMs);
  if (!c.measured) return `idle —  /  timeout ${budget}  (awaiting start)`;
  const note = c.hasOutput ? "" : ", no output yet";
  const tail = c.expired ? "(idle budget exhausted)" : `(${formatDurationMs(c.remainingMs)} left)`;
  return `idle ${formatDurationMs(c.idleMs)}${note}  /  timeout ${budget}  ${tail}`;
}

// Disk-glue convenience: the live idle countdown for a task, reading its stdout
// mtime and effective timeout from disk. Returns undefined for non-running tasks
// (countdown is meaningless once terminal). Shared by forge status / watch so
// they don't each re-derive the manifest + mtime reads. WALK-1.
export function liveIdleCountdownForTask(
  task: Pick<Task, "runId" | "id" | "status" | "startedAt">,
  now = Date.now(),
): IdleCountdown | undefined {
  if (task.status !== "running") return undefined;
  const tDir = taskDir(task.runId, task.id);
  const stdoutMtime = getLastOutputMtime(join(tDir, "container.stdout.log"));
  const idleTimeoutMs = getManifestIdleTimeoutMs(tDir) ?? resolveIdleTimeoutMs();
  const startedAtMs = task.startedAt ? new Date(task.startedAt).getTime() : undefined;
  return computeIdleCountdown(stdoutMtime, idleTimeoutMs, now, startedAtMs);
}

export function formatTimeAgo(mtimeMs: number, now = Date.now()): string {
  const diffMs = now - mtimeMs;
  const secs = Math.floor(diffMs / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  return remMins > 0 ? `${hours}h ${remMins}m ago` : `${hours}h ago`;
}

export function getLastOutputMtime(logPath: string): number | undefined {
  try {
    return statSync(logPath).mtimeMs;
  } catch {
    return undefined;
  }
}

// Bound the tail read so `forge show` never slurps a whole multi-MB stream-json
// container log into memory just to display the last few lines.
const TAIL_MAX_BYTES = 64 * 1024;

export function tailLines(filePath: string, n: number): string[] {
  let fd: number | undefined;
  try {
    const { size } = statSync(filePath);
    const readBytes = Math.min(size, TAIL_MAX_BYTES);
    const buf = Buffer.alloc(readBytes);
    fd = openSync(filePath, "r");
    readSync(fd, buf, 0, readBytes, size - readBytes);
    let lines = buf.toString("utf8").split("\n").filter((l) => l.length > 0);
    // If we didn't start at byte 0 we likely sliced mid-line; drop that leading
    // fragment so we never surface a truncated record.
    if (size > readBytes && lines.length > 0) lines = lines.slice(1);
    return lines.slice(-n);
  } catch {
    return [];
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // best-effort close
      }
    }
  }
}

// #200: an agent container log is JSONL where each line is a large JSON event —
// tailing it raw dumps unreadable blobs in `forge show`. Both runtimes forge runs
// emit such logs (claude-stream-json and codex-jsonl), and the humanizer is
// applied to every runtime's tail, so it covers both. When the tail looks like an
// agent log (a majority of lines are JSON objects with a `type` field), extract
// the human-readable text (see textFromAgentLogEvent) and show THAT. Falls back to
// the raw tail (verbatim) for plain logs, malformed JSONL, or an agent log that
// carries no extractable text. Pure + unit-tested.
const TAIL_SCAN_LINES = 60;   // window the extractor scans (still bounded by TAIL_MAX_BYTES)
const TAIL_RENDER_LINES = 5;  // lines actually shown — preserves the pre-#200 raw cap
const TAIL_MAX_WIDTH = 200;   // per-line width cap for EXTRACTED text (raw fallback is verbatim)

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// Readable text from one agent-log JSONL event; [] for events with no human text
// (system / tool_use / in-progress items / etc.). Covers BOTH agent log formats
// forge runs — the humanizer is applied to every runtime's log, so it must.
//   claude-stream-json: assistant message.content[].text, the final result
//     string, and text deltas (which forge wraps under stream_event.event).
//   codex-jsonl: {type:"item.completed", item:{...}} where item.type is
//     "agent_message" (item.text — the narration) or "command_execution"
//     (item.aggregated_output — the command's output). Gated on item.completed:
//     item.started carries empty text/output.
function textFromAgentLogEvent(ev: Record<string, unknown>): string[] {
  const out: string[] = [];
  const type = ev["type"];
  if (type === "assistant" && isPlainObject(ev["message"])) {
    const content = (ev["message"]["content"]);
    if (Array.isArray(content)) {
      for (const block of content) {
        if (isPlainObject(block) && block["type"] === "text" && typeof block["text"] === "string") {
          out.push(block["text"]);
        }
      }
    }
  } else if (type === "result" && typeof ev["result"] === "string") {
    out.push(ev["result"]);
  } else if (type === "content_block_delta" && isPlainObject(ev["delta"])) {
    const d = ev["delta"];
    if (d["type"] === "text_delta" && typeof d["text"] === "string") out.push(d["text"]);
  } else if (type === "stream_event" && isPlainObject(ev["event"])) {
    out.push(...textFromAgentLogEvent(ev["event"]));
  } else if (type === "item.completed" && isPlainObject(ev["item"])) {
    const item = ev["item"];
    if (item["type"] === "agent_message" && typeof item["text"] === "string") {
      out.push(item["text"]);
    } else if (
      item["type"] === "command_execution" &&
      typeof item["aggregated_output"] === "string" &&
      item["aggregated_output"].trim().length > 0
    ) {
      out.push(item["aggregated_output"]);
    }
  }
  return out;
}

export function humanizeLogTail(
  rawLines: string[],
  maxLines = TAIL_RENDER_LINES,
  maxWidth = TAIL_MAX_WIDTH,
): string[] {
  if (rawLines.length === 0) return [];
  // Detect stream-json: parse each line; it's stream-json if a majority are JSON
  // objects carrying a string `type`. Non-JSON lines keep their slot (as {}) so a
  // mixed/malformed log fails the majority test and falls back to raw.
  const events: Record<string, unknown>[] = [];
  let typed = 0;
  for (const line of rawLines) {
    try {
      const o: unknown = JSON.parse(line);
      if (isPlainObject(o)) {
        events.push(o);
        if (typeof o["type"] === "string") typed++;
      } else {
        events.push({});
      }
    } catch {
      events.push({});
    }
  }
  const looksStreamJson = typed >= Math.ceil(rawLines.length / 2);
  if (!looksStreamJson) return rawLines.slice(-maxLines); // raw fallback, verbatim

  const fragments: string[] = [];
  for (const ev of events) {
    for (const text of textFromAgentLogEvent(ev)) {
      for (const piece of text.split("\n")) {
        const s = piece.trim();
        if (s.length === 0) continue;
        fragments.push(s.length > maxWidth ? `${s.slice(0, maxWidth - 1)}…` : s);
      }
    }
  }
  // stream-json but nothing readable (e.g. only tool_use) → raw rather than blank.
  if (fragments.length === 0) return rawLines.slice(-maxLines);
  return fragments.slice(-maxLines);
}

// The idle timeout the task actually ran under, recorded in its manifest at
// dispatch. Falls back to undefined for pre-#202 manifests (or none), so the
// caller can substitute the current default — but a recorded value is exact
// even if the runtime YAML / env changed since the task ran.
export function getManifestIdleTimeoutMs(taskDirPath: string): number | undefined {
  try {
    const raw = readFileSync(join(taskDirPath, "manifest.json"), "utf8");
    const manifest = JSON.parse(raw) as { container?: { idleTimeoutMs?: unknown } };
    const v = manifest.container?.idleTimeoutMs;
    return typeof v === "number" ? v : undefined;
  } catch {
    return undefined;
  }
}

// Docs-drift Walk (#241): the files an implementer reported touching, for
// operator-surface inference. Tolerant of a missing/malformed result.
export function getResultFilesModified(taskDirPath: string): string[] {
  try {
    const raw = readFileSync(join(taskDirPath, "result.json"), "utf8");
    const result = JSON.parse(raw) as { files_modified?: unknown };
    return Array.isArray(result.files_modified)
      ? result.files_modified.filter((f): f is string => typeof f === "string")
      : [];
  } catch {
    return [];
  }
}

export function listPresentArtifacts(taskDirPath: string): string[] {
  try {
    const raw = readFileSync(join(taskDirPath, "manifest.json"), "utf8");
    const manifest = JSON.parse(raw) as { files?: Record<string, string> };
    if (manifest.files && typeof manifest.files === "object") {
      return Object.values(manifest.files).filter((f) => {
        try { statSync(join(taskDirPath, f)); return true; } catch { return false; }
      });
    }
  } catch {
    // no manifest — fall through to direct read
  }
  const known = [
    "CLAUDE.md",
    "package.md",
    "result.json",
    "container.stdout.log",
    "container.stderr.log",
    "progress.jsonl",
  ];
  return known.filter((f) => {
    try {
      statSync(join(taskDirPath, f));
      return true;
    } catch {
      return false;
    }
  });
}

export function deriveNextCommandForTask(
  status: string,
  failureKind: string | undefined,
  taskId: string,
): string {
  if (status === "failed") {
    if (
      failureKind === "idle_timeout" ||
      failureKind === "container_crash" ||
      failureKind === "result_missing" ||
      failureKind === "result_malformed" ||
      failureKind === "model_error" ||
      failureKind === "tool_error" ||
      failureKind === "unknown"
    ) {
      return `forge retry ${taskId}`;
    }
    if (failureKind === "red_blocked") {
      return `forge show <redTaskId>  # review findings, then forge gate ${taskId} --advance | --reject`;
    }
    // FG-455: a dirty worktree may hold real, unreviewed work — a blind retry
    // would re-dispatch over it. Point at inspection first; retry-policy.ts
    // already refuses `forge retry` on this kind without --force.
    if (failureKind === "orphaned_work_may_persist") {
      return `forge show ${taskId} --json  # inspect the worktree diff, then \`forge retry ${taskId} --force\` once verified`;
    }
    // FG-455 p2/p3 review finding 2: this is the fanout wave's PARENT — a blind
    // `forge retry` here mints a second, uncoordinated pending primary (retry-
    // policy.ts already refuses it without --force). `forge recover --re-drive`
    // is the coherent path; point at it directly, same as the child-strand guard.
    if (failureKind === "fanout_wave_orphaned") {
      return `forge show ${taskId} --json  # inspect which children completed, then \`forge recover ${taskId} --re-drive\``;
    }
    // FG-479: an unfinalized pipeline step — retry-policy.ts refuses a bare
    // `forge retry` (the preserved result/worktree would be re-dispatched over),
    // and recover --continue refuses it too. Inspect-then-force is the only path.
    if (failureKind === "orphaned_needs_finalize") {
      return `forge show ${taskId} --json  # inspect the preserved result and diff, then \`forge retry ${taskId} --force\` to re-run the step through the real finalize path`;
    }
    // FG-455 p4: a positively-identified OOM/SIGKILL death — distinct from the
    // generic orphaned kinds above, surfaced so the operator knows a bigger
    // memory allowance (not just a re-dispatch) may be needed. Same posture as
    // orphaned_work_may_persist above: retry-policy.ts refuses a bare `forge
    // retry` for this kind, so point at inspect-then-force instead.
    if (failureKind === "oom_killed") {
      return `forge show ${taskId} --json  # inspect the worktree diff, then \`forge retry ${taskId} --force\` once verified — container killed (exit 137, possibly OOM or external kill); if OOM, consider more memory or a smaller task`;
    }
    // FG-424: retry-policy.ts marks this non-retryable — a signal-killed gate
    // run leaves run.projectDir's toolchain/cache state untrustworthy to blindly
    // re-run against. Same inspect-then-force posture as oom_killed above.
    if (failureKind === "integration_gate_crashed") {
      return `forge show ${taskId} --json  # inspect run.projectDir for a broken or half-updated toolchain/cache, resolve it, then \`forge retry ${taskId} --force\``;
    }
    // FG-424: retryable:true in retry-policy.ts (a timeout is transient), but
    // made explicit here rather than relying on the default fallthrough — same
    // FG-461 consistency posture as the container_crash/idle_timeout guidance.
    if (failureKind === "integration_gate_timeout") {
      return `forge retry ${taskId}`;
    }
    return `forge retry ${taskId}`;
  }
  if (status === "awaiting_gate") return `forge gate ${taskId} --advance | --reject`;
  if (status === "blocked_by_red")
    return `forge show <redTaskId>  # review findings, then forge gate ${taskId} --advance | --reject`;
  return "—";
}

/** FG-455: the operator-facing recovery message for an orphaned_work_may_persist
 *  or (FG-455 p4) oom_killed task — task id, task dir, worktree path, changed
 *  files, and what to do next. Shared rendering for `forge show`, `forge
 *  status`, and `forge ops check`. `kind` defaults to orphaned_work_may_persist
 *  so existing callers keep their prior wording unchanged; pass "oom_killed"
 *  to lead with the OOM/kill cause instead of the generic dirty-worktree framing —
 *  branch on the failure KIND (not evidence.oomKilled/exitCode alone), since the
 *  valid-result/orphaned branches also carry those fields on baseEvidence and a
 *  plain orphaned task that happened to exit 137 must not read as an OOM.
 *  `isInvokeRun` defaults to true so existing callers (and tests) keep their
 *  prior "continue from it or retry with --force" wording byte-identical —
 *  pass false (FG-481) for a pipeline-run task, whose --continue recover.ts
 *  now refuses unconditionally, to route the guidance at retry --force instead. */
export function orphanRecoveryMessage(
  runId: string,
  taskId: string,
  evidence: OrphanEvidence,
  // FG-461: container_crash / idle_timeout attached-exit failures now carry the
  // same evidence and get their own headline; anything else (incl. the reconcile
  // orphaned_work_may_persist default) uses the generic "work may have persisted".
  kind: string = "orphaned_work_may_persist",
  isInvokeRun: boolean = true,
): string {
  const dir = taskDir(runId, taskId);
  const files = evidence.changedFiles.length > 0
    ? evidence.changedFiles.join(", ")
    : "(none listed)";
  // FG-455 finding 2: a shared-projectDir diff is NOT task-exclusive — disclose
  // that up front so an operator doesn't mistake it for confirmed persisted work.
  // Evidence recorded before `source` existed omits it; say nothing rather than guess.
  const sourceLine = evidence.source === "project_dir_shared"
    ? "    source:        SHARED project directory (no dedicated worktree for this task) — may include unrelated uncommitted changes; evidence to inspect, not proof of task work.\n"
    : evidence.source === "worktree"
      ? "    source:        dedicated worktree (task-exclusive)\n"
      : "";
  // FG-455 p4 review: oom_killed evidence is recorded for both dirty AND clean
  // worktrees — unlike orphaned_work_may_persist, which is only ever emitted
  // dirty. The headline must not claim changed files were found when there
  // are none (it would contradict the "(none listed)" changed-files line below).
  const foundChangedFiles = evidence.changedFiles.length > 0;
  // Common trailing clause for the specific-cause headlines (oom / crash / idle).
  const changedClause = foundChangedFiles
    ? " — no recoverable result, but changed files were found."
    : " — no recoverable result and no changed files on the worktree.";
  let headline: string;
  if (kind === "oom_killed") {
    const lead = evidence.oomKilled === true
      ? "container killed (OOM)"
      : "container killed (exit 137 — possibly OOM or an external kill)";
    headline = lead + changedClause;
  } else if (kind === "container_crash") {
    // FG-461: an attached-exit non-zero crash with no result.
    const lead = evidence.exitCode !== undefined
      ? `container crashed (exit ${evidence.exitCode})`
      : "container crashed";
    headline = lead + changedClause;
  } else if (kind === "idle_timeout") {
    // FG-461: the idle watchdog SIGKILLed a hung agent — partial edits may remain.
    headline = "agent idle-timed-out (killed after no output within the idle window)" + changedClause;
  } else if (kind === "orphaned_needs_finalize") {
    // FG-479: the agent finished (usable result preserved), but the pipeline's
    // host-side finalize never ran — the step must not be trusted complete.
    headline =
      "step finished but was never finalized — container gone with a usable result; the pipeline's host-side finalize (worktree merge → integration gate → reds) did not run, so the step cannot be trusted complete.";
  } else {
    headline = foundChangedFiles
      ? "work may have persisted — container gone, no recoverable result, but changed files were found."
      : "work may have persisted — container gone, no recoverable result and no changed files on the worktree.";
  }
  // FG-461 fix: container_crash / idle_timeout are retryable:true (retry-policy.ts)
  // and excluded from recover.ts's CONTINUABLE_KINDS, so "continue from it or
  // retry with --force" is wrong for them — --continue would be refused and
  // --force isn't required. Match recover.ts's own recommendationFor logic.
  const guidance =
    kind === "container_crash" || kind === "idle_timeout"
      ? `inspect the diff at ${evidence.worktreePathChecked ?? "the task dir"}, verify it, then \`forge retry ${taskId}\` (retryable without --force)`
      : kind === "orphaned_needs_finalize"
        // FG-479: recover --continue refuses this kind (adopting the result as
        // complete would skip merge/integration gate/reds) — retry --force is
        // the only path that re-runs the step through the real finalize.
        ? `inspect the preserved result and the diff at ${evidence.worktreePathChecked ?? "the task dir"}, then re-dispatch through the real finalize path with \`forge retry ${taskId} --force\``
        // FG-481: this branch also covers a plain "orphaned"/"orphaned_work_may_persist"
        // task, and oom_killed (whose guidance falls through here too) — all
        // CONTINUABLE_KINDS. On a pipeline run, recover.ts's --continue now refuses
        // unconditionally (same rationale as orphaned_needs_finalize above), so the
        // guidance must not suggest --continue; mirror that branch's wording instead.
        : isInvokeRun
          ? `inspect the diff at ${evidence.worktreePathChecked ?? "the task dir"}, verify it, then continue from it or retry with --force`
          : `inspect the diff at ${evidence.worktreePathChecked ?? "the task dir"}, then re-dispatch through the real finalize path with \`forge retry ${taskId} --force\``;
  return (
    `${headline}\n` +
    sourceLine +
    `    task dir:      ${dir}\n` +
    `    worktree path: ${evidence.worktreePathChecked ?? "(none — no worktree_path or run.projectDir recorded)"}\n` +
    `    changed files: ${files}\n` +
    `    guidance:      ${guidance}`
  );
}

/** FG-455 p2/p3 review finding 2: the operator-facing recovery message for a
 *  fanout_wave_orphaned parent — how many children finished before the wave
 *  was reconciled to failed, and the re-drive path. Shared rendering for
 *  `forge show` human + --json output. */
export function fanoutWaveRecoveryMessage(taskId: string, evidence: FanoutWaveEvidence): string {
  return (
    `fanout wave orphaned — ${evidence.complete}/${evidence.total} children completed before the parent was reconciled to failed.\n` +
    `    guidance:      \`forge recover ${taskId} --re-drive\` to re-drive the whole wave (forge retry is refused for this failure kind)`
  );
}

export function getBlockerTasks(tasks: Task[]): Task[] {
  return tasks.filter(
    (t) =>
      t.status === "awaiting_gate" ||
      t.status === "blocked_by_red",
  );
}

export function groupFailedByKind(
  tasks: Task[],
  getEvents: (taskId: string) => Event[],
): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const t of tasks) {
    if (t.status !== "failed") continue;
    const kind = getFailureKindFromEvents(getEvents(t.id)) ?? "unknown";
    const bucket = result[kind];
    if (bucket) {
      bucket.push(t.id);
    } else {
      result[kind] = [t.id];
    }
  }
  return result;
}

export function deriveNextCommandForRun(runId: string, tasks: Task[]): string {
  const awaitingGate = tasks.find((t) => t.status === "awaiting_gate");
  if (awaitingGate) return `forge gate ${awaitingGate.id} --advance | --reject`;
  const blockedByRed = tasks.find((t) => t.status === "blocked_by_red");
  if (blockedByRed) return `forge show ${blockedByRed.id}  # review red findings`;
  const failed = tasks.find((t) => t.status === "failed");
  if (failed) return `forge retry ${failed.id}`;
  const runningCount = tasks.filter((t) => t.status === "running").length;
  if (runningCount > 0) return `forge show ${runId}  # ${runningCount} task(s) still running`;
  return "—";
}

// ─── Display helpers ─────────────────────────────────────────────────────────

function fmtTime(iso: string): string {
  return iso.slice(11, 19);
}

function payloadSummary(payload: unknown): string {
  if (payload === null || payload === undefined) return "";
  if (typeof payload === "string") return ` — ${payload.slice(0, 60)}`;
  if (typeof payload === "object") {
    const keys = Object.keys(payload as Record<string, unknown>);
    if (keys.length === 0) return "";
    return ` — {${keys.slice(0, 3).join(", ")}${keys.length > 3 ? ", …" : ""}}`;
  }
  return ` — ${String(payload).slice(0, 60)}`;
}

function printTimeline(events: Event[]): void {
  console.log("");
  console.log("Timeline:");
  if (events.length === 0) {
    console.log("  (no events)");
    return;
  }
  for (const e of events) {
    const taskPart = e.taskId ? `  [task:${e.taskId}]` : "";
    console.log(`  ${fmtTime(e.createdAt)}  ${e.eventType}${taskPart}${payloadSummary(e.payload)}`);
  }
}

export function registerShow(program: Command): void {
  program
    .command("show")
    .argument("<id>", "task or run identifier")
    .description("Show full details of a task or run: package, result, verdicts, timeline")
    .option("--json", "emit JSON instead of human-readable output")
    .option("--reconcile", "reconcile the target against reality before showing — the ONLY mutating path (may emit task.reconciled / run.reconciled and finalize stale state). Default show is read-only.")
    .action((id: string, opts: { json?: boolean; reconcile?: boolean }) => {
      ensureForgeDirs();
      // #298: forge show is READ-ONLY by default. A diagnostic that mutated state
      // (reconcileRun, formerly run unconditionally here) is exactly the incident
      // this fixes — inspecting a stale-running task silently reconciled it. The
      // mutating path is now opt-in via --reconcile (alongside the lifecycle
      // commands that intentionally reconcile: next / status / gate).
      const { candidateReason, runCandidates } = showReconcileStep(id, opts);

      getDb({ readOnly: true });
      const result = performShow(id);

      if (result.kind === "not-found") {
        throw new Error(`Not found: ${id}`);
      }

      if (result.kind === "task") {
        const { task, verdicts, events } = result;
        // FG-481: recover.ts's --continue now refuses unconditionally for a
        // pipeline-run task (any workflow other than "invoke") — thread that
        // same signal into orphanRecoveryMessage's guidance so it doesn't
        // steer the operator toward a command that will be refused.
        const taskRun = getRun(task.runId);
        const taskIsInvokeRun = taskRun?.workflow === "invoke";
        const tDir = taskDir(task.runId, task.id);
        const runtimeMeta = getManifestRuntime(tDir);
        const stdoutLog = join(tDir, "container.stdout.log");
        const stderrLog = join(tDir, "container.stderr.log");
        const resultJson = join(tDir, "result.json");

        const failureKind = getFailureKindFromEvents(events);
        const elapsed = computeElapsed(task.startedAt, task.completedAt);
        const stdoutMtime = getLastOutputMtime(stdoutLog);
        const lastOutputAgo = stdoutMtime !== undefined ? formatTimeAgo(stdoutMtime) : "—";
        const recordedIdleTimeoutMs = getManifestIdleTimeoutMs(tDir);
        const idleTimeoutMs = recordedIdleTimeoutMs ?? resolveIdleTimeoutMs();
        const idleTimeoutExact = recordedIdleTimeoutMs !== undefined;
        const resultStatus = classifyResultFile(resultJson);
        const artifacts = listPresentArtifacts(tDir);
        const nextCommand = deriveNextCommandForTask(task.status, failureKind, task.id);
        // #200: extract readable text from stream-json logs; raw fallback for
        // plain output. Scan a wider window than we render so the extractor has
        // events to pull text from; humanizeLogTail caps the rendered lines.
        const stdoutTail = humanizeLogTail(tailLines(stdoutLog, TAIL_SCAN_LINES));
        const stderrTail = humanizeLogTail(tailLines(stderrLog, TAIL_SCAN_LINES));
        // WALK-1: live idle countdown only makes sense while the task is running.
        const idleCountdown = task.status === "running"
          ? computeIdleCountdown(stdoutMtime, idleTimeoutMs, Date.now(), task.startedAt ? new Date(task.startedAt).getTime() : undefined)
          : undefined;
        // #298/#290: reconcile-candidate reason from the read-only step above —
        // a running task whose container is gone is surfaced, never reconciled.
        const reconcileReason: ReconcileReason | null = candidateReason;
        // FG-455: orphaned_work_may_persist carries recovery evidence on its
        // task.failed event — surface it distinctly, not as a generic failure.
        const orphanEvidence = getOrphanEvidenceFromEvents(events);
        // FG-455 p2/p3 review finding 2: fanout_wave_orphaned carries a childSummary
        // (total/complete) on its task.failed event — surface it too, same as orphan evidence.
        const fanoutWaveEvidence = getFanoutWaveEvidenceFromEvents(events);

        if (opts.json) {
          console.log(
            JSON.stringify(
              {
                task,
                events,
                diagnostic: {
                  containerName: `forge-${task.id}`,
                  runtime: runtimeMeta ?? null,
                  reconcileCandidate: reconcileReason, // #298: null unless running + container gone
                  failureKind: failureKind ?? null,
                  orphanRecovery: orphanEvidence
                    ? { evidence: orphanEvidence, message: orphanRecoveryMessage(task.runId, task.id, orphanEvidence, failureKind ?? "orphaned_work_may_persist", taskIsInvokeRun) }
                    : null,
                  fanoutWaveRecovery: fanoutWaveEvidence
                    ? { childSummary: fanoutWaveEvidence, message: fanoutWaveRecoveryMessage(task.id, fanoutWaveEvidence) }
                    : null,
                  elapsed,
                  lastOutputAgo,
                  idleTimeoutMs,
                  idleTimeoutExact,
                  idleCountdown: idleCountdown ?? null,
                  resultStatus,
                  artifacts,
                  nextCommand,
                  stdoutTail,
                  stderrTail,
                },
              },
              null,
              2,
            ),
          );
          return;
        }

        console.log(`Task ${task.id}`);
        console.log(`  run:       ${task.runId}`);
        console.log(`  phase:     ${task.phase} (${task.agentRole})`);
        if (task.agentModel) {
          const alias = task.agentAlias ? ` (${task.agentAlias})` : "";
          console.log(`  model:     ${task.agentModel}${alias}`);
        }
        // AWN-7: in policy mode, explain WHY this model — the named profile,
        // provider/effective-auth, and the rule that selected it.
        if (task.resolvedProfile) {
          console.log(
            `  profile:   ${task.resolvedProfile} (${task.resolvedProvider}/${task.resolvedAuth}) — ${task.resolvedBy}`
          );
        }
        // #292: runtime EXECUTION facts, distinct from the model SELECTION above.
        if (runtimeMeta) {
          console.log(
            `  runtime:   ${runtimeMeta.name} [${runtimeMeta.kind}] — log=${runtimeMeta.logFormat}, prompt=${runtimeMeta.promptStrategy}, auth=${runtimeMeta.authStrategy}`
          );
        }
        console.log(`  status:    ${task.status}`);
        // #298: surface a reconcile candidate read-only — never silently mutate.
        if (reconcileReason) {
          console.log(`  reconcile: CANDIDATE (${reconcileReason}) — DB says running but the container is gone; run \`forge show --reconcile ${task.id}\` to finalize`);
        }
        if (failureKind) console.log(`  failure:   ${failureKind}`);
        // FG-455: don't let this collapse into a generic "failed" — the worktree
        // may hold real, unreviewed work.
        if (orphanEvidence) {
          console.log(`  recovery:  ${orphanRecoveryMessage(task.runId, task.id, orphanEvidence, failureKind ?? "orphaned_work_may_persist", taskIsInvokeRun)}`);
        }
        // FG-455 p2/p3 review finding 2: same distinct treatment for a fanout
        // parent orphaned mid-wave — don't let it collapse into a generic failure.
        if (fanoutWaveEvidence) {
          console.log(`  recovery:  ${fanoutWaveRecoveryMessage(task.id, fanoutWaveEvidence)}`);
        }
        // Docs-drift Walk (#241): if the completed task touched operator surfaces,
        // suggest the documentation-maintainer (advisory only — not a gate yet).
        // #246: surfaces are project-configurable via <project>/.forge/docs-surfaces.yml.
        const docsSuggest = docsImpactSuggestion(
          getResultFilesModified(tDir),
          loadOperatorSurfaces(taskRun?.projectDir)
        );
        if (docsSuggest) console.log(`  docs impact: ${docsSuggest}`);
        console.log(`  container: forge-${task.id}`);
        console.log(`  elapsed:   ${elapsed}`);
        console.log(`  last output: ${lastOutputAgo}`);
        console.log(`  idle timeout: ${formatDurationMs(idleTimeoutMs)}${idleTimeoutExact ? "" : " (current default — not recorded at dispatch)"}`);
        if (idleCountdown) console.log(`  idle:      ${formatIdleCountdown(idleCountdown)}`);
        console.log(`  parent:    ${task.parentId ?? "(none)"}`);
        // AWN-3: retry lineage. previous_failure (set by forge retry) marks this
        // task as a retry; a task.retried event marks it as having been retried.
        const prevFail = (task.taskPackage?.inputs as Record<string, unknown> | undefined)?.["previous_failure"] as { failedTaskId?: string; kind?: string } | undefined;
        if (prevFail?.failedTaskId) console.log(`  retry of:  ${prevFail.failedTaskId} (was ${prevFail.kind ?? "?"})`);
        const retriedEv = events.find((e) => e.eventType === "task.retried");
        if (retriedEv) console.log(`  retried →  ${(retriedEv.payload as Record<string, unknown> | null)?.["newTaskId"] ?? "?"}`);
        if (task.error) console.log(`  error:     ${task.error}`);

        if (stdoutTail.length > 0) {
          console.log("");
          console.log("Last stdout:");
          for (const line of stdoutTail) console.log(`  ${line}`);
        }
        if (stderrTail.length > 0) {
          console.log("");
          console.log("Last stderr:");
          for (const line of stderrTail) console.log(`  ${line}`);
        }

        console.log("");
        console.log(`Result: ${resultStatus}`);

        console.log("");
        console.log("Artifacts:");
        if (artifacts.length === 0) {
          console.log("  (none)");
        } else {
          for (const f of artifacts) console.log(`  ${f}`);
        }

        if (verdicts.length > 0) {
          console.log("");
          console.log("Verdicts:");
          for (const v of verdicts) {
            console.log(
              `  - ${v.redRole} (${v.authority}): ${v.verdict} (${v.confidence.toFixed(2)})`,
            );
            for (const f of v.findings) {
              console.log(`      [${f.severity}] ${f.summary}`);
            }
          }
        }

        printTimeline(events);

        console.log("");
        console.log("Next:");
        console.log(`  ${nextCommand}`);
        return;
      }

      // kind === "run"
      const { run, events, tasks } = result;
      const failedByKind = groupFailedByKind(tasks, eventsForTask);
      const blockers = getBlockerTasks(tasks);
      const runningTasks = tasks.filter((t) => t.status === "running");
      const nextCommand = deriveNextCommandForRun(run.id, tasks);
      // AWN-5: convergent (≥2 reds agree) vs unique review findings across the run.
      const reviewSummary = summarizeFindings(gatherRunReviews(tasks.map((t) => t.id), verdictsForTask));

      if (opts.json) {
        const now = Date.now();
        const runningWithLastOutput = runningTasks.map((t) => {
          const logPath = join(taskDir(t.runId, t.id), "container.stdout.log");
          const mtime = getLastOutputMtime(logPath);
          return {
            taskId: t.id,
            role: t.agentRole,
            lastOutputAgo: mtime !== undefined ? formatTimeAgo(mtime, now) : "—",
          };
        });
        console.log(
          JSON.stringify(
            {
              run,
              events,
              tasks,
              diagnostic: {
                blockers: blockers.map((t) => ({
                  taskId: t.id,
                  status: t.status,
                  role: t.agentRole,
                  phase: t.phase,
                })),
                failedByKind,
                runningWithLastOutput,
                reconcileCandidates: runCandidates, // #298: running tasks whose container is gone
                nextCommand,
                reviewSummary,
              },
            },
            null,
            2,
          ),
        );
        return;
      }

      console.log(`Run ${run.id}`);
      console.log(`  workflow: ${run.workflow}`);
      console.log(`  status:   ${run.status}`);
      console.log(`  project:  ${run.projectDir ?? "(none)"}`);
      console.log(`  created:  ${run.createdAt}`);
      if (run.completedAt) console.log(`  completed: ${run.completedAt}`);

      if (blockers.length > 0) {
        console.log("");
        console.log("Blockers:");
        for (const t of blockers) {
          console.log(`  ${t.id}  (${t.status})  ${t.phase}/${t.agentRole}`);
        }
      }

      if (Object.keys(failedByKind).length > 0) {
        console.log("");
        console.log("Failed tasks:");
        for (const [kind, taskIds] of Object.entries(failedByKind)) {
          console.log(`  ${kind}: ${taskIds.join(", ")}`);
        }
      }

      if (reviewSummary.convergent.length > 0 || reviewSummary.unique.length > 0) {
        console.log("");
        console.log("Review findings:");
        if (reviewSummary.convergent.length > 0) {
          console.log(`  Convergent (multiple reds agree):`);
          for (const c of reviewSummary.convergent) {
            console.log(`    [${c.maxSeverity}] ${c.exemplar.summary}  — ${c.reviewers.join(", ")} (${c.count})`);
          }
        }
        if (reviewSummary.unique.length > 0) {
          console.log(`  Unique (single red):`);
          for (const c of reviewSummary.unique) {
            console.log(`    [${c.maxSeverity}] ${c.exemplar.summary}  — ${c.reviewers[0]}`);
          }
        }
      }

      if (runningTasks.length > 0) {
        console.log("");
        console.log("Running tasks:");
        const now = Date.now();
        const candidateReasonById = new Map(runCandidates.map((c) => [c.taskId, c.reason]));
        for (const t of runningTasks) {
          const logPath = join(taskDir(t.runId, t.id), "container.stdout.log");
          const mtime = getLastOutputMtime(logPath);
          const ago = mtime !== undefined ? formatTimeAgo(mtime, now) : "—";
          // #298: a running task whose container is gone is a reconcile candidate,
          // not ordinary live work — flag it inline rather than listing it plainly.
          const reason = candidateReasonById.get(t.id);
          const flag = reason ? `  ⟶ reconcile candidate (${reason})` : "";
          console.log(`  ${t.id}  ${t.phase}/${t.agentRole}  last output: ${ago}${flag}`);
        }
      }
      // #298: an explicit, read-only callout so the operator sees the reconcile
      // path without forge show having mutated anything.
      if (runCandidates.length > 0) {
        console.log("");
        console.log("Reconcile candidates (DB says running, container gone — read-only; nothing was changed):");
        for (const c of runCandidates) {
          console.log(`  ${c.taskId}  ${c.reason}  →  forge show --reconcile ${c.taskId}`);
        }
      }

      printTimeline(events);

      console.log("");
      console.log("Next:");
      console.log(`  ${nextCommand}`);
    });
}
