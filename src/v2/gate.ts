// forge v2 — gate: mark a task complete/failed, optionally seed re-dispatch.
//
// Unlike v1's gate.ts, this does NOT proactively create next-phase tasks.
// In v2 the runner's ready-queue picks up unblocked successors on the next
// runNext call. Gate's only job is to set the primary task's final status
// and, for non-advance decisions, seed a fresh `pending` task that the
// runner will pick up.
//
// Decision matrix:
//   - advance           → mark task complete (runner picks up successors)
//   - reject (no onRej) → mark task failed (run effectively halts there)
//   - reject + on_reject → mark task failed + insert pending task in on_reject step
//   - request-changes   → mark task failed + insert pending task in SAME step
//                         with `requestedChanges` in inputs (rationale)
//
// Verdict re-check on advance mirrors v1 behavior (#110), widened by FG-482
// so it isn't scoped to gate: "verdict" steps only — an authoritative red
// fail must block advance under any gate mode (auto/human/verdict), since
// blocked_by_red is reachable regardless of the step's declared gate:
//   - any authoritative fail → block unless --force
//   - any specialist fail → require --rationale
//
// blocked_by_red also requires --force to advance.

import type { GateDecision, RedAuthority, Task, TaskPackage, VerdictRow } from "../types/index.js";
import { getTask, setTaskStatus, setTaskParentId, insertTask, markTaskComplete, updateTaskPackageInputs } from "../store/tasks.js";
import { getDb, writeTransaction } from "../store/db.js";
import { crashPoint } from "./crash-points.js";
import { verdictsForTask } from "../store/verdicts.js";
import { reviewsForTask, reviewsForRun, findingsForReview } from "../store/reviews.js";
import { assessEvidenceLedGate, renderDispositionRefusal, REVIEW_DISPOSITION_GATE } from "./review-gate.js";
import { insertGate } from "../store/gates.js";
import { getRun } from "../store/runs.js";
import { logEvent, eventsForTask } from "../store/events.js";
import { finalizeContainerRetention } from "./docker-exec.js";
import { newGateId, newTaskId, nowIso } from "../util/ids.js";
import { loadWorkflow } from "./loader.js";
import { resolveSeedGeneration } from "./seed-generation.js";
import type { Workflow, Step } from "./schema.js";
import { tasksForRun } from "../store/tasks.js";
import { failTask, classify } from "./failure-kind.js";
import { isRunSettled, isOnRejectRecoveryTask, classifyRunTerminalState } from "./ready-queue.js";
import { finalizeRunIfSettled } from "./run-finalize.js";

export type GateOptions = {
  force?: boolean;
  decidedBy?: string;
};

export type AggregatedVerdict = {
  verdict: "pass" | "fail" | "inconclusive";
  authoritativeFails: VerdictRow[];
  specialistFails: VerdictRow[];
};

// FG-523 (F16): the ONE rule for "does this verdict block the gate?", applied by
// both consumers — dispatch (runNext, from the in-hand red config) and this
// module's gate re-check (from the persisted row). gate_on_verdict is nullable
// on the row: a legacy verdict written before the column existed reads back
// null/undefined and blocks, preserving pre-migration behavior (fail closed).
// Only an explicit `false` opts a fail out of blocking.
export function verdictBlocksGate(v: {
  verdict: VerdictRow["verdict"];
  authority: RedAuthority;
  gateOnVerdict?: boolean | null;
}): boolean {
  return v.verdict === "fail" && v.authority === "authoritative" && v.gateOnVerdict !== false;
}

export function aggregateVerdicts(verdicts: VerdictRow[]): AggregatedVerdict {
  const authoritativeFails = verdicts.filter(verdictBlocksGate);
  const specialistFails = verdicts.filter(
    (v) => v.verdict === "fail" && v.authority === "specialist",
  );
  if (authoritativeFails.length > 0) {
    return { verdict: "fail", authoritativeFails, specialistFails };
  }
  if (verdicts.length > 0 && verdicts.every((v) => v.verdict === "pass")) {
    return { verdict: "pass", authoritativeFails, specialistFails };
  }
  return { verdict: "inconclusive", authoritativeFails, specialistFails };
}

