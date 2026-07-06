// forge v2 — runNext: dispatch one wave of ready steps.
//
// One invocation = one wave. Computes ready queue from SQLite state, spawns
// each ready step in parallel, awaits all, writes results to SQLite, returns.
//
// The orchestrator (the conversational agent) calls runNext in a loop. Between
// invocations it decides whether to advance gates (calling forge gate ...) or
// surface to the human. The runner itself is dumb — it doesn't know about
// gates beyond "step transitions to awaiting_gate" being a terminal state for
// this invocation.
//
// The v2 runner core: callable as a library and invoked by `forge next`
// (src/cli/commands/next.ts).
//
// See DECISIONS.md for the architectural calls made here.

import { existsSync, mkdirSync, writeFileSync, readFileSync, chmodSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolveIdleTimeoutMs, IDLE_TIMEOUT_EXIT_CODE } from "./idle-watchdog.js";
import {
  DEPENDENCY_PROVISIONING_FAILED_EXIT_CODE,
  DEPENDENCY_PROVISIONER_IDLE_TIMEOUT_MS,
  safeLockfileHash,
  isDependencyCacheReady,
  provisionDependencyCache,
  planDependencyVolumes,
  provisionerContainerName,
  type DependencyVolumePlan,
} from "./dependency-provisioning.js";
import { defaultDockerExec, type DockerExecArgs, type DockerExecFn } from "./docker-exec.js";
import { join } from "node:path";
import type { Task, TaskPackage, Verdict, Finding, RedAuthority, ReviewerContextPacket, DoneAuditResult } from "../types/index.js";
import type { Workflow, Step, Runtime, RedDef, FanoutDef } from "./schema.js";
import { resolveRuntimeMetadata } from "./schema.js";
import { analyzeProviderFailure } from "./provider-failure.js";
import { tasksForRun } from "../store/tasks.js";
import { getRun, updateRunStatus } from "../store/runs.js";
import { notifyOnTaskBlockedByRed, notifyOnGateAwaiting } from "../notify/trigger.js";
import { insertTask, getTask, markTaskRunning, markTaskComplete, markTaskAwaitingGate, markTaskFailed, setTaskStatus, setTaskWorktreePath } from "../store/tasks.js";
import { failTask, classify, ORPHAN_EVIDENCE_KINDS } from "./failure-kind.js";
import type { FailureKind, OrphanEvidence } from "./failure-kind.js";
import { captureUsageForTask } from "../store/model-calls.js";
import { insertVerdict, verdictsForTask } from "../store/verdicts.js";
import { getDb } from "../store/db.js";
import { assembleReviewerContextPacket } from "./reviewer-context-packet.js";
import { validateVerdict } from "./validate-findings.js";
import { gradeFindings } from "./review-quality.js";
import { logEvent } from "../store/events.js";
import { taskDir, integrationWorktreeDir } from "../util/paths.js";
import { computeReadyQueue } from "./ready-queue.js";
import { finalizeOrphanedPrimaries, attachedExitEvidence } from "./reconcile.js";
import { checkResultPersistence, persistenceErrorMessage } from "./persistence-check.js";
import { runIntegrationGate } from "./integration-gate.js";
import { deriveUpstream } from "./inputs.js";
import { composeSystemPrompt } from "./compose.js";
import { filterConstraints, loadAllConstraints } from "./constraints.js";
import { buildDockerArgs, buildProvisionerDockerArgs, resolveProjectContainerPath, preflightProjectMount, type SpawnContext } from "./spawn.js";
import { resolveAuthStateForContainer, AuthProfileError, roleUsesBrowser, cleanupStagedAuth } from "./auth-state.js";
import { loadProjectAuthProfile, resolveProjectAuthForContainer, ProjectAuthError } from "./project-auth.js";
import { writeTaskManifest, manifestControlPlaneBlock } from "./task-manifest.js";
import { resolveDocsSurfacesReceipt } from "./contract.js";
import { emitAgentProgressEvents } from "./agent-progress.js";
import { loadRuntimeWithSource, loadModelPolicyWithSource, loadWorkflowWithSource } from "./loader.js";
import {
  resolveModel,
  taskModelFields,
  manifestModelBlock,
  type ModelResolution,
} from "./model-resolution.js";
import { checkResolvedAvailability, checkToolCapability } from "./provider-doctor.js";
import { CONTROL_PLANE_METADATA_KEYS } from "./startRun.js";
import { newTaskId, newVerdictId, nowIso } from "../util/ids.js";
import { fillClosedCommit } from "../backlog/structured.js";
import { inferredResultFrom } from "./inferred-result.js";
// FG-351/FG-352: worktree lifecycle — gate check, create, merge-back, cleanup.
// FG-353: integration worktree helpers added.
import {
  isWorktreeModeEnabled,
  preflightWorktreeGate,
  createWorktree,
  mergeWorktreeBranch,
  removeWorktreeIfSafe,
  cleanupFailedWorktreeSetup,
  integrationBranchName,
  integrationBranchExists,
  createIntegrationWorktree,
  mergeChildIntoIntegration,
  mergeIntegrationBranchToHead,
  cleanupIntegrationWorktree,
} from "./worktree-lifecycle.js";

// Resolve the agent role for a fanout child. When fanout.agent_map is set and
// the input value carries a discipline string that's in the map, route to the
// mapped specialist. Otherwise fall back to step.agent. Exported for testing.
export function resolveChildAgent(step: Step, fanout: FanoutDef, value: unknown): string {
  const fallback = step.agent!;
  if (!fanout.agent_map) return fallback;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return fallback;
  const key = fanout.discipline_key ?? "discipline";
  const discipline = (value as Record<string, unknown>)[key];
  if (typeof discipline !== "string") return fallback;
  return fanout.agent_map[discipline] ?? fallback;
}

export type RunNextResult = {
  dispatchedSteps: string[];      // step ids that got dispatched this call
  completedSteps: string[];       // step ids that completed (auto gate)
  awaitingGate: string[];         // step ids that hit awaiting_gate (human/verdict)
  failedSteps: string[];          // step ids that failed
  runStatus: string;              // post-call run status
};

export async function runNext(args: {
  runId: string;
  workflow: Workflow;
  // For testing: override the docker spawn. Real callers leave this undefined
  // and the real `docker run ...` is invoked via buildDockerArgs + child_process.
  dockerExec?: DockerExecFn;
}): Promise<RunNextResult> {
  const run = getRun(args.runId);
  if (!run) throw new Error(`runNext: run not found: ${args.runId}`);

  if (run.status !== "active") {
    return {
      dispatchedSteps: [],
      completedSteps: [],
      awaitingGate: [],
      failedSteps: [],
      runStatus: run.status,
    };
  }

  // Self-heal orphaned duplicate primaries before computing the ready queue, so a
  // stranded pending retry-primary neither poisons phase advancement nor keeps the
  // run from completing at the end. No-op on healthy runs.
  finalizeOrphanedPrimaries(args.runId);

  const tasks = tasksForRun(args.runId);
  const ready = computeReadyQueue(args.workflow, tasks);

  if (ready.length === 0) {
    // Either everything's done, gated, or running (some other runNext is in flight).
    return {
      dispatchedSteps: [],
      completedSteps: [],
      awaitingGate: [],
      failedSteps: [],
      runStatus: run.status,
    };
  }

  if (!run.projectDir) {
    throw new Error(`runNext: run ${args.runId} has no projectDir set — cannot spawn containers`);
  }

  // Read --design-dir if set on this run (stored as run.metadata.designDir per
  // #114 + the existing spine pattern).
  const designDir = typeof run.metadata?.["designDir"] === "string"
    ? (run.metadata["designDir"] as string)
    : undefined;

  // Dispatch all ready steps in parallel (Promise.all → "parallel within wave").
  // Each dispatchStep returns the post-dispatch task status for its step.
  const dispatched: string[] = ready.map((s) => s.id);
  const outcomes = await Promise.all(
    ready.map((step) => dispatchStep({
      runId: args.runId,
      workflow: args.workflow,
      step,
      projectDir: run.projectDir!,
      designDir,
      runMetadata: run.metadata ?? {},
      dockerExec: args.dockerExec,
    }))
  );

  const completed: string[] = [];
  const awaitingGate: string[] = [];
  const failed: string[] = [];
  for (let i = 0; i < ready.length; i++) {
    const stepId = ready[i]!.id;
    const status = outcomes[i]!;
    if (status === "complete") completed.push(stepId);
    else if (status === "awaiting_gate" || status === "blocked_by_red") awaitingGate.push(stepId);
    else if (status === "failed") failed.push(stepId);
  }

  // If every step completed and no more steps remain ready in the workflow,
  // the run is done. Check by recomputing after this wave's writes.
  const tasksAfter = tasksForRun(args.runId);
  const readyAfter = computeReadyQueue(args.workflow, tasksAfter);
  const allStepsHaveTasks = args.workflow.steps.every((s) =>
    tasksAfter.some((t) => t.phase === s.id && t.parentId === undefined)
  );
  const noPendingWork = tasksAfter.every(
    (t) => t.status === "complete" || t.status === "failed" || t.parentId !== undefined
  );

  let runStatus: string = run.status;
  // Re-read the status: a concurrent `forge cancel` may have abandoned the run
  // while this wave ran. An abandoned run is authoritatively terminal — don't
  // flip it back to complete (AWN-2 cancel-vs-completion coherence).
  const currentStatus = getRun(args.runId)?.status ?? run.status;
  if (currentStatus !== "abandoned" && readyAfter.length === 0 && allStepsHaveTasks && noPendingWork) {
    // RunStatus union is "active" | "complete" | "abandoned" — there's no
    // "failed" state for runs. Mark complete regardless; the human / orchestrator
    // reads task statuses to know whether the run failed. Aligns with how the
    // v1 spine treats run completion.
    // A superseded failed task (request-changes audit record) must not count:
    // it is superseded when another top-level task in the same phase is NOT
    // failed (i.e. a successful replacement exists).
    const topLevelByPhase = tasksAfter.filter((t) => t.parentId === undefined);
    const anyFailed = topLevelByPhase.some(
      (t) =>
        t.status === "failed" &&
        !topLevelByPhase.some((other) => other.phase === t.phase && other.status !== "failed"),
    );
    runStatus = "complete";
    updateRunStatus(args.runId, "complete");
    logEvent("run.completed", { runId: args.runId, payload: { anyFailed } });
  } else if (currentStatus === "abandoned") {
    runStatus = "abandoned";
  }

  return {
    dispatchedSteps: dispatched,
    completedSteps: completed,
    awaitingGate,
    failedSteps: failed,
    runStatus,
  };
}

// Dispatch one step: create task row, spawn container (or stub), read result,
// write status. Returns the post-dispatch task status string.
async function dispatchStep(args: {
  runId: string;
  workflow: Workflow;
  step: Step;
  projectDir: string;
  designDir?: string;
  runMetadata: Record<string, unknown>;
  dockerExec?: DockerExecFn;
}): Promise<string> {
  const step = args.step;

  // For manual steps: create task at pending, never spawn. The runner returns
  // immediately; the orchestrator advances it via forge gate when done.
  if (step.manual) {
    return dispatchManualStep(args.runId, step);
  }

  // Fanout: one parent task, N children. Each child runs the same agent
  // against a single array element. Aggregation policy follows failure_mode.
  if (step.fanout) {
    return dispatchFanoutStep({
      runId: args.runId,
      workflow: args.workflow,
      step,
      fanout: step.fanout,
      projectDir: args.projectDir,
      designDir: args.designDir,
      runMetadata: args.runMetadata,
      dockerExec: args.dockerExec,
    });
  }

  return dispatchSingleStep({
    runId: args.runId,
    workflow: args.workflow,
    step,
    projectDir: args.projectDir,
    designDir: args.designDir,
    runMetadata: args.runMetadata,
    dockerExec: args.dockerExec,
  });
}

