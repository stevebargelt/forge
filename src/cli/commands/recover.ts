// FG-455 p3: `forge recover` — operator-safe recovery for tasks/runs left
// behind by a lost container. Reliability policy: prefer fail-safe refusal
// over false success; never silently discard persisted work. Default mode is
// read-only inspection; mutation (--continue / --re-drive) requires an
// explicit flag AND passes a recoverability check, writing nothing on refusal.

import type { Command } from "commander";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Task, Run } from "../../types/index.js";
import {
  getTask,
  tasksForRun,
  markTaskRecovered,
  insertTask,
  reopenFailedFanoutParentForReDrive,
  updateTaskPackageInputs,
} from "../../store/tasks.js";
import { getRun, reactivateFailedRun } from "../../store/runs.js";
import { writeTransaction } from "../../store/db.js";
import { logEvent, eventsForTask } from "../../store/events.js";
import { ensureForgeDirs, taskDir } from "../../util/paths.js";
import { acquireRunLock, releaseRunLock } from "../../util/run-lock.js";
import { newTaskId, nowIso } from "../../util/ids.js";
import { failureKindForTask, getOrphanEvidenceFromEvents } from "../../v2/failure-kind.js";
import { taskHasPipelineFinalize } from "../../v2/run-kind.js";
import type { OrphanEvidence } from "../../v2/failure-kind.js";
import { retryPolicy, isReDrivableFailureKind } from "../../v2/retry-policy.js";
import { changedWorktreeFiles, defaultContainerAlive, reconcileRun, isOrderedFanoutWave } from "../../v2/reconcile.js";
import type { ContainerAlive } from "../../v2/reconcile.js";
import { getManifestRuntime } from "../../v2/task-manifest.js";
import { analyzeProviderFailure } from "../../v2/provider-failure.js";
import { inferredResultFrom } from "../../v2/inferred-result.js";
import { recoverStructuredStreamResult } from "../../v2/stream-result-recovery.js";

// FG-455 p4 review finding 2: oom_killed carries the same worktree-evidence
// shape as orphaned_work_may_persist (both gathered on reconcile.ts's shared
// container-gone evidence path) and is legitimately continuable when work
// persisted despite the OOM/kill.
const CONTINUABLE_KINDS = new Set(["orphaned", "orphaned_work_may_persist", "oom_killed"]);
// FG-479 review finding 2: run-level inspect must surface orphaned_needs_finalize
// tasks too (single-task `forge recover <taskId>` already does, via buildTaskView
// unconditionally) — it is deliberately NOT in CONTINUABLE_KINDS (performContinue
// must keep refusing it; adopting the result as complete would recreate the exact
// bypass this failure kind exists to prevent), so a separate, wider set gates the
// run-level listing only.
const RUN_INSPECT_KINDS = new Set([...CONTINUABLE_KINDS, "orphaned_needs_finalize"]);
const TERMINAL = new Set(["complete", "failed"]);
const VERIFICATION_HINT =
  "Before adopting: review the diff at the path below, then run this project's verification (e.g. `npm run typecheck` and `npm run test:all` on the host).";

// ── read-only reconstruction of reconcile.ts's container-gone evidence ──────
// Mirrors reconcile.ts's never-throw readResult/resultFileState/stdout-recovery
// sequence (reconcile.ts ~64-96, ~178-190) so `forge recover` can recompute a
// fresh answer (the diff/stdout may look different now than at reconcile time)
// without importing reconcile.ts's private helpers.

