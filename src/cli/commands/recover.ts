// FG-455 p3: `forge recover` — operator-safe recovery for tasks/runs left
// behind by a lost container. Reliability policy: prefer fail-safe refusal
// over false success; never silently discard persisted work. Default mode is
// read-only inspection; mutation (--continue / --re-drive) requires an
// explicit flag AND passes a recoverability check, writing nothing on refusal.

import type { Command } from "commander";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Task, Run } from "../../types/index.js";
import { getTask, tasksForRun, markTaskRecovered, insertTask } from "../../store/tasks.js";
import { getRun } from "../../store/runs.js";
import { logEvent, eventsForTask } from "../../store/events.js";
import { ensureForgeDirs, taskDir } from "../../util/paths.js";
import { acquireRunLock, releaseRunLock } from "../../util/run-lock.js";
import { newTaskId, nowIso } from "../../util/ids.js";
import { failureKindForTask, getOrphanEvidenceFromEvents } from "../../v2/failure-kind.js";
import type { OrphanEvidence } from "../../v2/failure-kind.js";
import { changedWorktreeFiles, defaultContainerAlive, reconcileRun } from "../../v2/reconcile.js";
import type { ContainerAlive } from "../../v2/reconcile.js";
import { getManifestRuntime } from "../../v2/task-manifest.js";
import { analyzeProviderFailure } from "../../v2/provider-failure.js";
import { inferredResultFrom, type InferredResult } from "../../v2/inferred-result.js";

const CONTINUABLE_KINDS = new Set(["orphaned", "orphaned_work_may_persist"]);
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

function inferStdoutResult(task: Task): InferredResult | undefined {
  try {
    const dir = taskDir(task.runId, task.id);
    const runtimeMeta = getManifestRuntime(dir);
    const stdoutRaw = readStdoutLog(task.runId, task.id);
    const analysis = analyzeProviderFailure({
      logFormat: runtimeMeta?.logFormat,
      runtimeKind: runtimeMeta?.kind,
      stdoutRaw,
    });
    return inferredResultFrom(analysis, task.agentRole);
  } catch {
    return undefined;
  }
}

type LiveEvidence = {
  worktreePathChecked: string | null;
  source: "worktree" | "project_dir_shared";
  changedFiles: string[];
  validResult?: unknown;
  stdoutInferredResult?: InferredResult;
};

function gatherLiveEvidence(task: Task, run: Run): LiveEvidence {
  const worktreePathChecked = task.worktreePath ?? run.projectDir;
  const source: LiveEvidence["source"] = task.worktreePath ? "worktree" : "project_dir_shared";
  const changedFiles = changedWorktreeFiles(worktreePathChecked);
  const validResult = readResult(task.runId, task.id);
  const stdoutInferredResult = validResult === undefined ? inferStdoutResult(task) : undefined;
  return { worktreePathChecked: worktreePathChecked ?? null, source, changedFiles, validResult, stdoutInferredResult };
}

function recommendationFor(task: Task, evidence: LiveEvidence): string {
  if (evidence.validResult !== undefined || evidence.stdoutInferredResult !== undefined) {
    return evidence.source === "project_dir_shared"
      ? `forge recover ${task.id} --continue --force  (shared project dir — confirm the diff is this task's before forcing)`
      : `forge recover ${task.id} --continue`;
  }
  if (evidence.changedFiles.length > 0) {
    return evidence.source === "project_dir_shared"
      ? `forge recover ${task.id} --continue --force  (shared project dir — confirm the diff is this task's before forcing)`
      : `forge recover ${task.id} --continue`;
  }
  return `forge retry ${task.id}  (no persisted work found — safe to re-dispatch from scratch)`;
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
  verification: string;
};

