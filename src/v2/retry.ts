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
import { getTask, insertTask, tasksForRun } from "../store/tasks.js";
import { getRun } from "../store/runs.js";
import { logEvent, eventsForTask } from "../store/events.js";
import { newTaskId, nowIso } from "../util/ids.js";
import { taskDir } from "../util/paths.js";
import { failureKindForTask } from "./failure-kind.js";
import { publicationAttemptsForTask } from "../store/publications.js";
import { retryPolicy, isReDrivableFailureKind, type RetryDisposition } from "./retry-policy.js";
import {
  fanoutRecommendation,
  reDriveDisposition,
  renderRecommendation,
  type ReDriveDisposition,
} from "./re-drive-eligibility.js";
import { taskDispatchKind } from "./run-kind.js";
import { readTaskManifest } from "./task-manifest.js";
import { composeSystemPrompt } from "./compose.js";
import { resolveSeedGeneration } from "./seed-generation.js";
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

// FG-688: the OTHER misadvising surface, and the one the ticket says an operator
// is actually left with. `forge retry` mints a fresh PRIMARY with parentId unset
// (see the PRIMARY note on the new row below), while adoption is scoped to the
// CURRENT parent — `adoptablePlanItemChildren`'s `t.parentId === parentId`
// filter, the FG-584 RF-3b guard this ticket deliberately does NOT widen. So a
// retried ordered wave cannot reach the old parent's captured, already-integrated
// children: it re-resolves its base from the last publication receipt and re-runs
// every item from scratch. That discard is the whole subject of FG-688 — measured
// on FG-576 at 8 of 9 children already completed and merged into the candidate,
// including a 64-minute build step.
//
// `forge recover <parent> --re-drive` reopens THIS parent row in place, so
// runOrderedWave recomputes readiness and adoption from durable git ancestry at
// the top of every dependency group and dispatches only the items that never
// completed. Refused without --force, mirroring the fanout-CHILD refusal above:
// the operator's explicit override is preserved, because an operator who
// genuinely wants a clean re-run from a fresh parent is entitled to one.
//
// Extends RetryNotAllowedError rather than standing alone as its own Error: the
// `forge retry` CLI already renders that class with its advice line, so this
// refusal reaches the operator as a message instead of a stack trace without
// needing a new catch arm. It IS a retry-policy refusal — a failure kind whose
// forward verb is a different command — so the inheritance is the honest shape,
// not a shortcut.
export class OrderedFanoutParentRetryError extends RetryNotAllowedError {
  constructor(
    public readonly parentTaskId: string,
    public readonly failureKind: string,
  ) {
    super(parentTaskId, {
      retryable: false,
      reason:
        `it is an ORDERED fan-out wave's parent that failed as '${failureKind}', a kind the adopt-preserving re-drive ` +
        `accepts. \`forge retry\` mints a fresh primary with no parentId, and adoption is scoped to the current parent — ` +
        `so the retried wave could not reach this parent's already-captured, already-integrated children, and every ` +
        `completed item would be re-dispatched from scratch`,
      advice:
        `use \`forge recover ${parentTaskId} --re-drive\`, which reopens this parent in place: it adopts the items whose ` +
        `captured commits are already ancestors of the wave's candidate and dispatches only the items that did not complete`,
    });
    this.name = "OrderedFanoutParentRetryError";
  }
}

// FG-688 (build review, finding 1): the redirect above may only be thrown when
// `forge recover <parent> --re-drive` would ACTUALLY be accepted — otherwise it
// bounces the operator between two refusals with no accepted verb named, which is
// the very defect this ticket exists to close.
//
// The first cut tested four things (parent-less, re-drivable kind, has children,
// provably ordered) and consulted neither supersession nor the run's status, while
// the re-drive guard refuses on both — so two concretely reachable states advised
// a verb that immediately refused: a parent superseded by a later primary (minted
// by `forge retry <parent> --force` or `gate request-changes`), and a parent whose
// run was cancelled to `abandoned`.
//
// So the live-state clauses are not restated here: this reads
// `reDriveDisposition`, the SAME predicate the recover surface's recommendation
// and (modulo ordering) performReDrive's own conjunction consult. Two predicates
// drift; one cannot.
export class OrderedWaveReDriveUnavailableError extends RetryNotAllowedError {
  constructor(
    public readonly parentTaskId: string,
    public readonly failureKind: string,
    public readonly reDrive: ReDriveDisposition,
    /** The verb(s) that WILL be accepted, from the same recommendation builder the
     *  `forge recover` surface prints — never `--re-drive`, which would refuse. */
    public readonly recommendationCommands: string[],
    recommendationLine: string,
  ) {
    super(parentTaskId, {
      retryable: false,
      reason:
        `it is an ORDERED fan-out wave's parent that failed as '${failureKind}', and the adopt-preserving ` +
        `\`forge recover ${parentTaskId} --re-drive\` — the verb that would keep this wave's already-integrated children — ` +
        `would REFUSE it right now: ${reDrive.why}. A plain retry mints a fresh primary with no parentId, and adoption is ` +
        `scoped to the current parent, so every completed item would be re-dispatched from scratch`,
      advice:
        `run ${recommendationLine}; or, to mint that fresh primary anyway and accept the discard, ` +
        `\`forge retry ${parentTaskId} --force\``,
    });
    this.name = "OrderedWaveReDriveUnavailableError";
  }
}

