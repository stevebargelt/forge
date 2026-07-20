import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  startLaunch,
  waitForLaunchTerminal,
  realWaitHarness,
  removeLaunch,
  statusLine,
  type LaunchStatus,
  type TmuxRunner,
  type WaitHarness,
} from "../v2/launch.js";
import { FORGE_HOME, DB_PATH } from "../util/paths.js";
import { invoke } from "../v2/invoke.js";
import type { InvokeArgs, InvokeResult } from "../v2/invoke.js";
import { evaluateReadiness } from "../readiness/readiness.js";
import {
  getCampaign,
  getCampaignItem,
  listCampaignItems,
  updateCampaignItem,
  updateCampaignItemIfCampaignPaused,
  updateCampaignItemIfCampaignRunning,
  updateCampaignItemIfPending,
  claimCampaignItemForDrive,
  updateCampaignPlanForReapproval,
  tryTransitionCampaignToRunning,
  allocateItemGeneration,
  deriveCampaignItemDispatchKey,
} from "../store/campaigns.js";
import { getDb, writeTransaction } from "../store/db.js";
import { logEvent } from "../store/events.js";
import { tasksForRun } from "../store/tasks.js";
import type { Campaign, CampaignItem, CampaignItemLifecycleStatus, CampaignItemOutcome, BlockerKind, Run } from "../types/index.js";
import { resolvePlan, sourceInputToPlannerInput, getItemPlanEntry } from "./planner.js";
import type { PlannerInput, PlanMode, ExecutionLane, ItemModeOverride } from "./planner.js";
import { listTickets } from "../backlog/structured.js";
import type { StructuredTicket } from "../backlog/structured.js";
import { getRun, insertRun, updateRunStatus, runByDispatchKey } from "../store/runs.js";
import { computeReadyQueue } from "../v2/ready-queue.js";
import { taskHasPipelineFinalize } from "../v2/run-kind.js";
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
import { collectAuthoritativeEvents, collectReconcileEvidence } from "./reconcile-collect.js";
import { evaluateAuthoritativeOutcome, evaluateReconcileEvidence } from "./reconcile-evidence.js";
import { collectOutOfBandEvidence } from "./reconcile-outofband-collect.js";
import {
  evaluateOutOfBandEvidence,
  authoritativeOutcomeContribution,
  composeOutOfBandEligibility,
} from "./reconcile-outofband-evidence.js";
import { assessRunDocsImpact, formatDocsImpactWarning } from "../v2/docs-impact.js";
// FG-516: the running→paused park CAS lives entirely in ./park.js. executor.ts
// imports the boundary (parkCampaign) and the two non-park lifecycle wrappers
// (completeCampaign, resumeCampaignToRunning) but NEVER the raw tryTransitionCampaign
// symbol — so the "notify without a committed pause" wedge is unrepresentable here
// by construction. setCampaignNotifyEmitterForTest is re-exported so existing tests
// that import it from ./executor.js keep working.
import {
  parkCampaign,
  pickCampaignFallbackRunId,
  completeCampaign,
  resumeCampaignToRunning,
  setCampaignNotifyEmitterForTest,
} from "./park.js";
import type { ParkContext } from "./park.js";
export { setCampaignNotifyEmitterForTest };

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
  | "recovery_needed"
  | "lane_escalation_unresolved";

export type CampaignItemRecord = {
  itemId: string;
  ticketId: string;
  runId?: string;
  lifecycleStatus: CampaignItemLifecycleStatus;
  outcome?: CampaignItemOutcome;
  blockerKind?: BlockerKind;
  reason?: string;
};

// FG-596: the result of driving ONE campaign item to a terminal drive-process
// outcome or a legal park. `itemRecords` carries what the item settled to (usually
// one record); `stopReason` is present ONLY when this item's processing requires the
// whole campaign to stop (a park, an abandonment, or a recovery-needed wedge) —
// absent means the item settled without halting the campaign and the controller
// advances to the next item.
export type DriveOneItemResult = {
  itemRecords: CampaignItemRecord[];
  stopReason?: CampaignStopReason;
};

// FG-596: how the launch-per-item controller drives item N. The DEFAULT (production)
// launches `forge campaign drive-item` under `forge launch`, waits in-process via
// `forge launch wait`, and reconstructs the DriveOneItemResult from DURABLE state
// after the wake — never from the launch disposition. A test may inject an in-process
// launcher (the same drive, no subprocess) to exercise the controller deterministically.
export type DriveItemLaunchFn = (campaignId: string, itemId: string) => Promise<DriveOneItemResult>;

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
  // are resumable and must NOT trigger recovery_needed. FG-425 (AC5): awaiting_recovery
  // is the third — an unsettled publication is resumed by CONVERGING it (the AD-5 sweep
  // at the top of the next wave), which is exactly what a resume drives.
  const inFlight = items.find(
    (i) =>
      i.lifecycleStatus !== "pending" &&
      i.lifecycleStatus !== "complete" &&
      i.lifecycleStatus !== "failed" &&
      i.lifecycleStatus !== "awaiting_gate" &&
      i.lifecycleStatus !== "blocked_by_red" &&
      i.lifecycleStatus !== "awaiting_recovery"
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
    // A bare resume (no escalate, no re-approve) must never silently continue
    // dispatching later items past an item that outgrew its lane — the ONLY
    // way to clear this pause is escalateCampaignItemLane + re-approval.
    if (hasUnresolvedLaneEscalation(items)) return "lane_escalation_unresolved";
    return null;
  }
}

