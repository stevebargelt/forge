// forge retry — preserve the failed task as an audit record; create a new
// task row that inherits the same phase/role/inputs. The new task is `pending`;
// a workflow-step row is redispatched by forge-next, an ad-hoc row by retry
// itself (FG-507, below).
//
// The new row is a PRIMARY (parentId unset) — NOT gate.ts's `request-changes`
// shape, which does point a child back at its parent. runNext.dispatchStep only
// reuses pending PRIMARY rows, so a parented retry would be skipped by the ready
// queue and a fresh contextless task created in its place. Lineage is therefore
// carried by inputs.previous_failure.failedTaskId and the task.retried event;
// retry chains are walked through those, never through parentId.
//
// Scoped to failed tasks only. Rerun-on-complete is a different feature
// (different semantics; what does "different" mean from same inputs?) and
// not in scope.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import type { Run, Task } from "../types/index.js";
import { getTask, insertTask } from "../store/tasks.js";
import { getRun } from "../store/runs.js";
import { logEvent, eventsForTask } from "../store/events.js";
import { newTaskId, nowIso } from "../util/ids.js";
import { taskDir } from "../util/paths.js";
import { failureKindForTask } from "./failure-kind.js";
import { retryPolicy, type RetryDisposition } from "./retry-policy.js";
import { taskDispatchKind } from "./run-kind.js";
import { readTaskManifest } from "./task-manifest.js";
import { composeSystemPrompt } from "./compose.js";
import { resolveModel, taskModelFields, type ModelResolution } from "./model-resolution.js";
import {
  dispatchInvokeTask,
  invokeWorkflowShape,
  reactivateTerminalRun,
  type DockerExecFn,
  type InvokeResult,
} from "./invoke.js";

// FG-492: the failed task's container may have been RETAINED (docker-exec.ts's
// FORGE_CONTAINER_RETENTION policy keeps a failed task's container around for
// `forge show` / `forge ops reap-containers` to inspect). retry() always mints
// a brand-new task id (see below), so the new task's own container name
// (forge-<newId>) never collides with the old one — but once an operator has
// decided to retry, the old container's diagnostic value is spent, and leaving
// it around is just clutter a background `forge ops reap-containers` sweep
// would otherwise have to find later. Best-effort, never blocks the retry: a
// daemon hiccup or an already-gone container is silently ignored.
// Exported (mirrors docker-exec.ts's captureContainerCausalEvidence /
// finalizeContainerRetention convention) so a test can inject a fake
// execFileSync and assert the exact reap attempted, without a real docker
// daemon.
export function reapRetainedContainer(
  taskId: string,
  execFileSyncFn: typeof execFileSync = execFileSync,
): void {
  try {
    // -v: also remove the anonymous shadow volume (DEC-019) — no --rm anymore.
    execFileSyncFn("docker", ["rm", "-f", "-v", `forge-${taskId}`], { stdio: ["ignore", "ignore", "ignore"] });
  } catch {
    // best-effort only — container already gone, or docker unreachable
  }
}

export class RetryNotAllowedError extends Error {
  constructor(public taskId: string, public disposition: RetryDisposition) {
    super(`Task ${taskId} is not retryable: ${disposition.reason}.${disposition.advice ? ` ${disposition.advice}.` : ""} Use --force to retry anyway.`);
    this.name = "RetryNotAllowedError";
  }
}

// FG-455 p3: retrying a fanout CHILD directly mints a new parentId-undefined
// primary in the child's phase — the same phase the real fanout parent (and
// its siblings) already occupy. That stray primary confuses dispatchFanoutStep's
// existingParent lookup (which phase's the only-pending primary is now
// ambiguous) and pollutes tasksForRun with a primary that was never a genuine
// wave parent. `forge recover <parent> --re-drive` is the coherent path for
// re-driving a fanout wave; refuse the child-retry shortcut unless the operator
// explicitly forces it (preserving pre-FG-455 behavior).
export class FanoutChildRetryError extends Error {
  constructor(public taskId: string, public parentId: string) {
    super(
      `Task ${taskId} is a fanout child (parent ${parentId}) — retrying it directly would strand a detached primary in the fanout's phase. ` +
        `Use \`forge recover ${parentId} --re-drive\` to re-drive the whole wave, or pass --force to retry this child anyway.`,
    );
    this.name = "FanoutChildRetryError";
  }
}

