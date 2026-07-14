// AWN-1: lifecycle recovery. Make active/running state trustworthy after host
// crashes, Docker races, and interrupted forge commands.
//
// Runs on lifecycle-touching commands: `forge next`, `forge status`, and
// `forge show --reconcile` (#298 made plain `forge show` read-only — a diagnostic
// must not mutate; it surfaces a reconcile candidate via the #290 read-only
// classifier and leaves the explicit reconcile to --reconcile / the lifecycle
// commands). It NEVER silently rewrites state: every change emits a
// task.reconciled / run.reconciled event alongside the normal terminal event, so
// the forge show timeline explains what changed and why. FG-463 makes that
// invariant crash-atomic: each status write and its paired audit events commit in
// one SQLite transaction, so a SQLITE_BUSY under concurrent forge processes can
// never leave a status changed without its event — the group rolls back whole and
// a later idempotent pass re-applies it. Idempotent — a second pass finds terminal
// state and no-ops.
//
// Conservative by design: a container whose liveness we cannot determine (docker
// daemon down, docker missing) is assumed alive, so we never reconcile real work
// to failed on a transient docker hiccup. And we only complete an active RUN when
// it is unambiguous there is no further work — single-step invoke runs. Multi-
// step pipelines are finalized by `forge next`, which has the workflow.

import { execFileSync, spawnSync as cpSpawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getRun } from "../store/runs.js";
import { finalizeRunIfSettled } from "./run-finalize.js";
import { tasksForRun, markTaskComplete, markTaskFailed, backfillTaskResult } from "../store/tasks.js";
import { logEvent, eventsForTask } from "../store/events.js";
import { crashPoint } from "./crash-points.js";
import { resolveIdleTimeoutMs } from "./idle-watchdog.js";
import { getDb, writeTransaction } from "../store/db.js";
import { taskDir } from "../util/paths.js";
import { cleanupStagedAuth } from "./auth-state.js";
import { removeWorktreeIfSafe } from "./worktree-lifecycle.js";
import { getManifestRuntime } from "./task-manifest.js";
import { analyzeProviderFailure } from "./provider-failure.js";
import { inferredResultFrom } from "./inferred-result.js";
import { recoverStructuredStreamResult } from "./stream-result-recovery.js";
import type { OrphanEvidence, ContainerExitInfo, ContainerCausalEvidence } from "./failure-kind.js";
import { parseDockerInspectState } from "./failure-kind.js";
import { taskHasPipelineFinalize } from "./run-kind.js";
import { isPhasePrimaryRow } from "./lifecycle-evaluator.js";
import { shouldRetainContainer } from "./docker-exec.js";
import { liveRunLockHolder } from "../util/run-lock.js";

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
    // -v: task containers no longer run --rm (FG-492), so remove the anonymous
    // node_modules shadow volume (DEC-019) with the container or it leaks.
    execFileSync("docker", ["rm", "-f", "-v", containerName], { stdio: ["ignore", "ignore", "pipe"] });
    return "killed";
  } catch (e) {
    const stderr = (e as { stderr?: Buffer }).stderr?.toString() ?? "";
    if (/no such container/i.test(stderr)) return "not_found";
    return "error"; // NOT confirmed gone — leave it, a later reconcile can retry
  }
}

export type ContainerListEntry = {
  name: string;
  running: boolean;
  // Best-effort `docker inspect` State.FinishedAt for a stopped container —
  // undefined when inspect couldn't confirm it (daemon hiccup, or the
  // container was pruned between the `ps` and `inspect` calls). The age
  // check in ops.ts falls back to the task's own completedAt when absent.
  finishedAt?: string;
};
export type ContainerLister = () => ContainerListEntry[] | undefined;

/** List every forge-<taskId> container docker actually knows about — disk
 *  truth, not event presence. FG-503: `forge ops reap-containers` used to find
 *  candidates purely from task-row/event state (a `container.started` event,
 *  optionally `container.reap_failed`), which left a completed task whose
 *  forge process died between markTaskComplete and the reap call with NO
 *  event at all — permanently invisible to the sweep, since a happy-path reap
 *  deliberately records nothing and event-absence is ambiguous. ops.ts
 *  reconciles this list against task rows instead, so candidacy depends on
 *  what's actually sitting on disk, not on which events happened to survive
 *  the crash. Returns undefined when docker itself is unreachable (daemon
 *  down, docker missing) so the caller can report that distinctly rather than
 *  silently returning zero candidates. Never throws. */
export function defaultContainerList(): ContainerListEntry[] | undefined {
  let raw: string;
  try {
    raw = execFileSync(
      "docker",
      ["ps", "-a", "--filter", "name=^forge-", "--format", "{{.Names}}\t{{.State}}"],
      { stdio: ["ignore", "pipe", "pipe"] },
    ).toString();
  } catch {
    return undefined;
  }
  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .flatMap((line) => {
      const [name, state] = line.split("\t");
      if (!name) return [];
      const entry: ContainerListEntry = { name, running: state === "running" };
      if (!entry.running) {
        // Best-effort finishedAt — a failure here just means the caller falls
        // back to the task's own completedAt for the age check.
        try {
          const inspectRaw = execFileSync("docker", ["inspect", name], { stdio: ["ignore", "pipe", "pipe"] }).toString();
          const finishedAt = parseDockerInspectState(inspectRaw).finishedAt;
          if (finishedAt) entry.finishedAt = finishedAt;
        } catch {
          // best-effort only
        }
      }
      return [entry];
    });
}

export type TaskReconcileChange = { taskId: string; from: string; to: string; reason: string };
export type ReconcileResult = {
  runId: string;
  taskChanges: TaskReconcileChange[];
  runChange?: { from: string; to: string; reason: string };
};

// FG-459: reconcileRun documents a never-throw invariant — the file/docker READ
// side already upholds it (every read safe-denies), but the DB-WRITE side did
// not. A DB-layer throw (SQLITE_BUSY when two forge processes reconcile the same
// run concurrently, disk-full, etc.) must not propagate out of reconcileRun and
// must not abort reconciliation of the run's other tasks/passes. The actual
// safety mechanism is the per-item try/catch in each pass below; this injectable
// seam mirrors the existing containerAlive/reapContainer/containerExitInfo params
// so a test can force a write to throw SQLITE_BUSY-shaped deterministically.
export type ReconcileWriters = {
  markTaskComplete: typeof markTaskComplete;
  markTaskFailed: typeof markTaskFailed;
  backfillTaskResult: typeof backfillTaskResult;
};
export const defaultReconcileWriters: ReconcileWriters = { markTaskComplete, markTaskFailed, backfillTaskResult };

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

/** FG-455 p4 / FG-492: best-effort exit-code/OOM/signal/timing probe for a
 *  container we've already confirmed is gone (see defaultContainerAlive
 *  above) — the container may still be briefly inspectable in the window
 *  between "not Running" and the daemon actually reaping it. Never throws:
 *  any docker error (daemon hiccup, "No such object" for a genuinely-gone
 *  container) or unparseable output returns `{}` — unknown, not a guess.
 *  Shares its parsing with docker-exec.ts's capture-at-close probe
 *  (parseDockerInspectState) so the two never drift on field names. */
