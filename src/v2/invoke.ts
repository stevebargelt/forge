// forge v2 — invoke: dispatch a single agent against a freeform task.
//
// This is the primary primitive for the RACI-driven orchestrator pattern:
// most user requests resolve to one or two `forge invoke` calls. The pipeline
// (`forge new feature`) is reserved for implementation work.
//
// Behavior:
// - Loads the runtime (detects from env or accepts an override)
// - Composes the agent's system prompt (CLAUDE.md + constraints + freeform task framing)
// - Spawns one container via the existing v2 spawn machinery
// - Writes a task row to SQLite (visible in dashboard)
// - If --run-id is unset, creates a synthetic 1-task run with workflow name 'invoke'
// - Returns the parsed result.json
//
// What this does NOT handle (deliberately, see DECISIONS.md):
// - No depends_on linkage; orchestrator chains by passing prior results into next task text
// - No fanout; orchestrator parallelizes via multiple Bash forge invoke calls
// - No reds; reds are themselves invoke targets, dispatched by the orchestrator
// - No gate concept; agent completes or fails

import { existsSync, mkdirSync, writeFileSync, readFileSync, chmodSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, sep } from "node:path";
import type { Task, TaskPackage, Run } from "../types/index.js";
import type { Workflow, Step, Runtime } from "./schema.js";
import { resolveRuntimeMetadata } from "./schema.js";
import { analyzeProviderFailure } from "./provider-failure.js";
import { insertTask, markTaskRunning, markTaskComplete, tasksForRun, getTask } from "../store/tasks.js";
import { failTask, classify, ORPHAN_EVIDENCE_KINDS } from "./failure-kind.js";
import type { FailureKind, OrphanEvidence, ContainerCausalEvidence } from "./failure-kind.js";
import { attachedExitEvidence } from "./reconcile.js";
import { checkResultPersistence, persistenceErrorMessage } from "./persistence-check.js";
import { captureUsageForTask } from "../store/model-calls.js";
import { insertRun, getRun, updateRunStatus } from "../store/runs.js";
import { finalizeRunIfSettled } from "./run-finalize.js";
import { classifyRunTerminalState } from "./ready-queue.js";
import { logEvent } from "../store/events.js";
import { taskDir } from "../util/paths.js";
import { resolvePolicyPath, describeNoEffectiveHostPolicy } from "../raci/project.js";
import { validateRouteKeyUnder } from "../cli/route-preflight.js";
import { explainRouteFile } from "../cli/commands/route.js";
import { resolveIdleTimeoutMs, IDLE_TIMEOUT_EXIT_CODE } from "./idle-watchdog.js";
import { DEPENDENCY_PROVISIONING_FAILED_EXIT_CODE } from "./dependency-provisioning.js";
import { productionDockerExec, finalizeContainerRetention, type DockerExecArgs, type DockerExecFn } from "./docker-exec.js";
import { composeSystemPrompt } from "./compose.js";
import { STALE_PROTOCOL_FAILURE_KIND } from "./agent-protocol.js";
import { buildDockerArgs, preflightProjectMount, GIT_UNAVAILABLE_EXIT_CODE, type SpawnContext } from "./spawn.js";
import { loadRuntimeWithSource, loadModelPolicyWithSource } from "./loader.js";
import { resolveSeedGeneration, type SeedGeneration } from "./seed-generation.js";
import { resolveModel, taskModelFields, manifestModelBlock, type ModelResolution } from "./model-resolution.js";
import { checkResolvedAvailability, checkToolCapability } from "./provider-doctor.js";
import { newRunId, newTaskId } from "../util/ids.js";
import { resolveAuthStateForContainer, AuthProfileError, cleanupStagedAuth } from "./auth-state.js";
import { loadProjectAuthProfile, resolveProjectAuthForContainer, ProjectAuthError } from "./project-auth.js";
import { writeTaskManifest, manifestControlPlaneBlock } from "./task-manifest.js";
import { loadAllConstraints, filterConstraints } from "./constraints.js";
import { resolveDocsSurfacesReceipt } from "./contract.js";
import { emitAgentProgressEvents } from "./agent-progress.js";
import { inferredResultFrom } from "./inferred-result.js";
import { assertSelfHostDispatchAllowed } from "./self-host-guard.js";
import { recoverStructuredStreamResult } from "./stream-result-recovery.js";

export type InvokeArgs = {
  agentRole: string;
  task: string;
  projectDir: string;
  designDir?: string;
  modelAlias?: string;       // override the step's model alias
  modelProfile?: string;     // AWN-7: --profile, the top profile-selection precedence (policy mode)
  runtimeName?: string;      // override the runtime to load (default: "claude")
  readOnlyProject?: boolean; // mount /project ro (default: false)
  authProfile?: string;      // #176: name of a captured auth profile to inject (authenticated browser testing)
  runId?: string;            // attach to existing run; if absent, create a new one
  runTitle?: string;         // used only when creating a new run
  /** The orchestrator's home directory. When set, `forge status` filters
   *  this run into the current-workspace view even if projectDir points
   *  elsewhere (audit-workspace pattern: workspace=~/code/audit-workspace,
   *  projectDir=~/code/audit-workspace/repos/team-payments). Defaults at
   *  the CLI layer to cwd. */
  workspace?: string;
  /** FG-350: resolved route key (from `forge route explain`), recorded in the
   *  control-plane receipt so explain views can show dispatch-time routing. */
  routeKey?: string;
  /** FG-374: directory forge was invoked from (recorded in the control-plane
   *  receipt; may differ from projectDir when resolved up from a subdir). */
  invocationCwd?: string;
  /** FG-374: true when projectDir was resolved up from a monorepo subdir. */
  resolvedFromSubdir?: boolean;
  /** FG-374: true when --allow-subproject was passed to intentionally mount a subdir. */
  explicitSubproject?: boolean;
  /** FG-639: extra input files to materialize INSIDE the task dir before the container
   *  starts, keyed by path relative to it (`fix-batch/payload.json` →
   *  `/task/fix-batch/payload.json`). The task dir is already the package delivery
   *  channel — CLAUDE.md, package.md and result.json ride the same rw bind — so a
   *  caller with a host artifact the agent must read delivers it here rather than
   *  naming a host path no mount carries. */
  taskFiles?: Record<string, string>;
  /** FG-563 (CP2, F17 receipt bridge): the deterministic continuation dispatch_key
   *  this invocation is the physical dispatch OF. Stamped into the created run's
   *  metadata BEFORE the container spawns, so runByDispatchKey adopts this exact run
   *  on a recovery instead of duplicating it. Only honored when invoke OWNS the run
   *  (no --run attach) — an attached run already has its identity. */
  dispatchKey?: string;
  // Injected for tests; real callers leave undefined → docker is used.
  dockerExec?: DockerExecFn;
};

export type InvokeResult = {
  runId: string;
  taskId: string;
  status: "complete" | "failed";
  result?: unknown;
  error?: string;
  /** FG-513: the classified FailureKind for a failed dispatch, when one was
   *  determined at the failure site (e.g. "model_error", "idle_timeout",
   *  "container_crash"). Lets in-process callers (review-loop's same-round
   *  reviewer retry) react to the KIND without re-reading the task's event
   *  stream. Absent on success and on failure paths that don't classify
   *  in-hand (e.g. a lost CAS race to a concurrent cancel). */
  failureKind?: string;
};

// FG-503: wraps finalizeContainerRetention for every call site where the task
// genuinely succeeded (or a lost CAS race still leaves it complete) — a
// "reap_failed" outcome there is a silent, unsweepable leak (docker rm errored;
// container + DEC-019 shadow volume left behind), so it's recorded as a durable
// event `forge ops reap-containers` can later pick up by age. The reaped/
// retained outcomes stay exactly as silent as before FG-503.
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