export type GateResult = {
  task: Task;
  // Tasks created as a follow-up (request-changes redispatch, reject->on_reject).
  // The runner picks these up on the next runNext call.
  nextTasks: Task[];
};

export async function gate(
  taskId: string,
  decision: GateDecision,
  rationale: string | undefined,
  opts: GateOptions = {},
): Promise<GateResult> {
  const task = getTask(taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);

  const blocked = task.status === "blocked_by_red";
  if (blocked && !opts.force) {
    throw new Error(
      `Task ${taskId} is blocked_by_red. Re-run with --force --rationale "..." to override.`,
    );
  }
  if (blocked && opts.force && (!rationale || rationale.trim() === "")) {
    throw new Error(
      `Cannot force-advance blocked_by_red task ${taskId}: --rationale is required (it is the human decision record).`,
    );
  }
  // FG-425 (AC5): refused, and refused BY NAME — including under --force. There is no
  // human decision to record here: the task's publication is UNSETTLED, and advancing
  // (or rejecting) it would write a terminal task row over an attempt still recorded
  // `publishing`. Converge the publication first; then the task lands on the truth and
  // any gate it actually has is decided against a settled record.
  if (task.status === "awaiting_recovery") {
    throw new Error(
      `Task ${taskId} lost the publication window AFTER its target-ref advance landed — its publication is not ` +
        `settled, so there is nothing to gate yet (and --force cannot settle it). Its candidate may ALREADY be on ` +
        `the target. Run \`forge next ${task.runId}\` to converge the publication (AD-5) and reconcile the task; ` +
        `\`forge show ${taskId}\` names the attempt.`,
    );
  }
  if (task.status !== "awaiting_gate" && !blocked) {
    throw new Error(
      `Task ${taskId} is in status '${task.status}', not awaiting_gate. Cannot gate.`,
    );
  }

  const run = getRun(task.runId);
  if (!run) throw new Error(`Run not found for task ${taskId}`);
  // FG-583: anchor the seed generation once so gate's workflow read and any dispatch
  // it triggers observe ONE complete generation. No per-consumer seed-state gating —
  // loadWorkflow below refuses (named, repairable) at the loader's single resolve
  // point when no complete generation is published, so a gate advance can never
  // re-enter dispatch under a torn/incomplete/flat surface.
  const seedGeneration = resolveSeedGeneration();
  const workflow = loadWorkflow(run.workflow, { projectDir: run.projectDir, seedGeneration });
  const step = findStep(workflow, task.phase);
  if (!step) throw new Error(`Step '${task.phase}' not in workflow '${workflow.name}'`);

  // FG-640: WHICH GATE DECIDES THIS STEP. Exactly one authority model per run — an
  // evidence_led run's reviewed step is settled by the review ledger (`review_disposition`),
  // a legacy run's by verdict aggregation, and neither ever runs alongside the other.
  //
  // THE WORKFLOW'S DECLARATION IS THE SOURCE, because the workflow file is where the explicit
  // cutover lives and it is the same value `dispatchReds` selects lenses from — one source
  // read by both sites, so a narrowed panel and the gate that judges it can never disagree.
  // The run row is the durable per-run record (and FG-638's reconciliation anchor); when the
  // two disagree the run was moved between models after creation, and `review_mode_drift`
  // refuses by name rather than silently picking one.
  //
  // Scoped to a `gate: verdict` step on purpose: that is the position the disposition gate
  // REPLACES. A human or auto gate on an evidence-led run keeps its own meaning, so migrating
  // a workflow does not silently attach a ledger requirement to its architect and plan steps.
  const evidenceLed = workflow.review_mode === "evidence_led" && step.gate === "verdict";

  if (decision === "advance" && !opts.force && evidenceLed) {
    const runMode = run.reviewMode ?? "legacy_verdict";
    const { review, assessment } = assessEvidenceLedGate({
      taskId,
      reviews: reviewsForTask(taskId),
      runReviews: reviewsForRun(task.runId),
      findingsFor: findingsForReview,
      verdicts: verdictsForTask(taskId),
      declaredReds: step.reds,
      ...(runMode !== workflow.review_mode
        ? { modeDrift: { runMode, workflowMode: workflow.review_mode } }
        : {}),
    });
    if (assessment.blocked) {
      throw new Error(renderDispositionRefusal(taskId, review?.id ?? "(none)", assessment));
    }
  }

  // Verdict re-check on advance. Legacy authority only — see the evidence_led branch above.
  if (decision === "advance" && !opts.force && !evidenceLed) {
    const verdicts = verdictsForTask(taskId);
    const agg = aggregateVerdicts(verdicts);
    if (agg.verdict === "fail") {
      throw new Error(
        `Cannot advance ${taskId}: verdict aggregation = fail. Authoritative fails: ${agg.authoritativeFails
          .map((v) => v.redRole)
          .join(", ")}. Override with --force --rationale "...".`,
      );
    }
    if (agg.specialistFails.length > 0 && !rationale) {
      throw new Error(
        `Specialist red(s) failed on ${taskId}: ${agg.specialistFails
          .map((v) => v.redRole)
          .join(", ")}. Provide --rationale to advance over their objections.`,
      );
    }
  }

  // Atomic: both writes must succeed together so a crash cannot leave the
  // gates table with a row that has no matching events-table entry —
  // FG-427 makes the events table the sole source for outcome derivation.
  crashPoint("gate:before-decision-write");
  writeTransaction(() => {
    insertGate({
      id: newGateId(),
      taskId,
      decision,
      rationale,
      decidedAt: nowIso(),
      decidedBy: opts.decidedBy ?? "steven",
    });
    crashPoint("gate:inside-decision-write-txn");
    logEvent("gate.decided", {
      runId: run.id,
      taskId,
      payload: {
        decision,
        rationale,
        force: opts.force ?? false,
        // FG-640: only on the steps the new gate actually decides, so a legacy run's audit
        // payload is byte-identical to what it has always been.
        ...(evidenceLed ? { gateKind: REVIEW_DISPOSITION_GATE } : {}),
      },
    });
  });
  crashPoint("gate:after-decision-write");

  let nextTasks: Task[] = [];

  if (decision === "advance") {
    const isFanoutParent = typeof task.taskPackage?.inputs?.["fanout"] === "object";
    // FG-425: a blocked_by_red task's work is UNPUBLISHED. The publisher validates
    // the candidate (gate → reds → review) and only publishes if all of it passes,
    // so a red rejection means nothing reached the target. Force-advancing over that
    // rejection is the human saying "publish it anyway" — and it can only mean that
    // if the advance actually re-enters dispatch and publishes.
    //
    // Before FG-425 only a FANOUT parent re-entered (its integration branch still
    // needed merging to HEAD); a non-fanout task had already been merged BEFORE the
    // reds ran, so completing it in place was enough. That merge is exactly the
    // defect FG-425 removed — so now BOTH shapes need the re-entry, or a forced
    // advance would mark the task complete and silently drop its work.
    //
    // A task with no worktree published nothing and has nothing to publish (the
    // non-worktree path never enters the publisher): complete it in place, as before.
    const needsPublishReentry = blocked && (isFanoutParent || typeof task.worktreePath === "string");
    if (needsPublishReentry) {
      // Set gateForced in inputs so dispatch detects re-entry, then transition to
      // pending so the runner picks it up.
      // Atomic: both writes must succeed together so a crash cannot leave
      // the task in blocked_by_red with gateForced:true set (wedged).
      crashPoint("gate:advance:fanout-reentry:before-reentry-write");
      writeTransaction(() => {
        updateTaskPackageInputs(taskId, { ...task.taskPackage.inputs, gateForced: true });
        crashPoint("gate:advance:fanout-reentry:inside-reentry-write-txn");
        setTaskStatus(taskId, "pending");
      });
      crashPoint("gate:advance:fanout-reentry:after-reentry-write");
      return { task: getTask(taskId)!, nextTasks: [] };
    }
    // Non-fanout or non-blocked advance: unchanged.
    markTaskComplete(taskId, task.result);
    crashPoint("gate:advance:between-complete-status-and-event");
    logEvent("task.completed", { runId: run.id, taskId });
    crashPoint("gate:advance:after-complete-write");

    // FG-492 final round: this task paused at a human/verdict gate with its
    // container retained per the outcome-keyed policy (awaiting_gate is not
    // "complete", so runNext.ts's own finalizeContainerRetention call kept
    // it). Reconcile's reap sweep only ever revisits tasks that are still
    // `running` — this task left `running` the moment it became awaiting_gate
    // — so nothing else ever reaps this container once it advances here. Now
    // that it's genuinely complete, reap best-effort. Only tasks with their
    // own agent container (containerName forge-<taskId>) reach this — manual
    // steps and fanout parents never emit container.started for themselves,
    // same signal reconcile.ts gates its own container logic on.
    if (eventsForTask(taskId).some((e) => e.eventType === "container.started")) {
      const containerName = `forge-${taskId}`;
      const reapOutcome = finalizeContainerRetention(containerName, true);
      // FG-503: reap_failed on this success path is a silent, unsweepable leak
      // (docker rm errored; container + DEC-019 shadow volume left behind) —
      // record it so `forge ops reap-containers`/`forge ops check` can pick it
      // up later. Best-effort: a logging failure must never block the gate advance.
      if (reapOutcome === "reap_failed") {
        try {
          logEvent("container.reap_failed", {
            runId: run.id,
            taskId,
            payload: { containerName, why: "docker rm -f -v failed after gate advance-to-complete; container may still be running/present with its anonymous shadow volume" },
          });
        } catch {
          // best-effort — see comment above
        }
      }
    }

    // If this was the last step (no step depends on it) and every primary
    // task is now terminal, mark the run complete. The runner does this on
    // its own when called, but the CLI's UX is "user gates, returns to prompt"
    // — we don't want them to need a follow-up `forge next` just to flip the
    // run row.
    finalizeRunIfDone(run.id, workflow);
  } else if (decision === "reject") {
    // Atomic: failTask (markTaskFailed + task.failed event) and the conditional
    // on_reject recovery insert (+ its task.created event) must land together.
    // A crash between failTask committing and the recovery insert would leave
    // a rejected task terminally failed with no recovery task and no audit
    // trail — mirrors the fanout re-entry transaction below and dispatchReds'
    // verdict-insert transaction in runNext.ts.
    crashPoint("gate:reject:before-fail-write");
    writeTransaction(() => {
      // FG-532: pass the task's persisted result through, matching the
      // request-changes branch — the rejected artifact is the audit record
      // for WHY it was rejected; failTask without it NULLs the row's result.
      failTask(taskId, {
        runId: run.id,
        kind: classify({ source: "gate_rejected" }),
        error: rationale ?? "rejected by gate",
        result: task.result,
      });
      crashPoint("gate:reject:inside-txn-between-fail-and-recovery-mint");

      if (step.on_reject) {
        const targetStep = findStep(workflow, step.on_reject);
        if (!targetStep) {
          throw new Error(
            `step '${step.id}' on_reject references unknown step '${step.on_reject}'`,
          );
        }

        // Dedup: if a pending on_reject recovery row already exists in the
        // target phase, update its rejectedRationale/rejectedTaskId lineage
        // inputs instead of inserting a second row — mirrors the
        // request-changes dedup below. Two pending recovery rows in the same
        // phase would silently orphan the newer rationale (FG-476).
        const existingRecovery = tasksForRun(task.runId).find(
          (t) => t.phase === targetStep.id && t.status === "pending" && isOnRejectRecoveryTask(t),
        );

        if (existingRecovery) {
          updateTaskPackageInputs(existingRecovery.id, {
            ...existingRecovery.taskPackage.inputs,
            rejectedRationale: rationale ?? "",
            rejectedTaskId: taskId,
          });
          crashPoint("gate:reject:dedup:inside-txn-between-inputs-and-lineage");
          // Keep the durable parentId column aligned with the inputs above —
          // the dedup exists to carry the newer rationale, so lineage must
          // follow the newer reject too, not stay pinned to the first rejector.
          setTaskParentId(existingRecovery.id, taskId);
          crashPoint("gate:reject:dedup:inside-txn-between-lineage-and-event");
          const updatedRecovery = getTask(existingRecovery.id);
          if (!updatedRecovery) {
            throw new Error(
              `reject->on_reject dedup: task ${existingRecovery.id} vanished after updateTaskPackageInputs`,
            );
          }
          logEvent("gate.decided", {
            runId: run.id,
            taskId: existingRecovery.id,
            payload: { decision: "reject-on_reject-dedup", rationale },
          });
          nextTasks = [updatedRecovery];
        } else {
          // Insert a fresh pending task in the on_reject step. The runner's
          // ready-queue will pick it up. Inject the rejection rationale into
          // inputs so the on_reject agent has context.
          const newId = newTaskId(targetStep.id);
          const tp: TaskPackage = {
            taskId: newId,
            runId: task.runId,
            phase: targetStep.id,
            role: targetStep.agent ?? task.agentRole,
            // FG-512: runner-minted on_reject recovery row — total dispatch provenance.
            dispatchSource: "workflow",
            inputs: {
              rejectedRationale: rationale ?? "",
              rejectedTaskId: taskId,
            },
            composedSystemPrompt: "",
          };
          const newTask: Task = {
            id: newId,
            runId: task.runId,
            parentId: taskId,
            phase: targetStep.id,
            agentRole: targetStep.agent ?? task.agentRole,
            agentAlias: targetStep.activity,
            status: "pending",
            taskPackage: tp,
            createdAt: nowIso(),
          };
          insertTask(newTask);
          crashPoint("gate:reject:inside-txn-between-recovery-mint-and-event");
          logEvent("task.created", {
            runId: run.id,
            taskId: newId,
            payload: { from: "reject->on_reject" },
          });
          nextTasks = [newTask];
        }
      }
    });
    crashPoint("gate:reject:after-recovery-mint");
    // A rejected gate with no on_reject leaves this step terminally failed with
    // no replacement task — parity with the advance branch's finalizeRunIfDone
    // call. Without this, a gate-rejected step whose failure makes every
    // remaining step permanently unreachable would leave the run stuck at
    // status "active" forever (no runNext call ever flips it, since
    // computeReadyQueue's ready queue is empty and nothing dispatches again).
    // When on_reject DID fire, the fresh pending recovery task above keeps its
    // target phase's settle-state "active" — computeStepSettleStates treats a
    // live (pending/running) recovery task as unsettled regardless of that
    // phase's original (pre-reject) primary being complete — so this call is
    // correctly a no-op until the recovery task itself resolves.
    finalizeRunIfDone(run.id, workflow);
  } else if (decision === "request-changes") {
    if (step.manual) {
      throw new Error(
        `Task ${taskId} is in a manual step ('${step.id}'); request-changes is not supported. Use 'reject' to loop back to '${step.on_reject ?? "the prior step"}', or re-submit with corrected artifacts.`,
      );
    }
    // Fail the old task, preserving its result so it stays an audit record.
    crashPoint("gate:request-changes:before-fail-write");
    failTask(taskId, {
      runId: run.id,
      kind: classify({ source: "gate_rejected" }),
      error: "request-changes; superseded",
      result: task.result,
    });
    crashPoint("gate:request-changes:between-fail-and-replacement-mint");

    // Dedup: if a pending replacement primary already exists for this phase,
    // update its requestedChanges instead of creating a second pending primary.
    // dispatchFanoutStep .find() picks the oldest pending; two pending primaries
    // would silently orphan the newer rationale.
    const existingPending = tasksForRun(task.runId).find(
      (t) => t.phase === task.phase && t.parentId === undefined && t.status === "pending",
    );

    if (existingPending) {
      updateTaskPackageInputs(existingPending.id, { requestedChanges: rationale ?? "" });
      crashPoint("gate:request-changes:dedup:between-inputs-and-event");
      const updatedPending = getTask(existingPending.id);
      if (!updatedPending) {
        throw new Error(
          `request-changes dedup: task ${existingPending.id} vanished after updateTaskPackageInputs`,
        );
      }
      logEvent("gate.decided", {
        runId: run.id,
        taskId: existingPending.id,
        payload: { decision: "request-changes-dedup", rationale },
      });
      nextTasks = [updatedPending];
    } else {
      const newId = newTaskId(task.phase);
      const tp: TaskPackage = {
        ...task.taskPackage,
        taskId: newId,
        // FG-512: runner-minted request-changes replacement row — stamp explicitly
        // so provenance is total even when the rejected primary was a legacy
        // marker-less row (the spread above would otherwise carry nothing).
        dispatchSource: "workflow",
        composedSystemPrompt: "",
        inputs: {
          ...task.taskPackage.inputs,
          requestedChanges: rationale ?? "",
        },
      };
      const newTask: Task = {
        id: newId,
        runId: task.runId,
        // parentId intentionally absent — primary task, not a child. The runner's
        // "reuse pending row in same step" logic requires this (AWN-3).
        phase: task.phase,
        agentRole: task.agentRole,
        agentAlias: task.agentAlias,
        status: "pending",
        taskPackage: tp,
        createdAt: nowIso(),
      };
      insertTask(newTask);
      crashPoint("gate:request-changes:between-replacement-mint-and-event");
      logEvent("task.created", {
        runId: run.id,
        taskId: newId,
        payload: { from: "request-changes" },
      });
      nextTasks = [newTask];
    }
  }
  crashPoint("gate:after-branch");

  return { task: getTask(taskId)!, nextTasks };
}