export function defaultContainerExitInfo(name: string): ReturnType<ContainerExitInfo> {
  try {
    const out = execFileSync("docker", ["inspect", name], { stdio: ["ignore", "pipe", "pipe"] }).toString();
    return parseDockerInspectState(out);
  } catch {
    return {};
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

/** FG-461: build the OrphanEvidence tuple for an ATTACHED-EXIT missing-result
 *  failure (invoke.ts / runNext.ts), mirroring the reconcile-time evidence
 *  gathered in the container-gone branch above. The attached path already knows
 *  the exit code directly (no docker inspect needed) and that the result is
 *  absent, so it passes those in; changed files are gathered from the same
 *  never-throwing git-status probe reconcile uses. Never throws. The container
 *  has already exited here, hence containerLiveness: "gone". */
export function attachedExitEvidence(opts: {
  containerName: string;
  // The task's dedicated worktree, if it has one (task-exclusive, confident
  // evidence); undefined when it runs against the shared project dir.
  worktreePath: string | undefined;
  // The shared project dir — the fallback path probed when there's no dedicated
  // worktree. Recorded with source: "project_dir_shared" so a consumer knows the
  // diff may include the operator's own uncommitted changes.
  projectDir: string;
  exitCode?: number;
  oomKilled?: boolean;
}): OrphanEvidence {
  const pathChecked = opts.worktreePath ?? opts.projectDir;
  const source: OrphanEvidence["source"] = opts.worktreePath ? "worktree" : "project_dir_shared";
  return {
    containerName: opts.containerName,
    containerLiveness: "gone",
    resultState: "absent",
    recoverableStdoutResult: false,
    worktreePathChecked: pathChecked,
    changedFiles: changedWorktreeFiles(pathChecked),
    source,
    // FG-492: the attached path (invoke.ts / runNext.ts) called this because it
    // just watched the container's process exit itself — a confirmed exit, not
    // a disappearance discovered later. Distinct from reconcile's own
    // container-gone evidence below, which always sets this false.
    containerExitedEventObserved: true,
    ...(opts.exitCode !== undefined ? { exitCode: opts.exitCode } : {}),
    ...(opts.oomKilled !== undefined ? { oomKilled: opts.oomKilled } : {}),
  };
}

// FG-492: project reconcile's OrphanEvidence (which carries the container
// fields inline, alongside worktree/changed-files evidence) into the
// standalone ContainerCausalEvidence shape docker-exec.ts's attached-exit path
// emits, so `getContainerCausalEvidenceFromEvents` — the single reader `forge
// show`/`status`/`ops check` use — finds the SAME `containerEvidence` payload
// key regardless of which path produced it. Recorded ALONGSIDE `evidence` on
// the container-gone task.failed/task.reconciled events below, never
// replacing it — OrphanEvidence's worktree/changed-files fields have no home
// in ContainerCausalEvidence.
function toContainerCausalEvidence(evidence: OrphanEvidence): ContainerCausalEvidence {
  return {
    containerName: evidence.containerName,
    containerExitedEventObserved: evidence.containerExitedEventObserved ?? false,
    ...(evidence.exitCode !== undefined ? { dockerExitCode: evidence.exitCode } : {}),
    ...(evidence.oomKilled !== undefined ? { oomKilled: evidence.oomKilled } : {}),
    ...(evidence.dockerStateError !== undefined ? { dockerStateError: evidence.dockerStateError } : {}),
    ...(evidence.signal !== undefined ? { signal: evidence.signal } : {}),
    ...(evidence.startedAt !== undefined ? { startedAt: evidence.startedAt } : {}),
    ...(evidence.finishedAt !== undefined ? { finishedAt: evidence.finishedAt } : {}),
  };
}

// ── FG-536: the surviving idle bound for detached containers ─────────────────
// Detached execution (docker-exec.ts) means the in-process idle watchdog can
// die with its watcher process while the container lives on. Reconcile is the
// bound that survives: for a LIVE container whose last observable activity
// exceeds the task's idle budget, it kills the container — authoritative, the
// same `docker kill` the watchdog uses — and records container.idle_timeout.
// The task stays `running` that pass; the next pass finds the container gone
// and lands it through the ordinary evidence path. Unknowable activity (docker
// can't answer) enforces NOTHING — never kill on missing evidence.

/** Last-activity probe for a live container: epoch ms of its most recent log
 *  line (stdout or stderr; docker --timestamps), falling back to the
 *  container's StartedAt when it has produced no output yet — the same
 *  "silence since start counts" semantics as the in-process watchdog. */
export type ContainerIdleBound = {
  activity: (containerName: string) => number | null;
  kill: (containerName: string) => void;
};

function parseDockerLogTimestamp(line: string): number | null {
  const token = line.split(" ", 1)[0] ?? "";
  // RFC3339Nano — Date.parse only understands millisecond precision, so the
  // fractional part is truncated to three digits before parsing.
  const normalized = token.replace(/\.(\d{3})\d*(Z|[+-]\d\d:\d\d)$/, ".$1$2");
  const ms = Date.parse(normalized);
  return Number.isNaN(ms) ? null : ms;
}

export function defaultContainerActivity(containerName: string): number | null {
  try {
    const r = cpSpawnSync("docker", ["logs", "--tail", "5", "--timestamps", containerName], { encoding: "utf8" });
    if (r.status !== 0) return null;
    let latest: number | null = null;
    for (const line of `${r.stdout}\n${r.stderr}`.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const ms = parseDockerLogTimestamp(trimmed);
      if (ms !== null) latest = latest === null ? ms : Math.max(latest, ms);
    }
    if (latest !== null) return latest;
    const raw = execFileSync("docker", ["inspect", containerName], { stdio: ["ignore", "pipe", "pipe"] }).toString();
    const startedAt = parseDockerInspectState(raw).startedAt;
    const startedMs = startedAt !== undefined ? Date.parse(startedAt) : NaN;
    return Number.isNaN(startedMs) ? null : startedMs;
  } catch {
    return null;
  }
}

export const defaultIdleBound: ContainerIdleBound = {
  activity: defaultContainerActivity,
  kill: (name) => {
    try {
      execFileSync("docker", ["kill", name], { stdio: ["ignore", "ignore", "ignore"] });
    } catch { /* container may already be gone — the next pass settles it */ }
  },
};

/** FG-536: the daemon's container ID, as recorded in the task's container.started
 *  event. `forge-<taskId>` is a REUSABLE name — once the original container exits,
 *  a retry (or any other docker client) can bind it to a different container, and
 *  every by-name docker call reconcile makes would then address the replacement:
 *  probing its liveness, killing it on the idle bound, reading its exit code as
 *  the original's, reaping it. The recorded ID is the daemon's authoritative
 *  identity for THIS run of the task, so it is what reconcile addresses whenever
 *  it exists. The name stays the fallback for rows with no ID on the record
 *  (attached executor, `docker run -d` output unparseable, pre-FG-536 rows). */
function recordedContainerId(taskEvents: { eventType: string; payload: unknown }[]): string | undefined {
  for (const e of taskEvents) {
    if (e.eventType !== "container.started") continue;
    const id = (e.payload as { containerId?: unknown } | null)?.containerId;
    if (typeof id === "string" && id !== "") return id;
  }
  return undefined;
}

/** The task's idle budget, from its manifest (written at dispatch) — the same
 *  resolution `forge show`'s countdown uses. */
function manifestIdleTimeoutMs(taskDirPath: string): number | undefined {
  try {
    const raw = readFileSync(join(taskDirPath, "manifest.json"), "utf8");
    const v = (JSON.parse(raw) as { container?: { idleTimeoutMs?: unknown } }).container?.idleTimeoutMs;
    return typeof v === "number" ? v : undefined;
  } catch {
    return undefined;
  }
}

/** Reconcile a single run's task + run state against reality. Returns what (if
 *  anything) changed. */
export function reconcileRun(
  runId: string,
  containerAlive: ContainerAlive = defaultContainerAlive,
  reapContainer: ContainerReap = defaultContainerReap,
  containerExitInfo: ContainerExitInfo = defaultContainerExitInfo,
  writers: ReconcileWriters = defaultReconcileWriters,
  idleBound: ContainerIdleBound = defaultIdleBound,
): ReconcileResult {
  const { markTaskComplete, markTaskFailed, backfillTaskResult } = writers;
  const run = getRun(runId);
  const taskChanges: TaskReconcileChange[] = [];
  if (!run) return { runId, taskChanges };

  // FG-479: "container gone + usable result ⇒ complete" is only sound for
  // single-step invoke runs, where completion IS the end of the task's
  // lifecycle. In a pipeline the task stays `running` through the entire
  // post-container host-side sequence (persistence check → worktree merge →
  // integration gate → reds → finalizePrimary, runNext.ts dispatchSingleStep),
  // so a valid result.json proves only that the AGENT finished — none of the
  // trust gates have run. Completing it here would skip reds, verdict/human
  // gates, and (in worktree mode) the merge-back. FG-486: `invoke_chain` runs
  // (campaign quick lanes) dispatch plain invokes with no finalize either, so
  // their tasks complete the same way — run-kind.ts owns the one definition.
  const isInvokeLikeRun = !taskHasPipelineFinalize(run);

  // FG-479: the fail-safe landing for a pipeline task whose container finished
  // with a usable result but whose host-side finalize never ran. Preserves the
  // result (task row + disk) as evidence and points the operator at the real
  // re-drive path. `forge recover --continue` deliberately refuses this kind —
  // adopting the result as complete would recreate the exact bypass.
  // FG-481: recover.ts consumes the same predicate to unconditionally refuse
  // `--continue` for a pipeline-run task. The persisted error text below
  // must not recommend a command that recovery will then refuse.
  const workMayPersistAdvice = (taskId: string) =>
    isInvokeLikeRun ? `continue from it or \`forge retry ${taskId} --force\`` : `\`forge retry ${taskId} --force\``;

  const failPipelineUnfinalized = (taskId: string, result: unknown, evidence: OrphanEvidence, streamLogFormat?: string | null) => {
    const error =
      "orphaned_needs_finalize: container finished with a usable result, but the forge process died before this pipeline step's host-side finalize (worktree merge → integration gate → reds → gates) could run — the step cannot be trusted complete. " +
      `The result is preserved (result.json + this task's row); inspect with \`forge show ${taskId}\`, then re-dispatch through the real finalize path with \`forge retry ${taskId} --force\`.`;
    const containerEvidence = toContainerCausalEvidence(evidence);
    crashPoint("reconcile:before-fail-pipeline-unfinalized");
    writeTransaction(() => { // FG-463: fail write + its events atomic
      markTaskFailed(taskId, error, result);
      crashPoint("reconcile:inside-fail-pipeline-unfinalized-txn");
      logEvent("task.failed", { runId, taskId, payload: { failure_kind: "orphaned_needs_finalize", error, evidence, containerEvidence } });
      logEvent("task.reconciled", { runId, taskId, payload: { from: "running", to: "failed", reason: "container_gone_pipeline_unfinalized", evidence, containerEvidence } });
      // FG-540 provenance: the preserved result came from the structured stream.
      // Inside the same transaction as the fail write — the landing is terminal and
      // reconcile only revisits `running` tasks, so an event appended after the commit
      // would be lost for good if the process died in between.
      if (streamLogFormat !== undefined) {
        logEvent("task.result_recovered_from_stream", { runId, taskId, payload: { source: "reconcile_pipeline_unfinalized", logFormat: streamLogFormat } });
      }
    });
    taskChanges.push({ taskId, from: "running", to: "failed", reason: "container_gone_pipeline_unfinalized" });
  };

  for (const t of tasksForRun(runId)) {
    if (t.status !== "running") continue;
    // FG-459: never-throw guard. A DB-write throw (markTaskComplete/Failed,
    // backfillTaskResult, or the logEvent bookkeeping alongside them) during
    // ONE task's reconcile must neither propagate out of reconcileRun nor abort
    // the remaining tasks/passes. Swallow-and-continue mirrors the file's
    // read-side safe-deny; reconcile is idempotent, so a later pass retries.
    // FG-463: each (status write + its paired audit events) group below is wrapped
    // in a single getDb().transaction(...)() so it commits all-or-nothing — a
    // SQLITE_BUSY on the SECOND statement can no longer leave the status changed
    // without its task.reconciled/terminal event. The rollback throw surfaces here
    // and is swallowed; the whole group is re-applied cleanly on a later pass (a
    // rolled-back attempt inserts nothing, so no duplicate events). Filesystem work
    // (result.json, staged-auth, worktree cleanup) stays OUTSIDE every transaction.
    try {
    const taskEvents = eventsForTask(t.id);
    const hasContainerStarted = taskEvents.some((e) => e.eventType === "container.started");
    // The task's container NAME (what forge asked docker for) and the docker
    // ADDRESS reconcile actually uses (the recorded daemon ID when there is one
    // — see recordedContainerId). Evidence keeps reporting the name; every
    // docker call — liveness, activity, kill, exit info, reap — goes to the ref.
    const containerName = `forge-${t.id}`;
    const containerRef = recordedContainerId(taskEvents) ?? containerName;
    // FG-492 review (final round): hasContainerExited CAN be true here — it is
    // not just a defensive placeholder. Forge can log container.exited (or
    // .idle_timeout / .dependency_provisioning_failed) and then crash BEFORE
    // the markTaskComplete/failTask write that would move the task off
    // `running`; the next reconcile pass then finds a `running` task whose
    // event history already contains a real exit event. Recording this
    // explicitly — instead of inferring "no" from reaching this branch at all
    // — is what lets `forge show`/`status`/`ops check` distinguish "container
    // disappeared without terminal evidence" from a confirmed exit forge
    // itself already witnessed before crashing on the write.
    const hasContainerExited = taskEvents.some(
      (e) =>
        e.eventType === "container.exited" ||
        e.eventType === "container.idle_timeout" ||
        e.eventType === "container.dependency_provisioning_failed",
    );

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
    // Gate this branch to the genuine in/mid-provisioning window: after
    // provision_started but BEFORE provision_succeeded. Once
    // container.provision_succeeded has fired, the provisioner has already
    // --rm-removed itself and the task is legitimately mid-dispatch, waiting
    // on the agent container to start — a HEALTHY task, not a crash. Without
    // this check that window would be misclassified as a provisioning crash
    // and false-failed. A task that already succeeded provisioning falls
    // through to the existing container.started gate/logic below, unchanged.
    const hasProvisionSucceeded = taskEvents.some((e) => e.eventType === "container.provision_succeeded");
    if (!hasContainerStarted && !hasProvisionSucceeded) {
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
          // FG-463: status write + its paired audit events commit atomically. A
          // SQLITE_BUSY on any statement rolls the whole group back (the FG-459
          // outer catch swallows the throw; a later idempotent pass re-applies it).
          crashPoint("reconcile:before-fail-provisioning-phase-crash");
          writeTransaction(() => {
            markTaskFailed(t.id, error);
            crashPoint("reconcile:inside-fail-provisioning-phase-crash-txn");
            logEvent("task.failed", { runId, taskId: t.id, payload: { failure_kind: "verification_environment_unavailable", error, evidence } });
            logEvent("task.reconciled", { runId, taskId: t.id, payload: { from: "running", to: "failed", reason: "provisioning_phase_crash", evidence } });
          });
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
    if (!hasContainerStarted) {
      // FG-536 (review): the daemon-start-to-callback window. `docker run -d`
      // creates the container under the daemon and the container.started append
      // happens only once the client returns — a CLI kill in between leaves a
      // `running` row with no start event while the container runs on, writes
      // /task/result.json through its bind mount, and exits. For an INVOKE row
      // the FG-533 sweep below is deliberately inert (dispatchSource gate 1), so
      // without this the row would strand `running` forever even though its real
      // result is sitting on disk. A result.json is proof the agent ran: land it
      // through the ordinary container-gone evidence path below (which re-checks
      // liveness first, so a container still writing is left alone). Absent a
      // result there is nothing to finalize — an invoke row stays exempt from
      // the sweep, exactly as FG-536's scope note says.
      const invokeResultOnDisk =
        t.taskPackage.dispatchSource === "invoke" && readResult(t.runId, t.id) !== undefined;
      if (!invokeResultOnDisk) {
      // FG-533: the pre-container crash window. runContainer marks the task
      // `running` and logs task.started BEFORE the container launches; the span
      // that follows (image pull, auth staging, dependency provisioning) is
      // minutes long. A crash inside it leaves a `running` row with no
      // container.started — invisible to the container-gone sweep below, never
      // re-admitted by the ready queue, and refused by `forge retry` (not
      // failed). Sweep it here, gated four ways so the host-side exemption this
      // comment defends stays intact:
      //   1. dispatchSource === "workflow" only (FG-512 provenance, total for
      //      new rows). Session/design/legacy rows are marker-less and invoke
      //      rows are "invoke" — all exempt from being FAILED here. Invoke
      //      survivability is FG-536's scope, by construction rather than by
      //      sweep; an invoke row with a real result on disk is finalized by the
      //      branch above instead, never failed by this one.
      //   2. agentRole !== "manual": runner-minted manual steps carry the
      //      "workflow" marker but run host-side, never containerized.
      //   3. No live agent container, AND no result.json on disk. Together these
      //      cover the whole sub-window where docker started the container but
      //      the process died before the container.started append: while it is
      //      alive the liveness probe holds it; once it EXITS, liveness says
      //      "gone" and only the result proves the agent ran. Either way the
      //      work is real, so the row falls through to the ordinary
      //      container-gone evidence path below (complete for an invoke-like
      //      run, orphaned_needs_finalize for a pipeline step) rather than
      //      being false-failed as "no work exists to lose".
      //   4. No children: a fanout PARENT runs `running` with no container of
      //      its own for the whole wave — the FG-455-p2 pass below and the
      //      FG-531 sweep own parent recovery, and a parent is never "pre-
      //      container" (it has no container to be pre- of). Same shape test
      //      the FG-455-p2 pass uses.
      //   5. No live run-lock holder of ANY age (staleMs: MAX_SAFE_INTEGER —
      //      deliberately stricter than the FG-531 sweep's default). The
      //      awaiting_red sweep has a second liveness signal (live red
      //      containers); here the lock is the ONLY one, and the pre-container
      //      span can legitimately run long (cold image pull) under a lock
      //      acquired much earlier, so a LIVE holder must block the sweep no
      //      matter how old. Dead holders return null regardless of age, so a
      //      genuine crash is still swept on the next pass.
      // The FG-437 mid-provisioning branch above runs FIRST and keeps owning
      // its sub-window (live provisioner → skip; dead provisioner → its own
      // landing); everything else in the pre-container span lands here.
      const preContainerSweepable =
        t.taskPackage.dispatchSource === "workflow" &&
        t.agentRole !== "manual" &&
        !tasksForRun(runId).some((c) => c.parentId === t.id) &&
        !containerAlive(containerRef) &&
        liveRunLockHolder(runId, { staleMs: Number.MAX_SAFE_INTEGER }) === null;
      if (!preContainerSweepable) continue;

      // The container may have launched, run, and EXITED before the
      // container.started append — the liveness probe above only holds that row
      // while the container is still alive. A result.json is proof the agent
      // ran, so this is an event-lost completion, not a pre-container crash:
      // fall through to the container-gone evidence path below, which preserves
      // or finalizes it exactly as it would with the event present.
      if (readResult(t.runId, t.id) === undefined) {
        const error =
          "pre_container_crash: the forge process died in the pre-container window — the task was marked running, but its " +
          "agent container never launched (the span covers image pull, auth staging, and dependency provisioning), so no " +
          `work exists to lose. Re-dispatch with \`forge retry ${t.id}\`.`;
        const evidence = {
          dispatchSource: "workflow" as const,
          expectedContainer: containerName,
          containerStarted: false,
          reason: error,
        };
        // FG-463: status write + its paired audit events commit atomically. A
        // SQLITE_BUSY on any statement rolls the whole group back (the FG-459
        // outer catch swallows the throw; a later idempotent pass re-applies it).
        crashPoint("reconcile:before-fail-pre-container-crash");
        writeTransaction(() => {
          markTaskFailed(t.id, error);
          crashPoint("reconcile:inside-fail-pre-container-crash-txn");
          logEvent("task.failed", { runId, taskId: t.id, payload: { failure_kind: "pre_container_crash", error, evidence } });
          logEvent("task.reconciled", { runId, taskId: t.id, payload: { from: "running", to: "failed", reason: "pre_container_crash", evidence } });
        });
        taskChanges.push({ taskId: t.id, from: "running", to: "failed", reason: "pre_container_crash" });

        // AWN-8: same terminal cleanup as the FG-437 landing above. The
        // worktree call passes provenMerged=false, so outside EPHEMERAL mode it
        // is a no-op — a pre-container tree holds no agent work, but discarding
        // is never reconcile's call (invariant 4).
        cleanupStagedAuth(taskDir(t.runId, t.id));
        if (t.worktreePath && run.projectDir) {
          removeWorktreeIfSafe(t.worktreePath, t.runId, t.id, run.projectDir);
        }
        continue;
      }
      }
    }
    if (containerAlive(containerRef)) {
      // FG-536: the surviving idle bound (see defaultIdleBound above). A live
      // container past its idle budget is killed here — the same authoritative
      // `docker kill` the in-process watchdog uses — and the NEXT pass lands
      // the task through the ordinary container-gone evidence path. No status
      // is written this pass, and unknowable activity enforces nothing.
      try {
        const last = idleBound.activity(containerRef);
        if (last !== null) {
          const idleMs = manifestIdleTimeoutMs(taskDir(t.runId, t.id)) ?? resolveIdleTimeoutMs();
          if (idleMs > 0 && Date.now() - last > idleMs) {
            idleBound.kill(containerRef);
            logEvent("container.idle_timeout", {
              runId,
              taskId: t.id,
              payload: { source: "reconcile_idle_bound", containerName, containerRef, lastActivityAt: new Date(last).toISOString(), idleTimeoutMs: idleMs, reason: "no container output within the idle budget and no live in-process watchdog to enforce it (FG-536 detached execution)" },
            });
          }
        }
      } catch { /* FG-459 posture: the idle bound must never abort the pass */ }
      continue; // genuinely still running (or just killed — next pass settles it)
    }

    // Container is gone. If it left a usable result, finalize as complete (the
    // work finished but the DB write was lost); otherwise it was orphaned.
    const result = readResult(t.runId, t.id);

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
    // FG-455 p4: gathered once alongside the rest of the container-gone evidence
    // tuple — never throws (see defaultContainerExitInfo), so a daemon hiccup
    // just yields {} (unknown), same as today's behavior.
    let exitInfo: ReturnType<ContainerExitInfo>;
    try {
      exitInfo = containerExitInfo(containerRef);
    } catch {
      exitInfo = {};
    }
    const baseEvidence = {
      containerName,
      containerLiveness: "gone" as const,
      worktreePathChecked: worktreePathChecked ?? null,
      changedFiles,
      source,
      exitCode: exitInfo.exitCode,
      oomKilled: exitInfo.oomKilled,
      // FG-492: architecturally separate from exitCode/oomKilled above — this
      // records what FORGE observed (nothing — no prior container.exited event),
      // never collapsed with what docker inspect currently reports. The two can
      // legitimately disagree (docker still has exit info even though Forge
      // never saw the event), and that disagreement is itself diagnostic.
      containerExitedEventObserved: hasContainerExited,
      dockerStateError: exitInfo.dockerStateError,
      signal: exitInfo.signal,
      startedAt: exitInfo.startedAt,
      finishedAt: exitInfo.finishedAt,
    };

    // FG-492 review: whether the retained/stopped container reconcile just
    // observed is safe to reap — set true ONLY in the two branches below where
    // the task is actually finalized to `complete` (a genuinely investigated,
    // uninteresting outcome). Every other branch (orphaned_needs_finalize,
    // oom_killed, orphaned_work_may_persist, orphaned, or a lost CAS race)
    // leaves this false, so the reap check below retains it.
    let taskCompletedSuccessfully = false;

    if (result !== undefined) {
      // FG-455 p1 review: the valid-result outcome is one of the four
      // container-gone outcomes — it must carry the same durable evidence
      // tuple as the other three, not just an empty payload.
      const evidence: OrphanEvidence = { ...baseEvidence, resultState: "valid", recoverableStdoutResult: false };
      if (!isInvokeLikeRun) {
        // FG-479: pipeline task — the agent finished but merge/gate/reds never
        // ran. Never complete it here; land fail-safe with the result preserved.
        failPipelineUnfinalized(t.id, result, evidence);
      } else {
        // FG-463: the complete write + its paired events commit atomically. The
        // markTaskComplete no-op (already complete concurrently) rolls back to
        // nothing logged. A SQLITE_BUSY rolls the whole group back for a later pass.
        const containerEvidence = toContainerCausalEvidence(evidence);
        crashPoint("reconcile:before-complete-invoke-like");
        const completed = writeTransaction(() => {
          if (!markTaskComplete(t.id, result)) return false;
          crashPoint("reconcile:inside-complete-invoke-like-txn");
          logEvent("task.completed", { runId, taskId: t.id });
          logEvent("task.reconciled", { runId, taskId: t.id, payload: { from: "running", to: "complete", reason: "container_gone_result_present", evidence, containerEvidence } });
          return true;
        });
        if (completed) taskChanges.push({ taskId: t.id, from: "running", to: "complete", reason: "container_gone_result_present" });
        taskCompletedSuccessfully = completed;
      }
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
      let inferred: unknown;
      // FG-540 provenance: which recovery produced the result — the event
      // consumers (below) record structured recovery distinctly from FG-337
      // narrative synthesis, mirroring recover --continue's adoptedFrom.
      let recoveredSource: "structured_stream" | "stdout_inferred" | undefined;
      let recoveredLogFormat: string | undefined;
      try {
        const runtimeMeta = getManifestRuntime(dir);
        const stdoutRaw = readStdoutLog(t.runId, t.id);
        const analysis = analyzeProviderFailure({
          logFormat: runtimeMeta?.logFormat,
          runtimeKind: runtimeMeta?.kind,
          stdoutRaw,
        });
        // FG-540: structured recovery first — the same shared extraction rule
        // as the dispatch-time paths (invoke.ts/runNext.ts), so watcher loss
        // cannot change the result contract. Structured recovery is gated on
        // no CONTRARY exit evidence (a known non-zero exit or OOM refuses; an
        // unknown exit defers to the stream's own turn.completed proof), and
        // ALL stdout recovery — structured or FG-337 narrative — refuses when
        // the on-disk result.json is non-empty (malformed): that file is
        // evidence, it wins as a failure, and it is never overwritten.
        const fileMalformed = resultFileState(t.runId, t.id) === "malformed";
        const noContraryExit = exitInfo.oomKilled !== true && (exitInfo.exitCode === undefined || exitInfo.exitCode === 0);
        const structured = !fileMalformed && noContraryExit && !analysis.modelError
          ? recoverStructuredStreamResult({ logFormat: runtimeMeta?.logFormat, runtimeKind: runtimeMeta?.kind, stdoutRaw })
          : undefined;
        inferred = structured ?? (fileMalformed ? undefined : inferredResultFrom(analysis, t.agentRole));
        recoveredSource = structured !== undefined ? "structured_stream" : inferred !== undefined ? "stdout_inferred" : undefined;
        recoveredLogFormat = runtimeMeta?.logFormat ?? runtimeMeta?.kind;
      } catch {
        inferred = undefined;
        recoveredSource = undefined;
      }

      // FG-540 review: persist BEFORE the completion decision. A structured
      // stream recovery stands in for the agent's OWN result.json — the
      // dispatch-time path (invoke.ts) persists it and only then completes, so
      // reconcile must not complete a structured recovery it could not persist.
      // A failed write voids that recovery: the task falls through to the
      // ordinary oom/worktree-dirty/orphaned classification below, with the
      // write failure carried in evidence. FG-337 narrative synthesis stays
      // best-effort (FG-455 finding 1) — it is a summary of a dead run, not the
      // agent's result contract, so it still completes from memory.
      let resultWriteFailed = false;
      if (inferred !== undefined) {
        try {
          writeFileSync(join(dir, "result.json"), JSON.stringify(inferred));
        } catch {
          resultWriteFailed = true;
          if (recoveredSource === "structured_stream") {
            inferred = undefined;
            recoveredSource = undefined;
          }
        }
      }

      // Reuse baseEvidence gathered above the split — only resultState and
      // recoverableStdoutResult vary per outcome.
      const evidence: OrphanEvidence = {
        ...baseEvidence,
        resultState: resultFileState(t.runId, t.id),
        recoverableStdoutResult: inferred !== undefined,
        ...(resultWriteFailed ? { resultWriteFailed: true } : {}),
      };

      if (inferred) {
        if (!isInvokeLikeRun) {
          // FG-479: same guard as the valid-result branch above — a recovered
          // stdout result proves the agent finished, not that the pipeline's
          // host-side finalize ran.
          failPipelineUnfinalized(t.id, inferred, evidence, recoveredSource === "structured_stream" ? (recoveredLogFormat ?? null) : undefined);
        } else {
          // FG-463: complete write + its events atomic (the result.json write above
          // stays OUTSIDE the transaction — never hold a write lock across disk IO).
          const containerEvidence = toContainerCausalEvidence(evidence);
          crashPoint("reconcile:before-complete-invoke-like-from-stdout");
          const completed = writeTransaction(() => {
            if (!markTaskComplete(t.id, inferred)) return false;
            crashPoint("reconcile:inside-complete-invoke-like-from-stdout-txn");
            logEvent("task.completed", { runId, taskId: t.id });
            logEvent("task.reconciled", { runId, taskId: t.id, payload: { from: "running", to: "complete", reason: "container_gone_result_recovered_from_stdout", evidence, containerEvidence } });
            // FG-540 provenance: distinguish structured stream recovery from
            // FG-337 narrative synthesis, mirroring the dispatch paths and
            // recover --continue's adoptedFrom vocabulary.
            if (recoveredSource === "structured_stream") {
              logEvent("task.result_recovered_from_stream", { runId, taskId: t.id, payload: { source: "reconcile", logFormat: recoveredLogFormat ?? null } });
            }
            return true;
          });
          if (completed) taskChanges.push({ taskId: t.id, from: "running", to: "complete", reason: "container_gone_result_recovered_from_stdout" });
          taskCompletedSuccessfully = completed;
        }
      } else if (exitInfo.oomKilled === true || exitInfo.exitCode === 137) {
        // FG-455 p4: a positively-identified OOM/SIGKILL death is a distinct,
        // more specific cause than the generic orphaned/orphaned_work_may_persist
        // — takes precedence over both, even when the worktree is dirty (the
        // "work may have persisted" guidance still applies in that case).
        const error =
          `oom_killed: container was killed (${exitInfo.oomKilled ? "OOM" : `exit ${exitInfo.exitCode}`}) with no recoverable result` +
          (changedFiles.length > 0
            ? ` — ${changedFiles.length} changed file(s) found at ${worktreePathChecked} — ` +
              (source === "project_dir_shared"
                ? "in the SHARED project directory (no dedicated worktree for this task) — this may include unrelated uncommitted changes, evidence to inspect, not proof of task work. "
                : "") +
              `work may have persisted. Inspect the diff, verify it, then ${workMayPersistAdvice(t.id)}.`
            : " (reconciled after crash)");
        const containerEvidence = toContainerCausalEvidence(evidence);
        crashPoint("reconcile:before-fail-oom-killed");
        writeTransaction(() => { // FG-463: fail write + its events atomic
          markTaskFailed(t.id, error);
          crashPoint("reconcile:inside-fail-oom-killed-txn");
          logEvent("task.failed", { runId, taskId: t.id, payload: { failure_kind: "oom_killed", error, evidence, containerEvidence } });
          logEvent("task.reconciled", { runId, taskId: t.id, payload: { from: "running", to: "failed", reason: "container_oom_killed", evidence, containerEvidence } });
        });
        taskChanges.push({ taskId: t.id, from: "running", to: "failed", reason: "container_oom_killed" });
      } else if (changedFiles.length > 0) {
        const error =
          `orphaned_work_may_persist: container gone with no recoverable result, but ${changedFiles.length} changed file(s) found at ${worktreePathChecked} — ` +
          (source === "project_dir_shared"
            ? "in the SHARED project directory (no dedicated worktree for this task) — this may include unrelated uncommitted changes, evidence to inspect, not proof of task work. "
            : "") +
          `work may have persisted. Inspect the diff, verify it, then ${workMayPersistAdvice(t.id)}.`;
        const containerEvidence = toContainerCausalEvidence(evidence);
        crashPoint("reconcile:before-fail-orphaned-work-may-persist");
        writeTransaction(() => { // FG-463: fail write + its events atomic
          markTaskFailed(t.id, error);
          crashPoint("reconcile:inside-fail-orphaned-work-may-persist-txn");
          logEvent("task.failed", { runId, taskId: t.id, payload: { failure_kind: "orphaned_work_may_persist", error, evidence, containerEvidence } });
          logEvent("task.reconciled", { runId, taskId: t.id, payload: { from: "running", to: "failed", reason: "container_gone_worktree_dirty", evidence, containerEvidence } });
        });
        taskChanges.push({ taskId: t.id, from: "running", to: "failed", reason: "container_gone_worktree_dirty" });
      } else {
        const error = "orphaned: container gone with no result (reconciled after crash)";
        const containerEvidence = toContainerCausalEvidence(evidence);
        crashPoint("reconcile:before-fail-orphaned-no-result");
        writeTransaction(() => { // FG-463: fail write + its events atomic
          markTaskFailed(t.id, error);
          crashPoint("reconcile:inside-fail-orphaned-no-result-txn");
          logEvent("task.failed", { runId, taskId: t.id, payload: { failure_kind: "orphaned", error, containerEvidence } });
          logEvent("task.reconciled", { runId, taskId: t.id, payload: { from: "running", to: "failed", reason: "container_gone_no_result", evidence, containerEvidence } });
        });
        taskChanges.push({ taskId: t.id, from: "running", to: "failed", reason: "container_gone_no_result" });
      }
    }

    // FG-492 finding 3 (review): a container reconcile finds already gone (or
    // stopped-but-retained) leaks permanently if the forge process dies before
    // invoke.ts/runNext.ts's own reap-vs-retain decision can run — reconcile is
    // the only other place that ever observes it, and (pre-FG-503) `forge ops
    // reap-containers` only ever scanned FAILED tasks, so a task reconcile
    // finalizes to COMPLETE here (container_gone_result_present /
    // container_gone_result_recovered_from_stdout above) would otherwise never
    // be swept. FG-503 made reap-containers disk-truth-driven, covering
    // COMPLETE tasks too, but this reap-at-reconcile-time path still stands —
    // it reaps immediately instead of waiting on the next sweep. The decision
    // now mirrors
    // docker-exec.ts's shouldRetainContainer exactly, but keyed on the TASK
    // outcome reconcile itself just decided (taskCompletedSuccessfully), not on
    // the container's raw exit code — a clean exit (0) that reconcile still
    // failed (orphaned_needs_finalize, oom_killed, orphaned_work_may_persist,
    // orphaned, or a lost CAS race) must stay retained; reaping it just because
    // the exit code was 0 would destroy the evidence at the exact moment it's
    // worth investigating. Best-effort, never throws, never blocks the
    // reconcile pass on a daemon hiccup.
    // FG-503 (review): a reap failure here is the same silent, unsweepable
    // leak invoke.ts/runNext.ts/gate.ts already guard against on their own
    // success paths — record it the same way so ops.ts's completed-task
    // `container.reap_failed` scan picks up a reconcile-path leak too.
    if (!shouldRetainContainer(taskCompletedSuccessfully)) {
      let reapOutcome: ContainerReapResult;
      try {
        // Addressed by the recorded daemon ID when there is one: `docker rm -f`
        // by NAME would destroy whatever container holds the name now, which
        // after a retry is not the one this task ran.
        reapOutcome = reapContainer(containerRef);
      } catch {
        // best-effort — a later reconcile pass or `forge ops reap-containers` can retry
        reapOutcome = "error";
      }
      if (reapOutcome === "error") {
        try {
          logEvent("container.reap_failed", {
            runId,
            taskId: t.id,
            payload: { containerName, why: "docker rm -f -v failed after task completion; container may still be running/present with its anonymous shadow volume" },
          });
        } catch {
          // best-effort — a logging failure must never block the reconcile pass
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
    } catch { /* FG-459: DB write (or its bookkeeping) threw — skip this task, keep reconciling the rest */ }
  }

  // FG-455 p4 Mode A: a detached `forge invoke` whose wrapper was killed can
  // leave a task `complete` in the DB but with an EMPTY result — the
  // structured result was lost before it could be written back. The per-task
  // loop above only ever revisits `running` tasks, so a `complete` task like
  // this is never backfilled. Separate pass, gated on status === 'complete' so
  // it never interacts with the running-task recovery above; idempotent — a
  // task that already carries a non-empty result is left untouched.
  for (const t of tasksForRun(runId)) {
    if (t.status !== "complete") continue;
    if (t.result !== undefined) continue; // already has a result — nothing to backfill

    // Best-effort recovery, same precedence as the running-orphan path above:
    // 1. result.json may have been written after the DB row was marked complete.
    // 2. else recover the structured stream (FG-540), else synthesize from
    //    stdout (FG-337), same as the running-orphan path.
    // Any error here safe-denies to "nothing recovered" — never throws.
    let recovered: unknown;
    let backfillSource: "structured_stream" | undefined;
    let backfillLogFormat: string | undefined;
    try {
      const onDisk = readResult(t.runId, t.id);
      if (onDisk !== undefined) {
        recovered = onDisk;
      } else {
        const dir = taskDir(t.runId, t.id);
        const runtimeMeta = getManifestRuntime(dir);
        const stdoutRaw = readStdoutLog(t.runId, t.id);
        const analysis = analyzeProviderFailure({
          logFormat: runtimeMeta?.logFormat,
          runtimeKind: runtimeMeta?.kind,
          stdoutRaw,
        });
        // FG-540: structured recovery first (shared rule with the dispatch-time
        // paths), under the SAME no-contrary-exit guard as the running-orphan
        // branch: a known non-zero/OOM container exit refuses recovery even
        // though the DB row says complete (the row is exactly what Mode A
        // distrusts); an unknown exit defers to the stream's own turn.completed.
        // A non-empty malformed result.json refuses rather than be overwritten.
        let exitInfo: ReturnType<ContainerExitInfo>;
        try {
          exitInfo = containerExitInfo(recordedContainerId(eventsForTask(t.id)) ?? `forge-${t.id}`);
        } catch {
          exitInfo = {};
        }
        // FG-540 final pass: the malformed-file refusal gates ALL stdout
        // recovery here too — a non-empty result.json is never overwritten by
        // a backfill, structured or narrative.
        const fileMalformed = resultFileState(t.runId, t.id) === "malformed";
        const noContraryExit = exitInfo.oomKilled !== true && (exitInfo.exitCode === undefined || exitInfo.exitCode === 0);
        const structured = !fileMalformed && noContraryExit && !analysis.modelError
          ? recoverStructuredStreamResult({ logFormat: runtimeMeta?.logFormat, runtimeKind: runtimeMeta?.kind, stdoutRaw })
          : undefined;
        recovered = structured ?? (fileMalformed ? undefined : inferredResultFrom(analysis, t.agentRole));
        if (structured !== undefined) {
          backfillSource = "structured_stream";
          backfillLogFormat = runtimeMeta?.logFormat ?? runtimeMeta?.kind;
        }
      }
    } catch {
      recovered = undefined;
    }

    if (recovered === undefined) continue; // nothing recoverable — leave the complete task alone

    // FG-459: guard the backfill write + its event so a SQLITE_BUSY throw here
    // neither propagates nor aborts the remaining tasks/passes.
    try {
      // FG-463: the backfill (result write) + its reconciled event commit
      // atomically. The best-effort result.json disk write stays OUTSIDE the
      // transaction (never hold a write lock across disk IO), but its outcome
      // feeds the event's evidence, so it runs first. Writing it is idempotent —
      // `recovered` is the same source another concurrent backfiller would use —
      // so a subsequent no-op backfill (line below) simply doesn't log an event.
      const evidence: Record<string, unknown> = { recovered: true };
      try {
        writeFileSync(join(taskDir(t.runId, t.id), "result.json"), JSON.stringify(recovered));
      } catch {
        evidence.resultWriteFailed = true;
        // FG-540 (d82e136 rule, applied at this sibling too): a structured
        // stream recovery may not land ANYWHERE it could not be persisted —
        // no DB backfill, no reconciled event, no provenance event. The task
        // keeps its empty result untouched. On-disk and FG-337 narrative
        // backfills keep their existing best-effort behavior.
        if (backfillSource === "structured_stream") continue;
      }
      crashPoint("reconcile:before-backfill-complete-empty-result");
      const backfilled = writeTransaction(() => {
        if (!backfillTaskResult(t.id, recovered)) return false; // result written concurrently since our read — no-op
        crashPoint("reconcile:inside-backfill-complete-empty-result-txn");
        logEvent("task.reconciled", { runId, taskId: t.id, payload: { from: "complete", to: "complete", reason: "complete_empty_result_backfilled", evidence } });
        // FG-540 provenance: a structured-stream backfill is recorded
        // distinctly from an on-disk read or FG-337 narrative synthesis.
        if (backfillSource === "structured_stream") {
          logEvent("task.result_recovered_from_stream", { runId, taskId: t.id, payload: { source: "reconcile_backfill", logFormat: backfillLogFormat ?? null } });
        }
        return true;
      });
      if (backfilled) taskChanges.push({ taskId: t.id, from: "complete", to: "complete", reason: "complete_empty_result_backfilled" });
    } catch { /* FG-459: never throw — keep reconciling the rest */ }
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

    // FG-459: guard the parent-finalization writes (markTaskComplete/Failed +
    // events) so a DB throw here neither propagates nor aborts the run-level
    // completion check that follows.
    try {
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
      // FG-479 review finding 4: all children finished, but that only proves the
      // WAVE finished — the parent's own host-side finalize (integration merge
      // → post-merge gate → reds, runNext.ts dispatchFanoutStep ~1446-1590) never
      // ran, because dispatchFanoutStep never gave the parent a container to
      // crash out of (see the container.started gate above). Completing the
      // parent purely from child aggregation would silently skip that whole
      // sequence — the exact single-step bypass this ticket fixed for a PIPELINE
      // primary (failPipelineUnfinalized above), just on the fanout-parent
      // lifecycle. Land fail-safe instead: reuse fanout_wave_orphaned (same
      // recover --re-drive path already re-drives the whole wave coherently;
      // retryPolicy/recover.ts already refuse a bare `forge retry` for it) with
      // a distinct message so an operator isn't told children "failed or never
      // finished" when in fact every one of them succeeded.
      const error =
        `fanout parent unfinalized: all ${children.length} children completed, but the parent's own merge/integration-gate/reds sequence never ran ` +
        `(the process died before it started) — inspect with \`forge show ${parent.id}\` and re-drive the wave with \`forge recover ${parent.id} --re-drive\`.`;
      crashPoint("reconcile:before-fail-fanout-parent-unfinalized");
      writeTransaction(() => { // FG-463: fail write + its events atomic
        markTaskFailed(parent.id, error, parentResult);
        crashPoint("reconcile:inside-fail-fanout-parent-unfinalized-txn");
        logEvent("task.failed", { runId, taskId: parent.id, payload: { failure_kind: "fanout_wave_orphaned", error, childSummary: { total: children.length, complete: completeChildren.length } } });
        logEvent("task.reconciled", { runId, taskId: parent.id, payload: { from: "running", to: "failed", reason: "fanout_wave_unfinalized", childSummary: { total: children.length, complete: completeChildren.length } } });
      });
      taskChanges.push({ taskId: parent.id, from: "running", to: "failed", reason: "fanout_wave_unfinalized" });
    } else {
      const error =
        `fanout wave orphaned: ${completeChildren.length}/${children.length} children complete, the rest failed or never finished — ` +
        `inspect with \`forge show ${parent.id}\` and re-drive the wave with \`forge recover ${parent.id} --re-drive\`.`;
      crashPoint("reconcile:before-fail-fanout-wave-orphaned");
      writeTransaction(() => { // FG-463: fail write + its events atomic
        markTaskFailed(parent.id, error, parentResult);
        crashPoint("reconcile:inside-fail-fanout-wave-orphaned-txn");
        logEvent("task.failed", { runId, taskId: parent.id, payload: { failure_kind: "fanout_wave_orphaned", error, childSummary: { total: children.length, complete: completeChildren.length } } });
        logEvent("task.reconciled", { runId, taskId: parent.id, payload: { from: "running", to: "failed", reason: "fanout_wave_orphaned", childSummary: { total: children.length, complete: completeChildren.length } } });
      });
      taskChanges.push({ taskId: parent.id, from: "running", to: "failed", reason: "fanout_wave_orphaned" });
    }
    } catch { /* FG-459: never throw — a DB throw finalizing one fanout parent must not abort the rest */ }
  }

  // ── FG-531: the awaiting_red crash window ──────────────────────────────────
  // dispatchSingleStep (and dispatchFanoutStep for a wave's parent) writes
  // awaiting_red AFTER the step's work is done, merged, and integration-gated,
  // immediately BEFORE dispatchReds runs the red reviewers ATTACHED to the
  // dispatching process. A crash in that span leaves the task at awaiting_red
  // with reds that died with the process (or were never inserted): the per-task
  // loop above only sweeps `running` rows, computeReadyQueue treats
  // awaiting_red as live work (the phase is never re-admitted), and neither
  // `forge gate` nor `forge retry` accepts the status — a permanent wedge (the
  // FG-530-A matrix cells).
  //
  // Deliberate recovery transition (documented here; no new status): land the
  // task fail-safe with the SAME preserved-work kinds the container-gone sweeps
  // use — orphaned_needs_finalize for a single-step primary (operator verb:
  // `forge retry <id> --force`, re-driving the step through the real
  // merge → gate → reds path) and fanout_wave_orphaned for a wave's parent
  // (operator verb: `forge recover <id> --re-drive`; the completed children's
  // rows and results stay untouched as the audit trail, exactly like the
  // FG-455-p2 parent sweep above). Adopting partially-delivered red verdicts
  // and finalizing the primary from reconcile was considered and deliberately
  // REJECTED: it would duplicate dispatchReds' aggregation + finalizePrimary
  // semantics at a second site — the drift FG-477's evaluator exists to prevent
  // — and a re-driven red pass is strictly safer than adopting a half-delivered
  // one.
  //
  // Liveness guard: the dispatching process holds the run's dispatch lock for
  // the whole wave (`forge next` wraps dispatch in withRunLock), so a LIVE
  // foreign lock holder means the awaiting_red state is presumptively
  // in-flight — including the minutes-long red pre-container window where no
  // red container exists yet to probe. The sweep therefore runs only when no
  // live foreign process holds the lock (dead/stale/absent holders don't
  // count; nor does our own pid — `forge next` reconciles under its own lock,
  // and that is exactly the recovery pass that must be able to sweep).
  try {
    const awaitingRed = tasksForRun(runId).filter((t) => t.status === "awaiting_red");
    if (awaitingRed.length > 0 && liveRunLockHolder(runId) === null) {
      for (const t of awaitingRed) {
        try {
          const children = tasksForRun(runId).filter((c) => c.parentId === t.id);
          // A non-terminal child of an awaiting_red task can only be a red
          // reviewer (wave children are terminal before the parent reaches
          // awaiting_red; on_reject recovery rows parent to a FAILED task). A
          // live red container means the review is genuinely in flight.
          const deadReds = children.filter((c) => !TERMINAL_TASK.has(c.status));
          if (deadReds.some((c) => containerAlive(recordedContainerId(eventsForTask(c.id)) ?? `forge-${c.id}`))) continue;

          // Reds can never deliver a verdict for this task again. First settle
          // the dead red rows themselves (pending never-dispatched, or running
          // without a container.started — shapes the per-task loop can't sweep)
          // so they don't wedge as non-terminal orphans behind the primary.
          for (const red of deadReds) {
            const redError =
              "orphaned: red reviewer died with the crashed forge process before delivering a verdict — " +
              `its primary ${t.id} was landed fail-safe by the awaiting_red sweep (FG-531) and re-driving it re-runs the reds`;
            crashPoint("reconcile:before-fail-dead-red-child");
            writeTransaction(() => { // FG-463: fail write + its events atomic
              markTaskFailed(red.id, redError);
              crashPoint("reconcile:inside-fail-dead-red-child-txn");
              logEvent("task.failed", { runId, taskId: red.id, payload: { failure_kind: "orphaned", error: redError } });
              logEvent("task.reconciled", { runId, taskId: red.id, payload: { from: red.status, to: "failed", reason: "awaiting_red_dead_red" } });
            });
            taskChanges.push({ taskId: red.id, from: red.status, to: "failed", reason: "awaiting_red_dead_red" });
          }

          const result = readResult(runId, t.id);
          const isFanoutParent = children.some(
            (c) => typeof c.taskPackage.inputs["fanoutIndex"] === "number",
          );
          if (isFanoutParent) {
            const waveChildren = children.filter(
              (c) => typeof c.taskPackage.inputs["fanoutIndex"] === "number",
            );
            const completeChildren = waveChildren.filter((c) => c.status === "complete");
            const error =
              `fanout parent orphaned at awaiting_red: the wave's ${completeChildren.length}/${waveChildren.length} completed children ` +
              "(rows and results preserved) merged and gated, but the forge process died before the red reviewers delivered a verdict — " +
              `inspect with \`forge show ${t.id}\` and re-drive the wave with \`forge recover ${t.id} --re-drive\`.`;
            crashPoint("reconcile:before-fail-awaiting-red-fanout-parent");
            writeTransaction(() => { // FG-463: fail write + its events atomic
              markTaskFailed(t.id, error, result);
              crashPoint("reconcile:inside-fail-awaiting-red-fanout-parent-txn");
              logEvent("task.failed", { runId, taskId: t.id, payload: { failure_kind: "fanout_wave_orphaned", error, childSummary: { total: waveChildren.length, complete: completeChildren.length } } });
              logEvent("task.reconciled", { runId, taskId: t.id, payload: { from: "awaiting_red", to: "failed", reason: "awaiting_red_fanout_reds_dead" } });
            });
            taskChanges.push({ taskId: t.id, from: "awaiting_red", to: "failed", reason: "awaiting_red_fanout_reds_dead" });
          } else {
            const error =
              "orphaned_needs_finalize: the step's work is done and merged (it reached awaiting_red), but the forge process died " +
              "before its red reviewers delivered a verdict — the step cannot be trusted complete. The result is preserved; " +
              `inspect with \`forge show ${t.id}\`, then re-dispatch through the real finalize path with \`forge retry ${t.id} --force\`.`;
            crashPoint("reconcile:before-fail-awaiting-red-orphaned");
            writeTransaction(() => { // FG-463: fail write + its events atomic
              markTaskFailed(t.id, error, result);
              crashPoint("reconcile:inside-fail-awaiting-red-orphaned-txn");
              logEvent("task.failed", { runId, taskId: t.id, payload: { failure_kind: "orphaned_needs_finalize", error } });
              logEvent("task.reconciled", { runId, taskId: t.id, payload: { from: "awaiting_red", to: "failed", reason: "awaiting_red_reds_dead" } });
            });
            taskChanges.push({ taskId: t.id, from: "awaiting_red", to: "failed", reason: "awaiting_red_reds_dead" });
          }
        } catch { /* FG-459: never throw — one task's sweep must not abort the rest */ }
      }
    }
  } catch { /* FG-459: never throw — the lock probe / task scan must not abort reconcile */ }

  // Orphaned duplicate primaries: a pending primary in a phase that another
  // primary already completed. Produced by the duplicate-primary bug (`forge
  // retry` mints a parallel pending primary; a different rerun path completes the
  // phase first, stranding the retry's row). Left alone it never runs yet keeps
  // the run out of "complete" (it's non-terminal pending work) and, before the
  // ready-queue was made duplicate-tolerant, blocked the next phase. Finalize it
  // as failed/orphaned so the run can advance and complete.
  // FG-459: finalizeOrphanedPrimaries is itself never-throw (see its own
  // per-item guard), but guard the call site too so an unexpected throw can't
  // skip the run-level completion check below.
  try {
    for (const c of finalizeOrphanedPrimaries(runId)) taskChanges.push(c);
  } catch { /* FG-459: never throw */ }

  // Run-level: an active run with no remaining non-terminal work is no longer in
  // flight. We only complete it when there are no further workflow steps to come
  // — unambiguous only for single-step invoke runs; pipelines are finalized by
  // `forge next` (which loads the workflow).
  let runChange: ReconcileResult["runChange"];
  // FG-459: guard the run-level status write + its events so a DB throw here
  // does not propagate out of reconcileRun after the task passes succeeded.
  try {
    // FG-486: run-level completion stays LITERALLY invoke-only — deliberately
    // narrower than the task-level isInvokeLikeRun above. An `invoke_chain`
    // run with no live work may simply be BETWEEN chain steps; whether another
    // invoke is coming is known only to the campaign executor, so reconcile
    // must never complete it early.
    if (run.status === "active" && run.workflow === "invoke") {
      const after = tasksForRun(runId);
      const anyNonTerminal = after.some((t) => !TERMINAL_TASK.has(t.status));
      if (after.length > 0 && !anyNonTerminal) {
        // FG-484: finalizeRunIfSettled re-reads the run and refuses the
        // write (no events, no notification) if a concurrent `forge cancel`
        // already abandoned it — the `run.status === "active"` check above
        // is only this function's local snapshot from earlier in the call
        // and can be stale by the time we get here. The completion write and
        // BOTH its run.completed and run.reconciled events commit atomically
        // inside the helper's transaction (FG-463: restores the guarantee the
        // old getDb().transaction()-wrapped call here used to provide before
        // the FG-484 refactor split them into separate statements) — passed
        // as onCompleted so it only fires when the write actually applied.
        if (
          finalizeRunIfSettled(runId, "reconcile", { source: "reconcile" }, () =>
            logEvent("run.reconciled", { runId, payload: { from: "active", to: "complete", reason: "no_live_work" } }),
          )
        ) {
          runChange = { from: "active", to: "complete", reason: "no_live_work" };
        }
      }
    }
  } catch { /* FG-459: never throw */ }

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
    // FG-477: the classifier's phase-primary rule (rules 0/1/2) — parent-less and
    // not an ad-hoc invoke row. Children (fanout, red) and on_reject recovery rows
    // are not a phase's primary and are never swept as duplicates of one.
    //
    // FG-507: an ad-hoc invoke row is never a workflow primary — on a workflow
    // that declares a `task` step, sweeping it as a "duplicate" would fail the
    // row `forge retry` is about to dispatch directly.
    if (!isPhasePrimaryRow(t)) continue;
    const arr = primariesByPhase.get(t.phase) ?? [];
    arr.push({ id: t.id, status: t.status });
    primariesByPhase.set(t.phase, arr);
  }

  const changes: TaskReconcileChange[] = [];
  for (const primaries of primariesByPhase.values()) {
    if (!primaries.some((p) => p.status === "complete")) continue;
    for (const p of primaries) {
      if (p.status !== "pending") continue;
      // FG-459: never-throw — a DB throw failing one orphaned primary must not
      // abort the rest, and this function is also reused by `forge next`.
      try {
        const error =
          "orphaned: duplicate pending primary in a phase already completed by another primary";
        writeTransaction(() => { // FG-463: fail write + its events atomic
          markTaskFailed(p.id, error);
          logEvent("task.failed", { runId, taskId: p.id, payload: { failure_kind: "orphaned", error } });
          logEvent("task.reconciled", { runId, taskId: p.id, payload: { from: "pending", to: "failed", reason: "orphaned_duplicate_primary" } });
        });
        changes.push({ taskId: p.id, from: "pending", to: "failed", reason: "orphaned_duplicate_primary" });
      } catch { /* FG-459: never throw */ }
    }
  }
  return changes;
}

/** Reconcile a specific set of runs. Callers pass exactly the run ids they will
 *  act on / display, so reconciliation stays scoped — e.g. `forge status` must
 *  reconcile only the workspace-filtered runs it shows, not every active run on
 *  the host (that would mutate other workspaces' runs). Returns only the runs
 *  that actually changed. */
export function reconcileRuns(
  runIds: string[],
  containerAlive: ContainerAlive = defaultContainerAlive,
  reapContainer: ContainerReap = defaultContainerReap,
  containerExitInfo: ContainerExitInfo = defaultContainerExitInfo,
): ReconcileResult[] {
  return runIds
    .map((id) => reconcileRun(id, containerAlive, reapContainer, containerExitInfo))
    .filter((r) => r.taskChanges.length > 0 || r.runChange);
}
