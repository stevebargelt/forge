import { existsSync } from "node:fs";
import { join } from "node:path";
import { invoke } from "../v2/invoke.js";
import type { InvokeArgs, InvokeResult } from "../v2/invoke.js";
import { evaluateReadiness } from "../readiness/readiness.js";
import {
  getCampaign,
  getCampaignItem,
  listCampaignItems,
  updateCampaignItem,
  updateCampaignItemIfCampaignPaused,
  updateCampaignPlanForReapproval,
  tryTransitionCampaign,
  tryTransitionCampaignToRunning,
} from "../store/campaigns.js";
import { tasksForRun } from "../store/tasks.js";
import type { Campaign, CampaignItem, CampaignItemLifecycleStatus, CampaignItemOutcome, BlockerKind, Run } from "../types/index.js";
import { resolvePlan, sourceInputToPlannerInput, getItemPlanEntry } from "./planner.js";
import type { PlannerInput, PlanMode, ExecutionLane, ItemModeOverride } from "./planner.js";
import { listTickets, readTicket } from "../backlog/structured.js";
import type { StructuredTicket } from "../backlog/structured.js";
import { getRun, insertRun, updateRunStatus } from "../store/runs.js";
import { newRunId, nowIso } from "../util/ids.js";
import { failureKindForTask } from "../v2/failure-kind.js";
import {
  classifyFailureKind,
  isSharedBlocker,
  relationToBlocked,
  evaluateContinuePolicy,
} from "./policy.js";
import { startRun, CONTROL_PLANE_METADATA_KEYS } from "../v2/startRun.js";
import type { StartRunArgs } from "../v2/startRun.js";
import { runNext } from "../v2/runNext.js";
import type { RunNextResult } from "../v2/runNext.js";
import { loadWorkflow } from "../v2/loader.js";
import type { LoadContext } from "../v2/loader.js";
import { aggregateVerdicts, gate, findStep } from "../v2/gate.js";
import type { Workflow } from "../v2/schema.js";
import { verdictsForTask } from "../store/verdicts.js";
import { evaluateDoneAudit } from "../done-audit/done-audit.js";
import type { DoneAuditResult } from "../done-audit/done-audit.js";
import { collectDoneAuditInputFor } from "../done-audit/collect.js";
import { collectAuthoritativeEvents } from "./reconcile-collect.js";
import { evaluateAuthoritativeOutcome } from "./reconcile-evidence.js";
import { assessRunDocsImpact, formatDocsImpactWarning } from "../v2/docs-impact.js";

// Test-only override for done-audit evaluation in reconcileTerminalOutcome.
// Lets unit tests inject known results without real git/filesystem access.
let _testDoneAuditMapOverride: Map<string, DoneAuditResult> | null = null;
export function setExecutorDoneAuditMapForTest(map: Map<string, DoneAuditResult> | null): Map<string, DoneAuditResult> | null {
  const prev = _testDoneAuditMapOverride;
  _testDoneAuditMapOverride = map;
  return prev;
}

export type CampaignStopReason =
  | "not_planned"
  | "no_project_dir"
  | "invalid_project_dir"
  | "dry_run_not_executable"
  | "not_approved"
  | "stale_plan"
  | "plan_unresolvable"
  | "already_running"
  | "not_paused"
  | "paused"
  | "abandoned"
  | "item_failed"
  | "complete"
  | "recovery_needed";

export type CampaignItemRecord = {
  itemId: string;
  ticketId: string;
  runId?: string;
  lifecycleStatus: CampaignItemLifecycleStatus;
  outcome?: CampaignItemOutcome;
  blockerKind?: BlockerKind;
  reason?: string;
};

function hasBacklog(dir: string): boolean {
  return existsSync(join(dir, "backlog"));
}

// Re-exported for existing external callers — now a single shared implementation
// (see planner.ts). Previously executor.ts and report.ts each held their own
// copy; report.ts's silently dropped itemOverrides, which is exactly the drift
// the FG-442 lane data can't tolerate.
export { sourceInputToPlannerInput };

// Pure precondition evaluator — no DB writes. Returns the first blocking stop reason or null.
// In-flight check is status-agnostic and always runs first.
export function campaignBlocker(
  campaign: Campaign,
  items: CampaignItem[],
  intent: "start" | "resume"
): CampaignStopReason | null {
  // awaiting_gate and blocked_by_red are explicitly parked workflow states — they
  // are resumable and must NOT trigger recovery_needed.
  const inFlight = items.find(
    (i) =>
      i.lifecycleStatus !== "pending" &&
      i.lifecycleStatus !== "complete" &&
      i.lifecycleStatus !== "failed" &&
      i.lifecycleStatus !== "awaiting_gate" &&
      i.lifecycleStatus !== "blocked_by_red"
  );
  if (inFlight) return "recovery_needed";

  if (intent === "start") {
    if (campaign.status !== "planned") return "not_planned";
    const dir = campaign.projectDir;
    if (!dir) return "no_project_dir";
    if (!existsSync(dir) || !hasBacklog(dir)) return "invalid_project_dir";
    if (campaign.mode !== "pilot" && campaign.mode !== "sequential") return "dry_run_not_executable";
    if (!campaign.approvedPlanHash) return "not_approved";
    let startHash: string;
    try {
      const { planHash } = resolvePlan(sourceInputToPlannerInput(campaign.sourceInput), {
        projectDir: dir,
        mode: campaign.mode as PlanMode,
      });
      startHash = planHash;
    } catch {
      return "plan_unresolvable";
    }
    if (startHash !== campaign.approvedPlanHash) return "stale_plan";
    return null;
  } else {
    if (campaign.status !== "paused") return "not_paused";
    const dir = campaign.projectDir;
    if (!dir) return "no_project_dir";
    if (!existsSync(dir) || !hasBacklog(dir)) return "invalid_project_dir";
    if (!campaign.approvedPlanHash) return "not_approved";
    let resumeHash: string;
    try {
      const { planHash } = resolvePlan(sourceInputToPlannerInput(campaign.sourceInput), {
        projectDir: dir,
        mode: campaign.mode as PlanMode,
      });
      resumeHash = planHash;
    } catch {
      return "plan_unresolvable";
    }
    if (resumeHash !== campaign.approvedPlanHash) return "stale_plan";
    return null;
  }
}

type BlockedItemEntry = {
  id: string;
  ticket: StructuredTicket;
  blockerKind: BlockerKind;
};

// Evaluate whether a later item should be held given the current set of blocked items.
// Returns { hold: true, reason, holderId } or { hold: false }.
function evaluateForHold(
  laterTicket: StructuredTicket | undefined,
  blockedItems: BlockedItemEntry[],
  mode: string
): { hold: true; reason: string; holderId: string } | { hold: false } {
  if (!blockedItems.length) return { hold: false };

  for (const blocker of blockedItems) {
    const rel = laterTicket
      ? relationToBlocked({ id: blocker.id, related: blocker.ticket.related }, { id: laterTicket.id, related: laterTicket.related })
      : "unknown";
    const policy = evaluateContinuePolicy(blocker.blockerKind, rel, mode);

    if (policy === "hold_dependents" || policy === "hold_campaign") {
      const reason =
        rel === "dependent"
          ? `held because related to blocked item ${blocker.id}`
          : `held because dependency relation is unknown in sequential mode`;
      return { hold: true, reason, holderId: blocker.id };
    }
  }
  return { hold: false };
}