/** FG-688: the re-drive guard's answer for `task`, or undefined when `task` is not
 *  an ORDERED fan-out wave's parent the redirect has anything to say about.
 *
 *  The clauses that gate the LOOKUP (as opposed to the answer) are here, and each
 *  rules out a case where consulting the re-drive at all would be wrong:
 *   - parent-less with children: the same shape `recover.ts`'s `isFanoutParent`
 *     tests. A fanout CHILD is caught by FanoutChildRetryError above; an ordinary
 *     primary is not a wave at all.
 *   - an accepted failure kind: the ONE shared enumeration the re-drive's mutation
 *     guard consults. Fails closed on an unrecognized kind, so a kind from a future
 *     build routes to the ordinary retry policy rather than to either refusal.
 *   - provably ordered: read off the parent's durable `integration.worktree_created`
 *     evidence, via the disposition's own `ordered` field. This is what keeps the
 *     pre-existing UNORDERED `fanout_wave_orphaned` refusal untouched — an unordered
 *     wave never carries `ordered: true`, so it falls through to retry-policy.ts's
 *     entry exactly as before. */
function orderedWaveReDriveDisposition(task: Task, run: Run | undefined, failureKind: string | undefined): ReDriveDisposition | undefined {
  if (task.parentId !== undefined) return undefined;
  if (!isReDrivableFailureKind(failureKind)) return undefined;
  const allTasks = tasksForRun(task.runId);
  if (!allTasks.some((t) => t.parentId === task.id)) return undefined;
  const disposition = reDriveDisposition(task, allTasks, run, failureKind);
  return disposition.ordered ? disposition : undefined;
}

/** FG-425 (AC5): this task's candidate is ALREADY on the publish target — a durable
 *  attempt records the CAS that landed it. A retry re-runs the agent and publishes
 *  again, so it is refused with the fact that makes it refusable: the published SHA.
 *  --force is deliberately NOT an override here. There is no "retry it anyway" reading
 *  of published work: to build on it, dispatch new work; to undo it, that is a git
 *  operation on the target, not a forge retry. */