// Standard single-agent dispatch. Spawns primary, then any reds (in parallel),
// aggregates verdicts, sets final status per gate + verdict policy.
async function dispatchSingleStep(args: {
  runId: string;
  workflow: Workflow;
  step: Step;
  projectDir: string;
  designDir?: string;
  runMetadata: Record<string, unknown>;
  dockerExec?: DockerExecFn;
  parentId?: string;            // set when this dispatch is a fanout child
  fanoutInput?: { key: string; value: unknown };  // forwarded into task inputs
  syntheticPhase?: string;      // override phase id for fanout children (e.g. "build-0")
}): Promise<string> {
  const step = args.step;
  const agentRole = step.agent!;
  const phase = args.syntheticPhase ?? step.id;

  // Find or create a pending task row for this step. If a pending row exists
  // (e.g. from request-changes), reuse it; otherwise create fresh. Reuse only
  // applies to primary (non-child) dispatch — fanout children are always fresh.
  const existing = args.parentId === undefined
    ? tasksForRun(args.runId).find(
        (t) => t.phase === phase && t.status === "pending" && t.parentId === undefined
      )
    : undefined;
  const taskId = existing?.id ?? newTaskId(phase);

  const allTasks = tasksForRun(args.runId);
  const upstream = deriveUpstream({
    step,
    allTasks,
    runDir: join(homeForge(), "runs", args.runId),
  });

  // Inputs precedence (low → high):
  //   1. Run metadata (brief, question, prd, custom keys from --meta) — global to the run
  //   2. upstream (always present, may be empty array)
  //   3. fanoutInput (per-child key/value for fanout dispatches)
  // designDir is intentionally NOT poured into inputs — it's a mount, not a task field.
  // When REUSING a pending row (forge retry, gate request-changes), start from
  // the context it was created with so carried fields survive — previous_failure
  // (retry, AWN-3) and requestedChanges (request-changes). run metadata +
  // freshly-derived upstream layer on top and win on shared keys. A fresh
  // dispatch has no carried inputs, so this is a no-op there.
  const carried = (existing?.taskPackage?.inputs as Record<string, unknown> | undefined) ?? {};
  const inputs: Record<string, unknown> = { ...carried, ...args.runMetadata, upstream };
  // Control-plane metadata (designDir/authProfile/modelProfile/workspace) lives
  // at the mount / policy / scoping layer — never expose it as an input value,
  // or e.g. the pinned profile name would ride into the composed prompt.
  for (const key of CONTROL_PLANE_METADATA_KEYS) delete inputs[key];
  if (args.fanoutInput) {
    inputs[args.fanoutInput.key] = args.fanoutInput.value;
  }

  const taskPackage: TaskPackage = {
    taskId,
    runId: args.runId,
    phase,
    role: agentRole,
    inputs,
    composedSystemPrompt: composeSystemPrompt({
      role: agentRole,
      workflow: args.workflow,
      step,
      runTags: runTagsFromMetadata(args.runMetadata),
    }),
  };

  // AWN-7: resolve the model once (capability + profile). Computed regardless of
  // `existing` because runContainer needs the runtime/model even on a re-dispatch;
  // the resolved_* row fields are written only on first creation.
  const resolution = resolveModel({
    agentRole,
    stepAlias: step.activity,
    runtimeName: step.runtime,
    cliProfile: runModelProfile(args.runMetadata),
    profileSource: "run.profile",
    ctx: { projectDir: args.projectDir },
  });

  if (!existing) {
    const task: Task = {
      id: taskId,
      runId: args.runId,
      parentId: args.parentId,
      phase,
      agentRole,
      ...taskModelFields(resolution, step.activity),
      status: "pending",
      taskPackage,
      createdAt: new Date().toISOString(),
    };
    insertTask(task);
    // Primary-step tasks were the one creation path that never logged
    // task.created (reds/fanout/manual all do) — leaving a gap in the forge
    // show timeline. Emit it here so every task's lifecycle starts with a
    // creation event.
    logEvent("task.created", { runId: args.runId, taskId });
  }

  // FG-350: build control-plane receipt inputs from run metadata. routeReceipt
  // and workflowReceipt are RECORDED at startRun (step 3); constraint counts are
  // computed at dispatch time scoped to this specific task slot.
  const workflowReceipt = args.runMetadata["workflowReceipt"] as
    | { source: "host" | "project"; path: string }
    | undefined;
  const routeReceipt = args.runMetadata["routeReceipt"] as
    | Record<string, unknown>
    | undefined;
  const cpRunTags = runTagsFromMetadata(args.runMetadata);
  const cpConstraints = loadAllConstraints(join(homeForge(), "constraints"));
  const cpSuggestCount = filterConstraints(cpConstraints, {
    role: agentRole,
    workflow: args.workflow.name,
    phase,
    level: "suggest",
    runTags: cpRunTags,
  }).length;
  const cpForceCount = filterConstraints(cpConstraints, {
    role: agentRole,
    workflow: args.workflow.name,
    phase,
    level: "force",
    runTags: cpRunTags,
  }).length;
  const cpWorkflowProv = resolveWorkflowSource(args.workflow.name, args.projectDir, workflowReceipt);

  // FG-374/FG-351 gate ordering: preflightProjectMount must run BEFORE any state
  // mutation (worktree creation or DB write). A failed preflight must not leave a
  // leaked worktree or a stale task row. preflightProjectMount also runs inside
  // runContainer as a safety net for the red path; this call takes precedence for
  // primary dispatch so the worktree block is never reached on a bad mount.
  try {
    preflightProjectMount(args.projectDir);
  } catch (e) {
    const msg = `preflightProjectMount failed: ${(e as Error).message}`;
    failTask(taskId, { runId: args.runId, kind: classify({}), error: msg });
    return "failed";
  }

  // FG-351: create a task-scoped git worktree when worktree mode is enabled.
  // preflightWorktreeGate + createWorktree run BEFORE runContainer; the DB write
  // (setTaskWorktreePath) is durable BEFORE the container starts so reconcile can
  // find the path after a process restart. checkResultPersistence keeps args.projectDir
  // (the original host mount) — that seam is owned by FG-354.
  let primaryWorktreePath: string | undefined;
  if (isWorktreeModeEnabled()) {
    try {
      preflightWorktreeGate(args.projectDir);
      const wt = createWorktree(args.projectDir, args.runId, taskId);
      primaryWorktreePath = wt.worktreePath;
      setTaskWorktreePath(taskId, primaryWorktreePath);
      // Operator diagnostic: untracked/ignored host files are NOT in the worktree.
      // Git worktrees carry committed/tracked content only. Emit a warning so the
      // limitation is visible in forge logs even before a dedicated event type lands.
      if (wt.untrackedFiles.length > 0) {
        process.stderr.write(
          `[forge/worktree] task ${taskId}: ${wt.untrackedFiles.length} untracked host file(s) not in worktree: ${wt.untrackedFiles.slice(0, 5).join(", ")}${wt.untrackedFiles.length > 5 ? ` (+${wt.untrackedFiles.length - 5} more)` : ""}\n`
        );
      }
    } catch (e) {
      // Gate or create failure: no durable DB state to unwind (setTaskWorktreePath
      // only runs after a successful createWorktree), but the task must not stay
      // stuck in pending — transition to failed so the run can report the error.
      // cleanupFailedWorktreeSetup is NOT EPHEMERAL-gated: the agent never ran,
      // so there is no output to preserve — always safe to remove partial state.
      const msg = `worktree setup failed: ${(e as Error).message}`;
      cleanupFailedWorktreeSetup(args.projectDir, args.runId, taskId);
      failTask(taskId, { runId: args.runId, kind: classify({}), error: msg });
      return "failed";
    }
  }

  const dispatchResult = await runContainer({
    taskId,
    runId: args.runId,
    projectDir: args.projectDir,
    worktreePath: primaryWorktreePath,
    projectMode: "rw",
    designDir: args.designDir,
    taskPackage,
    resolution,
    workflowAlias: step.activity,
    authProfile: authProfileForRole(args.runMetadata, agentRole),
    role: agentRole,
    dockerExec: args.dockerExec,
    controlPlaneInputs: {
      workflowName: args.workflow.name,
      workflowSource: cpWorkflowProv.source,
      workflowPath: cpWorkflowProv.path,
      workflowWarnings: cpWorkflowProv.warnings,
      routeReceipt,
      suggestCount: cpSuggestCount,
      forceCount: cpForceCount,
      // FG-374: thread from run metadata (recorded by startRun); absent on
      // runs created before FG-374 — optional fields keep this legacy-safe.
      invocationCwd: typeof args.runMetadata["invocationCwd"] === "string"
        ? args.runMetadata["invocationCwd"]
        : undefined,
      resolvedFromSubdir: args.runMetadata["resolvedFromSubdir"] === true
        ? true
        : undefined,
      explicitSubproject: args.runMetadata["explicitSubproject"] === true
        ? true
        : undefined,
    },
  });

  if (dispatchResult.kind === "failed") {
    return "failed";
  }

  const result = dispatchResult.result;

  // #254: persistence assertion. If the agent reports a complete result with
  // files_modified but none of those files landed on the host project mount, the
  // work was written to an ephemeral path and discarded — fail loudly (don't run
  // reds, don't gate over an empty diff) instead of advancing on a green lie.
  const persistence = await checkResultPersistence(primaryWorktreePath ?? args.projectDir, result);
  if (!persistence.ok) {
    const error = persistenceErrorMessage(persistence);
    failTask(taskId, { runId: args.runId, kind: "work_not_persisted", error, result });
    return "failed";
  }

  // FG-352: merge the task worktree branch into run.projectDir (main checkout).
  // Skipped entirely when primaryWorktreePath is undefined — the default/non-worktree
  // path is byte-for-byte unchanged.
  if (primaryWorktreePath) {
    const merge = mergeWorktreeBranch(args.projectDir, primaryWorktreePath, args.runId, taskId);
    if (!merge.ok) {
      failTask(taskId, { runId: args.runId, kind: "merge_conflict", error: merge.error, result });
      // Retain worktree and branch for inspection — do NOT call removeWorktreeIfSafe.
      return "failed";
    }
    // FG-357: post-merge integration gate. The merge above only proves the
    // worktree branch fast-forwarded cleanly — it does NOT prove the merged
    // tree still builds+tests. Gate here, before reds dispatch / phase advance,
    // and return BEFORE any cleanup so the worktree/branch stay available for
    // inspection (mirrors the merge_conflict no-discard contract above).
    const gate = runIntegrationGate(args.projectDir);
    if (!gate.ok) {
      failTask(taskId, {
        runId: args.runId,
        kind: classify({ integrationGate: { status: gate.status, signal: gate.signal, timedOut: gate.timedOut } }),
        error: `post-merge integration gate failed: ${gate.error}\n${gate.output}`,
        result,
      });
      return "failed";
    }

    // FG-367: best-effort gap-fill — record the merge-HEAD SHA on the ticket
    // when the agent did not capture it at close time. Swallowed entirely so
    // a git or backlog error never fails the run.
    try {
      const headSha = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: args.projectDir,
        encoding: "utf8",
        timeout: 5000,
      });
      const ticketId = getRun(args.runId)?.title;
      if (ticketId) {
        fillClosedCommit(args.projectDir, ticketId, headSha.trim());
      }
    } catch {
      // swallow — gap-fill is advisory, must not fail the run
    }
  }

  // Reds: spawn after primary completes. Each red is a child task.
  // Aggregate verdicts then set primary status per policy.
  if (step.reds.length > 0) {
    // Per FORGE-DEC-017: blue is done, reds are about to run.
    setTaskStatus(taskId, "awaiting_red");
    logEvent("task.awaiting_red", { runId: args.runId, taskId });

    const aggregate = await dispatchReds({
      runId: args.runId,
      workflow: args.workflow,
      step,
      primaryTaskId: taskId,
      primaryResult: result,
      projectDir: args.projectDir,
      designDir: args.designDir,
      runMetadata: args.runMetadata,
      dockerExec: args.dockerExec,
    });

    // Aggregation policy mirrors v1 gate.ts:
    //   - any authoritative fail with gate_on_verdict ⇒ blocked_by_red
    //   - otherwise (verdict gate) ⇒ awaiting_gate (orchestrator/human reads verdicts)
    //   - gate: auto with no authoritative fail ⇒ complete
    if (aggregate.authoritativeFail) {
      setTaskStatus(taskId, "blocked_by_red");
      logEvent("task.blocked_by_red", { runId: args.runId, taskId });
      // Persist the result.json content too (test assertions need it).
      markTaskAwaitingGate(taskId, result);
      // markTaskAwaitingGate just wrote status=awaiting_gate; restore the block.
      setTaskStatus(taskId, "blocked_by_red");
      // Fire-and-forget SMS notification (no-op unless FORGE_NOTIFY=twilio).
      const runForNotify = getRun(args.runId);
      if (runForNotify) void notifyOnTaskBlockedByRed(runForNotify);
      return "blocked_by_red";
    }
    // No authoritative fail — proceed to normal gate semantics.
    const statusAfterReds = finalizePrimary(taskId, args.runId, step.gate, result);
    // FG-352: cleanup after proven-merged worktree (provenMerged=true because
    // the merge-back succeeded above). Also removes in EPHEMERAL test mode.
    if (statusAfterReds === "complete" && primaryWorktreePath) {
      removeWorktreeIfSafe(primaryWorktreePath, args.runId, taskId, args.projectDir, true);
    }
    return statusAfterReds;
  }

  const finalStatus = finalizePrimary(taskId, args.runId, step.gate, result);
  // FG-352: cleanup after proven-merged worktree (provenMerged=true because
  // the merge-back succeeded above). Also removes in EPHEMERAL test mode.
  if (finalStatus === "complete" && primaryWorktreePath) {
    removeWorktreeIfSafe(primaryWorktreePath, args.runId, taskId, args.projectDir, true);
  }
  return finalStatus;
}

