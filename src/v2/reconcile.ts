// AWN-1: lifecycle recovery. Make active/running state trustworthy after host
// crashes, Docker races, and interrupted forge commands.
//
// Runs on lifecycle-touching commands: `forge next`, `forge status`, and
// `forge show --reconcile` (#298 made plain `forge show` read-only — a diagnostic
// must not mutate; it surfaces a reconcile candidate via the #290 read-only
// classifier and leaves the explicit reconcile to --reconcile / the lifecycle
// commands). It NEVER silently rewrites state: every change emits a
// task.reconciled / run.reconciled event alongside the normal terminal event, so
// the forge show timeline explains what changed and why. Idempotent — a second
// pass finds terminal state and no-ops.
//
// Conservative by design: a container whose liveness we cannot determine (docker
// daemon down, docker missing) is assumed alive, so we never reconcile real work
// to failed on a transient docker hiccup. And we only complete an active RUN when
// it is unambiguous there is no further work — single-step invoke runs. Multi-
// step pipelines are finalized by `forge next`, which has the workflow.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getRun, updateRunStatus } from "../store/runs.js";
import { tasksForRun, markTaskComplete, markTaskFailed } from "../store/tasks.js";
import { logEvent, eventsForTask } from "../store/events.js";
import { taskDir } from "../util/paths.js";
import { cleanupStagedAuth } from "./auth-state.js";
import { removeWorktreeIfSafe } from "./worktree-lifecycle.js";
import { getManifestRuntime } from "./task-manifest.js";
import { analyzeProviderFailure } from "./provider-failure.js";
import { inferredResultFrom } from "./inferred-result.js";
import type { OrphanEvidence } from "./failure-kind.js";

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

// FG-455 finding 1: never gate a read on existsSync — the file can vanish (or
// become unreadable) between the check and the read (TOCTOU), and reconcileRun
// must NEVER throw. Read directly and treat ANY error (ENOENT, EACCES, EISDIR,
// ...) as "no result".
function readResult(runId: string, taskId: string): unknown | undefined {
  const p = join(taskDir(runId, taskId), "result.json");
  let raw: string;
  try {
    raw = readFileSync(p, "utf8").trim();
  } catch {
    return undefined;
  }
  if (raw.length === 0) return undefined;
  try { return JSON.parse(raw); } catch { return undefined; }
}

/** Diagnostic-only classification of the on-disk result.json state — recorded
 *  in the container-gone evidence, never used to drive markTaskComplete/Failed
 *  (that still goes through readResult's strict parse). Same TOCTOU guard as
 *  readResult above: any read error collapses to "absent". */
function resultFileState(runId: string, taskId: string): "absent" | "empty" | "malformed" {
  const p = join(taskDir(runId, taskId), "result.json");
  let raw: string;
  try {
    raw = readFileSync(p, "utf8").trim();
  } catch {
    return "absent";
  }
  if (raw.length === 0) return "empty";
  return "malformed"; // non-empty but readResult() above already returned undefined for this branch
}

function readStdoutLog(runId: string, taskId: string): string {
  const p = join(taskDir(runId, taskId), "container.stdout.log");
  if (!existsSync(p)) return "";
  try { return readFileSync(p, "utf8"); } catch { return ""; }
}

/** FG-455: git status --porcelain against a task's persisted-work path. Never
 *  throws — a missing path, a non-git directory, or any git error is reported
 *  as "no changed files" so reconcile stays safe even against a half-formed
 *  worktree. */