// Reason string for a continued (not held) item, for informational recording.
function continueReason(
  laterTicket: StructuredTicket | undefined,
  blockedItems: BlockedItemEntry[],
  mode: string
): string {
  if (blockedItems.length === 1) {
    const blockedItem = blockedItems[0]!;
    const rel = laterTicket
      ? relationToBlocked({ id: blockedItem.id, related: blockedItem.ticket.related }, { id: laterTicket.id, related: laterTicket.related })
      : "unknown";
    if (rel === "unknown" && mode === "pilot") return "continued because relation unknown and mode=pilot";
    return "continued because related metadata does not link to blocked item";
  }
  // Multiple blockers: don't falsely name only the last one — check if pilot+unknown applies
  if (mode === "pilot") {
    for (const b of blockedItems) {
      const rel = laterTicket
        ? relationToBlocked({ id: b.id, related: b.ticket.related }, { id: laterTicket.id, related: laterTicket.related })
        : "unknown";
      if (rel === "unknown") return "continued because relation unknown and mode=pilot";
    }
  }
  return "continued because item is independent of all blocked items";
}

export type CampaignRunResult = {
  stopReason: CampaignStopReason;
  itemRecords: CampaignItemRecord[];
};

// FG-442: the explicit, well-known "outgrew my lane" signal an agent's
// structured result.json may carry. Checked for a NAMED field only — never
// inferred from a generic failure (a model/tool error is scope, not escalation).
type LaneEscalationSignal = { reason: string; suggestedLane?: ExecutionLane };

function extractLaneEscalationSignal(result: unknown): LaneEscalationSignal | null {
  if (typeof result !== "object" || result === null) return null;
  const r = result as Record<string, unknown>;
  const le = r["laneEscalation"];
  if (typeof le !== "object" || le === null) return null;
  const lo = le as Record<string, unknown>;
  const reason = typeof lo["reason"] === "string" ? lo["reason"] : "agent reported outgrowing its assigned lane";
  const suggestedLane = typeof lo["suggestedLane"] === "string" ? (lo["suggestedLane"] as ExecutionLane) : undefined;
  return { reason, ...(suggestedLane ? { suggestedLane } : {}) };
}

// One opts.dispatch call, shared by every single-invoke-style lane (docs_only/
// test_only/review_only/research_only, and each half of quick_implementation's
// engineer->test-engineer chain). Detects the lane-escalation signal BEFORE the
// normal complete/failed branching — escalation is a distinct outcome, never
// inferred from a generic failure.
type LaneDispatchOutcome =
  | { status: "escalated"; signal: LaneEscalationSignal }
  | { status: "dispatch_threw"; error: string }
  | { status: "complete"; result: InvokeResult }
  | { status: "failed"; result: InvokeResult };

async function dispatchLaneInvoke(
  dispatch: (args: InvokeArgs) => Promise<InvokeResult>,
  args: InvokeArgs
): Promise<LaneDispatchOutcome> {
  let result: InvokeResult;
  try {
    result = await dispatch(args);
  } catch (err) {
    return { status: "dispatch_threw", error: err instanceof Error ? err.message : String(err) };
  }
  const signal = extractLaneEscalationSignal(result.result);
  if (signal) return { status: "escalated", signal };
  return result.status === "complete" ? { status: "complete", result } : { status: "failed", result };
}

// Finalizes a non-'complete' dispatch outcome (escalated/dispatch_threw/failed):
// updates the item, records it, and decides pause-vs-continue. Returns a
// CampaignRunResult when the caller must stop (shared blocker/escalation);
// null when a LOCAL blocker was recorded and the outer loop may continue (the
// caller still owns the cooperative-pause check before doing so).
async function finalizeInvokeDispatch(
  ctx: {
    campaignId: string;
    item: CampaignItem;
    runId: string;
    lane: ExecutionLane;
    laterTicket: StructuredTicket | undefined;
    itemRecords: CampaignItemRecord[];
    blockedItems: BlockedItemEntry[];
  },
  outcome: Exclude<LaneDispatchOutcome, { status: "complete" }>
): Promise<CampaignRunResult | null> {
  const { campaignId, item, runId, lane, laterTicket, itemRecords, blockedItems } = ctx;

  if (outcome.status === "escalated") {
    const suggestion = outcome.signal.suggestedLane ? ` — agent suggests lane '${outcome.signal.suggestedLane}'` : "";
    updateCampaignItem(item.id, {
      lifecycleStatus: "failed",
      outcome: "blocked",
      blockerKind: "lane_escalation",
      reason: outcome.signal.reason,
      requestedHumanAction: `item ${item.ticketId} outgrew lane '${lane}'${suggestion} — escalate the lane and re-approve before resuming`,
      continuePolicy: "hold_campaign",
    });
    itemRecords.push({
      itemId: item.id,
      ticketId: item.ticketId,
      runId,
      lifecycleStatus: "failed",
      outcome: "blocked",
      blockerKind: "lane_escalation",
    });
    if (tryTransitionCampaign(campaignId, "running", "paused")) {
      return { stopReason: "paused", itemRecords };
    }
    const post = getCampaign(campaignId);
    return { stopReason: post?.status === "abandoned" ? "abandoned" : "paused", itemRecords };
  }

  if (outcome.status === "dispatch_threw") {
    const blockerKind: BlockerKind = "infrastructure";
    updateRunStatus(runId, "abandoned");
    updateCampaignItem(item.id, {
      lifecycleStatus: "failed",
      outcome: "blocked",
      blockerKind,
      reason: outcome.error,
      requestedHumanAction: `resolve ${blockerKind} for ${item.ticketId} then resume`,
      continuePolicy: "hold_campaign",
    });
    itemRecords.push({ itemId: item.id, ticketId: item.ticketId, runId, lifecycleStatus: "failed", outcome: "blocked" });
    if (tryTransitionCampaign(campaignId, "running", "paused")) {
      return { stopReason: "paused", itemRecords };
    }
    const post = getCampaign(campaignId);
    return { stopReason: post?.status === "abandoned" ? "abandoned" : "paused", itemRecords };
  }

  // status === "failed" — dispatch returned, classify and apply FG-393 policy.
  const reason = outcome.result.error ?? "invoke failed";
  const failureKind = failureKindForTask(outcome.result.taskId);
  const blockerKind = classifyFailureKind(failureKind);
  const shared = isSharedBlocker(blockerKind);

  updateCampaignItem(item.id, {
    lifecycleStatus: "failed",
    outcome: "blocked",
    blockerKind,
    reason,
    requestedHumanAction: `resolve ${blockerKind} for ${item.ticketId} then resume`,
    continuePolicy: shared ? "hold_campaign" : "hold_dependents",
  });
  itemRecords.push({ itemId: item.id, ticketId: item.ticketId, runId, lifecycleStatus: "failed", outcome: "blocked" });

  if (shared) {
    if (tryTransitionCampaign(campaignId, "running", "paused")) {
      return { stopReason: "paused", itemRecords };
    }
    const post = getCampaign(campaignId);
    return { stopReason: post?.status === "abandoned" ? "abandoned" : "paused", itemRecords };
  }

  // LOCAL blocker — continue. Add to blockedItems so subsequent items can be evaluated.
  if (laterTicket) {
    blockedItems.push({ id: item.ticketId, ticket: laterTicket, blockerKind });
  } else {
    // Ticket not in ticketMap (deleted?). Use a synthetic entry with no related field
    // so downstream items get "unknown" relation and are conservatively held.
    blockedItems.push({
      id: item.ticketId,
      ticket: { id: item.ticketId, type: "story", status: "active", title: item.ticketId, body: "" } as StructuredTicket,
      blockerKind,
    });
  }
  return null;
}