export async function invoke(args: InvokeArgs): Promise<InvokeResult> {
  // FG-612: refuse a self-host dispatch BEFORE the run or task row exists.
  // Covers `forge invoke` and the review-loop's reviewer/fixer dispatches, which
  // both land here. "never-isolated" is the literal truth of this file: nothing
  // below provisions a workspace, so the live projectDir is mounted even where
  // FG-345's default resolves isolation ON.
  assertSelfHostDispatchAllowed(args.projectDir, "never-isolated");

  // Resolve / create the run.
  const runId = args.runId ?? createInvokeRun(args.agentRole, args.projectDir, args.designDir, args.runTitle, args.workspace, args.dispatchKey);
  const run = getRun(runId);
  if (!run) throw new Error(`invoke: run not found: ${runId}`);

  const ownsRun = args.runId === undefined;

  if (!ownsRun) reactivateTerminalRun(runId, run.status, "invoke");

  // FG-583: anchor the seed generation ONCE at invoke entry so task-create-time
  // model stamping (resolveModel below) and the dispatching container
  // (dispatchInvokeTask) resolve the SAME complete generation.
  const seedGeneration = resolveSeedGeneration();

  // FG-583 (finding 3): when a route key was resolved for this dispatch, re-validate
  // it under the SAME anchored generation the dispatch uses — not the LIVE policy the
  // CLI preflight already checked. A concurrent `forge upgrade` promoting a new
  // generation between the live preflight and this anchor would otherwise let a route
  // validated only under the old generation dispatch under the new one. Refuse and
  // direct re-resolution rather than route a receipt from a policy this dispatch was
  // never validated against.
  if (args.routeKey !== undefined) {
    const anchored = validateRouteKeyUnder(args.routeKey, args.projectDir, seedGeneration);
    if (!anchored.ok) {
      throw new Error(
        `forge invoke: route "${args.routeKey}" is not valid under the seed generation this dispatch anchored ` +
          `(a promotion may have interleaved since route resolution) — ${anchored.message}. ` +
          `Re-resolve the route and retry: forge route explain <route-key> --json`,
      );
    }
  }

  const { step, workflow } = invokeWorkflowShape(args.agentRole, args.modelAlias, args.runtimeName);

  // Use the agent role for the id (e.g. task-test-engineer-ab12cd), not the
  // literal phase "task" — newTaskId already prefixes "task-", so passing "task"
  // produced the doubled "task-task-..." id. The row's phase stays "task".
  const taskId = newTaskId(args.agentRole);
  const composed = composeSystemPrompt({
    role: args.agentRole,
    workflow,
    step,
    seedGeneration,
  });
  const taskPackage: TaskPackage = {
    taskId,
    runId,
    phase: "task",
    role: args.agentRole,
    inputs: { task: args.task } as Record<string, unknown>,
    // FG-507: dispatch provenance, recorded once at creation so `forge retry`
    // never has to infer it. Both invoke shapes pass through here — the synthetic
    // `invoke` run and `--run <real-workflow-run>`. renderInvokeTaskPackage reads
    // only taskId/runId/role/inputs, so this stays inert in what the agent sees.
    dispatchSource: "invoke",
    // FG-654: on a refusal this is the refusal text, never a prompt. No container
    // starts, so it is never delivered — it is the row's durable record of WHY.
    composedSystemPrompt: composed.ok ? composed.prompt : composed.refusal,
    // FG-654: carried from THIS compose, never re-read at manifest-write time. The
    // manifest is written later inside dispatchInvokeTask (after model resolution, mount
    // preflight and docker-arg construction); a `forge upgrade` landing in that window
    // would otherwise stamp a generation this prompt was not composed under.
    ...(composed.ok && composed.protocol ? { agentProtocol: composed.protocol } : {}),
  };

  // AWN-7: resolve the model (capability + profile) before inserting the row, so
  // the task carries its resolution record and the spawn uses the bound runtime.
  const resolution = resolveModel({
    agentRole: args.agentRole,
    stepAlias: args.modelAlias,
    cliProfile: args.modelProfile,
    runtimeName: args.runtimeName ?? "claude",
    ctx: { projectDir: args.projectDir },
    seedGeneration,
  });

  // Insert task row first; the spawn writes files into the task dir and the
  // dashboard / forge status reads the row.
  const task: Task = {
    id: taskId,
    runId,
    phase: "task",
    agentRole: args.agentRole,
    ...taskModelFields(resolution, args.modelAlias),
    status: "pending",
    taskPackage,
    createdAt: new Date().toISOString(),
  };
  insertTask(task);
  // invoke is forge's main orchestrator primitive; its timelines must start at
  // task.created, not task.started — matching the pipeline path (runNext).
  logEvent("task.created", { runId, taskId });

  // FG-654: the row exists so the refusal is durable and addressable (the review
  // ledger records this taskId against the lens), and nothing is dispatched. The
  // failureKind rides the result as a free string — review-wiring maps it onto the
  // `stale_protocol` discovery reason, which an operator lens acceptance may not clear.
  if (!composed.ok) {
    failTask(taskId, { runId, kind: classify({}), error: composed.refusal });
    return { runId, taskId, status: "failed", error: composed.refusal, failureKind: STALE_PROTOCOL_FAILURE_KIND };
  }

  return dispatchInvokeTask({
    task,
    resolution,
    projectDir: args.projectDir,
    taskText: args.task,
    ownsRun,
    modelAlias: args.modelAlias,
    designDir: args.designDir,
    readOnlyProject: args.readOnlyProject,
    authProfile: args.authProfile,
    routeKey: args.routeKey,
    invocationCwd: args.invocationCwd,
    resolvedFromSubdir: args.resolvedFromSubdir,
    explicitSubproject: args.explicitSubproject,
    taskFiles: args.taskFiles,
    seedGeneration,
    dockerExec: args.dockerExec,
  });
}

// #201: attaching a task to a run whose status already went terminal (a prior
// invoke closed it, or it was abandoned) must bring the run back to active — a
// run with a live task is not complete. Only the attach path can hit this; the
// owns-run path created a fresh active run. Before the fix the live task was
// invisible (dashboard / forge status list by run status), so a churning
// container looked like "nothing running".
// FG-507: `forge retry` on an ad-hoc task attaches to the failed task's run the
// same way, and hits the same trap.
export function reactivateTerminalRun(runId: string, status: Run["status"], source: string): void {
  if (status !== "complete" && status !== "abandoned" && status !== "failed") return;
  updateRunStatus(runId, "active");
  logEvent("run.reactivated", { runId, payload: { source, from: status } });
}