function changedWorktreeFiles(path: string | undefined): string[] {
  if (!path) return [];
  try {
    const out = execFileSync("git", ["status", "--porcelain"], {
      cwd: path,
      stdio: ["ignore", "pipe", "pipe"],
    }).toString();
    return out.split("\n").map((l) => l.trim()).filter(Boolean);
  } catch {
    return [];
  }
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
    if (result !== undefined && markTaskComplete(t.id, result)) {
      logEvent("task.completed", { runId, taskId: t.id });
      logEvent("task.reconciled", { runId, taskId: t.id, payload: { from: "running", to: "complete", reason: "container_gone_result_present" } });
      taskChanges.push({ taskId: t.id, from: "running", to: "complete", reason: "container_gone_result_present" });
    } else if (result === undefined) {
      // FG-455: an empty/absent result.json used to collapse straight to
      // "orphaned" — discarding any work the agent actually persisted before the
      // wrapper died. Recover in strict precedence order before giving up:
      //   1. a recoverable structured result sitting in stdout (FG-337 synthesis)
      //   2. a dirty worktree — real files may have landed even though nothing
      //      was ever readable back out of the container
      //   3. only then, the ordinary orphaned/no-result classification.
      const dir = taskDir(t.runId, t.id);
      const containerName = `forge-${t.id}`;
      // FG-455 finding 1: this whole attempt is best-effort recovery over
      // container.stdout.log — a malformed manifest, an unreadable log, or an
      // unexpected shape in the stdout analysis must never propagate out of
      // reconcileRun. Any error here safe-denies to "no recoverable result",
      // falling through to the worktree-dirty / ordinary-orphaned path below.
      let inferred: ReturnType<typeof inferredResultFrom>;
      try {
        const runtimeMeta = getManifestRuntime(dir);
        const stdoutRaw = readStdoutLog(t.runId, t.id);
        const analysis = analyzeProviderFailure({
          logFormat: runtimeMeta?.logFormat,
          runtimeKind: runtimeMeta?.kind,
          stdoutRaw,
        });
        inferred = inferredResultFrom(analysis, t.agentRole);
      } catch {
        inferred = undefined;
      }

      if (inferred) {
        writeFileSync(join(dir, "result.json"), JSON.stringify(inferred));
        if (markTaskComplete(t.id, inferred)) {
          logEvent("task.completed", { runId, taskId: t.id });
          logEvent("task.reconciled", { runId, taskId: t.id, payload: { from: "running", to: "complete", reason: "container_gone_result_recovered_from_stdout" } });
          taskChanges.push({ taskId: t.id, from: "running", to: "complete", reason: "container_gone_result_recovered_from_stdout" });
        }
      } else {
        // FG-455 finding 2: a dedicated worktree_path is this task's alone — any
        // changed files found there are confident, task-exclusive evidence. The
        // run.projectDir fallback (no-worktree tasks, the core FG-455 case) is
        // SHARED with the operator's cwd and any other no-worktree task in the
        // run — a dirty status there may just be unrelated in-progress work, not
        // proof this task persisted anything. Record which one it was so every
        // consumer (show/status/ops-check) can render the honest confidence level.
        const worktreePathChecked = t.worktreePath ?? run.projectDir;
        const source: OrphanEvidence["source"] = t.worktreePath ? "worktree" : "project_dir_shared";
        const changedFiles = changedWorktreeFiles(worktreePathChecked);
        const evidence: OrphanEvidence = {
          containerName,
          containerLiveness: "gone",
          resultState: resultFileState(t.runId, t.id),
          recoverableStdoutResult: false,
          worktreePathChecked: worktreePathChecked ?? null,
          changedFiles,
          source,
        };

        if (changedFiles.length > 0) {
          const error =
            `orphaned_work_may_persist: container gone with no recoverable result, but ${changedFiles.length} changed file(s) found at ${worktreePathChecked} — ` +
            (source === "project_dir_shared"
              ? "in the SHARED project directory (no dedicated worktree for this task) — this may include unrelated uncommitted changes, evidence to inspect, not proof of task work. "
              : "") +
            "work may have persisted. Inspect the diff, verify it, then continue from it or `forge retry --force`.";
          markTaskFailed(t.id, error);
          logEvent("task.failed", { runId, taskId: t.id, payload: { failure_kind: "orphaned_work_may_persist", error, evidence } });
          logEvent("task.reconciled", { runId, taskId: t.id, payload: { from: "running", to: "failed", reason: "container_gone_worktree_dirty", evidence } });
          taskChanges.push({ taskId: t.id, from: "running", to: "failed", reason: "container_gone_worktree_dirty" });
        } else {
          const error = "orphaned: container gone with no result (reconciled after crash)";
          markTaskFailed(t.id, error);
          logEvent("task.failed", { runId, taskId: t.id, payload: { failure_kind: "orphaned", error } });
          logEvent("task.reconciled", { runId, taskId: t.id, payload: { from: "running", to: "failed", reason: "container_gone_no_result" } });
          taskChanges.push({ taskId: t.id, from: "running", to: "failed", reason: "container_gone_no_result" });
        }
      }
    }
    // AWN-8: reconciliation is a terminal transition too — don't leave the staged
    // bearer token behind (no-op when there's no auth file).
    cleanupStagedAuth(taskDir(t.runId, t.id));
    // FG-351: ephemeral/test-mode worktree cleanup. Production no-op until
    // FG-352 (merge-back) makes cleanup safe for real agent output.
    // run.projectDir is required as git cwd — skip cleanup if the run has no
    // recorded projectDir (e.g. legacy rows created before FG-374).
    if (t.worktreePath && run.projectDir) {
      removeWorktreeIfSafe(t.worktreePath, t.runId, t.id, run.projectDir);
    }
  }

  // Orphaned duplicate primaries: a pending primary in a phase that another
  // primary already completed. Produced by the duplicate-primary bug (`forge
  // retry` mints a parallel pending primary; a different rerun path completes the
  // phase first, stranding the retry's row). Left alone it never runs yet keeps
  // the run out of "complete" (it's non-terminal pending work) and, before the
  // ready-queue was made duplicate-tolerant, blocked the next phase. Finalize it
  // as failed/orphaned so the run can advance and complete.
  for (const c of finalizeOrphanedPrimaries(runId)) taskChanges.push(c);

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