// Final status write for a primary task (no reds path, or reds passed).
function finalizePrimary(taskId: string, runId: string, gate: Step["gate"], result: unknown): string {
  switch (gate) {
    case "auto":
    case "none":
      // AWN-2 task-level race: don't overwrite a task a concurrent cancel already
      // marked failed. The CAS only completes a non-terminal task; if it didn't,
      // report the task's actual (cancelled/failed) terminal status.
      if (!markTaskComplete(taskId, result)) {
        return getTask(taskId)?.status ?? "failed";
      }
      logEvent("task.completed", { runId, taskId });
      return "complete";
    case "human":
      markTaskAwaitingGate(taskId, result);
      logEvent("task.awaiting_gate", { runId, taskId });
      notifyGateAwaiting(taskId);
      return "awaiting_gate";
    case "verdict":
      // Schema enforces reds.length > 0 for gate=verdict, so this is reached
      // only when all reds passed (or none authoritative-failed). Aggregate
      // outcome is the orchestrator's call; pause for it.
      markTaskAwaitingGate(taskId, result);
      logEvent("task.awaiting_gate", { runId, taskId });
      notifyGateAwaiting(taskId);
      return "awaiting_gate";
  }
}

// Fire-and-forget "forge is blocked on you" push when a task pauses for a gate.
// Looks up the run via the task so callers needn't thread runId; the trigger
// itself swallows provider failures, so this never throws.
function notifyGateAwaiting(taskId: string): void {
  const task = getTask(taskId);
  if (!task) return;
  const run = getRun(task.runId);
  if (run) void notifyOnGateAwaiting(run, task);
}

// Spawn reds for a primary task. Each red runs in parallel, in a read-only
// container, against the primary's result.json as the artifact. Returns
// aggregate verdict summary.
async function dispatchReds(args: {
  runId: string;
  workflow: Workflow;
  step: Step;
  primaryTaskId: string;
  primaryResult: unknown;
  projectDir: string;
  designDir?: string;
  runMetadata: Record<string, unknown>;
  dockerExec?: DockerExecFn;
}): Promise<{ verdicts: Verdict[]; authoritativeFail: boolean }> {
  const artifact = JSON.stringify(args.primaryResult, null, 2);
  const allTasks = tasksForRun(args.runId);
  const spec = buildRedSpec(args.workflow, allTasks);

  // FG-381: detect shipping-reviewer and assemble context packet ONCE before dispatch.
  const shippingReviewerRed = args.step.reds.find((r) => r.agent === "shipping-reviewer");
  let reviewerContextPacket: ReviewerContextPacket | undefined;
  let shippingReviewerPreFailed = false;
  if (shippingReviewerRed) {
    const packet = assembleReviewerContextPacket(args.runId, args.primaryTaskId, args.projectDir, args.primaryResult);
    const requiredMissing = packet.missingContext.filter((m) => m.required);
    if (requiredMissing.length > 0) {
      const reviewerTaskId = newTaskId(`red-${args.step.id}`);
      insertTask({
        id: reviewerTaskId,
        runId: args.runId,
        parentId: args.primaryTaskId,
        phase: args.step.id,
        agentRole: shippingReviewerRed.agent,
        status: "pending",
        taskPackage: emptyTaskPackage(reviewerTaskId, args.runId, args.step.id, shippingReviewerRed.agent),
        createdAt: nowIso(),
      });
      logEvent("task.created", { runId: args.runId, taskId: reviewerTaskId });
      const errMsg = `shipping-reviewer: missing required context (${requiredMissing.map((m) => m.field).join(", ")})`;
      markTaskFailed(reviewerTaskId, errMsg);
      logEvent("task.failed", {
        runId: args.runId,
        taskId: reviewerTaskId,
        payload: { failure_kind: "unknown", error: errMsg, missingContext: requiredMissing },
      });
      shippingReviewerPreFailed = true;
    } else {
      reviewerContextPacket = packet;
    }
  }

  // Exclude shipping-reviewer from launches when it was pre-failed above.
  const redsToLaunch =
    shippingReviewerRed && reviewerContextPacket === undefined
      ? args.step.reds.filter((r) => r.agent !== "shipping-reviewer")
      : args.step.reds;

  const launches = redsToLaunch.map((red) =>
    runOneRed({
      runId: args.runId,
      workflow: args.workflow,
      step: args.step,
      red,
      primaryTaskId: args.primaryTaskId,
      artifact,
      spec,
      projectDir: args.projectDir,
      designDir: args.designDir,
      runMetadata: args.runMetadata,
      dockerExec: args.dockerExec,
      reviewerContextPacket: red.agent === "shipping-reviewer" ? reviewerContextPacket : undefined,
    }),
  );
  const results = await Promise.all(launches);

  let authoritativeFail = false;
  const verdicts: Verdict[] = [];
  for (const r of results) {
    // #147: post-validate findings against project source. Hallucinated
    // citations get dropped; a fail with 100% dropped findings downgrades
    // to inconclusive. Returns a new verdict; original r.verdict untouched.
    const { validated, dropped } = validateVerdict(r.verdict, args.projectDir);
    // AWN-5: after citation validation, GRADE the surviving findings — reject the
    // malformed (no summary) and downgrade severity on unsupported-but-confident
    // ones (no evidence, no anchor, weak confidence). This enforces the review-
    // quality protocol, not just surfaces it.
    const { graded, rejected } = gradeFindings(validated.findings);
    const gradedFindings = graded.map((g) => g.finding);
    const downgradedCount = graded.filter((g) => g.downgraded).length;
    let finalVerdict: Verdict = { ...validated, findings: gradedFindings };
    // AWN-5: a `fail` with NO substantiating findings has no case to act on —
    // downgrade it to inconclusive so it doesn't BLOCK the gate. This covers both
    // "all findings rejected by grading (malformed)" and "fail with no findings at
    // all (unsubstantiated)"; an authoritative block must rest on a real finding.
    if (finalVerdict.verdict === "fail" && gradedFindings.length === 0) {
      const why = validated.findings.length > 0
        ? "all findings rejected by grading (malformed)"
        : "fail with no findings (unsubstantiated)";
      finalVerdict = {
        ...finalVerdict,
        verdict: "inconclusive",
        notes: [finalVerdict.notes, `${why}; fail → inconclusive`].filter(Boolean).join("; "),
      };
    }
    if (dropped.length > 0 || rejected.length > 0 || downgradedCount > 0) {
      logEvent("verdict.findings_dropped", {
        runId: args.runId,
        taskId: args.primaryTaskId,
        payload: {
          redRole: r.red.agent,
          originalVerdict: r.verdict.verdict,
          finalVerdict: finalVerdict.verdict,
          droppedCount: dropped.length,
          droppedReasons: dropped.map((d) => d.reason),
          rejectedCount: rejected.length,        // AWN-5 malformed
          downgradedCount,                       // AWN-5 weak-evidence severity downgrades
        },
      });
    }
    // FG-420: authoritative shipping-reviewer inconclusive is a hard block.
    // needs_human and unrecognized verdicts both map to inconclusive; under
    // authoritative authority with gate_on_verdict, they must not silently advance.
    // Prepend synthetic finding BEFORE insertVerdict so it is persisted to the DB.
    let shippingReviewerInconclusiveBlock = false;
    if (
      r.red.agent === "shipping-reviewer" &&
      r.red.authority === "authoritative" &&
      r.red.gate_on_verdict &&
      finalVerdict.verdict === "inconclusive"
    ) {
      shippingReviewerInconclusiveBlock = true;
      finalVerdict = {
        ...finalVerdict,
        findings: [
          {
            severity: "high",
            summary: "shipping-reviewer did not return a shippable verdict — this authoritative gate is blocked pending human review",
            evidence: "shipping-reviewer verdict is inconclusive (needs_human, an unrecognized verdict, or the reviewer failed to produce a result) under authoritative authority",
            hypothesis: "operator must run forge gate --force --rationale to explicitly override this block",
          },
          ...finalVerdict.findings,
        ],
      };
    }
    verdicts.push(finalVerdict);
    // Atomic: both writes must succeed together so a crash cannot leave the
    // verdicts table with a row that has no matching events-table entry —
    // FG-427 makes the events table the sole source for outcome derivation.
    getDb().transaction(() => {
      insertVerdict({
        id: newVerdictId(),
        taskId: args.primaryTaskId,
        redTaskId: r.redTaskId,
        redRole: r.red.agent,
        verdict: finalVerdict.verdict,
        confidence: finalVerdict.confidence,
        authority: r.red.authority as RedAuthority,
        findings: finalVerdict.findings,
        createdAt: nowIso(),
      });
      logEvent("verdict.received", {
        runId: args.runId,
        taskId: args.primaryTaskId,
        payload: { redRole: r.red.agent, verdict: finalVerdict.verdict, authority: r.red.authority },
      });
    })();
    // Gate on the GRADED verdict — a fail emptied by grading no longer blocks.
    if (r.red.authority === "authoritative" && r.red.gate_on_verdict && finalVerdict.verdict === "fail") {
      authoritativeFail = true;
    }
    // FG-420: authoritative shipping-reviewer inconclusive (needs_human / unrecognized) also blocks.
    if (shippingReviewerInconclusiveBlock) {
      authoritativeFail = true;
    }
  }
  // Missing required reviewer context is a hard stop: the packet could not be
  // built so there is nothing to review — block regardless of red configuration.
  if (shippingReviewerPreFailed) {
    authoritativeFail = true;
  }
  return { verdicts, authoritativeFail };
}

async function runOneRed(args: {
  runId: string;
  workflow: Workflow;
  step: Step;
  red: RedDef;
  primaryTaskId: string;
  artifact: string;
  spec?: string;
  projectDir: string;
  designDir?: string;
  runMetadata: Record<string, unknown>;
  dockerExec?: DockerExecFn;
  reviewerContextPacket?: ReviewerContextPacket;
}): Promise<{ red: RedDef; verdict: Verdict; redTaskId: string }> {
  const redTaskId = newTaskId(`red-${args.step.id}`);
  // failureModes: the force-level anti-prompts for the artifact under review.
  // Scoped to the PRIMARY (blue) role/workflow/phase being audited, not the red's
  // own role — a constraint like atlas-stack-rn lists roles [architecture-advisor,
  // engineer]. red-narrow requires these as a `failureModes` input; without them it
  // reports "missing required failureModes input" (forge-site bug).
  const failureModes = filterConstraints(loadAllConstraints(join(homeForge(), "constraints")), {
    role: args.step.agent ?? "",
    workflow: args.workflow.name,
    phase: args.step.id,
    level: "force",
    runTags: runTagsFromMetadata(args.runMetadata),
  })
    .map((c) => c.antiPrompt)
    .filter((p): p is string => typeof p === "string" && p.length > 0);
  const taskPackage: TaskPackage = {
    taskId: redTaskId,
    runId: args.runId,
    phase: args.step.id,
    role: args.red.agent,
    inputs: {
      failureModes,
      ...(args.reviewerContextPacket ? { reviewerContextPacket: args.reviewerContextPacket } : {}),
    },
    composedSystemPrompt: composeSystemPrompt({
      role: args.red.agent,
      workflow: args.workflow,
      step: args.step,
      runTags: runTagsFromMetadata(args.runMetadata),
    }),
    artifact: args.artifact,
    ...(args.spec ? { spec: args.spec } : {}),
  };
  const redResolution = resolveModel({
    agentRole: args.red.agent,
    stepAlias: args.red.activity,
    runtimeName: args.step.runtime,
    cliProfile: runModelProfile(args.runMetadata),
    profileSource: "run.profile",
    ctx: { projectDir: args.projectDir },
  });
  insertTask({
    id: redTaskId,
    runId: args.runId,
    parentId: args.primaryTaskId,
    phase: args.step.id,
    agentRole: args.red.agent,
    ...taskModelFields(redResolution, args.red.activity),
    status: "pending",
    taskPackage,
    createdAt: nowIso(),
  });
  logEvent("task.created", { runId: args.runId, taskId: redTaskId });

  // FG-350: build control-plane receipt inputs for the RED agent. Constraint
  // counts are scoped to the RED's own role/workflow/step rather than the
  // primary's — the receipt records what constraints THIS agent slot evaluated.
  const redWorkflowReceipt = args.runMetadata["workflowReceipt"] as
    | { source: "host" | "project"; path: string }
    | undefined;
  const redRouteReceipt = args.runMetadata["routeReceipt"] as
    | Record<string, unknown>
    | undefined;
  const redRunTags = runTagsFromMetadata(args.runMetadata);
  const redConstraints = loadAllConstraints(join(homeForge(), "constraints"));
  const redSuggestCount = filterConstraints(redConstraints, {
    role: args.red.agent,
    workflow: args.workflow.name,
    phase: args.step.id,
    level: "suggest",
    runTags: redRunTags,
  }).length;
  const redForceCount = failureModes.length;
  const redWorkflowProv = resolveWorkflowSource(args.workflow.name, args.projectDir, redWorkflowReceipt);

  // FG-351: reds are read-only reviewers — no worktree isolation needed or created.
  // Worktree isolation for reds is deferred to a future story.
  const result = await runContainer({
    taskId: redTaskId,
    runId: args.runId,
    projectDir: args.projectDir,
    projectMode: "ro",
    designDir: args.designDir,
    taskPackage,
    resolution: redResolution,
    workflowAlias: args.red.activity,
    role: args.red.agent,
    dockerExec: args.dockerExec,
    controlPlaneInputs: {
      workflowName: args.workflow.name,
      workflowSource: redWorkflowProv.source,
      workflowPath: redWorkflowProv.path,
      workflowWarnings: redWorkflowProv.warnings,
      routeReceipt: redRouteReceipt,
      suggestCount: redSuggestCount,
      forceCount: redForceCount,
      invocationCwd: typeof args.runMetadata["invocationCwd"] === "string"
        ? args.runMetadata["invocationCwd"]
        : undefined,
      resolvedFromSubdir: args.runMetadata["resolvedFromSubdir"] === true
        ? true
        : undefined,
      explicitSubproject: args.runMetadata["explicitSubproject"] === true
        ? true
        : undefined,
    },
  });

  if (result.kind === "failed") {
    // A red that fails to produce a verdict counts as inconclusive — don't let
    // a broken container block the gate. runContainer already marked the task
    // failed. FG-420 EXCEPTION: an authoritative shipping-reviewer that crashed
    // still triggers authoritativeFail (fail-safe) — dispatchReds detects the
    // inconclusive and blocks. Other reds' broken-container inconclusive is non-blocking.
    return {
      red: args.red,
      redTaskId,
      verdict: { verdict: "inconclusive", confidence: 0, findings: [] },
    };
  }

  // AWN-2 task-level race: only emit task.completed if the CAS actually completed
  // it (not if a concurrent cancel already terminated it).
  if (markTaskComplete(redTaskId, result.result)) {
    logEvent("task.completed", { runId: args.runId, taskId: redTaskId });
  }
  if (args.red.agent === "shipping-reviewer") {
    return {
      red: args.red,
      redTaskId,
      verdict: mapShippingReviewerVerdict(result.result, args.reviewerContextPacket?.doneAudit),
    };
  }
  return { red: args.red, redTaskId, verdict: parseVerdict(result.result) };
}

