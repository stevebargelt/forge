import type { Command } from "commander";
import { statSync, readFileSync } from "node:fs";
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

export function getFailureKindFromEvents(events: Event[]): string | undefined {
  const failedEv = events.find((e) => e.eventType === "task.failed");
  if (!failedEv) return undefined;
  const payload = failedEv.payload as Record<string, unknown> | null;
  if (payload && typeof payload["failure_kind"] === "string") return payload["failure_kind"];
  return undefined;
}

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

export function tailLines(filePath: string, n: number): string[] {
  try {
    const content = readFileSync(filePath, "utf8");
    const lines = content.split("\n").filter((l) => l.length > 0);
    return lines.slice(-n);
  } catch {
    return [];
  }
}

export function listPresentArtifacts(taskDirPath: string): string[] {
  // #197 seam: manifest.json will plug in here when that ticket lands.
  const known = [
    "CLAUDE.md",
    "package.md",
    "result.json",
    "container.stdout.log",
    "container.stderr.log",
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
      getDb({ readOnly: true });
      const result = performShow(id);

      if (result.kind === "not-found") {
        throw new Error(`Not found: ${id}`);
      }

      if (result.kind === "task") {
        const { task, verdicts, events } = result;
        const tDir = taskDir(task.runId, task.id);
        const stdoutLog = join(tDir, "container.stdout.log");
        const stderrLog = join(tDir, "container.stderr.log");
        const resultJson = join(tDir, "result.json");

        const failureKind = getFailureKindFromEvents(events);
        const elapsed = computeElapsed(task.startedAt, task.completedAt);
        const stdoutMtime = getLastOutputMtime(stdoutLog);
        const lastOutputAgo = stdoutMtime !== undefined ? formatTimeAgo(stdoutMtime) : "—";
        const idleTimeoutMs = resolveIdleTimeoutMs();
        const resultStatus = classifyResultFile(resultJson);
        const artifacts = listPresentArtifacts(tDir);
        const nextCommand = deriveNextCommandForTask(task.status, failureKind, task.id);
        const stdoutTail = tailLines(stdoutLog, 5);
        const stderrTail = tailLines(stderrLog, 5);

        if (opts.json) {
          console.log(
            JSON.stringify(
              {
                task,
                events,
                diagnostic: {
                  containerName: `forge-${task.id}`,
                  failureKind: failureKind ?? null,
                  elapsed,
                  lastOutputAgo,
                  idleTimeoutMs,
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
        console.log(`  status:    ${task.status}`);
        if (failureKind) console.log(`  failure:   ${failureKind}`);
        console.log(`  container: forge-${task.id}`);
        console.log(`  elapsed:   ${elapsed}`);
        console.log(`  last output: ${lastOutputAgo}`);
        console.log(`  idle timeout: ${formatDurationMs(idleTimeoutMs)}`);
        console.log(`  parent:    ${task.parentId ?? "(none)"}`);
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
