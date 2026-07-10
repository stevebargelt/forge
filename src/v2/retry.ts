// forge retry — preserve the failed task as an audit record; create a new
// task row that inherits the same phase/role/inputs and points back to the
// failed task via parentId. The new task is `pending`; next forge-next
// redispatches it.
//
// This mirrors gate.ts's `request-changes` shape (task → failed, new task
// created with parentId pointing back). Audit trail is preserved on the
// original row; retries form a walkable chain via parentId.
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
import { isAdHocTask } from "./run-kind.js";
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

function invokeCommandFor(task: Task, projectDir: string | undefined, taskText: string | undefined): string {
  const parts = [`forge invoke ${task.agentRole}`, `--run ${task.runId}`];
  if (projectDir) parts.push(`--project ${projectDir}`);
  parts.push(taskText ? `--task '${taskText.replaceAll("'", "'\\''")}'` : `--task '<the original task text — this row never recorded it>'`);
  return parts.join(" ");
}

function planAdHocRedispatch(task: Task, run: Run): AdHocDispatchPlan {
  const dir = taskDir(task.runId, task.id);
  const manifest = readTaskManifest(dir);
  const receipt = manifest?.controlPlane;

  const rawTaskText = task.taskPackage.inputs["task"];
  const taskText = typeof rawTaskText === "string" && rawTaskText.length > 0 ? rawTaskText : undefined;

  const projectDir = receipt?.projectDir ?? run.projectDir;
  // Annotated on the const, not just the arrow, so TS narrows past every call.
  const refuse: (reason: string) => never = (reason) => {
    throw new AdHocRedispatchUnavailableError(task.id, task.runId, reason, invokeCommandFor(task, projectDir, taskText));
  };

  if (!taskText) refuse("its taskPackage carries no `inputs.task` text, so there is no task to hand the agent");
  if (!projectDir) refuse("neither its dispatch receipt nor its run records a projectDir to mount at /project");
  if (!existsSync(projectDir)) refuse(`its recorded projectDir no longer exists on this host (${projectDir})`);

  // #176: an auth-profile invoke that silently re-dispatches WITHOUT the profile
  // lands the agent on an unauthenticated app and produces false "app broken"
  // reports. The manifest records that a profile was requested but not which one;
  // the name lives on the auth.profile_applied event.
  let authProfile: string | undefined;
  if (manifest?.auth?.profileRequested) {
    const applied = eventsForTask(task.id).find((e) => e.eventType === "auth.profile_applied");
    const name = (applied?.payload as { profile?: unknown } | undefined)?.profile;
    if (typeof name !== "string") {
      refuse("it ran with an auth profile whose name was never recorded, and re-dispatching unauthenticated would silently change what the agent sees");
    }
    authProfile = name;
  }

  // Reds get read-only project mounts as an OS-level invariant, not a preference
  // (CLAUDE.md). The receipt records the mount this task actually ran under; with
  // no receipt, fall back to the same `red-` role discriminator runNext.ts uses.
  const readOnlyProject = receipt ? receipt.mountMode === "ro" : task.agentRole.startsWith("red-");

  // The runtime the task actually ran under (FG-366: manifest.runtime.name is the
  // RESOLVED concrete runtime, e.g. "claude-apikey"). In policy mode resolveModel
  // rebinds it from (provider, auth) anyway; in legacy mode it is loaded verbatim.
  const runtimeName = manifest?.runtime?.name;

  // Resolve model + compose the prompt HERE, before the row is inserted: both can
  // throw on a broken policy/agent dir, and a throw before insertTask means no row.
  const resolution = resolveModel({
    agentRole: task.agentRole,
    stepAlias: task.agentAlias,
    cliProfile: undefined,
    runtimeName: runtimeName ?? "claude",
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

  // FG-507: plan the ad-hoc re-dispatch BEFORE any write. planAdHocRedispatch
  // refuses (throws) when the dispatch facts can't be recovered, so the refusal
  // path never inserts the pending row it couldn't have dispatched.
  const run = getRun(task.runId);
  const adHoc = run && isAdHocTask(task, run) ? planAdHocRedispatch(task, run) : undefined;

  // Build a fresh task row — same phase/role/inputs/agentAlias/agentModel, NEW id
  // (so it gets a fresh task dir: no reuse of the failed attempt's result.json or
  // staged auth-state). parentId points back to the failed one for lineage.
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