function parseVerdict(output: unknown): Verdict {
  const obj = (output ?? {}) as Record<string, unknown>;
  const verdict =
    obj["verdict"] === "pass" || obj["verdict"] === "fail" || obj["verdict"] === "inconclusive"
      ? obj["verdict"]
      : "inconclusive";
  const confidence =
    typeof obj["confidence"] === "number" && obj["confidence"] >= 0 && obj["confidence"] <= 1
      ? obj["confidence"]
      : 0.5;
  const findings: Finding[] = Array.isArray(obj["findings"]) ? (obj["findings"] as Finding[]) : [];
  // AWN-5: carry invariants_verified through (which invariants the red checked).
  const invariants = Array.isArray(obj["invariants_verified"])
    ? (obj["invariants_verified"] as unknown[]).filter((x): x is string => typeof x === "string")
    : undefined;
  return {
    verdict,
    confidence,
    findings,
    notes: typeof obj["notes"] === "string" ? obj["notes"] : undefined,
    ...(invariants && invariants.length > 0 ? { invariants_verified: invariants } : {}),
  };
}

// Maps the shipping-reviewer's canonical output contract to an internal Verdict.
// The shipping-reviewer emits { verdict, confidence, named_deferrals,
// doneAuditDisposition, findings, invariants_verified } — distinct from the
// pass/fail/inconclusive vocabulary used by other reds.
export function mapShippingReviewerVerdict(output: unknown, doneAudit?: DoneAuditResult | null): Verdict {
  const obj = (output ?? {}) as Record<string, unknown>;
  const srVerdict = obj["verdict"];

  const confidence =
    typeof obj["confidence"] === "number" && obj["confidence"] >= 0 && obj["confidence"] <= 1
      ? obj["confidence"]
      : 0.5;

  const findings: Finding[] = Array.isArray(obj["findings"]) ? (obj["findings"] as Finding[]) : [];

  const invariants = Array.isArray(obj["invariants_verified"])
    ? (obj["invariants_verified"] as unknown[]).filter((x): x is string => typeof x === "string")
    : undefined;

  let mappedVerdict: Verdict["verdict"];
  const syntheticFindings: Finding[] = [];

  if (srVerdict === "ship") {
    mappedVerdict = "pass";
  } else if (srVerdict === "ship_with_named_deferrals") {
    const deferrals = Array.isArray(obj["named_deferrals"]) ? obj["named_deferrals"] : [];
    const allValid =
      deferrals.length > 0 &&
      deferrals.every(
        (d) =>
          typeof d === "object" &&
          d !== null &&
          typeof (d as Record<string, unknown>)["description"] === "string" &&
          (d as Record<string, unknown>)["description"] !== "" &&
          typeof (d as Record<string, unknown>)["followUpTicketId"] === "string" &&
          (d as Record<string, unknown>)["followUpTicketId"] !== "",
      );
    if (!allValid) {
      mappedVerdict = "fail";
      syntheticFindings.push({
        severity: "high",
        summary: "shipping-reviewer returned ship_with_named_deferrals but a deferral is missing a description or a linked followUpTicketId — not a valid deferral",
        evidence: "shipping-reviewer verdict output: named_deferrals missing required fields",
        hypothesis: "an invalid deferral cannot substitute for a real shipping gate; the change must not be accepted",
      });
    } else {
      mappedVerdict = "pass";
    }
  } else if (srVerdict === "needs_fix") {
    mappedVerdict = "fail";
    syntheticFindings.push({
      severity: "high",
      summary: "shipping-reviewer returned needs_fix",
      evidence: "shipping-reviewer verdict output: verdict=needs_fix",
      hypothesis: "synthetic anchor unconditionally attached so the fail survives gradeFindings even when reviewer findings are absent or malformed",
    });
  } else if (srVerdict === "needs_human") {
    mappedVerdict = "inconclusive";
  } else {
    mappedVerdict = "inconclusive";
  }

  // GUARDRAIL BACKSTOP: a "pass" over unresolved mechanical checks with no named
  // exception is not a real pass. Downgrade to fail unless the result explicitly
  // names an accepted exception or a covering deferral.
  if (
    mappedVerdict === "pass" &&
    doneAudit !== undefined &&
    doneAudit !== null &&
    (doneAudit.outcome === "fail" || doneAudit.outcome === "unknown")
  ) {
    const disposition = typeof obj["doneAuditDisposition"] === "string" ? obj["doneAuditDisposition"] : "";
    const isExcepted = disposition.startsWith("accepted_exception") || disposition === "covered_by_deferral";
    if (!isExcepted) {
      mappedVerdict = "fail";
      syntheticFindings.push({
        severity: "high",
        summary: `shipping-reviewer returned ship over a done-audit outcome=${doneAudit.outcome} with no accepted exception or covering deferral`,
        evidence: `doneAudit.outcome=${doneAudit.outcome}, doneAuditDisposition=${disposition || "(none)"}`,
        hypothesis: "the done-audit indicates work is incomplete; accepting a ship verdict over an unresolved audit allows incomplete work to merge",
      });
    }
  }

  return {
    verdict: mappedVerdict,
    confidence,
    findings: syntheticFindings.length > 0 ? [...syntheticFindings, ...findings] : findings,
    ...(invariants && invariants.length > 0 ? { invariants_verified: invariants } : {}),
  };
}

// Defensive-failure path for a fanout parent (upstream missing / no array).
// When the step is seen for the first time we must create the parent row so its
// lifecycle starts with task.created, then route the failure through failTask
// for the normal bookkeeping the hand-rolled insert used to skip: completed_at
// and a classified failure_kind on the task.failed event. The existing-parent
// case just fails the already-created row.
function failFanoutParent(
  parentId: string,
  runId: string,
  step: Step,
  isNew: boolean,
  error: string,
): void {
  if (isNew) {
    insertTask({
      id: parentId,
      runId,
      phase: step.id,
      agentRole: step.agent ?? "fanout",
      status: "pending",
      taskPackage: emptyTaskPackage(parentId, runId, step.id, step.agent ?? "fanout"),
      createdAt: nowIso(),
    });
    logEvent("task.created", { runId, taskId: parentId, payload: { fanoutParent: true } });
  }
  failTask(parentId, { runId, kind: classify({}), error });
}

