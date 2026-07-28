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
  createDependencyMountpoints,
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
import { insertTask, getTask, markTaskRunning, markTaskComplete, markTaskAwaitingGate, markTaskAwaitingRecovery, markTaskHeldForGate, markTaskBlockedByRed, markTaskFailed, setTaskStatus, setTaskWorkspace, clearTaskWorkspace } from "../store/tasks.js";
import { failTask, classify, failureKindFromEvents, ORPHAN_EVIDENCE_KINDS } from "./failure-kind.js";
import type { FailureKind, OrphanEvidence, ContainerCausalEvidence } from "./failure-kind.js";
import { captureUsageForTask } from "../store/model-calls.js";
import { insertVerdict, verdictsForTask } from "../store/verdicts.js";
import { getDb, writeTransaction } from "../store/db.js";
import { crashPoint } from "./crash-points.js";
import { assembleReviewerContextPacket } from "./reviewer-context-packet.js";
import { validateVerdict } from "./validate-findings.js";
import { gradeFindings } from "./review-quality.js";
import { logEvent, eventsForTask } from "../store/events.js";
import { taskDir, integrationWorktreeDir, cloneDir } from "../util/paths.js";
import { computeReadyQueue, isRunSettled, resolvePhasePrimary, classifyRunTerminalState, type RunTerminalClassification } from "./ready-queue.js";
import { classifyTaskLineage, isWorkflowPrimaryRow } from "./lifecycle-evaluator.js";
import { finalizeOrphanedPrimaries, attachedExitEvidence } from "./reconcile.js";
import { checkResultPersistence, persistenceErrorMessage } from "./persistence-check.js";
import { verdictBlocksGate } from "./gate.js";
import { evaluateValidationContract } from "./validation-contract.js";
import { deriveUpstream } from "./inputs.js";
import { composeSystemPrompt } from "./compose.js";
import { filterConstraints, loadAllConstraints } from "./constraints.js";
import { buildDockerArgs, buildProvisionerDockerArgs, resolveProjectContainerPath, preflightProjectMount, GIT_UNAVAILABLE_EXIT_CODE, type SpawnContext } from "./spawn.js";
import { assertSelfHostDispatchAllowed } from "./self-host-guard.js";
import { resolveAuthStateForContainer, AuthProfileError, roleUsesBrowser, cleanupStagedAuth } from "./auth-state.js";
import { loadProjectAuthProfile, resolveProjectAuthForContainer, ProjectAuthError } from "./project-auth.js";
import { writeTaskManifest, manifestControlPlaneBlock } from "./task-manifest.js";
import { resolveDocsSurfacesReceipt } from "./contract.js";
import { emitAgentProgressEvents } from "./agent-progress.js";
import { loadRuntimeWithSource, loadModelPolicyWithSource, loadWorkflow, loadWorkflowWithSource, type ModelPolicyWithSource } from "./loader.js";
import { type SeedGeneration } from "./seed-generation.js";
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
// FG-621: mutating tasks are provisioned a PRIVATE `--shared` clone instead of a
// linked worktree, and their work is captured by fetching the clone's branch into
// this repository's ref namespace.
import {
  isWorktreeModeEnabled,
  preflightWorktreeGate,
  createTaskClone,
  captureTaskClone,
  TaskCloneExistsError,
  TaskCloneAnchorExistsError,
  worktreeBranchName,
  removeWorktreeIfSafe,
  cleanupFailedCloneSetup,
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
import { getPublicationAttempt, latestPublishedShaForRun, publicationAttemptsForTask, type PublicationAttempt } from "../store/publications.js";
import { localTargetFor, targetDescriptor } from "./publication-target.js";
import { projectIdentity } from "./project-identity.js";

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
  // FG-585: present iff this wave settled the run to a terminal state. Lets the
  // CLI name the failed + unreachable phases without re-deriving the verdict.
  terminal?: RunTerminalClassification;
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
  // FG-583: the wave's held seed generation, threaded into every model-policy load
  // so the whole wave resolves against ONE anchored generation.
  seedGeneration?: SeedGeneration | null,
): (projectDir: string) => ModelPolicyWithSource {
  const cache = new Map<string, ModelPolicyWithSource>();
  return (projectDir: string) => {
    const cached = cache.get(projectDir);
    if (cached) return cached;
    const resolved = loader({ projectDir, seedGeneration });
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
  // FG-583: the seed generation anchored ONCE at dispatch entry (next.ts) and
  // threaded through the wave so every dispatch-coupled load (workflow, runtime)
  // reads the SAME complete generation even if a promotion swaps the pointer
  // mid-wave. `undefined` (tests / older callers) → each load resolves the live
  // pointer, which under atomic publication still observes one complete generation.
  seedGeneration?: SeedGeneration | null;
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
    const classification = classifyRunTerminalState(args.workflow, tasks);
    if (classification) {
      // AWN-2 cancel-vs-completion race: a concurrent `forge cancel` may have
      // abandoned the run between the getRun at the top of runNext and this
      // write. finalizeRunIfSettled re-reads the run before flipping it — an
      // abandoned run is authoritatively terminal and must never be resurrected.
      // FG-585: classify to complete-vs-failed; a step that failed terminally
      // with no downstream reachable settles the run to `failed`, not complete.
      const finalized = finalizeRunIfSettled(
        args.runId,
        classification.status,
        "runNext-settled-no-dispatch",
        {
          failedPhases: classification.failedPhases.join(",") || undefined,
          unreachablePhases: classification.unreachablePhases.join(",") || undefined,
        },
      );
      const currentStatus = finalized ? classification.status : (getRun(args.runId)?.status ?? run.status);
      return {
        dispatchedSteps: [],
        completedSteps: [],
        awaitingGate: [],
        failedSteps: [],
        awaitingRecovery: [],
        runStatus: currentStatus,
        ...(finalized ? { terminal: classification } : {}),
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
  const getModelPolicy = createModelPolicyResolver(args.modelPolicyLoader, args.seedGeneration);
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
      seedGeneration: args.seedGeneration,
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
  // FG-585: the shared classifier is the SINGLE authority on the terminal state.
  // It returns null when not settled, "complete" when every step reached a
  // complete primary, and "failed" when a step is permanently blocked (its own
  // primaries failed, or a dependency is blocked so a declared downstream phase
  // can never dispatch). A superseded failed task (request-changes audit record)
  // resolves to "complete" inside the classifier, not here.
  const classification =
    readyAfter.length === 0 ? classifyRunTerminalState(args.workflow, tasksAfter) : null;
  if (classification) {
    // finalizeRunIfSettled re-reads the run before writing: a concurrent
    // `forge cancel` may have abandoned it while this wave ran, and an
    // abandoned run must never be resurrected (AWN-2).
    const applied = finalizeRunIfSettled(
      args.runId,
      classification.status,
      "runNext-wave-complete",
      {
        failedPhases: classification.failedPhases.join(",") || undefined,
        unreachablePhases: classification.unreachablePhases.join(",") || undefined,
      },
    );
    if (applied) runStatus = classification.status;
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
    ...(classification && runStatus === classification.status ? { terminal: classification } : {}),
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
  seedGeneration?: SeedGeneration | null;
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
      seedGeneration: args.seedGeneration,
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
    seedGeneration: args.seedGeneration,
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

// ── FG-621: private-clone provisioning for mutating tasks ─────────────────────
//
// Both workspace-creating sites in this file dispatch a MUTATING task, so there
// is no capability predicate to introduce here: a red creates no workspace at all
// (it is dispatched read-only against the publisher's candidate). The substrate
// swap is therefore unconditional on these two paths.
//
// The clone path travels through runContainer's EXISTING `worktreePath` argument,
// whose meaning becomes "this task's isolated workspace, whatever the substrate".
// That single decision is what makes isWorktreeRwDispatch and the
// IS_WORKTREE_DISPATCH dependency-cache flag cover clones with no spawn.ts change.

/** The two create-only refusals, which name state a PREVIOUS attempt owns: an
 *  existing clone directory, and an existing parent-side anchor ref. Neither may
 *  be followed by cleanup — a directory an agent wrote to and a ref holding a
 *  prior attempt's captured tip are both evidence, and the refusal exists to
 *  protect them. */
function isCreateOnlyRefusal(e: unknown): boolean {
  return e instanceof TaskCloneExistsError || e instanceof TaskCloneAnchorExistsError;
}

/** The failed-setup lane's last act: dispose of this attempt's partial state, then
 *  make the ROW agree with the disk.
 *
 *  provisionTaskClone records the workspace path before the clone exists — that
 *  order is what makes a workspace no row names impossible. Its cost is the
 *  mirror image: a row naming a workspace whose creation then failed. The reaper
 *  tolerates it (classifyWorkspace reads the path as `absent` and records
 *  nothing), but `forge show`, the dashboard and every other reader treat a
 *  non-null worktree_path as "a workspace exists here", so leaving it is a
 *  phantom for everyone except the one consumer that was written around it.
 *
 *  THE DISK DECIDES, not the failure class. Cleanup is skipped for the two
 *  create-only refusals, which name state a PREVIOUS attempt owns — but the
 *  anchor refusal happens before any directory is created, so its row is a
 *  phantom too, and clearing a row never touches a ref. A directory that
 *  survived (an existing clone, or a removal that failed) KEEPS its row: the
 *  recorded path is the only thing that will ever find it again. */
function settleFailedCloneProvisioning(projectDir: string, runId: string, taskId: string, e: unknown): void {
  if (!isCreateOnlyRefusal(e)) cleanupFailedCloneSetup(projectDir, runId, taskId);
  if (!existsSync(cloneDir(runId, taskId))) clearTaskWorkspace(taskId);
}

/** The target descriptor this dispatch's work will be published to — the same
 *  value publishIntegration records on the attempt, derived the same way, so a
 *  receipt lookup scoped by it selects receipts for THIS target only.
 *
 *  undefined when the target cannot be resolved at all (a detached HEAD, where
 *  publication is impossible anyway). The lookup then falls back to unscoped,
 *  which is the pre-existing behavior for a case that has no receipts to confuse. */
function publishTargetDescriptor(projectDir: string): string | undefined {
  try {
    return targetDescriptor(localTargetFor(projectIdentity(projectDir).canonicalDir));
  } catch {
    return undefined;
  }
}

/** AC 4: the base a task's private clone is created at.
 *
 *  The authority is the RECORDED publication receipt of the run's last accepted
 *  candidate — not a re-read of HEAD. A sequential task therefore starts from the
 *  exact accepted predecessor candidate even when the publish target is a remote
 *  that never advances local HEAD, and the value is a fact Forge wrote rather than
 *  one inferred from where the checkout happened to be at dispatch time.
 *
 *  SCOPED BY TARGET, and ordered by PUBLISH time. A run may publish to more than
 *  one target, and a receipt for another target is not this target's last
 *  accepted candidate. Ordering by intent time is wrong for the same class of
 *  reason: an attempt that parked and rebuilt is RECORDED earlier than one that
 *  published before it but LANDS later, so intent order can hand the next task a
 *  base that is not the last thing actually published (AC 4).
 *
 *  With no receipt yet (the run's first mutating task), projectDir HEAD is the
 *  base — and the SHA it RESOLVES to is what gets recorded. */
function resolveTaskBaseSha(projectDir: string, runId: string): string {
  const published = latestPublishedShaForRun(runId, publishTargetDescriptor(projectDir));
  if (published) return published;
  return execFileSync("git", ["rev-parse", "HEAD^{commit}"], {
    cwd: projectDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/** Record {workspace path, base SHA} DURABLY BEFORE any on-disk or ref state
 *  exists, then create the clone, then ASSERT on what was recorded. Throws on any
 *  failure; the caller's existing worktree-setup failure lane handles it.
 *
 *  THE ORDER IS THE POINT. Clone provisioning creates a workspace directory and a
 *  parent-side anchor ref, and NOTHING sweeps the clones root by scanning it —
 *  the reaper is keyed on the recorded path, deliberately (FG-356). So a crash
 *  between creating that state and recording it leaks both, invisibly and
 *  permanently: no row names the directory, so no pass ever looks at it again.
 *  Writing the row first makes the window leak-free in the only direction that
 *  matters — a row naming a workspace that was never created is self-correcting
 *  (the reaper reads it as `absent` and records nothing), while a workspace no row
 *  names is forever. The path is deterministic (cloneDir), which is what lets it
 *  be recorded before the thing it names exists. */
function provisionTaskClone(
  projectDir: string,
  runId: string,
  taskId: string,
  baseSha: string
): { clonePath: string; baseSha: string; untrackedFiles: string[] } {
  setTaskWorkspace(taskId, cloneDir(runId, taskId), baseSha);

  const clone = createTaskClone(projectDir, runId, taskId, baseSha);
  setTaskWorkspace(taskId, clone.clonePath, clone.baseSha);

  const recorded = getTask(taskId);
  if (recorded?.worktreePath !== clone.clonePath || recorded?.baseSha !== clone.baseSha) {
    throw new Error(
      `task ${taskId}: workspace state did not persist — recorded ` +
        `{path: ${recorded?.worktreePath ?? "none"}, base: ${recorded?.baseSha ?? "none"}} but created ` +
        `{path: ${clone.clonePath}, base: ${clone.baseSha}}`
    );
  }
  return { clonePath: clone.clonePath, baseSha: clone.baseSha, untrackedFiles: clone.untrackedFiles };
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
  seedGeneration?: SeedGeneration | null;
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
    seedGeneration: args.seedGeneration,
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
  const cpWorkflowProv = resolveWorkflowSource(args.workflow.name, args.projectDir, workflowReceipt, args.seedGeneration);

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

  // FG-612: a run created before the guard existed (or under a different env)
  // must still not dispatch into the live forge source unisolated. This path
  // provisions the private clone below when worktree mode is on, so it passes
  // that same answer through.
  try {
    assertSelfHostDispatchAllowed(args.projectDir, isWorktreeModeEnabled() ? "isolated" : "not-armed");
  } catch (e) {
    failTask(taskId, { runId: args.runId, kind: classify({}), error: (e as Error).message });
    return "failed";
  }

  // FG-351/FG-621: provision this mutating task's PRIVATE CLONE when workspace
  // isolation is enabled. preflightWorktreeGate (unchanged, Linux hard-fail
  // included) and the clone creation both run BEFORE runContainer, and the DB
  // write is durable BEFORE the container starts so reconcile can find the path
  // and the base after a process restart. checkResultPersistence keeps
  // args.projectDir (the original host mount) — that seam is owned by FG-354.
  let primaryWorktreePath: string | undefined;
  if (isWorktreeModeEnabled()) {
    try {
      preflightWorktreeGate(args.projectDir);
      const baseSha = resolveTaskBaseSha(args.projectDir, args.runId);
      const clone = provisionTaskClone(args.projectDir, args.runId, taskId, baseSha);
      primaryWorktreePath = clone.clonePath;
      // Operator diagnostic: untracked/ignored host files are NOT in the clone.
      // A clone carries committed content only, exactly as a worktree does.
      if (clone.untrackedFiles.length > 0) {
        process.stderr.write(
          `[forge/worktree] task ${taskId}: ${clone.untrackedFiles.length} untracked host file(s) not in workspace: ${clone.untrackedFiles.slice(0, 5).join(", ")}${clone.untrackedFiles.length > 5 ? ` (+${clone.untrackedFiles.length - 5} more)` : ""}\n`
        );
      }
    } catch (e) {
      // Gate or create failure: the task must not stay stuck in pending —
      // transition to failed so the run can report the error. The cleanup is NOT
      // EPHEMERAL-gated: the agent never ran, so there is no output to preserve
      // and removing partial state is always safe.
      const msg = `worktree setup failed: ${(e as Error).message}`;
      // A create-only REFUSAL must not be followed by cleanup: the directory it
      // names is one an agent may already have written to, and the ref it names
      // may hold a prior attempt's captured work. Cleanup disposes only of state
      // THIS attempt created, so both refusals are surfaced, never swept — and
      // the recorded workspace path is then left naming only what is really there.
      settleFailedCloneProvisioning(args.projectDir, args.runId, taskId, e);
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
    seedGeneration: args.seedGeneration,
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
      seedGeneration: args.seedGeneration,
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
    // FG-621 (AC 3 / AC 5): capture BEFORE the publisher runs, in the fixed order
    // captureTaskClone documents — safety-commit tracked AND untracked state in
    // the clone, resolve its branch tip, fetch that branch into THIS repository's
    // ref namespace under the deterministic name, and verify the two agree. The
    // agent's own commits arrive with it.
    const capture = captureTaskClone(args.projectDir, primaryWorktreePath, args.runId, taskId);
    if (!capture.ok) {
      // No-discard: the clone is retained exactly where it is, and the reaper
      // will record it rather than dispose of unproven work. The kind is
      // `capture_failed`, not `merge_conflict`: nothing has been merged at this
      // point and the publish target is not involved — the clone's work never
      // reached the parent's ref namespace at all.
      failTask(taskId, {
        runId: args.runId,
        kind: "capture_failed",
        error: `${capture.error} [${capture.cause}]`,
        result,
      });
      finalizeContainerRetention(containerName, false);
      return "failed";
    }
    const publication = await publishIntegration({
      runId: args.runId,
      taskId,
      projectDir: args.projectDir,
      // `worktreePath` is deliberately OMITTED for a clone source. The publisher's
      // autoCommitSource can only mutate a source it was told the path of, so
      // omitting it makes "no clone-side commit after the fetch" STRUCTURAL rather
      // than a convention — a post-fetch commit would advance only the clone's own
      // ref and be silently absent from the candidate (they are different
      // repositories). The branch below is the captured, verified parent ref.
      sources: [
        { branch: capture.branch, label: `task ${taskId}` },
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
    seedGeneration?: SeedGeneration | null;
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
    // FG-621: same omission as the first-pass publish above — the source was
    // already captured (safety-committed and fetched) when the task first ran, so
    // the publisher must not commit into the clone now and make that ref stale.
    sources: [
      { branch: worktreeBranchName(args.runId, task.id), label: `task ${task.id}` },
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
  seedGeneration?: SeedGeneration | null;
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
      seedGeneration: args.seedGeneration,
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
    const authoritativeGate = r.red.authority === "authoritative" && r.red.gate_on_verdict;
    // FG-628: every dispatched panel slot must produce a valid review verdict. This
    // `inconclusive` was SYNTHESIZED by runOneRed because none came back, so the
    // panel is incomplete and the phase cannot advance on its own. Before FG-628 it
    // ingested as a bare non-blocking `inconclusive (0.00)` — the ingestion an
    // orchestrator reads as "reviewed, undecided" — so an entire adversarial panel
    // could die at dispatch and the phase would still reach awaiting_gate with zero
    // review having run. Silence read as success.
    //
    // Keyed on PROVENANCE (was this authored by a reviewer?), never on the death
    // mode and never on a container lifecycle signal. Both of those have already
    // failed once each: `container_crash` does not enumerate idle_timeout /
    // oom_killed / model_error / result_missing, and `containerStarted` is a lie in
    // attached mode, where the start callback fires before docker creates the
    // container. A genuine reviewer-authored `inconclusive` — including AWN-5's
    // downgrade of an unsubstantiated `fail` below — is untouched: the reviewer
    // looked and could not decide, and that is an opinion.
    //
    // Deliberately its OWN channel, evaluated BEFORE (and independently of) the
    // authority chain below: FG-586's resultUnreadable channel blocks only for
    // `authority === "authoritative" && gate_on_verdict`, and every red observed
    // dying this way was SPECIALIST. Authority weights an opinion; there is no
    // opinion here to weight. A missing panel member makes the panel incomplete
    // regardless of rank.
    //
    // It runs FIRST so that when this ALSO trips the FG-420 authoritative
    // shipping-reviewer trigger, that one's finding still lands at the head of the
    // list where it has always been and this one sits behind it — both facts kept,
    // neither reordered out from under an existing reader.
    //
    // The verdict value stays `inconclusive` — claiming `fail` would misreport the
    // red as having judged the artifact and found it wanting. What changes is that
    // it BLOCKS (the primary lands blocked_by_red instead of awaiting_gate) and
    // carries a HIGH finding naming the absence, which `forge show` prints under the
    // verdict line. An operator who decides the panel can be waived overrides it
    // the same way as any other red block: forge gate --force --rationale.
    let reviewMissingBlock = false;
    if (r.reviewMissing) {
      reviewMissingBlock = true;
      // FG-586's block is now a strict subset of this rule, but it keeps its own
      // more specific text for the case it named. Prepending the generic finding
      // too would state the same fact twice in the same verdict.
      if (!(authoritativeGate && r.resultUnreadable)) {
        finalVerdict = {
          ...finalVerdict,
          findings: [
            {
              severity: "high",
              summary: `${r.red.agent} produced NO review — this inconclusive was synthesized by forge, so this artifact was NOT adversarially reviewed`,
              evidence: `the ${r.red.agent} red failed without returning a readable verdict (${r.failureKind ?? "dispatch failure"}${r.containerStarted !== undefined ? `, container_started=${r.containerStarted}` : ""}); the recorded inconclusive is the absence of a review, not a reviewer that could not decide — see forge show ${r.redTaskId} for the container's stderr`,
              hypothesis: "fix the dispatch/infrastructure failure and re-run the reds; operator must run forge gate --force --rationale to advance a phase whose adversarial review never executed",
            },
            ...finalVerdict.findings,
          ],
        };
      }
    }
    // FG-420 / FG-586: an authoritative gate_on_verdict red that could not deliver
    // a real, shippable verdict must BLOCK — never silently advance as inconclusive.
    // Two triggers, one mechanism (synthetic HIGH finding prepended BEFORE
    // insertVerdict so it persists, then authoritativeFail below):
    //   • FG-420: shipping-reviewer inconclusive (needs_human / unrecognized / no result).
    //   • FG-586: ANY authoritative red whose result payload was UNREADABLE after the
    //     Part A bounded envelope strip (malformed / truncated / internal bad byte) —
    //     the real verdict is unknown, so it fails closed instead of advancing.
    //     FG-628 widened the BLOCK to every authority; this branch survives for its
    //     finding text, which names the unreadable payload specifically.
    let authoritativeGateBlock = false;
    if (authoritativeGate && r.resultUnreadable) {
      authoritativeGateBlock = true;
      finalVerdict = {
        ...finalVerdict,
        findings: [
          {
            severity: "high",
            summary: "authoritative reviewer output was UNREADABLE — this gate is blocked pending inspection",
            evidence: `the ${r.red.agent} result payload could not be parsed even after the bounded envelope strip (malformed, truncated, or an internal bad byte); its real verdict is unknown`,
            hypothesis: "inspect the raw result.json for this red (kept on disk as-is) or rerun the reviewer; operator must run forge gate --force --rationale to explicitly override this block",
          },
          ...finalVerdict.findings,
        ],
      };
    } else if (
      r.red.agent === "shipping-reviewer" &&
      authoritativeGate &&
      finalVerdict.verdict === "inconclusive"
    ) {
      authoritativeGateBlock = true;
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
      // FG-628: written INSIDE the same transaction as the verdict it describes.
      // On its own (outside, ahead of the insert) the timeline could claim a
      // review is missing while no persisted verdict/block exists to stop the gate
      // — the half-applied state FG-482 forbids for this transition.
      //
      // The failure kind and the container lifecycle ride in the payload as
      // DIAGNOSTICS for whoever reads the timeline. They are recorded here
      // precisely because they are not allowed to decide anything above.
      if (reviewMissingBlock) {
        logEvent("verdict.review_missing", {
          runId: args.runId,
          taskId: args.primaryTaskId,
          payload: {
            redRole: r.red.agent,
            redTaskId: r.redTaskId,
            authority: r.red.authority,
            failureKind: r.failureKind ?? null,
            containerStarted: r.containerStarted ?? null,
          },
        });
      }
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
    // FG-420 / FG-586: an authoritative gate that could not read a real verdict blocks.
    if (authoritativeGateBlock) {
      authoritativeFail = true;
    }
    // FG-628: an incomplete panel blocks regardless of the missing member's rank.
    if (reviewMissingBlock) {
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
  seedGeneration?: SeedGeneration | null;
  reviewerContextPacket?: ReviewerContextPacket;
}): Promise<{
  red: RedDef;
  verdict: Verdict;
  redTaskId: string;
  resultUnreadable?: boolean;
  // FG-628: set on a verdict forge SYNTHESIZED because no review came back.
  reviewMissing?: boolean;
  // Diagnostics that ride along for the operator-facing event payload. They
  // describe HOW the red died; they never decide whether it blocks.
  failureKind?: FailureKind;
  containerStarted?: boolean;
}> {
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
  const redWorkflowProv = resolveWorkflowSource(args.workflow.name, args.projectDir, redWorkflowReceipt, args.seedGeneration);

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
    seedGeneration: args.seedGeneration,
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
    // No reviewer-authored verdict exists on this path, so forge SYNTHESIZES the
    // `inconclusive` below — and a synthesized inconclusive means the panel is
    // incomplete and BLOCKS, orthogonally to the red's authority. That holds for
    // every failureKind reaching here (container_crash, idle_timeout, oom_killed,
    // result_missing, result_malformed, model_error, and any kind added later):
    // the marker at the return is set unconditionally so an unenumerated failure
    // fails CLOSED by construction rather than by someone remembering to extend a
    // list. FG-420's authoritative shipping-reviewer fail-safe still exists, but it
    // is no longer what makes a crashed red block — the general rule is. See the
    // FG-628 note at the return for why provenance, not outcome, is the test.
    // runContainer already marked the task failed.
    // FG-586: an UNREADABLE result is a distinct case — surfaced to dispatchReds
    // so an authoritative gate_on_verdict red fails CLOSED rather than advancing as
    // a bare inconclusive. Two shapes count as unreadable: result_malformed (a bad
    // byte the Part A bounded strip could not recover) AND result_missing (empty /
    // whitespace-only / zero-length-truncated output — resultRaw is .trim()ed at
    // read, so whitespace-only reviewer output classifies missing, not malformed).
    // Scoped to those two: it is FG-586's distinctive finding text that is scoped,
    // not the block — since FG-628 the block below covers every one of these.
    //
    // FG-628: THIS RETURN IS THE PROVENANCE SEAM. It is the single place in forge
    // where a missing review becomes a verdict: the `inconclusive` below was
    // FABRICATED here, not authored by a reviewer. Anything that reaches this line
    // produced no reviewable artifact, so it is marked as such — unconditionally,
    // and without consulting `failureKind`. Keying on an enumerated list of death
    // modes is what let the original bug survive twice: a kind nobody enumerated
    // (or one whose classification shifts) fell through to a non-blocking
    // `inconclusive (0.00)` that an orchestrator reads as "reviewed, undecided".
    // Asking "did a reviewer author this?" instead makes an unenumerated failure
    // fail CLOSED by construction.
    //
    // Note this is NOT the only place forge rewrites a verdict: dispatchReds also
    // downgrades an unsubstantiated `fail` to `inconclusive` (AWN-5). That one is
    // reviewer-AUTHORED — the reviewer produced an artifact and forge transformed
    // it — and stays non-blocking. Provenance, not outcome, is the line.
    return {
      red: args.red,
      redTaskId,
      verdict: { verdict: "inconclusive", confidence: 0, findings: [] },
      reviewMissing: true,
      // Diagnostics for the operator-facing event payload only. Container
      // lifecycle in particular must never gate completeness: in attached mode
      // (FORGE_DETACHED_EXEC=off) the start callback fires the instant the docker
      // CLIENT is spawned, before the daemon has created the container, so a
      // mount failure reports containerStarted=true — the exact signal that made
      // the earlier, narrower version of this rule fail open.
      failureKind: result.failureKind,
      containerStarted: result.containerStarted,
      ...(result.failureKind === "result_malformed" || result.failureKind === "result_missing"
        ? { resultUnreadable: true }
        : {}),
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
  seedGeneration?: SeedGeneration | null;
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

  // FG-621 (AC 4): ONE base for the whole wave, resolved before any child is
  // spawned and recorded on every sibling's row. Siblings integrate through the
  // existing ordered candidate path, so they must start from the same commit —
  // resolving per-child would let a concurrent publication move the base
  // mid-wave. Skipped entirely when isolation is off: the children create no
  // workspace then, and the empty string they receive is never read.
  let waveBaseSha = "";
  if (isWorktreeModeEnabled()) {
    try {
      waveBaseSha = resolveTaskBaseSha(args.projectDir, args.runId);
    } catch (e) {
      // The parent row exists by now (inserted or marked running above), so this
      // is a plain failTask rather than the create-and-fail helper.
      failTask(parentId, {
        runId: args.runId,
        kind: classify({}),
        error: `fanout: could not resolve the wave's base commit: ${(e as Error).message}`,
      });
      return "failed";
    }
  }

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
        seedGeneration: args.seedGeneration,
        requestedChanges,
        baseSha: waveBaseSha,
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
          seedGeneration: args.seedGeneration,
          requestedChanges,
          // The retry is part of the SAME wave, so it starts from the same base.
          baseSha: waveBaseSha,
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
        // FG-621: the child workspace path is deliberately NOT passed. Every
        // completed child was already captured (safety-committed, then fetched
        // into this repository's ref namespace) when it finished, so the branch
        // this merge resolves is final. Committing into the clone now would
        // advance only the clone's own ref and leave the fetched branch — and
        // therefore the candidate — silently stale.
        const merge = mergeChildIntoIntegration(
          integrationWorktreePath,
          args.runId,
          child.childTaskId,
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
      seedGeneration: args.seedGeneration,
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
/** FG-425: was this task's terminal state CHOSEN by a human, or inflicted on it?
 *
 *  `failed` alone cannot answer that — `forge cancel` and a crash-stranded publication
 *  land in the same status — so this reads the evidence `forge cancel` durably writes
 *  and a crash cannot: the `task.cancelled` event, and the `cancelled` failure kind on
 *  the task.failed event beside it. Both are written by cancel.ts and nothing else.
 *  Either one is proof; the reconciler needs proof of the ABSENCE of a cancel before it
 *  may touch a terminal row, so it fails closed on either. */
function taskWasCancelled(taskId: string): boolean {
  const events = eventsForTask(taskId);
  return events.some((e) => e.eventType === "task.cancelled") || failureKindFromEvents(events) === "cancelled";
}

/** FG-425: the cancel stands — and the candidate is on the target anyway.
 *
 *  Leaving that silent would re-create the AC5 contradiction from the other direction:
 *  an operator reads `cancelled`, takes the target to be untouched, and the publication
 *  sitting in its history is a surprise waiting for them. So the fact is recorded once,
 *  durably, naming the sha — which is what `forge show` renders (publicationAfterCancel)
 *  and what `forge publish recover` reports back. Once, not once per wave: reconciliation
 *  re-sweeps every terminal task on every wave, and an event stream that grows a line per
 *  wave forever is noise, not a record. */
function announcePublicationAfterCancel(runId: string, taskId: string, attempt: PublicationAttempt): void {
  if (eventsForTask(taskId).some((e) => e.eventType === "task.published_after_cancel")) return;
  logEvent("task.published_after_cancel", {
    runId,
    taskId,
    payload: {
      attemptId: attempt.attemptId,
      publishedSha: attempt.publishedSha,
      target: attempt.target,
    },
  });
}

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

    // A CANCEL IS TERMINAL AND WINS. `forge cancel` writes the same `failed` row a
    // crash-stranded task ends up in, and the two are opposite things: one is damage
    // to repair, the other is a human's decision to stop. Reconciling a cancelled task
    // would override that decision — and a cancel a background sweep can undo is not a
    // cancel. So the CONTRADICTION rule above applies only where the failure was NOT
    // chosen, and this task is left exactly where the operator put it.
    if (taskWasCancelled(task.id)) {
      if (attempt.state === "published") announcePublicationAfterCancel(runId, task.id, attempt);
      continue;
    }

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
  /** FG-425: set when the owning task was CANCELLED and its attempt published anyway.
   *  Nothing was reconciled — a cancel is terminal — but the candidate IS on the target,
   *  and the operator who cancelled it may not be left thinking otherwise. */
  publishedAfterCancel?: { taskId: string; runId: string; publishedSha: string; target: string };
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
  {
    const classification = classifyRunTerminalState(workflow, tasksForRun(attempt.runId));
    if (classification) {
      finalizeRunIfSettled(attempt.runId, classification.status, "publish-recover-reconciled", {
        failedPhases: classification.failedPhases.join(",") || undefined,
        unreachablePhases: classification.unreachablePhases.join(",") || undefined,
      });
    }
  }

  const task = getTask(attempt.taskId);
  if (!task) return { outcome };
  // The hand path goes through the same reconciliation as a wave, so it refuses the
  // same resurrection — and it owes the operator the same account of it. Nothing was
  // reconciled here (the cancel stands), so reporting a reconciliation would be a
  // second lie on top of the one this guard exists to prevent.
  const settled = getPublicationAttempt(attemptId);
  if (taskWasCancelled(task.id) && settled?.state === "published" && settled.publishedSha) {
    return {
      outcome,
      publishedAfterCancel: {
        taskId: task.id,
        runId: attempt.runId,
        publishedSha: settled.publishedSha,
        target: settled.target,
      },
    };
  }
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
  if (p.kind === "readiness_failed") {
    // FG-566: an ENVIRONMENT fault, classified as one. It reuses the EXISTING
    // FG-376 kind — `verification_environment_unavailable` (retryable, with
    // dependency-install advice, and already mapped to the campaign_system lane) —
    // discriminated by the readiness reason carried in the error, rather than
    // inventing a third incompatible notion of dependency readiness. Critically NOT
    // integration_failed: the gate never ran, so there is no verdict on the code.
    return classify({ source: "verification_environment_unavailable" });
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
  if (p.kind === "readiness_failed") {
    // FG-566: never phrased as a gate failure. The gate did not run.
    return (
      `verification environment could not be prepared for candidate ${p.candidateSha} (${p.reason}) — the integration ` +
      `gate never ran, so this is NOT a verdict on the code, and nothing was published: ${p.error}`
    );
  }
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
  seedGeneration?: SeedGeneration | null;
  requestedChanges?: string;
  /** FG-621 (AC 4): the ONE base every sibling of this wave is created from,
   *  resolved once by the caller before any child was spawned. */
  baseSha: string;
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
  const fcWorkflowProv = resolveWorkflowSource(args.workflow.name, args.projectDir, fcWorkflowReceipt, args.seedGeneration);

  // FG-374/FG-351 gate ordering: same as primary dispatch — preflight must run
  // BEFORE any state mutation so a bad mount cannot leak a worktree or DB row.
  try {
    preflightProjectMount(args.projectDir);
  } catch (e) {
    const msg = `preflightProjectMount failed: ${(e as Error).message}`;
    failTask(childTaskId, { runId: args.runId, kind: classify({}), error: msg });
    return { index: args.index, value: args.value, childTaskId, status: "failed" };
  }

  // FG-612: same self-host refusal as primary dispatch — pre-worktree, pre-container.
  try {
    assertSelfHostDispatchAllowed(args.projectDir, isWorktreeModeEnabled() ? "isolated" : "not-armed");
  } catch (e) {
    failTask(childTaskId, { runId: args.runId, kind: classify({}), error: (e as Error).message });
    return { index: args.index, value: args.value, childTaskId, status: "failed" };
  }

  // FG-351/FG-621: provision each fanout child's PRIVATE CLONE when workspace
  // isolation is enabled. Same pattern as primary dispatch: DB write before
  // container start so reconcile can find the path after a process restart.
  //
  // AC 4: every sibling of one wave is created from the SAME base — args.baseSha,
  // resolved ONCE by dispatchFanoutStep before any child was spawned. Resolving it
  // per-child would let a concurrent publication move the base mid-wave and give
  // two siblings different starting points.
  let childWorktreePath: string | undefined;
  if (isWorktreeModeEnabled()) {
    try {
      preflightWorktreeGate(args.projectDir);
      const clone = provisionTaskClone(args.projectDir, args.runId, childTaskId, args.baseSha);
      childWorktreePath = clone.clonePath;
      if (clone.untrackedFiles.length > 0) {
        process.stderr.write(
          `[forge/worktree] task ${childTaskId}: ${clone.untrackedFiles.length} untracked host file(s) not in workspace: ${clone.untrackedFiles.slice(0, 5).join(", ")}${clone.untrackedFiles.length > 5 ? ` (+${clone.untrackedFiles.length - 5} more)` : ""}\n`
        );
      }
    } catch (e) {
      // Gate or create failure: transition the child task to failed so the fanout
      // run can report the error instead of hanging with a pending child.
      // cleanupFailedWorktreeSetup is NOT EPHEMERAL-gated: the agent never ran,
      // so there is no output to preserve — always safe to remove partial state.
      const msg = `worktree setup failed: ${(e as Error).message}`;
      settleFailedCloneProvisioning(args.projectDir, args.runId, childTaskId, e);
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
    seedGeneration: args.seedGeneration,
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

  // FG-621 (AC 3 / AC 5): capture the child's clone HERE, at completion, in the
  // fixed order — safety-commit tracked AND untracked state, then fetch the
  // branch into this repository's ref namespace. The integration merge below
  // resolves that branch by name, and the clone's private refs are not visible to
  // the parent until this runs.
  if (childWorktreePath) {
    const capture = captureTaskClone(args.projectDir, childWorktreePath, args.runId, childTaskId);
    if (!capture.ok) {
      failTask(childTaskId, {
        runId: args.runId,
        kind: "capture_failed",
        error: `${capture.error} [${capture.cause}]`,
        result: dispatchResult.result,
      });
      finalizeContainerRetention(dispatchResult.containerName, false);
      return { index: args.index, value: args.value, childTaskId, status: "failed", worktreePath: childWorktreePath };
    }
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
  // FG-586: failureKind threads the reason a container failed so callers can
  // distinguish an unreadable-result failure (result_malformed) from an ordinary
  // container failure. runOneRed uses it to fail an authoritative reviewer closed.
  //
  // FG-628: `containerStarted` is the START outcome, threaded PURELY as a
  // diagnostic for the operator-facing `verdict.review_missing` payload. It is
  // deliberately not trustworthy enough to gate on: the attached executor
  // (FORGE_DETACHED_EXEC=off) fires its start callback the instant the docker
  // CLIENT is spawned — before the daemon has created the container — so a mount
  // failure there reports `true`. Only present when the executor reports a start
  // at all (`signalsContainerStart`, FG-536).
  | { kind: "failed"; error: string; failureKind?: FailureKind; containerStarted?: boolean };

// FG-586 Part A: bounded envelope tolerance for a result payload that JSON.parse
// rejects as-is. Before declaring the result unreadable, retry the parse against a
// FIXED, ENUMERABLE set of whole-document wrapper strips — never an open-ended
// salvage: no "find the first '{'", no interior-content regex, no multi-marker
// peeling loop. A stray byte in the MIDDLE of the JSON is deliberately NOT
// recovered here (that stays unreadable; Part B fails it closed). Returns the
// parsed value on the first candidate that parses, else { ok: false }.
function parseResultWithBoundedEnvelope(
  raw: string,
): { ok: true; value: unknown } | { ok: false } {
  const trimmed = raw.trim();
  const candidates: string[] = [trimmed];
  // A SINGLE leading '+' or '-' diff/patch marker byte (one byte, not a loop).
  if (trimmed.length > 0 && (trimmed[0] === "+" || trimmed[0] === "-")) {
    candidates.push(trimmed.slice(1).trim());
  }
  // A Markdown fenced code block: a leading ```json (or bare ```) line and the
  // trailing ``` fence.
  const unfenced = stripJsonCodeFence(trimmed);
  if (unfenced !== null) candidates.push(unfenced);

  for (const candidate of candidates) {
    if (candidate.length === 0) continue;
    try {
      return { ok: true, value: JSON.parse(candidate) };
    } catch {
      // fall through to the next fixed candidate
    }
  }
  return { ok: false };
}

// FG-586: strip a single Markdown fenced code block wrapper — a leading fence line
// (``` or ```json, case-insensitive) and the trailing ``` fence — returning the
// inner body, or null if `s` is not fenced. Fixed grammar only; no salvage.
function stripJsonCodeFence(s: string): string | null {
  if (!s.startsWith("```")) return null;
  const firstNewline = s.indexOf("\n");
  if (firstNewline === -1) return null;
  const fenceLine = s.slice(0, firstNewline).trim();
  if (fenceLine !== "```" && fenceLine.toLowerCase() !== "```json") return null;
  const afterOpen = s.slice(firstNewline + 1);
  const closeIdx = afterOpen.lastIndexOf("```");
  if (closeIdx === -1) return null;
  // FG-586: the closing fence must TERMINATE the document — only whitespace may
  // follow it. Otherwise arbitrary text after the fence (`\`\`\`...\`\`\`\nGARBAGE`)
  // would be silently discarded and the inner JSON accepted. Refuse to strip a
  // fence with a non-whitespace suffix so the payload stays unreadable and (for an
  // authoritative red) fails closed rather than being salvaged.
  if (afterOpen.slice(closeIdx + 3).trim().length > 0) return null;
  return afterOpen.slice(0, closeIdx).trim();
}

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
  seedGeneration?: SeedGeneration | null;
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
  // FG-612: the last chokepoint every runNext spawn funnels through — primary,
  // red, fanout child. First statement in the body so nothing (not even
  // dependency provisioning, which spawns its own container below) can start
  // ahead of the refusal.
  try {
    assertSelfHostDispatchAllowed(args.projectDir, isWorktreeModeEnabled() ? "isolated" : "not-armed");
  } catch (e) {
    const msg = (e as Error).message;
    failTask(args.taskId, { runId: args.runId, kind: classify({}), error: msg });
    return { kind: "failed", error: msg };
  }

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
    const loaded = loadRuntimeWithSource(args.resolution.runtime, { projectDir: args.projectDir, seedGeneration: args.seedGeneration });
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

  // FG-628: establish the mountpoint precondition against repoRootForMount — the
  // tree that will ACTUALLY be bound at the container's project path — here, at
  // the point the mount is decided, not at each isolated-workspace constructor.
  //
  // Every dependency volume binds at a path INSIDE a read-only project mount (the
  // provisioner's at spawn.ts's buildProvisionerDockerArgs, the reviewer's at the
  // `:ro` planned volumes), and docker cannot mkdir a mountpoint on a read-only
  // rootfs. FG-627 created them at worktree/clone creation, which covers two of
  // the trees that can be bound here and misses the rest — a plain `--project
  // <dir>` dispatch and, the one that actually fires in worktree mode, an FG-425
  // publication candidate (`createCandidateWorktree`), whose fresh checkout can
  // never carry a gitignored `<member>/node_modules`. Deriving the precondition
  // from the mount decision instead of from a list of constructors is what makes
  // those covered by construction. worktree-lifecycle.ts's two calls stay: they
  // are now two callers of this mechanism, not the only ones.
  //
  // The underlying defect: readiness is a property of the LOCKFILE (host-global
  // `~/.forge/dependency-cache/<hash>.ready`, ABI-free and deliberately
  // checkout-independent), while mountability is a property of the SPECIFIC
  // CHECKOUT. The `.ready` marker was being used to authorize a mount into a tree
  // that had never been prepared for one. What becomes checkout-scoped here is the
  // mountpoint precondition; the readiness key stays exactly as FG-566 left it.
  //
  // Safety of writing into a live, non-disposable checkout (AC 4): the only thing
  // created is an EMPTY directory under an already-gitignored path. Git cannot see
  // an empty ignored directory through `status --porcelain`, `status --porcelain
  // --ignored`, or `ls-files --others` — verified in a fixture — so capture
  // stays clean. (`git clean -fdX`/`-fdx` DOES remove it, like any ignored path;
  // harmless, the next dispatch recreates it.) The FG-356 reaper's probe runs
  // against the task workspace from the DB row, which a non-isolated dispatch does
  // not have at all. FG-566's `workspaceHasNodeModules` non-empty check is what
  // keeps an empty mountpoint from reading as an installed tree; that check is the
  // reason this is safe, and it stays untouched. Refusing at preflight instead
  // would convert a crash into a permanent refusal for every project that ever ran
  // a root-only install — strictly worse than the bug.
  //
  // Idempotent under concurrency by construction: a non-isolated project dir has
  // no host-side mutual exclusion (the only dispatch lock is per-run, and a fanout
  // wave dispatches children in parallel), and `mkdir -p` racing itself is a
  // no-op, not a conflict.
  //
  // Failure is not fatal. If the mountpoints cannot be created (a read-only or
  // permission-denied checkout), we simply do not mount the cache — the exact
  // pre-existing "cache isn't ready" posture: never block, never install. Mounting
  // anyway is what crashes the container.
  //
  // Lazy + memoized so it runs exactly when a volume is about to be bound into
  // this tree and never otherwise: a plain rw non-worktree primary takes the
  // legacy anonymous shadow and mounts none of these, so it has no business
  // writing into the operator's checkout.
  let mountpointsReady: boolean | undefined;
  const projectTreeIsMountable = (): boolean => {
    if (mountpointsReady === undefined) {
      try {
        createDependencyMountpoints(repoRootForMount);
        mountpointsReady = true;
      } catch (e) {
        logEvent("container.dependency_mountpoints_unavailable", {
          runId: args.runId,
          taskId: args.taskId,
          payload: { repoRoot: repoRootForMount, error: (e as Error).message },
        });
        mountpointsReady = false;
      }
    }
    return mountpointsReady;
  };

  if (dependencyCacheEligible && isWorktreeRwDispatch && projectTreeIsMountable()) {
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
      // FG-559: build the provisioner argv HERE, not inside the lock callback —
      // its mount-plan assertion is a host-side refusal that must precede every
      // container this dispatch starts, and the provisioner starts before the
      // agent container buildDockerArgs guards below.
      let provisionerArgs: string[];
      try {
        provisionerArgs = buildProvisionerDockerArgs(
          runtime,
          {
            TASK_ID: args.taskId,
            PROJECT_DIR: repoRootForMount,
            // FG-621: Forge's OWN record of the parent this workspace was made
            // from. On the clone substrate the planner refuses without it — the
            // workspace's alternates file is agent-writable, so it is only ever a
            // value to verify, never a path to trust.
            CANONICAL_PROJECT_DIR: args.projectDir,
          },
          plan,
        );
      } catch (e) {
        const msg = `buildProvisionerDockerArgs failed: ${(e as Error).message}`;
        cleanupStagedAuth(dir); // AWN-8
        failTask(args.taskId, { runId: args.runId, kind: classify({}), error: msg });
        return { kind: "failed", error: msg };
      }
      let provisionerExitCode = -1;
      let provisionerStderrTail = "";
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
        provisionerStderrTail = existsSync(provisionStderrPath) ? readFileSync(provisionStderrPath, "utf8").trim() : "";
        return { exitCode: provisionerExitCode, stderrTail: provisionerStderrTail };
      });
      if (provision.outcome === "failed") {
        // FG-559: the provisioner runs the same entrypoint as the agent, so it
        // hits the git probe too — and on a fresh cache key it is the FIRST
        // container this dispatch starts, so 122 surfaces HERE, never at the
        // agent branch below. Diagnose it as the git failure it is; calling it
        // a dependency-install failure sends the operator hunting npm.
        const gitUnavailable = provisionerExitCode === GIT_UNAVAILABLE_EXIT_CODE;
        const error = gitUnavailable
          ? `verification_environment_unavailable: git is unusable in the project mount${provisionerStderrTail ? ` — ${provisionerStderrTail}` : ""}`
          : provision.error;
        logEvent(gitUnavailable ? "container.git_unavailable" : "container.dependency_provisioning_failed", {
          runId: args.runId,
          taskId: args.taskId,
          payload: { containerName: provisionContainerName, exitCode: provisionerExitCode },
        });
        cleanupStagedAuth(dir); // AWN-8
        failTask(args.taskId, {
          runId: args.runId,
          kind: classify({ source: "verification_environment_unavailable" }),
          error,
        });
        return { kind: "failed", error };
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
    // FG-628: a ready cache key authorizes the CONTENT of the mount; the
    // mountpoints authorize the mount itself. Both, or neither — this pairing is
    // the whole fix, because readiness is keyed on the lockfile and mountability
    // is a property of this specific checkout.
    const cacheKey = safeLockfileHash(repoRootForMount);
    if (cacheKey && isDependencyCacheReady(cacheKey) && projectTreeIsMountable()) {
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
    // FG-621: the parent repository as FORGE recorded it — the run's projectDir,
    // which is Forge-owned state, never anything read out of the workspace. The
    // clone mount planner derives the expected parent object store from this and
    // refuses any workspace whose `objects/info/alternates` disagrees; supplying
    // it here is what makes that verification run on the production path instead
    // of only when a test passes one in.
    CANONICAL_PROJECT_DIR: args.projectDir,
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
  //
  // FG-559: preflight repoRootForMount, NOT args.projectDir — the worktree is
  // what gets mounted at /project, so it is the tree whose `.git` pointer has to
  // resolve. On a non-worktree dispatch the two are the same value.
  try {
    preflightProjectMount(repoRootForMount);
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

  // FG-559: the entrypoint's git probe found git unusable in the project mount
  // (a linked worktree whose parent .git never made it into the container).
  // Same footing as the provisioning sentinel above — an environment failure.
  if (exitCode === GIT_UNAVAILABLE_EXIT_CODE) {
    const stderrTail = existsSync(stderrPath) ? readFileSync(stderrPath, "utf8").trim() : "";
    logEvent("container.git_unavailable", { runId: args.runId, taskId: args.taskId, payload: { containerName, exitCode, ...(containerEvidence ? { containerEvidence } : {}) } });
    const msg = `verification_environment_unavailable: git is unusable in the project mount${stderrTail ? ` — ${stderrTail}` : ""}`;
    failTask(args.taskId, { runId: args.runId, kind: classify({ source: "verification_environment_unavailable" }), error: msg });
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
    // FG-628: this was the ONE `failed` return that dropped its failureKind — the
    // malformed and missing-result branches below both thread it. Both it and the
    // start outcome ride out to runOneRed as DIAGNOSTICS, so the ingestion event an
    // operator reads names how the red died. Neither decides whether it blocks.
    return {
      kind: "failed",
      error: msg,
      failureKind: kind,
      ...(exec.signalsContainerStart ? { containerStarted: containerStartRecorded } : {}),
    };
  }
  let result: unknown;
  if (resultRaw.length > 0) {
    // FG-586 Part A: before declaring the result malformed, retry the parse
    // against a FIXED, bounded envelope strip (leading marker byte / fenced code
    // block) so a real verdict wrapped in a diff/patch or Markdown fence survives.
    // A stray byte in the MIDDLE of the document is deliberately NOT recovered —
    // it stays malformed and (for an authoritative red) fails closed via Part B.
    const parsed = parseResultWithBoundedEnvelope(resultRaw);
    if (!parsed.ok) {
      // FG-586: keep the raw unreadable artifact on disk as-is (evidence) — never
      // overwrite result.json with a "cleaned" version in the unrecoverable case.
      const msg = "result.json malformed";
      const kind = classify({ resultState: "malformed" });
      failTask(args.taskId, { runId: args.runId, kind, error: msg });
      // FG-492 review: task failed — retain (see finalizeContainerRetention in docker-exec.ts).
      finalizeContainerRetention(containerName, false);
      return { kind: "failed", error: msg, failureKind: kind };
    }
    result = parsed.value;
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
        return { kind: "failed", error: err, failureKind: kind };
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
    // FG-586: thread failureKind so runOneRed can fail an authoritative reviewer
    // CLOSED on a missing/empty/whitespace-truncated result (resultRaw is
    // .trim()ed at read, so whitespace-only reviewer output lands here as
    // result_missing) — not just on result_malformed. A model_error kind here
    // stays a non-blocking inconclusive (it won't match runOneRed's unreadable set).
    return { kind: "failed", error: msg, failureKind: kind };
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
  receipt: { source: "host" | "project"; path: string } | undefined,
  seedGeneration?: SeedGeneration | null,
): { source: "host" | "project" | "unknown"; path?: string; warnings?: string[] } {
  if (receipt) return receipt;
  try {
    const loaded = loadWorkflowWithSource(workflowName, { projectDir, seedGeneration });
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
