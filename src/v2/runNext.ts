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
import { productionDockerExec, finalizeContainerRetention, type DockerExecArgs, type DockerExecFn } from "./docker-exec.js";
import { join } from "node:path";
import type { Task, TaskPackage, Verdict, Finding, RedAuthority, ReviewerContextPacket, DoneAuditResult } from "../types/index.js";
import type { Workflow, Step, Runtime, RedDef, FanoutDef } from "./schema.js";
import { resolveRuntimeMetadata } from "./schema.js";
import { analyzeProviderFailure } from "./provider-failure.js";
import { tasksForRun } from "../store/tasks.js";
import { getRun } from "../store/runs.js";
import { finalizeRunIfSettled } from "./run-finalize.js";
import { notifyOnTaskBlockedByRed, notifyOnGateAwaiting } from "../notify/trigger.js";
import { insertTask, getTask, markTaskRunning, markTaskComplete, markTaskAwaitingGate, markTaskAwaitingRecovery, markTaskHeldForGate, markTaskBlockedByRed, markTaskFailed, setTaskStatus, setTaskWorktreePath } from "../store/tasks.js";
import { failTask, classify, ORPHAN_EVIDENCE_KINDS } from "./failure-kind.js";
import type { FailureKind, OrphanEvidence, ContainerCausalEvidence } from "./failure-kind.js";
import { captureUsageForTask } from "../store/model-calls.js";
import { insertVerdict, verdictsForTask } from "../store/verdicts.js";
import { getDb, writeTransaction } from "../store/db.js";
import { crashPoint } from "./crash-points.js";
import { assembleReviewerContextPacket } from "./reviewer-context-packet.js";
import { validateVerdict } from "./validate-findings.js";
import { gradeFindings } from "./review-quality.js";
import { logEvent } from "../store/events.js";
import { taskDir, integrationWorktreeDir } from "../util/paths.js";
import { computeReadyQueue, isRunSettled, resolvePhasePrimary } from "./ready-queue.js";
import { classifyTaskLineage, isWorkflowPrimaryRow } from "./lifecycle-evaluator.js";
import { finalizeOrphanedPrimaries, attachedExitEvidence } from "./reconcile.js";
import { checkResultPersistence, persistenceErrorMessage } from "./persistence-check.js";
import { verdictBlocksGate } from "./gate.js";
import { evaluateValidationContract } from "./validation-contract.js";
import { deriveUpstream } from "./inputs.js";
import { composeSystemPrompt } from "./compose.js";
import { filterConstraints, loadAllConstraints } from "./constraints.js";
import { buildDockerArgs, buildProvisionerDockerArgs, resolveProjectContainerPath, preflightProjectMount, type SpawnContext } from "./spawn.js";
import { resolveAuthStateForContainer, AuthProfileError, roleUsesBrowser, cleanupStagedAuth } from "./auth-state.js";
import { loadProjectAuthProfile, resolveProjectAuthForContainer, ProjectAuthError } from "./project-auth.js";
import { writeTaskManifest, manifestControlPlaneBlock } from "./task-manifest.js";
import { resolveDocsSurfacesReceipt } from "./contract.js";
import { emitAgentProgressEvents } from "./agent-progress.js";
import { loadRuntimeWithSource, loadModelPolicyWithSource, loadWorkflow, loadWorkflowWithSource, type ModelPolicyWithSource } from "./loader.js";
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
import { recoverStructuredStreamResult } from "./stream-result-recovery.js";
// FG-351/FG-352: worktree lifecycle — gate check, create, merge-back, cleanup.
// FG-353: integration worktree helpers added.
import {
  isWorktreeModeEnabled,
  preflightWorktreeGate,
  createWorktree,
  worktreeBranchName,
  removeWorktreeIfSafe,
  cleanupFailedWorktreeSetup,
  integrationBranchName,
  integrationBranchExists,
  createIntegrationWorktree,
  mergeChildIntoIntegration,
  cleanupIntegrationWorktree,
} from "./worktree-lifecycle.js";
// FG-425: every merge→publish path in this file routes through the serialized
// integration publisher. runIntegrationGate is deliberately NOT imported here any
// more — the gate now runs inside the publisher, against the candidate worktree,
// never against the publish target.
import {
  publishIntegration,
  finalizePublication,
  recoverUnfinishedPublications,
  recoverPublicationAttemptForOperator,
  type OperatorRecovery,
  type PublishOutcome,
  type ValidationResult,
} from "./integration-publisher.js";
import { getPublicationAttempt, publicationAttemptsForTask } from "../store/publications.js";

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
  // FG-425 (AC5): step ids whose publication advanced the target ref and then lost the
  // window — non-terminal, and NOT failures. Reported separately precisely so nothing
  // downstream can read them as "this step failed, retry it".
  awaitingRecovery: string[];
  runStatus: string;              // post-call run status
};

// FG-365: runContainer previously called loadModelPolicyWithSource once per
// container dispatch — a fan-out of N children + M reds re-read/re-parsed the
// same model-policy.yml N+M times. Built once per runNext() call and threaded
// down through dispatch/runContainer (same pattern as dockerExec) so every
// dispatch in the wave shares one resolution per projectDir. Fan-out reds run
// against the integration worktree (a different projectDir than the children),
// so this keys by projectDir rather than collapsing to a single value.
function createModelPolicyResolver(
  loader: typeof loadModelPolicyWithSource = loadModelPolicyWithSource,
): (projectDir: string) => ModelPolicyWithSource {
  const cache = new Map<string, ModelPolicyWithSource>();
  return (projectDir: string) => {
    const cached = cache.get(projectDir);
    if (cached) return cached;
    const resolved = loader({ projectDir });
    cache.set(projectDir, resolved);
    return resolved;
  };
}