export function findStep(workflow: Workflow, stepId: string): Step | undefined {
  return workflow.steps.find((s) => s.id === stepId);
}

// After an advance, if every step has a complete primary task and no work is
// pending or running, flip the run to "complete". The runner already does
// this, but gate runs in the user's foreground call — without finalizing
// here, the run row would still say "active" until the user runs `forge next`
// or `forge status` again. finalizeRunIfSettled carries the abandoned re-read
// (FG-484): a concurrent `forge cancel` may have abandoned the run between
// this gate decision and here, and an abandoned run must never be resurrected
// to complete.
function finalizeRunIfDone(runId: string, workflow: Workflow): void {
  const tasks = tasksForRun(runId);
  // FG-585: classify to the CORRECT terminal state (null = not settled). A gate
  // reject that leaves a required phase permanently blocked settles the run to
  // "failed", not "complete".
  const classification = classifyRunTerminalState(workflow, tasks);
  if (!classification) return;
  finalizeRunIfSettled(runId, classification.status, "gate", {
    failedPhases: classification.failedPhases.join(",") || undefined,
    unreachablePhases: classification.unreachablePhases.join(",") || undefined,
  });
}

export type BatchGateResult = {
  runId: string;
  decision: GateDecision;
  gated: Array<{ taskId: string; followups: number }>;
  skippedBlocked: Array<{ taskId: string; phase: string }>;
  failed: Array<{ taskId: string; error: string }>;
};

export async function batchGate(
  runId: string,
  decision: GateDecision,
  rationale: string | undefined,
  opts: GateOptions = {},
): Promise<BatchGateResult> {
  const run = getRun(runId);
  if (!run) throw new Error(`Run not found: ${runId}`);
  if (decision !== "advance") {
    throw new Error(
      `batchGate currently supports 'advance' only. ${decision} typically needs per-task rationale; gate those individually.`,
    );
  }

  const tasks = tasksForRun(runId);
  const eligible = tasks.filter((t) => t.status === "awaiting_gate");
  const blocked = tasks.filter((t) => t.status === "blocked_by_red");

  const result: BatchGateResult = {
    runId,
    decision,
    gated: [],
    skippedBlocked: blocked.map((t) => ({ taskId: t.id, phase: t.phase })),
    failed: [],
  };

  for (const t of eligible) {
    try {
      const r = await gate(t.id, decision, rationale, opts);
      result.gated.push({ taskId: t.id, followups: r.nextTasks.length });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      result.failed.push({ taskId: t.id, error: msg });
    }
  }

  return result;
}