// Fanout dispatch: read the upstream array, spawn N child tasks (max_concurrency
// at a time), apply failure_mode policy, mark a synthetic parent task that
// aggregates child results.
async function dispatchFanoutStep(args: {
  runId: string;
  workflow: Workflow;
  step: Step;
  fanout: FanoutDef;
  projectDir: string;
  designDir?: string;
  runMetadata: Record<string, unknown>;
  dockerExec?: DockerExecFn;
}): Promise<string> {
  const step = args.step;
  const fanout = args.fanout;

  // Find or reuse a parent task for this fanout step. We always need one
  // primary row to represent the step in tasks-for-run; fanout children
  // hang off it via parentId.
  const allTasks = tasksForRun(args.runId);
  // Prefer the PENDING primary (created by gate request-changes on a prior
  // blocked_by_red/failed parent). Old failed/blocked parents are audit records
  // and must NOT be reused as the live fan-out parent for the new child wave —
  // doing so attaches retry children to the dead lineage and wedges the run
  // (FG-364). A pending primary is the only one actively waiting to be dispatched.
  const existingParent = allTasks.find(
    (t) => t.phase === step.id && t.parentId === undefined && t.status === "pending",
  );
  const parentId = existingParent?.id ?? newTaskId(step.id);
  const rc = existingParent?.taskPackage.inputs["requestedChanges"];
  const requestedChanges = typeof rc === "string" ? rc : undefined;

  // Defense-in-depth: if a running/awaiting_red primary already has fan-out
  // children, this is a re-entrant dispatch (computeReadyQueue can be tricked by
  // pending child/red tasks in the phase). Return without creating a duplicate wave.
  const activeWithChildren = allTasks.find(
    (t) =>
      t.phase === step.id &&
      t.parentId === undefined &&
      (t.status === "running" || t.status === "awaiting_red") &&
      allTasks.some((c) => c.parentId === t.id && !c.agentRole.startsWith("red-")),
  );
  if (activeWithChildren) return activeWithChildren.status;
  if (existingParent) {
    const gateForced = existingParent.taskPackage?.inputs?.["gateForced"] === true;
    if (gateForced) {
      // FG-353 re-entry: gate.ts set gateForced on a blocked_by_red fanout parent
      // so we can merge the integration branch to HEAD before finalizing the parent.
      const redsAlreadyRan = verdictsForTask(existingParent.id).length > 0;
      markTaskRunning(existingParent.id);
      const savedResultPath = join(taskDir(args.runId, existingParent.id), "result.json");
      let savedResult: unknown;
      try {
        savedResult = JSON.parse(readFileSync(savedResultPath, "utf8"));
      } catch (e) {
        failTask(existingParent.id, {
          runId: args.runId,
          kind: classify({}),
          error: `re-entry: missing or malformed result.json for task ${existingParent.id}: ${String(e)}`,
        });
        return "failed";
      }
      if (
        isWorktreeModeEnabled() &&
        redsAlreadyRan &&
        integrationBranchExists(args.projectDir, args.runId, existingParent.id)
      ) {
        // Skip child dispatch and red dispatch — go directly to integration->HEAD merge.
        const headMerge = mergeIntegrationBranchToHead(args.projectDir, args.runId, existingParent.id);
        logEvent("integration.merged_to_head", {
          runId: args.runId,
          taskId: existingParent.id,
          payload: {
            ok: headMerge.ok,
            branch: integrationBranchName(args.runId, existingParent.id),
            reEntry: true,
            error: !headMerge.ok ? headMerge.error : undefined,
          },
        });
        if (!headMerge.ok) {
          failTask(existingParent.id, {
            runId: args.runId,
            kind: "merge_conflict",
            error: headMerge.error,
            result: savedResult,
          });
          return "failed";
        }
        // FG-357: post-merge integration gate. Return BEFORE any cleanup on
        // failure so the integration/child worktrees and branches stay
        // available for inspection (no-discard, same as merge_conflict above).
        const gate = runIntegrationGate(args.projectDir);
        if (!gate.ok) {
          failTask(existingParent.id, {
            runId: args.runId,
            kind: classify({ integrationGate: { status: gate.status, signal: gate.signal, timedOut: gate.timedOut } }),
            error: `post-merge integration gate failed: ${gate.error}\n${gate.output}`,
            result: savedResult,
          });
          return "failed";
        }
        // Only proven-merged (completed) children may be cleaned up; failed children
        // were never integrated and must retain their worktree/branch (no-discard).
        const childTasksForCleanup = allTasks.filter(
          (t) =>
            t.parentId === existingParent.id &&
            !t.agentRole.startsWith("red-") &&
            t.status === "complete",
        );
        for (const child of childTasksForCleanup) {
          const childWtPath = child.worktreePath as string | undefined;
          if (childWtPath) {
            removeWorktreeIfSafe(childWtPath, args.runId, child.id, args.projectDir, true);
          }
        }
        cleanupIntegrationWorktree(args.projectDir, args.runId, existingParent.id);
      } else if (isWorktreeModeEnabled() && redsAlreadyRan) {
        // Worktree mode is on and reds already ran (integration was built and
        // reviewed) but the integration branch is now missing — inconsistent state.
        // Fail loudly rather than silently completing without merging child work to HEAD.
        failTask(existingParent.id, {
          runId: args.runId,
          kind: "merge_conflict",
          error:
            `re-entry: integration branch missing for task ${existingParent.id} — ` +
            `expected ${integrationBranchName(args.runId, existingParent.id)}, ` +
            `cannot complete without merging child work to HEAD`,
          result: savedResult,
        });
        return "failed";
      }
      // For non-worktree re-entry (or worktree re-entry before reds ran),
      // complete directly — the human advance decision was already recorded when
      // gate advance --force ran, so re-gating via finalizePrimary would bounce
      // a verdict/human gate back to awaiting_gate instead of completing (FG-353).
      if (!markTaskComplete(existingParent.id, savedResult)) {
        return getTask(existingParent.id)?.status ?? "failed";
      }
      logEvent("task.completed", { runId: args.runId, taskId: existingParent.id });
      return "complete";
    }
    // Original pendingHasChildren guard unchanged below.
    const pendingHasChildren = allTasks.some(
      (c) => c.parentId === existingParent.id && !c.agentRole.startsWith("red-"),
    );
    if (pendingHasChildren) return existingParent.status;
  }

  // Read the upstream array. The fanout source is fanout.from_upstream.step,
  // and the value lives at result[array_key].
  const upstreamTask = allTasks
    .filter((t) => t.phase === fanout.from_upstream.step && t.parentId === undefined && t.status === "complete")
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .pop();
  if (!upstreamTask) {
    // Upstream hasn't completed; ready-queue logic should have prevented this.
    const upstreamMsg = "fanout: upstream not complete";
    failFanoutParent(parentId, args.runId, step, !existingParent, upstreamMsg);
    return "failed";
  }

  const upstreamResult = (upstreamTask.result ?? {}) as Record<string, unknown>;
  const rawArray = upstreamResult[fanout.from_upstream.array_key];
  if (!Array.isArray(rawArray) || rawArray.length === 0) {
    const noArrayMsg = `fanout: upstream '${fanout.from_upstream.step}' has no array at '${fanout.from_upstream.array_key}'`;
    failFanoutParent(parentId, args.runId, step, !existingParent, noArrayMsg);
    return "failed";
  }

  // Insert parent row first time we see this step. Status starts pending and
  // becomes complete/failed once children settle.
  if (!existingParent) {
    insertTask({
      id: parentId,
      runId: args.runId,
      phase: step.id,
      agentRole: step.agent ?? "fanout",
      status: "running",
      taskPackage: {
        taskId: parentId,
        runId: args.runId,
        phase: step.id,
        role: step.agent ?? "fanout",
        inputs: {
          fanout: {
            from_upstream: fanout.from_upstream,
            count: rawArray.length,
          },
        },
        composedSystemPrompt: "",
      },
      createdAt: nowIso(),
    });
    logEvent("task.created", { runId: args.runId, taskId: parentId, payload: { fanoutParent: true, count: rawArray.length } });
  } else {
    markTaskRunning(parentId);
  }

  // Dispatch children with max_concurrency. We process the array in order,
  // up to N at a time. failure_mode === "fail-phase" short-circuits once any
  // child fails; retry-once re-dispatches a single failure; continue lets
  // failures coexist with successes.
  const maxConc = fanout.max_concurrency ?? 4;
  const childOutcomes: ChildOutcome[] = [];

  let queue = rawArray.map((value, idx) => ({ value, idx }));
  let aborted = false;

  while (queue.length > 0 && !aborted) {
    const batch = queue.splice(0, maxConc);
    const results = await Promise.all(
      batch.map((entry) => runFanoutChild({
        runId: args.runId,
        workflow: args.workflow,
        step,
        fanout,
        parentId,
        index: entry.idx,
        value: entry.value,
        projectDir: args.projectDir,
        designDir: args.designDir,
        runMetadata: args.runMetadata,
        dockerExec: args.dockerExec,
        requestedChanges,
      })),
    );
    childOutcomes.push(...results);
    if (fanout.failure_mode === "fail-phase" && results.some((r) => r.status === "failed")) {
      aborted = true;
    }
  }

  // retry-once: re-dispatch any failed child a single time.
  if (fanout.failure_mode === "retry-once") {
    const failed = childOutcomes.filter((c) => c.status === "failed");
    if (failed.length > 0) {
      const retried = await Promise.all(
        failed.map((c) => runFanoutChild({
          runId: args.runId,
          workflow: args.workflow,
          step,
          fanout,
          parentId,
          index: c.index,
          value: c.value,
          projectDir: args.projectDir,
          designDir: args.designDir,
          runMetadata: args.runMetadata,
          dockerExec: args.dockerExec,
          requestedChanges,
        })),
      );
      // Replace failed outcomes with retry outcomes.
      for (const r of retried) {
        const existingIdx = childOutcomes.findIndex((c) => c.index === r.index && c.status === "failed");
        if (existingIdx >= 0) childOutcomes[existingIdx] = r;
      }
    }
  }

  // Aggregate child results into the parent's result.
  const parentResult = {
    status: childOutcomes.every((c) => c.status === "complete") ? "complete" : "partial",
    children: childOutcomes.map((c) => ({
      index: c.index,
      status: c.status,
      childTaskId: c.childTaskId,
      result: c.result,
    })),
  };

  // No container runs for the parent — write result.json explicitly so
  // deriveUpstream can find it when a downstream step depends_on this one.
  const parentTaskDir = taskDir(args.runId, parentId);
  mkdirSync(parentTaskDir, { recursive: true });
  writeFileSync(join(parentTaskDir, "result.json"), JSON.stringify(parentResult));

  // failure_mode determines whether a partial result fails the parent.
  const anyFailed = childOutcomes.some((c) => c.status === "failed");
  if (anyFailed && fanout.failure_mode === "fail-phase") {
    failTask(parentId, { runId: args.runId, kind: classify({}), error: "fanout: at least one child failed (failure_mode=fail-phase)", result: parentResult });
    return "failed";
  }

  // FG-353 Change 5: merge successful child branches into a dedicated integration
  // worktree (in child index order, --no-ff) so fan-out reds review the integrated
  // output rather than any single child. Non-worktree path is byte-for-byte unchanged.
  // Wrapped in try/catch so any unexpected git error transitions the parent to failed
  // rather than leaving it running/wedged.
  let integrationWorktreePath: string | undefined;
  if (isWorktreeModeEnabled()) {
    const successfulChildren = childOutcomes
      .filter((c) => c.status === "complete")
      .sort((a, b) => a.index - b.index);
    try {
      const { integrationPath } = createIntegrationWorktree(
        args.projectDir,
        args.runId,
        parentId,
      );
      integrationWorktreePath = integrationPath;
      logEvent("integration.worktree_created", {
        runId: args.runId,
        taskId: parentId,
        payload: {
          integrationPath,
          branch: integrationBranchName(args.runId, parentId),
          childCount: successfulChildren.length,
        },
      });
      for (const child of successfulChildren) {
        if (!child.worktreePath) continue;
        const merge = mergeChildIntoIntegration(
          integrationWorktreePath,
          args.runId,
          child.childTaskId,
          child.worktreePath,
        );
        logEvent("integration.child_merged", {
          runId: args.runId,
          taskId: parentId,
          payload: {
            childTaskId: child.childTaskId,
            childIndex: child.index,
            ok: merge.ok,
            error: !merge.ok ? merge.error : undefined,
          },
        });
        if (!merge.ok) {
          failTask(parentId, {
            runId: args.runId,
            kind: "merge_conflict",
            error: merge.error,
            result: parentResult,
          });
          // Retain integration branch and the offending child worktree for inspection.
          return "failed";
        }
      }
    } catch (e) {
      const errMsg = `integration worktree setup failed: ${(e as Error).message ?? String(e)}`;
      failTask(parentId, {
        runId: args.runId,
        kind: "merge_conflict",
        error: errMsg,
        result: parentResult,
      });
      return "failed";
    }
  }

  // Reds run per-parent on the aggregate (FORGE-DEC / #139: not per-child). The
  // single-step path does this; the fanout path used to skip it entirely, so the
  // build phase's authoritative reds never dispatched and the verdict gate had no
  // verdicts to resolve (forge-site bug). Mirror dispatchSingleStep's reds block.
  if (step.reds.length > 0) {
    setTaskStatus(parentId, "awaiting_red");
    logEvent("task.awaiting_red", { runId: args.runId, taskId: parentId });

    const aggregate = await dispatchReds({
      runId: args.runId,
      workflow: args.workflow,
      step,
      primaryTaskId: parentId,
      primaryResult: parentResult,
      // FG-353 Change 6: fan-out reds receive the integration tree as their
      // /project mount. Falls back to args.projectDir in non-worktree mode.
      projectDir: integrationWorktreePath ?? args.projectDir,
      designDir: args.designDir,
      runMetadata: args.runMetadata,
      dockerExec: args.dockerExec,
    });

    if (aggregate.authoritativeFail) {
      // Save result via markTaskAwaitingGate (sets awaiting_gate), then restore
      // the blocked_by_red status. Single setTaskStatus avoids double-setting churn.
      markTaskAwaitingGate(parentId, parentResult);
      setTaskStatus(parentId, "blocked_by_red");
      logEvent("task.blocked_by_red", { runId: args.runId, taskId: parentId });
      const runForNotify = getRun(args.runId);
      if (runForNotify) void notifyOnTaskBlockedByRed(runForNotify);
      // Integration branch + child worktrees retained for inspection on blocked_by_red.
      return "blocked_by_red";
    }

    // FG-353 Change 7: reds passed — merge integration branch to HEAD and clean up.
    if (integrationWorktreePath) {
      const headMerge = mergeIntegrationBranchToHead(args.projectDir, args.runId, parentId);
      logEvent("integration.merged_to_head", {
        runId: args.runId,
        taskId: parentId,
        payload: {
          ok: headMerge.ok,
          branch: integrationBranchName(args.runId, parentId),
          error: !headMerge.ok ? headMerge.error : undefined,
        },
      });
      if (!headMerge.ok) {
        failTask(parentId, {
          runId: args.runId,
          kind: "merge_conflict",
          error: headMerge.error,
          result: parentResult,
        });
        return "failed";
      }
      // FG-357: post-merge integration gate. Return BEFORE any cleanup on
      // failure so the integration/child worktrees and branches stay
      // available for inspection (no-discard, same as merge_conflict above).
      const gate = runIntegrationGate(args.projectDir);
      if (!gate.ok) {
        failTask(parentId, {
          runId: args.runId,
          kind: classify({ integrationGate: { status: gate.status, signal: gate.signal, timedOut: gate.timedOut } }),
          error: `post-merge integration gate failed: ${gate.error}\n${gate.output}`,
          result: parentResult,
        });
        return "failed";
      }
      // Only proven-merged (completed) children may be cleaned up; failed children
      // were never integrated and must retain their worktree/branch (no-discard).
      for (const child of childOutcomes.filter((c) => c.status === "complete")) {
        if (child.worktreePath) {
          removeWorktreeIfSafe(child.worktreePath, args.runId, child.childTaskId, args.projectDir, true);
        }
      }
      cleanupIntegrationWorktree(args.projectDir, args.runId, parentId);
    }
    return finalizePrimary(parentId, args.runId, step.gate, parentResult);
  }

  // No reds path: merge integration to HEAD directly before finalizing.
  if (integrationWorktreePath) {
    const headMerge = mergeIntegrationBranchToHead(args.projectDir, args.runId, parentId);
    logEvent("integration.merged_to_head", {
      runId: args.runId,
      taskId: parentId,
      payload: {
        ok: headMerge.ok,
        branch: integrationBranchName(args.runId, parentId),
        error: !headMerge.ok ? headMerge.error : undefined,
      },
    });
    if (!headMerge.ok) {
      failTask(parentId, {
        runId: args.runId,
        kind: "merge_conflict",
        error: headMerge.error,
        result: parentResult,
      });
      return "failed";
    }
    // FG-357: post-merge integration gate. Return BEFORE any cleanup on
    // failure so the integration/child worktrees and branches stay available
    // for inspection (no-discard, same as merge_conflict above).
    const gate = runIntegrationGate(args.projectDir);
    if (!gate.ok) {
      failTask(parentId, {
        runId: args.runId,
        kind: classify({ integrationGate: { status: gate.status, signal: gate.signal, timedOut: gate.timedOut } }),
        error: `post-merge integration gate failed: ${gate.error}\n${gate.output}`,
        result: parentResult,
      });
      return "failed";
    }
    // Only proven-merged (completed) children may be cleaned up; failed children
    // were never integrated and must retain their worktree/branch (no-discard).
    for (const child of childOutcomes.filter((c) => c.status === "complete")) {
      if (child.worktreePath) {
        removeWorktreeIfSafe(child.worktreePath, args.runId, child.childTaskId, args.projectDir, true);
      }
    }
    cleanupIntegrationWorktree(args.projectDir, args.runId, parentId);
  }

  return finalizePrimary(parentId, args.runId, step.gate, parentResult);
}

