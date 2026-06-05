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
import { failureKindFromEvents as getFailureKindFromEvents } from "../../v2/failure-kind.js";
import { reconcileRun } from "../../v2/reconcile.js";
import { docsImpactSuggestion, loadOperatorSurfaces, type TaskContract } from "../../v2/contract.js";
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

// ─── Pure helpers, exported for testing ─────────────────────────────────────

// The failure-kind scan lives in the neutral failure-kind module (single source
// of truth, also consumed by the notification layer). Imported + re-exported
// here under its long-standing name so forge show / watch importers and tests
// stay stable.
export { getFailureKindFromEvents };

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

// #292: the runtime EXECUTION metadata this task ran under, from its manifest.
// Undefined for pre-#292 manifests. Lets forge show report runtime behavior
// (parser/prompt/auth strategy) distinctly from upstream provider/model.
export type ManifestRuntime = {
  name: string;
  kind: string;
  logFormat: string;
  promptStrategy: string;
  authStrategy: string;
};
export function getManifestRuntime(taskDirPath: string): ManifestRuntime | undefined {
  try {
    const raw = readFileSync(join(taskDirPath, "manifest.json"), "utf8");
    const manifest = JSON.parse(raw) as { runtime?: ManifestRuntime };
    return manifest.runtime;
  } catch {
    return undefined;
  }
}

// AWN-4: the task contract this task was dispatched under, from its manifest.
export function getManifestContract(taskDirPath: string): TaskContract | undefined {
  try {
    const raw = readFileSync(join(taskDirPath, "manifest.json"), "utf8");
    const manifest = JSON.parse(raw) as { contract?: TaskContract };
    return manifest.contract;
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
    return `forge retry ${taskId}`;
  }
  if (status === "awaiting_gate") return `forge gate ${taskId} --advance | --reject`;
  if (status === "blocked_by_red")
    return `forge show <redTaskId>  # review findings, then forge gate ${taskId} --advance | --reject`;
  if (status === "awaiting_human_input") return `forge gate ${taskId} --advance`;
  return "—";
}

export function getBlockerTasks(tasks: Task[]): Task[] {
  return tasks.filter(
    (t) =>
      t.status === "awaiting_gate" ||
      t.status === "awaiting_human_input" ||
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
    .action((id: string, opts: { json?: boolean }) => {
      ensureForgeDirs();
      // AWN-1: reconcile the target run against reality (writable) BEFORE the
      // read-only show, so the timeline reflects any crash/Docker recovery.
      const targetTask = getTask(id);
      reconcileRun(targetTask ? targetTask.runId : id);

      getDb({ readOnly: true });
      const result = performShow(id);

      if (result.kind === "not-found") {
        throw new Error(`Not found: ${id}`);
      }

      if (result.kind === "task") {
        const { task, verdicts, events } = result;
        const tDir = taskDir(task.runId, task.id);
        const contract = getManifestContract(tDir);
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
        const stdoutTail = tailLines(stdoutLog, 5);
        const stderrTail = tailLines(stderrLog, 5);
        // WALK-1: live idle countdown only makes sense while the task is running.
        const idleCountdown = task.status === "running"
          ? computeIdleCountdown(stdoutMtime, idleTimeoutMs, Date.now(), task.startedAt ? new Date(task.startedAt).getTime() : undefined)
          : undefined;

        if (opts.json) {
          console.log(
            JSON.stringify(
              {
                task,
                events,
                diagnostic: {
                  containerName: `forge-${task.id}`,
                  runtime: runtimeMeta ?? null,
                  failureKind: failureKind ?? null,
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
        if (failureKind) console.log(`  failure:   ${failureKind}`);
        if (contract) {
          console.log(`  contract:  ${contract.objective}${contract.risk ? `  [risk: ${contract.risk}]` : ""}`);
          if (contract.allowed_paths?.length) console.log(`    allowed:   ${contract.allowed_paths.join(", ")}`);
          if (contract.validation?.commands?.length) console.log(`    validate:  ${contract.validation.commands.join(" ; ")}`);
          if (contract.review?.invariants?.length) console.log(`    invariants: ${contract.review.invariants.join(" | ")}`);
          if (contract.operator_behavior_changed) console.log(`    operator behavior: changes — docs impact expected`);
        }
        // Docs-drift Walk (#241): if the completed task touched operator surfaces,
        // suggest the documentation-maintainer (advisory only — not a gate yet).
        // #246: surfaces are project-configurable via <project>/.forge/docs-surfaces.yml.
        const docsSuggest = docsImpactSuggestion(
          getResultFilesModified(tDir),
          loadOperatorSurfaces(getRun(task.runId)?.projectDir)
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
        for (const t of runningTasks) {
          const logPath = join(taskDir(t.runId, t.id), "container.stdout.log");
          const mtime = getLastOutputMtime(logPath);
          const ago = mtime !== undefined ? formatTimeAgo(mtime, now) : "—";
          console.log(`  ${t.id}  ${t.phase}/${t.agentRole}  last output: ${ago}`);
        }
      }

      printTimeline(events);

      console.log("");
      console.log("Next:");
      console.log(`  ${nextCommand}`);
    });
}