// Derive terminal campaign item outcome from a completed/abandoned workflow run.
// Updates the item's lifecycleStatus and outcome in the DB.
// outcome='shipped' requires BOTH a passing authoritative outcome AND a passing done-audit.
//
// FG-427: the authoritative outcome is derived from the EFFECTIVE LATEST state
// PER REVIEWING TASK via the shared evaluateAuthoritativeOutcome (also used by
// the `forge campaign reconcile` command's Fact 5 — see reconcile-evidence.ts)
// rather than a naive aggregateVerdicts(verdictsForRun(...)) over every verdict
// ever recorded. This lets a later authoritative pass, or a recorded qualifying
// force-advance (decision:advance + force + non-empty rationale) at the gate,
// supersede an earlier authoritative fail on the SAME task — instead of any
// historical fail wedging the item forever — while still requiring at least
// one task to have an actual authoritative verdict on record (a force-advance
// alone can never substitute for authoritative review).
function reconcileTerminalOutcome(run: Run, itemId: string, projectDir?: string): void {
  if (run.status !== "complete") {
    updateCampaignItem(itemId, {
      lifecycleStatus: "failed",
      outcome: "blocked",
      blockerKind: "campaign_system",
      requestedHumanAction: `workflow run ${run.id} ended with status ${run.status}`,
    });
    return;
  }
  const { outcome } = evaluateAuthoritativeOutcome(collectAuthoritativeEvents(run.id));
  if (outcome === "pass") {
    const item = getCampaignItem(itemId);
    const ticketId = item?.ticketId;
    let auditResult: DoneAuditResult | undefined;
    if (_testDoneAuditMapOverride !== null) {
      auditResult = ticketId ? _testDoneAuditMapOverride.get(ticketId) : undefined;
    } else if (projectDir && ticketId) {
      try {
        const auditInput = collectDoneAuditInputFor(projectDir, ticketId, run.id);
        auditResult = evaluateDoneAudit(auditInput);
      } catch {
        // auditResult stays undefined — treated as unknown below
      }
    }
    if (auditResult?.outcome === "pass") {
      updateCampaignItem(itemId, { lifecycleStatus: "complete", outcome: "shipped" });
    } else {
      const auditGap = auditResult?.requestedAction ?? "done-audit not evaluated";
      updateCampaignItem(itemId, {
        lifecycleStatus: "failed",
        outcome: "blocked",
        blockerKind: "campaign_system",
        requestedHumanAction: `verdict passed but done-audit ${auditResult?.outcome ?? "unknown"}: ${auditGap}`,
      });
    }
  } else if (outcome === "fail") {
    updateCampaignItem(itemId, {
      lifecycleStatus: "failed",
      outcome: "blocked",
      blockerKind: "scope",
      requestedHumanAction: "workflow completed but authoritative reviewer verdict failed",
    });
  } else {
    // unresolved — no authoritative verdict (and no qualifying force-advance
    // superseding one) recorded for any task in this run.
    updateCampaignItem(itemId, {
      lifecycleStatus: "failed",
      outcome: "blocked",
      blockerKind: "campaign_system",
      requestedHumanAction:
        "workflow completed but no authoritative reviewer verdicts found — check workflow reds configuration",
    });
  }
}

// Injectable function types for testability.
type RunNextFn = (args: { runId: string; workflow: Workflow }) => Promise<RunNextResult>;
type StartRunFn = (args: StartRunArgs) => { runId: string };
type LoadWorkflowFn = (name: string, ctx: LoadContext) => Workflow;