type ChildOutcome = {
  index: number;
  value: unknown;
  childTaskId: string;
  status: "complete" | "failed";
  result?: unknown;
  // FG-353: worktree path for this child, used for integration merges + cleanup.
  worktreePath?: string;
};

async function runFanoutChild(args: {
  runId: string;
  workflow: Workflow;
  step: Step;
  fanout: FanoutDef;
  parentId: string;
  index: number;
  value: unknown;
  projectDir: string;
  designDir?: string;
  runMetadata: Record<string, unknown>;
  dockerExec?: DockerExecFn;
  requestedChanges?: string;
}): Promise<ChildOutcome> {
  const step = args.step;
  const agentRole = resolveChildAgent(step, args.fanout, args.value);
  const syntheticPhase = `${step.id}-${args.index}`;
  const childTaskId = newTaskId(syntheticPhase);

  const allTasks = tasksForRun(args.runId);
  const upstream = deriveUpstream({
    step,
    allTasks,
    runDir: join(homeForge(), "runs", args.runId),
  });

  const inputKey = args.fanout.from_upstream.input_key;
  const childInputs: Record<string, unknown> = {
    ...args.runMetadata,
    upstream,
    [inputKey]: args.value,
    fanoutIndex: args.index,
  };
  if (args.requestedChanges) {
    childInputs["requestedChanges"] = args.requestedChanges;
  }
  for (const key of CONTROL_PLANE_METADATA_KEYS) delete childInputs[key];
  const taskPackage: TaskPackage = {
    taskId: childTaskId,
    runId: args.runId,
    phase: step.id,
    role: agentRole,
    inputs: childInputs,
    composedSystemPrompt: composeSystemPrompt({
      role: agentRole,
      workflow: args.workflow,
      step,
      runTags: runTagsFromMetadata(args.runMetadata),
    }),
  };

  const childResolution = resolveModel({
    agentRole,
    stepAlias: step.activity,
    runtimeName: step.runtime,
    cliProfile: runModelProfile(args.runMetadata),
    profileSource: "run.profile",
    ctx: { projectDir: args.projectDir },
  });
  insertTask({
    id: childTaskId,
    runId: args.runId,
    parentId: args.parentId,
    phase: step.id,
    agentRole,
    ...taskModelFields(childResolution, step.activity),
    status: "pending",
    taskPackage,
    createdAt: nowIso(),
  });
  logEvent("task.created", { runId: args.runId, taskId: childTaskId, payload: { fanoutChild: true, index: args.index } });

  // FG-350: control-plane receipt for fanout children — same provenance logic as
  // dispatchSingleStep; constraint counts scoped to this child's role/step.
  const fcWorkflowReceipt = args.runMetadata["workflowReceipt"] as
    | { source: "host" | "project"; path: string }
    | undefined;
  const fcRouteReceipt = args.runMetadata["routeReceipt"] as
    | Record<string, unknown>
    | undefined;
  const fcRunTags = runTagsFromMetadata(args.runMetadata);
  const fcConstraints = loadAllConstraints(join(homeForge(), "constraints"));
  const fcSuggestCount = filterConstraints(fcConstraints, {
    role: agentRole,
    workflow: args.workflow.name,
    phase: step.id,
    level: "suggest",
    runTags: fcRunTags,
  }).length;
  const fcForceCount = filterConstraints(fcConstraints, {
    role: agentRole,
    workflow: args.workflow.name,
    phase: step.id,
    level: "force",
    runTags: fcRunTags,
  }).length;
  const fcWorkflowProv = resolveWorkflowSource(args.workflow.name, args.projectDir, fcWorkflowReceipt);

  // FG-374/FG-351 gate ordering: same as primary dispatch — preflight must run
  // BEFORE any state mutation so a bad mount cannot leak a worktree or DB row.
  try {
    preflightProjectMount(args.projectDir);
  } catch (e) {
    const msg = `preflightProjectMount failed: ${(e as Error).message}`;
    failTask(childTaskId, { runId: args.runId, kind: classify({}), error: msg });
    return { index: args.index, value: args.value, childTaskId, status: "failed" };
  }

  // FG-351: create a task-scoped git worktree for each fanout child when worktree
  // mode is enabled. Same pattern as primary dispatch: DB write before container
  // start so reconcile can find the path after a process restart.
  let childWorktreePath: string | undefined;
  if (isWorktreeModeEnabled()) {
    try {
      preflightWorktreeGate(args.projectDir);
      const wt = createWorktree(args.projectDir, args.runId, childTaskId);
      childWorktreePath = wt.worktreePath;
      setTaskWorktreePath(childTaskId, childWorktreePath);
      if (wt.untrackedFiles.length > 0) {
        process.stderr.write(
          `[forge/worktree] task ${childTaskId}: ${wt.untrackedFiles.length} untracked host file(s) not in worktree: ${wt.untrackedFiles.slice(0, 5).join(", ")}${wt.untrackedFiles.length > 5 ? ` (+${wt.untrackedFiles.length - 5} more)` : ""}\n`
        );
      }
    } catch (e) {
      // Gate or create failure: transition the child task to failed so the fanout
      // run can report the error instead of hanging with a pending child.
      // cleanupFailedWorktreeSetup is NOT EPHEMERAL-gated: the agent never ran,
      // so there is no output to preserve — always safe to remove partial state.
      const msg = `worktree setup failed: ${(e as Error).message}`;
      cleanupFailedWorktreeSetup(args.projectDir, args.runId, childTaskId);
      failTask(childTaskId, { runId: args.runId, kind: classify({}), error: msg });
      return { index: args.index, value: args.value, childTaskId, status: "failed" };
    }
  }

  const dispatchResult = await runContainer({
    taskId: childTaskId,
    runId: args.runId,
    projectDir: args.projectDir,
    worktreePath: childWorktreePath,
    projectMode: "rw",
    designDir: args.designDir,
    taskPackage,
    resolution: childResolution,
    workflowAlias: step.activity,
    authProfile: authProfileForRole(args.runMetadata, agentRole),
    role: agentRole,
    dockerExec: args.dockerExec,
    controlPlaneInputs: {
      workflowName: args.workflow.name,
      workflowSource: fcWorkflowProv.source,
      workflowPath: fcWorkflowProv.path,
      workflowWarnings: fcWorkflowProv.warnings,
      routeReceipt: fcRouteReceipt,
      suggestCount: fcSuggestCount,
      forceCount: fcForceCount,
      invocationCwd: typeof args.runMetadata["invocationCwd"] === "string"
        ? args.runMetadata["invocationCwd"]
        : undefined,
      resolvedFromSubdir: args.runMetadata["resolvedFromSubdir"] === true
        ? true
        : undefined,
      explicitSubproject: args.runMetadata["explicitSubproject"] === true
        ? true
        : undefined,
    },
  });

  if (dispatchResult.kind === "failed") {
    // FG-353: include worktreePath so dispatchFanoutStep can clean up failed children.
    return { index: args.index, value: args.value, childTaskId, status: "failed", worktreePath: childWorktreePath };
  }

  // AWN-2 task-level race: don't overwrite / re-announce a concurrently-cancelled child.
  if (markTaskComplete(childTaskId, dispatchResult.result)) {
    logEvent("task.completed", { runId: args.runId, taskId: childTaskId });
    // FG-353: cleanup responsibility moves to dispatchFanoutStep after proven HEAD merge.
    // The old per-child removeWorktreeIfSafe call is removed here.
  }
  return {
    index: args.index,
    value: args.value,
    childTaskId,
    status: "complete",
    result: dispatchResult.result,
    worktreePath: childWorktreePath,
  };
}

// Materializes a task on disk, spawns the container, reads result.json,
// transitions task to running/failed. Returns the parsed result on success;
// the caller writes the final status (complete vs awaiting_gate vs blocked).
//
// This is the shared core used by primary, red, and fanout-child dispatches.
type ContainerOutcome =
  | { kind: "ok"; result: unknown }
  | { kind: "failed"; error: string };