// The synthetic single-step workflow + step invoke dispatches against. The runner
// machinery (compose, spawn) takes Workflow + Step types; for invoke we create
// minimal ones in-memory rather than loading from YAML. The runner's heavy step
// lifecycle (depends_on, gates, reds) isn't exercised here.
export function invokeWorkflowShape(
  agentRole: string,
  modelAlias: string | undefined,
  runtimeName: string | undefined,
): { step: Step; workflow: Workflow } {
  const step: Step = {
    id: "task",                           // synthetic phase id; matches v1 single-task runs
    agent: agentRole,
    activity: modelAlias,                 // capability alias (CLI --model); legacy field name was `model`
    runtime: runtimeName ?? "claude",
    depends_on: [],
    gate: "auto",
    manual: false,
    reds: [],
    // FG-497: do NOT embed the task text here — workflow_additions folds into the
    // composed system prompt, which every claude/pi runtime passes as a single
    // argv string (--append-system-prompt), capped by Linux's 128KB
    // MAX_ARG_STRLEN. A large task (e.g. a >120KB review-loop packet) blew past
    // that limit and crashed the container exec with E2BIG before the agent even
    // started. The task reaches the agent instead via TASK_PACKAGE_MARKDOWN,
    // piped over stdin (unbounded) — see renderInvokeTaskPackage below.
    workflow_additions:
      `You are receiving a single freeform task. The task description arrives as ` +
      `your input message (the task package). Read it carefully and produce a result.\n`,
  };
  return {
    step,
    workflow: {
      name: "invoke",
      description: "Single-agent invocation (forge invoke)",
      // FG-640: an ad-hoc invoke has no review ledger and no reviewed step, so it carries the
      // legacy authority model. Naming it beats inheriting it silently.
      review_mode: "legacy_verdict",
      inputs: [],
      steps: [step],
    },
  };
}

// FG-639: the task dir's OWN artifacts. A taskFiles key that lands on one of these
// overwrites the delivery channel it rides on (the composed prompt, the package, the
// result the host reads back) or takes a name a later write needs — so it is refused
// rather than resolved in favor of whoever wrote last. Matched case-insensitively
// because the host filesystem is APFS on the Mac these run from.
//
// EVERY ARTIFACT THE HOST READS BACK OUT OF THE TASK DIR BELONGS HERE, not just the ones
// forge writes on the way in. `progress.jsonl` was the omission: the host reads it after exec
// and emits one task.progress / task.artifact / task.decision event per record, ATTRIBUTED TO
// THE AGENT (see emitAgentProgressEvents in agent-progress.ts), and it is copied verbatim
// into support bundles. A caller that could pre-write it could forge agent-authored timeline
// records for an agent that never wrote one — which is the trust boundary this list is sold
// as defending, so an omission from it is a hole regardless of what today's one caller passes.
const RESERVED_TASK_ARTIFACTS = [
  "claude.md",
  "package.md",
  "result.json",
  "progress.jsonl",
  "detached-entry.sh",
  "detached-stdin",
  "manifest.json",
];

// The longest single path segment most host filesystems accept. A longer basename makes
// writeFileSync throw ENAMETOOLONG mid-loop, which is a crash rather than a refusal.
const MAX_SEGMENT_BYTES = 255;

function isReservedTaskArtifact(segment: string): boolean {
  const lower = segment.toLowerCase();
  return RESERVED_TASK_ARTIFACTS.includes(lower) || (lower.startsWith("container.") && lower.endsWith(".log"));
}

/** FG-639: confine taskFiles to the task dir. Screened at the invoke layer — the one
 *  chokepoint every caller passes through — so a future caller inherits the confinement
 *  instead of re-deriving it. Pure and total: it decides from the keys alone, so the
 *  refusal happens before the task dir exists and nothing is written on the way to it.
 *  Returns the named refusal, or undefined when every key is a plain relative file path
 *  inside the task dir and clear of its reserved artifacts.
 *
 *  TOTAL AND INJECTIVE FOR EVERY KEY IT ADMITS, which the confinement screens alone did not
 *  make it. Confinement said nothing about keys the write loop cannot execute (a NUL byte →
 *  ERR_INVALID_ARG_VALUE, an overlong segment → ENAMETOOLONG) or cannot execute
 *  unambiguously (two distinct map keys that join to ONE target, or one key needing as a
 *  directory the name another key writes as a file → EEXIST). Every one of those threw from
 *  the middle of the loop, AFTER the task dir and its own artifacts had landed and BEFORE
 *  markTaskRunning — an unhandled rejection with no named refusal, a pending task row and an
 *  active run. So they are screened HERE, from the keys, where a refusal still costs nothing. */
export function taskFilesRefusal(taskFiles: Record<string, string> | undefined): string | undefined {
  const targets = new Map<string, string>();
  const fileTargets = new Set<string>();
  const parentTargets = new Map<string, string>();

  for (const rel of Object.keys(taskFiles ?? {})) {
    if (rel.trim() === "") {
      return `taskFiles: an empty key names no file — keys are paths relative to the task dir.`;
    }
    if (rel.includes("\0")) {
      return `taskFiles key ${JSON.stringify(rel)}: a NUL byte is not a path — refused.`;
    }
    if (isAbsolute(rel)) {
      return `taskFiles key "${rel}": absolute paths are refused — keys are relative to the task dir.`;
    }
    const segments = normalize(rel)
      .split(sep)
      .flatMap((s) => s.split("/"))
      .filter((s) => s !== "" && s !== ".");
    if (segments.length === 0) {
      return `taskFiles key "${rel}": resolves to the task dir itself, not to a file in it — refused.`;
    }
    if (segments.includes("..")) {
      return `taskFiles key "${rel}": resolves outside the task dir — refused.`;
    }
    if (rel.endsWith("/") || rel.endsWith(sep)) {
      return `taskFiles key "${rel}": names a directory, not a file — refused.`;
    }
    const over = segments.find((s) => Buffer.byteLength(s, "utf8") > MAX_SEGMENT_BYTES);
    if (over !== undefined) {
      return (
        `taskFiles key "${rel}": the path segment "${over.slice(0, 40)}…" is ` +
        `${Buffer.byteLength(over, "utf8")} bytes, over the ${MAX_SEGMENT_BYTES}-byte limit the filesystem ` +
        `accepts — refused.`
      );
    }
    const top = segments[0] as string;
    if (isReservedTaskArtifact(top)) {
      return `taskFiles key "${rel}": collides with the reserved task artifact "${top}" — refused.`;
    }

    // INJECTIVITY. `fix-batch/payload.json` and `fix-batch/./payload.json` are two map keys
    // over one target: writing both silently lets whichever came last win, with no refusal
    // and no way to tell afterwards which bytes the agent read.
    const target = segments.join("/");
    const clash = targets.get(target);
    if (clash !== undefined) {
      return (
        `taskFiles keys "${clash}" and "${rel}": two keys name the ONE file ${target} — refused rather than ` +
        `resolved in favor of whichever was written last.`
      );
    }
    targets.set(target, rel);

    // And a name cannot be both a file and a directory. mkdirSync throws EEXIST for
    // {"a": …, "a/b": …} in one loop order and writeFileSync throws EISDIR in the other.
    fileTargets.add(target);
    for (let i = 1; i < segments.length; i++) {
      parentTargets.set(segments.slice(0, i).join("/"), rel);
    }
  }

  for (const [dir, needer] of parentTargets) {
    if (fileTargets.has(dir)) {
      return (
        `taskFiles keys "${targets.get(dir) as string}" and "${needer}": ${dir} would have to be both a file ` +
        `and a directory — refused.`
      );
    }
  }
  return undefined;
}

export type DispatchInvokeTaskArgs = {
  /** An already-inserted PENDING row whose taskPackage.composedSystemPrompt is set. */
  task: Task;
  resolution: ModelResolution;
  projectDir: string;
  /** The freeform task text (task.taskPackage.inputs.task). */
  taskText: string;
  ownsRun: boolean;
  modelAlias?: string;
  designDir?: string;
  readOnlyProject?: boolean;
  authProfile?: string;
  routeKey?: string;
  invocationCwd?: string;
  resolvedFromSubdir?: boolean;
  explicitSubproject?: boolean;
  /** FG-639: see InvokeArgs.taskFiles. Written into the task dir before the container
   *  starts, so the agent finds them under /task at the path the prompt names. */
  taskFiles?: Record<string, string>;
  /** FG-583: the seed generation anchored at invoke entry. Threaded so the runtime
   *  (and any generation-coupled load) reads ONE complete generation for the life of
   *  this dispatch. `undefined` (e.g. the `forge retry` caller) → resolve the live
   *  pointer once here. */
  seedGeneration?: SeedGeneration | null;
  dockerExec?: DockerExecFn;
};

