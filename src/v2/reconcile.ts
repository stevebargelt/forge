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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

/** Outcome of a best-effort `docker rm -f` reap attempt on a container we've
 *  already confirmed is not alive (see containerAlive above) — mirrors
 *  dependency-provisioning.ts's dockerKillContainer discriminated result so a
 *  daemon hiccup ('error') is never mistaken for confirmed cleanup. */
export type ContainerReapResult = "killed" | "not_found" | "error";
export type ContainerReap = (containerName: string) => ContainerReapResult;

/** Real `docker rm -f` — reconcile's default reaper for an orphaned
 *  dependency-provisioner container. Tests inject a fake so no real docker is
 *  required to exercise the FG-437 recovery branch. */
export function defaultContainerReap(containerName: string): ContainerReapResult {
  try {
    execFileSync("docker", ["rm", "-f", containerName], { stdio: ["ignore", "ignore", "pipe"] });
    return "killed";
  } catch (e) {
    const stderr = (e as { stderr?: Buffer }).stderr?.toString() ?? "";
    if (/no such container/i.test(stderr)) return "not_found";
    return "error"; // NOT confirmed gone — leave it, a later reconcile can retry
  }
}

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
 *  worktree. Exported so `forge recover` (FG-455 p3) can recompute the same
 *  live diff without duplicating the never-throw git-status shape. */