function readResult(runId: string, taskId: string): unknown | undefined {
  const p = join(taskDir(runId, taskId), "result.json");
  let raw: string;
  try {
    raw = readFileSync(p, "utf8").trim();
  } catch {
    return undefined;
  }
  if (raw.length === 0) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function readStdoutLog(runId: string, taskId: string): string {
  const p = join(taskDir(runId, taskId), "container.stdout.log");
  try {
    return readFileSync(p, "utf8");
  } catch {
    return "";
  }
}

function resultFileMalformed(runId: string, taskId: string): boolean {
  let raw: string;
  try {
    raw = readFileSync(join(taskDir(runId, taskId), "result.json"), "utf8").trim();
  } catch {
    return false;
  }
  if (raw.length === 0) return false;
  try {
    JSON.parse(raw);
    return false;
  } catch {
    return true;
  }
}

type StdoutRecovered = { result: unknown; from: "stream_recovered" | "stdout_inferred" };

// FG-540: `forge recover` is a missing-result consumer like invoke/runNext/
// reconcile, so it reads stdout through the SAME shared extraction rule — a
// structured terminal result first, FG-337 narrative synthesis only after.
// Without this, the operator surface and reconcile disagree about whether the
// same task has a recoverable result. Guards mirror reconcile's container-gone
// branch: no contrary exit evidence (a recorded non-zero exit or OOM refuses; an
// unknown exit defers to the stream's own turn.completed proof), no provider
// error, and a non-empty malformed result.json is never overwritten by ANY
// stdout recovery — structured OR narrative — it stays a failure on disk.
function recoverStdoutResult(task: Task): StdoutRecovered | undefined {
  try {
    // The malformed-file refusal gates ALL stdout recovery, not just the
    // structured half: a present-but-corrupt result.json is evidence, and
    // adopting a synthesized narrative over it would silently replace it.
    if (resultFileMalformed(task.runId, task.id)) return undefined;
    const dir = taskDir(task.runId, task.id);
    const runtimeMeta = getManifestRuntime(dir);
    const stdoutRaw = readStdoutLog(task.runId, task.id);
    const analysis = analyzeProviderFailure({
      logFormat: runtimeMeta?.logFormat,
      runtimeKind: runtimeMeta?.kind,
      stdoutRaw,
    });
    const exit = getOrphanEvidenceFromEvents(eventsForTask(task.id));
    const exitCode = exit?.exitCode;
    const noContraryExit = exit?.oomKilled !== true && (exitCode === undefined || exitCode === 0);
    if (noContraryExit && !analysis.modelError) {
      const structured = recoverStructuredStreamResult({
        logFormat: runtimeMeta?.logFormat,
        runtimeKind: runtimeMeta?.kind,
        stdoutRaw,
      });
      if (structured) return { result: structured, from: "stream_recovered" };
    }
    const inferred = inferredResultFrom(analysis, task.agentRole);
    return inferred ? { result: inferred, from: "stdout_inferred" } : undefined;
  } catch {
    return undefined;
  }
}

type LiveEvidence = {
  worktreePathChecked: string | null;
  source: "worktree" | "project_dir_shared";
  changedFiles: string[];
  validResult?: unknown;
  stdoutRecovered?: StdoutRecovered;
};

function gatherLiveEvidence(task: Task, run: Run): LiveEvidence {
  const worktreePathChecked = task.worktreePath ?? run.projectDir;
  const source: LiveEvidence["source"] = task.worktreePath ? "worktree" : "project_dir_shared";
  const changedFiles = changedWorktreeFiles(worktreePathChecked);
  const validResult = readResult(task.runId, task.id);
  const stdoutRecovered = validResult === undefined ? recoverStdoutResult(task) : undefined;
  return { worktreePathChecked: worktreePathChecked ?? null, source, changedFiles, validResult, stdoutRecovered };
}

// FG-481/FG-486: only a run whose tasks have NO host-side pipeline finalize
// (worktree merge -> integration gate -> reds -> gates) may have work adopted
// by --continue — a usable result IS the end of such a task's lifecycle.
// That is `invoke` AND `invoke_chain` (campaign quick lanes chain plain
// invokes); run-kind.ts owns the one definition shared with reconcile.ts.

// A recommended next step: the command(s) to run, and why. Rendered as
// `cmd [&& cmd]  (note)` — the `&&` chain is literal, copy-pasteable shell.
type Recommendation = { commands: string[]; note: string };

function renderRecommendation(r: Recommendation): string {
  return r.commands.join(" && ") + (r.note ? `  (${r.note})` : "");
}

// FG-455 p4 review finding 2: only recommend --continue for a failure_kind
// performContinue will actually accept (CONTINUABLE_KINDS) — otherwise this
// recommended a command performContinue then refused (e.g. a container_crash
// task that happened to have a dirty worktree). A non-continuable kind falls
// back to the plain retry recommendation instead.
function recommendationForKind(task: Task, evidence: LiveEvidence, failureKind: string | undefined, run: Run): Recommendation {
  const continuable = CONTINUABLE_KINDS.has(failureKind ?? "") && !taskHasPipelineFinalize(run);
  const hasRecoverableWork =
    evidence.validResult !== undefined || evidence.stdoutRecovered !== undefined || evidence.changedFiles.length > 0;
  if (continuable && hasRecoverableWork) {
    return evidence.source === "project_dir_shared"
      ? { commands: [`forge recover ${task.id} --continue --force`], note: "shared project dir — confirm the diff is this task's before forcing" }
      : { commands: [`forge recover ${task.id} --continue`], note: "" };
  }
  if (hasRecoverableWork) {
    if (retryPolicy(failureKind).retryable) {
      return {
        commands: [`forge retry ${task.id}`],
        note: `failure_kind=${failureKind ?? "none"} isn't continuable via --continue, but is retryable without --force; evidence found — inspect the diff first if unsure`,
      };
    }
    return {
      commands: [`forge retry ${task.id} --force`],
      note: `failure_kind=${failureKind ?? "none"} isn't continuable via --continue; evidence found but not adopted — inspect the diff first`,
    };
  }
  if (!retryPolicy(failureKind).retryable) {
    return { commands: [`forge retry ${task.id} --force`], note: `failure_kind=${failureKind ?? "none"} requires --force to re-dispatch` };
  }
  return { commands: [`forge retry ${task.id}`], note: "no persisted work found — safe to re-dispatch from scratch" };
}

// The failure_kind `forge cancel` stamps on a task it kills — see cancel.ts's
// `classify({ source: "cancelled" })`. The post-cancel retry recommendation is
// computed against THIS kind, not the running task's (absent) one, so its
// --force suffix reflects the state the task will actually be in.
const POST_CANCEL_FAILURE_KIND = "cancelled";

// FG-507 gap 1: `forge recover` on a RUNNING task whose container is confirmed
// gone used to recommend a bare `forge retry <id>` — which retry then refuses
// ("Task is in status running, not failed"), because retrying over a
// possibly-live task is unsafe. That guard is correct; the recommendation was
// not. Recover already holds the evidence that the container is gone, so it can
// name the sequence that actually works: cancel (settling the row to
// failed/cancelled) and then the retry line it would otherwise have printed.
// Recover does NOT perform the cancel itself — killing a task stays an explicit
// operator act.
function recommendationFor(
  task: Task,
  evidence: LiveEvidence,
  failureKind: string | undefined,
  run: Run,
  containerAlive: ContainerAlive,
): Recommendation {
  if (task.status === "running" && !containerAlive(`forge-${task.id}`)) {
    const afterCancel = recommendationForKind(task, evidence, POST_CANCEL_FAILURE_KIND, run);
    const why =
      `container forge-${task.id} is confirmed gone, but the row is still status=running — ` +
      `forge retry only accepts a failed task, so cancel it first`;
    return {
      commands: [`forge cancel ${task.id}`, ...afterCancel.commands],
      note: afterCancel.note ? `${why}; then: ${afterCancel.note}` : why,
    };
  }
  return recommendationForKind(task, evidence, failureKind, run);
}

export type TaskEvidenceView = {
  taskId: string;
  runId: string;
  phase: string;
  status: string;
  failureKind?: string;
  storedEvidence?: OrphanEvidence;
  worktreePathChecked: string | null;
  source: "worktree" | "project_dir_shared";
  changedFiles: string[];
  hasValidResult: boolean;
  hasStdoutRecoverableResult: boolean;
  recommendation: string;
  /** FG-507: the recommendation as discrete commands, in order. Usually one;
   *  two for the cancel→retry sequence a running task with a dead container needs. */
  recommendationCommands: string[];
  verification: string;
};

function buildTaskView(task: Task, run: Run, containerAlive: ContainerAlive): TaskEvidenceView {
  const failureKind = failureKindForTask(task.id);
  const storedEvidence = getOrphanEvidenceFromEvents(eventsForTask(task.id));
  const evidence = gatherLiveEvidence(task, run);
  const recommendation = recommendationFor(task, evidence, failureKind, run, containerAlive);
  return {
    taskId: task.id,
    runId: task.runId,
    phase: task.phase,
    status: task.status,
    failureKind,
    storedEvidence,
    worktreePathChecked: evidence.worktreePathChecked,
    source: evidence.source,
    changedFiles: evidence.changedFiles,
    hasValidResult: evidence.validResult !== undefined,
    hasStdoutRecoverableResult: evidence.stdoutRecovered !== undefined,
    recommendation: renderRecommendation(recommendation),
    recommendationCommands: recommendation.commands,
    verification: VERIFICATION_HINT,
  };
}

export type FanoutParentView = {
  parentId: string;
  runId: string;
  phase: string;
  status: string;
  failureKind?: string;
  children: { id: string; status: string }[];
  recommendation: string;
};

function isFanoutParent(task: Task, allTasks: Task[]): boolean {
  return task.parentId === undefined && allTasks.some((t) => t.parentId === task.id);
}

// Is this a fanout parent in a state piece-2 reconcile would act on (settle) or
// has already settled into fanout_wave_orphaned? A `running` parent whose
// children aren't all terminal yet is left alone by reconcile too — the wave
// may still be in flight — so it's not listed as recoverable here either.
function fanoutParentRecoverable(task: Task, allTasks: Task[]): boolean {
  if (!isFanoutParent(task, allTasks)) return false;
  if (task.status === "failed") return failureKindForTask(task.id) === "fanout_wave_orphaned";
  if (task.status === "running") {
    if (eventsForTask(task.id).some((e) => e.eventType === "container.started")) return false;
    const children = allTasks.filter((t) => t.parentId === task.id);
    return children.every((c) => TERMINAL.has(c.status));
  }
  return false;
}

function buildFanoutView(task: Task, allTasks: Task[]): FanoutParentView {
  const children = allTasks.filter((t) => t.parentId === task.id).map((c) => ({ id: c.id, status: c.status }));
  return {
    parentId: task.id,
    runId: task.runId,
    phase: task.phase,
    status: task.status,
    failureKind: failureKindForTask(task.id),
    children,
    recommendation: `forge recover ${task.id} --re-drive`,
  };
}

export type AdoptedFrom = "result_json" | "stream_recovered" | "stdout_inferred" | "diff_adopted";

/** FG-688: the two shapes a `--re-drive` can take. Chosen by the wave's DURABLE
 *  shape (isOrderedFanoutWave), never by its failure kind. */
export type ReDriveLane = "ordered_reopened_in_place" | "unordered_fresh_primary";

export type RecoverOutcome =
  | { kind: "inspect-task"; task: TaskEvidenceView }
  | { kind: "inspect-fanout-parent"; parent: FanoutParentView }
  | { kind: "inspect-run"; runId: string; tasks: TaskEvidenceView[]; fanoutParents: FanoutParentView[] }
  | { kind: "continued"; taskId: string; runId: string; adoptedFrom: AdoptedFrom; result: unknown }
  | { kind: "continue-refused"; id: string; reason: string }
  | {
      kind: "re-drive-done";
      parentId: string;
      runId: string;
      /** FG-688: WHICH lane ran. `ordered_reopened_in_place` reuses the parent
       *  row so runOrderedWave can adopt the children whose commits are already
       *  integrated; `unordered_fresh_primary` is the pre-FG-688 mint path. */
      lane: ReDriveLane;
      /** The task `forge next` will dispatch — the REUSED parent on the ordered
       *  lane, the freshly minted primary on the unordered one. Always set, so a
       *  consumer that only needs "what runs next" never has to branch on lane. */
      dispatchTaskId: string;
      /** Set ONLY by the unordered lane. The ordered lane reports the reused
       *  parent id via `dispatchTaskId`/`parentId` and mints nothing, so naming a
       *  `newTaskId` here would be a claim it did not earn. */
      newTaskId?: string;
      /** true iff THIS call moved the run row failed -> active (and therefore
       *  wrote the one `run.reactivated` event). false when the run was already
       *  active — an idempotent no-op, not an error. */
      runReactivated: boolean;
      /** The failure kind that authorized the mutation, for the audit trail. */
      authorizingFailureKind: string;
    }
  | { kind: "re-drive-refused"; id: string; reason: string }
  | { kind: "bad-usage"; id: string; reason: string }
  | { kind: "unknown"; id: string };

// ── default: read-only inspection ───────────────────────────────────────────

export function performInspect(id: string, containerAlive: ContainerAlive = defaultContainerAlive): RecoverOutcome {
  const task = getTask(id);
  if (task) {
    const run = getRun(task.runId);
    if (!run) return { kind: "unknown", id };
    const allTasks = tasksForRun(task.runId);
    if (isFanoutParent(task, allTasks)) {
      return { kind: "inspect-fanout-parent", parent: buildFanoutView(task, allTasks) };
    }
    return { kind: "inspect-task", task: buildTaskView(task, run, containerAlive) };
  }

  const run = getRun(id);
  if (run) {
    const allTasks = tasksForRun(run.id);
    // Only FAILED tasks are listed here, so buildTaskView never reaches the
    // running-task container probe below — a run-level inspect stays docker-free.
    const tasks = allTasks
      .filter((t) => t.status === "failed" && RUN_INSPECT_KINDS.has(failureKindForTask(t.id) ?? ""))
      .map((t) => buildTaskView(t, run, containerAlive));
    const fanoutParents = allTasks.filter((t) => fanoutParentRecoverable(t, allTasks)).map((t) => buildFanoutView(t, allTasks));
    return { kind: "inspect-run", runId: run.id, tasks, fanoutParents };
  }

  return { kind: "unknown", id };
}

// ── --continue: adopt persisted work → complete ─────────────────────────────

export function performContinue(taskId: string, opts: { force?: boolean } = {}): RecoverOutcome {
  const task = getTask(taskId);
  if (!task) return { kind: "continue-refused", id: taskId, reason: `unknown task '${taskId}'` };
  const run = getRun(task.runId);
  if (!run) return { kind: "continue-refused", id: taskId, reason: `run ${task.runId} not found for task ${taskId}` };

  // FG-481: refuse unconditionally (ignoring failure_kind and --force) for any
  // pipeline-run task. Adopting persisted work here would complete the step
  // without host-side finalize (worktree merge -> integration gate -> reds ->
  // gates) ever running — the same bypass class FG-479 closed on the silent
  // reconcile path, now closed on the explicit operator path too.
  if (taskHasPipelineFinalize(run)) {
    return {
      kind: "continue-refused",
      id: taskId,
      reason:
        `task ${taskId}'s run (workflow=${run.workflow}) is a pipeline run (not invoke/invoke_chain) — --continue never adopts a pipeline task's ` +
        "persisted work, because host-side finalize (worktree merge → integration gate → reds → gates) never ran for it and the step " +
        "cannot be trusted complete. --force does not override this refusal. Re-drive through the real finalize path with " +
        `\`forge retry ${taskId} --force\`.`,
    };
  }

  const failureKind = failureKindForTask(taskId);
  if (task.status !== "failed" || !CONTINUABLE_KINDS.has(failureKind ?? "")) {
    return {
      kind: "continue-refused",
      id: taskId,
      reason:
        `task ${taskId} is not in a recoverable state (status=${task.status}, failure_kind=${failureKind ?? "none"}) — ` +
        "--continue only applies to a failed task orphaned by a lost container (failure_kind orphaned / orphaned_work_may_persist / oom_killed)",
    };
  }

  const evidence = gatherLiveEvidence(task, run);
  const adopted: { result: unknown; adoptedFrom: AdoptedFrom } | undefined =
    evidence.validResult !== undefined
      ? { result: evidence.validResult, adoptedFrom: "result_json" }
      : evidence.stdoutRecovered !== undefined
        ? { result: evidence.stdoutRecovered.result, adoptedFrom: evidence.stdoutRecovered.from }
        : evidence.changedFiles.length > 0
          ? {
              result: {
                contract: "adopted_diff",
                status: "complete",
                changedFiles: evidence.changedFiles,
                worktreePathChecked: evidence.worktreePathChecked,
              },
              adoptedFrom: "diff_adopted",
            }
          : undefined;

  if (!adopted) {
    return {
      kind: "continue-refused",
      id: taskId,
      reason:
        `no recoverable result for ${taskId} (no valid result.json, no stdout-recoverable result) and no changed files at ` +
        `${evidence.worktreePathChecked ?? "(no worktree path recorded)"} — nothing to adopt. Discarding is the only honest outcome; ` +
        `re-dispatch fresh with \`forge retry ${taskId}\` instead.`,
    };
  }

  if (evidence.source === "project_dir_shared" && !opts.force) {
    return {
      kind: "continue-refused",
      id: taskId,
      reason:
        `task ${taskId} had no dedicated worktree — its evidence source is project_dir_shared, so the ` +
        `${evidence.changedFiles.length} changed file(s) at ${evidence.worktreePathChecked} may include unrelated uncommitted changes ` +
        "from the operator's own working tree or another no-worktree task in this run. Pass --force once you've confirmed the diff is this task's.",
    };
  }

  acquireRunLock(task.runId, "recover --continue");
  try {
    // FG-540 (d82e136 rule, applied here too): a stream_recovered result
    // stands in for the agent's OWN result contract, so it must be PERSISTED
    // before any completion write — the dispatch paths persist-then-complete,
    // and reconcile's running-orphan recovery voids an unpersistable
    // structured recovery. On a failed write: refuse, leave the task failed,
    // emit nothing. Every other adoption source (result_json already on disk,
    // narrative stdout_inferred, diff_adopted) keeps its best-effort write.
    if (adopted.adoptedFrom === "stream_recovered") {
      try {
        writeFileSync(join(taskDir(task.runId, task.id), "result.json"), JSON.stringify(adopted.result));
      } catch {
        return {
          kind: "continue-refused",
          id: taskId,
          reason:
            `task ${taskId} has a stream-recoverable structured result, but persisting it to result.json failed — ` +
            "a structured recovery may not complete a task it could not persist. Fix the task directory (result.json may be " +
            "a directory or unwritable) and re-run `forge recover " + taskId + " --continue`.",
        };
      }
    }
    if (!markTaskRecovered(task.id, adopted.result)) {
      return { kind: "continue-refused", id: taskId, reason: `task ${taskId} was concurrently finalized by another process — not overwriting` };
    }
    // Best-effort disk write for the non-structured sources, mirroring
    // reconcile.ts: their completion proceeds from the in-memory result
    // regardless of whether the write below succeeds.
    if (adopted.adoptedFrom !== "stream_recovered") {
      try {
        writeFileSync(join(taskDir(task.runId, task.id), "result.json"), JSON.stringify(adopted.result));
      } catch {
        // best-effort only
      }
    }
    if (adopted.adoptedFrom === "stream_recovered") {
      logEvent("task.result_recovered_from_stream", {
        runId: task.runId,
        taskId: task.id,
        payload: { source: "recover --continue" },
      });
    }
    logEvent("task.completed", { runId: task.runId, taskId: task.id });
    logEvent("task.reconciled", {
      runId: task.runId,
      taskId: task.id,
      payload: {
        from: "failed",
        to: "complete",
        reason: "operator_recovered",
        via: "forge recover --continue",
        adoptedFrom: adopted.adoptedFrom,
        evidence: { source: evidence.source, changedFiles: evidence.changedFiles, worktreePathChecked: evidence.worktreePathChecked },
        forced: !!opts.force,
      },
    });
  } finally {
    releaseRunLock(task.runId);
  }

  return { kind: "continued", taskId: task.id, runId: task.runId, adoptedFrom: adopted.adoptedFrom, result: adopted.result };
}

// ── --re-drive: in-run re-drive of a failed fanout wave ─────────────────────
//
// ONE shared eligibility conjunction, then TWO lanes.
//
// Eligibility: (i) the task is a fan-out PARENT, (ii) its status is `failed`,
// (iii) `isReDrivableFailureKind(failureKindForTask(parent))` — the ONE shared
// enumeration the recommendation surface also consults, exhaustive at compile
// time and fail-closed at runtime — and (iv) the parent is NOT SUPERSEDED.
//
// ORDERED lane (FG-688). The parent ROW IS REUSED: reopened `failed` -> `pending`
// in place, keeping its children attached. That is the WHOLE mechanism, and the
// reason is that nothing downstream needs teaching. runOrderedWave recomputes
// readiness AND adoption from durable state (two task rows and two git refs) at
// the top of every dependency group, skips a merge whose commit is already an
// ancestor of the candidate, and adopts an existing candidate branch by rewinding
// it to its prerequisites; dispatchFanoutStep already prefers a pending primary
// and already carves ordered waves out of its `pendingHasChildren` early return.
// So an item whose captured commit is already integrated is never re-dispatched —
// regardless of WHY the wave stopped, because git ancestry does not record why.
//
// This supersedes what this comment used to say — that resuming only the failed
// children would need "deep dispatchFanoutStep surgery". It needs NONE: that
// claim predated FG-584's ordered lane, which made readiness recomputable. The
// surgery was a verb that returns the parent row to `pending` and the run row to
// `active`; it is below.
//
// UNORDERED lane. Unchanged: mint a fresh pending PRIMARY (parentId undefined) in
// the SAME phase — byte-for-byte the shape gate.ts's request-changes uses, which
// dispatchFanoutStep reuses cleanly. The old parent and children stay as an audit
// trail, and the fresh wave re-runs every item. Reopening an unordered parent in
// place would WEDGE (dispatchFanoutStep returns early for
// `pendingHasChildren && !graph.ordered`), which is exactly why the lane is chosen
// by the wave's durable SHAPE and why isOrderedFanoutWave answers false when it
// cannot prove ordering: an ordered wave misread as unordered discards work (todays
// behaviour, safe), while an unordered wave misread as ordered strands the run.
//
// BOTH lanes take the run-level `failed` -> `active` transition. That is a
// PRE-EXISTING hole in this verb, not one the widened accept-set opens: an accepted
// wave failure settles the RUN to `failed` too, and both `forge next` entry points
// refuse a non-active run, so a reopened-or-minted primary would never dispatch.
// `forge retry` has reactivated since FG-585; this verb never did.
//
// ATOMICITY is load-bearing, not tidy, and the asymmetry is why: run-moved-but-
// parent-not merely writes a redundant `run.failed` on the next command, while
// parent-moved-but-run-not is a PERMANENT wedge — the ready queue keeps the phase
// active, classifyRunTerminalState returns null forever, and the run can neither
// settle nor dispatch without hand surgery on the DB. So the parent reopen, the run
// reactivation and BOTH audit events commit in ONE writeTransaction, taken inside
// the run lock this verb already holds. Every write is a CAS against a status read
// inside that transaction; if either CAS matches zero rows the whole transaction
// rolls back and the verb returns a refusal with NO state written and NO events
// emitted. Deliberately NOT composed from completeRun/failRun/reactivateTerminalRun:
// their notifications and event writes sit OUTSIDE their own transaction and would
// escape the rollback.

/** Thrown inside the re-drive transaction to roll it back and surface the reason
 *  as a refusal. Never escapes performReDrive. */
class ReDriveRollback extends Error {
  constructor(readonly refusal: string) {
    super(refusal);
    this.name = "ReDriveRollback";
  }
}

// FG-688 / AC3, the verb-level half of "cross-parent adoption stays closed".
//
// A parent is SUPERSEDED when another parent-less primary in the same phase was
// created at or after it. Such a primary OWNS the phase now — `forge gate
// request-changes` mints exactly this shape — so the older parent belongs to a
// DEAD LINEAGE, and reopening it would put two live parents in one phase. That is
// precisely the cross-wave hazard FG-584's RF-3b review closed by scoping adoption
// to the current parent, arriving through the recovery door instead of the
// dispatch one, and the reason decision (a) reuses the parent row is so that guard
// never has to move.
//
// The comparison is `>=`, not `>`: two primaries stamped in the same millisecond
// leave the phase's ownership genuinely ambiguous, and this gates a MUTATION, so
// the tie refuses. It subsumes the old `dupePending` check (a pending re-drive is
// a superseding primary), whose "run forge next instead" advice is preserved below.
function supersedingPrimary(parent: Task, allTasks: Task[]): Task | undefined {
  return allTasks.find(
    (t) => t.id !== parent.id && t.phase === parent.phase && t.parentId === undefined && t.createdAt >= parent.createdAt,
  );
}

/** The run-level half of the re-drive transaction. MUST be called from inside the
 *  enclosing writeTransaction: it re-reads the run status there (getRun uses the
 *  writable handle, so it sees this transaction's own uncommitted writes) and
 *  throws ReDriveRollback — rolling the parent reopen back with it — on anything
 *  outside the accept-set.
 *
 *  Accept-set, enforced HERE at the verb and never as an exemption in the store:
 *    failed    -> reactivate, and write the one `run.reactivated` audit event
 *    active    -> no run-level write; proceed (idempotent — only one phase's wave failed)
 *    complete  -> REFUSE always (a run that already succeeded is never reopened)
 *    abandoned -> REFUSE always (AWN-2: a human's `forge cancel` is authoritatively
 *                 terminal; retry.ts's ad-hoc carve-out is scoped to an explicit
 *                 per-task retry and deliberately does not extend here)
 *    anything else -> REFUSE, fail closed.
 *
 *  Returns true iff this call moved the run row. */
function reactivateRunForReDrive(parent: Task, failureKind: string, lane: ReDriveLane): boolean {
  const run = getRun(parent.runId);
  if (!run) throw new ReDriveRollback(`run ${parent.runId} not found for fanout parent ${parent.id} — nothing written`);
  if (run.status === "active") return false;
  if (run.status !== "failed") {
    throw new ReDriveRollback(
      `run ${parent.runId} is '${run.status}', and --re-drive only reopens a 'failed' run (an 'active' one it leaves alone) — ` +
        `a ${run.status} run is never reopened by a recovery verb. Nothing was written.`,
    );
  }
  // Captured BEFORE the write: reactivation NULLs completed_at, so after it the
  // row carries no trace that the run ever failed. This event is the sole durable
  // record — which is why it commits in the same transaction as the flip, and why
  // the earlier `run.failed` event is never amended or deleted. The readable
  // history is run.failed -> run.reactivated -> (later) run.completed | run.failed.
  const completedAtCleared = run.completedAt ?? null;
  const applied = reactivateFailedRun(parent.runId, {
    onApplied: () =>
      logEvent("run.reactivated", {
        runId: parent.runId,
        payload: {
          // Distinct from invoke.ts's "retry"/"invoke" sources so this verb is
          // identifiable in the log without joining against anything.
          source: "recover --re-drive",
          from: "failed",
          completedAtCleared,
          authorizingTaskId: parent.id,
          failure_kind: failureKind,
          lane,
        },
      }),
  });
  if (!applied) {
    throw new ReDriveRollback(
      `run ${parent.runId} was concurrently moved off 'failed' while re-driving ${parent.id} — refusing rather than ` +
        "reopening a task on a run that settled underneath it. Nothing was written.",
    );
  }
  return true;
}

export function performReDrive(id: string, opts: { containerAlive?: ContainerAlive } = {}): RecoverOutcome {
  const anchor = getTask(id);
  if (!anchor) return { kind: "re-drive-refused", id, reason: `unknown task '${id}'` };

  let parent: Task;
  if (anchor.parentId !== undefined) {
    const p = getTask(anchor.parentId);
    if (!p) return { kind: "re-drive-refused", id, reason: `parent task ${anchor.parentId} of ${id} not found` };
    parent = p;
  } else {
    parent = anchor;
  }

  if (!isFanoutParent(parent, tasksForRun(parent.runId))) {
    return { kind: "re-drive-refused", id, reason: `${parent.id} is not a fanout parent (no children) — --re-drive only applies to a fanout wave` };
  }

  if (parent.status === "running") {
    reconcileRun(parent.runId, opts.containerAlive ?? defaultContainerAlive);
    const reloaded = getTask(parent.id);
    if (reloaded) parent = reloaded;
  }

  if (parent.status === "complete") {
    return { kind: "re-drive-refused", id, reason: `${parent.id} already completed — nothing to re-drive` };
  }
  if (parent.status === "running") {
    return {
      kind: "re-drive-refused",
      id,
      reason: `${parent.id} is still running — a child container may still be live, so the wave may still be in progress. Try again once it settles, or \`forge cancel ${parent.id}\` first.`,
    };
  }
  if (parent.status !== "failed") {
    return { kind: "re-drive-refused", id, reason: `${parent.id} is in status '${parent.status}', not a recoverable failed fanout parent` };
  }

  // (iii) The shared, compile-time-exhaustive, fail-closed enumeration. An
  // unrecognized kind string — one written by a build this one does not know —
  // lands here too and is refused, deliberately unlike retryPolicy's permissive
  // advisory default.
  const parentFailureKind = failureKindForTask(parent.id);
  if (!isReDrivableFailureKind(parentFailureKind)) {
    return {
      kind: "re-drive-refused",
      id,
      reason:
        `${parent.id} failed as ${parentFailureKind ?? "none"}, which --re-drive does not accept — a re-drive re-reads the same plan and ` +
        `re-gates the same tree, so it would fail identically. Use \`forge retry ${parent.id}\` / \`forge recover ${parent.id} --continue\` as appropriate.`,
    };
  }

  // isReDrivableFailureKind returns false for `undefined`, so past the guard above
  // the kind is necessarily a recognized string. Narrowed once, here, rather than
  // cast at each of the four places the audit trail carries it.
  const authorizingKind: string = parentFailureKind as string;

  // (iv) Supersession — see supersedingPrimary above. This is AC3's verb-level half.
  const allTasks = tasksForRun(parent.runId);
  const superseding = supersedingPrimary(parent, allTasks);
  if (superseding) {
    return {
      kind: "re-drive-refused",
      id,
      reason:
        superseding.status === "pending"
          ? `a re-drive is already pending as ${superseding.id} — run \`forge next ${parent.runId}\` to dispatch it instead of re-driving again`
          : `${parent.id} has been SUPERSEDED by ${superseding.id} (status=${superseding.status}), a later primary that now owns phase ` +
            `'${parent.phase}' — reopening a dead lineage would put two live parents in one phase and let one wave adopt another's ` +
            `children. Run \`forge next ${parent.runId}\` to drive the live wave instead.`,
    };
  }

  // The run accept-set, read here so an ineligible run refuses BEFORE the lock is
  // taken and before any write is attempted. Re-checked authoritatively inside the
  // transaction (reactivateRunForReDrive), which is what actually binds.
  const run = getRun(parent.runId);
  if (!run) return { kind: "re-drive-refused", id, reason: `run ${parent.runId} not found for fanout parent ${parent.id}` };
  if (run.status !== "failed" && run.status !== "active") {
    return {
      kind: "re-drive-refused",
      id,
      reason:
        `run ${parent.runId} is '${run.status}' — --re-drive only reopens a 'failed' run (an 'active' one it leaves alone). ` +
        (run.status === "abandoned"
          ? "An abandoned run is a human's decision and is authoritatively terminal; no recovery verb resurrects it."
          : "A run that already completed is never reopened."),
    };
  }

  // The lane is chosen by the wave's DURABLE shape, never by its failure kind.
  const lane: ReDriveLane = isOrderedFanoutWave(parent.id) ? "ordered_reopened_in_place" : "unordered_fresh_primary";

  acquireRunLock(parent.runId, "recover --re-drive");
  try {
    if (lane === "ordered_reopened_in_place") {
      const runReactivated = writeTransaction(() => {
        // (a) The parent row, in place. CAS from 'failed' only — a second named
        // terminal exit, not a relaxation of setTaskStatus's structural guard.
        if (!reopenFailedFanoutParentForReDrive(parent.id)) {
          throw new ReDriveRollback(
            `${parent.id} was concurrently moved off 'failed' — refusing rather than reopening a row another process just ` +
              "settled. Nothing was written.",
          );
        }
        // (b) Stamp the failure onto the reopened row's inputs, mirroring the mint
        // lane. markTaskRunning clears `error` when the row is actually
        // re-dispatched, so without this the reason for the re-drive would not
        // survive into the wave it authorized.
        updateTaskPackageInputs(parent.id, {
          previous_failure: { kind: authorizingKind, error: parent.error ?? null, failedTaskId: parent.id },
        });
        // (c) The run row + its audit event, same transaction.
        const reactivated = reactivateRunForReDrive(parent, authorizingKind, lane);
        // (d) The task-level audit event, same transaction. `to: "pending"` — the
        // row really is back to pending, unlike the mint lane's "redriven", which
        // describes a parent left terminal.
        logEvent("task.reconciled", {
          runId: parent.runId,
          taskId: parent.id,
          payload: {
            from: "failed",
            to: "pending",
            reason: "ordered_wave_redriven_in_place",
            via: "forge recover --re-drive",
            failure_kind: authorizingKind,
            runReactivated: reactivated,
          },
        });
        return reactivated;
      });
      return {
        kind: "re-drive-done",
        parentId: parent.id,
        runId: parent.runId,
        lane,
        dispatchTaskId: parent.id,
        runReactivated,
        authorizingFailureKind: authorizingKind,
      };
    }

    // UNORDERED lane — the pre-FG-688 mint path, byte-for-byte, now wrapped in the
    // same transaction as the run reactivation so a refused run CAS leaves no
    // orphaned pending primary behind.
    const newId = newTaskId(parent.phase);
    const runReactivated = writeTransaction(() => {
      const newTask: Task = {
        id: newId,
        runId: parent.runId,
        phase: parent.phase,
        agentRole: parent.agentRole,
        status: "pending",
        taskPackage: {
          ...parent.taskPackage,
          taskId: newId,
          inputs: {
            ...parent.taskPackage.inputs,
            previous_failure: { kind: authorizingKind, error: parent.error ?? null, failedTaskId: parent.id },
          },
          composedSystemPrompt: "",
        },
        createdAt: nowIso(),
      };
      insertTask(newTask);
      const reactivated = reactivateRunForReDrive(parent, authorizingKind, lane);
      logEvent("task.created", {
        runId: parent.runId,
        taskId: newId,
        payload: { fanoutParent: true, from: "forge recover --re-drive", previousParentId: parent.id },
      });
      logEvent("task.reconciled", {
        runId: parent.runId,
        taskId: parent.id,
        payload: {
          from: "failed",
          to: "redriven",
          reason: "fanout_wave_redriven",
          via: "forge recover --re-drive",
          newTaskId: newId,
          failure_kind: authorizingKind,
          runReactivated: reactivated,
        },
      });
      return reactivated;
    });
    return {
      kind: "re-drive-done",
      parentId: parent.id,
      runId: parent.runId,
      lane,
      dispatchTaskId: newId,
      newTaskId: newId,
      runReactivated,
      authorizingFailureKind: authorizingKind,
    };
  } catch (e) {
    if (e instanceof ReDriveRollback) return { kind: "re-drive-refused", id, reason: e.refusal };
    throw e;
  } finally {
    releaseRunLock(parent.runId);
  }
}

export type RecoverOpts = { json?: boolean; continueTask?: boolean; reDrive?: boolean; force?: boolean };

export function performRecover(
  id: string,
  opts: RecoverOpts,
  containerAlive: ContainerAlive = defaultContainerAlive,
): RecoverOutcome {
  if (opts.continueTask && opts.reDrive) {
    return { kind: "bad-usage", id, reason: "--continue and --re-drive are mutually exclusive" };
  }
  if (opts.continueTask) return performContinue(id, { force: opts.force });
  if (opts.reDrive) return performReDrive(id, { containerAlive });
  return performInspect(id, containerAlive);
}

function renderTaskEvidence(v: TaskEvidenceView): string[] {
  const lines: string[] = [];
  lines.push(`  ${v.taskId}  [${v.phase}]  status=${v.status}  failure_kind=${v.failureKind ?? "none"}`);
  lines.push(`    worktree:      ${v.worktreePathChecked ?? "(none)"} (${v.source})`);
  if (v.source === "project_dir_shared") {
    lines.push("    ⚠ shared project directory — this diff may include unrelated uncommitted changes.");
  }
  lines.push(`    changed files: ${v.changedFiles.length > 0 ? v.changedFiles.join(", ") : "(none)"}`);
  lines.push(`    valid result.json: ${v.hasValidResult}   stdout-recoverable: ${v.hasStdoutRecoverableResult}`);
  lines.push(`    verify:  ${v.verification}`);
  lines.push(`    next:    ${v.recommendation}`);
  return lines;
}

function renderFanoutView(v: FanoutParentView): string[] {
  const lines: string[] = [];
  lines.push(`  ${v.parentId}  [${v.phase}]  status=${v.status}  failure_kind=${v.failureKind ?? "none"}`);
  lines.push(`    children: ${v.children.map((c) => `${c.id}(${c.status})`).join(", ") || "(none)"}`);
  lines.push(`    next:     ${v.recommendation}`);
  return lines;
}

export function registerRecover(program: Command): void {
  program
    .command("recover")
    .argument("<id>", "task id or run id to inspect or recover")
    .description(
      "Operator-safe recovery for a task/run left behind by a lost container. Read-only by default — inspects persisted diff/result and recommends a next command. --continue adopts persisted work and completes the task; --re-drive re-dispatches an orphaned fanout wave in-run.",
    )
    .option("--continue", "adopt the orphaned task's persisted result and mark it complete")
    .option("--re-drive", "re-drive an orphaned fanout wave in-run instead of stranding a detached primary")
    .option("--force", "acknowledge an ambiguous shared-directory diff (or other refusal) and proceed anyway")
    .option("--json", "emit structured JSON (the primary orchestrator surface)")
    .action((id: string, opts: { continue?: boolean; reDrive?: boolean; force?: boolean; json?: boolean }) => {
      ensureForgeDirs();
      const outcome = performRecover(id, { json: opts.json, continueTask: opts.continue, reDrive: opts.reDrive, force: opts.force });

      if (opts.json) {
        console.log(JSON.stringify(outcome, null, 2));
        if (outcome.kind === "unknown" || outcome.kind === "continue-refused" || outcome.kind === "re-drive-refused" || outcome.kind === "bad-usage") {
          process.exit(1);
        }
        return;
      }

      switch (outcome.kind) {
        case "unknown":
          process.stderr.write(`forge recover: unknown id '${outcome.id}' — not a task or run\n`);
          process.exit(1);
          break;
        case "bad-usage":
          process.stderr.write(`forge recover: ${outcome.reason}\n`);
          process.exit(1);
          break;
        case "inspect-task":
          console.log(`Task ${outcome.task.taskId} — recoverable evidence:`);
          console.log(renderTaskEvidence(outcome.task).join("\n"));
          break;
        case "inspect-fanout-parent":
          console.log(`Fanout parent ${outcome.parent.parentId} — recoverable evidence:`);
          console.log(renderFanoutView(outcome.parent).join("\n"));
          break;
        case "inspect-run": {
          if (outcome.tasks.length === 0 && outcome.fanoutParents.length === 0) {
            console.log(`Run ${outcome.runId} has no recoverable tasks.`);
            break;
          }
          console.log(`Run ${outcome.runId} — ${outcome.tasks.length} recoverable task(s), ${outcome.fanoutParents.length} fanout parent(s):`);
          for (const t of outcome.tasks) console.log(renderTaskEvidence(t).join("\n"));
          for (const f of outcome.fanoutParents) console.log(renderFanoutView(f).join("\n"));
          break;
        }
        case "continued":
          console.log(`Adopted persisted work for ${outcome.taskId} (from ${outcome.adoptedFrom}) — marked complete.`);
          break;
        case "continue-refused":
          process.stderr.write(`forge recover --continue: refused — ${outcome.reason}\n`);
          process.exit(1);
          break;
        case "re-drive-done":
          if (outcome.lane === "ordered_reopened_in_place") {
            console.log(
              `Re-drove ordered fanout parent ${outcome.parentId} in place (failure_kind=${outcome.authorizingFailureKind}) — ` +
                "reopened to pending, keeping its captured children. Items whose commits are already integrated will be adopted, not re-run.",
            );
          } else {
            console.log(`Re-drove fanout parent ${outcome.parentId} — new pending primary ${outcome.newTaskId} created.`);
          }
          if (outcome.runReactivated) console.log(`Run ${outcome.runId} reactivated (failed → active).`);
          console.log(`Next:\n  forge next ${outcome.runId}`);
          break;
        case "re-drive-refused":
          process.stderr.write(`forge recover --re-drive: refused — ${outcome.reason}\n`);
          process.exit(1);
          break;
      }
    });
}
