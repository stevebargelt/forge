// AWN-1: lifecycle recovery. Make active/running state trustworthy after host
// crashes, Docker races, and interrupted forge commands.
//
// Runs on lifecycle-touching commands (status/show/next). It NEVER silently
// rewrites state: every change emits a task.reconciled / run.reconciled event
// alongside the normal terminal event, so the forge show timeline explains what
// changed and why. Idempotent — a second pass finds terminal state and no-ops.
//
// Conservative by design: a container whose liveness we cannot determine (docker
// daemon down, docker missing) is assumed alive, so we never reconcile real work
// to failed on a transient docker hiccup. And we only complete an active RUN when
// it is unambiguous there is no further work — single-step invoke runs. Multi-
// step pipelines are finalized by `forge next`, which has the workflow.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { listRuns, getRun, updateRunStatus } from "../store/runs.js";
import { tasksForRun, markTaskComplete, markTaskFailed } from "../store/tasks.js";
import { logEvent, eventsForTask } from "../store/events.js";
import { taskDir } from "../util/paths.js";

export type ContainerAlive = (containerName: string) => boolean;

export type TaskReconcileChange = { taskId: string; from: string; to: string; reason: string };
export type ReconcileResult = {
  runId: string;
  taskChanges: TaskReconcileChange[];
  runChange?: { from: string; to: string; reason: string };
};

const TERMINAL_TASK = new Set(["complete", "failed"]);

/** Is the named container actually running? Conservative on ambiguity: a clear
 *  "No such object" means gone; anything else (daemon unreachable, docker
 *  missing) returns true so we don't reconcile live work on a transient error. */
export function defaultContainerAlive(name: string): boolean {
  try {
    const out = execFileSync("docker", ["inspect", "-f", "{{.State.Running}}", name], {
      stdio: ["ignore", "pipe", "pipe"],
    }).toString().trim();
    return out === "true";
  } catch (e) {
    const stderr = (e as { stderr?: Buffer }).stderr?.toString() ?? "";
    if (/No such object|no such container/i.test(stderr)) return false; // genuinely gone
    return true; // ambiguous → assume alive, don't reconcile
  }
}

function readResult(runId: string, taskId: string): unknown | undefined {
  const p = join(taskDir(runId, taskId), "result.json");
  if (!existsSync(p)) return undefined;
  const raw = readFileSync(p, "utf8").trim();
  if (raw.length === 0) return undefined;
  try { return JSON.parse(raw); } catch { return undefined; }
}

/** Reconcile a single run's task + run state against reality. Returns what (if
 *  anything) changed. */
export function reconcileRun(runId: string, containerAlive: ContainerAlive = defaultContainerAlive): ReconcileResult {
  const run = getRun(runId);
  const taskChanges: TaskReconcileChange[] = [];
  if (!run) return { runId, taskChanges };

  for (const t of tasksForRun(runId)) {
    if (t.status !== "running") continue;
    // Only CONTAINERIZED tasks are reconcilable via container liveness. Session
    // (forge design / orchestrator) and manual tasks run host-side and never
    // launch a container, so `docker inspect` would always say "gone" and we'd
    // wrongly orphan them. The authoritative signal that forge launched a
    // container is a container.started event for the task.
    if (!eventsForTask(t.id).some((e) => e.eventType === "container.started")) continue;
    if (containerAlive(`forge-${t.id}`)) continue; // genuinely still running

    // Container is gone. If it left a usable result, finalize as complete (the
    // work finished but the DB write was lost); otherwise it was orphaned.
    const result = readResult(t.runId, t.id);
    if (result !== undefined) {
      markTaskComplete(t.id, result);
      logEvent("task.completed", { runId, taskId: t.id });
      logEvent("task.reconciled", { runId, taskId: t.id, payload: { from: "running", to: "complete", reason: "container_gone_result_present" } });
      taskChanges.push({ taskId: t.id, from: "running", to: "complete", reason: "container_gone_result_present" });
    } else {
      const error = "orphaned: container gone with no result (reconciled after crash)";
      markTaskFailed(t.id, error);
      logEvent("task.failed", { runId, taskId: t.id, payload: { failure_kind: "orphaned", error } });
      logEvent("task.reconciled", { runId, taskId: t.id, payload: { from: "running", to: "failed", reason: "container_gone_no_result" } });
      taskChanges.push({ taskId: t.id, from: "running", to: "failed", reason: "container_gone_no_result" });
    }
  }

  // Run-level: an active run with no remaining non-terminal work is no longer in
  // flight. We only complete it when there are no further workflow steps to come
  // — unambiguous only for single-step invoke runs; pipelines are finalized by
  // `forge next` (which loads the workflow).
  let runChange: ReconcileResult["runChange"];
  if (run.status === "active" && run.workflow === "invoke") {
    const after = tasksForRun(runId);
    const anyNonTerminal = after.some((t) => !TERMINAL_TASK.has(t.status));
    if (after.length > 0 && !anyNonTerminal) {
      updateRunStatus(runId, "complete");
      logEvent("run.completed", { runId, payload: { source: "reconcile" } });
      logEvent("run.reconciled", { runId, payload: { from: "active", to: "complete", reason: "no_live_work" } });
      runChange = { from: "active", to: "complete", reason: "no_live_work" };
    }
  }

  return { runId, taskChanges, ...(runChange ? { runChange } : {}) };
}

/** Reconcile every active run. Used by `forge status` (the list view). Returns
 *  only the runs that actually changed. */
export function reconcileActiveRuns(containerAlive: ContainerAlive = defaultContainerAlive): ReconcileResult[] {
  return listRuns()
    .filter((r) => r.status === "active")
    .map((r) => reconcileRun(r.id, containerAlive))
    .filter((r) => r.taskChanges.length > 0 || r.runChange);
}