export function changedWorktreeFiles(path: string | undefined): string[] {
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
export function reconcileRun(
  runId: string,
  containerAlive: ContainerAlive = defaultContainerAlive,
  reapContainer: ContainerReap = defaultContainerReap,
): ReconcileResult {
  const run = getRun(runId);
  const taskChanges: TaskReconcileChange[] = [];
  if (!run) return { runId, taskChanges };

  for (const t of tasksForRun(runId)) {
    if (t.status !== "running") continue;
    const taskEvents = eventsForTask(t.id);
    const hasContainerStarted = taskEvents.some((e) => e.eventType === "container.started");

    // FG-437: a task can crash between task.started and container.started —
    // while its dependency provisioner (a SEPARATE, differently-named
    // container: forge-provision-<cacheKey>, not forge-<taskId>) runs to
    // completion. The container.started gate below exists precisely to skip
    // host-side session/manual tasks, but it also (wrongly) skips this
    // in-flight-provisioning shape forever, since container.started for the
    // AGENT container only fires after provisioning succeeds. Detect + recover
    // it here, before that gate, using the durable provision_started event
    // (which carries the real container name/cacheKey independent of the
    // worktree, which may already be gone).
    if (!hasContainerStarted) {
      const provisionStarted = taskEvents.find((e) => e.eventType === "container.provision_started");
      if (provisionStarted) {
        const payload = provisionStarted.payload as { containerName?: string; cacheKey?: string } | null;
        const provisionContainerName = payload?.containerName;
        const cacheKey = payload?.cacheKey;
        if (provisionContainerName && cacheKey) {
          if (containerAlive(provisionContainerName)) {
            // FG-376 rule: never touch a live provisioner — an install may
            // still be in flight. Leave running; a later reconcile settles
            // this once the provisioner container actually dies.
            continue;
          }

          // Provisioner confirmed gone. Best-effort reap of any orphaned
          // container left behind — never throws, never blocks the task
          // transition below on a reap failure (a daemon hiccup just means a
          // later reconcile/dispatch tries again).
          let reapResult: ContainerReapResult;
          try {
            reapResult = reapContainer(provisionContainerName);
          } catch {
            reapResult = "error";
          }

          const error =
            `verification_environment_unavailable: task crashed during dependency provisioning ` +
            `(provisioner ${provisionContainerName} is gone) — dependencies may already be cached; ` +
            `retry with \`forge retry ${t.id}\`.`;
          const evidence = {
            containerName: provisionContainerName,
            cacheKey,
            provisionerLiveness: "gone" as const,
            reapResult,
            reason: error,
          };
          markTaskFailed(t.id, error);
          logEvent("task.failed", { runId, taskId: t.id, payload: { failure_kind: "verification_environment_unavailable", error, evidence } });
          logEvent("task.reconciled", { runId, taskId: t.id, payload: { from: "running", to: "failed", reason: "provisioning_phase_crash", evidence } });
          taskChanges.push({ taskId: t.id, from: "running", to: "failed", reason: "provisioning_phase_crash" });

          // FG-437 AC: deliberately do NOT hand-clear the cacheKey's .lock /
          // .ready files here — a crash mid-provision never writes the ready
          // marker (atomic rename in markDependencyCacheReady), so there's
          // nothing to un-mark, and a stale lock from the now-dead holder is
          // already handled by FG-376's liveness-aware steal on the next
          // provision attempt (dependency-provisioning.ts onDeadHolder).
          // Duplicating that here would fight the single source of truth for
          // lock recovery.

          // AWN-8: same terminal cleanup as the container-gone branch below.
          cleanupStagedAuth(taskDir(t.runId, t.id));
          if (t.worktreePath && run.projectDir) {
            removeWorktreeIfSafe(t.worktreePath, t.runId, t.id, run.projectDir);
          }
          continue;
        }
      }
    }

    // Only CONTAINERIZED tasks are reconcilable via container liveness. Session
    // (forge design / orchestrator) and manual tasks run host-side and never
    // launch a container, so `docker inspect` would always say "gone" and we'd
    // wrongly orphan them. The authoritative signal that forge launched a
    // container is a container.started event for the task.
    if (!hasContainerStarted) continue;
    if (containerAlive(`forge-${t.id}`)) continue; // genuinely still running

    // Container is gone. If it left a usable result, finalize as complete (the
    // work finished but the DB write was lost); otherwise it was orphaned.
    const result = readResult(t.runId, t.id);
    const containerName = `forge-${t.id}`;

    // FG-455 p1 review: gather the worktree/changedFiles evidence ONCE, before
    // the result-present/absent split, so all four container-gone outcomes
    // (valid result, recovered-from-stdout, work-may-persist, ordinary orphaned)
    // share the same accurately-gathered tuple — none hardcodes
    // worktreePathChecked/changedFiles. A dedicated worktree_path is task-
    // exclusive, confident evidence; the run.projectDir fallback is SHARED with
    // the operator's cwd, so its source is recorded separately (see
    // OrphanEvidence.source).
    const worktreePathChecked = t.worktreePath ?? run.projectDir;
    const source: OrphanEvidence["source"] = t.worktreePath ? "worktree" : "project_dir_shared";
    const changedFiles = changedWorktreeFiles(worktreePathChecked);
    const baseEvidence = {
      containerName,
      containerLiveness: "gone" as const,
      worktreePathChecked: worktreePathChecked ?? null,
      changedFiles,
      source,
    };

    if (result !== undefined && markTaskComplete(t.id, result)) {
      // FG-455 p1 review: the valid-result outcome is one of the four
      // container-gone outcomes — it must carry the same durable evidence
      // tuple as the other three, not just an empty payload.
      const evidence: OrphanEvidence = { ...baseEvidence, resultState: "valid", recoverableStdoutResult: false };
      logEvent("task.completed", { runId, taskId: t.id });
      logEvent("task.reconciled", { runId, taskId: t.id, payload: { from: "running", to: "complete", reason: "container_gone_result_present", evidence } });
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

      // Reuse baseEvidence gathered above the split — only resultState and
      // recoverableStdoutResult vary per outcome.
      const evidence: OrphanEvidence = {
        ...baseEvidence,
        resultState: resultFileState(t.runId, t.id),
        recoverableStdoutResult: inferred !== undefined,
      };

      if (inferred) {
        // FG-455 review finding 1: completion must come from the in-memory
        // recovered result, never depend on the disk write succeeding — the
        // write is best-effort only. If result.json is a directory, unwritable,
        // or the path races invalid, note the failure in evidence and still
        // complete the task from `inferred`.
        try {
          writeFileSync(join(dir, "result.json"), JSON.stringify(inferred));
        } catch {
          evidence.resultWriteFailed = true;
        }
        if (markTaskComplete(t.id, inferred)) {
          logEvent("task.completed", { runId, taskId: t.id });
          logEvent("task.reconciled", { runId, taskId: t.id, payload: { from: "running", to: "complete", reason: "container_gone_result_recovered_from_stdout", evidence } });
          taskChanges.push({ taskId: t.id, from: "running", to: "complete", reason: "container_gone_result_recovered_from_stdout" });
        }
      } else {
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
          logEvent("task.reconciled", { runId, taskId: t.id, payload: { from: "running", to: "failed", reason: "container_gone_no_result", evidence } });
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

  // FG-455 p2: a fanout PARENT left `running` after its children finish or die
  // mid-wave. dispatchFanoutStep never gives the parent its own container (no
  // container.started for forge-<parentId>), so the per-task loop above —
  // gated on that event — always skips it, and nothing else ever advances it
  // out of `running`. Runs AFTER the per-task loop above: any child left
  // `running` with a dead container has already been resolved into
  // complete/failed by then, so "every child terminal" below already reflects
  // each child's own containerAlive check — a non-terminal child here means
  // its container is still alive (or the wave never reached it), either way
  // signalling the wave may still be in progress.
  for (const parent of tasksForRun(runId)) {
    if (parent.status !== "running" || parent.parentId !== undefined) continue;
    const children = tasksForRun(runId).filter((c) => c.parentId === parent.id);
    if (children.length === 0) continue; // no children — an ordinary task, not a fanout parent
    if (eventsForTask(parent.id).some((e) => e.eventType === "container.started")) continue; // real containerized task
    if (children.some((c) => !TERMINAL_TASK.has(c.status))) continue; // wave may still be in progress

    const completeChildren = children.filter((c) => c.status === "complete");
    const allComplete = completeChildren.length === children.length;
    // Mirrors the aggregate dispatchFanoutStep writes at the end of a live wave
    // (runNext.ts ~1378-1392) so a downstream depends_on step can still read it
    // via deriveUpstream.
    const parentResult = {
      status: allComplete ? "complete" : "partial",
      children: children.map((c, i) => ({
        index: typeof c.taskPackage.inputs["fanoutIndex"] === "number" ? c.taskPackage.inputs["fanoutIndex"] : i,
        status: c.status,
        childTaskId: c.id,
        result: c.result,
      })),
    };

    // Best-effort disk write — never throws; a bad/missing task dir shouldn't
    // block the status transition below.
    try {
      const parentDir = taskDir(runId, parent.id);
      mkdirSync(parentDir, { recursive: true });
      writeFileSync(join(parentDir, "result.json"), JSON.stringify(parentResult));
    } catch {
      // best-effort only
    }

    if (allComplete) {
      if (markTaskComplete(parent.id, parentResult)) {
        logEvent("task.completed", { runId, taskId: parent.id });
        logEvent("task.reconciled", { runId, taskId: parent.id, payload: { from: "running", to: "complete", reason: "fanout_wave_orphaned_recovered", childSummary: { total: children.length, complete: completeChildren.length } } });
        taskChanges.push({ taskId: parent.id, from: "running", to: "complete", reason: "fanout_wave_orphaned_recovered" });
      }
    } else {
      const error =
        `fanout wave orphaned: ${completeChildren.length}/${children.length} children complete, the rest failed or never finished — ` +
        `inspect with \`forge show ${parent.id}\` and re-drive the wave with \`forge recover ${parent.id} --re-drive\`.`;
      markTaskFailed(parent.id, error, parentResult);
      logEvent("task.failed", { runId, taskId: parent.id, payload: { failure_kind: "fanout_wave_orphaned", error, childSummary: { total: children.length, complete: completeChildren.length } } });
      logEvent("task.reconciled", { runId, taskId: parent.id, payload: { from: "running", to: "failed", reason: "fanout_wave_orphaned", childSummary: { total: children.length, complete: completeChildren.length } } });
      taskChanges.push({ taskId: parent.id, from: "running", to: "failed", reason: "fanout_wave_orphaned" });
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