async function runContainer(args: {
  taskId: string;
  runId: string;
  projectDir: string;
  // FG-351: when worktree mode is active, the worktree path replaces projectDir
  // as the container's PROJECT_DIR mount. projectDir retains the original value
  // for persistence checks and other non-mount uses.
  worktreePath?: string;
  projectMode: "rw" | "ro";
  designDir?: string;
  taskPackage: TaskPackage;
  // AWN-7: the model resolution chosen at the call site (drives runtime + MODEL +
  // the manifest model block). resolution.runtime is the runtime to load.
  resolution: ModelResolution;
  // The workflow-declared alias (step.activity / red.activity) — used for the
  // model_calls usage rollup, preserving pre-AWN-7 alias attribution.
  workflowAlias?: string;
  // #176: name of a captured auth profile to inject. Callers pass this only for
  // browser-capable PRIMARY steps; reds never do (read-only, no credential).
  authProfile?: string;
  role?: string; // AWN-6: agent role, for project-command auth role-gating
  dockerExec?: DockerExecFn;
  // FG-350: dispatch-time control-plane inputs for the manifest receipt. When
  // provided, runContainer assembles a ControlPlaneReceipt and writes it into
  // the manifest.json so explain views read RECORDED dispatch-time truth.
  controlPlaneInputs?: {
    workflowName: string;
    workflowSource: "host" | "project" | "synthetic" | "unknown";
    workflowPath?: string;
    workflowWarnings?: string[];
    routeReceipt?: Record<string, unknown>;
    suggestCount: number;
    forceCount: number;
    // FG-374: project-mount provenance from the originating CLI invocation.
    // Optional/legacy-safe: runs created before FG-374 omit these.
    invocationCwd?: string;
    resolvedFromSubdir?: boolean;
    explicitSubproject?: boolean;
  };
}): Promise<ContainerOutcome> {
  const dir = taskDir(args.runId, args.taskId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "CLAUDE.md"), args.taskPackage.composedSystemPrompt);
  writeFileSync(join(dir, "package.md"), renderTaskPackage(args.taskPackage));
  writeFileSync(join(dir, "result.json"), "");
  chmodSync(dir, 0o777);

  markTaskRunning(args.taskId);
  logEvent("task.started", { runId: args.runId, taskId: args.taskId });

  let runtime: Runtime;
  let runtimeSource: "host" | "project" = "host";
  let runtimePath = "";
  let runtimeName = "";
  try {
    const loaded = loadRuntimeWithSource(args.resolution.runtime, { projectDir: args.projectDir });
    runtime = loaded;
    runtimeSource = loaded.source;
    runtimePath = loaded.path;
    runtimeName = loaded.name;
  } catch (e) {
    const msg = `loadRuntime failed: ${(e as Error).message}`;
    failTask(args.taskId, { runId: args.runId, kind: classify({}), error: msg });
    return { kind: "failed", error: msg };
  }
  // #292: the runtime's EXECUTION metadata (parser/prompt/auth strategy), resolved
  // once and threaded into the manifest + usage capture — behavior chosen from the
  // runtime, not the upstream provider name.
  const runtimeMeta = resolveRuntimeMetadata(runtime);

  // AWN-7: fail loud BEFORE spawning if the resolved auth is unavailable (policy
  // mode, on_unavailable=fail). A no-op in legacy mode. Then record the resolution.
  const availability = checkResolvedAvailability(args.resolution);
  if (!availability.ok) {
    logEvent("model.profile_unavailable", {
      runId: args.runId,
      taskId: args.taskId,
      payload: {
        profile: args.resolution.profile,
        provider: args.resolution.provider,
        auth: args.resolution.auth,
        reason: availability.reason,
      },
    });
    failTask(args.taskId, { runId: args.runId, kind: classify({}), error: availability.reason });
    return { kind: "failed", error: availability.reason };
  }
  // FG-339: fail loud if a tool-requiring role is dispatched to a non-tool-capable
  // model. Policy mode only — legacy mode (resolvedBy==='legacy') is a no-op.
  // Pi runtimes default non-capable (guilty-until-proven); others default capable.
  if (args.resolution.resolvedBy !== "legacy") {
    const effectiveToolCapable = args.resolution.toolCapable ?? (runtimeMeta.runtimeKind !== "pi");
    const toolCapability = checkToolCapability(args.role, effectiveToolCapable, args.resolution.profile, args.resolution.model, args.resolution.alias);
    if (!toolCapability.ok) {
      logEvent("model.profile_unavailable", {
        runId: args.runId,
        taskId: args.taskId,
        payload: {
          profile: args.resolution.profile,
          provider: args.resolution.provider,
          auth: args.resolution.auth,
          capability: "tool",
          reason: toolCapability.reason,
        },
      });
      failTask(args.taskId, { runId: args.runId, kind: classify({}), error: toolCapability.reason });
      return { kind: "failed", error: toolCapability.reason };
    }
  }
  const resolvedBlock = manifestModelBlock(args.resolution);
  if (resolvedBlock) {
    logEvent("model.profile_resolved", { runId: args.runId, taskId: args.taskId, payload: resolvedBlock });
  }
  // Usage attribution: prefer the resolved capability alias (policy mode); fall
  // back to the workflow-declared alias (legacy, where resolution.alias is unset).
  const usageAlias = args.resolution.alias ?? args.workflowAlias;
  // #292: the runtime's log_format selects the usage parser (codex-jsonl → codex;
  // else claude stream-json) — an execution fact, not the provider. provider is
  // still recorded for attribution + as the captureUsageForTask legacy fallback.
  const usageMeta = {
    ...(usageAlias ? { alias: usageAlias } : {}),
    logFormat: runtimeMeta.logFormat,
    ...(args.resolution.provider ? { provider: args.resolution.provider } : {}),
    ...(args.resolution.model ? { model: args.resolution.model } : {}),
  };

  // #176: stage the auth profile (resolve + reconcile localhost origins) for
  // injection. Fail fast on missing/expired — don't run a browser step against
  // a dead session and emit false "app broken" findings.
  let authStateHostPath: string | undefined;
  if (args.authProfile) {
    try {
      // AWN-6: project-command profile (project's own login) vs captured #176 profile.
      const projectProfile = loadProjectAuthProfile(args.projectDir, args.authProfile);
      const staged = projectProfile
        ? resolveProjectAuthForContainer(projectProfile, args.projectDir, dir, args.role ?? "engineer")
        : resolveAuthStateForContainer(args.authProfile, dir);
      authStateHostPath = staged.hostPath;
      logEvent("auth.profile_applied", { runId: args.runId, taskId: args.taskId, payload: { profile: args.authProfile, kind: projectProfile ? "project-command" : "captured" } });
      if (staged.reconciled) {
        console.error(
          `forge: auth-profile '${args.authProfile}' — rewrote localhost origins for container access. ` +
            `Agent should navigate to: ${staged.origins.join(", ")}`,
        );
      }
    } catch (e) {
      if (e instanceof AuthProfileError || e instanceof ProjectAuthError) {
        logEvent("auth.profile_failed", { runId: args.runId, taskId: args.taskId, payload: { profile: args.authProfile, reason: (e as Error).message } });
        failTask(args.taskId, { runId: args.runId, kind: classify({ error: e }), error: (e as Error).message });
        return { kind: "failed", error: (e as Error).message };
      }
      throw e;
    }
  }

  // Resolve the effective idle timeout once, at dispatch, and record it in the
  // manifest so forge show reports the value this task actually ran under.
  const idleTimeoutMs = resolveIdleTimeoutMs(runtime.container.idle_timeout_seconds);

  // FG-350: assemble control-plane receipt when inputs are provided. Recorded at
  // dispatch time so Explain views answer "why this config" from RECORDED facts,
  // not recomputed from current host/project config.
  let controlPlane: ReturnType<typeof manifestControlPlaneBlock> | undefined;
  if (args.controlPlaneInputs) {
    const cp = args.controlPlaneInputs;
    const rr = cp.routeReceipt;
    const routing = rr && typeof rr["responsible"] === "string"
      ? {
          routeKey: String(rr["routeKey"]),
          source: rr["source"] as "host" | "project",
          policyPath: String(rr["policyPath"]),
          responsible: String(rr["responsible"]),
          pathType: String(rr["pathType"]),
          requiredFollowups: Array.isArray(rr["requiredFollowups"])
            ? (rr["requiredFollowups"] as string[])
            : [],
        }
      : undefined;
    const receiptWarnings = rr && Array.isArray(rr["warnings"])
      ? (rr["warnings"] as string[])
      : undefined;
    const allWarnings = [
      ...(receiptWarnings ?? []),
      ...(cp.workflowWarnings ?? []),
    ];
    let modelPolicyLoaded: ReturnType<typeof loadModelPolicyWithSource>;
    try {
      modelPolicyLoaded = loadModelPolicyWithSource({ projectDir: args.projectDir });
    } catch (e) {
      const msg = `loadModelPolicy failed: ${(e as Error).message}`;
      cleanupStagedAuth(dir); // AWN-8
      failTask(args.taskId, { runId: args.runId, kind: classify({}), error: msg });
      return { kind: "failed", error: msg };
    }
    const docsSurfacesResult = resolveDocsSurfacesReceipt(args.projectDir);
    if (docsSurfacesResult.warning) allWarnings.push(docsSurfacesResult.warning);
    controlPlane = manifestControlPlaneBlock({
      workflow: { name: cp.workflowName, source: cp.workflowSource, path: cp.workflowPath },
      runtime: { name: runtimeName, source: runtimeSource, path: runtimePath },
      modelPolicy: {
        source: modelPolicyLoaded.source,
        path: modelPolicyLoaded.source !== "absent" ? modelPolicyLoaded.path : undefined,
      },
      routing,
      docsSurfaces: docsSurfacesResult.receipt,
      constraints: {
        dir: join(homeForge(), "constraints"),
        suggestCount: cp.suggestCount,
        forceCount: cp.forceCount,
      },
      mountMode: args.projectMode,
      projectDir: args.projectDir,
      ...(cp.invocationCwd !== undefined ? { invocationCwd: cp.invocationCwd } : {}),
      ...(cp.resolvedFromSubdir !== undefined ? { resolvedFromSubdir: cp.resolvedFromSubdir } : {}),
      ...(cp.explicitSubproject !== undefined ? { explicitSubproject: cp.explicitSubproject } : {}),
      warnings: allWarnings.length > 0 ? allWarnings : undefined,
    });
  }

  writeTaskManifest(dir, {
    taskId: args.taskId,
    runId: args.runId,
    files: { prompt: "CLAUDE.md", package: "package.md", result: "result.json", stdout: "container.stdout.log", stderr: "container.stderr.log" },
    container: { name: `forge-${args.taskId}`, idleTimeoutMs },
    auth: { profileRequested: !!args.authProfile, stateMounted: !!authStateHostPath },
    runtime: { name: args.resolution.runtime, kind: runtimeMeta.runtimeKind, logFormat: runtimeMeta.logFormat, promptStrategy: runtimeMeta.promptStrategy, authStrategy: runtimeMeta.authStrategy },
    ...(manifestModelBlock(args.resolution) ? { model: manifestModelBlock(args.resolution) } : {}),
    ...(controlPlane ? { controlPlane } : {}),
  });

  // FG-376: resolve the dependency-cache decision BEFORE building docker args
  // for the AGENT/reviewer container. FIX1 gates the named-volume path to
  // worktree-mode rw dispatches only (repoRootForMount mirrors the
  // PROJECT_DIR the container will actually see, below).
  //
  // Provisioning (installing into the shared cache) now runs as a SEPARATE,
  // short-lived container to completion HERE — before the agent/reviewer
  // container is built at all — via provisionDependencyCache, which holds the
  // cache-key host lock for only that provisioner's lifetime, never for this
  // task's full dispatch. A concurrent dispatch for the same cache key blocks
  // inside provisionDependencyCache until the first either marks the cache
  // ready or fails without a marker; either way, by the time buildDockerArgs
  // runs below the cache is either ready (mounted read-only) or this function
  // has already returned failed. A read-only reviewer/red never provisions —
  // it only reuses an already-ready cache (no lock, no install, no block; an
  // unpopulated cache just leaves it unmounted).
  const repoRootForMount = args.worktreePath ?? args.projectDir;
  const isWorktreeRwDispatch = args.projectMode === "rw" && args.worktreePath !== undefined;
  const dependencyCacheEligible = process.platform === "darwin" && process.env.FORGE_NO_NM_SHADOW !== "1";
  const depSpawnFields: Pick<SpawnContext, "IS_WORKTREE_DISPATCH" | "DEPENDENCY_CACHE_MOUNT_RO"> = {};

  const exec = args.dockerExec ?? defaultDockerExec;

  if (dependencyCacheEligible && isWorktreeRwDispatch) {
    depSpawnFields.IS_WORKTREE_DISPATCH = "1";
    const projectContainerPath = resolveProjectContainerPath(runtime);
    let plan: DependencyVolumePlan | undefined;
    if (projectContainerPath) {
      try {
        plan = planDependencyVolumes(repoRootForMount, projectContainerPath);
      } catch {
        plan = undefined; // no lockfile — spawn.ts falls back to the legacy anonymous shadow
      }
    }
    if (plan) {
      let provisionerExitCode = -1;
      // FG-437: the real, durable provisioner container name/cacheKey — logged
      // independently of the worktree (which may be gone by the time reconcile
      // runs) so a mid-provision crash is recoverable.
      const provisionContainerName = provisionerContainerName(plan.lockfileHash);
      const provisionEventPayload = {
        containerName: provisionContainerName,
        cacheKey: plan.lockfileHash,
        phase: "dependency_provisioning" as const,
      };
      const provision = await provisionDependencyCache(plan.lockfileHash, async () => {
        logEvent("container.provision_started", {
          runId: args.runId,
          taskId: args.taskId,
          payload: provisionEventPayload,
        });
        const provisionerArgs = buildProvisionerDockerArgs(
          runtime,
          { TASK_ID: args.taskId, PROJECT_DIR: repoRootForMount },
          plan!,
        );
        const provisionStdoutPath = join(dir, "container.provision.stdout.log");
        const provisionStderrPath = join(dir, "container.provision.stderr.log");
        provisionerExitCode = await exec({
          args: provisionerArgs,
          stdin: undefined,
          stdoutPath: provisionStdoutPath,
          stderrPath: provisionStderrPath,
          idleTimeoutMs: DEPENDENCY_PROVISIONER_IDLE_TIMEOUT_MS,
        });
        const stderrTail = existsSync(provisionStderrPath) ? readFileSync(provisionStderrPath, "utf8").trim() : "";
        return { exitCode: provisionerExitCode, stderrTail };
      });
      if (provision.outcome === "failed") {
        logEvent("container.dependency_provisioning_failed", {
          runId: args.runId,
          taskId: args.taskId,
          payload: { containerName: provisionContainerName, exitCode: provisionerExitCode },
        });
        cleanupStagedAuth(dir); // AWN-8
        failTask(args.taskId, {
          runId: args.runId,
          kind: classify({ source: "verification_environment_unavailable" }),
          error: provision.error,
        });
        return { kind: "failed", error: provision.error };
      } else if (provisionerExitCode !== -1) {
        // We actually ran the provisioner (as opposed to reusing an
        // already-ready cache) and it succeeded.
        logEvent("container.provision_succeeded", {
          runId: args.runId,
          taskId: args.taskId,
          payload: provisionEventPayload,
        });
      }
      depSpawnFields.DEPENDENCY_CACHE_MOUNT_RO = "1";
    }
  } else if (dependencyCacheEligible && args.projectMode === "ro") {
    const cacheKey = safeLockfileHash(repoRootForMount);
    if (cacheKey && isDependencyCacheReady(cacheKey)) {
      depSpawnFields.DEPENDENCY_CACHE_MOUNT_RO = "1";
    }
  }

  const spawnCtx: SpawnContext = {
    TASK_ID: args.taskId,
    TASK_DIR: dir,
    // FG-351: resolve the container project mount. When worktree mode is active,
    // use the task-scoped worktree path; otherwise use the original projectDir.
    // This is the ONLY place the worktree substitution enters spawn processing.
    // The shadow-volume trigger (spawn.ts:247-259) is NOT affected.
    PROJECT_DIR: repoRootForMount,
    PROJECT_MODE: args.projectMode,
    MODEL: args.resolution.model,
    UPSTREAM_PROVIDER: args.resolution.provider ?? "",
    SYSTEM_PROMPT: args.taskPackage.composedSystemPrompt,
    TASK_PACKAGE_MARKDOWN: renderTaskPackage(args.taskPackage),
    DESIGN_DIR: args.designDir,
    AUTH_STATE_HOST_PATH: authStateHostPath,
    ...depSpawnFields,
  };

  let dockerArgs;
  try {
    dockerArgs = buildDockerArgs(runtime, spawnCtx);
  } catch (e) {
    const msg = `buildDockerArgs failed: ${(e as Error).message}`;
    cleanupStagedAuth(dir); // AWN-8
    failTask(args.taskId, { runId: args.runId, kind: classify({}), error: msg });
    return { kind: "failed", error: msg };
  }

  // FG-374: verify the resolved projectDir is a non-empty directory before
  // exec'ing — mirrors the same guard in invoke.ts.
  try {
    preflightProjectMount(args.projectDir);
  } catch (e) {
    const msg = `preflightProjectMount failed: ${(e as Error).message}`;
    cleanupStagedAuth(dir); // AWN-8
    failTask(args.taskId, { runId: args.runId, kind: classify({}), error: msg });
    return { kind: "failed", error: msg };
  }

  const stdoutPath = join(dir, "container.stdout.log");
  const stderrPath = join(dir, "container.stderr.log");
  const containerName = `forge-${args.taskId}`;
  logEvent("container.started", { runId: args.runId, taskId: args.taskId, payload: { containerName } });
  let exitCode: number;
  try {
    exitCode = await exec({
      args: dockerArgs.args,
      stdin: dockerArgs.stdin,
      stdoutPath,
      stderrPath,
      idleTimeoutMs,
    });
  } catch (e) {
    // #155: capture usage on docker failure too — tokens may have flown before crash.
    captureUsageForTask(stdoutPath, { taskId: args.taskId, ...usageMeta });
    // WALK-3: ingest progress on the crash path too — last decision/progress
    // records are most valuable in failure cases.
    emitAgentProgressEvents(dir, args.runId, args.taskId);
    cleanupStagedAuth(dir); // AWN-8
    const msg = `docker exec threw: ${(e as Error).message}`;
    failTask(args.taskId, { runId: args.runId, kind: classify({}), error: msg });
    return { kind: "failed", error: msg };
  }
  // #155: capture token usage from the stream-json log. Best-effort.
  captureUsageForTask(stdoutPath, { taskId: args.taskId, ...usageMeta });
  // WALK-3: ingest progress as soon as exec returns — BEFORE the idle-timeout /
  // crash / normal branches — so a hung or crashed agent's records still land on
  // the timeline. The events precede the terminal event, matching when written.
  emitAgentProgressEvents(dir, args.runId, args.taskId);
  cleanupStagedAuth(dir); // AWN-8: remove staged auth-state once the container is done

  // FG-461: gather the same OrphanEvidence tuple reconcile records, for a
  // recovery-relevant attached-exit kind (oom_killed / container_crash /
  // idle_timeout), so getOrphanEvidenceFromEvents surfaces it and
  // show/status/ops-check render a recovery line. Skipped for a read-only
  // dispatch (reds/audits) — they can't persist work, so there's no worktree
  // diff worth recovering. Never throws (attachedExitEvidence uses the safe git
  // probe).
  const recoveryEvidenceFor = (kind: FailureKind): OrphanEvidence | undefined =>
    args.projectMode !== "ro" && ORPHAN_EVIDENCE_KINDS.has(kind)
      ? attachedExitEvidence({
          containerName,
          worktreePath: args.worktreePath,
          projectDir: args.projectDir,
          exitCode,
          // FG-461 follow-up: attached-exit has only the exit code, never a
          // `docker inspect` OOMKilled flag — exit 137 is as likely an external
          // kill as an OOM. Leave oomKilled UNSET (unknown) so the recovery
          // message stays "exit 137 — possibly OOM or an external kill"; only the
          // reconcile path may assert a confirmed OOM.
        })
      : undefined;

  // #173: the watchdog killed a hung agent (no stdout within the idle timeout).
  // Fail with a clear reason rather than a generic container_crash.
  if (exitCode === IDLE_TIMEOUT_EXIT_CODE) {
    logEvent("container.idle_timeout", { runId: args.runId, taskId: args.taskId, payload: { containerName, exitCode } });
    const msg = `idle_timeout (no agent output for ${Math.round(idleTimeoutMs / 60000)}m)`;
    const kind = classify({ exitCode });
    failTask(args.taskId, { runId: args.runId, kind, error: msg, evidence: recoveryEvidenceFor(kind) });
    return { kind: "failed", error: msg };
  }

  // FG-376 defensive backstop: this AGENT container never sets
  // FORGE_NM_INSTALL_ROOT (only the short-lived provisioner above does, and
  // its failure is already handled well before this container is spawned) —
  // but if this sentinel exit code is ever seen here anyway, classify it the
  // same way rather than letting it fall into the generic container_crash
  // branch below.
  if (exitCode === DEPENDENCY_PROVISIONING_FAILED_EXIT_CODE) {
    const stderrTail = existsSync(stderrPath) ? readFileSync(stderrPath, "utf8").trim() : "";
    logEvent("container.dependency_provisioning_failed", { runId: args.runId, taskId: args.taskId, payload: { containerName, exitCode } });
    const msg = `verification_environment_unavailable: dependency install failed${stderrTail ? ` — ${stderrTail}` : ""}`;
    failTask(args.taskId, { runId: args.runId, kind: classify({ source: "verification_environment_unavailable" }), error: msg });
    return { kind: "failed", error: msg };
  }

  logEvent("container.exited", { runId: args.runId, taskId: args.taskId, payload: { containerName, exitCode } });

  const resultPath = join(dir, "result.json");
  const resultRaw = existsSync(resultPath) ? readFileSync(resultPath, "utf8").trim() : "";
  if (exitCode !== 0 && !resultRaw) {
    // #228: attribute a provider/model error from structured stdout before
    // defaulting to a generic container_crash.
    let kind = classify({ exitCode, resultState: "missing" });
    let msg = kind === "oom_killed"
      ? `container killed (exit ${exitCode} — possibly OOM or an external kill)`
      : `container_crash (exit ${exitCode})`;
    const a = analyzeProviderFailure({
      logFormat: runtimeMeta.logFormat,
      runtimeKind: runtimeMeta.runtimeKind,
      stdoutRaw: existsSync(stdoutPath) ? readFileSync(stdoutPath, "utf8") : "",
    });
    if (a.modelError) {
      kind = classify({ source: "model_error" });
      if (a.error) msg = a.error;
    }
    // FG-461: oom_killed / container_crash carry recovery evidence; model_error
    // is not in ORPHAN_EVIDENCE_KINDS, so recoveryEvidenceFor returns undefined.
    failTask(args.taskId, { runId: args.runId, kind, error: msg, evidence: recoveryEvidenceFor(kind) });
    return { kind: "failed", error: msg };
  }
  let result: unknown;
  try {
    if (resultRaw.length > 0) result = JSON.parse(resultRaw);
  } catch {
    const msg = "result.json malformed";
    failTask(args.taskId, { runId: args.runId, kind: classify({ resultState: "malformed" }), error: msg });
    return { kind: "failed", error: msg };
  }
  if (!result) {
    // #264: pi exits 0 even on a provider error — attribute a missing result from
    // pi's structured stdout instead of the ambiguous bare "no_result_json".
    // #267: a provider/model error is classified `model_error` (with the cause),
    // not generic result_missing.
    let msg = "no_result_json";
    let kind = classify({ resultState: "missing" });
    const a = analyzeProviderFailure({
      logFormat: runtimeMeta.logFormat,
      runtimeKind: runtimeMeta.runtimeKind,
      stdoutRaw: existsSync(stdoutPath) ? readFileSync(stdoutPath, "utf8") : "",
    });
    if (a.error) msg = a.error;
    if (a.modelError) kind = classify({ source: "model_error" });
    // FG-337: clean completion + captured assistant text + narrative role →
    // synthesize an inferred result instead of hard-failing.
    const inferred = inferredResultFrom(a, args.role);
    if (inferred) {
      writeFileSync(join(dir, "result.json"), JSON.stringify(inferred));
      return { kind: "ok", result: inferred };
    }
    failTask(args.taskId, { runId: args.runId, kind, error: msg });
    return { kind: "failed", error: msg };
  }

  return { kind: "ok", result };
}