export class PublishedTaskRetryError extends Error {
  constructor(public taskId: string, public attemptId: string, public publishedSha: string) {
    super(
      `Task ${taskId} has ALREADY published its work to the target (attempt ${attemptId}, published ` +
        `${publishedSha.slice(0, 12)}). Retrying would re-dispatch the agent and publish a second time — the target ` +
        `already carries this task's candidate. Inspect it with \`forge show ${taskId}\`; if the published work needs ` +
        `changing, dispatch new work on top of it rather than re-running a publication that succeeded.`,
    );
    this.name = "PublishedTaskRetryError";
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
  /** FG-654: the stamp the compose above resolved, carried to the retried row's package
   *  so its manifest records the protocol THIS prompt was built from. */
  agentProtocol?: { role: string; sha256: string; source: string };
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
  // FG-654: a retry RE-VERIFIES against today's required protocol and re-stamps; it never
  // replays the original task's stamp. A retry after a `forge upgrade` genuinely runs a
  // different protocol, and replaying the old sha would make the ledger lie in exactly the
  // direction this ticket exists to prevent. Refused BEFORE any row is written, like every
  // other precondition here.
  // A retry is its own short-lived invocation with nothing anchored, so it resolves the
  // live seed pointer once, here, and composes under exactly that generation.
  const composed = composeSystemPrompt({
    role: task.agentRole,
    workflow,
    step,
    seedGeneration: resolveSeedGeneration(),
  });
  if (!composed.ok) refuse(composed.refusal);
  const composedSystemPrompt = composed.prompt;

  return {
    projectDir,
    readOnlyProject,
    taskText,
    composedSystemPrompt,
    ...(composed.ok && composed.protocol ? { agentProtocol: composed.protocol } : {}),
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

  // FG-425 (AC5) RETRY SAFETY, and it is checked FIRST — before the status rule, which
  // would otherwise refuse a published task with a generic "not failed, gate instead"
  // that says nothing about the reason that actually matters. A durable `published`
  // attempt means this task's candidate LANDED on the target through a CAS: retrying
  // re-dispatches the agent and publishes a second time, duplicating work already in
  // the target's history. The publisher is idempotent per TASK, but a retry mints a NEW
  // task id, so that guard can never see this one; the refusal has to live here, where
  // the lineage is still visible.
  const published = publicationAttemptsForTask(taskId).find((a) => a.state === "published");
  if (published) {
    throw new PublishedTaskRetryError(taskId, published.attemptId, published.publishedSha ?? "");
  }

  if (task.status !== "failed") {
    // FG-425 (AC5): awaiting_recovery names itself. A generic "not failed, gate or
    // submit instead" would send the operator looking for a gate that does not exist,
    // on a task whose candidate may already be on the target.
    if (task.status === "awaiting_recovery") {
      throw new Error(
        `Task ${taskId} lost the publication window AFTER its target-ref advance landed — its work may ALREADY be ` +
          `published, so a retry would publish it twice. The disposition is not settled yet and forge will not guess ` +
          `at one. Run \`forge next ${task.runId}\` (AD-5 convergence + reconciliation), or ` +
          `\`forge publish recover <attemptId>\` to converge it by hand; \`forge show ${taskId}\` names the attempt.`,
      );
    }
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

  // Read here rather than just before planRetryDispatch below: the FG-688 redirect
  // needs the run row too — its status is one of the live-state clauses the
  // re-drive guard enforces — and one read serves both.
  const run = getRun(task.runId);

  // FG-688: checked BEFORE the generic policy refusal below, so an ordered wave
  // parent gets the message that names its actual forward verb rather than the
  // kind's generic advice. This matters in both directions: `prerequisite_blocked`
  // is retryable:true and would otherwise sail straight through to minting the
  // discarding primary, while `integration_blocked` is retryable:false and would
  // otherwise refuse with per-kind advice that says nothing about the captured
  // items sitting in the candidate.
  //
  // Build-review finding 1: WHICH refusal depends on the same live state the
  // re-drive guard reads. Eligible -> point at `--re-drive`, the verb that adopts
  // the captured children. Ineligible (superseded, or a run no recovery verb
  // reopens) -> point at whatever the shared recommendation names instead, so the
  // operator is never handed a verb that will refuse. `--force` still proceeds
  // through BOTH: an operator who wants the fresh-primary discard is entitled to it.
  // The `!== undefined` is TS narrowing for the throw, not a second policy check:
  // isReDrivableFailureKind already refuses `undefined` (it fails closed), so this
  // can never widen what the guard accepts.
  const reDrive = failureKind !== undefined ? orderedWaveReDriveDisposition(task, run, failureKind) : undefined;
  if (reDrive && failureKind !== undefined && !opts?.force) {
    if (reDrive.eligible) throw new OrderedFanoutParentRetryError(taskId, failureKind);
    const recommendation = fanoutRecommendation(task, reDrive, failureKind);
    throw new OrderedWaveReDriveUnavailableError(
      taskId,
      failureKind,
      reDrive,
      recommendation.commands,
      renderRecommendation(recommendation),
    );
  }

  if (!disposition.retryable && !opts?.force) {
    throw new RetryNotAllowedError(taskId, disposition);
  }

  // FG-507: decide ad-hoc vs workflow-step, and plan the ad-hoc re-dispatch,
  // BEFORE any write. Both refusals (dispatch facts unrecoverable; the workflow
  // that would answer the question won't load) throw here, so neither ever
  // inserts the pending row it could not have dispatched. This is the ONE place
  // taskDispatchKind's `unknown` is interpreted.
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
  // FG-654: the stamp is RE-RESOLVED by this retry's own compose above (ad-hoc), or cleared
  // for a workflow row that re-composes at dispatch. Never inherited from the failed
  // attempt: a `forge upgrade` between the two makes the original sha a statement about a
  // prompt this row does not carry, which is the ledger lying in the exact direction this
  // ticket exists to prevent.
  delete newTask.taskPackage.agentProtocol;
  if (adHoc?.agentProtocol) newTask.taskPackage.agentProtocol = adHoc.agentProtocol;
  insertTask(newTask);
  // FG-585: recovery must not WEDGE. A run that already settled terminal
  // (complete or, post-FG-585, failed) has to return to active so `forge next`
  // will dispatch this fresh primary — `forge next` refuses a terminal run.
  // No-op when the run is still active; the ad-hoc path reactivates again at
  // dispatch (harmless). Abandoned reactivation matches the pre-existing ad-hoc
  // retry behavior (explicit operator retry is authoritative over a cancel).
  if (run) reactivateTerminalRun(task.runId, run.status, "retry");
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