function buildTaskView(task: Task, run: Run): TaskEvidenceView {
  const failureKind = failureKindForTask(task.id);
  const storedEvidence = getOrphanEvidenceFromEvents(eventsForTask(task.id));
  const evidence = gatherLiveEvidence(task, run);
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
    hasStdoutRecoverableResult: evidence.stdoutInferredResult !== undefined,
    recommendation: recommendationFor(task, evidence),
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

export type RecoverOutcome =
  | { kind: "inspect-task"; task: TaskEvidenceView }
  | { kind: "inspect-fanout-parent"; parent: FanoutParentView }
  | { kind: "inspect-run"; runId: string; tasks: TaskEvidenceView[]; fanoutParents: FanoutParentView[] }
  | { kind: "continued"; taskId: string; runId: string; adoptedFrom: "result_json" | "stdout_inferred" | "diff_adopted"; result: unknown }
  | { kind: "continue-refused"; id: string; reason: string }
  | { kind: "re-drive-done"; parentId: string; runId: string; newTaskId: string }
  | { kind: "re-drive-refused"; id: string; reason: string }
  | { kind: "bad-usage"; id: string; reason: string }
  | { kind: "unknown"; id: string };

// ── default: read-only inspection ───────────────────────────────────────────

export function performInspect(id: string): RecoverOutcome {
  const task = getTask(id);
  if (task) {
    const run = getRun(task.runId);
    if (!run) return { kind: "unknown", id };
    const allTasks = tasksForRun(task.runId);
    if (isFanoutParent(task, allTasks)) {
      return { kind: "inspect-fanout-parent", parent: buildFanoutView(task, allTasks) };
    }
    return { kind: "inspect-task", task: buildTaskView(task, run) };
  }

  const run = getRun(id);
  if (run) {
    const allTasks = tasksForRun(run.id);
    const tasks = allTasks
      .filter((t) => t.status === "failed" && CONTINUABLE_KINDS.has(failureKindForTask(t.id) ?? ""))
      .map((t) => buildTaskView(t, run));
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

  const failureKind = failureKindForTask(taskId);
  if (task.status !== "failed" || !CONTINUABLE_KINDS.has(failureKind ?? "")) {
    return {
      kind: "continue-refused",
      id: taskId,
      reason:
        `task ${taskId} is not in a recoverable state (status=${task.status}, failure_kind=${failureKind ?? "none"}) — ` +
        "--continue only applies to a failed task orphaned by a lost container (failure_kind orphaned / orphaned_work_may_persist)",
    };
  }

  const evidence = gatherLiveEvidence(task, run);
  const adopted: { result: unknown; adoptedFrom: "result_json" | "stdout_inferred" | "diff_adopted" } | undefined =
    evidence.validResult !== undefined
      ? { result: evidence.validResult, adoptedFrom: "result_json" }
      : evidence.stdoutInferredResult !== undefined
        ? { result: evidence.stdoutInferredResult, adoptedFrom: "stdout_inferred" }
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
    if (!markTaskRecovered(task.id, adopted.result)) {
      return { kind: "continue-refused", id: taskId, reason: `task ${taskId} was concurrently finalized by another process — not overwriting` };
    }
    // Best-effort disk write, mirroring reconcile.ts: completion proceeds from
    // the in-memory result regardless of whether the write below succeeds.
    try {
      writeFileSync(join(taskDir(task.runId, task.id), "result.json"), JSON.stringify(adopted.result));
    } catch {
      // best-effort only
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

// ── --re-drive: clean in-run re-drive of an orphaned fanout wave ────────────
//
// Mechanism: mint a fresh pending PRIMARY task (parentId undefined) in the
// SAME phase as the fanout step — byte-for-byte the same shape gate.ts's
// request-changes already uses to re-drive a step, a pattern dispatchFanoutStep
// is proven to reuse cleanly (its existingParent lookup finds the lone pending
// primary in the phase and dispatches a fresh wave). The old parent and its
// children are left in place as an audit trail (same convention as `forge
// retry` elsewhere) — dispatchFanoutStep always mints brand-new child rows on
// dispatch, so there is no "resume only the failed children" mechanism to hook
// into without deep dispatchFanoutStep surgery; this re-drives the FULL wave.

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

  const allTasks = tasksForRun(parent.runId);
  const dupePending = allTasks.find((t) => t.phase === parent.phase && t.parentId === undefined && t.status === "pending");
  if (dupePending) {
    return {
      kind: "re-drive-refused",
      id,
      reason: `a re-drive is already pending as ${dupePending.id} — run \`forge next ${parent.runId}\` to dispatch it instead of re-driving again`,
    };
  }

  acquireRunLock(parent.runId, "recover --re-drive");
  let newId: string;
  try {
    newId = newTaskId(parent.phase);
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
          previous_failure: { kind: "fanout_wave_orphaned", error: parent.error ?? null, failedTaskId: parent.id },
        },
        composedSystemPrompt: "",
      },
      createdAt: nowIso(),
    };
    insertTask(newTask);
    logEvent("task.created", {
      runId: parent.runId,
      taskId: newId,
      payload: { fanoutParent: true, from: "forge recover --re-drive", previousParentId: parent.id },
    });
    logEvent("task.reconciled", {
      runId: parent.runId,
      taskId: parent.id,
      payload: { from: "failed", to: "redriven", reason: "fanout_wave_redriven", via: "forge recover --re-drive", newTaskId: newId },
    });
  } finally {
    releaseRunLock(parent.runId);
  }

  return { kind: "re-drive-done", parentId: parent.id, runId: parent.runId, newTaskId: newId };
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
  return performInspect(id);
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
          console.log(`Re-drove fanout parent ${outcome.parentId} — new pending primary ${outcome.newTaskId} created.`);
          console.log(`Next:\n  forge next ${outcome.runId}`);
          break;
        case "re-drive-refused":
          process.stderr.write(`forge recover --re-drive: refused — ${outcome.reason}\n`);
          process.exit(1);
          break;
      }
    });
}