function dispatchManualStep(runId: string, step: Step): string {
  // Look for an existing pending task; if none, create one at pending status.
  // Manual steps never spawn a container; the orchestrator advances them via forge gate.
  const existing = tasksForRun(runId).find(
    (t) => t.phase === step.id && t.parentId === undefined
  );
  if (existing) return existing.status;

  const taskId = newTaskId(step.id);
  const taskPackage: TaskPackage = {
    taskId,
    runId,
    phase: step.id,
    role: "manual",
    inputs: {},
    composedSystemPrompt: "",
  };
  insertTask({
    id: taskId,
    runId,
    phase: step.id,
    agentRole: "manual",
    status: "pending",
    taskPackage,
    createdAt: new Date().toISOString(),
  });
  logEvent("task.created", { runId, taskId, payload: { manual: true } });
  return "pending";
}

// --- Helpers ---

export type { DockerExecArgs, DockerExecFn };

// Collect completed architect + tech-lead outputs from the run and compose them
// into a spec string for reds. Returns undefined when no such tasks exist (e.g.
// a bare forge invoke with no pipeline), so the caller can omit the section.
function buildRedSpec(workflow: Workflow, allTasks: Task[]): string | undefined {
  const parts: string[] = [];
  for (const step of workflow.steps) {
    const isArchitect = step.agent === "architecture-advisor";
    const isTechLead = step.agent === "tech-lead";
    if (!isArchitect && !isTechLead) continue;
    const task = allTasks
      .filter((t) => t.phase === step.id && t.parentId === undefined && t.status === "complete")
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .pop();
    if (!task?.result) continue;
    const label = isArchitect ? "Architect intent" : "Tech-lead plan";
    parts.push(`### ${label}\n\n\`\`\`json\n${JSON.stringify(task.result, null, 2)}\n\`\`\``);
  }
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

function homeForge(): string {
  return process.env.FORGE_HOME ?? join(process.env.HOME ?? "/", ".forge");
}

// Resolve where a workflow YAML came from. Uses the receipt recorded at startRun
// when available. When absent (caller didn't pass workflowSource to startRun),
// re-probes the filesystem at dispatch time so we never claim "host" without
// checking. Returns source="unknown" with a warning if the probe itself fails —
// the receipt must never silently record "host" when the source is indeterminate.
function resolveWorkflowSource(
  workflowName: string,
  projectDir: string,
  receipt: { source: "host" | "project"; path: string } | undefined
): { source: "host" | "project" | "unknown"; path?: string; warnings?: string[] } {
  if (receipt) return receipt;
  try {
    const loaded = loadWorkflowWithSource(workflowName, { projectDir });
    return { source: loaded.source, path: loaded.path };
  } catch {
    return {
      source: "unknown",
      warnings: [`workflow source probe failed for "${workflowName}"; source recorded as unknown`],
    };
  }
}

function emptyTaskPackage(taskId: string, runId: string, phase: string, role: string): TaskPackage {
  return {
    taskId,
    runId,
    phase,
    role,
    inputs: {},
    composedSystemPrompt: "",
  };
}

function renderTaskPackage(tp: TaskPackage): string {
  const sections = [
    `# Task ${tp.taskId}`,
    ``,
    `Run: ${tp.runId}`,
    `Phase: ${tp.phase}`,
    `Role: ${tp.role}`,
    ``,
    `## Inputs`,
    ``,
    "```json",
    JSON.stringify(tp.inputs, null, 2),
    "```",
    ``,
  ];
  if (typeof tp.spec === "string" && tp.spec.trim().length > 0) {
    sections.push(`## Spec`, ``, tp.spec, ``);
  }
  // Reds receive the upstream artifact (the primary's result.json) here. The red
  // seeds read it from `## Artifact under review` by name; without this section a
  // red sees only empty inputs and reports "no artifact provided" (forge-site bug).
  if (typeof tp.artifact === "string" && tp.artifact.trim().length > 0) {
    sections.push(`## Artifact under review`, ``, "```json", tp.artifact, "```", ``);
  }
  return [
    ...sections,
    `## Output contract`,
    ``,
    `Write a single JSON object to /task/result.json with at minimum the fields {"status": "complete"|"failed", ...role-specific output}.`,
    ``,
  ].join("\n");
}

// #176: the run-level auth profile (from `forge new --auth-profile`) applies
// only to browser-capable PRIMARY roles — non-browsing roles don't need the
// credential and would trip the browser-tools guard. Reds never reach here
// (runOneRed doesn't pass authProfile).
function authProfileForRole(runMetadata: Record<string, unknown>, role: string): string | undefined {
  const profile = runMetadata["authProfile"];
  if (typeof profile !== "string" || !profile) return undefined;
  return roleUsesBrowser(role) ? profile : undefined;
}

// AWN-7: a run-level model-profile override (from `forge new --profile`) pins
// EVERY task in the run — primary, red, and fanout child — to one profile at
// the highest profile-selection precedence (above agent overrides and activity
// defaults), exactly as `forge invoke --profile` does for a single agent.
// Returns undefined when the run wasn't started with --profile, leaving
// project/user policy in charge; in legacy mode (no model-policy.yml) the
// resolver ignores it. Passed with profileSource "run.profile" so the manifest
// and `forge show` distinguish a whole-run operator pin from a per-invoke flag.
function runModelProfile(runMetadata: Record<string, unknown>): string | undefined {
  const profile = runMetadata["modelProfile"];
  return typeof profile === "string" && profile ? profile : undefined;
}

function runTagsFromMetadata(runMetadata: Record<string, unknown>): string[] | undefined {
  const tags = runMetadata["tags"];
  return Array.isArray(tags) ? (tags as string[]) : undefined;
}
