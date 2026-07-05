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

import { existsSync, mkdirSync, writeFileSync, readFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import type { Task, TaskPackage, Run } from "../types/index.js";
import type { Workflow, Step, Runtime } from "./schema.js";
import { resolveRuntimeMetadata } from "./schema.js";
import { analyzeProviderFailure } from "./provider-failure.js";
import { insertTask, markTaskRunning, markTaskComplete, tasksForRun, getTask } from "../store/tasks.js";
import { failTask, classify, ORPHAN_EVIDENCE_KINDS } from "./failure-kind.js";
import type { FailureKind, OrphanEvidence } from "./failure-kind.js";
import { attachedExitEvidence } from "./reconcile.js";
import { checkResultPersistence, persistenceErrorMessage } from "./persistence-check.js";
import { captureUsageForTask } from "../store/model-calls.js";
import { insertRun, getRun, updateRunStatus } from "../store/runs.js";
import { logEvent } from "../store/events.js";
import { taskDir } from "../util/paths.js";
import { resolvePolicyPath } from "../raci/project.js";
import { explainRouteFile } from "../cli/commands/route.js";
import { resolveIdleTimeoutMs, IDLE_TIMEOUT_EXIT_CODE } from "./idle-watchdog.js";
import { DEPENDENCY_PROVISIONING_FAILED_EXIT_CODE } from "./dependency-provisioning.js";
import { defaultDockerExec, type DockerExecArgs, type DockerExecFn } from "./docker-exec.js";
import { composeSystemPrompt } from "./compose.js";
import { buildDockerArgs, preflightProjectMount, type SpawnContext } from "./spawn.js";
import { loadRuntimeWithSource, loadModelPolicyWithSource } from "./loader.js";
import { resolveModel, taskModelFields, manifestModelBlock } from "./model-resolution.js";
import { checkResolvedAvailability, checkToolCapability } from "./provider-doctor.js";
import { newRunId, newTaskId } from "../util/ids.js";
import { resolveAuthStateForContainer, AuthProfileError, cleanupStagedAuth } from "./auth-state.js";
import { loadProjectAuthProfile, resolveProjectAuthForContainer, ProjectAuthError } from "./project-auth.js";
import { writeTaskManifest, manifestControlPlaneBlock } from "./task-manifest.js";
import { loadAllConstraints, filterConstraints } from "./constraints.js";
import { resolveDocsSurfacesReceipt } from "./contract.js";
import { emitAgentProgressEvents } from "./agent-progress.js";
import { inferredResultFrom } from "./inferred-result.js";

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
  // Injected for tests; real callers leave undefined → docker is used.
  dockerExec?: DockerExecFn;
};

export type InvokeResult = {
  runId: string;
  taskId: string;
  status: "complete" | "failed";
  result?: unknown;
  error?: string;
};