// FG-507: the spawn → result-ingestion → run-finalization half of `invoke`,
// against a task row that already exists. `forge invoke` calls it right after
// minting its row; `forge retry` calls it against the lineage-linked row it
// mints for a retried ad-hoc task, which the workflow ready queue would never
// dispatch. ONE dispatch path, so the two can't drift on the result.json
// contract, the event sequence, or run finalization.
export async function dispatchInvokeTask(args: DispatchInvokeTaskArgs): Promise<InvokeResult> {
  const { task, resolution } = args;
  // FG-583: use the anchor resolved at invoke entry (or resolve once here for the
  // `forge retry` caller). ONE complete generation for the life of this dispatch,
  // even if a promotion swaps the seed pointer mid-run.
  const seedGeneration = args.seedGeneration !== undefined ? args.seedGeneration : resolveSeedGeneration();
  const taskId = task.id;
  const runId = task.runId;
  const agentRole = task.agentRole;
  const taskPackage = task.taskPackage;

  // Run status is a derived property: a run is "active" iff it has a
  // non-terminal top-level task. Close to "complete" only when no top-level
  // task is still in flight — so a parallel sibling invoke under the same run
  // (e.g. reds launched together) keeps the run active until the last one
  // finishes. This supersedes #157's "attached invoke never closes the run":
  // that left attached runs leaked-active with nothing to close them. Applies
  // to owned AND attached runs; the owns-run case still closes its lone task.
  //
  // FG-585: the shared classifier decides the terminal state for the invoke run
  // shape (no workflow steps → it reads the top-level tasks). A settled invoke
  // run whose task(s) ended `failed` closes as `failed`, not a false `complete`.
  // Returns null while any top-level task is still non-terminal (a parallel
  // sibling invoke under the same run keeps it active until the last finishes).
  const closeRunIfIdle = (succeeded: boolean): void => {
    const classification = classifyRunTerminalState(undefined, tasksForRun(runId));
    if (!classification) return;
    // finalizeRunIfSettled re-reads the run and only writes when it's still
    // "active" — a no-op (false, no write, no event) when it's already
    // terminal (idempotent close) or abandoned (a concurrent `forge cancel`
    // won the race; its cancellation is authoritative and must not be
    // flipped back, AWN-2/FG-484).
    finalizeRunIfSettled(runId, classification.status, "invoke", {
      source: "invoke",
      succeeded,
      owned: args.ownsRun,
    });
  };

  // FG-612: the pre-container chokepoint for callers that reach
  // dispatchInvokeTask without passing through invoke() (`forge retry`). It sits
  // at the FIRST point where projectDir is known — before the task dir, the
  // manifest, auth staging and buildDockerArgs — so a refused retry is pre-WRITE,
  // matching the other four entry points. Refusing after the first file lands
  // defeats the property the guard exists for.
  try {
    assertSelfHostDispatchAllowed(args.projectDir, "never-isolated");
  } catch (e) {
    const error = (e as Error).message;
    failTask(taskId, { runId, kind: classify({}), error });
    closeRunIfIdle(false);
    return { runId, taskId, status: "failed", error };
  }

  // FG-639: the taskFiles confinement sits at the same pre-WRITE chokepoint. A key that
  // escapes the task dir or takes a reserved artifact's name is refused here, before the
  // dir is created and before any container starts — so a refused delivery leaves nothing
  // on disk to reason about.
  const filesRefusal = taskFilesRefusal(args.taskFiles);
  if (filesRefusal !== undefined) {
    failTask(taskId, { runId, kind: classify({}), error: filesRefusal });
    closeRunIfIdle(false);
    return { runId, taskId, status: "failed", error: filesRefusal };
  }

  // FG-583: no per-consumer seed-state gating. The runtime/workflow/policy loads
  // below reach the seed surface through the loader's single resolve point, which
  // refuses (named, repairable) when no complete generation is published — the
  // loadRuntimeWithSource try/catch below turns that into a failed task with the
  // loader's message. A torn/incomplete/absent generation never dispatches.

  // Materialize the task dir.
  //
  // FG-639: the taskFiles loop is the one part of this that runs on caller-supplied names, so
  // it is the one part that can fail for a reason the guard above did not decide. The guard is
  // now total for the keys it admits, which makes this catch a backstop rather than the
  // mechanism — but a backstop that matters: without it the throw escaped as an unhandled
  // rejection AFTER the dir and its artifacts had landed and BEFORE markTaskRunning, leaving a
  // pending task row and an active run with no named refusal anywhere. Removing the dir is
  // what keeps the guard's "nothing was written" true for an admitted key too.
  const dir = taskDir(runId, taskId);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "CLAUDE.md"), taskPackage.composedSystemPrompt);
    writeFileSync(join(dir, "package.md"), renderInvokeTaskPackage(taskPackage, args.taskText));
    writeFileSync(join(dir, "result.json"), "");
    for (const [rel, contents] of Object.entries(args.taskFiles ?? {})) {
      const target = join(dir, rel);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, contents);
    }
    chmodSync(dir, 0o777);
  } catch (e) {
    const error =
      `the task dir could not be materialized (${(e as Error).message}) — the dispatch is refused and the ` +
      `partial task dir was removed. No container started.`;
    rmSync(dir, { recursive: true, force: true });
    failTask(taskId, { runId, kind: classify({}), error });
    closeRunIfIdle(false);
    return { runId, taskId, status: "failed", error };
  }

  markTaskRunning(taskId);
  logEvent("task.started", { runId, taskId });

  // Load runtime + build docker args. loadRuntimeWithSource captures the
  // provenance (host vs project override) for the FG-350 control-plane receipt.
  let runtime: Runtime;
  let runtimeSource: "host" | "project";
  let runtimePath: string;
  let runtimeName: string;
  try {
    const runtimeLoaded = loadRuntimeWithSource(resolution.runtime, { projectDir: args.projectDir, seedGeneration });
    runtime = runtimeLoaded;
    runtimeSource = runtimeLoaded.source;
    runtimePath = runtimeLoaded.path;
    runtimeName = runtimeLoaded.name;
  } catch (e) {
    const error = `loadRuntime failed: ${(e as Error).message}`;
    failTask(taskId, { runId, kind: classify({}), error });
    closeRunIfIdle(false);
    return { runId, taskId, status: "failed", error };
  }
  // #292: the runtime's EXECUTION metadata (parser/prompt/auth strategy), resolved
  // once. Threaded into the manifest + usage capture so behavior is chosen from the
  // runtime, not from the upstream provider name.
  const runtimeMeta = resolveRuntimeMetadata(runtime);

  // AWN-7: fail loud BEFORE spawning if the resolved auth is unavailable (policy
  // mode, on_unavailable=fail). A no-op in legacy mode. Then record the resolution.
  const availability = checkResolvedAvailability(resolution);
  if (!availability.ok) {
    logEvent("model.profile_unavailable", {
      runId,
      taskId,
      payload: { profile: resolution.profile, provider: resolution.provider, auth: resolution.auth, reason: availability.reason },
    });
    failTask(taskId, { runId, kind: classify({}), error: availability.reason });
    closeRunIfIdle(false);
    return { runId, taskId, status: "failed", error: availability.reason };
  }
  // FG-339: fail loud if a tool-requiring role is dispatched to a non-tool-capable
  // model. Policy mode only — legacy mode (resolvedBy==='legacy') is a no-op.
  // Pi runtimes default non-capable (guilty-until-proven); others default capable.
  if (resolution.resolvedBy !== "legacy") {
    const effectiveToolCapable = resolution.toolCapable ?? (runtimeMeta.runtimeKind !== "pi");
    const toolCapability = checkToolCapability(agentRole, effectiveToolCapable, resolution.profile, resolution.model, resolution.alias);
    if (!toolCapability.ok) {
      logEvent("model.profile_unavailable", {
        runId,
        taskId,
        payload: { profile: resolution.profile, provider: resolution.provider, auth: resolution.auth, capability: "tool", reason: toolCapability.reason },
      });
      failTask(taskId, { runId, kind: classify({}), error: toolCapability.reason });
      closeRunIfIdle(false);
      return { runId, taskId, status: "failed", error: toolCapability.reason };
    }
  }
  const resolvedBlock = manifestModelBlock(resolution);
  if (resolvedBlock) {
    logEvent("model.profile_resolved", { runId, taskId, payload: resolvedBlock });
  }

  // #176: resolve the requested auth profile and fail fast BEFORE spawning a
  // container. An expired session would silently land the agent on an
  // unauthenticated app (which doesn't even redirect to login — it just renders
  // empty), producing false "app broken" reports. Better to refuse up front.
  // invoke honors --auth-profile for whatever agent the user named (no role
  // filter — that scoping is the pipeline's concern, not an explicit invoke).
  let authStateHostPath: string | undefined;
  if (args.authProfile) {
    try {
      // AWN-6: a project-command profile (<project>/.forge/auth-profiles.yml) runs
      // the project's own login to produce storage_state; otherwise fall back to a
      // captured #176 profile. Either way forge stages a mode-600 copy.
      const projectProfile = loadProjectAuthProfile(args.projectDir, args.authProfile);
      const staged = projectProfile
        ? resolveProjectAuthForContainer(projectProfile, args.projectDir, dir, agentRole)
        : resolveAuthStateForContainer(args.authProfile, dir);
      authStateHostPath = staged.hostPath;
      logEvent("auth.profile_applied", { runId, taskId, payload: { profile: args.authProfile, kind: projectProfile ? "project-command" : "captured" } });
      if (staged.reconciled) {
        console.error(
          `forge: auth-profile '${args.authProfile}' — rewrote localhost origins for container access. ` +
            `Point the agent at: ${staged.origins.join(", ")}`,
        );
      }
    } catch (e) {
      if (e instanceof AuthProfileError || e instanceof ProjectAuthError) {
        logEvent("auth.profile_failed", { runId, taskId, payload: { profile: args.authProfile, reason: (e as Error).message } });
        failTask(taskId, { runId, kind: classify({ error: e }), error: (e as Error).message });
        closeRunIfIdle(false);
        return { runId, taskId, status: "failed", error: (e as Error).message };
      }
      throw e;
    }
  }

  // Resolve the effective idle timeout once, at dispatch, and record it in the
  // manifest so forge show reports the value this task actually ran under.
  const idleTimeoutMs = resolveIdleTimeoutMs(runtime.container.idle_timeout_seconds);

  // FG-350: assemble the control-plane receipt — records dispatch-time provenance
  // so explain views answer "why did Forge run this task this way" from RECORDED
  // facts, not recomputed from current config. Workflow is always 'synthetic' for
  // invoke (the workflow object is built in-memory, not loaded from a YAML file).
  let modelPolicyLoaded: ReturnType<typeof loadModelPolicyWithSource>;
  try {
    modelPolicyLoaded = loadModelPolicyWithSource({ projectDir: args.projectDir, seedGeneration });
  } catch (e) {
    const error = `loadModelPolicy failed: ${(e as Error).message}`;
    cleanupStagedAuth(dir); // AWN-8
    failTask(taskId, { runId, kind: classify({}), error });
    closeRunIfIdle(false);
    return { runId, taskId, status: "failed", error };
  }

  const constraintsDir = join(process.env.FORGE_HOME ?? join(process.env.HOME ?? "/", ".forge"), "constraints");
  const allConstraints = loadAllConstraints(constraintsDir);
  const suggestCount = filterConstraints(allConstraints, {
    role: agentRole,
    workflow: "invoke",
    phase: "task",
    level: "suggest",
  }).length;
  const forceCount = filterConstraints(allConstraints, {
    role: agentRole,
    workflow: "invoke",
    phase: "task",
    level: "force",
  }).length;

  const receiptWarnings: string[] = [];
  const routingReceipt = (() => {
    if (!args.routeKey) return undefined;
    // FG-583: resolve the route from the SAME anchored generation this dispatch
    // consumes for workflows/runtimes (seedGeneration, resolved at invoke entry),
    // never the flat ~/.forge/routing-policy.yml. A no-generation host records a
    // named warning rather than reading flat.
    const policyResolved = resolvePolicyPath(args.projectDir, seedGeneration);
    if (policyResolved.source === "host" && (policyResolved.noGeneration || policyResolved.incompletePolicy)) {
      // FG-583: no generation, or a torn/tampered generation policy (finding 2) — do
      // not consume mis-routing bytes into a receipt; record the named state instead.
      receiptWarnings.push(`route lookup skipped for routeKey="${args.routeKey}": ${describeNoEffectiveHostPolicy(policyResolved)}`);
      return undefined;
    }
    const explanation = explainRouteFile(policyResolved.path, args.routeKey);
    if (!explanation.ok) {
      const detail = explanation.findings.map((f) => f.message).join("; ");
      receiptWarnings.push(`route lookup failed for routeKey="${args.routeKey}": ${detail}`);
      return undefined;
    }
    return {
      routeKey: args.routeKey,
      source: policyResolved.source,
      policyPath: policyResolved.path,
      responsible: explanation.route.responsible,
      pathType: explanation.route.path,
      requiredFollowups: explanation.route.required_followups,
    };
  })();

  const docsSurfacesResult = resolveDocsSurfacesReceipt(args.projectDir);
  if (docsSurfacesResult.warning) receiptWarnings.push(docsSurfacesResult.warning);

  const controlPlane = manifestControlPlaneBlock({
    workflow: { name: "invoke", source: "synthetic" },
    runtime: { name: runtimeName, source: runtimeSource, path: runtimePath },
    modelPolicy: modelPolicyLoaded.source === "absent"
      ? { source: "absent" }
      : { source: modelPolicyLoaded.source, path: modelPolicyLoaded.path },
    ...(routingReceipt ? { routing: routingReceipt } : {}),
    docsSurfaces: docsSurfacesResult.receipt,
    constraints: { dir: constraintsDir, suggestCount, forceCount },
    mountMode: args.readOnlyProject ? "ro" : "rw",
    projectDir: args.projectDir,
    ...(args.invocationCwd !== undefined ? { invocationCwd: args.invocationCwd } : {}),
    ...(args.resolvedFromSubdir !== undefined ? { resolvedFromSubdir: args.resolvedFromSubdir } : {}),
    ...(args.explicitSubproject !== undefined ? { explicitSubproject: args.explicitSubproject } : {}),
    warnings: receiptWarnings.length > 0 ? receiptWarnings : undefined,
  });

  writeTaskManifest(dir, {
    taskId,
    runId,
    files: { prompt: "CLAUDE.md", package: "package.md", result: "result.json", stdout: "container.stdout.log", stderr: "container.stderr.log" },
    container: { name: `forge-${taskId}`, idleTimeoutMs },
    auth: { profileRequested: !!args.authProfile, stateMounted: !!authStateHostPath },
    // FG-366: name is the resolved concrete runtime (matches controlPlane.runtime.name),
    // not the requested sentinel — see task-manifest.ts's ManifestRuntime doc comment.
    runtime: { name: runtimeName, kind: runtimeMeta.runtimeKind, logFormat: runtimeMeta.logFormat, promptStrategy: runtimeMeta.promptStrategy, authStrategy: runtimeMeta.authStrategy },
    ...(manifestModelBlock(resolution) ? { model: manifestModelBlock(resolution) } : {}),
    controlPlane,
    // FG-654: RECORDED here, at the same dispatch-time seam as every other receipt, so
    // "which protocol did this agent run under" is answerable from durable state after
    // the fact rather than inferred from whatever is installed when someone asks. The
    // value is the one COMPOSE resolved (TaskPackage.agentProtocol) — recomputing it here
    // would describe the seed as of now, not the bytes in the prompt below.
    ...(taskPackage.agentProtocol ? { agentProtocol: taskPackage.agentProtocol } : {}),
  });

  // Usage attribution: prefer the resolved capability alias (policy mode); fall
  // back to the workflow-declared alias (legacy, where resolution.alias is unset).
  const usageAlias = resolution.alias ?? args.modelAlias;
  // #292: the runtime's log_format selects the usage parser (codex-jsonl → codex;
  // else claude stream-json) — an execution fact, not the provider. provider is
  // still recorded for attribution + as the captureUsageForTask legacy fallback.
  const usageMeta = {
    ...(usageAlias ? { alias: usageAlias } : {}),
    logFormat: runtimeMeta.logFormat,
    ...(resolution.provider ? { provider: resolution.provider } : {}),
    ...(resolution.model ? { model: resolution.model } : {}),
  };

  const systemPrompt = taskPackage.composedSystemPrompt;

  const ctx: SpawnContext = {
    TASK_ID: taskId,
    TASK_DIR: dir,
    PROJECT_DIR: args.projectDir,
    // FG-621: `forge invoke` creates no workspace, so the project dir IS the
    // canonical one — and it is Forge's own record of it either way (the resolved
    // --project, never anything read out of the tree). The clone mount planner
    // REFUSES without it, so omitting it turned a project dir that itself borrows
    // objects (`clone --shared` / `--reference`) into a hard invoke failure.
    //
    // FG-345 SCOPE: default-on isolation did NOT change this. Workspace
    // provisioning lives on the workflow-dispatch path (runNext.ts); this surface
    // has no candidate/publication step to merge a workspace back through, and
    // `forge review-loop` reads its fixer's output from the very directory mounted
    // here (it stages and commits host-side in ctx.projectDir). So an invoke-
    // dispatched agent — including the loop's red reviewer and its fixer — runs
    // against the live checkout even where the default resolves ON, and its task
    // row records no worktree_path or base_sha. Documented in
    // docs/concepts.md → Workspace isolation; pinned by
    // fg345-default-on-dispatch.worktree.test.ts's (invoke-scope) case.
    CANONICAL_PROJECT_DIR: args.projectDir,
    PROJECT_MODE: args.readOnlyProject ? "ro" : "rw",
    MODEL: resolution.model,
    UPSTREAM_PROVIDER: resolution.provider ?? "",
    SYSTEM_PROMPT: systemPrompt,
    TASK_PACKAGE_MARKDOWN: renderInvokeTaskPackage(taskPackage, args.taskText),
    DESIGN_DIR: args.designDir,
    AUTH_STATE_HOST_PATH: authStateHostPath,
  };

  let dockerArgs;
  try {
    dockerArgs = buildDockerArgs(runtime, ctx);
  } catch (e) {
    const error = `buildDockerArgs failed: ${(e as Error).message}`;
    cleanupStagedAuth(dir); // AWN-8
    failTask(taskId, { runId, kind: classify({}), error });
    closeRunIfIdle(false);
    return { runId, taskId, status: "failed", error };
  }

  // FG-374: verify the resolved projectDir has expected project markers before
  // exec'ing — a broken mount wastes agent tokens on a bare directory.
  try {
    preflightProjectMount(args.projectDir);
  } catch (e) {
    const error = `preflightProjectMount failed: ${(e as Error).message}`;
    cleanupStagedAuth(dir); // AWN-8
    failTask(taskId, { runId, kind: classify({}), error });
    closeRunIfIdle(false);
    return { runId, taskId, status: "failed", error };
  }

  const exec = args.dockerExec ?? productionDockerExec;
  const stdoutPath = join(dir, "container.stdout.log");
  const stderrPath = join(dir, "container.stderr.log");
  const containerName = `forge-${taskId}`;
  // FG-536: the start record lands from the executor's post-`docker run -d`
  // callback, so container.started means a container really exists and the
  // watcher-death window (host gone, container running on) starts where the
  // container does. Legacy/fake executors give no signal and keep the up-front
  // record.
  let containerStartRecorded = false;
  const recordContainerStarted = (containerId?: string): void => {
    if (containerStartRecorded) return;
    containerStartRecorded = true;
    logEvent("container.started", { runId, taskId, payload: { containerName, ...(containerId !== undefined ? { containerId } : {}) } });
  };
  if (!exec.signalsContainerStart) recordContainerStarted();
  let exitCode: number;
  // FG-492: populated by docker-exec.ts's capture-at-close. Attached onto
  // every terminal container event below so `forge show`/`status`/`ops check`
  // can render "confirmed container exit — exit N, signal S, OOMKilled=B"
  // instead of an unproven "killed" label. FG-492 review: reap-vs-retain is
  // decided separately, below, once result.json's outcome is known — see
  // finalizeContainerRetention.
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
    // #155: capture usage even on docker failure — the task may have streamed
    // tokens before crashing, and we want to account for them.
    captureUsageForTask(stdoutPath, { taskId, ...usageMeta });
    // WALK-3: ingest progress on the crash path too — the agent's last
    // decision/progress records are most valuable in failure cases.
    emitAgentProgressEvents(dir, runId, taskId);
    cleanupStagedAuth(dir); // AWN-8: remove staged auth-state once terminal
    const error = `docker exec threw: ${(e as Error).message}`;
    failTask(taskId, { runId, kind: classify({}), error });
    closeRunIfIdle(false);
    return { runId, taskId, status: "failed", error };
  }
  // #155: capture token usage from the stream-json log. Best-effort; never
  // throws or affects task status.
  captureUsageForTask(stdoutPath, { taskId, ...usageMeta });
  // WALK-3: ingest any agent-written progress.jsonl as soon as exec returns —
  // BEFORE the idle-timeout / crash / normal branches below — so a hung or
  // crashed agent's progress records still land on the timeline (these are the
  // failure cases where they matter most). The events precede the terminal
  // event, matching when the agent actually wrote them.
  emitAgentProgressEvents(dir, runId, taskId);
  cleanupStagedAuth(dir); // AWN-8: remove staged auth-state once the container is done

  // FG-461: for a recovery-relevant attached-exit kind (oom_killed /
  // container_crash / idle_timeout), gather the same OrphanEvidence tuple
  // reconcile records for a container-gone task, so getOrphanEvidenceFromEvents
  // surfaces it and show/status/ops-check render a recovery line. Skipped for a
  // read-only project mount — a red/audit agent can't persist work, so there's
  // no worktree diff worth recovering (and the operator's own dirty files would
  // be noise). Never throws (attachedExitEvidence uses the safe git probe).
  const recoveryEvidenceFor = (kind: FailureKind): OrphanEvidence | undefined =>
    !args.readOnlyProject && ORPHAN_EVIDENCE_KINDS.has(kind)
      ? attachedExitEvidence({
          containerName,
          worktreePath: getTask(taskId)?.worktreePath,
          projectDir: args.projectDir,
          exitCode,
          // FG-461 follow-up: the attached-exit path only has the process exit
          // code — it never runs `docker inspect`, so it cannot CONFIRM OOM.
          // Exit 137 (128+SIGKILL) is just as likely an external kill. Leave
          // oomKilled UNSET (unknown) — only the reconcile path, which reads
          // Docker's real OOMKilled flag, may assert it. This keeps the recovery
          // message at the honest "exit 137 — possibly OOM or an external kill",
          // matching the error string this same branch already emits.
        })
      : undefined;

  // #173: the watchdog SIGKILLed a hung agent (no stdout within the idle
  // timeout). Fail with a clear reason rather than a generic container_crash.
  if (exitCode === IDLE_TIMEOUT_EXIT_CODE) {
    logEvent("container.idle_timeout", { runId, taskId, payload: { containerName, exitCode, ...(containerEvidence ? { containerEvidence } : {}) } });
    const error = `idle_timeout (no agent output for ${Math.round(idleTimeoutMs / 60000)}m)`;
    const kind = classify({ exitCode });
    failTask(taskId, { runId, kind, error, evidence: recoveryEvidenceFor(kind) });
    // FG-492 review: the reap/retain decision moves here, keyed on the TASK
    // outcome (false = failed) rather than the raw exit code — retained for
    // `forge show --diagnostic` / `docker inspect` unless
    // FORGE_CONTAINER_RETENTION=off forces an immediate reap regardless.
    finalizeContainerRetention(containerName, false);
    closeRunIfIdle(false);
    return { runId, taskId, status: "failed", error, failureKind: kind };
  }

  // FG-376: the entrypoint's dependency install (npm ci/install from
  // FORGE_NM_INSTALL_ROOT) failed before it could exec the agent command.
  // Recognized ahead of the generic container_crash branch below so a broken
  // worktree/volume dependency graph is reported as
  // verification_environment_unavailable, not misread as a test failure or a
  // generic crash.
  if (exitCode === DEPENDENCY_PROVISIONING_FAILED_EXIT_CODE) {
    const stderrTail = existsSync(stderrPath) ? readFileSync(stderrPath, "utf8").trim() : "";
    logEvent("container.dependency_provisioning_failed", { runId, taskId, payload: { containerName, exitCode, ...(containerEvidence ? { containerEvidence } : {}) } });
    const error = `verification_environment_unavailable: dependency install failed${stderrTail ? ` — ${stderrTail}` : ""}`;
    const kind = classify({ source: "verification_environment_unavailable" });
    failTask(taskId, { runId, kind, error });
    // FG-492 review: task failed — retain (see finalizeContainerRetention above).
    finalizeContainerRetention(containerName, false);
    closeRunIfIdle(false);
    return { runId, taskId, status: "failed", error, failureKind: kind };
  }

  // FG-559: the entrypoint's git probe found git unusable in the project mount
  // (a linked worktree whose parent .git never made it into the container) and
  // exited before the agent ran. Same footing as the provisioning sentinel
  // above: an environment failure, not a crash and not a task failure.
  if (exitCode === GIT_UNAVAILABLE_EXIT_CODE) {
    const stderrTail = existsSync(stderrPath) ? readFileSync(stderrPath, "utf8").trim() : "";
    logEvent("container.git_unavailable", { runId, taskId, payload: { containerName, exitCode, ...(containerEvidence ? { containerEvidence } : {}) } });
    const error = `verification_environment_unavailable: git is unusable in the project mount${stderrTail ? ` — ${stderrTail}` : ""}`;
    const kind = classify({ source: "verification_environment_unavailable" });
    failTask(taskId, { runId, kind, error });
    finalizeContainerRetention(containerName, false);
    closeRunIfIdle(false);
    return { runId, taskId, status: "failed", error, failureKind: kind };
  }

  logEvent("container.exited", { runId, taskId, payload: { containerName, exitCode, ...(containerEvidence ? { containerEvidence } : {}) } });

  // Read result.json.
  const resultPath = join(dir, "result.json");
  const resultRaw = existsSync(resultPath) ? readFileSync(resultPath, "utf8").trim() : "";
  if (exitCode !== 0 && !resultRaw) {
    // #228: before defaulting to a generic container_crash, attribute the cause
    // from the runtime's structured stdout — a provider/model error (invalid
    // model, quota, 4xx) is classified `model_error` with the cause surfaced.
    let kind = classify({ exitCode, resultState: "missing" });
    let error = kind === "oom_killed"
      ? `container killed (exit ${exitCode} — possibly OOM or an external kill)`
      : `container_crash (exit ${exitCode})`;
    const a = analyzeProviderFailure({
      logFormat: runtimeMeta.logFormat,
      runtimeKind: runtimeMeta.runtimeKind,
      stdoutRaw: existsSync(stdoutPath) ? readFileSync(stdoutPath, "utf8") : "",
    });
    if (a.modelError) {
      kind = classify({ source: "model_error" });
      if (a.error) error = a.error;
    }
    // FG-461: oom_killed / container_crash carry recovery evidence; model_error
    // (a clean provider rejection) is not in ORPHAN_EVIDENCE_KINDS, so
    // recoveryEvidenceFor returns undefined for it.
    failTask(taskId, { runId, kind, error, evidence: recoveryEvidenceFor(kind) });
    // FG-492 review: task failed — retain (see finalizeContainerRetention above).
    finalizeContainerRetention(containerName, false);
    closeRunIfIdle(false);
    return { runId, taskId, status: "failed", error, failureKind: kind };
  }

  let result: unknown = undefined;
  try {
    if (resultRaw.length > 0) result = JSON.parse(resultRaw);
  } catch {
    const error = "result.json malformed";
    const kind = classify({ resultState: "malformed" });
    failTask(taskId, { runId, kind, error });
    // FG-492 review: task failed — retain (see finalizeContainerRetention above).
    finalizeContainerRetention(containerName, false);
    closeRunIfIdle(false);
    return { runId, taskId, status: "failed", error, failureKind: kind };
  }
  if (!result) {
    // #264: pi exits 0 even on a provider error, so a missing result.json here is
    // ambiguous — attribute the cause from pi's structured stdout. #267: when that
    // cause is a PROVIDER/model error, classify it `model_error` (with the cause),
    // not generic result_missing.
    let error = "no_result_json";
    let kind = classify({ resultState: "missing" });
    const stdoutRaw = existsSync(stdoutPath) ? readFileSync(stdoutPath, "utf8") : "";
    const a = analyzeProviderFailure({
      logFormat: runtimeMeta.logFormat,
      runtimeKind: runtimeMeta.runtimeKind,
      stdoutRaw,
    });
    if (a.error) error = a.error;
    if (a.modelError) kind = classify({ source: "model_error" });
    // FG-540: provider-adapter recovery — a cleanly-exited run whose stream
    // carries an unambiguous terminal JSON-object agent_message supplies the
    // structured result the agent failed to write. The recovered object then
    // falls THROUGH to the normal completion path below (persistence check,
    // CAS complete, task.completed, retention) exactly like a file result.
    // A non-empty result.json never reaches here (parsed or malformed above),
    // so recovery can never overwrite one.
    const recovered = exitCode === 0 && resultRaw.length === 0 && !a.modelError
      ? recoverStructuredStreamResult({ logFormat: runtimeMeta.logFormat, runtimeKind: runtimeMeta.runtimeKind, stdoutRaw })
      : undefined;
    if (recovered) {
      // FG-540 review: persist-or-fail-closed. If the recovered result can't be
      // written (unwritable dir, a directory at result.json), the task has no
      // durable result — fail it through the normal result-missing path rather
      // than throwing out of dispatch with the task left running.
      try {
        writeFileSync(resultPath, JSON.stringify(recovered));
      } catch (e) {
        const err = `${error} (stream-recovered result could not be persisted: ${e instanceof Error ? e.message : String(e)})`;
        failTask(taskId, { runId, kind, error: err, evidence: recoveryEvidenceFor(kind) });
        finalizeContainerRetention(containerName, false);
        closeRunIfIdle(false);
        return { runId, taskId, status: "failed", error: err, failureKind: kind };
      }
      logEvent("task.result_recovered_from_stream", {
        runId, taskId,
        payload: { source: "invoke", logFormat: runtimeMeta.logFormat ?? runtimeMeta.runtimeKind ?? null },
      });
      result = recovered;
    } else {
    // FG-337: clean completion + captured assistant text + narrative role →
    // synthesize an inferred result instead of hard-failing.
    const inferred = inferredResultFrom(a, agentRole);
    if (inferred) {
      writeFileSync(join(dir, "result.json"), JSON.stringify(inferred));
      if (!markTaskComplete(taskId, inferred)) {
        const finalStatus = getTask(taskId)?.status === "failed" ? "failed" : "complete";
        // FG-492 review: reap only if the task actually ended up complete —
        // a lost CAS race to a concurrent cancel is a failure, not a success.
        reapContainerAndReportFailure(containerName, finalStatus === "complete", runId, taskId);
        closeRunIfIdle(finalStatus === "complete");
        return { runId, taskId, status: finalStatus, result: inferred, ...(finalStatus === "failed" ? { error: getTask(taskId)?.error ?? "cancelled" } : {}) };
      }
      logEvent("task.completed", { runId, taskId });
      reapContainerAndReportFailure(containerName, true, runId, taskId);
      closeRunIfIdle(true);
      return { runId, taskId, status: "complete", result: inferred };
    }
    // FG-492 finding 1: result_missing now joins ORPHAN_EVIDENCE_KINDS, so
    // recoveryEvidenceFor gathers the same worktree-diff evidence as
    // container_crash/idle_timeout for it; model_error is not in that set, so
    // recoveryEvidenceFor returns undefined for it, matching the branch above.
    failTask(taskId, { runId, kind, error, evidence: recoveryEvidenceFor(kind) });
    // FG-492 review: this is exactly the state-4 case the retention fix targets
    // — a clean exit that produced no result.json is retained, not reaped.
    finalizeContainerRetention(containerName, false);
    closeRunIfIdle(false);
    return { runId, taskId, status: "failed", error, failureKind: kind };
    }
  }

  // #254: persistence assertion (rw project only — a read-only mount can't
  // persist by design, so files_modified there isn't loss). If the result claims
  // files but none reached the host, the work was discarded; fail loudly.
  if (!args.readOnlyProject) {
    const persistence = await checkResultPersistence(getTask(taskId)?.worktreePath ?? args.projectDir, result);
    if (!persistence.ok) {
      const error = persistenceErrorMessage(persistence);
      failTask(taskId, { runId, kind: "work_not_persisted", error, result });
      // FG-492 review: task failed — retain (see finalizeContainerRetention above).
      finalizeContainerRetention(containerName, false);
      closeRunIfIdle(false);
      return { runId, taskId, status: "failed", error, failureKind: "work_not_persisted" };
    }
  }

  // AWN-2 task-level race: a concurrent `forge cancel` may have already marked
  // this task failed (failure_kind=cancelled) while the container ran. The CAS in
  // markTaskComplete refuses to overwrite a terminal task — only emit
  // task.completed and report success if we actually completed it.
  if (!markTaskComplete(taskId, result)) {
    const finalStatus = getTask(taskId)?.status === "failed" ? "failed" : "complete";
    // FG-492 review: reap only if the task actually ended up complete.
    reapContainerAndReportFailure(containerName, finalStatus === "complete", runId, taskId);
    closeRunIfIdle(finalStatus === "complete");
    return { runId, taskId, status: finalStatus, result, ...(finalStatus === "failed" ? { error: getTask(taskId)?.error ?? "cancelled" } : {}) };
  }
  logEvent("task.completed", { runId, taskId });
  // FG-492 review: task marked complete with a valid result — nothing left to
  // investigate on this container, reap it now instead of leaving it to
  // `forge ops reap-containers` or a stray reconcile pass.
  reapContainerAndReportFailure(containerName, true, runId, taskId);
  closeRunIfIdle(true);
  return { runId, taskId, status: "complete", result };
}

