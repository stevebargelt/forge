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
  tryTransitionCampaign,
  tryTransitionCampaignToRunning,
} from "../store/campaigns.js";
import { tasksForRun } from "../store/tasks.js";
import type { Campaign, CampaignItem, CampaignItemLifecycleStatus, CampaignItemOutcome, BlockerKind, Run } from "../types/index.js";
import { resolvePlan } from "./planner.js";
import type { PlannerInput, PlanMode, ItemModeOverride } from "./planner.js";
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
import { verdictsForTask, verdictsForRun } from "../store/verdicts.js";
import { evaluateDoneAudit } from "../done-audit/done-audit.js";
import type { DoneAuditResult } from "../done-audit/done-audit.js";
import { collectDoneAuditInputFor } from "../done-audit/collect.js";

// Test-only override for done-audit evaluation in reconcileTerminalOutcome.
// Lets unit tests inject known results without real git/filesystem access.
let _testDoneAuditMapOverride: Map<string, DoneAuditResult> | null = null;
export function setExecutorDoneAuditMapForTest(map: Map<string, DoneAuditResult> | null): Map<string, DoneAuditResult> | null {
  const prev = _testDoneAuditMapOverride;
  _testDoneAuditMapOverride = map;
  return prev;
}

// Local alias — not exported. Flows through the DB as a string in canonicalContent.
type ItemExecutionMode = "workflow" | "invoke";

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


export function sourceInputToPlannerInput(sourceInput: Record<string, unknown>): PlannerInput {
  const kind = sourceInput["kind"] as string;
  const itemOverrides = sourceInput["itemOverrides"] as Record<string, ItemModeOverride> | undefined;
  if (kind === "list") {
    return { kind: "list", ticketIds: (sourceInput["ticketIds"] as string[]) ?? [], ...(itemOverrides ? { itemOverrides } : {}) };
  }
  if (kind === "epic") {
    return { kind: "epic", epicId: sourceInput["epicId"] as string, ...(itemOverrides ? { itemOverrides } : {}) };
  }
  return {
    kind: "mixed",
    epicId: sourceInput["epicId"] as string,
    additions: sourceInput["additions"] as string[] | undefined,
    exclusions: sourceInput["exclusions"] as string[] | undefined,
    ...(itemOverrides ? { itemOverrides } : {}),
  };
}

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

// Read per-item execution config from canonicalContent (stored in campaign.metadata.planContent).
// Returns { executionMode: 'workflow', workflowName: 'feature' } as default when not found.
function getItemExecutionConfig(
  canonicalContent: unknown,
  ticketId: string,
): { executionMode: ItemExecutionMode; workflowName: string; agentRole?: string } {
  const cc = canonicalContent as Record<string, unknown> | null | undefined;
  if (cc) {
    const orderedItems = cc["orderedItems"];
    if (Array.isArray(orderedItems)) {
      const entry = orderedItems.find(
        (it) =>
          typeof it === "object" &&
          it !== null &&
          (it as Record<string, unknown>)["ticketId"] === ticketId,
      ) as Record<string, unknown> | undefined;
      if (entry) {
        if (entry["executionMode"] === "invoke") {
          return {
            executionMode: "invoke",
            workflowName: "feature",
            agentRole: typeof entry["agentRole"] === "string" ? entry["agentRole"] : "engineer",
          };
        }
        return {
          executionMode: "workflow",
          workflowName:
            typeof entry["workflowName"] === "string" ? entry["workflowName"] : "feature",
        };
      }
    }
  }
  // Default to invoke for backward compatibility — items without explicit workflow
  // configuration fall through to the original dispatch path.
  return { executionMode: "invoke", workflowName: "feature" };
}