// Drive a workflow run until it reaches a terminal state (complete/abandoned) or parks
// at a gate (awaiting_gate / blocked_by_red). Updates campaign item state in the DB.
//
// Returns 'paused' when the campaign must stop (human gate, blocked reviewer, or
// shared-blocker terminal outcome). Returns 'continue' for terminal outcomes that
// do not require halting the campaign (shipped or scope-fail — caller handles policy).
async function driveWorkflowItem(
  campaignId: string,
  item: CampaignItem,
  runId: string,
  workflow: Workflow,
  fns: {
    runNextFn: RunNextFn;
    gateFn?: typeof gate;
    projectDir?: string;
  } = { runNextFn: runNext },
): Promise<{ outcome: "continue" | "paused"; itemRecord: CampaignItemRecord }> {
  const itemId = item.id;
  const ticketId = item.ticketId;
  const doGate = fns.gateFn ?? gate;

  while (true) {
    // Step 1/2: Re-read run from DB; check for terminal status.
    const currentRun = getRun(runId);
    if (!currentRun || currentRun.status !== "active") {
      const termRun: Run = currentRun ?? {
        id: runId,
        workflow: workflow.name,
        title: ticketId,
        status: "abandoned",
        createdAt: nowIso(),
      };
      reconcileTerminalOutcome(termRun, itemId, fns.projectDir);
      const updatedItem = getCampaignItem(itemId);
      const bk = updatedItem?.blockerKind;
      // campaign_system is a shared blocker — pause the campaign
      if (bk && isSharedBlocker(bk)) {
        tryTransitionCampaign(campaignId, "running", "paused");
        return {
          outcome: "paused",
          itemRecord: {
            itemId,
            ticketId,
            runId,
            lifecycleStatus: updatedItem?.lifecycleStatus ?? "failed",
            outcome: updatedItem?.outcome,
            blockerKind: bk,
          },
        };
      }
      // scope-fail or shipped — let the caller decide continue policy
      return {
        outcome: "continue",
        itemRecord: {
          itemId,
          ticketId,
          runId,
          lifecycleStatus: updatedItem?.lifecycleStatus ?? "failed",
          outcome: updatedItem?.outcome,
          blockerKind: bk,
        },
      };
    }

    // Step 3: blocked_by_red takes priority.
    const tasks = tasksForRun(runId);
    const blockedRedTask = tasks.find((t) => t.status === "blocked_by_red");
    if (blockedRedTask) {
      updateCampaignItem(itemId, {
        lifecycleStatus: "blocked_by_red",
        outcome: "blocked",
        blockerKind: "scope",
        requestedHumanAction: `workflow blocked by authoritative reviewer at step ${blockedRedTask.phase}`,
      });
      tryTransitionCampaign(campaignId, "running", "paused");
      return {
        outcome: "paused",
        itemRecord: {
          itemId,
          ticketId,
          runId,
          lifecycleStatus: "blocked_by_red",
          outcome: "blocked",
          blockerKind: "scope",
        },
      };
    }

    // Step 4: For each awaiting_gate task, branch on gate type.
    const awaitingTasks = tasks.filter((t) => t.status === "awaiting_gate");
    let parked = false;

    for (const awaitingTask of awaitingTasks) {
      const step = findStep(workflow, awaitingTask.phase);
      const gateType = step?.gate ?? "human"; // safe park when step not found

      if (gateType === "auto" || gateType === "none") {
        // Auto-advance: don't pause the campaign, continue the drive loop.
        await doGate(awaitingTask.id, "advance", "campaign: auto-advance (gate:auto)", {});
      } else if (gateType === "verdict") {
        const taskVerdicts = verdictsForTask(awaitingTask.id);
        const agg = aggregateVerdicts(taskVerdicts);
        if (agg.verdict === "pass") {
          await doGate(awaitingTask.id, "advance", "campaign: auto-advance (gate:verdict, all reds passed)", {});
        } else if (agg.verdict === "fail") {
          updateCampaignItem(itemId, {
            lifecycleStatus: "blocked_by_red",
            outcome: "blocked",
            blockerKind: "scope",
            requestedHumanAction: `workflow blocked by failing verdict at step ${step?.id ?? awaitingTask.phase}`,
          });
          tryTransitionCampaign(campaignId, "running", "paused");
          parked = true;
          break;
        } else {
          // inconclusive — campaign_system (shared)
          updateCampaignItem(itemId, {
            lifecycleStatus: "blocked_by_red",
            outcome: "blocked",
            blockerKind: "campaign_system",
            requestedHumanAction: `workflow verdict inconclusive at step ${step?.id ?? awaitingTask.phase}`,
          });
          tryTransitionCampaign(campaignId, "running", "paused");
          parked = true;
          break;
        }
      } else {
        // gate:human — this is the ONLY path that sets item lifecycleStatus to 'awaiting_gate'.
        updateCampaignItem(itemId, {
          lifecycleStatus: "awaiting_gate",
          requestedHumanAction: `Human gate required at step ${step?.id ?? awaitingTask.phase} in workflow ${currentRun.workflow}`,
        });
        tryTransitionCampaign(campaignId, "running", "paused");
        parked = true;
        break;
      }
    }

    if (parked) {
      const updatedItem = getCampaignItem(itemId);
      return {
        outcome: "paused",
        itemRecord: {
          itemId,
          ticketId,
          runId,
          lifecycleStatus: updatedItem?.lifecycleStatus ?? "awaiting_gate",
          outcome: updatedItem?.outcome,
          blockerKind: updatedItem?.blockerKind,
        },
      };
    }

    // Step 5: No parked tasks — call runNext to dispatch the next wave.
    await fns.runNextFn({ runId, workflow });
    // Loop continues: re-read run status and tasks at the top.
  }
}