/** Mark as failed any PENDING primary task in a phase that another primary has
 *  already COMPLETED — an orphaned duplicate primary (see the duplicate-primary
 *  bug in ready-queue.ts). Pending-only: a `running` duplicate may be doing real
 *  work and is left for container-liveness reconciliation. Idempotent (a second
 *  pass finds the orphan already failed). Returns what it changed. Exported so
 *  `forge next` can self-heal on the advance path, not only on status/show. */
export function finalizeOrphanedPrimaries(runId: string): TaskReconcileChange[] {
  const primariesByPhase = new Map<string, { id: string; status: string }[]>();
  for (const t of tasksForRun(runId)) {
    if (t.parentId !== undefined) continue; // primaries only
    const arr = primariesByPhase.get(t.phase) ?? [];
    arr.push({ id: t.id, status: t.status });
    primariesByPhase.set(t.phase, arr);
  }

  const changes: TaskReconcileChange[] = [];
  for (const primaries of primariesByPhase.values()) {
    if (!primaries.some((p) => p.status === "complete")) continue;
    for (const p of primaries) {
      if (p.status !== "pending") continue;
      const error =
        "orphaned: duplicate pending primary in a phase already completed by another primary";
      markTaskFailed(p.id, error);
      logEvent("task.failed", { runId, taskId: p.id, payload: { failure_kind: "orphaned", error } });
      logEvent("task.reconciled", { runId, taskId: p.id, payload: { from: "pending", to: "failed", reason: "orphaned_duplicate_primary" } });
      changes.push({ taskId: p.id, from: "pending", to: "failed", reason: "orphaned_duplicate_primary" });
    }
  }
  return changes;
}

/** Reconcile a specific set of runs. Callers pass exactly the run ids they will
 *  act on / display, so reconciliation stays scoped — e.g. `forge status` must
 *  reconcile only the workspace-filtered runs it shows, not every active run on
 *  the host (that would mutate other workspaces' runs). Returns only the runs
 *  that actually changed. */
export function reconcileRuns(runIds: string[], containerAlive: ContainerAlive = defaultContainerAlive): ReconcileResult[] {
  return runIds
    .map((id) => reconcileRun(id, containerAlive))
    .filter((r) => r.taskChanges.length > 0 || r.runChange);
}