// FG-507: an ad-hoc (invoke-attached) task is invisible to the workflow ready
// queue, so `forge retry` re-dispatches its new row itself rather than minting a
// pending row and pointing at `forge next` — which reported "nothing ready to
// dispatch" and stranded the row (the live FG-502 failure). This is the dispatch
// context that re-dispatch needs, all of it recovered from RECORDED facts (the
// FG-350 control-plane receipt + the failed task's own row/events), never guessed.
export type AdHocDispatchPlan = {
  projectDir: string;
  readOnlyProject: boolean;
  taskText: string;
  composedSystemPrompt: string;
  resolution: ModelResolution;
  designDir?: string;
  authProfile?: string;
  /** RECORDED only: absent when the task failed before dispatch wrote a manifest. */
  runtimeName?: string;
};

// Refused BEFORE any row is written, so a retry that cannot dispatch can never
// leave a stranded pending task behind — the exact silent state FG-507 is about.
export class AdHocRedispatchUnavailableError extends Error {
  constructor(public taskId: string, public runId: string, public reason: string, public nextAction: string) {
    super(
      `Task ${taskId} is an ad-hoc (invoke-attached) task, so \`forge retry\` must re-dispatch it directly — ` +
        `but it cannot: ${reason}. No pending task row was created (nothing to clean up). Re-dispatch it yourself:\n  ${nextAction}`,
    );
    this.name = "AdHocRedispatchUnavailableError";
  }
}

// FG-507 (round 2): taskDispatchKind came back `unknown` — forge cannot tell a
// workflow step (which `forge next` redispatches) from an invoke-attached row
// (which it never will). Guessing "workflow step" is what stranded rows in the
// first place, so refuse — before any write — and hand back both recoveries,
// since only the operator knows which task this was. `reason` carries WHICH
// unprovable state this is; the rendered message differs, the refusal doesn't.
export class RetryDispatchKindUnknownError extends Error {
  constructor(
    public taskId: string,
    public runId: string,
    public workflow: string,
    public reason: "workflow_unloadable" | "legacy_ambiguous_phase",
    message: string,
  ) {
    super(message);
    this.name = "RetryDispatchKindUnknownError";
  }
}

function invokeCommandFor(task: Task, projectDir: string | undefined, taskText: string | undefined): string {
  const parts = [`forge invoke ${task.agentRole}`, `--run ${task.runId}`];
  if (projectDir) parts.push(`--project ${projectDir}`);
  parts.push(taskText ? `--task '${taskText.replaceAll("'", "'\\''")}'` : `--task '<the original task text — this row never recorded it>'`);
  return parts.join(" ");
}

/** The dispatch facts recoverable from RECORDED state (the FG-350 receipt + the
 *  task's own row), shared by the re-dispatch plan and both refusal paths — so a
 *  refusal always names the same projectDir/task text the plan would have used. */
function recordedDispatchFacts(task: Task, run: Run) {
  const manifest = readTaskManifest(taskDir(task.runId, task.id));
  const raw = task.taskPackage.inputs["task"];
  return {
    manifest,
    projectDir: manifest?.controlPlane?.projectDir ?? run.projectDir,
    taskText: typeof raw === "string" && raw.length > 0 ? raw : undefined,
  };
}

/** The `(b)` recovery, shared by both refusals: a ready-to-run invoke command when
 *  the row recorded its task text, and an honest admission when it didn't. */
function adHocRecoveryAction(task: Task, projectDir: string | undefined, taskText: string | undefined): string {
  return taskText
    ? `  (b) an ad-hoc \`forge invoke --run ${task.runId}\` task — re-dispatch it directly:\n        ${invokeCommandFor(task, projectDir, taskText)}`
    : `  (b) an ad-hoc \`forge invoke --run ${task.runId}\` task — re-dispatch it directly with \`forge invoke ${task.agentRole} --run ${task.runId}\`; this row recorded no \`inputs.task\` text, so supply the original task yourself.`;
}

function refuseUnloadableWorkflow(task: Task, run: Run, loadError: string): never {
  const { projectDir, taskText } = recordedDispatchFacts(task, run);
  const actions = [
    `  (a) a workflow step — restore the workflow YAML, then re-run \`forge retry ${task.id}\`.`,
    adHocRecoveryAction(task, projectDir, taskText),
  ];
  throw new RetryDispatchKindUnknownError(
    task.id,
    task.runId,
    run.workflow,
    "workflow_unloadable",
    `Task ${task.id} cannot be retried: run ${task.runId}'s workflow '${run.workflow}' does not load, so forge cannot tell whether ` +
      `${task.id} is a step of that workflow (which \`forge next\` would redispatch) or an ad-hoc \`forge invoke\` task ` +
      `(which \`forge next\` never dispatches, and which would strand as a pending row). ` +
      `No pending task row was created (nothing to clean up).\n` +
      `  workflow load error: ${loadError}\n` +
      `Recover by whichever this task is:\n${actions.join("\n")}`,
  );
}