// Shared item-dispatch loop used by startCampaign and resumeCampaign.
// Requires the campaign to already be in 'running' state.
// Skips terminal items (complete/failed); dispatches only pending items.
// Reattaches to workflow items in awaiting_gate or blocked_by_red on resume.
// Cooperative pause: re-reads campaign status before each dispatch and after
// each item completes, stopping without transition if status != 'running'.
async function driveRemainingItems(
  campaignId: string,
  opts: {
    dispatch: (args: InvokeArgs) => Promise<InvokeResult>;
    projectDir: string;
    mode: string;
    // For testing: inject workflow-path dependencies.
    runNextFn?: RunNextFn;
    startRunFn?: StartRunFn;
    loadWorkflowFn?: LoadWorkflowFn;
    gateFn?: typeof gate;
  }
): Promise<CampaignRunResult> {
  const itemRecords: CampaignItemRecord[] = [];
  const items = listCampaignItems(campaignId);
  const ticketCache = listTickets(opts.projectDir);
  const ticketMap = new Map(ticketCache.map((t) => [t.id, t]));

  // Read per-item execution config from campaign canonical content.
  const campaignData = getCampaign(campaignId);
  const canonicalContent = campaignData?.metadata?.["planContent"];

  const doRunNext: RunNextFn = opts.runNextFn ?? runNext;
  const doStartRun: StartRunFn = opts.startRunFn ?? startRun;
  const doLoadWorkflow: LoadWorkflowFn = opts.loadWorkflowFn ?? loadWorkflow;

  // Track LOCAL blocked items for dependency-based hold evaluation.
  // Rebuilt from terminal failed+blocked items at the start of the loop (for resume),
  // then extended as new failures occur.
  const blockedItems: BlockedItemEntry[] = [];
  let anyHeld = false;

  for (const item of items) {
    // Safe-terminal: skip idempotently on re-drive
    if (item.lifecycleStatus === "complete" || item.lifecycleStatus === "failed") {
      // Rebuild blockedItems from previously-failed LOCAL blocked items for resume re-evaluation.
      if (
        item.lifecycleStatus === "failed" &&
        item.outcome === "blocked" &&
        item.blockerKind &&
        !isSharedBlocker(item.blockerKind)
      ) {
        const t = ticketMap.get(item.ticketId);
        if (t) blockedItems.push({ id: item.ticketId, ticket: t, blockerKind: item.blockerKind });
      }
      continue;
    }

    // RESUME PATH: reattach to parked workflow items (awaiting_gate or blocked_by_red).
    // When a run cannot be found or the workflow cannot be loaded, transition the campaign
    // back to paused (running→paused is valid) before returning recovery_needed. This
    // preserves the invariant that a paused campaign can always be safely re-examined.
    if (item.lifecycleStatus === "awaiting_gate" || item.lifecycleStatus === "blocked_by_red") {
      if (!item.runId) {
        itemRecords.push({ itemId: item.id, ticketId: item.ticketId, runId: item.runId, lifecycleStatus: item.lifecycleStatus });
        tryTransitionCampaign(campaignId, "running", "paused");
        return { stopReason: "recovery_needed", itemRecords };
      }
      const runForItem = getRun(item.runId);
      if (!runForItem) {
        itemRecords.push({ itemId: item.id, ticketId: item.ticketId, runId: item.runId, lifecycleStatus: item.lifecycleStatus });
        tryTransitionCampaign(campaignId, "running", "paused");
        return { stopReason: "recovery_needed", itemRecords };
      }
      let workflowForItem: Workflow;
      try {
        workflowForItem = doLoadWorkflow(runForItem.workflow, { projectDir: opts.projectDir });
      } catch {
        itemRecords.push({ itemId: item.id, ticketId: item.ticketId, runId: item.runId, lifecycleStatus: item.lifecycleStatus });
        tryTransitionCampaign(campaignId, "running", "paused");
        return { stopReason: "recovery_needed", itemRecords };
      }

      // Cooperative pause before reattaching
      const preReattach = getCampaign(campaignId);
      if (!preReattach || preReattach.status !== "running") {
        return { stopReason: preReattach?.status === "abandoned" ? "abandoned" : "paused", itemRecords };
      }

      const driveResult = await driveWorkflowItem(campaignId, item, item.runId, workflowForItem, {
        runNextFn: doRunNext,
        gateFn: opts.gateFn,
        projectDir: opts.projectDir,
      });
      itemRecords.push(driveResult.itemRecord);

      if (driveResult.outcome === "paused") {
        const c = getCampaign(campaignId);
        return { stopReason: c?.status === "abandoned" ? "abandoned" : "paused", itemRecords };
      }

      // Item reached terminal — handle blocked-items tracking and cooperative pause.
      const termItem = getCampaignItem(item.id);
      if (termItem?.lifecycleStatus === "failed" && termItem.outcome === "blocked" && termItem.blockerKind) {
        if (!isSharedBlocker(termItem.blockerKind)) {
          const laterTicket = ticketMap.get(item.ticketId);
          if (laterTicket) {
            blockedItems.push({ id: item.ticketId, ticket: laterTicket, blockerKind: termItem.blockerKind });
          } else {
            blockedItems.push({
              id: item.ticketId,
              ticket: { id: item.ticketId, type: "story", status: "active", title: item.ticketId, body: "" } as StructuredTicket,
              blockerKind: termItem.blockerKind,
            });
          }
        }
      }
      const postReattach = getCampaign(campaignId);
      if (!postReattach || postReattach.status !== "running") {
        return { stopReason: postReattach?.status === "abandoned" ? "abandoned" : "paused", itemRecords };
      }
      continue;
    }

    // In-flight/indeterminate: restore paused state and stop.
    // This path is reached when the item is in a status not handled above (e.g.
    // a future TaskStatus value or a status that slipped past campaignBlocker).
    if (item.lifecycleStatus !== "pending") {
      itemRecords.push({
        itemId: item.id,
        ticketId: item.ticketId,
        runId: item.runId,
        lifecycleStatus: item.lifecycleStatus,
      });
      tryTransitionCampaign(campaignId, "running", "paused");
      return { stopReason: "recovery_needed", itemRecords };
    }

    const laterTicket = ticketMap.get(item.ticketId);

    // Re-evaluate HELD items (resume: items already marked held from a prior run).
    if (item.outcome === "held") {
      if (item.blockerKind === "readiness") {
        // Readiness-held: re-run evaluateReadiness against the current ticket body.
        const currentTicket = ticketMap.get(item.ticketId);
        if (!currentTicket) {
          // Ticket not in map — keep held conservatively.
          anyHeld = true;
          itemRecords.push({ itemId: item.id, ticketId: item.ticketId, lifecycleStatus: "pending", outcome: "held", blockerKind: "readiness" });
          continue;
        }
        const r = evaluateReadiness(currentTicket);
        if (r.outcome === "needs_refinement" || r.outcome === "blocked") {
          updateCampaignItem(item.id, {
            outcome: "held",
            blockerKind: "readiness",
            continuePolicy: "hold_dependents",
            reason: `held because not ready: ${r.gaps.join("; ")}`,
            requestedHumanAction: `refine ${item.ticketId} then resume${r.refinementProposal ? ` — ${r.refinementProposal}` : ""}`,
          });
          anyHeld = true;
          itemRecords.push({ itemId: item.id, ticketId: item.ticketId, lifecycleStatus: "pending", outcome: "held", blockerKind: "readiness" });
          continue;
        }
        // Now ready/exploratory — clear all readiness-hold fields and fall through to dispatch.
        updateCampaignItem(item.id, { outcome: undefined, blockerKind: undefined, continuePolicy: undefined, reason: undefined, requestedHumanAction: undefined });
      } else {
        // Dependency-held: use existing evaluateForHold path.
        const holdResult = evaluateForHold(laterTicket, blockedItems, opts.mode);
        if (holdResult.hold) {
          updateCampaignItem(item.id, { outcome: "held", continuePolicy: "hold_dependents", reason: holdResult.reason });
          anyHeld = true;
          itemRecords.push({ itemId: item.id, ticketId: item.ticketId, lifecycleStatus: "pending", outcome: "held", reason: holdResult.reason });
          continue;
        }
        // No longer held — clear and fall through to dispatch.
        updateCampaignItem(item.id, { outcome: undefined, continuePolicy: undefined, reason: undefined, requestedHumanAction: undefined });
      }
    }

    // Check if this pending item should be newly HELD based on current blockedItems.
    if (blockedItems.length > 0) {
      const holdResult = evaluateForHold(laterTicket, blockedItems, opts.mode);
      if (holdResult.hold) {
        updateCampaignItem(item.id, { outcome: "held", continuePolicy: "hold_dependents", reason: holdResult.reason });
        anyHeld = true;
        itemRecords.push({ itemId: item.id, ticketId: item.ticketId, lifecycleStatus: "pending", outcome: "held", reason: holdResult.reason });
        continue;
      }
      // continue_allowed — record reason before dispatch (informational)
      if (laterTicket) {
        const reason = continueReason(laterTicket, blockedItems, opts.mode);
        updateCampaignItem(item.id, { reason });
      }
    }

    // Readiness gate: evaluate ticket before dispatch; hold without dispatching if not ready.
    {
      const ticket = ticketMap.get(item.ticketId);
      if (ticket) {
        const r = evaluateReadiness(ticket);
        if (r.outcome === "needs_refinement" || r.outcome === "blocked") {
          updateCampaignItem(item.id, {
            outcome: "held",
            blockerKind: "readiness",
            continuePolicy: "hold_dependents",
            reason: `held because not ready: ${r.gaps.join("; ")}`,
            requestedHumanAction: `refine ${item.ticketId} then resume${r.refinementProposal ? ` — ${r.refinementProposal}` : ""}`,
          });
          anyHeld = true;
          itemRecords.push({ itemId: item.id, ticketId: item.ticketId, lifecycleStatus: "pending", outcome: "held", blockerKind: "readiness" });
          continue;
        }
      }
    }

    // Cooperative pause: check campaign status before each dispatch
    const preCheck = getCampaign(campaignId);
    if (!preCheck || preCheck.status !== "running") {
      return {
        stopReason: preCheck?.status === "abandoned" ? "abandoned" : "paused",
        itemRecords,
      };
    }

    // ── DISPATCH BRANCH — strictly by the approved lane, no re-derivation ──────
    const itemConfig = getItemPlanEntry(canonicalContent, item.ticketId);

    if (itemConfig.lane === "full_feature") {
      // ── FULL_FEATURE: existing loadWorkflow/startRun/runNext path, UNCHANGED ─
      const workflowName = itemConfig.workflowName ?? "feature";

      // Load the workflow — failure containment mirrors the existing throw-catch pattern.
      let loadedWorkflow: Workflow;
      try {
        loadedWorkflow = doLoadWorkflow(workflowName, { projectDir: opts.projectDir });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        const runId = newRunId(item.ticketId);
        insertRun({
          id: runId,
          workflow: workflowName,
          title: item.ticketId,
          status: "abandoned",
          createdAt: nowIso(),
          projectDir: opts.projectDir,
        });
        updateCampaignItem(item.id, {
          runId,
          lifecycleStatus: "failed",
          outcome: "blocked",
          blockerKind: "campaign_system",
          requestedHumanAction: `workflow YAML missing or invalid: ${workflowName} — ${reason}`,
        });
        itemRecords.push({
          itemId: item.id,
          ticketId: item.ticketId,
          runId,
          lifecycleStatus: "failed",
          outcome: "blocked",
        });
        if (tryTransitionCampaign(campaignId, "running", "paused")) {
          return { stopReason: "paused", itemRecords };
        }
        const postLoadFail = getCampaign(campaignId);
        return {
          stopReason: postLoadFail?.status === "abandoned" ? "abandoned" : "paused",
          itemRecords,
        };
      }

      // Build inputs for startRun. Supply brief (ticket is the brief for a campaign item)
      // plus ticket context. Exclude CONTROL_PLANE_METADATA_KEYS.
      const cachedTicket = ticketMap.get(item.ticketId);
      const ticketBrief = cachedTicket
        ? `${cachedTicket.title}\n\n${cachedTicket.body}`
        : item.ticketId;
      const inputs: Record<string, unknown> = {
        ticketId: item.ticketId,
        brief: ticketBrief,
        projectContext: cachedTicket
          ? `${item.ticketId}: ${cachedTicket.title}\n\n${cachedTicket.body}`
          : item.ticketId,
      };
      for (const key of CONTROL_PLANE_METADATA_KEYS) {
        delete inputs[key];
      }

      let runId: string;
      try {
        const startResult = doStartRun({
          workflow: loadedWorkflow,
          title: item.ticketId,
          inputs,
          projectDir: opts.projectDir,
        });
        runId = startResult.runId;
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        const failRunId = newRunId(item.ticketId);
        insertRun({
          id: failRunId,
          workflow: workflowName,
          title: item.ticketId,
          status: "abandoned",
          createdAt: nowIso(),
          projectDir: opts.projectDir,
        });
        updateCampaignItem(item.id, {
          runId: failRunId,
          lifecycleStatus: "failed",
          outcome: "blocked",
          blockerKind: "campaign_system",
          requestedHumanAction: `workflow input validation failed: ${reason}`,
        });
        itemRecords.push({
          itemId: item.id,
          ticketId: item.ticketId,
          runId: failRunId,
          lifecycleStatus: "failed",
          outcome: "blocked",
          blockerKind: "campaign_system",
        });
        if (tryTransitionCampaign(campaignId, "running", "paused")) {
          return { stopReason: "paused", itemRecords };
        }
        const postStartFail = getCampaign(campaignId);
        return {
          stopReason: postStartFail?.status === "abandoned" ? "abandoned" : "paused",
          itemRecords,
        };
      }

      updateCampaignItem(item.id, { runId, lifecycleStatus: "running" });

      // Drive the workflow run to terminal or park.
      const driveResult = await driveWorkflowItem(campaignId, item, runId, loadedWorkflow, {
        runNextFn: doRunNext,
        gateFn: opts.gateFn,
        projectDir: opts.projectDir,
      });
      itemRecords.push(driveResult.itemRecord);

      if (driveResult.outcome === "paused") {
        const c = getCampaign(campaignId);
        return { stopReason: c?.status === "abandoned" ? "abandoned" : "paused", itemRecords };
      }

      // Item reached terminal — record worktree evidence if available.
      const runTasks = tasksForRun(runId);
      const worktreeTask = runTasks.find((t) => t.worktreePath != null);
      if (worktreeTask) {
        updateCampaignItem(item.id, {
          branch: `forge/${runId}/${worktreeTask.id}`,
          worktreePath: worktreeTask.worktreePath,
        });
      }

      // Cooperative pause after item completes.
      const postCheck = getCampaign(campaignId);

      const termItem = getCampaignItem(item.id);
      if (termItem?.lifecycleStatus === "failed" && termItem.outcome === "blocked" && termItem.blockerKind) {
        if (isSharedBlocker(termItem.blockerKind)) {
          // driveWorkflowItem already paused the campaign for shared blockers;
          // guard defensively.
          if (!postCheck || postCheck.status !== "running") {
            return { stopReason: postCheck?.status === "abandoned" ? "abandoned" : "paused", itemRecords };
          }
        } else {
          // Local blocker (scope) — add to blockedItems so later items can be evaluated.
          if (laterTicket) {
            blockedItems.push({ id: item.ticketId, ticket: laterTicket, blockerKind: termItem.blockerKind });
          } else {
            blockedItems.push({
              id: item.ticketId,
              ticket: { id: item.ticketId, type: "story", status: "active", title: item.ticketId, body: "" } as StructuredTicket,
              blockerKind: termItem.blockerKind,
            });
          }
        }
      }

      if (!postCheck || postCheck.status !== "running") {
        return {
          stopReason: postCheck?.status === "abandoned" ? "abandoned" : "paused",
          itemRecords,
        };
      }

    } else if (itemConfig.lane === "ticketing_only" || itemConfig.lane === "manual") {
      // ── TICKETING_ONLY / MANUAL: no-dispatch path — no run/task, ever ────────
      const requestedHumanAction =
        itemConfig.lane === "ticketing_only"
          ? `file/update the backlog ticket for ${item.ticketId} — lane 'ticketing_only' does not dispatch an agent`
          : `handle ${item.ticketId} manually — lane 'manual' does not dispatch an agent`;
      updateCampaignItem(item.id, {
        lifecycleStatus: "complete",
        outcome: "skipped",
        requestedHumanAction,
      });
      itemRecords.push({
        itemId: item.id,
        ticketId: item.ticketId,
        lifecycleStatus: "complete",
        outcome: "skipped",
      });

      const postCheck = getCampaign(campaignId);
      if (!postCheck || postCheck.status !== "running") {
        return {
          stopReason: postCheck?.status === "abandoned" ? "abandoned" : "paused",
          itemRecords,
        };
      }
    } else if (itemConfig.lane === "quick_implementation") {
      // ── QUICK_IMPLEMENTATION: engineer invoke -> test-engineer invoke, one run ─
      const runId = newRunId(item.ticketId);
      insertRun({
        id: runId,
        workflow: "invoke_chain",
        title: item.ticketId,
        status: "active",
        createdAt: nowIso(),
        metadata: { invokeChain: ["engineer", "test-engineer"] },
        projectDir: opts.projectDir,
      });
      updateCampaignItem(item.id, { runId, lifecycleStatus: "running" });

      const cachedTicket = ticketMap.get(item.ticketId);
      const taskText = cachedTicket
        ? `${item.ticketId}: ${cachedTicket.title}\n\n${cachedTicket.body}`
        : item.ticketId;
      const finalizeCtx = { campaignId, item, runId, lane: itemConfig.lane, laterTicket, itemRecords, blockedItems };

      const engineerOutcome = await dispatchLaneInvoke(opts.dispatch, {
        agentRole: "engineer",
        task: taskText,
        projectDir: opts.projectDir,
        runId,
        runTitle: item.ticketId,
      });
      if (engineerOutcome.status !== "complete") {
        const stop = await finalizeInvokeDispatch(finalizeCtx, engineerOutcome);
        if (stop) return stop;
        const postCheck = getCampaign(campaignId);
        if (!postCheck || postCheck.status !== "running") {
          return { stopReason: postCheck?.status === "abandoned" ? "abandoned" : "paused", itemRecords };
        }
        continue;
      }

      const testEngineerTask = `${taskText}\n\n## Prior step\nengineer completed implementation for this item under run ${runId}; verify and add/adjust tests as needed.`;
      const testEngineerOutcome = await dispatchLaneInvoke(opts.dispatch, {
        agentRole: "test-engineer",
        task: testEngineerTask,
        projectDir: opts.projectDir,
        runId,
        runTitle: item.ticketId,
      });
      if (testEngineerOutcome.status !== "complete") {
        const stop = await finalizeInvokeDispatch(finalizeCtx, testEngineerOutcome);
        if (stop) return stop;
        const postCheck = getCampaign(campaignId);
        if (!postCheck || postCheck.status !== "running") {
          return { stopReason: postCheck?.status === "abandoned" ? "abandoned" : "paused", itemRecords };
        }
        continue;
      }

      // Both invokes completed — finalize the item.
      const postCheck = getCampaign(campaignId);
      let outcome: CampaignItemOutcome | undefined;
      try {
        const freshTicket = readTicket(opts.projectDir, item.ticketId);
        if (freshTicket.status === "done" && !!freshTicket.closedCommit) outcome = "shipped";
      } catch {
        // ticket not found after run — leave outcome undefined
      }

      // FG-442: docs-impact resolution — advisory only, mirrors milestone.ts's
      // ship-time check. quick_implementation has no docs phase of its own
      // (unlike full_feature's pipeline, which always runs documentation-maintainer).
      const docsWarning = formatDocsImpactWarning(assessRunDocsImpact(runId), runId);

      updateCampaignItem(item.id, { lifecycleStatus: "complete", outcome, reason: docsWarning ?? undefined });

      const runTasks = tasksForRun(runId);
      const worktreeTask = runTasks.find((t) => t.worktreePath != null);
      if (worktreeTask) {
        updateCampaignItem(item.id, {
          branch: `forge/${runId}/${worktreeTask.id}`,
          worktreePath: worktreeTask.worktreePath,
        });
      }

      itemRecords.push({
        itemId: item.id,
        ticketId: item.ticketId,
        runId,
        lifecycleStatus: "complete",
        outcome,
        ...(docsWarning ? { reason: docsWarning } : {}),
      });

      if (!postCheck || postCheck.status !== "running") {
        return { stopReason: postCheck?.status === "abandoned" ? "abandoned" : "paused", itemRecords };
      }
    } else {
      // ── docs_only | test_only | review_only | research_only ─────────────────
      // Single opts.dispatch invoke to the item's stored agentRole — the SAME
      // mechanism the pre-FG-442 executionMode:'invoke' escape hatch always used
      // (see planner.ts foldItemEntry), which is why report.ts still labels it
      // "invoke (escape hatch)".
      const agentRole = itemConfig.agentRole!; // guaranteed by planner validation
      const runId = newRunId(item.ticketId);
      insertRun({
        id: runId,
        workflow: "invoke",
        title: item.ticketId,
        status: "active",
        createdAt: nowIso(),
        metadata: { invokeAgent: agentRole },
        projectDir: opts.projectDir,
      });
      updateCampaignItem(item.id, { runId, lifecycleStatus: "running" });

      const cachedTicket = ticketMap.get(item.ticketId);
      const taskText = cachedTicket
        ? `${item.ticketId}: ${cachedTicket.title}\n\n${cachedTicket.body}`
        : item.ticketId;

      const dispatchOutcome = await dispatchLaneInvoke(opts.dispatch, {
        agentRole,
        task: taskText,
        projectDir: opts.projectDir,
        runId,
        runTitle: item.ticketId,
      });

      if (dispatchOutcome.status !== "complete") {
        const stop = await finalizeInvokeDispatch(
          { campaignId, item, runId, lane: itemConfig.lane, laterTicket, itemRecords, blockedItems },
          dispatchOutcome
        );
        if (stop) return stop;
        const postCheck = getCampaign(campaignId);
        if (!postCheck || postCheck.status !== "running") {
          return { stopReason: postCheck?.status === "abandoned" ? "abandoned" : "paused", itemRecords };
        }
        continue;
      }

      const postCheck = getCampaign(campaignId);
      let outcome: CampaignItemOutcome | undefined;
      try {
        const freshTicket = readTicket(opts.projectDir, item.ticketId);
        if (freshTicket.status === "done" && !!freshTicket.closedCommit) {
          outcome = "shipped";
        }
      } catch {
        // ticket not found after run — leave outcome undefined
      }
      updateCampaignItem(item.id, { lifecycleStatus: "complete", outcome });

      const runTasks = tasksForRun(runId);
      const worktreeTask = runTasks.find((t) => t.worktreePath != null);
      if (worktreeTask) {
        updateCampaignItem(item.id, {
          branch: `forge/${runId}/${worktreeTask.id}`,
          worktreePath: worktreeTask.worktreePath,
        });
      }

      itemRecords.push({
        itemId: item.id,
        ticketId: item.ticketId,
        runId,
        lifecycleStatus: "complete",
        outcome,
      });

      if (!postCheck || postCheck.status !== "running") {
        return {
          stopReason: postCheck?.status === "abandoned" ? "abandoned" : "paused",
          itemRecords,
        };
      }
    }
  }

  // All items processed. If any held items remain, campaign → paused (awaiting resume).
  // If no held items, campaign → complete (may be complete_with_issues per report verdict).
  if (anyHeld) {
    if (tryTransitionCampaign(campaignId, "running", "paused")) {
      return { stopReason: "paused", itemRecords };
    }
    const finalCheck = getCampaign(campaignId);
    return {
      stopReason: finalCheck?.status === "abandoned" ? "abandoned" : "paused",
      itemRecords,
    };
  }

  if (tryTransitionCampaign(campaignId, "running", "complete")) {
    return { stopReason: "complete", itemRecords };
  }
  const finalCheck = getCampaign(campaignId);
  return {
    stopReason: finalCheck?.status === "abandoned" ? "abandoned" : "paused",
    itemRecords,
  };
}