// --- Helpers ---

// FG-487: exported so callers that must create the run row EAGERLY — before any
// task dispatch — can reuse the exact same run-creation primitive `invoke()`
// itself uses lazily (see review-loop.ts's CLI wiring, which creates the run at
// loop entry, before round 1's verification, rather than waiting for the first
// reviewer/fixer dispatch).
export function createInvokeRun(
  agentRole: string,
  projectDir: string,
  designDir: string | undefined,
  titleOverride: string | undefined,
  workspace: string | undefined,
  // FG-563 (CP2, F17): stamped into metadata so this run is discoverable by
  // runByDispatchKey the instant it exists — before the container spawn is
  // observable. Trailing-optional so existing positional callers are unaffected.
  dispatchKey?: string,
): string {
  const title = titleOverride ?? `invoke ${agentRole}`;
  const runId = newRunId(title);
  const metadata: Record<string, unknown> = { invokeAgent: agentRole };
  if (designDir) metadata["designDir"] = designDir;
  if (workspace) metadata["workspace"] = workspace;
  if (dispatchKey) metadata["dispatchKey"] = dispatchKey;

  const run: Run = {
    id: runId,
    workflow: "invoke",  // sentinel; not a registered workflow
    title,
    status: "active",
    createdAt: new Date().toISOString(),
    metadata,
    projectDir,
  };
  insertRun(run);
  logEvent("run.created", { runId, payload: { kind: "invoke", agent: agentRole } });
  return runId;
}