// The row predates FG-507's `dispatchSource` marker, and the run's workflow
// legitimately owns a step whose id is `task` — the phase every `forge invoke`
// row carries. Nothing recorded distinguishes the two, and both wrong guesses are
// bad: "workflow step" strands a pending row, "ad-hoc" re-dispatches a pipeline
// step with invoke semantics (no worktree merge, no gates, no reds). Refuse.
function refuseAmbiguousLegacyPhase(task: Task, run: Run): never {
  const { projectDir, taskText } = recordedDispatchFacts(task, run);
  const actions = [
    `  (a) a genuine \`${task.phase}\` step of workflow '${run.workflow}' — forge cannot mint its pending ` +
      `replacement row without proving it is one. \`forge next ${task.runId}\` dispatches that run's ready queue, ` +
      `but it will not pick this phase up while its only row is the failed primary; re-drive the step from a fresh run of '${run.workflow}'.`,
    adHocRecoveryAction(task, projectDir, taskText),
  ];
  throw new RetryDispatchKindUnknownError(
    task.id,
    task.runId,
    run.workflow,
    "legacy_ambiguous_phase",
    `Task ${task.id} cannot be retried: it records no dispatch provenance (a legacy pre-provenance row), and run ` +
      `${task.runId}'s workflow '${run.workflow}' owns a step whose id is '${task.phase}' — the same phase every ` +
      `\`forge invoke\` task carries. A legacy \`forge invoke --run\` row and a genuine '${task.phase}' step are ` +
      `indistinguishable here, so forge cannot tell whether \`forge next\` would redispatch ${task.id} or never see it ` +
      `(stranding it as a pending row). No pending task row was created (nothing to clean up).\n` +
      `Recover by whichever this task is:\n${actions.join("\n")}`,
  );
}

function planAdHocRedispatch(task: Task, run: Run): AdHocDispatchPlan {
  const { manifest, projectDir, taskText } = recordedDispatchFacts(task, run);
  const receipt = manifest?.controlPlane;
  // Annotated on the const, not just the arrow, so TS narrows past every call.
  const refuse: (reason: string) => never = (reason) => {
    throw new AdHocRedispatchUnavailableError(task.id, task.runId, reason, invokeCommandFor(task, projectDir, taskText));
  };

  if (!taskText) refuse("its taskPackage carries no `inputs.task` text, so there is no task to hand the agent");
  if (!projectDir) refuse("neither its dispatch receipt nor its run records a projectDir to mount at /project");
  if (!existsSync(projectDir)) refuse(`its recorded projectDir no longer exists on this host (${projectDir})`);

  // #176: an auth-profile invoke that silently re-dispatches WITHOUT the profile
  // lands the agent on an unauthenticated app and produces false "app broken"
  // reports. `auth.profile_applied` is the DURABLE record of which profile ran, so
  // it is consulted first and unconditionally — manifest.auth.profileRequested is
  // only a dispatch-time intent flag, and a partial/pre-receipt manifest omits it
  // entirely. The flag alone (requested, but the task died before auth applied)
  // still refuses: the name was never recorded, so there is nothing to replay.
  const applied = eventsForTask(task.id).find((e) => e.eventType === "auth.profile_applied");
  const appliedProfile = (applied?.payload as { profile?: unknown } | undefined)?.profile;
  let authProfile: string | undefined;
  if (typeof appliedProfile === "string") {
    authProfile = appliedProfile;
  } else if (applied || manifest?.auth?.profileRequested) {
    refuse("it ran with an auth profile whose name was never recorded, and re-dispatching unauthenticated would silently change what the agent sees");
  }

  // Reds get read-only project mounts as an OS-level invariant, not a preference
  // (CLAUDE.md). The receipt records the mount this task actually ran under; with
  // no receipt, fall back to the same `red-` role discriminator runNext.ts uses.
  const readOnlyProject = receipt ? receipt.mountMode === "ro" : task.agentRole.startsWith("red-");

  // The runtime the task actually ran under (FG-366: manifest.runtime.name and the
  // FG-350 receipt's runtime.name are the same RESOLVED concrete runtime, e.g.
  // "claude-apikey" — either is a RECORDED fact). In policy mode resolveModel
  // rebinds it from (provider, auth) anyway; in legacy mode it is loaded verbatim,
  // so a manifest that proves the task dispatched but records neither name cannot
  // be defaulted to "claude" without silently moving a codex/pi invoke's retry
  // onto a different runtime. A task with NO manifest never reached dispatch (invoke
  // writes it just before buildDockerArgs; auth/provider preflight fails earlier),
  // so there is no runtime it ran under to preserve — that retry re-resolves exactly
  // as a fresh `forge invoke` does, which is also all the refusal below could offer.
  const runtimeName = manifest?.runtime?.name ?? manifest?.controlPlane?.runtime?.name;
  if (manifest && !runtimeName) refuse("its manifest records no runtime — neither `runtime.name` nor the dispatch receipt's — so the runtime it ran under cannot be replayed, and defaulting to `claude` could silently re-dispatch it elsewhere");

  // An explicit `forge invoke --profile <name>` is an operator decision about
  // which model/provider/auth runs the work, not an incidental default. Re-resolving
  // without it would silently retry on whatever profile the ambient policy picks now
  // (an agent override, an activity default — including the profile of whatever
  // review loop happens to be driving the retry). The manifest records the profile
  // AND its provenance, so replay it only when the CLI flag was what won: every
  // other resolvedBy is a policy rule that should re-evaluate against today's policy.
  const model = manifest?.model;
  const cliProfile = model?.resolvedBy === "cli.--profile" && model.profile ? model.profile : undefined;

  // Resolve model + compose the prompt HERE, before the row is inserted: both can
  // throw on a broken policy/agent dir, and a throw before insertTask means no row.
  const resolution = resolveModel({
    agentRole: task.agentRole,
    stepAlias: task.agentAlias,
    cliProfile,
    runtimeName,
    ctx: { projectDir },
  });
  const { step, workflow } = invokeWorkflowShape(task.agentRole, task.agentAlias, runtimeName);
  const composedSystemPrompt = composeSystemPrompt({ role: task.agentRole, workflow, step });

  return {
    projectDir,
    readOnlyProject,
    taskText,
    composedSystemPrompt,
    resolution,
    ...(run.metadata?.["designDir"] ? { designDir: String(run.metadata["designDir"]) } : {}),
    ...(authProfile ? { authProfile } : {}),
    ...(runtimeName ? { runtimeName } : {}),
  };
}

