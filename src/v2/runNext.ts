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
import { resolveIdleTimeoutMs, IDLE_TIMEOUT_EXIT_CODE } from "./idle-watchdog.js";
import { defaultDockerExec, type DockerExecArgs, type DockerExecFn } from "./docker-exec.js";
import { join } from "node:path";
import type { Task, TaskPackage, Verdict, Finding, RedAuthority } from "../types/index.js";
import type { Workflow, Step, Runtime, RedDef, FanoutDef } from "./schema.js";
import { tasksForRun } from "../store/tasks.js";
import { getRun, updateRunStatus } from "../store/runs.js";
import { notifyOnTaskBlockedByRed, notifyOnGateAwaiting } from "../notify/trigger.js";
import { insertTask, getTask, markTaskRunning, markTaskComplete, markTaskAwaitingGate, setTaskStatus } from "../store/tasks.js";
import { failTask, classify } from "./failure-kind.js";
import { captureUsageForTask } from "../store/model-calls.js";
import { insertVerdict } from "../store/verdicts.js";
import { validateVerdict } from "./validate-findings.js";
import { gradeFindings } from "./review-quality.js";
import { logEvent } from "../store/events.js";
import { taskDir } from "../util/paths.js";
import { computeReadyQueue } from "./ready-queue.js";
import { finalizeOrphanedPrimaries } from "./reconcile.js";
import { checkResultPersistence, persistenceErrorMessage } from "./persistence-check.js";
import { deriveUpstream } from "./inputs.js";
import { composeSystemPrompt } from "./compose.js";
import { buildDockerArgs, type SpawnContext } from "./spawn.js";
import { resolveAuthStateForContainer, AuthProfileError, roleUsesBrowser, cleanupStagedAuth } from "./auth-state.js";
import { loadProjectAuthProfile, resolveProjectAuthForContainer, ProjectAuthError } from "./project-auth.js";
import { writeTaskManifest } from "./task-manifest.js";
import { emitAgentProgressEvents } from "./agent-progress.js";
import { loadRuntime } from "./loader.js";
import {
  resolveModel,
  taskModelFields,
  manifestModelBlock,
  type ModelResolution,
} from "./model-resolution.js";
import { checkResolvedAvailability } from "./provider-doctor.js";
import { CONTROL_PLANE_METADATA_KEYS } from "./startRun.js";
import { newTaskId, newVerdictId, nowIso } from "../util/ids.js";

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
    const anyFailed = tasksAfter.some((t) => t.status === "failed" && t.parentId === undefined);
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

  const dispatchResult = await runContainer({
    taskId,
    runId: args.runId,
    projectDir: args.projectDir,
    projectMode: "rw",
    designDir: args.designDir,
    taskPackage,
    resolution,
    workflowAlias: step.activity,
    authProfile: authProfileForRole(args.runMetadata, agentRole),
    role: agentRole,
    dockerExec: args.dockerExec,
  });

  if (dispatchResult.kind === "failed") {
    return "failed";
  }

  const result = dispatchResult.result;

  // #254: persistence assertion. If the agent reports a complete result with
  // files_modified but none of those files landed on the host project mount, the
  // work was written to an ephemeral path and discarded — fail loudly (don't run
  // reds, don't gate over an empty diff) instead of advancing on a green lie.
  const persistence = checkResultPersistence(args.projectDir, result);
  if (!persistence.ok) {
    const error = persistenceErrorMessage(persistence);
    failTask(taskId, { runId: args.runId, kind: "work_not_persisted", error, result });
    return "failed";
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
    return finalizePrimary(taskId, args.runId, step.gate, result);
  }

  return finalizePrimary(taskId, args.runId, step.gate, result);
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
  const launches = args.step.reds.map((red) =>
    runOneRed({
      runId: args.runId,
      workflow: args.workflow,
      step: args.step,
      red,
      primaryTaskId: args.primaryTaskId,
      artifact,
      projectDir: args.projectDir,
      designDir: args.designDir,
      runMetadata: args.runMetadata,
      dockerExec: args.dockerExec,
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
    verdicts.push(finalVerdict);
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
    // Gate on the GRADED verdict — a fail emptied by grading no longer blocks.
    if (r.red.authority === "authoritative" && r.red.gate_on_verdict && finalVerdict.verdict === "fail") {
      authoritativeFail = true;
    }
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
  projectDir: string;
  designDir?: string;
  runMetadata: Record<string, unknown>;
  dockerExec?: DockerExecFn;
}): Promise<{ red: RedDef; verdict: Verdict; redTaskId: string }> {
  const redTaskId = newTaskId(`red-${args.step.id}`);
  const taskPackage: TaskPackage = {
    taskId: redTaskId,
    runId: args.runId,
    phase: args.step.id,
    role: args.red.agent,
    inputs: {},
    composedSystemPrompt: composeSystemPrompt({
      role: args.red.agent,
      workflow: args.workflow,
      step: args.step,
    }),
    artifact: args.artifact,
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

  const result = await runContainer({
    taskId: redTaskId,
    runId: args.runId,
    projectDir: args.projectDir,
    projectMode: "ro",
    designDir: args.designDir,
    taskPackage,
    resolution: redResolution,
    workflowAlias: args.red.activity,
    dockerExec: args.dockerExec,
  });

  if (result.kind === "failed") {
    // A red that fails to produce a verdict counts as inconclusive — don't let
    // a broken container block the gate. runContainer already marked the task
    // failed.
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
  const existingParent = allTasks.find(
    (t) => t.phase === step.id && t.parentId === undefined,
  );
  const parentId = existingParent?.id ?? newTaskId(step.id);

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

  // failure_mode determines whether a partial result fails the parent.
  const anyFailed = childOutcomes.some((c) => c.status === "failed");
  if (anyFailed && fanout.failure_mode === "fail-phase") {
    failTask(parentId, { runId: args.runId, kind: classify({}), error: "fanout: at least one child failed (failure_mode=fail-phase)", result: parentResult });
    return "failed";
  }

  return finalizePrimary(parentId, args.runId, step.gate, parentResult);
}

type ChildOutcome = {
  index: number;
  value: unknown;
  childTaskId: string;
  status: "complete" | "failed";
  result?: unknown;
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

  const dispatchResult = await runContainer({
    taskId: childTaskId,
    runId: args.runId,
    projectDir: args.projectDir,
    projectMode: "rw",
    designDir: args.designDir,
    taskPackage,
    resolution: childResolution,
    workflowAlias: step.activity,
    authProfile: authProfileForRole(args.runMetadata, agentRole),
    role: agentRole,
    dockerExec: args.dockerExec,
  });

  if (dispatchResult.kind === "failed") {
    return { index: args.index, value: args.value, childTaskId, status: "failed" };
  }

  // AWN-2 task-level race: don't overwrite / re-announce a concurrently-cancelled child.
  if (markTaskComplete(childTaskId, dispatchResult.result)) {
    logEvent("task.completed", { runId: args.runId, taskId: childTaskId });
  }
  return {
    index: args.index,
    value: args.value,
    childTaskId,
    status: "complete",
    result: dispatchResult.result,
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
  try {
    runtime = loadRuntime(args.resolution.runtime);
  } catch (e) {
    const msg = `loadRuntime failed: ${(e as Error).message}`;
    failTask(args.taskId, { runId: args.runId, kind: classify({}), error: msg });
    return { kind: "failed", error: msg };
  }

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
  const resolvedBlock = manifestModelBlock(args.resolution);
  if (resolvedBlock) {
    logEvent("model.profile_resolved", { runId: args.runId, taskId: args.taskId, payload: resolvedBlock });
  }
  // Usage attribution: prefer the resolved capability alias (policy mode); fall
  // back to the workflow-declared alias (legacy, where resolution.alias is unset).
  const usageAlias = args.resolution.alias ?? args.workflowAlias;
  // AWN-7: provider/model drive the per-provider usage parser (openai → codex
  // JSONL; else claude stream-json). Undefined in legacy mode → claude parser.
  const usageMeta = {
    ...(usageAlias ? { alias: usageAlias } : {}),
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

  writeTaskManifest(dir, {
    taskId: args.taskId,
    runId: args.runId,
    files: { prompt: "CLAUDE.md", package: "package.md", result: "result.json", stdout: "container.stdout.log", stderr: "container.stderr.log" },
    container: { name: `forge-${args.taskId}`, idleTimeoutMs },
    auth: { profileRequested: !!args.authProfile, stateMounted: !!authStateHostPath },
    ...(manifestModelBlock(args.resolution) ? { model: manifestModelBlock(args.resolution) } : {}),
  });

  const spawnCtx: SpawnContext = {
    TASK_ID: args.taskId,
    TASK_DIR: dir,
    PROJECT_DIR: args.projectDir,
    PROJECT_MODE: args.projectMode,
    MODEL: args.resolution.model,
    SYSTEM_PROMPT: args.taskPackage.composedSystemPrompt,
    TASK_PACKAGE_MARKDOWN: renderTaskPackage(args.taskPackage),
    DESIGN_DIR: args.designDir,
    AUTH_STATE_HOST_PATH: authStateHostPath,
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

  const exec = args.dockerExec ?? defaultDockerExec;
  const stdoutPath = join(dir, "container.stdout.log");
  const containerName = `forge-${args.taskId}`;
  logEvent("container.started", { runId: args.runId, taskId: args.taskId, payload: { containerName } });
  let exitCode: number;
  try {
    exitCode = await exec({
      args: dockerArgs.args,
      stdin: dockerArgs.stdin,
      stdoutPath,
      stderrPath: join(dir, "container.stderr.log"),
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

  // #173: the watchdog killed a hung agent (no stdout within the idle timeout).
  // Fail with a clear reason rather than a generic container_crash.
  if (exitCode === IDLE_TIMEOUT_EXIT_CODE) {
    logEvent("container.idle_timeout", { runId: args.runId, taskId: args.taskId, payload: { containerName, exitCode } });
    const msg = `idle_timeout (no agent output for ${Math.round(idleTimeoutMs / 60000)}m)`;
    failTask(args.taskId, { runId: args.runId, kind: classify({ exitCode }), error: msg });
    return { kind: "failed", error: msg };
  }

  logEvent("container.exited", { runId: args.runId, taskId: args.taskId, payload: { containerName, exitCode } });

  const resultPath = join(dir, "result.json");
  const resultRaw = existsSync(resultPath) ? readFileSync(resultPath, "utf8").trim() : "";
  if (exitCode !== 0 && !resultRaw) {
    const msg = `container_crash (exit ${exitCode})`;
    failTask(args.taskId, { runId: args.runId, kind: classify({ exitCode, resultState: "missing" }), error: msg });
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
    const msg = "no_result_json";
    failTask(args.taskId, { runId: args.runId, kind: classify({ resultState: "missing" }), error: msg });
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

function homeForge(): string {
  return process.env.FORGE_HOME ?? join(process.env.HOME ?? "/", ".forge");
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
  return [
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