export async function startCampaign(
  id: string,
  opts: {
    dispatch?: (args: InvokeArgs) => Promise<InvokeResult>;
    runNextFn?: RunNextFn;
    startRunFn?: StartRunFn;
    loadWorkflowFn?: LoadWorkflowFn;
    gateFn?: typeof gate;
  } = {}
): Promise<CampaignRunResult> {
  const itemRecords: CampaignItemRecord[] = [];

  const campaign = getCampaign(id);
  if (!campaign) {
    return { stopReason: "not_planned", itemRecords };
  }

  const items = listCampaignItems(id);
  const blocker = campaignBlocker(campaign, items, "start");
  if (blocker !== null) {
    if (blocker === "recovery_needed") {
      const inf = items.find(
        (i) => i.lifecycleStatus !== "pending" && i.lifecycleStatus !== "complete" && i.lifecycleStatus !== "failed"
      );
      return {
        stopReason: "recovery_needed",
        itemRecords: inf
          ? [{ itemId: inf.id, ticketId: inf.ticketId, runId: inf.runId, lifecycleStatus: inf.lifecycleStatus }]
          : [],
      };
    }
    return { stopReason: blocker, itemRecords };
  }

  if (!tryTransitionCampaignToRunning(id)) {
    return { stopReason: "already_running", itemRecords };
  }

  return driveRemainingItems(id, {
    dispatch: opts.dispatch ?? invoke,
    projectDir: campaign.projectDir!,
    mode: campaign.mode,
    runNextFn: opts.runNextFn,
    startRunFn: opts.startRunFn,
    loadWorkflowFn: opts.loadWorkflowFn,
    gateFn: opts.gateFn,
  });
}