// FG-507: run the retried ad-hoc row through the SAME spawn machinery `forge
// invoke` uses — one dispatch path, so result.json handling, events, run
// finalization and notifications cannot drift between the two commands.
export async function dispatchRetriedAdHocTask(
  newTask: Task,
  plan: AdHocDispatchPlan,
  dockerExec?: DockerExecFn,
): Promise<InvokeResult> {
  const run = getRun(newTask.runId);
  if (run) reactivateTerminalRun(newTask.runId, run.status, "retry");
  return dispatchInvokeTask({
    task: newTask,
    resolution: plan.resolution,
    projectDir: plan.projectDir,
    taskText: plan.taskText,
    ownsRun: false,
    modelAlias: newTask.agentAlias,
    readOnlyProject: plan.readOnlyProject,
    ...(plan.designDir ? { designDir: plan.designDir } : {}),
    ...(plan.authProfile ? { authProfile: plan.authProfile } : {}),
    ...(dockerExec ? { dockerExec } : {}),
  });
}

/** undefined => workflow step: leave the new pending row to the ready queue. */
function planRetryDispatch(task: Task, run: Run): AdHocDispatchPlan | undefined {
  const kind = taskDispatchKind(task, run);
  if (kind.kind === "workflow_step") return undefined;
  if (kind.kind === "unknown") {
    if (kind.reason === "workflow_unloadable") refuseUnloadableWorkflow(task, run, kind.loadError);
    refuseAmbiguousLegacyPhase(task, run);
  }
  return planAdHocRedispatch(task, run);
}

/** Is `task` a fanout child? True iff it has a parent, that parent shares its
 *  phase (fanout children run in the SAME phase as their synthetic parent —
 *  gate.ts's reject->on_reject children land in a DIFFERENT phase, the on_reject
 *  target, so phase equality alone rules those out), and it isn't itself a red
 *  reviewer (reds also share parentId+phase with an ordinary primary, but are
 *  always prefixed "red-" — see runNext.ts's own `!agentRole.startsWith("red-")`
 *  filters for the same discriminator). */
function fanoutParentOf(task: Task): Task | undefined {
  if (task.parentId === undefined) return undefined;
  if (task.agentRole.startsWith("red-")) return undefined;
  const parent = getTask(task.parentId);
  if (!parent || parent.phase !== task.phase) return undefined;
  return parent;
}