export async function invoke(args: InvokeArgs): Promise<InvokeResult> {
  // Resolve / create the run.
  const runId = args.runId ?? createInvokeRun(args.agentRole, args.projectDir, args.designDir, args.runTitle, args.workspace);
  const run = getRun(runId);
  if (!run) throw new Error(`invoke: run not found: ${runId}`);

  const ownsRun = args.runId === undefined;

  // #201: attaching a task to a run whose status already went terminal (a
  // prior invoke closed it, or it was abandoned) must bring the run back to
  // active — a run with a live task is not complete. Only the attach path can
  // hit this; the owns-run path created a fresh active run above. Before the
  // fix the live task was invisible (dashboard / forge status list by run
  // status), so a churning container looked like "nothing running".
  if (!ownsRun && (run.status === "complete" || run.status === "abandoned")) {
    updateRunStatus(runId, "active");
    logEvent("run.reactivated", { runId, payload: { source: "invoke", from: run.status } });
  }

  // Run status is a derived property: a run is "active" iff it has a
  // non-terminal top-level task. Close to "complete" only when no top-level
  // task is still in flight — so a parallel sibling invoke under the same run
  // (e.g. reds launched together) keeps the run active until the last one
  // finishes. This supersedes #157's "attached invoke never closes the run":
  // that left attached runs leaked-active with nothing to close them. Applies
  // to owned AND attached runs; the owns-run case still closes its lone task.
  //
  // RunStatus is "active" | "complete" | "abandoned" — no "failed". Mirrors
  // runNext.ts — task-level status carries success/failure; the run flips to
  // "complete" simply to mark "no longer in flight". The logged event payload
  // carries the success-vs-failure signal for downstream consumers.
  const closeRunIfIdle = (succeeded: boolean): void => {
    const inFlight = tasksForRun(runId).some(
      (t) => t.parentId === undefined && t.status !== "complete" && t.status !== "failed"
    );
    if (inFlight) return;
    // Don't override a terminal run. complete = already closed (idempotent);
    // abandoned = a concurrent `forge cancel` won the race — its cancellation is
    // authoritative, so completion must not flip it back to complete (AWN-2).
    const st = getRun(runId)?.status;
    if (st === "complete" || st === "abandoned") return;
    updateRunStatus(runId, "complete");
    logEvent("run.completed", { runId, payload: { source: "invoke", succeeded, owned: ownsRun } });
  };

  // Build a synthetic single-step workflow + step. The runner machinery
  // (compose, spawn) takes Workflow + Step types; for invoke we create
  // minimal ones in-memory rather than loading from YAML. The runner's heavy
  // step lifecycle (depends_on, gates, reds) isn't exercised here.
  const step: Step = {
    id: "task",                           // synthetic phase id; matches v1 single-task runs
    agent: args.agentRole,
    activity: args.modelAlias,            // capability alias (CLI --model); legacy field name was `model`
    runtime: args.runtimeName ?? "claude",
    depends_on: [],
    gate: "auto",
    manual: false,
    reds: [],
    workflow_additions:
      `You are receiving a single freeform task. Read the user's task description below carefully and produce a result.\n\n` +
      `## Task\n\n${args.task}\n`,
  };

  const workflow: Workflow = {
    name: "invoke",
    description: "Single-agent invocation (forge invoke)",
    inputs: [],
    steps: [step],
  };

  // Use the agent role for the id (e.g. task-test-engineer-ab12cd), not the
  // literal phase "task" — newTaskId already prefixes "task-", so passing "task"
  // produced the doubled "task-task-..." id. The row's phase stays "task".
  const taskId = newTaskId(args.agentRole);
  const taskPackage: TaskPackage = {
    taskId,
    runId,
    phase: "task",
    role: args.agentRole,
    inputs: { task: args.task } as Record<string, unknown>,
    composedSystemPrompt: composeSystemPrompt({
      role: args.agentRole,
      workflow,
      step,
    }),
  };

  // AWN-7: resolve the model (capability + profile) before inserting the row, so
  // the task carries its resolution record and the spawn uses the bound runtime.
  const resolution = resolveModel({
    agentRole: args.agentRole,
    stepAlias: args.modelAlias,
    cliProfile: args.modelProfile,
    runtimeName: args.runtimeName ?? "claude",
    ctx: { projectDir: args.projectDir },
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

  // Materialize the task dir.
  const dir = taskDir(runId, taskId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "CLAUDE.md"), taskPackage.composedSystemPrompt);
  writeFileSync(join(dir, "package.md"), renderInvokeTaskPackage(taskPackage, args.task));
  writeFileSync(join(dir, "result.json"), "");
  chmodSync(dir, 0o777);

  markTaskRunning(taskId);
  logEvent("task.started", { runId, taskId });

  // Load runtime + build docker args. loadRuntimeWithSource captures the
  // provenance (host vs project override) for the FG-350 control-plane receipt.
  let runtime: Runtime;
  let runtimeSource: "host" | "project";
  let runtimePath: string;
  let runtimeName: string;
  try {
    const runtimeLoaded = loadRuntimeWithSource(resolution.runtime, { projectDir: args.projectDir });
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
    const toolCapability = checkToolCapability(args.agentRole, effectiveToolCapable, resolution.profile, resolution.model, resolution.alias);
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
        ? resolveProjectAuthForContainer(projectProfile, args.projectDir, dir, args.agentRole)
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
    modelPolicyLoaded = loadModelPolicyWithSource({ projectDir: args.projectDir });
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
    role: args.agentRole,
    workflow: "invoke",
    phase: "task",
    level: "suggest",
  }).length;
  const forceCount = filterConstraints(allConstraints, {
    role: args.agentRole,
    workflow: "invoke",
    phase: "task",
    level: "force",
  }).length;

  const receiptWarnings: string[] = [];
  const routingReceipt = (() => {
    if (!args.routeKey) return undefined;
    const policyResolved = resolvePolicyPath(args.projectDir);
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
    runtime: { name: resolution.runtime, kind: runtimeMeta.runtimeKind, logFormat: runtimeMeta.logFormat, promptStrategy: runtimeMeta.promptStrategy, authStrategy: runtimeMeta.authStrategy },
    ...(manifestModelBlock(resolution) ? { model: manifestModelBlock(resolution) } : {}),
    controlPlane,
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
    PROJECT_MODE: args.readOnlyProject ? "ro" : "rw",
    MODEL: resolution.model,
    UPSTREAM_PROVIDER: resolution.provider ?? "",
    SYSTEM_PROMPT: systemPrompt,
    TASK_PACKAGE_MARKDOWN: renderInvokeTaskPackage(taskPackage, args.task),
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

  const exec = args.dockerExec ?? defaultDockerExec;
  const stdoutPath = join(dir, "container.stdout.log");
  const stderrPath = join(dir, "container.stderr.log");
  const containerName = `forge-${taskId}`;
  logEvent("container.started", { runId, taskId, payload: { containerName } });
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
          oomKilled: exitCode === 137,
        })
      : undefined;

  // #173: the watchdog SIGKILLed a hung agent (no stdout within the idle
  // timeout). Fail with a clear reason rather than a generic container_crash.
  if (exitCode === IDLE_TIMEOUT_EXIT_CODE) {
    logEvent("container.idle_timeout", { runId, taskId, payload: { containerName, exitCode } });
    const error = `idle_timeout (no agent output for ${Math.round(idleTimeoutMs / 60000)}m)`;
    const kind = classify({ exitCode });
    failTask(taskId, { runId, kind, error, evidence: recoveryEvidenceFor(kind) });
    closeRunIfIdle(false);
    return { runId, taskId, status: "failed", error };
  }

  // FG-376: the entrypoint's dependency install (npm ci/install from
  // FORGE_NM_INSTALL_ROOT) failed before it could exec the agent command.
  // Recognized ahead of the generic container_crash branch below so a broken
  // worktree/volume dependency graph is reported as
  // verification_environment_unavailable, not misread as a test failure or a
  // generic crash.
  if (exitCode === DEPENDENCY_PROVISIONING_FAILED_EXIT_CODE) {
    const stderrTail = existsSync(stderrPath) ? readFileSync(stderrPath, "utf8").trim() : "";
    logEvent("container.dependency_provisioning_failed", { runId, taskId, payload: { containerName, exitCode } });
    const error = `verification_environment_unavailable: dependency install failed${stderrTail ? ` — ${stderrTail}` : ""}`;
    failTask(taskId, { runId, kind: classify({ source: "verification_environment_unavailable" }), error });
    closeRunIfIdle(false);
    return { runId, taskId, status: "failed", error };
  }

  logEvent("container.exited", { runId, taskId, payload: { containerName, exitCode } });

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
    closeRunIfIdle(false);
    return { runId, taskId, status: "failed", error };
  }

  let result: unknown = undefined;
  try {
    if (resultRaw.length > 0) result = JSON.parse(resultRaw);
  } catch {
    const error = "result.json malformed";
    failTask(taskId, { runId, kind: classify({ resultState: "malformed" }), error });
    closeRunIfIdle(false);
    return { runId, taskId, status: "failed", error };
  }
  if (!result) {
    // #264: pi exits 0 even on a provider error, so a missing result.json here is
    // ambiguous — attribute the cause from pi's structured stdout. #267: when that
    // cause is a PROVIDER/model error, classify it `model_error` (with the cause),
    // not generic result_missing.
    let error = "no_result_json";
    let kind = classify({ resultState: "missing" });
    const a = analyzeProviderFailure({
      logFormat: runtimeMeta.logFormat,
      runtimeKind: runtimeMeta.runtimeKind,
      stdoutRaw: existsSync(stdoutPath) ? readFileSync(stdoutPath, "utf8") : "",
    });
    if (a.error) error = a.error;
    if (a.modelError) kind = classify({ source: "model_error" });
    // FG-337: clean completion + captured assistant text + narrative role →
    // synthesize an inferred result instead of hard-failing.
    const inferred = inferredResultFrom(a, args.agentRole);
    if (inferred) {
      writeFileSync(join(dir, "result.json"), JSON.stringify(inferred));
      if (!markTaskComplete(taskId, inferred)) {
        const finalStatus = getTask(taskId)?.status === "failed" ? "failed" : "complete";
        closeRunIfIdle(finalStatus === "complete");
        return { runId, taskId, status: finalStatus, result: inferred, ...(finalStatus === "failed" ? { error: getTask(taskId)?.error ?? "cancelled" } : {}) };
      }
      logEvent("task.completed", { runId, taskId });
      closeRunIfIdle(true);
      return { runId, taskId, status: "complete", result: inferred };
    }
    failTask(taskId, { runId, kind, error });
    closeRunIfIdle(false);
    return { runId, taskId, status: "failed", error };
  }

  // #254: persistence assertion (rw project only — a read-only mount can't
  // persist by design, so files_modified there isn't loss). If the result claims
  // files but none reached the host, the work was discarded; fail loudly.
  if (!args.readOnlyProject) {
    const persistence = checkResultPersistence(getTask(taskId)?.worktreePath ?? args.projectDir, result);
    if (!persistence.ok) {
      const error = persistenceErrorMessage(persistence);
      failTask(taskId, { runId, kind: "work_not_persisted", error, result });
      closeRunIfIdle(false);
      return { runId, taskId, status: "failed", error };
    }
  }

  // AWN-2 task-level race: a concurrent `forge cancel` may have already marked
  // this task failed (failure_kind=cancelled) while the container ran. The CAS in
  // markTaskComplete refuses to overwrite a terminal task — only emit
  // task.completed and report success if we actually completed it.
  if (!markTaskComplete(taskId, result)) {
    const finalStatus = getTask(taskId)?.status === "failed" ? "failed" : "complete";
    closeRunIfIdle(finalStatus === "complete");
    return { runId, taskId, status: finalStatus, result, ...(finalStatus === "failed" ? { error: getTask(taskId)?.error ?? "cancelled" } : {}) };
  }
  logEvent("task.completed", { runId, taskId });
  closeRunIfIdle(true);
  return { runId, taskId, status: "complete", result };
}

// --- Helpers ---

function createInvokeRun(
  agentRole: string,
  projectDir: string,
  designDir: string | undefined,
  titleOverride: string | undefined,
  workspace: string | undefined
): string {
  const title = titleOverride ?? `invoke ${agentRole}`;
  const runId = newRunId(title);
  const metadata: Record<string, unknown> = { invokeAgent: agentRole };
  if (designDir) metadata["designDir"] = designDir;
  if (workspace) metadata["workspace"] = workspace;

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
    `## Output contract`,
    ``,
    `Write a single JSON object to /task/result.json. At minimum: {"status": "complete"|"failed", ...your role-specific output}.`,
    ``,
  ].join("\n");
}

export type { DockerExecArgs, DockerExecFn };