// FG-442 fix: the ONLY way to clear a lane_escalation pause is a genuine
// escalateCampaignItemLane call, which resets the item to 'pending' (clearing
// blockerKind) in the SAME write that mints the fresh plan_hash — so an item
// still sitting failed/blocked with blockerKind 'lane_escalation' means no
// escalate has happened yet, regardless of what a bare resume's stale-plan
// check sees (sourceInput/plan_hash are untouched by a no-op resume attempt).
export function hasUnresolvedLaneEscalation(items: CampaignItem[]): boolean {
  return items.some(
    (item) => item.lifecycleStatus === "failed" && item.outcome === "blocked" && item.blockerKind === "lane_escalation"
  );
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
    if (await parkCampaign(campaignId, item.id, "decision_needed", { exemption: "item-carries-context" })) {
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
    if (await parkCampaign(campaignId, item.id, "blocked", { exemption: "item-carries-context" })) {
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
    if (await parkCampaign(campaignId, item.id, "blocked", { exemption: "item-carries-context" })) {
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
  // FG-585: `failed` is a real, evidence-bearing terminal (a required phase
  // failed / a downstream phase became unreachable). Route it through the SAME
  // authoritative attribution as `complete` — gate_rejected → scope/LOCAL,
  // verdict-fail → scope, shared infra/auth → campaign_system (SHARED-WINS) —
  // NOT the campaign_system short-circuit that would pause the whole campaign
  // for a per-item local failure. Before FG-585 this path relied on the run
  // falsely reaching `complete`; now the run tells the truth and the attribution
  // logic below handles both terminals. Only a run that is neither complete nor
  // failed (abandoned, or somehow still active) is a genuine campaign anomaly.
  if (run.status !== "complete" && run.status !== "failed") {
    updateCampaignItem(itemId, {
      lifecycleStatus: "failed",
      outcome: "blocked",
      blockerKind: "campaign_system",
      requestedHumanAction: `workflow run ${run.id} ended with status ${run.status}`,
    });
    return;
  }
  const { outcome } = evaluateAuthoritativeOutcome(collectAuthoritativeEvents(run.id));
  // Only a genuinely `complete` run may ship — a `failed` run never routes to the
  // shipped/done-audit branch even if an authoritative pass verdict exists (some
  // later required phase still failed).
  if (run.status === "complete" && outcome === "pass") {
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
      // FG-425 (AC5): a SHIPPED item carries no actionable blocker. The
      // awaiting_recovery park (driveWorkflowItem, below) is the one campaign park
      // that stamps a blockerKind on an item still expected to ship — 'git_state',
      // a SHARED kind. Left behind by this terminal write, the stamp outlives the
      // unsettled publication that justified it: the next drive reads it off an
      // already-shipped item and pauses the whole campaign on a blocker that
      // converged. Shipment is the moment the git state is durably settled, so this
      // is where the stamp (and the recovery guidance beside it) is cleared. Only
      // durable shipment clears it — an item still parked on an unconverged
      // publication never reaches this branch and keeps its blocker.
      updateCampaignItem(itemId, {
        lifecycleStatus: "complete",
        outcome: "shipped",
        blockerKind: undefined,
        requestedHumanAction: undefined,
      });
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
    //
    // FG-475: this also fires for a run that reached 'complete' by way of
    // driveWorkflowItem's terminal-unreachable settlement (v2/ready-queue.ts's
    // shared settled-run helper) after a gate reject with no on_reject — there
    // was never a reviewer verdict to evaluate, only a rejected gate. Blindly
    // defaulting to blockerKind:'campaign_system' here would pause the WHOLE
    // campaign (SHARED) for what is actually a LOCAL, per-item scope failure.
    // Before falling back, classify EVERY failed primary task in the run through
    // the exact failureKindForTask -> classifyFailureKind sequence finalizeInvokeDispatch
    // already uses above, then apply SHARED-WINS precedence: if any failed primary
    // classifies to a SHARED blockerKind (isSharedBlocker), the whole run stays
    // campaign_system — a single shared infra/auth failure must never be masked
    // by a later local gate_rejected on the same run. Only when every failed
    // primary classifies LOCAL do we use that local kind (e.g. 'scope' for
    // gate_rejected). A run with no failed primary at all still lands on
    // campaign_system, preserving today's behavior for that case.
    const failedPrimaries = tasksForRun(run.id).filter((t) => t.parentId === undefined && t.status === "failed");
    const failedBlockerKinds = failedPrimaries.map((t) => classifyFailureKind(failureKindForTask(t.id)));
    const anySharedFailure = failedBlockerKinds.some((k) => isSharedBlocker(k));
    const unresolvedBlockerKind: BlockerKind =
      failedPrimaries.length === 0 || anySharedFailure ? "campaign_system" : failedBlockerKinds[failedBlockerKinds.length - 1]!;
    updateCampaignItem(itemId, {
      lifecycleStatus: "failed",
      outcome: "blocked",
      blockerKind: unresolvedBlockerKind,
      requestedHumanAction:
        unresolvedBlockerKind === "campaign_system"
          ? "workflow completed but no authoritative reviewer verdicts found — check workflow reds configuration"
          : `resolve ${unresolvedBlockerKind} for this item then resume`,
    });
  }
}

// Injectable function types for testability.
type RunNextFn = (args: { runId: string; workflow: Workflow }) => Promise<RunNextResult>;
type StartRunFn = (args: StartRunArgs) => { runId: string };
type LoadWorkflowFn = (name: string, ctx: LoadContext) => Workflow;

// FG-490 (review F7), widened by FG-509: a thrown drive-path error must never
// leave the campaign stranded at 'running' with no way back but DB surgery —
// the same dead end F6 reached via a stalled loop instead of an exception.
// All four callers — runNext, reconcileTerminalOutcome, and the two unattended
// doGate auto-advances (gate:auto/none and gate:verdict-pass) — share the
// property this park depends on: a run row already exists behind the item,
// because every one of them is reached only after startRun succeeded. So the
// item parks at 'awaiting_gate' (the SAME recoverable shape F2b's no-progress
// backstop uses below, so `campaign resume` reattaches to this run instead of
// campaignBlocker refusing outright) and the campaign at 'paused', the failure
// is durably recorded, then the ORIGINAL error is rethrown (wrapped with
// next-action guidance via `cause`) so it still reaches the CLI's top-level
// handler. What resume DOES on reattach splits by caller: the three
// active-run sites re-enter the drive loop via the liveness probe, while
// reconcileTerminalOutcome's run is terminal or absent, so resume falls
// through to the out-of-band evidence path and retries the same reconciliation
// (see docs/concepts.md, "Drive-path catch-and-park"). If the park itself
// throws (e.g. a DB error), that secondary failure is swallowed — the original
// drive error must always be what propagates, never masked by a failure in the
// recovery path itself.
//
// NOTE: a thrown startRun has no live run to reattach to — see the sibling
// parkCampaignOnStartRunThrow below, which parks that shape directly at its
// true terminal state instead of this recoverable one.
// FG-516 (finding F1): async + AWAITED notify. The production campaign CLI
// (renderDriveErrorAndExit) calls process.exit(1) as soon as this rethrow reaches
// its top-level catch. A fire-and-forget `void notifyCampaignPause(...)` could be
// pre-empted at an await hop before it records/dispatches, leaving the wedge
// silent. Awaiting the notify (it never throws) before the rethrow guarantees the
// milestone is settled before control returns to the CLI.
async function parkCampaignOnDriveThrow(
  campaignId: string,
  itemId: string,
  ticketId: string,
  runId: string,
  err: unknown
): Promise<never> {
  const message = err instanceof Error ? err.message : String(err);
  try {
    updateCampaignItem(itemId, {
      runId,
      lifecycleStatus: "awaiting_gate",
      outcome: undefined,
      blockerKind: undefined,
      reason: message,
      requestedHumanAction: `drive loop threw while dispatching ${ticketId} on run ${runId}: ${message}. Inspect the run (forge show ${runId}), resolve the issue, then run \`forge campaign resume\`.`,
    });
    logEvent("campaign_item.drive_error", {
      runId,
      payload: { campaignId, itemId, ticketId, error: message, decidedAt: nowIso() },
    });
    // FG-516 (finding F1/B): parkCampaign gates the notify on the CAS actually
    // committing. A concurrent operator `forge campaign pause` (the one explicit
    // exemption) can win the running→paused race first; this stale driver then
    // commits nothing, so it must NOT emit a fresh unattended-wedge push for a
    // pause it did not cause. Awaited before the rethrow below so the milestone is
    // settled before the CLI's process.exit(1).
    await parkCampaign(campaignId, itemId, "blocked", { exemption: "item-carries-context" }, { bodyBlockerKind: "drive_error" });
  } catch {
    // park failed — original drive error below still propagates unmasked.
  }
  throw err instanceof Error
    ? new Error(
        `campaign ${campaignId} paused after a drive error on ${ticketId} (run ${runId}) — resolve the issue, then \`forge campaign resume ${campaignId}\`: ${err.message}`,
        { cause: err }
      )
    : err;
}

// FG-490 review (round 2, F1): startRun throwing means no run ever actually
// dispatched — there is no live workflow to reattach to, only the synthetic
// 'abandoned' run row inserted above for traceability. Parking this shape at
// 'awaiting_gate' (parkCampaignOnDriveThrow's shape) let the reattach path on
// resume see that terminal run and reconcileTerminalOutcome re-terminalize the
// item to blockerKind 'campaign_system'. Park it DIRECTLY at its true terminal
// shape instead — failed/blocked/infrastructure, matching the terminal synthetic
// run row so the projection never disagrees with itself.
//
// FG-511: `forge campaign retry` now accepts campaign_system conditionally, but
// only behind probeCampaignSystemRetryEvidence — and this shape has no evidence
// trail for that probe to read. No run was ever dispatched, so no primary task
// ever failed, so the probe's no-failed-primary branch would refuse it. Parking
// at 'infrastructure' (directly retryable, its blockerKind already IS the
// classification) keeps composing with retry instead of routing the operator
// through an evidence probe that must refuse.
// FG-516 (finding F1): async + AWAITED notify, same rationale as
// parkCampaignOnDriveThrow — the CLI process.exit(1) must not race the push.
async function parkCampaignOnStartRunThrow(
  campaignId: string,
  itemId: string,
  ticketId: string,
  runId: string,
  err: unknown
): Promise<never> {
  const message = err instanceof Error ? err.message : String(err);
  try {
    logEvent("campaign_item.drive_error", {
      runId,
      payload: { campaignId, itemId, ticketId, error: message, decidedAt: nowIso() },
    });
    updateCampaignItem(itemId, {
      runId,
      lifecycleStatus: "failed",
      outcome: "blocked",
      blockerKind: "infrastructure",
      reason: message,
      requestedHumanAction: `startRun threw while dispatching ${ticketId} on run ${runId}: ${message}. Once the campaign is paused, run \`forge campaign retry ${campaignId} ${ticketId}\`, then \`forge campaign resume\`.`,
    });
    // FG-516 (finding F1/B): same concurrent-manual-pause guard as
    // parkCampaignOnDriveThrow — parkCampaign only notifies when THIS park
    // committed the pause, and is awaited before the rethrow below. The synthetic
    // abandoned run row is inserted best-effort (see the startRun-throw catch), so
    // when that insert failed the item has no run of its OWN — pass a campaign
    // fallback run so notifyCampaignPause still emits (scoped to another item's
    // run) instead of going silent, exactly like the other no-own-run parks.
    await parkCampaign(campaignId, itemId, "blocked", { exemption: "item-carries-context" }, { fallbackRunId: pickCampaignFallbackRunId(campaignId) });
  } catch {
    // park failed — original drive error below still propagates unmasked.
  }
  throw err instanceof Error
    ? new Error(
        `campaign ${campaignId} paused after a drive error on ${ticketId} (run ${runId}) — resolve the issue, then \`forge campaign retry ${campaignId} ${ticketId}\`, then \`forge campaign resume ${campaignId}\`: ${err.message}`,
        { cause: err }
      )
    : err;
}

// Drive a workflow run until it reaches a terminal state (complete/abandoned) or parks
// at a gate (awaiting_gate / blocked_by_red). Updates campaign item state in the DB.
//
// Returns 'paused' when the campaign must stop (human gate, blocked reviewer, or
// shared-blocker terminal outcome). Returns 'continue' for terminal outcomes that
// do not require halting the campaign (shipped or scope-fail — caller handles policy).
// Returns 'recovery_needed' when the loop detects no progress (F2b): the run stays
// active but two consecutive passes dispatch nothing and observe no state change —
// the class-level backstop for the FG-476 on_reject-recovery shape (one instance of
// this pattern) and any future lifecycle bug that produces the same "active but
// nothing is dispatchable" mismatch. Without this bound the loop spins at 100% CPU
// (the FG-475/FG-476 incident) instead of parking cooperatively.
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
): Promise<{ outcome: "continue" | "paused" | "recovery_needed"; itemRecord: CampaignItemRecord }> {
  const itemId = item.id;
  const ticketId = item.ticketId;
  const doGate = fns.gateFn ?? gate;
  const NO_PROGRESS_LIMIT = 2;
  const CONVERGE_LIMIT = 2;
  let noProgressStreak = 0;
  let convergeAttempts = 0;
  let lastSnapshot: string | null = null;

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
      try {
        reconcileTerminalOutcome(termRun, itemId, fns.projectDir);
      } catch (err) {
        throw await parkCampaignOnDriveThrow(campaignId, itemId, ticketId, runId, err);
      }
      const updatedItem = getCampaignItem(itemId);
      const bk = updatedItem?.blockerKind;
      // campaign_system is a shared blocker — pause the campaign
      if (bk && isSharedBlocker(bk)) {
        await parkCampaign(campaignId, itemId, "blocked", { exemption: "item-carries-context" });
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

    // FG-425 (AC5): ahead of every other branch — a task whose publication advanced
    // the target ref and then lost the window. Its candidate may ALREADY be on the
    // target, so the campaign must not report it as failed, must not retry it, and
    // must not let it fall through to the no-progress backstop (which would mislabel
    // it awaiting_gate).
    //
    // But it must not park INSTEAD of converging, either. runNext's wave prologue is
    // the ONLY caller of the AD-5 convergence authority (recoverUnfinishedPublications,
    // then reconcilePublicationRecoveries) — so a branch that parks and returns here,
    // ahead of the runNext call in Step 5, can never converge anything: every resume
    // re-enters, re-parks identically, and the item the park tells the operator to
    // `forge campaign resume` is the one command guaranteed not to help. That is the
    // FG-475 wedge shape.
    //
    // So: DRIVE THE EXISTING AUTHORITY FIRST. Call runNext (which converges the
    // publication from the recorded ref and reconciles the task onto whatever landed)
    // and loop — a converged task falls through to the normal drive path at the top.
    // Nothing is re-dispatched: convergence reconciles the task onto the candidate
    // that is already on the target, it never re-runs it. Bounded by CONVERGE_LIMIT
    // per drive, in kind with NO_PROGRESS_LIMIT below, so an attempt that genuinely
    // cannot settle (a live publisher still owns the window) parks instead of spinning.
    const recoveringTask = tasks.find((t) => t.status === "awaiting_recovery");
    if (recoveringTask) {
      if (convergeAttempts < CONVERGE_LIMIT) {
        convergeAttempts++;
        try {
          await fns.runNextFn({ runId, workflow });
        } catch (err) {
          throw await parkCampaignOnDriveThrow(campaignId, itemId, ticketId, runId, err);
        }
        continue;
      }

      // Convergence was attempted and the attempt is still unsettled — the window is
      // held by someone else, or the publisher has not released it yet. Park on the
      // truth, with guidance that names commands which now genuinely converge it.
      updateCampaignItem(itemId, {
        lifecycleStatus: "awaiting_recovery",
        blockerKind: "git_state",
        requestedHumanAction:
          `step ${recoveringTask.phase} lost the publication window AFTER its ref advance landed — the publish ` +
          `target may ALREADY carry its candidate, and AD-5 convergence could not settle the attempt on this drive ` +
          `(the publication window is still held). Nothing was lost and nothing needs re-running: do NOT retry ` +
          `${recoveringTask.id}. Once the window is free, run \`forge campaign resume ${campaignId}\` (or ` +
          `\`forge next ${runId}\`) to converge the publication (AD-5) and reconcile the task onto what actually landed.`,
      });
      await parkCampaign(campaignId, itemId, "blocked", { exemption: "item-carries-context" });
      return {
        outcome: "paused",
        itemRecord: {
          itemId,
          ticketId,
          runId,
          lifecycleStatus: "awaiting_recovery",
          blockerKind: "git_state",
        },
      };
    }

    const blockedRedTask = tasks.find((t) => t.status === "blocked_by_red");
    if (blockedRedTask) {
      updateCampaignItem(itemId, {
        lifecycleStatus: "blocked_by_red",
        outcome: "blocked",
        blockerKind: "scope",
        requestedHumanAction: `workflow blocked by authoritative reviewer at step ${blockedRedTask.phase}`,
      });
      await parkCampaign(campaignId, itemId, "blocked", { exemption: "item-carries-context" });
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
        try {
          await doGate(awaitingTask.id, "advance", "campaign: auto-advance (gate:auto)", {});
        } catch (err) {
          throw await parkCampaignOnDriveThrow(campaignId, itemId, ticketId, runId, err);
        }
      } else if (gateType === "verdict") {
        const taskVerdicts = verdictsForTask(awaitingTask.id);
        const agg = aggregateVerdicts(taskVerdicts);
        if (agg.verdict === "pass") {
          try {
            await doGate(awaitingTask.id, "advance", "campaign: auto-advance (gate:verdict, all reds passed)", {});
          } catch (err) {
            throw await parkCampaignOnDriveThrow(campaignId, itemId, ticketId, runId, err);
          }
        } else if (agg.verdict === "fail") {
          updateCampaignItem(itemId, {
            lifecycleStatus: "blocked_by_red",
            outcome: "blocked",
            blockerKind: "scope",
            requestedHumanAction: `workflow blocked by failing verdict at step ${step?.id ?? awaitingTask.phase}`,
          });
          await parkCampaign(campaignId, itemId, "blocked", { exemption: "item-carries-context" });
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
          await parkCampaign(campaignId, itemId, "blocked", { exemption: "item-carries-context" });
          parked = true;
          break;
        }
      } else {
        // gate:human — one of two producers of 'awaiting_gate' (the other being an
        // invoke-lane item that finished without shipping; see the invoke-lane finalize
        // sites below). Both set no blockerKind, which is what marks them as the
        // out-of-band shape `forge campaign reconcile` looks for.
        updateCampaignItem(itemId, {
          lifecycleStatus: "awaiting_gate",
          requestedHumanAction: `Human gate required at step ${step?.id ?? awaitingTask.phase} in workflow ${currentRun.workflow}`,
        });
        // FG-516 (finding F2): a gate:human park persists no blockerKind by design
        // (that unset field marks the out-of-band reconcile shape), so compose a
        // body-only label — otherwise the pushed body carries no blocker kind at all.
        await parkCampaign(campaignId, itemId, "decision_needed", { exemption: "item-carries-context" }, { bodyBlockerKind: "human_gate" });
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
    const snapshot = JSON.stringify({
      runStatus: currentRun.status,
      tasks: tasks.map((t) => ({ id: t.id, status: t.status })).sort((a, b) => a.id.localeCompare(b.id)),
    });
    let nextResult: RunNextResult;
    try {
      nextResult = await fns.runNextFn({ runId, workflow });
    } catch (err) {
      throw await parkCampaignOnDriveThrow(campaignId, itemId, ticketId, runId, err);
    }
    const dispatchedNothing =
      nextResult.dispatchedSteps.length === 0 &&
      nextResult.completedSteps.length === 0 &&
      nextResult.awaitingGate.length === 0 &&
      nextResult.failedSteps.length === 0 &&
      nextResult.runStatus === "active";
    noProgressStreak = dispatchedNothing && snapshot === lastSnapshot ? noProgressStreak + 1 : 0;
    lastSnapshot = snapshot;

    if (noProgressStreak >= NO_PROGRESS_LIMIT) {
      // F2b: run active, nothing dispatched, no observable state change across
      // two passes — park like the existing gate:human shape (awaiting_gate, no
      // blockerKind) so the FG-441 reattach liveness probe re-examines this exact
      // run on resume instead of the campaign refusing outright via campaignBlocker.
      updateCampaignItem(itemId, {
        lifecycleStatus: "awaiting_gate",
        requestedHumanAction: `drive loop made no progress on run ${runId}: it is active but nothing is dispatchable. Inspect the run's tasks (forge show ${runId}), resolve the blockage, then resume.`,
      });
      // FG-516 (finding F2): the no-progress backstop parks awaiting_gate with no
      // persisted blockerKind (same recoverable reattach shape), so compose a
      // body-only label so the pushed body still leads with a blocker kind.
      await parkCampaign(campaignId, itemId, "blocked", { exemption: "item-carries-context" }, { bodyBlockerKind: "no_progress" });
      const updatedItem = getCampaignItem(itemId);
      return {
        outcome: "recovery_needed",
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
    // Loop continues: re-read run status and tasks at the top.
  }
}

// FG-483: the SINGLE shared evidence-eligibility evaluation for a drive-time
// invoke-lane finalize (quick_implementation and the docs_only/test_only/
// review_only/research_only escape hatch) — the exact composeOutOfBandEligibility
// chain the FG-441 reattach branch above already uses for the resume path, so
// drive-time and resume-time can never disagree for the same evidence. Replaces
// the pre-FG-483 check (freshTicket.status==='done' && !!freshTicket.closedCommit)
// that trusted hand-editable ticket frontmatter alone — spoofable by any agent
// that can self-close its own ticket with a fabricated closedCommit (review F4).
function evaluateInvokeLaneEligibility(
  projectDir: string,
  item: CampaignItem
): { eligible: boolean; missing: string[]; evidence: unknown } {
  const authoritative = authoritativeOutcomeContribution(collectReconcileEvidence(projectDir, item));
  const outOfBand = evaluateOutOfBandEvidence(collectOutOfBandEvidence(projectDir, item));
  return composeOutOfBandEligibility({ outOfBand, authoritative, hasRunId: true });
}

type InvokeLaneFinalizeResult = { outcome: "shipped" } | { outcome: "parked"; missing: string[] };

// FG-483: applies an evaluateInvokeLaneEligibility verdict — refuses (logging
// the SAME campaign_item.evidence_reconcile_refused event the reattach path
// emits) or ships. The terminal 'shipped' write is guarded by the SAME
// running-gated CAS the reattach path uses (updateCampaignItemIfCampaignRunning):
// a concurrent pause/abandon landing between the evidence check and the write
// must never let this be an optimistic ship. When the CAS is lost (eligible,
// but the campaign left 'running' underneath us) the caller parks the item at
// 'awaiting_gate' exactly like a genuine refusal — never left at its prior
// 'running' status — so the SAME reattach branch above can finish the job on
// the next resume/reconcile instead of stranding the item mid-flight.
function finalizeInvokeLaneOutcome(
  campaignId: string,
  item: CampaignItem,
  evaluated: { eligible: boolean; missing: string[]; evidence: unknown },
  opts: { shippedReason?: string } = {}
): InvokeLaneFinalizeResult {
  if (!evaluated.eligible) {
    logEvent("campaign_item.evidence_reconcile_refused", {
      runId: item.runId,
      payload: {
        campaignId,
        itemId: item.id,
        ticketId: item.ticketId,
        missing: evaluated.missing,
        decidedBy: "campaign_drive",
        decidedAt: nowIso(),
      },
    });
    return { outcome: "parked", missing: evaluated.missing };
  }

  const shipped = writeTransaction(() => {
    // Only touch `reason` when the caller has one to set (e.g. quick_implementation's
    // docs-impact warning) — an omitted key preserves whatever pre-dispatch reason is
    // already on the item (e.g. FG-393's "continued because ..." for an item that
    // continued past a blocker), since {...existing, ...update} treats a present-but-
    // undefined key as an explicit clear, not a no-op.
    const update: Parameters<typeof updateCampaignItemIfCampaignRunning>[2] = {
      lifecycleStatus: "complete",
      outcome: "shipped",
    };
    if (opts.shippedReason) update.reason = opts.shippedReason;
    const applied = updateCampaignItemIfCampaignRunning(item.id, campaignId, update);
    if (!applied) return false;
    logEvent("campaign_item.evidence_reconciled", {
      runId: item.runId,
      payload: {
        campaignId,
        itemId: item.id,
        ticketId: item.ticketId,
        evidence: evaluated.evidence,
        decidedBy: "campaign_drive",
        decidedAt: nowIso(),
      },
    });
    return true;
  });

  return shipped ? { outcome: "shipped" } : { outcome: "parked", missing: [] };
}

// Shared item-dispatch loop used by startCampaign and resumeCampaign.
// Requires the campaign to already be in 'running' state.
// Skips terminal items (complete/failed); dispatches only pending items.
// Reattaches to workflow items in awaiting_gate or blocked_by_red on resume.
// Cooperative pause: re-reads campaign status before each dispatch and after
// each item completes, stopping without transition if status != 'running'.
// Exported (test-only) so a test can drive an item whose lifecycle status
// slipped past campaignBlocker straight into the in-flight/indeterminate park —
// that backstop is otherwise shadowed by campaignBlocker and unreachable through
// startCampaign/resumeCampaign.
// FG-596: drive ONE campaign item to a terminal drive-process outcome or a legal
// park. This is the standalone operation the launch-per-item controller launches (as
// `forge campaign drive-item`) and waits on; ALL of the single-item work — startRun/
// insertRun + generation persist + dispatch-key stamp, runNext within-item waves,
// publication convergence, gates, item finalization, and every park-on-throw — runs
// SYNCHRONOUSLY here so every durable transition commits before the (child) process
// exits. The body is the former item-loop body verbatim (FG-425 invariants preserved
// byte-for-byte): a `continue` in the original — advance to the next item without
// halting — becomes a fall-through to the terminal `return { itemRecords }` (no
// stopReason), and a `return { stopReason, itemRecords }` returns as-is. Cross-item
// controller state (blockedItems / held accounting) is re-derived from DURABLE state
// so a single item is self-contained across a process boundary.
export async function driveOneCampaignItem(
  campaignId: string,
  itemId: string,
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
): Promise<DriveOneItemResult> {
  const itemRecords: CampaignItemRecord[] = [];
  const items = listCampaignItems(campaignId);
  const targetItem = items.find((i) => i.id === itemId);
  if (!targetItem) return { itemRecords };
  const ticketCache = listTickets(opts.projectDir);
  const ticketMap = new Map(ticketCache.map((t) => [t.id, t]));

  // Read per-item execution config from campaign canonical content.
  const campaignData = getCampaign(campaignId);
  const canonicalContent = campaignData?.metadata?.["planContent"];

  const doRunNext: RunNextFn = opts.runNextFn ?? runNext;
  const doStartRun: StartRunFn = opts.startRunFn ?? startRun;
  const doLoadWorkflow: LoadWorkflowFn = opts.loadWorkflowFn ?? loadWorkflow;

  // Track LOCAL blocked items for dependency-based hold evaluation. Each item now
  // drives in isolation (its own process, under a launch), so rebuild blockedItems
  // from the DURABLE terminal state of the items that precede this one — the exact
  // set the old in-loop terminal-skip rebuild accumulated by the time it reached this
  // item. Prior items are final before this one is launched (the controller drives
  // strictly in order), so this is faithful.
  const blockedItems: BlockedItemEntry[] = [];
  let anyHeld = false;
  for (const prior of items) {
    if (prior.id === itemId) break;
    if (
      prior.lifecycleStatus === "failed" &&
      prior.outcome === "blocked" &&
      prior.blockerKind &&
      !isSharedBlocker(prior.blockerKind)
    ) {
      const t = ticketMap.get(prior.ticketId);
      if (t) blockedItems.push({ id: prior.ticketId, ticket: t, blockerKind: prior.blockerKind });
    }
  }

  for (const item of [targetItem]) {
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
    if (
      item.lifecycleStatus === "awaiting_gate" ||
      item.lifecycleStatus === "blocked_by_red" ||
      // FG-425 (AC5): a parked-on-unsettled-publication item reattaches like any other
      // parked workflow item. Re-driving its run is what converges the publication.
      item.lifecycleStatus === "awaiting_recovery"
    ) {
      // Populated by the FG-485 liveness probe below when it successfully loads
      // the active run's workflow, so the driveWorkflowItem call further down
      // reuses that fetch instead of re-deriving the same run/workflow.
      let preloadedRun: Run | undefined;
      let preloadedWorkflow: Workflow | undefined;

      // FG-441: an awaiting_gate item with no blockerKind can have been driven
      // manually OUTSIDE this loop after the campaign attached its run — through
      // gates/fixers/red/host-verification/PR-merge/backlog-close — leaving the
      // item shipped in reality but still parked here. Before re-parking it via
      // driveWorkflowItem below, re-derive shipped-ness from the SAME durable
      // evidence `forge campaign reconcile`'s scope-blocked branch uses. Only
      // fires for the manually-driven shape: blocked_by_red and any item WITH a
      // blockerKind are FG-428/other lanes and must reach driveWorkflowItem unchanged.
      if (item.lifecycleStatus === "awaiting_gate" && !item.blockerKind && item.runId) {
        // FG-485: liveness-first. An awaiting_gate item with no blockerKind can
        // ALSO mean the operator decided the gate in-run (forge gate <task>
        // request-changes / advance) and then called campaign resume — that
        // seeds either a pending replacement primary in the same phase
        // (request-changes) or clears the way for the next phase to become
        // ready (advance), and the run is still 'active' with real dispatchable
        // work. Treating that the same as a genuinely manually-driven/terminal
        // run and jumping straight to out-of-band evidence evaluation is
        // exactly the FG-485 bug: the pending replacement never gets dispatched
        // and the item is re-parked on missing ship evidence that was never
        // going to exist yet. Check liveness BEFORE evidence: if the run is
        // active and computeReadyQueue (the same ready-queue runNext/gate.ts
        // use to decide what's dispatchable right now) finds a ready step,
        // skip the evidence path entirely and fall through to the
        // getRun/driveWorkflowItem path below so this resume re-enters the
        // drive loop. Only a run that's absent, not active, or settled with
        // nothing left to dispatch reaches the evidence fallback.
        //
        // FG-483/FG-486: this probe only applies to pipeline runs (taskHasPipelineFinalize
        // true) — those have a YAML workflow that must load and a drive loop
        // (computeReadyQueue) that can have more dispatchable work. invoke-family
        // runs ("invoke" / "invoke_chain") have no loadable workflow and no drive
        // loop to re-enter at all, so for those the probe is skipped entirely and
        // this reattach falls straight through to the out-of-band evidence path
        // below, exactly as it did before the FG-485 liveness check existed.
        let hasDispatchableWork = false;
        const liveRun = getRun(item.runId);
        if (liveRun && liveRun.status === "active" && taskHasPipelineFinalize(liveRun)) {
          let liveWorkflow: Workflow;
          try {
            liveWorkflow = doLoadWorkflow(liveRun.workflow, { projectDir: opts.projectDir });
          } catch {
            // The run is ACTIVE but its workflow failed to load — an infra/load
            // failure, not a manually-driven/settled run. This must never reach
            // the evidence path below (that would emit a false
            // evidence_reconcile_refused for a live run). Route directly to the
            // same recovery_needed handling the shared block further down uses.
            itemRecords.push({ itemId: item.id, ticketId: item.ticketId, runId: item.runId, lifecycleStatus: item.lifecycleStatus });
            // FG-518: the resume liveness-probe workflow-load-failure park fires its
            // milestone WITHOUT re-describing the load failure — the item is an
            // out-of-band awaiting_gate row (no blockerKind), so the body retains its
            // OLD gate action. Composing a truthful load-failure body here IS the
            // FG-518 deliverable; deferred as a documented known-gap, not faked.
            await parkCampaign(campaignId, item.id, "blocked", { exemption: "known-gap", ticket: "FG-518" });
            return { stopReason: "recovery_needed", itemRecords };
          }
          const liveTasks = tasksForRun(item.runId);
          hasDispatchableWork = computeReadyQueue(liveWorkflow, liveTasks).length > 0;
          preloadedRun = liveRun;
          preloadedWorkflow = liveWorkflow;
        }

        if (!hasDispatchableWork) {
          // FG-460: evaluate this reattach with the SAME shared out-of-band
          // composition `forge campaign reconcile` uses (reconcile.ts's isOutOfBand
          // branch) — MINUS reconcile's host-verification capture, which is
          // reconcile-only. Previously resume used evaluateReconcileEvidence, whose
          // fixed host_verification requirement wrongly refused a docs-only
          // (non_code_diff) item that reconcile ships (FG-452's lane needs no host
          // gate). Now both paths reach the same verdict for the same evidence by
          // construction: resume ships a docs-only item, still refuses an
          // unresolved authoritative fail, and — because it never captures — still
          // refuses any code-touching item that lacks a passing host-verification
          // row (it never starts shipping un-verified code; the widening is scoped
          // to the non_code_diff lane).
          const evaluated = evaluateInvokeLaneEligibility(opts.projectDir, item);
          if (evaluated.eligible) {
            // Atomic: same paused-guard pattern reconcile.ts uses, gated on 'running'
            // instead of 'paused' — resumeCampaign already transitioned the campaign
            // to 'running' before driveRemainingItems runs, so a paused-only guard
            // would make this write a permanent no-op. A concurrent pause/abandon
            // between the evidence check and this write still lands as a no-op here,
            // never an optimistic ship.
            const shipped = writeTransaction(() => {
              const applied = updateCampaignItemIfCampaignRunning(item.id, campaignId, {
                lifecycleStatus: "complete",
                outcome: "shipped",
                blockerKind: undefined,
                reason: undefined,
                requestedHumanAction: undefined,
              });
              if (!applied) return false;
              logEvent("campaign_item.evidence_reconciled", {
                runId: item.runId,
                payload: {
                  campaignId,
                  itemId: item.id,
                  ticketId: item.ticketId,
                  evidence: evaluated.evidence,
                  decidedBy: "campaign_resume",
                  decidedAt: nowIso(),
                },
              });
              return true;
            });
            if (shipped) {
              itemRecords.push({
                itemId: item.id,
                ticketId: item.ticketId,
                runId: item.runId,
                lifecycleStatus: "complete",
                outcome: "shipped",
              });
              continue;
            }
            // Campaign left 'running' between the evidence check and the write —
            // fall through; the cooperative-pause checks below will stop cleanly.
          } else {
            console.error(
              `campaign resume: ${item.ticketId} is awaiting_gate on a manually-driven run but evidence is incomplete — refusing to ship and re-parking (missing: ${evaluated.missing.join(", ")})`
            );
            logEvent("campaign_item.evidence_reconcile_refused", {
              runId: item.runId,
              payload: {
                campaignId,
                itemId: item.id,
                ticketId: item.ticketId,
                missing: evaluated.missing,
                decidedBy: "campaign_resume",
                decidedAt: nowIso(),
              },
            });
          }
        }
        // else: the run has live dispatchable work — fall through below to
        // re-enter the drive loop instead of evaluating ship evidence.
      }

      if (!item.runId) {
        // FG-516: a parked workflow item (awaiting_gate/blocked_by_red) with no run
        // to reattach to is a campaign-machinery wedge (campaign_system). Persist
        // blockerKind + requestedHumanAction BEFORE parking so notifyCampaignPause
        // emits a real "blocker: … — …" body instead of the generic "parked <ticket>"
        // fallback. Distinct from the FG-518 workflow-load deferral below; the FG-441
        // reattach marker (unset blockerKind) doesn't apply here — that path is gated
        // on item.runId, which is absent.
        updateCampaignItem(item.id, {
          blockerKind: "campaign_system",
          requestedHumanAction: `campaign has no run to reattach for ${item.ticketId} (parked '${item.lifecycleStatus}' with no runId) — inspect the item, resolve it, then \`forge campaign resume ${campaignId}\`.`,
        });
        itemRecords.push({ itemId: item.id, ticketId: item.ticketId, runId: item.runId, lifecycleStatus: item.lifecycleStatus, blockerKind: "campaign_system" });
        // This item has no run of its own, so scope the pause milestone to a
        // campaign fallback run instead of going silent.
        await parkCampaign(campaignId, item.id, "blocked", { exemption: "item-carries-context" }, { fallbackRunId: pickCampaignFallbackRunId(campaignId) });
        return { stopReason: "recovery_needed", itemRecords };
      }
      const runForItem = preloadedRun ?? getRun(item.runId);
      if (!runForItem) {
        // FG-516: the item's persisted runId no longer resolves. A normal
        // human-gate item reaches here with NO persisted blockerKind (the FG-441
        // reattach marker), so — like the other unattended parks — supply
        // blockerKind + requestedHumanAction BEFORE notifying so notifyCampaignPause
        // emits a real "blocker: … — …" body instead of its generic "parked
        // <ticket>" fallback. An item that ALREADY carries a meaningful blockerKind
        // (FG-428's 'scope' lane, etc.) keeps it untouched. Scope the milestone to a
        // campaign fallback run; without it notifyCampaignPause rejects the stale
        // runId and this recovery park goes silent.
        if (!item.blockerKind) {
          updateCampaignItem(item.id, {
            blockerKind: "campaign_system",
            requestedHumanAction: `campaign lost the run for ${item.ticketId} (persisted runId '${item.runId}' no longer resolves) — inspect the item, resolve it, then \`forge campaign resume ${campaignId}\`.`,
          });
        }
        itemRecords.push({ itemId: item.id, ticketId: item.ticketId, runId: item.runId, lifecycleStatus: item.lifecycleStatus, blockerKind: item.blockerKind ?? "campaign_system" });
        await parkCampaign(campaignId, item.id, "blocked", { exemption: "item-carries-context" }, { fallbackRunId: pickCampaignFallbackRunId(campaignId) });
        return { stopReason: "recovery_needed", itemRecords };
      }
      let workflowForItem: Workflow;
      if (preloadedWorkflow) {
        workflowForItem = preloadedWorkflow;
      } else {
        try {
          workflowForItem = doLoadWorkflow(runForItem.workflow, { projectDir: opts.projectDir });
        } catch {
          itemRecords.push({ itemId: item.id, ticketId: item.ticketId, runId: item.runId, lifecycleStatus: item.lifecycleStatus });
          // FG-518: the reattach-path twin of the liveness-probe load-failure park
          // above — same out-of-band awaiting_gate item, same deferred difficulty of
          // composing a load-failure body over a row carrying a stale gate action.
          // Deferred to FG-518 with its sibling as one coherent unit, not half-fixed.
          await parkCampaign(campaignId, item.id, "blocked", { exemption: "known-gap", ticket: "FG-518" });
          return { stopReason: "recovery_needed", itemRecords };
        }
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

      if (driveResult.outcome === "recovery_needed") {
        return { stopReason: "recovery_needed", itemRecords };
      }

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
      // FG-516: like every other unattended park, persist the two context fields
      // BEFORE notifying so notifyCampaignPause emits a real "blocker: … — …" body
      // instead of its generic "parked <ticket>" fallback. An item stuck in an
      // unhandled lifecycle status is a campaign-machinery wedge (campaign_system).
      updateCampaignItem(item.id, {
        blockerKind: "campaign_system",
        requestedHumanAction: `campaign left ${item.ticketId} in the unexpected lifecycle status '${item.lifecycleStatus}' — inspect the item${item.runId ? ` (forge show ${item.runId})` : ""}, resolve it, then \`forge campaign resume ${campaignId}\`.`,
      });
      itemRecords.push({
        itemId: item.id,
        ticketId: item.ticketId,
        runId: item.runId,
        lifecycleStatus: item.lifecycleStatus,
        blockerKind: "campaign_system",
      });
      await parkCampaign(campaignId, item.id, "blocked", { exemption: "item-carries-context" }, { fallbackRunId: pickCampaignFallbackRunId(campaignId) });
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
          // FG-516: persist blockerKind + requestedHumanAction so the anyHeld park's
          // milestone carries real context (which dependency + how to clear it),
          // not the generic "parked <ticket>" fallback.
          updateCampaignItem(item.id, {
            outcome: "held",
            blockerKind: "dependency",
            continuePolicy: "hold_dependents",
            reason: holdResult.reason,
            requestedHumanAction: `held on dependency ${holdResult.holderId} — resolve/complete ${holdResult.holderId}, then forge campaign resume`,
          });
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
        // FG-516: persist blockerKind + requestedHumanAction so the anyHeld park's
        // milestone carries real context (which dependency + how to clear it),
        // not the generic "parked <ticket>" fallback.
        updateCampaignItem(item.id, {
          outcome: "held",
          blockerKind: "dependency",
          continuePolicy: "hold_dependents",
          reason: holdResult.reason,
          requestedHumanAction: `held on dependency ${holdResult.holderId} — resolve/complete ${holdResult.holderId}, then forge campaign resume`,
        });
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

    // FG-596 LEGACY FAIL-CLOSED: a pending item whose runId resolves to a REAL run row
    // must NEVER be replaced with a fresh run — that would orphan/duplicate a genuine
    // attempt. This is the pre-FG-596 legacy shape (a run dispatched before the
    // generation/key stamp existed) and the crash-mid-dispatch shape (run created, item
    // not yet moved off 'pending'). The dispatch lanes below are the only run-CREATING
    // paths, so guard them here; the no-dispatch lanes (ticketing_only/manual) never mint
    // a run and are exempt. A DANGLING runId string with no backing run row (e.g. a
    // held-then-cleared item whose linkage columns survived the hold reset, FG-410) has
    // nothing to preserve — fall through to a fresh dispatch that re-stamps it. When a
    // real run exists, park it ADOPTABLE (the run stays intact, reachable by dispatch
    // key) and surface recovery_needed — do not auto-recover (FG-564 owns adoption).
    if (item.runId && itemConfig.lane !== "ticketing_only" && itemConfig.lane !== "manual" && getRun(item.runId)) {
      updateCampaignItem(item.id, {
        lifecycleStatus: "awaiting_gate",
        blockerKind: "campaign_system",
        requestedHumanAction:
          `${item.ticketId} is pending but already carries run ${item.runId} with no fresh dispatch ` +
          `(attempt_generation ${item.attemptGeneration}) — refusing to replace it (it may be a legacy ` +
          `pre-FG-596 attempt or an in-flight one). Inspect it (forge show ${item.runId}), resolve or ` +
          `abandon, then \`forge campaign resume ${campaignId}\`.`,
      });
      itemRecords.push({
        itemId: item.id,
        ticketId: item.ticketId,
        runId: item.runId,
        lifecycleStatus: "awaiting_gate",
        blockerKind: "campaign_system",
      });
      await parkCampaign(campaignId, item.id, "blocked", { exemption: "item-carries-context" }, { fallbackRunId: pickCampaignFallbackRunId(campaignId) });
      return { stopReason: "recovery_needed", itemRecords };
    }

    // FG-596: allocate/reuse the LOGICAL attempt generation and derive the deterministic
    // dispatch key, PERSISTED before any run is created — so all three lanes stamp the
    // SAME slot (run metadata.dispatchKey) startRun uses and runByDispatchKey dedups
    // lane-agnostically. gen 0 = never allocated → initial dispatch → allocate (→ 1); a
    // non-zero generation (bumped by an explicit retry) is REUSED unchanged so the key
    // stays stable across the same logical attempt.
    const stampGeneration = item.attemptGeneration > 0 ? item.attemptGeneration : allocateItemGeneration(item.id);
    const stampDispatchKey = deriveCampaignItemDispatchKey(campaignId, item.id, stampGeneration);

    // FG-596 (fix 1): ADOPTION LOOKUP — consume the deterministic key that fix's stamp
    // writes. A prior drive of THIS same logical attempt may have created a run and then
    // crashed BEFORE `updateCampaignItem` linked runId to the item (the C4 window; AC A6).
    // Because the generation is reused unchanged on a re-drive, the key re-derives
    // identically, so runByDispatchKey resolves that already-created run. ADOPT it (link
    // its runId to the item, mark running) rather than minting a second run. Each lane
    // below checks `adoptedRun` and skips its own run creation when it is set. The legacy
    // fail-closed guard above has already exempted a real run reachable via item.runId, so
    // this only fires for the unlinked-run crash window — never over a run the item already
    // points at. A retry mints a NEW generation → a distinct key → no false adoption.
    const adoptedRun = runByDispatchKey(stampDispatchKey);

    // FG-596 (A6): close the launch-boundary containment/child race BY CONSTRUCTION.
    // Before creating or linking ANY run, CLAIM the item atomically — flip pending→running
    // gated on the campaign still being 'running'. This is the SAME atomic 'pending'
    // precondition the launch-boundary containment now parks under
    // (updateCampaignItemIfPending), so the two can never both win: whichever CAS commits
    // first flips the item off 'pending' and the other becomes a no-op. If the containment
    // (or a concurrent operator pause/abandon) already parked the item / paused the
    // campaign, the claim REFUSES here and the child creates no run, links nothing, and
    // resurrects nothing — "paused campaign ⇒ no child-created run" holds by construction,
    // so the containment no longer has to assume anything about the child. The
    // ticketing_only/manual lanes dispatch no run at all, so they never claim (their
    // terminal complete/skipped write is not a run-creating transition). Adoption of a
    // crash-window run (FG-564) flows through the claim too: a re-drive of the SAME attempt
    // reaches here with the item still 'pending' (runId unlinked) and passes the gate.
    const laneDispatchesRun =
      itemConfig.lane !== "ticketing_only" && itemConfig.lane !== "manual";
    if (laneDispatchesRun) {
      const claimed = claimCampaignItemForDrive(
        item.id,
        campaignId,
        adoptedRun ? adoptedRun.id : undefined,
      );
      if (!claimed) {
        // The launch-boundary containment (or a concurrent operator pause/abandon) won the
        // race and already parked this item / paused the campaign. Do NOT create a run
        // behind it — reconcile from durable state exactly as the cooperative-pause checks
        // below would, and halt the controller cleanly.
        const durable = getCampaignItem(item.id);
        itemRecords.push({
          itemId: item.id,
          ticketId: item.ticketId,
          runId: durable?.runId,
          lifecycleStatus: durable?.lifecycleStatus ?? "failed",
          outcome: durable?.outcome,
          blockerKind: durable?.blockerKind,
          reason: durable?.reason,
        });
        const c = getCampaign(campaignId);
        return { stopReason: c?.status === "abandoned" ? "abandoned" : "paused", itemRecords };
      }
      if (adoptedRun) item.runId = adoptedRun.id;
      item.lifecycleStatus = "running";
    }

    if (itemConfig.lane === "full_feature") {
      // ── FULL_FEATURE: existing loadWorkflow/startRun/runNext path, UNCHANGED ─
      const workflowName = itemConfig.workflowName ?? "feature";

      // Load the workflow — failure containment mirrors the existing throw-catch pattern.
      let loadedWorkflow: Workflow;
      try {
        loadedWorkflow = doLoadWorkflow(workflowName, { projectDir: opts.projectDir });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        // FG-596: when a crash-window run was ADOPTED for this key (adoptedRun set, item
        // already linked+running above), the load failure must PRESERVE it — minting a
        // fresh abandoned run here would create a SECOND run on the same dispatch key and
        // replace the item linkage, orphaning the genuine attempt a re-drive is meant to
        // recover. So reuse the adopted run and keep it linked; only when there is nothing
        // to adopt do we create the synthetic abandoned run for traceability.
        const runId = adoptedRun ? adoptedRun.id : newRunId(item.ticketId);
        if (!adoptedRun) {
          insertRun({
            id: runId,
            workflow: workflowName,
            title: item.ticketId,
            status: "abandoned",
            createdAt: nowIso(),
            // FG-596 (fix 4): stamp the shared dispatch key + item-attempt identity on the
            // failure-fallback lane too, so EVERY run-creating lane is adoptable by key and
            // no lane silently duplicates on FG-564 adoption.
            metadata: { campaignId, ticketId: item.ticketId, itemId: item.id, dispatchKey: stampDispatchKey, attemptGeneration: stampGeneration },
            projectDir: opts.projectDir,
          });
        }
        updateCampaignItem(item.id, {
          runId,
          lifecycleStatus: "failed",
          outcome: "blocked",
          blockerKind: "campaign_system",
          requestedHumanAction: adoptedRun
            ? `workflow YAML missing or invalid: ${workflowName} — ${reason}. The in-flight attempt (run ${runId}) from a prior crash was PRESERVED and remains adoptable by its dispatch key — inspect it (forge show ${runId}) and resolve, then resume.`
            : `workflow YAML missing or invalid: ${workflowName} — ${reason}`,
        });
        itemRecords.push({
          itemId: item.id,
          ticketId: item.ticketId,
          runId,
          lifecycleStatus: "failed",
          outcome: "blocked",
        });
        if (await parkCampaign(campaignId, item.id, "blocked", { exemption: "item-carries-context" })) {
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
        campaignId,
        itemId: item.id,
        brief: ticketBrief,
        projectContext: cachedTicket
          ? `${item.ticketId}: ${cachedTicket.title}\n\n${cachedTicket.body}`
          : item.ticketId,
      };
      for (const key of CONTROL_PLANE_METADATA_KEYS) {
        delete inputs[key];
      }

      let runId: string;
      if (adoptedRun) {
        // FG-596 (fix 1): adopt the already-created run from the crash window instead of
        // starting a second one; drive THAT run to terminal below.
        runId = adoptedRun.id;
      } else try {
        const startResult = doStartRun({
          workflow: loadedWorkflow,
          title: item.ticketId,
          inputs,
          projectDir: opts.projectDir,
          // FG-596: stamp the deterministic dispatch key + item-attempt identity into
          // run metadata BEFORE the run is observable (startRun writes them pre-insert).
          dispatchKey: stampDispatchKey,
          attemptGeneration: stampGeneration,
        });
        runId = startResult.runId;
      } catch (err) {
        const failRunId = newRunId(item.ticketId);
        try {
          insertRun({
            id: failRunId,
            workflow: workflowName,
            title: item.ticketId,
            status: "abandoned",
            createdAt: nowIso(),
            // FG-596 (fix 4): stamp the shared dispatch key on the startRun-throw
            // fallback lane too — every run-creating lane is adoptable by key.
            metadata: { campaignId, ticketId: item.ticketId, itemId: item.id, dispatchKey: stampDispatchKey, attemptGeneration: stampGeneration },
            projectDir: opts.projectDir,
          });
        } catch {
          // best-effort synthetic run row for traceability — a failure here must
          // not stop parkCampaignOnStartRunThrow below from recording and rethrowing
          // the ORIGINAL startRun error.
        }
        throw await parkCampaignOnStartRunThrow(campaignId, item.id, item.ticketId, failRunId, err);
      }

      updateCampaignItem(item.id, { runId, lifecycleStatus: "running" });

      // Drive the workflow run to terminal or park.
      const driveResult = await driveWorkflowItem(campaignId, item, runId, loadedWorkflow, {
        runNextFn: doRunNext,
        gateFn: opts.gateFn,
        projectDir: opts.projectDir,
      });
      itemRecords.push(driveResult.itemRecord);

      if (driveResult.outcome === "recovery_needed") {
        return { stopReason: "recovery_needed", itemRecords };
      }

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
      // FG-596 (fix 1): adopt the crash-window run by key if one exists; else insert.
      const runId = adoptedRun?.id ?? newRunId(item.ticketId);
      if (!adoptedRun) {
        insertRun({
          id: runId,
          workflow: "invoke_chain",
          title: item.ticketId,
          status: "active",
          createdAt: nowIso(),
          // FG-596: route this insertRun lane through the SAME metadata.dispatchKey stamp
          // startRun uses (plus the item-attempt identity) so runByDispatchKey dedups it
          // lane-agnostically — an unstamped insertRun lane would silently duplicate on
          // FG-564 adoption.
          metadata: { invokeChain: ["engineer", "test-engineer"], campaignId, ticketId: item.ticketId, itemId: item.id, dispatchKey: stampDispatchKey, attemptGeneration: stampGeneration },
          projectDir: opts.projectDir,
        });
      }
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

      // Both invokes completed — finalize the item using the SAME evidence
      // eligibility the FG-441 resume/reattach path uses (see
      // evaluateInvokeLaneEligibility/finalizeInvokeLaneOutcome above): only a
      // genuinely eligible item may complete; anything else parks at
      // awaiting_gate for `forge campaign reconcile`/`forge campaign resume`
      // (or manual resolution) instead of reporting complete (FG-442 review
      // Finding 1; hardened by FG-483 to require real evidence — commit
      // reachability + a covering host-verification row for code-touching
      // commits, or the non_code_diff classification — never ticket
      // frontmatter alone).
      const itemWithRunId = { ...item, runId };
      const eligibility = evaluateInvokeLaneEligibility(opts.projectDir, itemWithRunId);

      // FG-442: docs-impact resolution — advisory only, mirrors milestone.ts's
      // ship-time check. quick_implementation has no docs phase of its own
      // (unlike full_feature's pipeline, which always runs documentation-maintainer).
      const docsWarning = eligibility.eligible ? formatDocsImpactWarning(assessRunDocsImpact(runId), runId) : null;

      const finalized = finalizeInvokeLaneOutcome(campaignId, itemWithRunId, eligibility, {
        shippedReason: docsWarning ?? undefined,
      });
      const outcome: CampaignItemOutcome | undefined = finalized.outcome === "shipped" ? "shipped" : undefined;

      // FG-516 (finding 1): the invoke-lane eligibility park below persists NO
      // blockerKind (the item stays the out-of-band awaiting_gate reconcile shape
      // reconcile.ts / report.ts / FG-483 all key off), so hand parkCampaign a
      // composed context whose kind feeds the pushed BODY label only — without it the
      // body carried no `blocker: <kind>` at all. human_decision is the honest kind:
      // the automated evidence gate could not confirm the ship, a human must review
      // and reconcile.
      let laneParkContext: ParkContext = { exemption: "item-carries-context" };
      if (finalized.outcome === "parked") {
        const parkAction =
          finalized.missing.length > 0
            ? `agent finished but evidence is incomplete for ${item.ticketId} (${finalized.missing.join(", ")}) — resolve and run \`forge campaign reconcile\`, or resolve manually`
            : `agent finished and ${item.ticketId} looks shipped, but the campaign state changed mid-evaluation — run \`forge campaign resume\` or \`forge campaign reconcile\` to finalize`;
        updateCampaignItem(item.id, { lifecycleStatus: "awaiting_gate", requestedHumanAction: parkAction });
        laneParkContext = { blockerKind: "human_decision", requestedHumanAction: parkAction };
      }

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
        lifecycleStatus: outcome === "shipped" ? "complete" : "awaiting_gate",
        outcome,
        ...(docsWarning ? { reason: docsWarning } : {}),
      });

      if (outcome !== "shipped") {
        if (await parkCampaign(campaignId, item.id, "decision_needed", laneParkContext)) {
          return { stopReason: "paused", itemRecords };
        }
        const post = getCampaign(campaignId);
        return { stopReason: post?.status === "abandoned" ? "abandoned" : "paused", itemRecords };
      }

      const postCheck = getCampaign(campaignId);
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
      // FG-596 (fix 1): adopt the crash-window run by key if one exists; else insert.
      const runId = adoptedRun?.id ?? newRunId(item.ticketId);
      if (!adoptedRun) {
        insertRun({
          id: runId,
          workflow: "invoke",
          title: item.ticketId,
          status: "active",
          createdAt: nowIso(),
          // FG-596: same shared metadata.dispatchKey stamp + item-attempt identity as the
          // other two lanes, so the escape-hatch insertRun run is adoptable by key too.
          metadata: { invokeAgent: agentRole, campaignId, ticketId: item.ticketId, itemId: item.id, dispatchKey: stampDispatchKey, attemptGeneration: stampGeneration },
          projectDir: opts.projectDir,
        });
      }
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

      // Only a genuinely eligible item may complete — the SAME evidence
      // eligibility the FG-441 resume/reattach path uses (see
      // evaluateInvokeLaneEligibility/finalizeInvokeLaneOutcome above);
      // anything else parks at awaiting_gate for `forge campaign
      // reconcile`/`forge campaign resume` (or manual resolution) instead of
      // reporting complete (FG-442 review; hardened by FG-483 to require real
      // evidence — commit reachability + a covering host-verification row for
      // code-touching commits, or the non_code_diff classification — never
      // ticket frontmatter alone).
      const itemWithRunId = { ...item, runId };
      const eligibility = evaluateInvokeLaneEligibility(opts.projectDir, itemWithRunId);
      const finalized = finalizeInvokeLaneOutcome(campaignId, itemWithRunId, eligibility);
      const outcome: CampaignItemOutcome | undefined = finalized.outcome === "shipped" ? "shipped" : undefined;

      // FG-516 (finding 2): same missing-blocker-label path as finding 1, on the
      // docs_only/test_only/review_only/research_only invoke lanes — persist no
      // blockerKind (out-of-band marker), feed the composed kind to the body label.
      let laneParkContext: ParkContext = { exemption: "item-carries-context" };
      if (finalized.outcome === "parked") {
        const parkAction =
          finalized.missing.length > 0
            ? `agent finished but evidence is incomplete for ${item.ticketId} (${finalized.missing.join(", ")}) — resolve and run \`forge campaign reconcile\`, or resolve manually`
            : `agent finished and ${item.ticketId} looks shipped, but the campaign state changed mid-evaluation — run \`forge campaign resume\` or \`forge campaign reconcile\` to finalize`;
        updateCampaignItem(item.id, { lifecycleStatus: "awaiting_gate", requestedHumanAction: parkAction });
        laneParkContext = { blockerKind: "human_decision", requestedHumanAction: parkAction };
      }

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
        lifecycleStatus: outcome === "shipped" ? "complete" : "awaiting_gate",
        outcome,
      });

      if (outcome !== "shipped") {
        if (await parkCampaign(campaignId, item.id, "decision_needed", laneParkContext)) {
          return { stopReason: "paused", itemRecords };
        }
        const post = getCampaign(campaignId);
        return { stopReason: post?.status === "abandoned" ? "abandoned" : "paused", itemRecords };
      }

      const postCheck = getCampaign(campaignId);
      if (!postCheck || postCheck.status !== "running") {
        return {
          stopReason: postCheck?.status === "abandoned" ? "abandoned" : "paused",
          itemRecords,
        };
      }
    }
  }

  // The single-item body fell through without a stop-return (a `continue` in the
  // former loop): the item settled — shipped / skipped / held / local-blocked — WITHOUT
  // halting the campaign. `anyHeld` is retained above only to preserve the body
  // byte-for-byte; the held-park + completion decision is the controller's, derived
  // from durable state after every item has drained.
  void anyHeld;
  return { itemRecords };
}

// FG-596: the launch-per-item controller. Drives one launch per item, waits in-process
// on `forge launch wait`, and reads the item outcome from DURABLE state after the wake
// — it no longer blocks in-process on the item's containers, and it NEVER branches on
// the launch disposition (exited_ok/non-zero/owner_gone/unknown) to decide
// shipped/parked/failed. Cross-item state (held accounting, completion) is derived from
// durable state after the items drain. Shared item-dispatch loop for startCampaign and
// resumeCampaign; requires the campaign to already be 'running'.
export async function driveRemainingItems(
  campaignId: string,
  opts: {
    dispatch: (args: InvokeArgs) => Promise<InvokeResult>;
    projectDir: string;
    mode: string;
    // For testing: inject workflow-path dependencies (threaded into the in-process
    // drive when no launcher is injected).
    runNextFn?: RunNextFn;
    startRunFn?: StartRunFn;
    loadWorkflowFn?: LoadWorkflowFn;
    gateFn?: typeof gate;
    // FG-596: how a single item is driven. Absent → the in-process drive below (used
    // by the whole existing campaign test suite and any direct programmatic caller).
    // The CLI supplies the real subprocess launcher (launchDriveItemUnderForge) so the
    // production `forge campaign start/resume` gets the cross-process per-item boundary.
    launchDriveItem?: DriveItemLaunchFn;
  }
): Promise<CampaignRunResult> {
  const itemRecords: CampaignItemRecord[] = [];

  const launch: DriveItemLaunchFn =
    opts.launchDriveItem ??
    ((cid, itemId) =>
      driveOneCampaignItem(cid, itemId, {
        dispatch: opts.dispatch,
        projectDir: opts.projectDir,
        mode: opts.mode,
        runNextFn: opts.runNextFn,
        startRunFn: opts.startRunFn,
        loadWorkflowFn: opts.loadWorkflowFn,
        gateFn: opts.gateFn,
      }));

  const items = listCampaignItems(campaignId);
  for (const item of items) {
    // Safe-terminal: skip idempotently on re-drive (no launch for a settled item).
    if (item.lifecycleStatus === "complete" || item.lifecycleStatus === "failed") continue;

    // Cooperative pause: re-read campaign status before launching each item.
    const preCheck = getCampaign(campaignId);
    if (!preCheck || preCheck.status !== "running") {
      return { stopReason: preCheck?.status === "abandoned" ? "abandoned" : "paused", itemRecords };
    }

    // Launch item N and wait in-process; the launcher reads the outcome from durable
    // state (never the disposition). A drive error inside the child is committed as a
    // durable park BEFORE the child exits, so it surfaces here as a stopReason, not an
    // in-process throw (the in-process launcher preserves the throw for existing tests).
    const result = await launch(campaignId, item.id);
    itemRecords.push(...result.itemRecords);
    if (result.stopReason) {
      return { stopReason: result.stopReason, itemRecords };
    }

    // Cooperative pause after the item settles.
    const postCheck = getCampaign(campaignId);
    if (!postCheck || postCheck.status !== "running") {
      return { stopReason: postCheck?.status === "abandoned" ? "abandoned" : "paused", itemRecords };
    }
  }

  // All items drained without halting. Held items (derived from durable state) keep the
  // campaign paused awaiting resume; otherwise it completes. This is the former
  // end-of-loop anyHeld/completeCampaign decision, now reading durable item state.
  // FG-516 (finding F3): the held pause is an unattended running→paused park, so it
  // still notifies (scoped to a campaign fallback run; the per campaign+item dedupe key
  // keeps a re-park across resumes from spamming).
  const finalItems = listCampaignItems(campaignId);
  const heldItemIds = [...new Set(finalItems.filter((i) => i.outcome === "held").map((i) => i.id))];
  if (heldItemIds.length > 0) {
    if (await parkCampaign(campaignId, heldItemIds, "blocked", { exemption: "item-carries-context" }, { fallbackRunId: pickCampaignFallbackRunId(campaignId) })) {
      return { stopReason: "paused", itemRecords };
    }
    const finalCheck = getCampaign(campaignId);
    return { stopReason: finalCheck?.status === "abandoned" ? "abandoned" : "paused", itemRecords };
  }

  if (completeCampaign(campaignId)) {
    return { stopReason: "complete", itemRecords };
  }
  const finalCheck = getCampaign(campaignId);
  return {
    stopReason: finalCheck?.status === "abandoned" ? "abandoned" : "paused",
    itemRecords,
  };
}

// FG-596 (fix 3): a drive-error park shape — the durable item that
// parkCampaignOnDriveThrow (awaiting_gate) or parkCampaignOnStartRunThrow
// (failed/blocked/infrastructure) leaves after a drive THROW. Mirrors the exact
// predicate renderDriveErrorAndExit matches on, so a re-raise from durable state lands
// the same CLI rendering. `reason` carries the original error message.
function isDriveErrorParkShape(item: CampaignItem): boolean {
  return (
    item.lifecycleStatus === "awaiting_gate" ||
    (item.lifecycleStatus === "failed" && item.outcome === "blocked" && item.blockerKind === "infrastructure")
  );
}

// FG-596 (fix 3): the item reached a terminal or parked state (the drive committed a
// durable transition off pending/running). Its negation means the drive process ended
// while the item was still mid-flight — a crash, not a settle.
function isItemSettledOrParked(item: CampaignItem | undefined): boolean {
  return item !== undefined && item.lifecycleStatus !== "pending" && item.lifecycleStatus !== "running";
}

// FG-596 (fix 3): the DURABLE shape the recovery_needed paths in driveOneCampaignItem
// leave — the legacy fail-closed guard (awaiting_gate + campaign_system, an item that
// still carries an unadopted run). Everything else that parked the campaign is an
// operator-actionable pause. The no-progress backstop parks awaiting_gate with NO
// blockerKind, indistinguishable from a gate:human pause by item shape alone; it derives
// here as 'paused', which is SAFE — resume re-probes it via the FG-441 reattach liveness
// path, exactly the recoverable shape that backstop was built to hand off.
function isRecoveryShape(item: CampaignItem | undefined): boolean {
  return item !== undefined && item.lifecycleStatus === "awaiting_gate" && item.blockerKind === "campaign_system";
}

// FG-596 (fix 3): reconstruct the DriveOneItemResult PURELY from durable state after the
// drive-item child ends — the stdout marker is GONE; nothing anything in the child's
// combined output could forge is ever the source of truth. The launch DISPOSITION is
// consulted ONLY to learn how the drive PROCESS ended (clean exit / error exit / crash),
// never the item's shipped/parked/failed fate:
//   - the item OUTCOME comes from getCampaignItem (durable);
//   - the campaign HALT (paused/abandoned/continue) from getCampaign (durable);
//   - a drive-error re-raise is reconstructed from the durably-parked item's `reason` so
//     the CLI's renderDriveErrorAndExit still matches by reason (the FG-490 rendering).
// Returns a `driveError` for the boundary to re-raise (preserving the in-process throw),
// else a `stopReason` (absent = the item settled and the campaign continues).
export function deriveDriveItemResultFromDurableState(
  campaignId: string,
  itemId: string,
  disposition: LaunchStatus | undefined,
): { itemRecords: CampaignItemRecord[]; stopReason?: CampaignStopReason; driveError?: Error } {
  const durableItem = getCampaignItem(itemId);
  const record: CampaignItemRecord | undefined = durableItem
    ? {
        itemId: durableItem.id,
        ticketId: durableItem.ticketId,
        runId: durableItem.runId,
        lifecycleStatus: durableItem.lifecycleStatus,
        outcome: durableItem.outcome,
        blockerKind: durableItem.blockerKind,
        reason: durableItem.reason,
      }
    : undefined;
  const itemRecords = record ? [record] : [];
  const campaign = getCampaign(campaignId);

  // How did the drive PROCESS end? exited_ok → clean settle; exited_error → the child's
  // top-level catch ran process.exit(1) (a drive THROW); anything else terminal (signal
  // / owner_gone / unknown) → it died without a clean exit. `!cleanExit` covers both an
  // error exit and a hard crash for the unfinished-drive check below.
  const cleanExit = disposition?.state === "exited_ok";
  const errorExit = disposition?.state === "exited_error";

  // (1) DRIVE ERROR: the child exited non-zero after committing a durable park. Re-raise
  // from the durably-parked item's `reason` (NOT any marker) so renderDriveErrorAndExit
  // matches the parked item by reason. The park is already committed; the boundary just
  // re-surfaces the throw the in-process path would have propagated.
  if (errorExit && durableItem?.reason && isDriveErrorParkShape(durableItem)) {
    const original = durableItem.reason;
    const wrapped = new Error(
      `campaign ${campaignId} paused after a drive error on ${durableItem.ticketId}` +
        `${durableItem.runId ? ` (run ${durableItem.runId})` : ""} — resolve the issue, then ` +
        `\`forge campaign resume ${campaignId}\`: ${original}`,
      { cause: new Error(original) },
    );
    return { itemRecords, driveError: wrapped };
  }

  // (2) ABANDONED: durable campaign status is authoritative — checked before the crash
  // case so an abandon during a crashed drive still reads as abandoned.
  if (!campaign || campaign.status === "abandoned") {
    return { itemRecords, stopReason: "abandoned" };
  }

  // (3) The child ended withOUT a clean exit (a crash / error exit) AND left the item
  // mid-flight (still pending or running) → the drive did not finish. Leave it adoptable
  // (its dispatch_key is stamped) → recovery_needed. A CLEAN exit that left the item
  // pending is NOT this case: a readiness/dependency HELD item deliberately stays pending
  // and the child exits 0 — that is a legal deferral, handled by the controller's
  // after-drain held park, not a wedge.
  if (!cleanExit && !isItemSettledOrParked(durableItem)) {
    return { itemRecords, stopReason: "recovery_needed" };
  }

  // (4) The drive parked the campaign. Distinguish the recovery shape (fail-closed, an
  // item still carrying an unadopted run) from an operator-actionable pause.
  if (campaign.status !== "running") {
    return { itemRecords, stopReason: isRecoveryShape(durableItem) ? "recovery_needed" : "paused" };
  }

  // (5) Campaign still running and the child ended cleanly (or settled the item): the
  // item settled or was deliberately deferred (held) without halting the campaign — the
  // controller advances / applies its after-drain held-pause decision (no stopReason).
  return { itemRecords };
}

// FG-596 (A6): contain a PRODUCTION launch-boundary failure. startLaunch (tmux setup)
// and waitForLaunchTerminal (the wait harness) can THROW before the drive-item child
// ever commits a durable outcome — a missing/broken tmux makes startLaunch explicitly
// throw, and the wait harness can fail. By this point startCampaign has already CAS'd
// the campaign to `running`, so an UNCAUGHT throw wedges it there: `forge campaign
// start` refuses (no longer planned) and `forge campaign resume` refuses (not paused),
// leaving no non-manual recovery — the exact wedge A6 forbids. Contain it into a
// durable RECOVERABLE park instead:
//   1. Durable state is authoritative. If the child already settled or parked the item
//      before the boundary threw (e.g. a wait-harness cleanup throw after a committed
//      park), reconcile from durable state exactly as the clean path would — the throw
//      was incidental to an already-committed, already-recoverable outcome.
//   2. If the campaign is no longer running (abandoned, or a concurrent operator
//      `forge campaign pause` won the CAS), honor that durable state — never force a
//      park over it.
//   3. If startLaunch SUCCEEDED and the drive-item child already dispatched a run —
//      stamping the item to `running` with its adoptable dispatch_key — before the WAIT
//      harness threw, the child is live (removeLaunch above, no --force, refuses to kill
//      a running launch, so the drive keeps going). That item is the ADOPTABLE recovery
//      shape, NOT a no-run park: overwriting it as failed/retryable would tell the
//      operator to `retry` and mint a DUPLICATE run while the original drive is still
//      running. Reconcile from durable state (→ recovery_needed) exactly as a
//      crashed-child drive does, leaving the run adoptable for FG-564.
//   4. Otherwise the item is still `pending` (no run was ever dispatched — a startLaunch
//      throw) and the campaign is still running — the wedge shape. PARK the item at its
//      true terminal shape (failed/blocked/infrastructure, directly retryable — the same
//      shape parkCampaignOnStartRunThrow leaves for a setup failure that dispatched no
//      run) and CAS the campaign running→paused via parkCampaign, so `forge campaign
//      retry <cid> <ticket>` then `forge campaign resume` recover it with NO manual SQL.
//      Preserves the FG-425 invariants: never resets the item to pending, never mints a
//      replacement run, never overwrites an existing shared blocker (e.g. git_state).
async function containLaunchBoundaryFailure(
  campaignId: string,
  itemId: string,
  err: unknown,
): Promise<DriveOneItemResult> {
  const deriveDurable = (): DriveOneItemResult => {
    const d = deriveDriveItemResultFromDurableState(campaignId, itemId, undefined);
    return { itemRecords: d.itemRecords, ...(d.stopReason ? { stopReason: d.stopReason } : {}) };
  };

  const durableItem = getCampaignItem(itemId);
  if (isItemSettledOrParked(durableItem)) return deriveDurable();

  // A `running` item means the child dispatched a run (dispatch_key stamped) and is still
  // live — a wait-harness failure never makes that a no-run park. Reconcile from durable
  // state (→ recovery_needed, adoptable) instead of overwriting it as retryable, which
  // would allow a duplicate run alongside the original drive.
  if (durableItem?.lifecycleStatus === "running") return deriveDurable();

  const campaign = getCampaign(campaignId);
  if (!campaign || campaign.status !== "running") return deriveDurable();

  const message = err instanceof Error ? err.message : String(err);
  const ticketId = durableItem?.ticketId ?? itemId;
  // FG-425: preserve an existing SHARED blocker (git_state) rather than clearing it.
  // A launched item should not carry one (the controller skips failed items), but stay
  // defensive so the containment never masks a shared blocker.
  const existingShared =
    durableItem?.blockerKind && isSharedBlocker(durableItem.blockerKind) ? durableItem.blockerKind : undefined;
  const blockerKind: BlockerKind = existingShared ?? "infrastructure";
  try {
    // FG-596 (A6, by construction): park the item ONLY while it is still 'pending' — its
    // pre-drive state. The pending-gated CAS is the parent-side half of the claim/park
    // race: if the drive-item child already CLAIMED the item (pending→running via
    // claimCampaignItemForDrive) between this containment's durableItem read above and this
    // write, the park is a no-op and we must NOT clobber the live drive nor pause the
    // campaign behind it. In that case the item is a live/adoptable mid-flight drive —
    // reconcile from durable state (→ recovery_needed) exactly as the 'running' early
    // return above does. Only when the park actually lands (the item was genuinely still
    // pending — no child ever dispatched) do we CAS the campaign running→paused.
    const didPark = updateCampaignItemIfPending(itemId, campaignId, {
      lifecycleStatus: "failed",
      outcome: "blocked",
      blockerKind,
      reason: message,
      requestedHumanAction: `the per-item launch boundary failed before ${ticketId} could be driven (${message}) — no run was dispatched. Run \`forge campaign retry ${campaignId} ${ticketId}\`, then \`forge campaign resume ${campaignId}\`.`,
    });
    if (!didPark) return deriveDurable();
    logEvent("campaign_item.drive_error", {
      ...(durableItem?.runId ? { runId: durableItem.runId } : {}),
      payload: { campaignId, itemId, ticketId, error: message, boundary: "launch", decidedAt: nowIso() },
    });
    await parkCampaign(campaignId, itemId, "blocked", { exemption: "item-carries-context" }, { fallbackRunId: pickCampaignFallbackRunId(campaignId) });
  } catch {
    // park failed — the returned stopReason still halts the controller cooperatively
    // and the item transition above is best-effort; nothing here may re-throw.
  }
  const parked = getCampaignItem(itemId);
  const record: CampaignItemRecord = parked
    ? {
        itemId: parked.id,
        ticketId: parked.ticketId,
        runId: parked.runId,
        lifecycleStatus: parked.lifecycleStatus,
        outcome: parked.outcome,
        blockerKind: parked.blockerKind,
        reason: parked.reason,
      }
    : { itemId, ticketId, lifecycleStatus: "failed", outcome: "blocked", blockerKind, reason: message };
  return { itemRecords: [record], stopReason: "paused" };
}

// FG-596: the production launcher — start `forge campaign drive-item <cid> <itemId>`
// under a durable `forge launch` tmux owner, block until it reaches a terminal
// DRIVE-PROCESS disposition, then reconstruct the DriveOneItemResult ENTIRELY from
// DURABLE state (deriveDriveItemResultFromDurableState). The launch disposition is used
// ONLY to decide "did the child settle cleanly, error out, or crash" — NEVER to decide
// the item outcome, and NO stdout marker is read. A crash with the item still mid-flight
// leaves it ADOPTABLE (its dispatch_key is stamped) and surfaces recovery_needed WITHOUT
// auto-recovering (FG-564's job).
export function launchDriveItemUnderForge(
  forgeBin: string[],
  // FG-596: the tmux/subprocess boundary is the ONE seam a test may substitute — the
  // same shape as the docker-exec injection elsewhere. Default (production) wires the
  // real tmux and the real wait harness, so startLaunch/waitForLaunchTerminal, the argv,
  // and FORGE_HOME/cwd propagation are the production article; a test injects a fake
  // tmux that runs the drive in-process and records a genuine exit record, and a wait
  // harness with test timers, to prove the launch/wait path without spawning tmux.
  seams: { tmux?: TmuxRunner; makeWaitHarness?: (id: string) => WaitHarness } = {},
): DriveItemLaunchFn {
  return async (campaignId, itemId) => {
    // The launch runs under a tmux server whose environment can be STALE (a
    // long-lived server does not pick up the launcher's FORGE_HOME), so the child
    // could otherwise open a DIFFERENT store than the controller and never find the
    // campaign. Pin the RESOLVED FORGE_HOME *and* the RESOLVED DB_PATH through an
    // `env` prefix so the drive-item child provably shares the controller's durable
    // store, independent of tmux env inheritance. FORGE_HOME alone is not enough: a
    // campaign started with a FORGE_DB_PATH override resolves DB_PATH away from
    // FORGE_HOME/forge.db, and a stale tmux env would leave the child falling back to
    // the default store — splitting controller and child across stores. Pinning the
    // already-resolved DB_PATH forwards that override verbatim. (`env` is a recognized
    // launch exec-prefix — it applies the assignments and execs the real command;
    // provenance records it correctly.)
    const argv = ["env", `FORGE_HOME=${FORGE_HOME}`, `FORGE_DB_PATH=${DB_PATH}`, ...forgeBin, "campaign", "drive-item", campaignId, itemId];
    // Run the drive in the CAMPAIGN's project directory, not whatever cwd `forge
    // campaign start` happened to be invoked from — the item's git/worktree work
    // belongs there, and it keeps the drive from ever touching an unrelated checkout
    // the launcher was standing in.
    const cwd = getCampaign(campaignId)?.projectDir;

    // FG-596 (A6): the launch boundary is failure-contained. startLaunch throwing
    // (broken tmux) or waitForLaunchTerminal failing must NOT propagate uncaught to the
    // CLI — that would strand the already-running campaign in an unrecoverable wedge.
    // containLaunchBoundaryFailure turns any such throw into a durable recoverable park.
    let meta;
    let outcome;
    try {
      meta = startLaunch(argv, { name: `campaign-drive-${itemId}`, ...(cwd ? { cwd } : {}), ...(seams.tmux ? { tmux: seams.tmux } : {}) });
      const harness = seams.makeWaitHarness ? seams.makeWaitHarness(meta.id) : realWaitHarness(meta.id);
      outcome = await waitForLaunchTerminal(meta.id, harness);
    } catch (err) {
      // Best-effort cleanup of any launch record the setup left behind before parking.
      if (meta) { try { removeLaunch(meta.id, seams.tmux ? { tmux: seams.tmux } : {}); } catch { /* best-effort */ } }
      return containLaunchBoundaryFailure(campaignId, itemId, err);
    }

    // The disposition of the drive-item PROCESS (never the item outcome).
    const disposition: LaunchStatus | undefined =
      outcome.kind === "terminal" ? outcome.view.status : undefined;

    const derived = deriveDriveItemResultFromDurableState(campaignId, itemId, disposition);

    // A drive error re-raises the in-process throw so the CLI renders drive_error. The
    // park is already durable, so the launch record is disposable.
    if (derived.driveError) {
      try { removeLaunch(meta.id, seams.tmux ? { tmux: seams.tmux } : {}); } catch { /* best-effort cleanup */ }
      throw derived.driveError;
    }

    // recovery_needed leaves the launch record for inspection/adoption (FG-564); every
    // other settle is disposable (its durable effects are committed). Annotate the crash
    // record with the process disposition so the operator sees HOW the drive ended.
    if (derived.stopReason === "recovery_needed" && !isItemSettledOrParked(getCampaignItem(itemId))) {
      const dispositionNote = disposition ? statusLine(disposition) : `waiter: ${outcome.kind}`;
      const [rec] = derived.itemRecords;
      const annotated: CampaignItemRecord = rec
        ? { ...rec, reason: `drive-item process ended without settling the item (${dispositionNote}) — the item is adoptable by its dispatch key; inspect and resolve, then resume` }
        : { itemId, ticketId: itemId, lifecycleStatus: "running", reason: `drive-item process ended without settling the item (${dispositionNote})` };
      return { itemRecords: [annotated], stopReason: "recovery_needed" };
    }

    try { removeLaunch(meta.id, seams.tmux ? { tmux: seams.tmux } : {}); } catch { /* best-effort cleanup */ }
    return { itemRecords: derived.itemRecords, ...(derived.stopReason ? { stopReason: derived.stopReason } : {}) };
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
    launchDriveItem?: DriveItemLaunchFn;
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
    launchDriveItem: opts.launchDriveItem,
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
    launchDriveItem?: DriveItemLaunchFn;
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

  if (!resumeCampaignToRunning(id)) {
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
    launchDriveItem: opts.launchDriveItem,
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

  // RED-WIDE fix: ticketId must name a real campaign item that is actually
  // blocked on lane_escalation — otherwise an operator could escalate an
  // unrelated (or nonexistent) ticket, mint a fresh plan_hash, and let
  // `campaign approve` pass while the REAL escalated item stays unresolved.
  const items = listCampaignItems(campaignId);
  const targetItem = items.find((i) => i.ticketId === ticketId);
  if (!targetItem) {
    return { ok: false, reason: `ticket ${ticketId} is not a campaign item in campaign ${campaignId}` };
  }
  if (!(targetItem.lifecycleStatus === "failed" && targetItem.outcome === "blocked" && targetItem.blockerKind === "lane_escalation")) {
    return {
      ok: false,
      reason: `ticket ${ticketId} is not currently blocked on lane_escalation (lifecycleStatus: ${targetItem.lifecycleStatus}, blockerKind: ${targetItem.blockerKind ?? "none"})`,
    };
  }

  // A genuine escalation must change what actually dispatches — a rationale-only
  // tweak that keeps the SAME lane must not be allowed to mint a "fresh" plan_hash
  // and satisfy the re-approval gate without any real change (RED-WIDE LOW finding).
  const currentLane = getItemPlanEntry(campaign.metadata?.["planContent"], ticketId).lane;
  if (currentLane === opts.newLane) {
    return { ok: false, reason: `newLane '${opts.newLane}' is the same as the item's current lane — escalation requires an actual lane change` };
  }

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

  updateCampaignItemIfCampaignPaused(targetItem.id, campaignId, {
    lifecycleStatus: "pending",
    outcome: undefined,
    blockerKind: undefined,
    continuePolicy: undefined,
    reason: undefined,
    requestedHumanAction: undefined,
    // FG-596: an escalation dispatches the item FRESH in its new lane — it is a
    // genuinely new attempt. Clear the stale run linkage from the outgrown-lane
    // attempt (the next dispatch would replace it anyway) and bump the generation, so
    // the re-dispatch is a clean new attempt with a DISTINCT dispatch key rather than
    // tripping the drive-item fail-closed guard (a pending item that still carries a
    // run is refused, never replaced). Mirrors retryCampaignItem's reset.
    runId: undefined,
    branch: undefined,
    worktreePath: undefined,
    prUrl: undefined,
    attemptGeneration: (targetItem.attemptGeneration ?? 0) + 1,
  });

  return { ok: true, planHash };
}

export type RetryItemResult = { ok: true } | { ok: false; reason: string };

// FG-489: the ONLY supported way to return a transiently-failed item to
// 'pending' — replaces the "hand-edit the DB" workaround the FG-489 review
// (F6) flagged as the one path operators had for the most common overnight
// interruptions (expired auth, container/infra crash, idle timeout). Reuses
// classifyFailureKind's SHARED categories: auth and infrastructure (which
// already folds in idle_timeout/container_crash/orphaned) reflect host/
// environment trouble, not the item's own work, so they retry directly. A
// scope/verdict failure (or any other blockerKind, including lane_escalation
// which has its own escalate-lane recovery path) is refused — silently
// retrying a red/verdict failure would re-burn the item with no operator
// signal that anything about the failure actually changed. Auto-reset on
// resume is deliberately NOT implemented here (scope decision at filing):
// that would re-burn an item against a still-broken transient blocker with
// no operator signal.
const RETRYABLE_BLOCKER_KINDS = new Set<BlockerKind>(["auth", "infrastructure"]);

// FG-511: one classified failed primary task of the item's run. Recorded on the
// campaign_item.campaign_system_retried audit event so a later done-audit (or an
// operator) can see exactly which durable evidence licensed the retry.
export type CampaignSystemRetryEvidence = { taskId: string; failureKind: string; classified: BlockerKind };

// FG-511 (round 2): the ONE shared "was this ticket actually delivered" test for a
// campaign_system item — reconcile.ts's own composition (composeOutOfBandEligibility
// over the same two collectors), minus reconcile's host-verification capture, which
// is a write neither a retry nor a read-only preview may perform. Delivered work is
// reconciled, never re-dispatched, so the retry verb AND show/report's retry hint
// both gate on this single function: the surface cannot promise a retry the verb
// would refuse, and the verb cannot reset an item the surface calls shipped.
export function evaluateCampaignSystemShipEligibility(
  projectDir: string,
  item: CampaignItem,
): { eligible: boolean; missing: string[] } {
  const authoritative = authoritativeOutcomeContribution(item.runId ? collectReconcileEvidence(projectDir, item) : null);
  const outOfBand = evaluateOutOfBandEvidence(collectOutOfBandEvidence(projectDir, item));
  const { eligible, missing } = composeOutOfBandEligibility({ outOfBand, authoritative, hasRunId: !!item.runId });
  return { eligible, missing };
}

// FG-511: reconcileTerminalOutcome lands ANY non-complete run on campaign_system,
// so an overnight transient blip (idle timeout, container crash, killed driver)
// that abandoned a run is indistinguishable — at the ITEM level — from a genuine
// campaign-system fault. The item's blockerKind is therefore not a classification
// here (unlike auth/infrastructure, which already ARE one); it is a placeholder.
// Probe the underlying run/task evidence instead, and accept only when every
// failed primary task provably classifies transient. Fail-closed in every branch:
// missing run, complete run, no failed primary, or ANY non-transient/mixed
// classification refuses and names what was missing or non-transient.
//
// Exported (read-only — it never writes) so report.ts's show/report preview can
// gate its `forge campaign retry` guidance on the SAME evidence the write path
// judges from, instead of mirroring the probe and drifting from it.
export function probeCampaignSystemRetryEvidence(
  campaign: Campaign,
  item: CampaignItem,
): { ok: true; evidence: CampaignSystemRetryEvidence[] } | { ok: false; reason: string } {
  const campaignId = campaign.id;
  const ticketId = item.ticketId;
  const runId = item.runId;
  const refuse = (reason: string) => ({ ok: false as const, reason: `ticket ${ticketId} failed with blockerKind 'campaign_system' — ${reason}` });

  // FG-511 (round 2): ship evidence outranks transient evidence, and is checked
  // FIRST. A campaign_system item can carry both — an abandoned run whose primary
  // idled out, and a ticket that was nonetheless delivered out-of-band. Accepting
  // the retry there would CAS-reset the item and re-dispatch work already on the
  // base branch. Fail-closed: when the delivery cannot be re-derived at all (no
  // stored projectDir), refuse rather than guess.
  if (!campaign.projectDir) {
    return refuse(
      `its campaign has no stored project directory, so whether the ticket was already delivered cannot be re-derived from durable evidence; inspect the item, then re-plan or abandon`,
    );
  }
  if (evaluateCampaignSystemShipEligibility(campaign.projectDir, item).eligible) {
    return refuse(
      `its ticket is provably delivered (closed, its closing commit reachable on the base branch, lane evidence satisfied) — delivered work is reconciled, never re-dispatched; run \`forge campaign reconcile ${campaignId}\` to complete it from that evidence`,
    );
  }

  if (!runId) {
    return refuse("no linked run, so there is no durable evidence the failure was transient; inspect the item, then re-plan or abandon");
  }
  const run = getRun(runId);
  if (!run) {
    return refuse(`its linked run ${runId} is not in the store, so there is no durable evidence the failure was transient; inspect the item, then re-plan or abandon`);
  }
  // A run that reached 'complete' and STILL landed campaign_system is a
  // done-audit/verdict gap, not a transient dispatch failure — re-driving it
  // would re-burn the item against evidence that is already on record.
  if (run.status === "complete") {
    return refuse(
      `its run ${runId} completed — that is a done-audit/verdict gap, not a transient dispatch failure; run \`forge campaign reconcile ${campaignId}\` to re-derive the outcome from durable evidence`,
    );
  }

  const failedPrimaries = tasksForRun(runId).filter((t) => t.parentId === undefined && t.status === "failed");
  if (failedPrimaries.length === 0) {
    return refuse(
      `its run ${runId} (status ${run.status}) recorded no failed primary task, so the failure kind cannot be classified — the driver may have died before any task failure landed; inspect it (\`forge show ${runId}\`), then re-plan or abandon`,
    );
  }

  const evidence: CampaignSystemRetryEvidence[] = failedPrimaries.map((t) => {
    const failureKind = failureKindForTask(t.id);
    return { taskId: t.id, failureKind: failureKind ?? "unknown", classified: classifyFailureKind(failureKind) };
  });
  const nonTransient = evidence.find((e) => !RETRYABLE_BLOCKER_KINDS.has(e.classified));
  if (nonTransient) {
    return refuse(
      `task ${nonTransient.taskId} of run ${runId} failed with kind '${nonTransient.failureKind}', which classifies as '${nonTransient.classified}' — not a transient host/environment failure; inspect it (\`forge show ${runId}\`), then re-plan or abandon`,
    );
  }
  return { ok: true, evidence };
}

export function retryCampaignItem(campaignId: string, ticketId: string): RetryItemResult {
  const campaign = getCampaign(campaignId);
  if (!campaign) return { ok: false, reason: `campaign ${campaignId} not found` };
  if (campaign.status !== "paused") {
    return { ok: false, reason: `campaign must be paused to retry an item (status: ${campaign.status})` };
  }

  const items = listCampaignItems(campaignId);
  const targetItem = items.find((i) => i.ticketId === ticketId);
  if (!targetItem) {
    return { ok: false, reason: `ticket ${ticketId} is not a campaign item in campaign ${campaignId}` };
  }
  if (!(targetItem.lifecycleStatus === "failed" && targetItem.outcome === "blocked")) {
    return {
      ok: false,
      reason: `ticket ${ticketId} is not currently failed (lifecycleStatus: ${targetItem.lifecycleStatus}, outcome: ${targetItem.outcome ?? "none"})`,
    };
  }
  const blockerKind = targetItem.blockerKind;
  const isCampaignSystem = blockerKind === "campaign_system";
  if (!blockerKind || !(RETRYABLE_BLOCKER_KINDS.has(blockerKind) || isCampaignSystem)) {
    const kind = blockerKind ?? "none";
    const hint =
      blockerKind === "lane_escalation"
        ? `run forge campaign escalate-lane ${campaignId} ${ticketId} --new-lane <lane> --rationale <text> instead`
        : `it is not a transient host/environment failure — inspect the item (blockerKind: ${kind}), then re-plan or abandon`;
    return {
      ok: false,
      reason: `ticket ${ticketId} failed with blockerKind '${kind}', which is not retryable — ${hint}`,
    };
  }

  // FG-511: auth/infrastructure need no probe — their blockerKind already IS the
  // classification. campaign_system is a placeholder, so it must earn the retry
  // from the underlying run's durable task evidence.
  const retainedRunId = targetItem.runId;
  let evidence: CampaignSystemRetryEvidence[] | undefined;
  if (isCampaignSystem) {
    const probe = probeCampaignSystemRetryEvidence(campaign, targetItem);
    if (!probe.ok) return probe;
    evidence = probe.evidence;
  }

  // Clear per-attempt state (run/branch/worktree/PR from the failed attempt)
  // so the next dispatch starts clean — mirrors escalateCampaignItemLane's
  // reset above, plus the run-linkage fields that a lane escalation leaves
  // untouched but a retry of the SAME lane must not carry forward.
  //
  // FG-511: the reset and the campaign_system audit event land in ONE
  // transaction, mirroring reconcile.ts's campaign_item.campaign_system_reconciled
  // precedent — updateCampaignItemIfCampaignPaused reads campaigns.status inside
  // its own UPDATE, so a concurrent unpause makes the write a no-op and no audit
  // event is logged for a reset that never happened.
  const applied = writeTransaction(() => {
    const wrote = updateCampaignItemIfCampaignPaused(targetItem.id, campaignId, {
      lifecycleStatus: "pending",
      outcome: undefined,
      blockerKind: undefined,
      continuePolicy: undefined,
      reason: undefined,
      requestedHumanAction: undefined,
      runId: undefined,
      branch: undefined,
      worktreePath: undefined,
      prUrl: undefined,
      // FG-596: a retry is a genuinely NEW attempt — allocate a fresh generation rather
      // than clearing runId without one, so the next dispatch derives a DISTINCT
      // dispatch key (a delayed completion from the prior attempt cannot be mistaken for
      // this one, and the next drive REUSES this bumped generation rather than
      // re-allocating). Bumped in-line here (one CAS with the reset) instead of via
      // allocateItemGeneration so it shares this paused-guarded transaction.
      attemptGeneration: (targetItem.attemptGeneration ?? 0) + 1,
    });
    if (!wrote) return false;
    if (evidence) {
      logEvent("campaign_item.campaign_system_retried", {
        runId: retainedRunId,
        payload: { campaignId, itemId: targetItem.id, ticketId, runId: retainedRunId, evidence, decidedAt: nowIso() },
      });
    }
    return true;
  });
  if (!applied) return { ok: false, reason: "campaign is no longer paused (concurrent state change)" };

  return { ok: true };
}