export type RetryOutcome = {
  task: Task;
  newTask: Task;
  disposition: RetryDisposition;
  failureKind?: string;
  /** FG-507: present iff the new row is ad-hoc — the caller must dispatch it via
   *  dispatchRetriedAdHocTask(); `forge next` will never see it. */
  adHoc?: AdHocDispatchPlan;
};

export async function retry(taskId: string, opts?: { force?: boolean }): Promise<RetryOutcome> {
  const task = getTask(taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);

  if (task.status !== "failed") {
    throw new Error(
      `Task ${taskId} is in status '${task.status}', not failed. Retry only resets failed tasks; for other states, gate or submit instead.`
    );
  }

  const fanoutParent = fanoutParentOf(task);
  if (fanoutParent && !opts?.force) {
    throw new FanoutChildRetryError(taskId, fanoutParent.id);
  }

  // AWN-3: consult the per-failure_kind retry policy. Non-retryable kinds (gate
  // rejection, red block) would just re-run identical work — refuse unless --force.
  const failureKind = failureKindForTask(taskId);
  const disposition = retryPolicy(failureKind, taskId);
  if (!disposition.retryable && !opts?.force) {
    throw new RetryNotAllowedError(taskId, disposition);
  }

  // FG-507: decide ad-hoc vs workflow-step, and plan the ad-hoc re-dispatch,
  // BEFORE any write. Both refusals (dispatch facts unrecoverable; the workflow
  // that would answer the question won't load) throw here, so neither ever
  // inserts the pending row it could not have dispatched. This is the ONE place
  // taskDispatchKind's `unknown` is interpreted.
  const run = getRun(task.runId);
  const adHoc = run ? planRetryDispatch(task, run) : undefined;

  // Build a fresh task row — same phase/role/inputs/agentAlias/agentModel, NEW id
  // (so it gets a fresh task dir: no reuse of the failed attempt's result.json or
  // staged auth-state). parentId is left undefined — see the PRIMARY note below.
  // composedSystemPrompt is cleared (re-composed at dispatch). status pending.
  const newId = newTaskId(task.phase);
  const newTask: Task = {
    id: newId,
    runId: task.runId,
    // PRIMARY task (parentId undefined) — runNext.dispatchStep only reuses pending
    // PRIMARY rows, so a parentId-child would be ignored and a fresh task created
    // instead, dropping this retry's context. Lineage is preserved via
    // inputs.previous_failure.failedTaskId + the task.retried event, not parentId.
    phase: task.phase,
    agentRole: task.agentRole,
    // An ad-hoc row dispatches immediately, so its model resolution is resolved
    // now (like invoke does) rather than copied from a stale prior attempt.
    ...(adHoc ? taskModelFields(adHoc.resolution, task.agentAlias) : { agentAlias: task.agentAlias, agentModel: task.agentModel }),
    status: "pending",
    taskPackage: {
      ...task.taskPackage,
      taskId: newId,
      // FG-507/FG-512: stamp provenance UNCONDITIONALLY so a retried row is never
      // re-decided by inference on the next retry. An ad-hoc row IS dispatched by
      // invoke semantics (dispatchRetriedAdHocTask → dispatchInvokeTask), so it
      // records `invoke`; every other row here is a `workflow_step` by construction
      // (planRetryDispatch returns undefined only for that kind, and throws on
      // `unknown`), so it records `workflow` — closing the gap where a marker-less
      // legacy workflow row would otherwise mint a fresh marker-less row.
      dispatchSource: adHoc ? ("invoke" as const) : ("workflow" as const),
      // AWN-3: hand the agent the previous failure as context so the retry is
      // informed. Prose + tag only — never secrets (task.error is a summary,
      // failure_kind is a classifier label).
      inputs: {
        ...task.taskPackage.inputs,
        previous_failure: { kind: failureKind ?? "unknown", error: task.error ?? null, failedTaskId: task.id },
      },
      composedSystemPrompt: adHoc?.composedSystemPrompt ?? "", // re-compose at dispatch
    },
    createdAt: nowIso(),
  };
  insertTask(newTask);
  reapRetainedContainer(task.id);

  logEvent("task.retried", {
    runId: task.runId,
    taskId: task.id,
    payload: {
      newTaskId: newId,
      failure_kind: failureKind ?? null,
      previousError: task.error ?? null,
      forced: !!opts?.force && !disposition.retryable,
      adHoc: !!adHoc,
    },
  });

  return { task, newTask, disposition, ...(failureKind ? { failureKind } : {}), ...(adHoc ? { adHoc } : {}) };
}