export async function resumeCampaign(
  id: string,
  opts: {
    dispatch?: (args: InvokeArgs) => Promise<InvokeResult>;
    runNextFn?: RunNextFn;
    startRunFn?: StartRunFn;
    loadWorkflowFn?: LoadWorkflowFn;
    gateFn?: typeof gate;
  } = {}
): Promise<CampaignRunResult> {
  const itemRecords: CampaignItemRecord[] = [];

  const campaign = getCampaign(id);
  if (!campaign) {
    return { stopReason: "not_paused", itemRecords };
  }

  const items = listCampaignItems(id);
  const blocker = campaignBlocker(campaign, items, "resume");
  if (blocker !== null) {
    if (blocker === "recovery_needed") {
      const inf = items.find(
        (i) => i.lifecycleStatus !== "pending" && i.lifecycleStatus !== "complete" && i.lifecycleStatus !== "failed"
      );
      return {
        stopReason: "recovery_needed",
        itemRecords: inf
          ? [{ itemId: inf.id, ticketId: inf.ticketId, runId: inf.runId, lifecycleStatus: inf.lifecycleStatus }]
          : [],
      };
    }
    return { stopReason: blocker, itemRecords };
  }

  if (!tryTransitionCampaign(id, "paused", "running")) {
    const current = getCampaign(id);
    return {
      stopReason: current?.status === "abandoned" ? "abandoned" : "already_running",
      itemRecords,
    };
  }

  return driveRemainingItems(id, {
    dispatch: opts.dispatch ?? invoke,
    projectDir: campaign.projectDir!,
    mode: campaign.mode,
    runNextFn: opts.runNextFn,
    startRunFn: opts.startRunFn,
    loadWorkflowFn: opts.loadWorkflowFn,
    gateFn: opts.gateFn,
  });
}