export async function runNext(args: {
  runId: string;
  workflow: Workflow;
  // For testing: override the docker spawn. Real callers leave this undefined
  // and the real `docker run ...` is invoked via buildDockerArgs + child_process.
  dockerExec?: DockerExecFn;
  // For testing: override/spy on the model-policy loader. Real callers leave
  // this undefined and the real loadModelPolicyWithSource is used.
  modelPolicyLoader?: typeof loadModelPolicyWithSource;
}): Promise<RunNextResult> {
  const run = getRun(args.runId);
  if (!run) throw new Error(`runNext: run not found: ${args.runId}`);

  if (run.status !== "active") {
    return {
      dispatchedSteps: [],
      completedSteps: [],
      awaitingGate: [],
      failedSteps: [],
      awaitingRecovery: [],
      runStatus: run.status,
    };
  }

  // Self-heal orphaned duplicate primaries before computing the ready queue, so a
  // stranded pending retry-primary neither poisons phase advancement nor keeps the
  // run from completing at the end. No-op on healthy runs.
  finalizeOrphanedPrimaries(args.runId);

  // FG-425 (AD-5): converge any publication attempt left INSIDE the publication
  // window by a crash — the one non-terminal state in which the target may already
  // have been mutated. Recovery is derived from {baseSha, candidateSha,
  // currentTargetSha} and the RECORDED target ref; the working tree is never
  // inspected. Runs BEFORE this wave can publish anything of its own against the
  // same project. A defined recovery that nothing invokes is not a recovery — it is
  // a manual procedure nobody knows to run. No-op on healthy projects.
  if (run.projectDir) recoverUnfinishedPublications(run.projectDir, args.runId);

  // FG-425 (AC5): converge the PUBLICATION from the ref (above), then reconcile the
  // TASK from the publication. A task parked in `awaiting_recovery` by a lost window
  // is moved onto whatever that convergence recorded — complete when its candidate
  // landed, terminally failed when it provably did not. Without this second half, a
  // converged `published` attempt would sit forever beside a task that disagrees with
  // it. Runs BEFORE the ready queue, so a reconciled task advances its phase in the
  // same wave.
  if (run.projectDir) reconcilePublicationRecoveries(args.runId, args.workflow, run.projectDir);

  const tasks = tasksForRun(args.runId);
  const ready = computeReadyQueue(args.workflow, tasks);

  if (ready.length === 0) {
    // Either everything's done, gated, running (some other runNext is in flight),
    // or — the hang this branch used to miss entirely — a step failed terminally
    // with no pending replacement and no on_reject fired, permanently stranding
    // every downstream step with unmet deps that will never dispatch. Zero I/O
    // happens in that case (nothing here is "ready"), so a caller looping on
    // runNext would spin forever without this check ever moving run.status off
    // "active". isRunSettled distinguishes that terminal case from a legitimate
    // "waiting on a human gate / another runNext in flight" pause.
    if (isRunSettled(args.workflow, tasks)) {
      // AWN-2 cancel-vs-completion race: a concurrent `forge cancel` may have
      // abandoned the run between the getRun at the top of runNext and this
      // write. finalizeRunIfSettled re-reads the run before flipping it to
      // complete — an abandoned run is authoritatively terminal and must
      // never be resurrected.
      const finalized = finalizeRunIfSettled(args.runId, "runNext-settled-no-dispatch");
      const currentStatus = finalized ? "complete" : (getRun(args.runId)?.status ?? run.status);
      return {
        dispatchedSteps: [],
        completedSteps: [],
        awaitingGate: [],
        failedSteps: [],
        awaitingRecovery: [],
        runStatus: currentStatus,
      };
    }
    return {
      dispatchedSteps: [],
      completedSteps: [],
      awaitingGate: [],
      failedSteps: [],
      awaitingRecovery: [],
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
  const getModelPolicy = createModelPolicyResolver(args.modelPolicyLoader);
  const outcomes = await Promise.all(
    ready.map((step) => dispatchStep({
      runId: args.runId,
      workflow: args.workflow,
      step,
      projectDir: run.projectDir!,
      designDir,
      runMetadata: run.metadata ?? {},
      dockerExec: args.dockerExec,
      getModelPolicy,
    }))
  );

  const completed: string[] = [];
  const awaitingGate: string[] = [];
  const failed: string[] = [];
  // FG-425 (AC5): its OWN bucket. Folding it into failedSteps would be the same lie
  // one layer up — a step whose candidate may already be on the target is not a
  // failed step, and nothing downstream may treat it as one.
  const awaitingRecovery: string[] = [];
  for (let i = 0; i < ready.length; i++) {
    const stepId = ready[i]!.id;
    const status = outcomes[i]!;
    if (status === "complete") completed.push(stepId);
    else if (status === "awaiting_gate" || status === "blocked_by_red") awaitingGate.push(stepId);
    else if (status === "awaiting_recovery") awaitingRecovery.push(stepId);
    else if (status === "failed") failed.push(stepId);
  }

  // If every step completed and no more steps remain ready in the workflow,
  // the run is done. Check by recomputing after this wave's writes.
  const tasksAfter = tasksForRun(args.runId);
  const readyAfter = computeReadyQueue(args.workflow, tasksAfter);

  let runStatus: string = run.status;
  if (readyAfter.length === 0 && isRunSettled(args.workflow, tasksAfter)) {
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
    // finalizeRunIfSettled re-reads the run before writing: a concurrent
    // `forge cancel` may have abandoned it while this wave ran, and an
    // abandoned run must never be resurrected to complete (AWN-2).
    if (finalizeRunIfSettled(args.runId, "runNext-wave-complete", { anyFailed })) {
      runStatus = "complete";
    }
  }
  // Re-read once more for reporting: a concurrent `forge cancel` may have
  // abandoned the run either before or during the block above (including
  // when it was never settled enough to attempt finalization at all) — the
  // returned runStatus must reflect that authoritatively.
  if (getRun(args.runId)?.status === "abandoned") {
    runStatus = "abandoned";
  }

  return {
    dispatchedSteps: dispatched,
    completedSteps: completed,
    awaitingGate,
    failedSteps: failed,
    awaitingRecovery,
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
  getModelPolicy: (projectDir: string) => ModelPolicyWithSource;
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
      getModelPolicy: args.getModelPolicy,
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
    getModelPolicy: args.getModelPolicy,
  });
}

// FG-503: wraps finalizeContainerRetention for every call site where the
// primary genuinely completed — a "reap_failed" outcome there is a silent,
// unsweepable leak (docker rm errored; container + DEC-019 shadow volume left
// behind), so it's recorded as a durable event `forge ops reap-containers` can
// later pick up by age. The reaped/retained outcomes stay exactly as silent
// as before FG-503.
function reapContainerAndReportFailure(containerName: string, taskSucceeded: boolean, runId: string, taskId: string): void {
  const outcome = finalizeContainerRetention(containerName, taskSucceeded);
  if (outcome === "reap_failed") {
    try {
      logEvent("container.reap_failed", {
        runId,
        taskId,
        payload: { containerName, why: "docker rm -f -v failed after task completion; container may still be running/present with its anonymous shadow volume" },
      });
    } catch {
      // best-effort — a logging failure must never fail the run
    }
  }
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
  getModelPolicy: (projectDir: string) => ModelPolicyWithSource;
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
  //
  // FG-476: when the phase has no pending parentId===undefined primary — the
  // normal case once a phase's primary has already completed — fall back to a
  // pending on_reject recovery row (marker-tagged via isOnRejectRecoveryTask)
  // scoped to this phase. This is computeReadyQueue's admission exception
  // reaching dispatch: a gate reject whose on_reject targets an already-complete
  // step leaves exactly this shape (complete primary + pending recovery task).
  // Reuse the recovery row's OWN id/parentId — never rewrite it to a fresh
  // parentId===undefined primary, which would sever the rejectedTaskId lineage
  // and duplicate the phase's primary. A fanout/red child (parentId-tagged,
  // no marker) never matches isOnRejectRecoveryTask, so it's never picked up here.
  //
  // FG-507: an ad-hoc invoke row is a pending parentId===undefined row in phase
  // `task` too, and on a workflow that declares a `task` step it would otherwise
  // be reused here and run as that step. It is never this workflow's work.
  //
  // FG-477: both matches are KIND questions, so both go through the lineage
  // classifier. `isWorkflowPrimaryRow` is exactly the old
  // `parentId === undefined && !isAdHocInvokeTask(t)` pair (primary +
  // retry_replacement + the marker-less legacy row consumers already counted),
  // and `on_reject_recovery` is exactly isOnRejectRecoveryTask.
  const phaseTasks = args.parentId === undefined ? tasksForRun(args.runId) : [];
  const kinds = classifyTaskLineage(args.workflow, phaseTasks);
  const existing = args.parentId === undefined
    ? phaseTasks.find(
        (t) => t.phase === phase && t.status === "pending" && isWorkflowPrimaryRow(kinds.get(t.id)!)
      ) ?? phaseTasks.find(
        (t) => t.phase === phase && t.status === "pending" && kinds.get(t.id) === "on_reject_recovery"
      )
    : undefined;
  const taskId = existing?.id ?? newTaskId(phase);

  // FG-425 re-entry: gate.ts force-advanced this task over a red rejection. Its
  // work is UNPUBLISHED (the publisher refuses to publish a red-rejected candidate),
  // so the human's "publish it anyway" has to actually publish it. Re-enter straight
  // at the publication step — the agent already ran, so nothing is re-dispatched and
  // no container starts. Mirrors dispatchFanoutStep's gateForced re-entry.
  if (existing?.taskPackage?.inputs?.["gateForced"] === true) {
    return await republishForcedPrimary(args, existing);
  }

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
  // This merge (and the taskPackage built from it below) is dispatch-time-only:
  // on a reuse, it drives the live container's inputs but is never written back
  // to the task's DB row (no reuse path here calls updateTaskPackageInputs).
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
    // FG-512: runner-minted row — total dispatch provenance (see taskDispatchKind).
    dispatchSource: "workflow",
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
    getModelPolicy: args.getModelPolicy,
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
  crashPoint("dispatchSingleStep:after-result-ingest");
  // FG-492 review: runContainer deliberately left the reap/retain decision to
  // us — a valid result doesn't mean the STEP succeeds; persistence, merge,
  // the integration gate, reds, and a human gate can still fail/pause it
  // below. Reap only once we reach the actual "complete" outcome; every
  // return before that retains (see finalizeContainerRetention calls below).
  const containerName = dispatchResult.containerName;

  // #254: persistence assertion. If the agent reports a complete result with
  // files_modified but none of those files landed on the host project mount, the
  // work was written to an ephemeral path and discarded — fail loudly (don't run
  // reds, don't gate over an empty diff) instead of advancing on a green lie.
  const persistence = await checkResultPersistence(primaryWorktreePath ?? args.projectDir, result);
  if (!persistence.ok) {
    const error = persistenceErrorMessage(persistence);
    failTask(taskId, { runId: args.runId, kind: "work_not_persisted", error, result });
    finalizeContainerRetention(containerName, false);
    return "failed";
  }

  // FG-523 (F19): the validation contract is evaluated BEFORE reds dispatch — and
  // therefore before publication, since the reds are now part of the validation
  // that gates it. A primary that fails the contract must land the NAMED validation
  // hold: evaluating it after the reds would let an authoritative red fail win the
  // race and park the task at blocked_by_red, which says nothing about the missing
  // tests_run and takes a --force to clear. A result that doesn't meet the contract
  // isn't worth spending reds — or a publication — on either.
  crashPoint("dispatchSingleStep:before-validation-contract");
  const contractHold = holdIfValidationContractFails(taskId, args.runId, result);
  if (contractHold) {
    finalizeContainerRetention(containerName, false);
    return contractHold;
  }

  // FG-425: publish the task's work through the serialized integration publisher.
  //
  // ORDER IS THE WHOLE POINT. This path used to merge the task branch straight into
  // run.projectDir HEAD and only THEN gate the (already-published) target. The first
  // cut of FG-425 fixed the gate but still published BEFORE the reds ran — so a
  // red-REJECTED candidate had already reached the target, which is the very thing
  // the ticket exists to prevent. The order is now the ticket's:
  //
  //   validate candidate C (integration gate → reds → review) → short lock → CAS-publish C
  //
  // The reds run INSIDE the publisher's `validate`, against the candidate worktree
  // at candidateSha. That placement is what makes an AD-1 moved-base rebuild sound:
  // the rebuild re-runs `validate` for the NEW candidate, so the reds see the
  // REBUILT tree. A rebuild that re-ran only the gate would publish a tree no red
  // ever looked at.
  //
  // Skipped entirely when primaryWorktreePath is undefined — the default/
  // non-worktree path is byte-for-byte unchanged: no lane, no lock, no gate.
  let publicationAttemptId: string | undefined;
  let redAggregate: RedAggregate | undefined;

  // Reds against a given tree. Called with the CANDIDATE worktree when publishing
  // (so the reds review exactly what will land, and an AD-1 rebuild re-runs them
  // against the REBUILT tree), and with args.projectDir in non-worktree mode.
  const runRedsAgainst = async (dir: string): Promise<ValidationResult> => {
    if (step.reds.length === 0) return { ok: true };
    // Per FORGE-DEC-017: blue is done, reds are about to run.
    crashPoint("dispatchSingleStep:before-awaiting-red");
    setTaskStatus(taskId, "awaiting_red");
    crashPoint("dispatchSingleStep:between-awaiting-red-status-and-event");
    logEvent("task.awaiting_red", { runId: args.runId, taskId });
    crashPoint("dispatchSingleStep:after-awaiting-red");
    redAggregate = await dispatchReds({
      runId: args.runId,
      workflow: args.workflow,
      step,
      primaryTaskId: taskId,
      primaryResult: result,
      projectDir: dir,
      designDir: args.designDir,
      runMetadata: args.runMetadata,
      dockerExec: args.dockerExec,
      getModelPolicy: args.getModelPolicy,
    });
    return redRejection(redAggregate);
  };

  // The blocked_by_red landing. Aggregation policy mirrors v1 gate.ts: any
  // authoritative fail with gate_on_verdict => blocked_by_red.
  const landBlockedByRed = async (): Promise<string> => {
    // FG-482: status + result written together in one CAS'd UPDATE — the task is
    // never observable as awaiting_gate mid-transition. If the CAS lost a race
    // (task no longer awaiting_red), report its actual status rather than
    // logging/notifying a transition that didn't happen.
    let blockedByRedApplied = false;
    crashPoint("dispatchSingleStep:before-blocked-by-red");
    writeTransaction(() => {
      blockedByRedApplied = markTaskBlockedByRed(taskId, result);
      crashPoint("dispatchSingleStep:inside-blocked-by-red-txn");
      if (blockedByRedApplied) {
        logEvent("task.blocked_by_red", { runId: args.runId, taskId });
      }
    });
    crashPoint("dispatchSingleStep:after-blocked-by-red");
    // FG-492 review: blocked_by_red (whether applied here or lost to a concurrent
    // transition) is never "complete" — retain either way.
    finalizeContainerRetention(containerName, false);
    if (!blockedByRedApplied) {
      return getTask(taskId)?.status ?? "failed";
    }
    // Fire-and-forget SMS notification (no-op unless FORGE_NOTIFY=twilio).
    const runForNotify = getRun(args.runId);
    if (runForNotify) void notifyOnTaskBlockedByRed(runForNotify);
    return "blocked_by_red";
  };

  if (primaryWorktreePath) {
    const publication = await publishIntegration({
      runId: args.runId,
      taskId,
      projectDir: args.projectDir,
      sources: [
        { branch: worktreeBranchName(args.runId, taskId), worktreePath: primaryWorktreePath, label: `task ${taskId}` },
      ],
      // Runs AFTER the publisher's integration gate has passed against this
      // candidate — and once per candidate, so a rebuild re-runs it too.
      alsoValidate: (candidateDir) => runRedsAgainst(candidateDir),
    });
    publicationAttemptId = publication.attemptId;
    logEvent("integration.published", {
      runId: args.runId,
      taskId,
      payload: {
        attemptId: publication.attemptId,
        outcome: publication.kind,
        ...(publication.kind === "published"
          ? {
              target: publication.target,
              baseSha: publication.baseSha,
              candidateSha: publication.candidateSha,
              publishedSha: publication.publishedSha,
              rebuilds: publication.rebuilds,
            }
          : {}),
      },
    });

    if (publication.kind !== "published") {
      // FG-425 (AC5): the ref advance landed and the window was lost. There is no
      // terminal truth to write yet — least of all a failure telling the operator
      // nothing was published. Land the task RECOVERABLE and leave it there.
      if (publication.kind === "recovery_pending") {
        finalizeContainerRetention(containerName, false);
        return awaitPublicationRecovery(taskId, args.runId, publication, result);
      }
      // A red REJECTED the candidate: that is blocked_by_red (a human decision to
      // make), not a task failure — and, critically, NOTHING was published. The
      // target is still at the base the candidate was built on.
      if (redAggregate?.authoritativeFail) {
        return await landBlockedByRed();
      }
      // No-discard on every other failure path: the candidate and task worktrees
      // are retained for inspection, exactly as the old merge_conflict contract did.
      failTask(taskId, {
        runId: args.runId,
        kind: publicationFailureKind(publication),
        error: publicationFailureError(publication),
        result,
      });
      finalizeContainerRetention(containerName, false);
      return "failed";
    }

    // FG-367: best-effort gap-fill — record the merge-HEAD SHA on the ticket
    // when the agent did not capture it at close time. Swallowed entirely so
    // a git or backlog error never fails the run.
    try {
      const ticketId = getRun(args.runId)?.title;
      if (ticketId) {
        fillClosedCommit(args.projectDir, ticketId, publication.publishedSha);
      }
    } catch {
      // swallow — gap-fill is advisory, must not fail the run
    }
  } else {
    // Non-worktree mode: no candidate, no publisher. Reds run against the project
    // directory exactly as they always did.
    const reds = await runRedsAgainst(args.projectDir);
    if (!reds.ok) return await landBlockedByRed();
  }

  const finalStatus = finalizePrimary(taskId, args.runId, step.gate, result);
  // FG-492 review: reap only on the real "complete" outcome — gate=human/verdict
  // returns "awaiting_gate" (paused, not failed, but not done either), and a lost
  // CAS race reports the task's actual terminal status. Anything else retains.
  // FG-503: same reap_failed durability rule too — see reapContainerAndReportFailure.
  reapContainerAndReportFailure(containerName, finalStatus === "complete", args.runId, taskId);
  // FG-352: cleanup after a proven-merged worktree (provenMerged=true because the
  // publication above landed the candidate). Also removes in EPHEMERAL test mode.
  if (finalStatus === "complete" && primaryWorktreePath) {
    removeWorktreeIfSafe(primaryWorktreePath, args.runId, taskId, args.projectDir, true);
    // FG-425: idempotent, best-effort — a leaked candidate worktree must never
    // fail a publication that already landed.
    if (publicationAttemptId) finalizePublication(args.projectDir, publicationAttemptId);
  }
  return finalStatus;
}

/** FG-425: the single-primary counterpart of dispatchFanoutStep's gateForced
 *  re-entry.
 *
 *  A blocked_by_red primary has published NOTHING — the publisher validates the
 *  candidate (gate → reds → review) and only publishes once all of it passes. When
 *  a human force-advances over that rejection, "advance" has to mean "publish it
 *  anyway", so the task re-enters here and runs the publication step alone: the
 *  agent already ran, so no container is dispatched and no red is re-collected (the
 *  human overrode them, with a recorded rationale — that IS the decision).
 *
 *  The integration gate still runs against the candidate. A human overriding a red
 *  is not a human overriding a broken build, and they did not ask to. */
async function republishForcedPrimary(
  args: {
    runId: string;
    projectDir: string;
    workflow: Workflow;
    designDir?: string;
    runMetadata: Record<string, unknown>;
    dockerExec?: DockerExecFn;
    getModelPolicy: (projectDir: string) => ModelPolicyWithSource;
  },
  task: Task,
): Promise<string> {
  markTaskRunning(task.id);
  const worktreePath = task.worktreePath;
  if (typeof worktreePath !== "string") {
    // gate.ts only sets gateForced on a task with a worktree (or a fanout parent,
    // which never reaches this function) — there is nothing to publish without one.
    failTask(task.id, {
      runId: args.runId,
      kind: classify({}),
      error: `re-entry: task ${task.id} was force-advanced but has no worktree — nothing to publish`,
    });
    return "failed";
  }

  const publication = await publishIntegration({
    runId: args.runId,
    taskId: task.id,
    projectDir: args.projectDir,
    sources: [
      { branch: worktreeBranchName(args.runId, task.id), worktreePath, label: `task ${task.id}` },
    ],
    // No alsoValidate: the publisher's integration gate still runs against the
    // candidate, but the reds are not re-collected — the human overrode them.
  });
  logEvent("integration.published", {
    runId: args.runId,
    taskId: task.id,
    payload: {
      attemptId: publication.attemptId,
      outcome: publication.kind,
      reEntry: true,
      ...(publication.kind === "published"
        ? {
            target: publication.target,
            baseSha: publication.baseSha,
            candidateSha: publication.candidateSha,
            publishedSha: publication.publishedSha,
            rebuilds: publication.rebuilds,
          }
        : {}),
    },
  });
  if (publication.kind !== "published") {
    if (publication.kind === "recovery_pending") {
      return awaitPublicationRecovery(task.id, args.runId, publication, task.result);
    }
    failTask(task.id, {
      runId: args.runId,
      kind: publicationFailureKind(publication),
      error: publicationFailureError(publication),
      result: task.result,
    });
    return "failed";
  }

  // Complete directly rather than re-gating: the human advance decision was already
  // recorded when `gate advance --force` ran, and finalizePrimary would bounce a
  // verdict/human gate back to awaiting_gate instead of completing it (FG-353).
  if (!markTaskComplete(task.id, task.result)) {
    return getTask(task.id)?.status ?? "failed";
  }
  logEvent("task.completed", { runId: args.runId, taskId: task.id });
  removeWorktreeIfSafe(worktreePath, args.runId, task.id, args.projectDir, true);
  finalizePublication(args.projectDir, publication.attemptId);
  return "complete";
}

type RedAggregate = Awaited<ReturnType<typeof dispatchReds>>;

/** FG-425: shape a red aggregate as a ValidationResult, so the reds are part of the
 *  SAME validation set the publisher gates a publication on (and re-runs on an AD-1
 *  rebuild). An authoritative red fail REFUSES the publication — the candidate never
 *  reaches the target. The caller turns that refusal into blocked_by_red, which is a
 *  human decision, not the plain task failure the publisher's other refusals map to. */
function redRejection(aggregate: RedAggregate): ValidationResult {
  return aggregate.authoritativeFail
    ? { ok: false, error: "an authoritative red REJECTED the candidate — refusing to publish it" }
    : { ok: true };
}

// FG-523 (F19): enforce the validation contract on a workflow primary's result,
// BEFORE anything else can claim the task's outcome (reds dispatch, the gate).
// Returns the task's status when the result is held (or when a concurrent cancel
// won the CAS), and null when the result may proceed.
//
// Only the primary path calls this. A fanout PARENT is exempt: its result is a
// synthetic aggregate ({status, children}) that never carries tests_run — the
// agent results live on the children, which are not primaries and finalize
// through markTaskComplete.
function holdIfValidationContractFails(taskId: string, runId: string, result: unknown): string | null {
  const role = getTask(taskId)?.agentRole ?? "";
  const contract = evaluateValidationContract({ role, result });
  if (contract.held) {
    // Fail-safe: hold for a gate decision rather than advance. CAS'd so a
    // concurrent cancel that already failed the task isn't resurrected.
    if (!markTaskHeldForGate(taskId, result)) {
      return getTask(taskId)?.status ?? "failed";
    }
    crashPoint("holdIfValidationContractFails:between-hold-status-and-event");
    logEvent("task.awaiting_gate", {
      runId,
      taskId,
      payload: { kind: "validation_contract", reason: contract.reason },
    });
    notifyGateAwaiting(taskId);
    return "awaiting_gate";
  }
  if (contract.waiver !== undefined) {
    // The waiver advances the task, but it must leave a record.
    logEvent("task.decision", {
      runId,
      taskId,
      payload: { kind: "validation_waiver", reason: contract.waiver },
    });
  }
  return null;
}

// Final status write for a primary task (no reds path, or reds passed).
function finalizePrimary(
  taskId: string,
  runId: string,
  gate: Step["gate"],
  result: unknown,
): string {
  crashPoint("finalizePrimary:before-status-write");
  switch (gate) {
    case "auto":
    case "none":
      // AWN-2 task-level race: don't overwrite a task a concurrent cancel already
      // marked failed. The CAS only completes a non-terminal task; if it didn't,
      // report the task's actual (cancelled/failed) terminal status.
      if (!markTaskComplete(taskId, result)) {
        return getTask(taskId)?.status ?? "failed";
      }
      crashPoint("finalizePrimary:between-complete-status-and-event");
      logEvent("task.completed", { runId, taskId });
      return "complete";
    case "human":
      markTaskAwaitingGate(taskId, result);
      crashPoint("finalizePrimary:between-awaiting-gate-status-and-event");
      logEvent("task.awaiting_gate", { runId, taskId });
      notifyGateAwaiting(taskId);
      return "awaiting_gate";
    case "verdict":
      // Schema enforces reds.length > 0 for gate=verdict, so this is reached
      // only when all reds passed (or none authoritative-failed). Aggregate
      // outcome is the orchestrator's call; pause for it.
      markTaskAwaitingGate(taskId, result);
      crashPoint("finalizePrimary:between-awaiting-gate-status-and-event");
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
  getModelPolicy: (projectDir: string) => ModelPolicyWithSource;
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
      getModelPolicy: args.getModelPolicy,
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
    crashPoint("dispatchReds:before-verdict-insert");
    writeTransaction(() => {
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
        // FG-523 (F16): persist the in-hand red config so the later gate
        // re-check applies the same blocking rule dispatch applies below.
        gateOnVerdict: r.red.gate_on_verdict,
      });
      crashPoint("dispatchReds:inside-verdict-insert-txn");
      logEvent("verdict.received", {
        runId: args.runId,
        taskId: args.primaryTaskId,
        payload: { redRole: r.red.agent, verdict: finalVerdict.verdict, authority: r.red.authority },
      });
    });
    crashPoint("dispatchReds:after-verdict-insert");
    // Gate on the GRADED verdict — a fail emptied by grading no longer blocks.
    // FG-523: same predicate aggregateVerdicts applies to the persisted row.
    if (verdictBlocksGate({
      verdict: finalVerdict.verdict,
      authority: r.red.authority as RedAuthority,
      gateOnVerdict: r.red.gate_on_verdict,
    })) {
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
  getModelPolicy: (projectDir: string) => ModelPolicyWithSource;
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
    // FG-512: runner-minted red row — total dispatch provenance.
    dispatchSource: "workflow",
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
    getModelPolicy: args.getModelPolicy,
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
  const redCompleted = markTaskComplete(redTaskId, result.result);
  if (redCompleted) {
    logEvent("task.completed", { runId: args.runId, taskId: redTaskId });
  }
  // FG-492 review: a red is read-only (no merge/gate downstream) — its
  // container's fate is decided right here. Reap only if the CAS above
  // actually completed it; a lost race to a concurrent cancel retains.
  // FG-503 (review): route through reapContainerAndReportFailure like the
  // other success-path reaps in this file — a reap failure here is the same
  // silent, unsweepable leak.
  reapContainerAndReportFailure(result.containerName, redCompleted, args.runId, redTaskId);
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
  getModelPolicy: (projectDir: string) => ModelPolicyWithSource;
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
        // Skip child dispatch and red dispatch — validate the candidate and publish.
        // FG-425: the integration branch is the candidate SOURCE; the publisher
        // rebuilds it on the target's current base in its own fresh worktree, gates
        // THAT, and CAS-publishes the exact commit it gated. The reds are not
        // re-dispatched (redsAlreadyRan): a human already overrode their verdict
        // with a recorded rationale, which is what gateForced means.
        const childTasksForCleanup: ChildOutcome[] = allTasks
          .filter(
            (t) =>
              t.parentId === existingParent.id &&
              !t.agentRole.startsWith("red-") &&
              t.status === "complete",
          )
          .map((t, index): ChildOutcome => ({
            childTaskId: t.id,
            index,
            value: undefined,
            status: "complete",
            ...(typeof t.worktreePath === "string" ? { worktreePath: t.worktreePath } : {}),
          }));
        const published = await publishFanoutIntegration(
          args,
          existingParent.id,
          savedResult,
          childTasksForCleanup,
          { reEntry: true },
        );
        if (published !== "complete") return published;
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
  // FG-519: canonical latest-complete parent-less primary — pure parity with the
  // prior inline filter/sort/pop (which already selected latest-complete here).
  const upstreamTask = resolvePhasePrimary(allTasks, fanout.from_upstream.step);
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
        // FG-512: runner-minted fanout parent row — total dispatch provenance.
        dispatchSource: "workflow",
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
        getModelPolicy: args.getModelPolicy,
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
          getModelPolicy: args.getModelPolicy,
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

  // FG-425: validation (integration gate + reds) and publication, in that order.
  //
  // Reds run per-parent on the aggregate (FORGE-DEC / #139: not per-child), and they
  // now run INSIDE the publisher's validation span, against the CANDIDATE worktree —
  // the exact tree that will be published. Two consequences, both required by the
  // ticket:
  //
  //   - The reds review what actually lands, not a tree that merely resembles it.
  //     (Before FG-425 they reviewed the FG-353 integration worktree, which was built
  //     on whatever base the run started from — not necessarily the one published to.)
  //   - An AD-1 moved-base rebuild re-runs the FULL validation set (gate AND reds)
  //     for the NEW candidateSha. Re-running only the gate would publish a rebuilt
  //     tree that no red ever saw.
  let redAggregate: RedAggregate | undefined;

  const runFanoutRedsAgainst = async (dir: string): Promise<ValidationResult> => {
    if (step.reds.length === 0) return { ok: true };
    crashPoint("dispatchFanoutStep:before-awaiting-red");
    setTaskStatus(parentId, "awaiting_red");
    crashPoint("dispatchFanoutStep:between-awaiting-red-status-and-event");
    logEvent("task.awaiting_red", { runId: args.runId, taskId: parentId });
    crashPoint("dispatchFanoutStep:after-awaiting-red");
    redAggregate = await dispatchReds({
      runId: args.runId,
      workflow: args.workflow,
      step,
      primaryTaskId: parentId,
      primaryResult: parentResult,
      projectDir: dir,
      designDir: args.designDir,
      runMetadata: args.runMetadata,
      dockerExec: args.dockerExec,
      getModelPolicy: args.getModelPolicy,
    });
    return redRejection(redAggregate);
  };

  const landFanoutBlockedByRed = async (): Promise<string> => {
    // FG-482: status + result written together in one CAS'd UPDATE — the task is
    // never observable as awaiting_gate mid-transition. If the CAS lost a race (task
    // no longer awaiting_red), report its actual status rather than logging/notifying
    // a transition that didn't happen.
    let blockedByRedApplied = false;
    crashPoint("dispatchFanoutStep:before-blocked-by-red");
    writeTransaction(() => {
      blockedByRedApplied = markTaskBlockedByRed(parentId, parentResult);
      crashPoint("dispatchFanoutStep:inside-blocked-by-red-txn");
      if (blockedByRedApplied) {
        logEvent("task.blocked_by_red", { runId: args.runId, taskId: parentId });
      }
    });
    crashPoint("dispatchFanoutStep:after-blocked-by-red");
    if (!blockedByRedApplied) {
      return getTask(parentId)?.status ?? "failed";
    }
    const runForNotify = getRun(args.runId);
    if (runForNotify) void notifyOnTaskBlockedByRed(runForNotify);
    // Integration branch + child worktrees retained for inspection on blocked_by_red.
    return "blocked_by_red";
  };

  if (integrationWorktreePath) {
    const published = await publishFanoutIntegration(args, parentId, parentResult, childOutcomes, {
      alsoValidate: (candidateDir) => runFanoutRedsAgainst(candidateDir),
      redRejected: () => redAggregate?.authoritativeFail === true,
    });
    if (published === "red_rejected") return await landFanoutBlockedByRed();
    if (published !== "complete") return published;
  } else if (step.reds.length > 0) {
    // Non-worktree mode: no integration branch, no candidate, no publisher. Reds
    // run against the project directory, exactly as they always did.
    const reds = await runFanoutRedsAgainst(args.projectDir);
    if (!reds.ok) return await landFanoutBlockedByRed();
  }

  return finalizePrimary(parentId, args.runId, step.gate, parentResult);
}

/** FG-425: the fan-out validate-then-publish step.
 *
 *  The children were merged into the FG-353 integration branch. That branch is the
 *  candidate SOURCE: the publisher folds it into a FRESH per-attempt worktree at
 *  the target's CURRENT base, then runs the full validation set (integration gate,
 *  then the step's reds) against that candidate, and only then CAS-publishes the
 *  exact commit it validated. Nothing is ever built, tested, or reviewed inside the
 *  publish target.
 *
 *  `redsAlreadyRan` is the gate-forced re-entry case: a human has already overridden
 *  the reds with a recorded rationale, so validation is the gate alone — re-dispatching
 *  reds there would just re-collect the verdicts the human already overrode.
 *
 *  Returns "complete" when the publication landed; otherwise the task status the
 *  caller must return (worktrees and branches retained for inspection). */
async function publishFanoutIntegration(
  args: { runId: string; projectDir: string },
  parentId: string,
  parentResult: unknown,
  childOutcomes: ChildOutcome[],
  opts: {
    /** The reds, folded into the SAME validation set the publication is gated on.
     *  Omitted on the gate-forced re-entry: a human already overrode the reds with a
     *  recorded rationale, which is what gateForced MEANS. The integration gate still
     *  runs — overriding a red is not overriding a broken build. */
    alsoValidate?: (candidateDir: string, candidateSha: string) => Promise<ValidationResult>;
    /** True once an authoritative red has REJECTED the candidate. Distinguishes the
     *  one refusal that is a human decision (blocked_by_red) from every other one
     *  (a task failure). */
    redRejected?: () => boolean;
    reEntry?: boolean;
  } = {},
): Promise<string> {
  const publication = await publishIntegration({
    runId: args.runId,
    taskId: parentId,
    projectDir: args.projectDir,
    sources: [{ branch: integrationBranchName(args.runId, parentId), label: `${parentId} integration` }],
    ...(opts.alsoValidate ? { alsoValidate: opts.alsoValidate } : {}),
  });
  logEvent("integration.published", {
    runId: args.runId,
    taskId: parentId,
    payload: {
      attemptId: publication.attemptId,
      outcome: publication.kind,
      branch: integrationBranchName(args.runId, parentId),
      ...(opts.reEntry ? { reEntry: true } : {}),
      ...(publication.kind === "published"
        ? {
            target: publication.target,
            baseSha: publication.baseSha,
            candidateSha: publication.candidateSha,
            publishedSha: publication.publishedSha,
            rebuilds: publication.rebuilds,
          }
        : {}),
    },
  });
  if (publication.kind !== "published") {
    // FG-425 (AC5): the ref advance landed and the window was lost — not a refusal,
    // and not something a red rejection can explain (the reds passed, or the
    // publisher would never have reached the window). Recoverable, non-terminal.
    if (publication.kind === "recovery_pending") {
      return awaitPublicationRecovery(parentId, args.runId, publication, parentResult);
    }
    // The caller distinguishes a RED rejection (blocked_by_red — a human decision)
    // from every other refusal (a task failure). Nothing was published either way;
    // the integration branch and child worktrees are retained for inspection.
    if (opts.redRejected?.()) return "red_rejected";
    failTask(parentId, {
      runId: args.runId,
      kind: publicationFailureKind(publication),
      error: publicationFailureError(publication),
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
  finalizePublication(args.projectDir, publication.attemptId);
  return "complete";
}

/** FG-425 (AC5): the ONE landing a lost-window publication may have when its
 *  disposition is not yet settled. NON-TERMINAL by construction: the attempt is still
 *  `publishing`, the target ref carries its candidate, and the only honest thing forge
 *  can say is "this is not settled yet, and you must not retry it". The next
 *  `forge next` converges the attempt (AD-5) and reconciles this task onto the truth.
 *
 *  The CAS mirrors every other non-terminal landing: a concurrent `forge cancel`
 *  already holds the task, and it wins. */
function awaitPublicationRecovery(
  taskId: string,
  runId: string,
  p: Extract<PublishOutcome, { kind: "recovery_pending" }>,
  result: unknown,
): string {
  if (!markTaskAwaitingRecovery(taskId, p.error, result)) {
    return getTask(taskId)?.status ?? "failed";
  }
  logEvent("task.awaiting_recovery", {
    runId,
    taskId,
    payload: {
      attemptId: p.attemptId,
      target: p.target,
      baseSha: p.baseSha,
      candidateSha: p.candidateSha,
    },
  });
  return "awaiting_recovery";
}

/** FG-425 (AC5): move every task parked in `awaiting_recovery` onto the truth AD-5
 *  convergence recorded for its attempt. Runs at the top of every wave, immediately
 *  after recoverUnfinishedPublications — which is what settles the attempt in the
 *  first place — so the pair is: converge the PUBLICATION from the ref, then
 *  reconcile the TASK from the publication.
 *
 *  This is the half the old code was missing. Recovery already converged the attempt
 *  to `published`; nothing ever went back and told the task, so the task stayed
 *  `failed` with retry advice for work that was already on the target. A `published`
 *  attempt whose task says `failed` is the defect, not a cosmetic mismatch.
 *
 *  An attempt still `publishing` (the window was busy, or a live publisher owns it)
 *  is LEFT ALONE and the task stays recoverable — an unsettled publication is not a
 *  failure, and waiting is not a wedge: the next wave sweeps again.
 *
 *  It reconciles a task ALREADY RECORDED `failed` beside a `published` attempt too,
 *  because that contradiction has more than one way in: a DB written by a build that
 *  predates this fix, and — the window this function's own writes open — a crash
 *  between the publisher returning and the awaiting_recovery landing, after which
 *  reconcile lands the stranded `running` row as a terminal failure while the AD-5
 *  sweep converges its attempt to `published`. The rule is about the CONTRADICTION,
 *  not about how it arrived: a `published` attempt's task tells the truth, whatever it
 *  said before. A `failed` task with NO published attempt is a real failure and is
 *  never touched.
 *
 *  `running` is deliberately NOT reconciled here: a task is legitimately `running`
 *  with a `published` attempt for the instant between the CAS and finalizePrimary, and
 *  a second process converging that from underneath the live one would be the race the
 *  lease exists to prevent. Crash-stranded `running` rows are reconcile.ts's, and they
 *  arrive here as `failed` on the pass after it lands them. */
function reconcilePublicationRecoveries(runId: string, workflow: Workflow, projectDir: string): void {
  const recovering = tasksForRun(runId).filter(
    (t) =>
      t.status === "awaiting_recovery" ||
      (t.status === "failed" && publicationAttemptsForTask(t.id).some((a) => a.state === "published")),
  );
  for (const task of recovering) {
    // A `published` attempt is the authoritative one whatever else this task tried:
    // its candidate is in the target's history, and no later disposition un-publishes
    // it (the publisher short-circuits a task that already landed, so there is no
    // later attempt — but the record, not that invariant, is what decides here).
    const attempts = publicationAttemptsForTask(task.id);
    const attempt = attempts.find((a) => a.state === "published") ?? attempts.find((a) => a.state !== "intent");
    if (!attempt || attempt.state === "publishing") continue;

    if (attempt.state === "published") {
      // Clear the terminal claim FIRST, through the state that means exactly "the
      // publication is settled; this task has not caught up yet". finalizePrimary's
      // completion CAS refuses to overwrite a `failed` row on purpose (it guards a
      // completing container against a concurrent cancel) — and that guard must not be
      // relaxed, so the repair steps through awaiting_recovery rather than around it.
      if (task.status === "failed") setTaskStatus(task.id, "awaiting_recovery");
      // The candidate LANDED. The task's work is on the target, so the task finishes
      // exactly as it would have had the window never been lost — through the same
      // gate its step declares (a lost mutex is not a reason to skip a human gate).
      const step = workflow.steps.find((s) => s.id === task.phase);
      const status = finalizePrimary(task.id, runId, step?.gate ?? "auto", task.result);
      logEvent("task.publication_reconciled", {
        runId,
        taskId: task.id,
        payload: {
          attemptId: attempt.attemptId,
          outcome: "published",
          publishedSha: attempt.publishedSha,
          target: attempt.target,
          status,
        },
      });
      if (status === "complete") {
        if (typeof task.worktreePath === "string") {
          removeWorktreeIfSafe(task.worktreePath, runId, task.id, projectDir, true);
        }
        finalizePublication(projectDir, attempt.attemptId);
      }
      continue;
    }

    // Converged to a NON-published disposition: the ref did not carry the candidate,
    // so nothing of this task's work is on the target and a terminal failure is now
    // the truthful record. The kind is the converged one — never a guess made back
    // when the window was lost.
    const kind: FailureKind = attempt.state === "parked" && attempt.parkReason
      ? attempt.parkReason
      : "publication_refused";
    failTask(task.id, {
      runId,
      kind,
      error:
        `publication attempt ${attempt.attemptId} was converged by AD-5 recovery to \`${attempt.state}\`: the target ` +
        `ref does not carry candidate ${(attempt.candidateSha ?? "").slice(0, 12)}, so nothing from this task was ` +
        `published and the target is unchanged.`,
      result: task.result,
    });
    logEvent("task.publication_reconciled", {
      runId,
      taskId: task.id,
      payload: { attemptId: attempt.attemptId, outcome: attempt.state, failureKind: kind },
    });
  }
}

/** FG-425 (AC4/AC5): `forge publish recover` — the HAND half of the two mechanisms
 *  that clear `awaiting_recovery`, and the whole of it.
 *
 *  Recovery is TWO halves, and the operator command used to be only the first:
 *  converge the PUBLICATION from the ref, then reconcile the TASK from the
 *  publication. Run bare, it would mark the attempt `published`, synchronize the
 *  target — and leave the task that owns it sitting in `awaiting_recovery`, with
 *  `forge show` still calling the publication unsettled, until some later `forge next`
 *  happened to run the other half. A hand recovery that only settles the attempt is
 *  the same contradiction between two durable records that AC5 exists to forbid; it
 *  just arrives by a different door.
 *
 *  So the run path and the hand path converge on the SAME reconciliation, and the
 *  only difference between them is who invoked it. Idempotent: re-running it against a
 *  settled attempt whose task already caught up reconciles nothing.
 *
 *  The reconciliation is skipped when the run is no longer active — a cancelled or
 *  completed run's tasks are terminal, and recovery settles the publication record
 *  without resurrecting them.
 *
 *  It is also skipped, REPORTED rather than thrown, when the run's workflow no longer
 *  resolves: the task's landing needs the step's gate, and that lives in the workflow
 *  definition. The publication is already converged and the target already synchronized
 *  by the time we get here, so a missing workflow may not turn a successful recovery
 *  into a crash — it may only leave the task uncaught-up, which is the pre-fix
 *  behaviour and which the operator is then told about by name. */
export type HandRecovery = {
  outcome: OperatorRecovery;
  /** The owning task's status AFTER reconciliation — what the operator is told, and
   *  the thing that used to be a lie. Absent when nothing was reconciled. */
  task?: { taskId: string; runId: string; status: string };
  /** Set when the publication converged but its task could NOT be reconciled here.
   *  Says why, and what the operator must do instead. */
  unreconciled?: string;
};

export function recoverPublicationByHand(attemptId: string): HandRecovery {
  const outcome = recoverPublicationAttemptForOperator(attemptId);
  if (outcome.kind === "unknown_attempt" || outcome.kind === "blocked") return { outcome };

  const attempt = getPublicationAttempt(attemptId);
  if (!attempt) return { outcome };
  const run = getRun(attempt.runId);
  if (!run || run.status !== "active" || !run.projectDir) return { outcome };

  let workflow: Workflow;
  try {
    workflow = loadWorkflow(run.workflow, { projectDir: run.projectDir });
  } catch (e) {
    return {
      outcome,
      unreconciled:
        `the publication is converged, but task ${attempt.taskId} could NOT be reconciled onto it here: run ` +
        `${attempt.runId}'s workflow (${run.workflow}) does not load — ${(e as Error).message}. Restore the workflow ` +
        `definition and run \`forge next ${attempt.runId}\`, which runs the same reconciliation.`,
    };
  }

  reconcilePublicationRecoveries(attempt.runId, workflow, run.projectDir);
  if (isRunSettled(workflow, tasksForRun(attempt.runId))) {
    finalizeRunIfSettled(attempt.runId, "publish-recover-reconciled");
  }

  const task = getTask(attempt.taskId);
  if (!task) return { outcome };
  return { outcome, task: { taskId: task.id, runId: attempt.runId, status: task.status } };
}

/** Map a non-published publication outcome onto forge's failure-kind vocabulary.
 *  A gate failure against the CANDIDATE keeps the same infra-vs-test-failure
 *  classification the post-merge gate had — only the tree it ran against moved. */
function publicationFailureKind(p: PublishOutcome): FailureKind {
  if (p.kind === "recovery_pending") {
    // FG-425 (AC5): NOT a failure kind, because this is not a failure — it is an
    // unsettled publication whose ref advance already landed. Every caller routes it
    // to awaitPublicationRecovery BEFORE reaching here; a call that got this far
    // would be about to write a terminal task row over a `publishing` attempt, which
    // is the exact contradiction AC5 forbids.
    throw new Error(
      `publication ${p.attemptId} is awaiting AD-5 recovery (the ref carries candidate ` +
        `${p.candidateSha.slice(0, 12)}) — it has NO failure kind, and no terminal disposition may be written for ` +
        `it. This is a caller bug: route recovery_pending to awaitPublicationRecovery.`,
    );
  }
  if (p.kind === "validation_failed") {
    return classify({
      integrationGate: {
        status: p.status ?? null,
        signal: p.signal ?? null,
        timedOut: p.timedOut ?? false,
      },
    });
  }
  if (p.kind === "merge_failed") return "merge_conflict";
  if (p.kind === "parked") return p.reason;
  if (p.kind === "refused") return "publication_refused";
  return classify({});
}

function publicationFailureError(p: PublishOutcome): string {
  if (p.kind === "validation_failed") {
    return `integration gate failed against candidate ${p.candidateSha}: ${p.error}`;
  }
  if (p.kind === "parked") return `publication parked (${p.reason}): ${p.error}`;
  if (p.kind === "published") return "";
  return p.error;
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
  getModelPolicy: (projectDir: string) => ModelPolicyWithSource;
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
    // FG-512: runner-minted fanout child row — total dispatch provenance.
    dispatchSource: "workflow",
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
    getModelPolicy: args.getModelPolicy,
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
  const childCompleted = markTaskComplete(childTaskId, dispatchResult.result);
  if (childCompleted) {
    logEvent("task.completed", { runId: args.runId, taskId: childTaskId });
    // FG-353: cleanup responsibility moves to dispatchFanoutStep after proven HEAD merge.
    // The old per-child removeWorktreeIfSafe call is removed here.
  }
  // FG-492 review: reap only if the CAS above actually completed the child —
  // a lost race to a concurrent cancel retains its container.
  // FG-503 (review): route through reapContainerAndReportFailure like the
  // other success-path reaps in this file — a reap failure here is the same
  // silent, unsweepable leak.
  reapContainerAndReportFailure(dispatchResult.containerName, childCompleted, args.runId, childTaskId);
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
// FG-492 review: `containerName` rides on the "ok" outcome so the caller
// (dispatchSingleStep / runOneRed / runFanoutChild) can decide reap-vs-retain
// once IT knows the task's real final outcome — a valid result here doesn't
// mean the task ultimately succeeds (merge conflict, integration gate, reds,
// or a human gate can still fail/pause it downstream). Every failure branch
// inside runContainer already knows its own outcome is terminal-failed, so it
// retains (or reaps under FORGE_CONTAINER_RETENTION=off) right there.
type ContainerOutcome =
  | { kind: "ok"; result: unknown; containerName: string }
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
  // FG-365: resolves (and memoizes, per projectDir, for the dispatch wave)
  // model-policy provenance for the controlPlane receipt below — replaces a
  // direct loadModelPolicyWithSource call so a fan-out of N children + M reds
  // reads model-policy.yml once per projectDir instead of once per container.
  getModelPolicy: (projectDir: string) => ModelPolicyWithSource;
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
  // FG-533: the pre-container window. Everything from here to the container.started
  // append below (image pull, auth staging, dependency provisioning — minutes) runs
  // with the task already `running` and no container.started event, which is the
  // signal BOTH sweeps gate on. Reconcile's pre-container sweep recovers a crash
  // here: it lands as `pre_container_crash`, retryable without --force (no work yet).
  crashPoint("runContainer:after-mark-running-before-container-launch");

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
    let modelPolicyLoaded: ModelPolicyWithSource;
    try {
      modelPolicyLoaded = args.getModelPolicy(args.projectDir);
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
    // FG-366: name is the resolved concrete runtime (matches controlPlane.runtime.name),
    // not the requested sentinel — see task-manifest.ts's ManifestRuntime doc comment.
    runtime: { name: runtimeName, kind: runtimeMeta.runtimeKind, logFormat: runtimeMeta.logFormat, promptStrategy: runtimeMeta.promptStrategy, authStrategy: runtimeMeta.authStrategy },
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

  const exec = args.dockerExec ?? productionDockerExec;

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
          // FG-492 finding 2: the provisioner keeps its own --rm lifecycle
          // (FG-437) — skip docker-exec.ts's capture-at-close/reap policy so a
          // clean provisioner run doesn't `docker inspect`/`docker rm -f` a
          // container the daemon has likely already auto-removed.
          isProvisionerExec: true,
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
  // FG-536: the durable start record and the FG-530 kill point both fire from the
  // executor's start callback — for the detached executor, the instant after
  // `docker run -d` returns success. Before that instant there is no container, so
  // a death there is a PRE-container crash (FG-533's window, its own probe above)
  // and container.started would be a lie. From this callback until exec returns the
  // host is only a WATCHER; a crash in that span leaves the container running to
  // completion and the task `running` with container.started on the record — the
  // shape the container-gone sweep and its invoke-like/needs-finalize landings
  // recover from the REAL result once the container exits.
  let containerStartRecorded = false;
  const recordContainerStarted = (containerId?: string): void => {
    if (containerStartRecorded) return;
    containerStartRecorded = true;
    logEvent("container.started", { runId: args.runId, taskId: args.taskId, payload: { containerName, ...(containerId !== undefined ? { containerId } : {}) } });
    crashPoint("runContainer:after-container-started-before-exec");
  };
  // Legacy/fake executors give no start signal; they get the record up-front, which
  // is where it always sat for them.
  if (!exec.signalsContainerStart) recordContainerStarted();
  let exitCode: number;
  // FG-492: populated by docker-exec.ts's capture-at-close. Attached onto
  // every terminal container event below (mirrors invoke.ts). FG-492 review:
  // reap-vs-retain is decided separately, below, once result.json's outcome
  // is known — see finalizeContainerRetention.
  let containerEvidence: ContainerCausalEvidence | undefined;
  try {
    exitCode = await exec({
      args: dockerArgs.args,
      stdin: dockerArgs.stdin,
      imageIndex: dockerArgs.imageIndex,
      stdoutPath,
      stderrPath,
      idleTimeoutMs,
      onContainerEvidence: (e) => { containerEvidence = e; },
      onContainerStarted: recordContainerStarted,
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
    logEvent("container.idle_timeout", { runId: args.runId, taskId: args.taskId, payload: { containerName, exitCode, ...(containerEvidence ? { containerEvidence } : {}) } });
    const msg = `idle_timeout (no agent output for ${Math.round(idleTimeoutMs / 60000)}m)`;
    const kind = classify({ exitCode });
    failTask(args.taskId, { runId: args.runId, kind, error: msg, evidence: recoveryEvidenceFor(kind) });
    // FG-492 review: task failed — retain (see finalizeContainerRetention in docker-exec.ts).
    finalizeContainerRetention(containerName, false);
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
    logEvent("container.dependency_provisioning_failed", { runId: args.runId, taskId: args.taskId, payload: { containerName, exitCode, ...(containerEvidence ? { containerEvidence } : {}) } });
    const msg = `verification_environment_unavailable: dependency install failed${stderrTail ? ` — ${stderrTail}` : ""}`;
    failTask(args.taskId, { runId: args.runId, kind: classify({ source: "verification_environment_unavailable" }), error: msg });
    // FG-492 review: task failed — retain (see finalizeContainerRetention in docker-exec.ts).
    finalizeContainerRetention(containerName, false);
    return { kind: "failed", error: msg };
  }

  logEvent("container.exited", { runId: args.runId, taskId: args.taskId, payload: { containerName, exitCode, ...(containerEvidence ? { containerEvidence } : {}) } });

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
    // FG-492 review: task failed — retain (see finalizeContainerRetention in docker-exec.ts).
    finalizeContainerRetention(containerName, false);
    return { kind: "failed", error: msg };
  }
  let result: unknown;
  try {
    if (resultRaw.length > 0) result = JSON.parse(resultRaw);
  } catch {
    const msg = "result.json malformed";
    failTask(args.taskId, { runId: args.runId, kind: classify({ resultState: "malformed" }), error: msg });
    // FG-492 review: task failed — retain (see finalizeContainerRetention in docker-exec.ts).
    finalizeContainerRetention(containerName, false);
    return { kind: "failed", error: msg };
  }
  if (!result) {
    // #264: pi exits 0 even on a provider error — attribute a missing result from
    // pi's structured stdout instead of the ambiguous bare "no_result_json".
    // #267: a provider/model error is classified `model_error` (with the cause),
    // not generic result_missing.
    let msg = "no_result_json";
    let kind = classify({ resultState: "missing" });
    const stdoutRaw = existsSync(stdoutPath) ? readFileSync(stdoutPath, "utf8") : "";
    const a = analyzeProviderFailure({
      logFormat: runtimeMeta.logFormat,
      runtimeKind: runtimeMeta.runtimeKind,
      stdoutRaw,
    });
    if (a.error) msg = a.error;
    if (a.modelError) kind = classify({ source: "model_error" });
    // FG-540: provider-adapter recovery — same shared extraction rule as
    // invoke.ts/reconcile.ts. A recovered object is returned exactly like a
    // file-written result: the caller still runs persistence, merge,
    // integration gate, reds, and gate before any outcome is decided.
    // A non-empty result.json never reaches here, so it is never overwritten.
    const recovered = exitCode === 0 && resultRaw.length === 0 && !a.modelError
      ? recoverStructuredStreamResult({ logFormat: runtimeMeta.logFormat, runtimeKind: runtimeMeta.runtimeKind, stdoutRaw })
      : undefined;
    if (recovered) {
      // FG-540 review: persist-or-fail-closed. An unwritable result.json must
      // fail the task through the normal result-missing path (retention
      // included), not throw out of the workflow dispatcher.
      try {
        writeFileSync(join(dir, "result.json"), JSON.stringify(recovered));
      } catch (e) {
        const err = `${msg} (stream-recovered result could not be persisted: ${e instanceof Error ? e.message : String(e)})`;
        failTask(args.taskId, { runId: args.runId, kind, error: err, evidence: recoveryEvidenceFor(kind) });
        finalizeContainerRetention(containerName, false);
        return { kind: "failed", error: err };
      }
      logEvent("task.result_recovered_from_stream", {
        runId: args.runId, taskId: args.taskId,
        payload: { source: "workflow", logFormat: runtimeMeta.logFormat ?? runtimeMeta.runtimeKind ?? null },
      });
      return { kind: "ok", result: recovered, containerName };
    }
    // FG-337: clean completion + captured assistant text + narrative role →
    // synthesize an inferred result instead of hard-failing.
    const inferred = inferredResultFrom(a, args.role);
    if (inferred) {
      writeFileSync(join(dir, "result.json"), JSON.stringify(inferred));
      return { kind: "ok", result: inferred, containerName };
    }
    // FG-492 finding 2: result_missing now joins ORPHAN_EVIDENCE_KINDS, so
    // recoveryEvidenceFor gathers the same worktree-diff evidence as
    // container_crash/idle_timeout for it; model_error is not in that set, so
    // recoveryEvidenceFor returns undefined for it, matching line 2339 above.
    failTask(args.taskId, { runId: args.runId, kind, error: msg, evidence: recoveryEvidenceFor(kind) });
    // FG-492 review: this is exactly the state-4 case the retention fix
    // targets — a clean exit that produced no result.json is retained, not
    // reaped.
    finalizeContainerRetention(containerName, false);
    return { kind: "failed", error: msg };
  }

  // FG-492 review: a valid result here does NOT mean reap now — the caller
  // still has to run the persistence check, worktree merge, integration gate,
  // reds, and gate before the task's real outcome is known. containerName
  // rides on the outcome so the caller can decide once it does.
  return { kind: "ok", result, containerName };
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
    // FG-512: runner-minted manual-step row — total dispatch provenance.
    dispatchSource: "workflow",
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
    // FG-512: runner-minted rows (shipping-reviewer pre-fail red, fanout-parent
    // failure row) — total dispatch provenance.
    dispatchSource: "workflow",
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