// Derive terminal campaign item outcome from a completed/abandoned workflow run.
// Updates the item's lifecycleStatus and outcome in the DB.
// outcome='shipped' requires BOTH a passing aggregate verdict AND a passing done-audit.
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
  const agg = aggregateVerdicts(verdictsForRun(run.id));
  if (agg.verdict === "pass") {
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
  } else if (agg.verdict === "fail") {
    updateCampaignItem(itemId, {
      lifecycleStatus: "failed",
      outcome: "blocked",
      blockerKind: "scope",
      requestedHumanAction: "workflow completed but authoritative reviewer verdict failed",
    });
  } else {
    // inconclusive — includes aggregateVerdicts([]) === 'inconclusive' (empty verdicts)
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

    // ── DISPATCH BRANCH ────────────────────────────────────────────────────────
    const itemConfig = getItemExecutionConfig(canonicalContent, item.ticketId);

    if (itemConfig.executionMode === "workflow") {
      // ── WORKFLOW DISPATCH PATH ─────────────────────────────────────────────

      // Load the workflow — failure containment mirrors the existing throw-catch pattern.
      let loadedWorkflow: Workflow;
      try {
        loadedWorkflow = doLoadWorkflow(itemConfig.workflowName, { projectDir: opts.projectDir });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        const runId = newRunId(item.ticketId);
        insertRun({
          id: runId,
          workflow: itemConfig.workflowName,
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
          requestedHumanAction: `workflow YAML missing or invalid: ${itemConfig.workflowName} — ${reason}`,
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
          workflow: itemConfig.workflowName,
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

    } else {
      // ── INVOKE DISPATCH PATH (escape hatch — explicit opt-in only) ─────────

      const runId = newRunId(item.ticketId);
      const run: Run = {
        id: runId,
        workflow: "invoke",
        title: item.ticketId,
        status: "active",
        createdAt: nowIso(),
        metadata: { invokeAgent: itemConfig.agentRole ?? "engineer" },
        projectDir: opts.projectDir,
      };
      insertRun(run);
      updateCampaignItem(item.id, { runId, lifecycleStatus: "running" });

      const cachedTicket = ticketMap.get(item.ticketId);
      const taskText = cachedTicket
        ? `${item.ticketId}: ${cachedTicket.title}\n\n${cachedTicket.body}`
        : item.ticketId;

      let dispatchResult: InvokeResult;
      try {
        dispatchResult = await opts.dispatch({
          agentRole: itemConfig.agentRole ?? "engineer",
          task: taskText,
          projectDir: opts.projectDir,
          runId,
          runTitle: item.ticketId,
        });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        // Throws are infrastructure-level failures (SHARED).
        const blockerKind: BlockerKind = "infrastructure";
        updateRunStatus(runId, "abandoned");
        updateCampaignItem(item.id, {
          lifecycleStatus: "failed",
          outcome: "blocked",
          blockerKind,
          reason,
          requestedHumanAction: `resolve ${blockerKind} for ${item.ticketId} then resume`,
          continuePolicy: "hold_campaign",
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
        const throwPostFail = getCampaign(campaignId);
        return {
          stopReason: throwPostFail?.status === "abandoned" ? "abandoned" : "paused",
          itemRecords,
        };
      }

      // Re-read campaign status after item completes
      const postCheck = getCampaign(campaignId);

      if (dispatchResult.status === "complete") {
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

        // Record worktree evidence if any task in the run has a worktreePath set.
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

        // Cooperative pause: if campaign was paused during this item, stop without transition
        if (!postCheck || postCheck.status !== "running") {
          return {
            stopReason: postCheck?.status === "abandoned" ? "abandoned" : "paused",
            itemRecords,
          };
        }
      } else {
        // Dispatch returned failed — classify and apply FG-393 policy.
        const reason = dispatchResult.error ?? "invoke failed";
        const failureKind = failureKindForTask(dispatchResult.taskId);
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
        itemRecords.push({
          itemId: item.id,
          ticketId: item.ticketId,
          runId,
          lifecycleStatus: "failed",
          outcome: "blocked",
        });

        if (shared) {
          // Hold the whole campaign — remaining pending items stay pending.
          if (tryTransitionCampaign(campaignId, "running", "paused")) {
            return { stopReason: "paused", itemRecords };
          }
          const resultPostFail = getCampaign(campaignId);
          return {
            stopReason: resultPostFail?.status === "abandoned" ? "abandoned" : "paused",
            itemRecords,
          };
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

        // Cooperative pause check after failure: if already paused, stop the loop.
        if (!postCheck || postCheck.status !== "running") {
          return {
            stopReason: postCheck?.status === "abandoned" ? "abandoned" : "paused",
            itemRecords,
          };
        }
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