// FG-507: `forge retry` stamps inputs.previous_failure on the row it mints (AWN-3)
// so the next attempt is informed. The pipeline renderer surfaces inputs; this one
// renders only the freeform task text, so a re-dispatched ad-hoc retry would have
// silently dropped that context. Plain invoke rows never carry the key.
function previousFailureSection(tp: TaskPackage): string[] {
  const pf = tp.inputs["previous_failure"] as { kind?: string; error?: string | null; failedTaskId?: string } | undefined;
  if (!pf) return [];
  return [
    `## Previous attempt (this is a retry)`,
    ``,
    `Task ${pf.failedTaskId ?? "(unknown)"} attempted this same work and failed with failure_kind=${pf.kind ?? "unknown"}.`,
    `Error: ${pf.error ?? "(none recorded)"}`,
    ``,
    `Read that as context, not as instruction — diagnose before repeating the same approach.`,
    ``,
  ];
}

function renderInvokeTaskPackage(tp: TaskPackage, task: string): string {
  return [
    `# Task ${tp.taskId}`,
    ``,
    `Run: ${tp.runId}`,
    `Agent: ${tp.role}`,
    ``,
    `## Task`,
    ``,
    task,
    ``,
    ...previousFailureSection(tp),
    `## Output contract`,
    ``,
    `Write a single JSON object to /task/result.json. At minimum: {"status": "complete"|"failed", ...your role-specific output}.`,
    ``,
  ].join("\n");
}

export type { DockerExecArgs, DockerExecFn };