export type EscalateLaneResult = { ok: true; planHash: string } | { ok: false; reason: string };

// FG-442: the escalation store capability. approveCampaign() was hard-gated to
// campaign.status==='planned' and there was no way to mutate an existing
// campaign's planContent or re-approve a paused campaign — "reuse the approve
// state machine" was not implementable as-is (RED-WIDE HIGH FINDING). This
// mutates the ESCALATED item's lane directly into campaign.sourceInput (so
// resolvePlan deterministically re-derives the SAME escalated lane on every
// future resolve — it never reads campaign.metadata.planContent as its source
// of truth), re-resolves the plan, and writes a fresh UNAPPROVED plan_hash —
// forcing `forge campaign approve` before start/resume will accept the new
// baseline (campaignBlocker's stale-plan check). The escalated item is also
// reset to 'pending' so a subsequent resume dispatches it fresh, in its new
// lane — never a silent downgrade, never a silent continue in the outgrown lane.
export function escalateCampaignItemLane(
  campaignId: string,
  ticketId: string,
  opts: { newLane: ExecutionLane; laneRationale: string; materialLaneAssumptions?: string[]; agentRole?: string }
): EscalateLaneResult {
  const campaign = getCampaign(campaignId);
  if (!campaign) return { ok: false, reason: `campaign ${campaignId} not found` };
  if (campaign.status !== "paused") {
    return { ok: false, reason: `campaign must be paused to escalate a lane (status: ${campaign.status})` };
  }
  if (!campaign.projectDir) return { ok: false, reason: "campaign has no projectDir" };

  const sourceInput: Record<string, unknown> = { ...campaign.sourceInput };
  const existingOverrides = (sourceInput["itemOverrides"] as Record<string, ItemModeOverride> | undefined) ?? {};
  const newOverride: ItemModeOverride = {
    lane: opts.newLane,
    laneRationale: opts.laneRationale,
    materialLaneAssumptions: opts.materialLaneAssumptions ?? [],
    agentRole: opts.agentRole,
  };
  sourceInput["itemOverrides"] = { ...existingOverrides, [ticketId]: newOverride };

  let planHash: string;
  let canonicalContent: unknown;
  try {
    const plannerInput = sourceInputToPlannerInput(sourceInput);
    const resolved = resolvePlan(plannerInput, { projectDir: campaign.projectDir, mode: campaign.mode as PlanMode });
    planHash = resolved.planHash;
    canonicalContent = resolved.canonicalContent;
  } catch (e) {
    return { ok: false, reason: `plan could not be re-resolved: ${(e as Error).message}` };
  }

  const metadata = { ...(campaign.metadata ?? {}), planContent: canonicalContent };
  const wrote = updateCampaignPlanForReapproval(campaignId, { sourceInput, metadata, planHash });
  if (!wrote) return { ok: false, reason: "campaign is no longer paused (concurrent state change)" };

  const escalatedItem = listCampaignItems(campaignId).find((i) => i.ticketId === ticketId);
  if (escalatedItem) {
    updateCampaignItemIfCampaignPaused(escalatedItem.id, campaignId, {
      lifecycleStatus: "pending",
      outcome: undefined,
      blockerKind: undefined,
      continuePolicy: undefined,
      reason: undefined,
      requestedHumanAction: undefined,
    });
  }

  return { ok: true, planHash };
}
