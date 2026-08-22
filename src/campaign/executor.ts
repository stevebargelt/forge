import { existsSync } from "node:fs";
import { join } from "node:path";
import { recordLaunchStart } from "../store/launch-observations.js";
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
  reserveCampaignDriveDispatch,
  updateCampaignPlanForReapproval,
  tryTransitionCampaignToRunning,
  isCampaignOperatorPaused,
  clearOperatorPauseMarker,
  type CampaignDriveReservation,
} from "../store/campaigns.js";
import { getDb, writeTransaction } from "../store/db.js";
import {
  recordItemLaunch,
  refreshItemLaunchBornUnder,
  updateItemLaunch,
  getItemLaunch,
  getCampaignLease,
  campaignLeaseHeldBy,
  acquireCampaignLease,
  renewCampaignLease,
  releaseCampaignLease,
} from "../store/campaign-controller.js";
import { recordContinuation, getContinuation } from "../store/continuations.js";
import {
  campaignContinuationId,
  campaignItemPhase,
  driveCampaignItemAction,
  finalizeCampaignAction,
} from "./continuation-adapter.js";
import { logEvent } from "../store/events.js";
import { tasksForRun } from "../store/tasks.js";
import type { Campaign, CampaignItem, CampaignItemLifecycleStatus, CampaignItemOutcome, BlockerKind, Run, Task } from "../types/index.js";
import { resolvePlan, sourceInputToPlannerInput, getItemPlanEntry } from "./planner.js";
import type { PlannerInput, PlanMode, ExecutionLane, ItemModeOverride } from "./planner.js";
import { listTickets } from "../backlog/structured.js";
import { projectHasBacklog } from "../backlog/storage-mode.js";
import type { StructuredTicket } from "../backlog/structured.js";
import { getRun, insertRun, resolveRunProjectIdentity, updateRunStatus } from "../store/runs.js";
import { computeReadyQueue, classifyRunTerminalState } from "../v2/ready-queue.js";
import { isPhasePrimaryRow, isAdHocInvokeRow } from "../v2/lifecycle-evaluator.js";
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
import { resolveSeedGeneration } from "../v2/seed-generation.js";
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
  // FG-750: present with stopReason "paused" when THIS drive committed an ITEM-SCOPED
  // operator park (one item waiting on a human decision) — as opposed to a
  // campaign-scoped stop (a shared blocker, a lane escalation, or an operator pause
  // that won the running→paused race). The controller retains the parked item and
  // continues with the next independent eligible item only when the scope is "item".
  // Set from parkCampaign's own commit boolean on the in-process path (precise: an
  // operator pause that pre-empted the park leaves it unset); reconstructed from the
  // durable park shape on the cross-process launch path.
  stopScope?: "item" | "campaign";
};

// FG-596: how the launch-per-item controller drives item N. The DEFAULT (production)
// launches `forge campaign drive-item` under `forge launch`, waits in-process via
// `forge launch wait`, and reconstructs the DriveOneItemResult from DURABLE state
// after the wake — never from the launch disposition. A test may inject an in-process
// launcher (the same drive, no subprocess) to exercise the controller deterministically.
export type DriveItemLaunchFn = (campaignId: string, itemId: string) => Promise<DriveOneItemResult>;

// FG-607: "has a backlog" is a question about the AUTHORITATIVE store, not about
// the filesystem. A db-mode project legitimately has no backlog/ directory and
// must not be rejected as invalid_project_dir while its CLI CRUD works fine.
function hasBacklog(dir: string): boolean {
  return projectHasBacklog(dir);
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
    // FG-608: two DIFFERENT questions, both required. existsSync is host-path
    // LIVENESS on the recorded projectDir (a campaign whose directory was
    // deleted); hasBacklog is the store question. In db mode the store answers
    // `true` for a directory that is gone, so collapsing these would run a
    // campaign against a vanished checkout. Locked by
    // fg608-dir-guard-regression.integration.test.ts.
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
    // FG-608: see the start site above — liveness AND store, never one or the other.
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
  // FG-750: how this item became a blocker. A "park" blocker (an item parked
  // awaiting an operator decision, or a later item transitively held on such a
  // park) blocks ONLY its explicit direct dependents — never an item that is merely
  // later in approved order or that carries no dependency metadata. A "failure"
  // blocker keeps the FG-393 continue-policy (unknown relation holds in sequential
  // mode). Sequential order is never, on its own, a dependency edge.
  source: "failure" | "park";
};

// FG-750: an ITEM-SCOPED park is an operator decision about ONE item — a human
// gate, a review-disposition withhold, or a blocking reviewer verdict. Its
// blockerKind is item-local (or absent, for a pure human gate). A shared blocker, a
// recovery wedge (awaiting_gate + campaign_system), or a lane escalation is
// campaign-scoped and halts the whole campaign. This is a pure function of durable
// state so the controller's continue/halt decision, the after-drain park, and the
// report surfaces all classify a park identically.
export function isItemScopedPark(item: CampaignItem | undefined): boolean {
  if (!item) return false;
  if (item.lifecycleStatus !== "awaiting_gate" && item.lifecycleStatus !== "blocked_by_red") return false;
  if (isRecoveryShape(item)) return false;
  if (item.blockerKind && isSharedBlocker(item.blockerKind)) return false;
  return true;
}

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
    // FG-750: a parked item (and anything transitively held on it) blocks ONLY its
    // explicit direct dependents — never an item that is merely later in order or has
    // no dependency metadata. A failure blocker keeps the FG-393 policy.
    const policy =
      blocker.source === "park"
        ? rel === "dependent"
          ? "hold_dependents"
          : "continue_allowed"
        : evaluateContinuePolicy(blocker.blockerKind, rel, mode);

    if (policy === "hold_dependents" || policy === "hold_campaign") {
      const reason =
        blocker.source === "park"
          ? `held because it depends on parked item ${blocker.id}`
          : rel === "dependent"
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
    blockedItems.push({ id: item.ticketId, ticket: laterTicket, blockerKind, source: "failure" });
  } else {
    // Ticket not in ticketMap (deleted?). Use a synthetic entry with no related field
    // so downstream items get "unknown" relation and are conservatively held.
    blockedItems.push({
      id: item.ticketId,
      ticket: { id: item.ticketId, type: "story", status: "active", title: item.ticketId, body: "" } as StructuredTicket,
      blockerKind,
      source: "failure",
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
function reconcileTerminalOutcome(run: Run, itemId: string, workflow: Workflow, projectDir?: string): void {
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
    // FG-721 (FG-477 D2): the failed-primary SELECTION is the evaluator's terminal
    // classification (classifyRunTerminalState -> failedPhases, the FG-718 projection
    // over evaluateLifecycle().terminal), not an ad-hoc `parentId === undefined &&
    // status === 'failed'` row scan. failedPhases is the set of workflow steps whose
    // OWN primaries terminally failed with no complete replacement — so it excludes
    // two shapes the old scan wrongly counted: a SUPERSEDED failed primary (a
    // request-changes replacement completed the same phase; hasCompletePrimary drops
    // it) and a failed AD-HOC invoke row (never a workflow phase). The BlockerKind
    // thus reflects only genuine unsuperseded workflow-phase failures.
    //
    // Within each failed phase, EVERY terminally-failed primary attempt is
    // classified (not just the latest) through the exact failureKindForTask ->
    // classifyFailureKind sequence finalizeInvokeDispatch uses above, resolved via
    // the evaluator's own phase-primary predicate (isPhasePrimaryRow) — not a
    // re-derived parentId scan. Classifying every attempt preserves the SHARED-WINS
    // guarantee within a phase: a phase whose earlier attempt container_crashed
    // (SHARED) and whose retry then gate_rejected (LOCAL) must stay campaign_system,
    // never downgrade to scope on the later attempt. The FailureKind -> BlockerKind
    // translation stays HERE in src/campaign: the evaluator returns campaign-neutral
    // step ids only, never a BlockerKind. SHARED-WINS precedence across phases: if any
    // failed attempt classifies to a SHARED blockerKind (isSharedBlocker), the whole
    // run stays campaign_system — a single shared infra/auth failure must never be
    // masked by a later local gate_rejected on the same run. Only when every failed
    // attempt classifies LOCAL do we use that local kind (e.g. 'scope' for
    // gate_rejected). A run with no genuine failed phase still lands on
    // campaign_system, preserving today's behavior for that case.
    const runTasks = tasksForRun(run.id);
    const failedPhases = classifyRunTerminalState(workflow, runTasks)?.failedPhases ?? [];
    const failedBlockerKinds = failedPhases.flatMap((phase) =>
      runTasks
        .filter((t) => t.phase === phase && isPhasePrimaryRow(t) && t.status === "failed")
        .map((t) => classifyFailureKind(failureKindForTask(t.id))),
    );
    const anySharedFailure = failedBlockerKinds.some((k) => isSharedBlocker(k));
    const unresolvedBlockerKind: BlockerKind =
      failedPhases.length === 0 || anySharedFailure ? "campaign_system" : failedBlockerKinds[failedBlockerKinds.length - 1]!;
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
    // committed the pause, and is awaited before the rethrow below. The caller
    // reserves a keyed synthetic abandoned run and passes its id here (see the
    // startRun-throw catch), so the item normally has a run of its OWN; the
    // campaign fallback keeps notifyCampaignPause emitting (scoped to another
    // item's run) rather than going silent in the other no-own-run parks.
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
// FG-564 (AC9 capstone): exported so a worktree-tier test can drive a run the campaign adapter
// already reserved (`created`) through the REAL runNext + real publisher — the drive seam a
// continuation advance injects. Not part of the normal control surface; the executor's own lanes
// call it internally.
export async function driveWorkflowItem(
  campaignId: string,
  item: CampaignItem,
  runId: string,
  workflow: Workflow,
  fns: {
    runNextFn: RunNextFn;
    gateFn?: typeof gate;
    projectDir?: string;
    // FG-564 (item 3, AC-ADOPT-DRIVE "stays fenced for the whole drive"): the born-under fence,
    // re-verified against the LIVE campaign-controller lease at the top of every wave. Supplied by
    // a launched drive-item child (enforceFence); absent for the in-process/programmatic drive.
    fenceAuthorizes?: () => boolean;
  } = { runNextFn: runNext },
): Promise<{ outcome: "continue" | "paused" | "recovery_needed"; itemRecord: CampaignItemRecord; stopScope?: "item" | "campaign" }> {
  const itemId = item.id;
  const ticketId = item.ticketId;
  const doGate = fns.gateFn ?? gate;
  const NO_PROGRESS_LIMIT = 2;
  const CONVERGE_LIMIT = 2;
  let noProgressStreak = 0;
  let convergeAttempts = 0;
  let lastSnapshot: string | null = null;

  while (true) {
    // FG-564 (item 3): re-assert the born-under fence at the START of every wave — BEFORE any
    // durable publish-commit / runNext / gate. A child orphaned by an owner that died mid-drive
    // (a takeover bumped the generation, or the lease lapsed) STOPS here with NO further durable
    // write, rather than continuing to commit across subsequent waves under a dead/superseded
    // lease. The lane-entry fence checks only cover ENTRY; this closes the multi-wave gap so the
    // fence holds across the WHOLE drive.
    if (fns.fenceAuthorizes && !fns.fenceAuthorizes()) {
      const cur = getCampaignItem(itemId);
      return {
        outcome: "recovery_needed",
        itemRecord: {
          itemId,
          ticketId,
          runId,
          lifecycleStatus: cur?.lifecycleStatus ?? "running",
          outcome: cur?.outcome,
          blockerKind: cur?.blockerKind,
        },
      };
    }
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
        reconcileTerminalOutcome(termRun, itemId, workflow, fns.projectDir);
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
      // FG-750: a blocking reviewer verdict is an item-local (scope) block — item-scoped.
      const redCommitted = await parkCampaign(campaignId, itemId, "blocked", { exemption: "item-carries-context" });
      return {
        outcome: "paused",
        ...(redCommitted ? { stopScope: "item" as const } : {}),
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
    // FG-750: true when the park that set `parked` was an ITEM-SCOPED operator decision
    // (review disposition / failing verdict / human gate) AND this drive committed the
    // pause. An inconclusive verdict (campaign_system) is campaign-scoped and leaves it
    // false, as does a pause an operator won first.
    let parkedItemScope = false;

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
      } else if (gateType === "verdict" && workflow.review_mode === "evidence_led") {
        // FG-640: on an evidence-led run this step is settled by the review LEDGER, not by
        // verdict aggregation — the reds here are advisory, so aggregating them would park the
        // campaign on an advisory `fail` the gate explicitly does not block on, and would do it
        // without ever reading the ledger. Two authority models in one run is exactly what the
        // cutover forbids, so the campaign asks the one gate that owns this step and lets its
        // named refusal be the park reason.
        try {
          await doGate(awaitingTask.id, "advance", "campaign: auto-advance (gate:verdict, evidence_led ledger settled)", {});
        } catch (err) {
          updateCampaignItem(itemId, {
            lifecycleStatus: "awaiting_gate",
            requestedHumanAction:
              `review_disposition gate withholds at step ${step?.id ?? awaitingTask.phase}: ` +
              `${err instanceof Error ? err.message : String(err)}`,
          });
          parkedItemScope = await parkCampaign(campaignId, itemId, "decision_needed", { exemption: "item-carries-context" }, { bodyBlockerKind: "review_disposition" });
          parked = true;
          break;
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
          parkedItemScope = await parkCampaign(campaignId, itemId, "blocked", { exemption: "item-carries-context" });
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
        parkedItemScope = await parkCampaign(campaignId, itemId, "decision_needed", { exemption: "item-carries-context" }, { bodyBlockerKind: "human_gate" });
        parked = true;
        break;
      }
    }

    if (parked) {
      const updatedItem = getCampaignItem(itemId);
      return {
        outcome: "paused",
        ...(parkedItemScope ? { stopScope: "item" as const } : {}),
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
// FG-564 (FIX round 5): the ONE lane-aware dispatch-preparation/materialization AUTHORITY.
// BOTH the normal drive (driveOneCampaignItem's lane switch) AND continuation recovery (the
// continuation-adapter, wired in runCampaignRecovery) converge on this — there is no second
// lane switch and no recovery-only materialization. It:
//   1. resolves the item's LANE + the required FILESYSTEM inputs (the workflow YAML via
//      loadWorkflow, the ticket via listTickets) OUTSIDE the reservation write transaction —
//      the returned createRun captures them and does NO filesystem read, so both callers'
//      reservations run tx-clean;
//   2. keyed by lane, returns a createRun that mints the CORRECT run shape INSIDE the caller's
//      reservation tx (full_feature -> real startRun pipeline; quick_implementation ->
//      invoke_chain; docs_only/test_only/review_only/research_only -> invoke) — byte-identical
//      to what the normal drive produced inline before this unify;
//   3. FAILS CLOSED (throws BEFORE the caller reserves, so the item stays pending, no run is
//      minted, and a recover advance is left recoverable) on: a missing ticket, a missing
//      projectDir, an unresolved workflow, or a non-dispatching / unknown lane
//      (ticketing_only / manual never mint a run).
// The `driver` in the result is the LANE IDENTITY both callers use to select the SAME physical
// driver off this result — runNext for pipeline, the real invoke path for invoke/invoke_chain —
// rather than re-deriving it. A launched drive-item child re-reads the same identity off the
// created run's durable `workflow`/metadata, so the adopt path stays lane-correct too.
export type CampaignItemDriver = "pipeline" | "invoke" | "invoke_chain";

export type CampaignItemDispatchPlan = {
  lane: ExecutionLane;
  driver: CampaignItemDriver;
  /** present iff driver === "pipeline" — the resolved workflow the drive runs via runNext. */
  workflow?: Workflow;
  /** present iff driver === "invoke" — the single agent role. */
  agentRole?: string;
  /** present iff driver === "invoke_chain" — the ordered chain. */
  invokeChain?: string[];
  /** Mints the correct run shape INSIDE the reservation tx (no filesystem read). */
  createRun: (ctx: { dispatchKey: string; attemptGeneration: number }) => string;
};

export function prepareCampaignItemDispatch(
  ctx: { campaignId: string; itemId: string },
  deps: {
    projectDir: string;
    planContent?: unknown;
    workflow?: Workflow;
    ticket?: StructuredTicket;
    loadWorkflowFn?: LoadWorkflowFn;
    startRunFn?: StartRunFn;
  },
): CampaignItemDispatchPlan {
  const item = getCampaignItem(ctx.itemId);
  if (!item || item.campaignId !== ctx.campaignId) {
    throw new Error(
      `prepareCampaignItemDispatch: item ${ctx.itemId} is not an item of campaign ${ctx.campaignId}`,
    );
  }
  if (!deps.projectDir) {
    throw new Error(
      `prepareCampaignItemDispatch: campaign ${ctx.campaignId} has no project directory — ` +
        `cannot materialize a drivable run for ${ctx.itemId} (fail closed)`,
    );
  }
  const planContent = deps.planContent ?? getCampaign(ctx.campaignId)?.metadata?.["planContent"];
  const entry = getItemPlanEntry(planContent, item.ticketId);
  const lane = entry.lane;
  const campaignId = ctx.campaignId;
  const itemId = item.id;
  const ticketId = item.ticketId;

  // FAIL CLOSED: the ticket is the item's brief/task source. A missing ticket is refused
  // BEFORE the reservation — the item stays pending, no run minted, a recover advance stays
  // recoverable rather than falsely advanced.
  const ticket = deps.ticket ?? listTickets(deps.projectDir).find((t) => t.id === ticketId);
  if (!ticket) {
    throw new Error(
      `prepareCampaignItemDispatch: ticket ${ticketId} not found for campaign ${campaignId} — ` +
        `refusing to materialize a run (fail closed)`,
    );
  }
  const ticketText = `${ticket.title}\n\n${ticket.body}`;
  const projectDir = deps.projectDir;
  // FG-663 (RF-3): resolve the run's project identity HERE — outside the
  // reservation write transaction, alongside the other filesystem inputs — and
  // capture it in the createRun closure below. The closures run INSIDE
  // reserveCampaignDriveDispatch's write lock, where a git subprocess must never
  // be held (FG-693 write-lock invariant; the createRun-does-no-fs-read contract).
  const projectIdentity = resolveRunProjectIdentity(projectDir);

  if (lane === "full_feature") {
    // Resolve the workflow YAML OUTSIDE the tx (fail closed if it cannot be resolved).
    const workflow = deps.workflow ?? (deps.loadWorkflowFn ?? loadWorkflow)(entry.workflowName ?? "feature", { projectDir });
    const inputs: Record<string, unknown> = {
      ticketId,
      campaignId,
      itemId,
      brief: ticketText,
      projectContext: `${ticketId}: ${ticketText}`,
    };
    for (const key of CONTROL_PLANE_METADATA_KEYS) delete inputs[key];
    return {
      lane,
      driver: "pipeline",
      workflow,
      createRun: ({ dispatchKey, attemptGeneration }) =>
        (deps.startRunFn ?? startRun)({
          workflow,
          title: ticketId,
          inputs,
          projectDir,
          dispatchKey,
          attemptGeneration,
          projectIdentity,
        }).runId,
    };
  }

  if (lane === "quick_implementation") {
    const invokeChain = ["engineer", "test-engineer"];
    return {
      lane,
      driver: "invoke_chain",
      invokeChain,
      createRun: ({ dispatchKey, attemptGeneration }) => {
        const newId = newRunId(ticketId);
        insertRun(
          {
            id: newId,
            workflow: "invoke_chain",
            title: ticketId,
            status: "active",
            createdAt: nowIso(),
            metadata: { invokeChain, campaignId, ticketId, itemId, dispatchKey, attemptGeneration },
            projectDir,
          },
          projectIdentity,
        );
        return newId;
      },
    };
  }

  if (lane === "docs_only" || lane === "test_only" || lane === "review_only" || lane === "research_only") {
    const agentRole = entry.agentRole;
    if (!agentRole) {
      throw new Error(
        `prepareCampaignItemDispatch: lane '${lane}' requires an agentRole for ${ticketId} (fail closed)`,
      );
    }
    return {
      lane,
      driver: "invoke",
      agentRole,
      createRun: ({ dispatchKey, attemptGeneration }) => {
        const newId = newRunId(ticketId);
        insertRun(
          {
            id: newId,
            workflow: "invoke",
            title: ticketId,
            status: "active",
            createdAt: nowIso(),
            metadata: { invokeAgent: agentRole, campaignId, ticketId, itemId, dispatchKey, attemptGeneration },
            projectDir,
          },
          projectIdentity,
        );
        return newId;
      },
    };
  }

  // ticketing_only / manual (no-dispatch lanes) and any unrecognized lane never mint an
  // item-run — FAIL CLOSED so a recover advance can never falsely materialize one.
  throw new Error(
    `prepareCampaignItemDispatch: lane '${lane}' for ${ticketId} does not materialize an item-run (fail closed)`,
  );
}

// FG-564 (FIX round 5): the ONE real invoke-lane drive, shared by the normal-drive lane
// switch (a freshly `created` reservation) AND the launched drive-item child's adopt/reattach
// path (an `adopted` invoke run the recover advance's reservation minted). Both callers reserve
// the run through prepareCampaignItemDispatch (the sole run shape authority), then drive it HERE
// — so a recover-driven invoke-lane item runs the SAME real invoke/invoke-chain as the normal
// drive, never a pipeline mis-materialization and never an approximation. Returns a
// DriveOneItemResult when the caller must STOP-and-return (shared blocker / escalation / park /
// cooperative pause), or null when the item settled without halting and the caller may advance
// to the next item (the outer loop's `continue`). Mirrors the former inline lane bodies exactly.
async function driveInvokeLaneItem(
  campaignId: string,
  item: CampaignItem,
  runId: string,
  spec: { driver: "invoke" | "invoke_chain"; agentRole?: string; invokeChain?: string[] },
  ctx: {
    dispatch: (args: InvokeArgs) => Promise<InvokeResult>;
    projectDir: string;
    taskText: string;
    laterTicket: StructuredTicket | undefined;
    itemRecords: CampaignItemRecord[];
    blockedItems: BlockedItemEntry[];
  },
): Promise<DriveOneItemResult | null> {
  const { dispatch, projectDir, taskText, laterTicket, itemRecords, blockedItems } = ctx;
  const lane: ExecutionLane = spec.driver === "invoke_chain" ? "quick_implementation" : (getItemPlanEntry(getCampaign(campaignId)?.metadata?.["planContent"], item.ticketId).lane);
  const finalizeCtx = { campaignId, item, runId, lane, laterTicket, itemRecords, blockedItems };

  if (spec.driver === "invoke_chain") {
    // The invoke_chain lane is the fixed engineer -> test-engineer chain (one run). Kept as
    // the explicit two steps the normal drive always produced — same agent task prompts.
    const engineerOutcome = await dispatchLaneInvoke(dispatch, {
      agentRole: "engineer",
      task: taskText,
      projectDir,
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
      return null;
    }

    const testEngineerTask = `${taskText}\n\n## Prior step\nengineer completed implementation for this item under run ${runId}; verify and add/adjust tests as needed.`;
    const testEngineerOutcome = await dispatchLaneInvoke(dispatch, {
      agentRole: "test-engineer",
      task: testEngineerTask,
      projectDir,
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
      return null;
    }

    // Both invokes completed — finalize with the SAME evidence eligibility the resume/reattach
    // path uses (FG-483: real commit reachability + covering host-verification, or the
    // non_code_diff classification — never ticket frontmatter alone).
    const itemWithRunId = { ...item, runId };
    const eligibility = evaluateInvokeLaneEligibility(projectDir, itemWithRunId);
    const docsWarning = eligibility.eligible ? formatDocsImpactWarning(assessRunDocsImpact(runId), runId) : null;
    const finalized = finalizeInvokeLaneOutcome(campaignId, itemWithRunId, eligibility, {
      shippedReason: docsWarning ?? undefined,
    });
    const outcome: CampaignItemOutcome | undefined = finalized.outcome === "shipped" ? "shipped" : undefined;

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
      updateCampaignItem(item.id, { branch: `forge/${runId}/${worktreeTask.id}`, worktreePath: worktreeTask.worktreePath });
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
      // FG-750: an unshipped invoke item parks waiting on an operator decision — an
      // item-scoped park. When this drive commits the pause, tell the controller to
      // continue with the next independent eligible item.
      if (await parkCampaign(campaignId, item.id, "decision_needed", laneParkContext)) {
        return { stopReason: "paused", stopScope: "item", itemRecords };
      }
      const post = getCampaign(campaignId);
      return { stopReason: post?.status === "abandoned" ? "abandoned" : "paused", itemRecords };
    }

    const postCheck = getCampaign(campaignId);
    if (!postCheck || postCheck.status !== "running") {
      return { stopReason: postCheck?.status === "abandoned" ? "abandoned" : "paused", itemRecords };
    }
    return null;
  }

  // ── driver === "invoke": single-role escape-hatch lane ─────────────────────
  const agentRole = spec.agentRole!;
  const dispatchOutcome = await dispatchLaneInvoke(dispatch, {
    agentRole,
    task: taskText,
    projectDir,
    runId,
    runTitle: item.ticketId,
  });

  if (dispatchOutcome.status !== "complete") {
    const stop = await finalizeInvokeDispatch(finalizeCtx, dispatchOutcome);
    if (stop) return stop;
    const postCheck = getCampaign(campaignId);
    if (!postCheck || postCheck.status !== "running") {
      return { stopReason: postCheck?.status === "abandoned" ? "abandoned" : "paused", itemRecords };
    }
    return null;
  }

  const itemWithRunId = { ...item, runId };
  const eligibility = evaluateInvokeLaneEligibility(projectDir, itemWithRunId);
  const finalized = finalizeInvokeLaneOutcome(campaignId, itemWithRunId, eligibility);
  const outcome: CampaignItemOutcome | undefined = finalized.outcome === "shipped" ? "shipped" : undefined;

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
    updateCampaignItem(item.id, { branch: `forge/${runId}/${worktreeTask.id}`, worktreePath: worktreeTask.worktreePath });
  }

  itemRecords.push({
    itemId: item.id,
    ticketId: item.ticketId,
    runId,
    lifecycleStatus: outcome === "shipped" ? "complete" : "awaiting_gate",
    outcome,
  });

  if (outcome !== "shipped") {
    // FG-750: item-scoped park (unshipped invoke item awaiting an operator decision).
    if (await parkCampaign(campaignId, item.id, "decision_needed", laneParkContext)) {
      return { stopReason: "paused", stopScope: "item", itemRecords };
    }
    const post = getCampaign(campaignId);
    return { stopReason: post?.status === "abandoned" ? "abandoned" : "paused", itemRecords };
  }

  const postCheck = getCampaign(campaignId);
  if (!postCheck || postCheck.status !== "running") {
    return { stopReason: postCheck?.status === "abandoned" ? "abandoned" : "paused", itemRecords };
  }
  return null;
}

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
    // FG-564 (item 3, C7 double-driver fence): when true, this is a LAUNCHED drive-item child.
    // Its authorization to do physical work is resolved from the DURABLE launch linkage row
    // (campaign_item_launches, keyed by the child's own (campaignId, itemId, attemptGeneration))
    // and NOT from any caller-supplied/env token — a raw or forged `campaign drive-item`
    // invocation cannot smuggle an authority in. Authorization holds ONLY while the linkage's
    // IMMUTABLE born-under owner/generation still holds the LIVE campaign-controller lease. It
    // FAILS CLOSED when the durable linkage is missing (absent = denied) or the born-under token
    // no longer holds the live lease (a takeover bumped the generation / the lease lapsed). A
    // fenced child STOPS with NO durable write attributable to the expired owner (item 4).
    enforceFence?: boolean;
  }
): Promise<DriveOneItemResult> {
  const itemRecords: CampaignItemRecord[] = [];

  const items = listCampaignItems(campaignId);
  const targetItem = items.find((i) => i.id === itemId);
  if (!targetItem) return { itemRecords };

  // FG-564 (item 1/3/4, C7 fence, FAIL CLOSED): resolve the born-under authority from the DURABLE
  // linkage — never an env/caller token. A CLI/launched `campaign drive-item` invocation
  // (enforceFence) is authorized ONLY while ALL of the following hold: a LIVE campaign-controller
  // lease exists AND its own attempt has a matching durable launch linkage AND that linkage's
  // IMMUTABLE born-under owner/generation still holds the live lease. It FAILS CLOSED — DENY —
  // when ANY link is absent:
  //   * NO lease row (item 1): a dead controller's expired/removed lease, or a legacy running
  //     campaign with no lease. Absence must DENY, never authorize — otherwise ANY caller could
  //     invoke a raw `campaign drive-item` and perform the normal durable drive with no linkage
  //     and no born-under token (the fail-open hole two reviewers flagged).
  //   * lease present but the linkage is missing (a raw/forged invocation — absent = denied);
  //   * the born-under owner/generation no longer holds the live lease (an orphaned child from an
  //     expired owner after a takeover bumped the generation / the lease lapsed).
  // The legitimate lease-less flow — the INTERNAL in-process drive (driveRemainingItems' direct
  // driveOneCampaignItem call, and the whole programmatic test suite) — never sets enforceFence,
  // so it never reaches this predicate: a raw command cannot invoke it. Enforced BEFORE any
  // durable write, so a fenced child performs NO write (item 4), re-checked immediately before
  // physical work in each run-producing lane AND at each wave inside the multi-wave drive loop
  // (item 3) so the fence holds ACROSS the whole drive.
  const fenceAuthorizes = (): boolean => {
    if (getCampaignLease(campaignId) === undefined) return false; // no live lease → raw/unmanaged drive is fenced
    const gen = targetItem.attemptGeneration > 0 ? targetItem.attemptGeneration : 1;
    const linkage = getItemLaunch(campaignId, itemId, gen);
    if (!linkage) return false; // a lease is held but this attempt has no born-under authority
    return campaignLeaseHeldBy(campaignId, linkage.controllerOwner, linkage.controllerGeneration);
  };
  if (opts.enforceFence && !fenceAuthorizes()) {
    // FENCED: STOP with no durable write. Any fence-occurrence audit is the NEW lease-holding
    // controller's job (the takeover/recover path), never this expired child's (item 4).
    return { itemRecords, stopReason: "recovery_needed" };
  }
  const ticketCache = listTickets(opts.projectDir);
  const ticketMap = new Map(ticketCache.map((t) => [t.id, t]));

  // Read per-item execution config from campaign canonical content.
  const campaignData = getCampaign(campaignId);
  const canonicalContent = campaignData?.metadata?.["planContent"];

  // FG-583: resolve the seed generation ONCE at drive entry and inject it into every
  // wave/gate/load below. No per-consumer seed-state gating — every workflow load here
  // reaches the seed surface through the loader's single resolve point, which refuses
  // (named, repairable) when no complete generation is published. That throw is caught
  // by the drive-throw / start-run-throw park handlers below, so a torn/incomplete/
  // absent generation parks the item instead of dispatching under a mixed/flat surface.
  // Anchor: injected into every workflow load AND runNext wave below, so a long-lived
  // item that outlives a promotion stays on the ONE complete generation it opened
  // (retained-never-recycled) rather than reading a recycled/torn one mid-drive. A
  // test-injected runNext/loader is honored as-is.
  const anchoredSeedGeneration = resolveSeedGeneration();
  const doRunNext: RunNextFn = opts.runNextFn ?? ((a) => runNext({ ...a, seedGeneration: anchoredSeedGeneration }));
  const doStartRun: StartRunFn = opts.startRunFn ?? startRun;
  const doLoadWorkflow: LoadWorkflowFn = opts.loadWorkflowFn
    ?? ((name, ctx) => loadWorkflow(name, { ...ctx, seedGeneration: anchoredSeedGeneration }));

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
      if (t) blockedItems.push({ id: prior.ticketId, ticket: t, blockerKind: prior.blockerKind, source: "failure" });
    } else if (isItemScopedPark(prior)) {
      // FG-750: a prior item parked awaiting an operator decision is unavailable —
      // hold only its EXPLICIT direct dependents; independent later items proceed.
      const t = ticketMap.get(prior.ticketId);
      if (t) blockedItems.push({ id: prior.ticketId, ticket: t, blockerKind: prior.blockerKind ?? "scope", source: "park" });
    } else if (prior.outcome === "held" && prior.blockerKind === "dependency") {
      // FG-750: an item already held on a parked/failed dependency is itself
      // transitively unavailable, so its own explicit dependents must hold too.
      const t = ticketMap.get(prior.ticketId);
      if (t) blockedItems.push({ id: prior.ticketId, ticket: t, blockerKind: "scope", source: "park" });
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
        if (t) blockedItems.push({ id: item.ticketId, ticket: t, blockerKind: item.blockerKind, source: "failure" });
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
      item.lifecycleStatus === "awaiting_recovery" ||
      // FG-564 (AC-ADOPT-DRIVE, item 2): a LAUNCHED drive-item child (enforceFence) can find its
      // item already 'running' with a real backing run — the controller's continuation-advance
      // reservation CREATED the run (the sole FG-596 item-run authority), then launched THIS child
      // to physically drive it. ONLY a child whose durable born-under fence authorizes may convert
      // that adopted reservation into the one live physical re-drive: reattach to the existing run
      // and drive it to terminal (no duplicate run, no fresh reservation — the reattach path below
      // never mints one). An unauthorized/expired child never reaches here (the entry fence already
      // denied it above); an un-launched (non-enforceFence) drive keeps the FG-596 legacy-guard
      // park below, so a raw concurrent drive still never re-drives another owner's run.
      (opts.enforceFence && item.lifecycleStatus === "running" && !!item.runId && fenceAuthorizes())
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

      // FG-564 (FIX round 5, AC-ADOPT-DRIVE): an ADOPTED invoke-family run — the recover
      // advance's reservation minted an "invoke"/"invoke_chain" run (via the shared authority),
      // then launched THIS authorized child to physically drive it. Its RECORDED lane identity
      // is the run's own durable `workflow` (+ metadata invokeAgent/invokeChain), so re-enter the
      // SAME real invoke driver the normal drive uses — NOT driveWorkflowItem/runNext (an invoke
      // run has no loadable YAML). Only the launched, fence-authorized child reaches this (the
      // entry condition gates on enforceFence + running + fenceAuthorizes); a normal parked
      // (awaiting_gate/blocked_by_red) invoke item keeps the existing evidence/reconcile path.
      if (item.lifecycleStatus === "running" && (runForItem.workflow === "invoke" || runForItem.workflow === "invoke_chain")) {
        const preReattachInvoke = getCampaign(campaignId);
        if (!preReattachInvoke || preReattachInvoke.status !== "running") {
          return { stopReason: preReattachInvoke?.status === "abandoned" ? "abandoned" : "paused", itemRecords };
        }
        const meta = (runForItem.metadata ?? {}) as Record<string, unknown>;
        const cachedTicket = ticketMap.get(item.ticketId);
        const taskText = cachedTicket ? `${item.ticketId}: ${cachedTicket.title}\n\n${cachedTicket.body}` : item.ticketId;
        const spec =
          runForItem.workflow === "invoke_chain"
            ? { driver: "invoke_chain" as const, ...(Array.isArray(meta["invokeChain"]) ? { invokeChain: (meta["invokeChain"] as unknown[]).filter((x): x is string => typeof x === "string") } : {}) }
            : { driver: "invoke" as const, ...(typeof meta["invokeAgent"] === "string" ? { agentRole: meta["invokeAgent"] as string } : {}) };
        const stop = await driveInvokeLaneItem(campaignId, item, item.runId, spec, {
          dispatch: opts.dispatch,
          projectDir: opts.projectDir,
          taskText,
          laterTicket: cachedTicket,
          itemRecords,
          blockedItems,
        });
        if (stop) return stop;
        continue;
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
        // FG-564 (item 3): keep the born-under fence live across the whole multi-wave drive.
        ...(opts.enforceFence ? { fenceAuthorizes } : {}),
      });
      itemRecords.push(driveResult.itemRecord);

      if (driveResult.outcome === "recovery_needed") {
        return { stopReason: "recovery_needed", itemRecords };
      }

      if (driveResult.outcome === "paused") {
        const c = getCampaign(campaignId);
        if (c?.status === "abandoned") return { stopReason: "abandoned", itemRecords };
        // FG-750: propagate the item-scoped-park signal so the controller continues
        // with the next independent eligible item instead of halting the campaign.
        return { stopReason: "paused", ...(driveResult.stopScope ? { stopScope: driveResult.stopScope } : {}), itemRecords };
      }

      // Item reached terminal — handle blocked-items tracking and cooperative pause.
      const termItem = getCampaignItem(item.id);
      if (termItem?.lifecycleStatus === "failed" && termItem.outcome === "blocked" && termItem.blockerKind) {
        if (!isSharedBlocker(termItem.blockerKind)) {
          const laterTicket = ticketMap.get(item.ticketId);
          if (laterTicket) {
            blockedItems.push({ id: item.ticketId, ticket: laterTicket, blockerKind: termItem.blockerKind, source: "failure" });
          } else {
            blockedItems.push({
              id: item.ticketId,
              ticket: { id: item.ticketId, type: "story", status: "active", title: item.ticketId, body: "" } as StructuredTicket,
              blockerKind: termItem.blockerKind,
              source: "failure",
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

    // FG-564 (item 3): re-assert the born-under fence IMMEDIATELY before any physical work /
    // durable write (a takeover between entry and here — however narrow — must not let the
    // expired owner mutate). Fenced → STOP with no durable write.
    if (opts.enforceFence && !fenceAuthorizes()) {
      return { itemRecords, stopReason: "recovery_needed" };
    }

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

    // FG-596 (redesign): the run-producing lanes below establish the ENTIRE pre-dispatch
    // invariant — allocate/reuse the attempt generation, derive the dispatch key, insert
    // the stamped run row, link it to the item, and CAS the item pending→running — in ONE
    // atomic transaction (reserveCampaignDriveDispatch). No partial shape ("running item
    // with no run", "run created but not linked") is representable, so there is no separate
    // claim step, no crash-mid-claim detector, and no pre-tx adoption lookup: adoption of a
    // crash-window run (FG-564) is inside the reservation. Only AFTER it commits does
    // physical work (runNext / invoke) begin, OUTSIDE the tx. The ticketing_only/manual
    // lanes dispatch no run and never reserve.
    //
    // Shared handling for a LOST reservation: the campaign was paused/abandoned or the item
    // parked out from under this drive (a concurrent operator action, or the launch-boundary
    // containment). Nothing was created — reconcile from durable state and halt cleanly,
    // exactly as the cooperative-pause checks would.
    const reconcileLostReservation = (): DriveOneItemResult => {
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
    };

    // FG-596 boundary: shared handling for an ADOPTED reservation. `adopted` means the run
    // at this key ALREADY existed — a concurrent drive (or a crash-window predecessor)
    // created and owns it. The reservation kept the link (item → the keyed run); THIS drive
    // must NOT physically drive that run: it dispatches no runNext / no invoke, mutates no
    // run / task / publication state, and infers NO owner liveness — physical-drive fencing
    // (controller identity + lease) is FG-564. Only reservation.status === "created" (this
    // caller created the run, so it owns the physical drive) enters the drive seam below.
    // Leave the DURABLE recovery shape (awaiting_gate + campaign_system) that IDENTIFIES the
    // adopted run, park the campaign, and return recovery_needed — so the controller /
    // operator and FG-564 can act on the already-owned run without a re-drive here. This is
    // the same recovery shape the legacy fail-closed guard above leaves (see isRecoveryShape
    // / deriveDriveItemResultFromDurableState).
    const handleAdoptedReservation = async (
      adopted: { runId: string; attemptGeneration: number },
    ): Promise<DriveOneItemResult> => {
      const requestedHumanAction =
        `${item.ticketId} already has run ${adopted.runId} (attempt_generation ` +
        `${adopted.attemptGeneration}) created and owned by another drive — this drive adopted ` +
        `and kept the keyed run but will NOT physically drive it (FG-564 owns physical-drive ` +
        `fencing). Inspect it (forge show ${adopted.runId}), resolve or abandon, then ` +
        `\`forge campaign resume ${campaignId}\`.`;
      updateCampaignItem(item.id, {
        lifecycleStatus: "awaiting_gate",
        blockerKind: "campaign_system",
        requestedHumanAction,
      });
      itemRecords.push({
        itemId: item.id,
        ticketId: item.ticketId,
        runId: adopted.runId,
        lifecycleStatus: "awaiting_gate",
        blockerKind: "campaign_system",
      });
      await parkCampaign(campaignId, item.id, "blocked", { exemption: "item-carries-context" }, { fallbackRunId: pickCampaignFallbackRunId(campaignId) });
      return { stopReason: "recovery_needed", itemRecords };
    };

    if (itemConfig.lane === "full_feature") {
      // ── FULL_FEATURE: resolve (fail closed) → atomic reserve (startRun inside the tx) → runNext ─
      const workflowName = itemConfig.workflowName ?? "feature";

      // FG-564 (FIX round 6): resolve the lane + filesystem inputs (workflow YAML + ticket)
      // through the ONE shared authority, which FAILS CLOSED — THROWS BEFORE any reservation —
      // on an unresolved/failed workflow, a missing ticket, or a missing projectDir, EXACTLY as
      // the recover advance does (both callers converge on prepareCampaignItemDispatch off the
      // same lane authority). On a resolution failure NO run is minted: the item stays pending
      // and the campaign / continuation stays recoverable, so there is no path where the normal
      // drive mints a run while the recover drive fails closed. The workflow YAML + ticket are
      // read OUTSIDE the tx here; the returned createRun captures them and does no fs read inside
      // the reservation. loadWorkflow is injected so a test can force the resolution failure.
      const cachedTicket = ticketMap.get(item.ticketId);
      const fullFeaturePlan = prepareCampaignItemDispatch(
        { campaignId, itemId: item.id },
        { projectDir: opts.projectDir, planContent: canonicalContent, ticket: cachedTicket, startRunFn: doStartRun, loadWorkflowFn: doLoadWorkflow },
      );
      const loadedWorkflow = fullFeaturePlan.workflow!;

      // Atomic reserve: allocate/reuse the generation, derive the key, insert the stamped
      // run (via startRun, INSIDE the tx), link it, and CAS the item pending→running — all
      // or nothing. A startRun throw rolls the whole reservation back (item stays pending,
      // no run) and propagates here → park directly at the terminal failure shape. Adoption
      // of a crash-window run happens inside the reservation, so no `adoptedRun` branch is
      // needed here.
      let reservation: CampaignDriveReservation;
      try {
        reservation = reserveCampaignDriveDispatch({
          campaignId,
          itemId: item.id,
          // FG-596: startRun stamps the deterministic dispatch key + item-attempt identity
          // into run metadata BEFORE the run is observable (pre-insert), INSIDE the tx.
          createRun: fullFeaturePlan.createRun,
        });
      } catch (err) {
        // startRun threw → the reservation rolled back COMPLETELY (item stays pending, no
        // run). The abandoned traceability run for this failed dispatch is created through
        // a FRESH reserveCampaignDriveDispatch — so it is stamped with the SAME attempt
        // generation + deterministic dispatch key as the rolled-back attempt, and its
        // insert + item run_id linkage + pending→running CAS commit atomically. A re-drive
        // in the crash window ADOPTS this one keyed synthetic run (runByDispatchKey) rather
        // than inserting a second row. Only AFTER the reservation commits does
        // parkCampaignOnStartRunThrow apply the failed/infrastructure classification —
        // creating no additional run.
        let parkRunId: string;
        // FG-663 (RF-3): resolve identity ABOVE the reservation's write lock.
        const syntheticIdentity = resolveRunProjectIdentity(opts.projectDir);
        try {
          const synthetic = reserveCampaignDriveDispatch({
            campaignId,
            itemId: item.id,
            createRun: ({ dispatchKey, attemptGeneration }) => {
              const newId = newRunId(item.ticketId);
              insertRun(
                {
                  id: newId,
                  workflow: workflowName,
                  title: item.ticketId,
                  status: "abandoned",
                  createdAt: nowIso(),
                  metadata: { campaignId, ticketId: item.ticketId, itemId: item.id, dispatchKey, attemptGeneration },
                  projectDir: opts.projectDir,
                },
                syntheticIdentity,
              );
              return newId;
            },
          });
          // Reservation LOST: the campaign was paused/abandoned or the item parked out from
          // under this drive. Nothing was created — reconcile from durable state and halt,
          // exactly as the load-fail lane does.
          if (synthetic.status === "lost") return reconcileLostReservation();
          // Reservation ADOPTED: a racing crash-window re-drive already committed and owns
          // the keyed synthetic run. Do NOT run parkCampaignOnStartRunThrow over it (that
          // mutates run/campaign state for a run this drive does not own) — surface
          // recovery_needed identifying the adopted run and leave it for FG-564.
          if (synthetic.status === "adopted") return await handleAdoptedReservation(synthetic);
          parkRunId = synthetic.runId;
        } catch {
          // The synthetic-run reservation itself failed to persist (a DB-level fault — the
          // insert or the CAS raised). The traceability row is best-effort: rather than let
          // that fault mask the ORIGINAL startRun error, fall back to a dangling run id so
          // parkCampaignOnStartRunThrow STILL records the drive error and notifies — scoped
          // to a campaign fallback run — instead of the park going silent (FG-516 F1).
          parkRunId = newRunId(item.ticketId);
        }
        throw await parkCampaignOnStartRunThrow(campaignId, item.id, item.ticketId, parkRunId, err);
      }
      if (reservation.status === "lost") return reconcileLostReservation();
      // Only a CREATED reservation (this caller minted the run) enters the physical drive
      // seam. An ADOPTED reservation means the keyed run is owned by another drive — keep
      // the link, drive nothing, and surface recovery_needed for FG-564 (no runNext here).
      if (reservation.status === "adopted") return await handleAdoptedReservation(reservation);
      const runId = reservation.runId;
      item.runId = runId;
      item.lifecycleStatus = "running";

      // Drive the workflow run to terminal or park.
      const driveResult = await driveWorkflowItem(campaignId, item, runId, loadedWorkflow, {
        runNextFn: doRunNext,
        gateFn: opts.gateFn,
        projectDir: opts.projectDir,
        // FG-564 (item 3): keep the born-under fence live across the whole multi-wave drive.
        ...(opts.enforceFence ? { fenceAuthorizes } : {}),
      });
      itemRecords.push(driveResult.itemRecord);

      if (driveResult.outcome === "recovery_needed") {
        return { stopReason: "recovery_needed", itemRecords };
      }

      if (driveResult.outcome === "paused") {
        const c = getCampaign(campaignId);
        if (c?.status === "abandoned") return { stopReason: "abandoned", itemRecords };
        // FG-750: propagate the item-scoped-park signal so the controller continues
        // with the next independent eligible item instead of halting the campaign.
        return { stopReason: "paused", ...(driveResult.stopScope ? { stopScope: driveResult.stopScope } : {}), itemRecords };
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
            blockedItems.push({ id: item.ticketId, ticket: laterTicket, blockerKind: termItem.blockerKind, source: "failure" });
          } else {
            blockedItems.push({
              id: item.ticketId,
              ticket: { id: item.ticketId, type: "story", status: "active", title: item.ticketId, body: "" } as StructuredTicket,
              blockerKind: termItem.blockerKind,
              source: "failure",
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
    } else if (itemConfig.lane === "quick_implementation" || itemConfig.lane === "docs_only" || itemConfig.lane === "test_only" || itemConfig.lane === "review_only" || itemConfig.lane === "research_only") {
      // ── INVOKE-FAMILY lanes: quick_implementation (engineer -> test-engineer chain) and
      //    the single-role escape hatch (docs_only/test_only/review_only/research_only) ──
      // FG-564 (FIX round 5): resolve the lane + fs inputs through the ONE shared authority
      // OUTSIDE the tx (fail closed on a missing ticket / unknown lane), reserve the correct
      // invoke/invoke_chain run shape INSIDE the tx via its createRun, then drive it through
      // the SAME real invoke path the recover/adopt child reuses (driveInvokeLaneItem). This
      // is the SOLE place these run shapes are minted — the recover adapter converges here too.
      const invokePlan = prepareCampaignItemDispatch(
        { campaignId, itemId: item.id },
        { projectDir: opts.projectDir, planContent: canonicalContent, ticket: ticketMap.get(item.ticketId) },
      );
      // Atomic reserve: create the stamped invoke/invoke_chain run + link + CAS pending→running
      // in ONE tx, adopting a crash-window run by key inside the reservation.
      const reservation = reserveCampaignDriveDispatch({
        campaignId,
        itemId: item.id,
        createRun: invokePlan.createRun,
      });
      if (reservation.status === "lost") return reconcileLostReservation();
      // Only CREATED drives the invoke lane; ADOPTED means another (unlaunched) drive owns the
      // keyed run — dispatch no invoke, surface recovery_needed for FG-564. A LAUNCHED
      // authorized child never reaches here for an adopted run: it entered the reattach branch
      // above and re-drove the recorded lane through driveInvokeLaneItem.
      if (reservation.status === "adopted") return await handleAdoptedReservation(reservation);
      const runId = reservation.runId;
      item.runId = runId;
      item.lifecycleStatus = "running";

      const cachedTicket = ticketMap.get(item.ticketId);
      const taskText = cachedTicket
        ? `${item.ticketId}: ${cachedTicket.title}\n\n${cachedTicket.body}`
        : item.ticketId;

      const stop = await driveInvokeLaneItem(
        campaignId,
        item,
        runId,
        invokePlan.driver === "invoke_chain"
          ? { driver: "invoke_chain", ...(invokePlan.invokeChain ? { invokeChain: invokePlan.invokeChain } : {}) }
          : { driver: "invoke", ...(invokePlan.agentRole ? { agentRole: invokePlan.agentRole } : {}) },
        { dispatch: opts.dispatch, projectDir: opts.projectDir, taskText, laterTicket, itemRecords, blockedItems },
      );
      if (stop) return stop;
      // Settled without halting — advance to the next item.
      continue;
    } else {
      // Unrecognized run-producing lane (the no-dispatch ticketing_only/manual lanes are
      // handled above). Fail closed rather than silently dispatching nothing.
      throw new Error(`driveOneCampaignItem: unrecognized dispatch lane '${itemConfig.lane}' for ${item.ticketId}`);
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
// FG-564 (D1): the campaign-controller lease TTL. It fences a longer-lived physical driver
// than the FG-562 per-phase continuation lease, so it is deliberately longer.
export const DEFAULT_CONTROLLER_LEASE_MS = 10 * 60 * 1000;

// FG-564 (P0-A, AC3): the next drivable (non-terminal) item strictly after `afterItemId`, in
// campaign order — the item whose id the boundary continuation's nextAction names (contract
// correction 3). Undefined when `afterItemId` is the last drivable item (→ finalize).
function nextDrivableItem(items: CampaignItem[], afterItemId: string): CampaignItem | undefined {
  const idx = items.findIndex((i) => i.id === afterItemId);
  if (idx < 0) return undefined;
  return items
    .slice(idx + 1)
    .find((i) => i.lifecycleStatus !== "complete" && i.lifecycleStatus !== "failed");
}

// FG-564 (P0-A / AC3): the campaign continuation RECORDER on the production drive path. Records
// ONE durable continuation per item boundary: continuationId = (campaignId, itemId);
// currentPhase = attempt-scoped drive:<itemId>#<attempt>; sourceLaunchId = the item's durable
// drive-item launch (from the item-attempt launch linkage — never re-derived heuristically);
// nextAction names the NEXT item explicitly (or finalize). The row is recorded in
// 'awaiting_completion' (never claimed here), so it is NOT in the recover in-dispatch set and a
// completed item is never re-driven; it is the durable boundary receipt `forge campaign recover`
// resolves against the linkage when it repairs an in-flight item's missing continuation (P1-G).
// Idempotent-tolerant: a re-record for the same continuation is swallowed by the caller.
// Returns true ONLY when a continuation was ACTUALLY recorded; false when the write was
// SKIPPED because there is no durable launch linkage to bind (in-process / legacy drive).
// The reopen-to-running caller (FG-750 RF-1) must treat a skip exactly like a throw — no
// continuation backs the transition either way, so it must NOT flip the campaign to running.
function recordItemBoundaryContinuation(campaignId: string, item: CampaignItem, items: CampaignItem[]): boolean {
  const gen = item.attemptGeneration > 0 ? item.attemptGeneration : 1;
  const linkage = getItemLaunch(campaignId, item.id, gen);
  const sourceLaunchId = linkage?.sourceLaunchId;
  if (!sourceLaunchId) return false; // in-process / legacy drive with no durable launch — nothing to bind
  const continuationId = campaignContinuationId(campaignId, item.id);
  const currentPhase = campaignItemPhase(item.id, gen);
  const next = nextDrivableItem(items, item.id);
  const nextAction = next ? driveCampaignItemAction(campaignId, next.id) : finalizeCampaignAction(campaignId);
  recordContinuation({ continuationId, consumerKind: "campaign", sourceLaunchId, currentPhase, nextAction });
  return true;
}

// FG-750 (RF-3 reconcile): whether the AUTHORITATIVE RESERVATION backs recovery for this
// boundary — the durable item-launch linkage the recover/resume path re-drives the parked item
// from, WITHOUT needing a continuation ("the reservation stays authoritative"). This is what
// makes reopening to running safe even when the item-boundary continuation write skipped or
// failed: there is still a durable reservation for recovery to adopt. Only when this is absent
// AND no continuation matching this attempt exists is the reopen the genuine RF-1 crash hazard.
function boundaryReservationBacksRecovery(campaignId: string, item: CampaignItem): boolean {
  const gen = item.attemptGeneration > 0 ? item.attemptGeneration : 1;
  return getItemLaunch(campaignId, item.id, gen) !== undefined;
}

// FG-750 (RF-1): whether an ALREADY-EXISTING boundary continuation backs THIS attempt's reopen.
// The continuation id is stable as (campaignId, itemId) across attempts — the attempt identity
// lives in the phase, not the id (see campaignContinuationId / campaignItemPhase). So a row left
// by a PRIOR attempt (a superseded escalation/retry generation) shares this boundary's id, and
// accepting it as backing would mask a genuine crash gap: recovery would adopt a stale prior
// attempt's continuation for a newer attempt. Match the row to the current attempt's generation
// phase before treating it as backing; a stale/mismatched continuation is NOT backing (the caller
// falls through to the reservation, else stays paused).
function existingContinuationBacksThisAttempt(campaignId: string, item: CampaignItem): boolean {
  const existing = getContinuation(campaignContinuationId(campaignId, item.id));
  if (!existing) return false;
  const gen = item.attemptGeneration > 0 ? item.attemptGeneration : 1;
  return existing.currentPhase === campaignItemPhase(item.id, gen);
}

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
    // FG-564 (P0-A / D1): the instance-stable controller identity that owns the
    // campaign-controller lease across this drive. When present (the production CLI path),
    // the drive acquires the lease (FAIL CLOSED against a live foreign owner — AC8 is
    // non-vacuous against a live NORMAL-start controller), actively RENEWS it across every
    // blocking per-item physical drive (D1 active-renewal model), records one durable
    // continuation per item boundary (the recorder the recover path adopts through the shared
    // adapter), and RELEASES it when the campaign becomes terminal or durably parks. Absent
    // (the existing in-process test suite and direct programmatic callers) → no leasing, the
    // legacy direct loop, byte-for-byte unchanged.
    controllerOwner?: string;
    controllerLeaseTtlMs?: number;
    // FG-564 (D1, item 2): how often the lease-renewal HEARTBEAT fires WHILE the parent is
    // parked on a blocking per-item drive. A single pre-launch renewal cannot fence a drive
    // longer than the TTL — the lease would lapse mid-drive and a second controller could take
    // over the item still being physically driven. The heartbeat fires during the `await`
    // (the wait harness yields the event loop), renewing the owner/generation-scoped lease so
    // the ORIGINAL owner holds it continuously for the WHOLE drive, however long it runs.
    // Defaults to a third of the TTL. (Injectable so a host-stress test can drive it fast.)
    controllerRenewIntervalMs?: number;
  }
): Promise<CampaignRunResult> {
  const itemRecords: CampaignItemRecord[] = [];
  const owner = opts.controllerOwner;
  const ttlMs = opts.controllerLeaseTtlMs ?? DEFAULT_CONTROLLER_LEASE_MS;
  const renewIntervalMs = opts.controllerRenewIntervalMs ?? Math.max(1, Math.floor(ttlMs / 3));

  // FG-564 (P0-A/AC7/AC8): acquire the campaign-controller lease before driving. A DIFFERENT
  // owner holding a still-LIVE lease FAILS CLOSED — a normal start/resume must not drive under
  // a live foreign controller (takeover is only after expiry, via `forge campaign recover`).
  let leaseGeneration: number | undefined;
  if (owner) {
    const grant = acquireCampaignLease({ campaignId, owner, ttlMs });
    if (!grant.granted) {
      itemRecords.push(
        ...listCampaignItems(campaignId)
          .filter((i) => i.lifecycleStatus !== "pending" && i.lifecycleStatus !== "complete" && i.lifecycleStatus !== "failed")
          .slice(0, 1)
          .map((i) => ({ itemId: i.id, ticketId: i.ticketId, runId: i.runId, lifecycleStatus: i.lifecycleStatus })),
      );
      return { stopReason: "recovery_needed", itemRecords };
    }
    leaseGeneration = grant.lease.generation;
  }

  // Release our lease when the campaign durably parks/terminates (D1). Owner/generation-scoped,
  // so it never clears a takeover winner's lease. Called on every owner-path return below.
  const releaseIfOwned = (): void => {
    if (owner && leaseGeneration !== undefined) {
      try { releaseCampaignLease(campaignId, owner, leaseGeneration); } catch { /* best-effort settle */ }
    }
  };

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
      releaseIfOwned();
      return { stopReason: preCheck?.status === "abandoned" ? "abandoned" : "paused", itemRecords };
    }

    // FG-564 (D1 active-renewal): OWN the lease across the blocking per-item drive. Renew ONCE
    // up front — a failure means a takeover already bumped the generation (or our lease lapsed):
    // we are FENCED, so stop without driving, and do NOT release (we no longer own it).
    if (owner && leaseGeneration !== undefined) {
      if (!renewCampaignLease(campaignId, owner, leaseGeneration, ttlMs)) {
        itemRecords.push({ itemId: item.id, ticketId: item.ticketId, runId: item.runId, lifecycleStatus: item.lifecycleStatus });
        return { stopReason: "recovery_needed", itemRecords };
      }
    }

    // FG-564 (D1, item 2): a single pre-launch renewal cannot fence a drive that OUTLIVES the
    // TTL — the lease would lapse mid-drive and a second controller could take over the item
    // still being physically driven. Run an owner/generation-scoped renewal HEARTBEAT that
    // fires DURING the blocking wait below (the wait harness yields the event loop, so the
    // timer renews while the parent is parked on the drive). The original owner therefore holds
    // the lease CONTINUOUSLY for the whole drive, however long it runs.
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let heartbeatLostLease = false;
    if (owner && leaseGeneration !== undefined) {
      const hbOwner = owner;
      const hbGen = leaseGeneration;
      heartbeat = setInterval(() => {
        // A renewal that fails means a takeover already stepped past us (owner/generation
        // changed) or our lease strictly lapsed despite the heartbeat — record it so we stop
        // fencing ourselves after the drive rather than driving further under a dead lease.
        if (!renewCampaignLease(campaignId, hbOwner, hbGen, ttlMs)) heartbeatLostLease = true;
      }, renewIntervalMs);
      // Never keep the process alive on the heartbeat alone.
      if (typeof heartbeat.unref === "function") heartbeat.unref();
    }

    // Launch item N and wait in-process; the launcher reads the outcome from durable
    // state (never the disposition). A drive error inside the child is committed as a
    // durable park BEFORE the child exits, so it surfaces here as a stopReason, not an
    // in-process throw (the in-process launcher preserves the throw for existing tests).
    let result: DriveOneItemResult;
    try {
      result = await launch(campaignId, item.id);
    } finally {
      if (heartbeat) clearInterval(heartbeat);
    }

    // If the heartbeat ever failed to renew, our lease was taken over mid-drive — we are
    // FENCED from advancing further: stop, and do NOT release (a takeover owner holds it now).
    if (heartbeatLostLease) {
      itemRecords.push(...result.itemRecords);
      return { stopReason: "recovery_needed", itemRecords };
    }
    itemRecords.push(...result.itemRecords);
    if (result.stopReason) {
      // FG-750: distinguish an ITEM-SCOPED operator park from a campaign-scoped stop.
      // A sequential campaign runs one item at a time — it does NOT make every later
      // item depend on every earlier one. When THIS item parked waiting on an operator
      // decision (a human gate / review disposition / blocking reviewer verdict — an
      // item-local blocker, or none), retain it (its run/workspace/evidence/question/
      // recommendation/resume-action are already durable) and return the campaign to
      // running so the NEXT independent eligible item in approved order can proceed. Its
      // true dependency descendants are held by the durable-state rebuild the next drive
      // performs. A campaign-scoped stop (shared blocker, lane escalation, recovery
      // wedge, operator pause/abandon) halts the whole campaign, unchanged.
      const durableItem = getCampaignItem(item.id);
      // Only continue past the park when there is genuinely later work still to drive.
      // If the parked item is effectively the last one (no later pending item), leave the
      // campaign paused exactly as before — flipping it back to running only to re-park it
      // would be pointless churn and a second pause notification for the same item.
      const idx = items.findIndex((i) => i.id === item.id);
      const laterPending = items
        .slice(idx + 1)
        .some((i) => getCampaignItem(i.id)?.lifecycleStatus === "pending");
      if (
        result.stopReason === "paused" &&
        result.stopScope === "item" &&
        isItemScopedPark(durableItem) &&
        laterPending &&
        // FG-750 (RF-2): an operator campaign-wide pause is a campaign-scoped stop that MUST
        // halt dispatch. The cross-process launch path reconstructs stopScope "item" from the
        // durable park shape alone, which cannot tell an operator pause (that won the
        // running→paused race) from the controller's OWN item-park pause — both leave the
        // identical shape. Re-check the durable operator-pause marker at this dispatch
        // decision point and refuse to continue when it is set.
        !isCampaignOperatorPaused(campaignId)
      ) {
        // FG-750 (RF-1): record the item-boundary continuation BEFORE flipping the campaign
        // back to running, so the durable "running" state is ALWAYS backed by a continuation
        // recovery can adopt. A crash between reopening the park and dispatching the next
        // item can then never leave the campaign running with nothing in flight: the worst
        // case is a paused campaign with the continuation already recorded, which resume
        // adopts (a completed boundary is never re-driven; the parked run is reattached,
        // never re-created).
        //
        // FG-750 (RF-3): fail closed if the reopen would leave NOTHING recovery can adopt —
        // that is the exact RF-1 hole (a subsequent crash leaves the campaign 'running' with
        // nothing in flight and nothing to adopt). But "fail closed" means fail closed ONLY on a
        // genuine loss of recoverable backing, NOT on every throw-or-skip. The reopen is backed
        // when ANY of these hold, and it is safe to proceed:
        //   (a) a continuation was freshly recorded in this transition; OR
        //   (b) a continuation ALREADY EXISTS for this boundary AND represents THIS attempt — a
        //       UNIQUE-constraint on continuation_id means the row IS durably present (an idempotent
        //       re-record of the current attempt's boundary), which is success, not failure. The
        //       continuation id is stable across attempts (RF-1), so a row left by a PRIOR attempt
        //       does NOT count: it is matched to the current attempt's generation phase first; OR
        //   (c) the authoritative reservation (the durable item-launch linkage) itself backs
        //       recovery for this boundary — the original "reservation stays authoritative"
        //       invariant: resume/recover re-drives the parked item from it without a
        //       continuation.
        // Only when NONE of those hold — no continuation recorded, none already present, and no
        // durable launch reservation to adopt — is there genuinely nothing recoverable, and the
        // campaign must stay PAUSED with the park intact.
        //
        // The owner-less in-process/programmatic drive records no continuation at all; there the
        // durable item state / reservation is authoritative exactly as it always was, so the
        // reopen is unconditionally safe (this is FG-750's core "the gate park does not stop
        // independent work" — a parked item returns the campaign to running so the next
        // independent item proceeds).
        let reopenRecoverable = true;
        if (owner && leaseGeneration !== undefined && durableItem) {
          reopenRecoverable = false;
          let threw: unknown;
          try {
            reopenRecoverable = recordItemBoundaryContinuation(campaignId, durableItem, items);
          } catch (err) {
            threw = err;
          }
          if (!reopenRecoverable) {
            // The write skipped (no launch linkage) or threw. It is still recoverable if the
            // continuation is now durably present (already-exists / idempotent re-record) or the
            // reservation backs recovery for this boundary.
            reopenRecoverable =
              existingContinuationBacksThisAttempt(campaignId, durableItem) ||
              boundaryReservationBacksRecovery(campaignId, durableItem);
          }
          if (!reopenRecoverable) {
            // Genuinely nothing to adopt — stay paused (the RF-1 crash hazard). Surface why.
            if (threw !== undefined) {
              const message = threw instanceof Error ? threw.message : String(threw);
              console.error(
                `campaign ${campaignId}: item-boundary continuation write failed for ${durableItem.ticketId} with no recoverable backing — keeping the campaign PAUSED with the park intact (resume/recover will re-drive it): ${message}`
              );
              logEvent("campaign_item.item_boundary_continuation_failed", {
                runId: durableItem.runId,
                payload: { campaignId, itemId: durableItem.id, ticketId: durableItem.ticketId, error: message, decidedAt: nowIso() },
              });
            } else {
              console.error(
                `campaign ${campaignId}: no item-boundary continuation recorded for ${durableItem.ticketId} and no reservation backing — keeping the campaign PAUSED with the park intact (resume/recover will re-drive it)`
              );
              logEvent("campaign_item.item_boundary_continuation_skipped", {
                runId: durableItem.runId,
                payload: { campaignId, itemId: durableItem.id, ticketId: durableItem.ticketId, decidedAt: nowIso() },
              });
            }
          }
        }
        if (reopenRecoverable && resumeCampaignToRunning(campaignId)) continue;
      }
      releaseIfOwned();
      return { stopReason: result.stopReason, itemRecords };
    }

    // FG-564 (P0-A recorder + boundary advance): item N settled without halting the campaign.
    // Durably record + advance the (campaignId, itemId) continuation for this boundary so a
    // crash before the NEXT item is launched is recoverable by `forge campaign recover`
    // (the shared adapter adopts it) — and a completed boundary is never re-driven.
    if (owner && leaseGeneration !== undefined) {
      const settled = getCampaignItem(item.id);
      if (settled) {
        try { recordItemBoundaryContinuation(campaignId, settled, items); } catch { /* best-effort: reservation stays authoritative */ }
      }
    }

    // Cooperative pause after the item settles.
    const postCheck = getCampaign(campaignId);
    if (!postCheck || postCheck.status !== "running") {
      releaseIfOwned();
      return { stopReason: postCheck?.status === "abandoned" ? "abandoned" : "paused", itemRecords };
    }
  }
  releaseIfOwned();

  // All items drained without halting. Held items (derived from durable state) keep the
  // campaign paused awaiting resume; otherwise it completes. This is the former
  // end-of-loop anyHeld/completeCampaign decision, now reading durable item state.
  // FG-516 (finding F3): the held pause is an unattended running→paused park, so it
  // still notifies (scoped to a campaign fallback run; the per campaign+item dedupe key
  // keeps a re-park across resumes from spamming).
  // FG-750: the campaign-scoped stop when no eligible work remains. Items parked awaiting
  // an operator decision (item-scoped parks the controller continued past) and items held
  // on a parked/failed dependency both keep the campaign paused — completing while an item
  // still waits on the operator would be a false "complete". Already-parked items fired
  // their pause milestone when they parked, so ONLY the newly-held items are notified here;
  // the CAS still carries the whole campaign to paused when either kind remains.
  const finalItems = listCampaignItems(campaignId);
  const heldItemIds = [...new Set(finalItems.filter((i) => i.outcome === "held").map((i) => i.id))];
  const anyParked = finalItems.some((i) => isItemScopedPark(i));
  if (heldItemIds.length > 0 || anyParked) {
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
): { itemRecords: CampaignItemRecord[]; stopReason?: CampaignStopReason; driveError?: Error; stopScope?: "item" | "campaign" } {
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
  // item still carrying an unadopted run) from an operator-actionable pause. FG-750: a
  // pause whose item settled at an ITEM-SCOPED operator-park shape is reconstructed as
  // stopScope "item" so the controller continues with the next independent eligible item
  // (the launch path reads the child's outcome from durable state, never its return
  // value, so this is where the cross-process scope is recovered).
  if (campaign.status !== "running") {
    if (isRecoveryShape(durableItem)) return { itemRecords, stopReason: "recovery_needed" };
    if (isItemScopedPark(durableItem)) return { itemRecords, stopReason: "paused", stopScope: "item" };
    return { itemRecords, stopReason: "paused" };
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
    // pre-drive state. The pending-gated CAS is the parent-side half of the reserve/park
    // race: if the drive-item child already reserved and dispatched the item (pending→running
    // atomically, inside reserveCampaignDriveDispatch) between this containment's durableItem
    // read above and this write, the park is a no-op and we must NOT clobber the live drive
    // nor pause the campaign behind it. In that case the item is a live/adoptable mid-flight
    // drive — reconcile from durable state (→ recovery_needed) exactly as the 'running' early
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
// FG-564 (Slice 5b, AC10 / step 5): persist the durable item-attempt launch linkage at
// launch time so a replacement controller discovers the (campaignId, itemId,
// attemptGeneration) -> sourceLaunchId binding DIRECTLY — never by parsing launch names,
// argv, or timestamps. Recorded record-FIRST (right after startLaunch, before the waiter is
// relied on) with the DETERMINISTIC generation the child's reserveCampaignDriveDispatch will
// use (reuse a persisted non-zero generation; else the first attempt is 1 — the identical
// formula the reservation applies), so the record-first row is stamped under the correct
// key. The born-under fencing token is the live campaign-controller lease owner/generation
// (AC7) when one is held; a stable launcher label otherwise.
//
// FG-564 (P1-F): this is a REQUIRED ordered step, NOT best-effort. It THROWS on failure so
// the caller (launchDriveItemUnderForge) can durably contain/park the item and NOT proceed
// with an unlinked launch. Recovery's sole direct-discovery authority is this linkage, so a
// swallowed failure that still launched+waited would be unrecoverable-by-linkage.
export function recordDriveItemLaunchLinkage(
  campaignId: string,
  itemId: string,
  sourceLaunchId: string,
  token?: { owner: string; generation: number },
): void {
  const item = getCampaignItem(itemId);
  if (!item || item.campaignId !== campaignId) {
    throw new Error(`recordDriveItemLaunchLinkage: item ${itemId} not found for campaign ${campaignId}`);
  }
  // The SAME formula reserveCampaignDriveDispatch uses: reuse a persisted attempt, else 1.
  const attemptGeneration = item.attemptGeneration > 0 ? item.attemptGeneration : 1;
  const lease = token ?? getCampaignLease(campaignId);
  const controllerOwner = lease?.owner ?? `campaign@${campaignId}@launcher`;
  const controllerGeneration = lease?.generation ?? 0;
  recordItemLaunch({
    campaignId,
    itemId,
    attemptGeneration,
    sourceLaunchId,
    controllerOwner,
    controllerGeneration,
    ...(item.runId ? { runId: item.runId } : {}),
    state: "launched",
  });
  // FG-737: recordItemLaunch's upsert keeps a pre-existing row's born-under token IMMUTABLE (only
  // ever moving run_id from NULL). That immutability strands a held item across a NEW controller:
  // its linkage stays pinned to the FIRST controller's owner (e.g. a stale `cli-<pid>` from before
  // the stable-identity fix, or a different generation after a legitimate takeover), so the
  // drive-item born-under fence never authorizes and the item fences forever without reaching its
  // held-readiness re-eval. When the attempt has SETTLED — run_id IS NULL, no in-flight authority
  // to protect — REFRESH the born-under token to THIS drive's controller so a legitimate new
  // controller re-drives. The refresh is guarded (run_id IS NULL) inside the store primitive: a
  // genuinely in-flight linkage (run_id present) is left untouched, preserving FG-564's
  // double-driver fence against a foreign live controller.
  refreshItemLaunchBornUnder(campaignId, itemId, attemptGeneration, {
    owner: controllerOwner,
    generation: controllerGeneration,
  });
}

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
    // FG-564 (item 3): the born-under fencing token is NOT carried into the child via env — an
    // env/caller token is forgeable and is never the authority. The child resolves its own
    // born-under owner/generation from the DURABLE launch linkage (recordDriveItemLaunchLinkage
    // below stamps it), so the argv carries only FORGE_HOME + FORGE_DB_PATH.
    const heldLease = getCampaignLease(campaignId);
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
      // FG-679 (BD-2): supply EXACTLY what the campaign actually knows at submission
      // — the campaign and the item. A run association is NOT manufactured here: the
      // drive-item child dispatches its own run, so no run id exists yet to declare,
      // and inventing one would attribute this launch to a run it was never
      // associated with. Campaign/item identity is PROVENANCE, not placement
      // authority (associationKindFor), so this launch is placed at project level
      // from its cwd and labeled `unassociated` — which is the honest answer, and the
      // one this comment has always claimed.
      meta = startLaunch(argv, { name: `campaign-drive-${itemId}`, ...(cwd ? { cwd } : {}), ...(seams.tmux ? { tmux: seams.tmux } : {}) });
      // FG-700: `campaign`, declared — this launch drives a campaign item, it is not
      // host verification. Recorded as its own field beside the campaign/item
      // provenance, which still authorizes no placement (associationKindFor).
      recordLaunchStart(meta, { campaignId, itemId }, "campaign");
      // FG-564 (AC10 / P1-F): make the item-attempt -> launch linkage durable as a REQUIRED
      // ordered step BEFORE arming the waiter, so a crash between here and the child's
      // continuation-record is recoverable by direct linkage discovery (C7). If it cannot
      // commit we must NOT proceed with an unlinked launch: force-remove the launch and
      // durably contain/park the item (throw → the outer catch runs containment).
      try {
        recordDriveItemLaunchLinkage(campaignId, itemId, meta.id, heldLease ? { owner: heldLease.owner, generation: heldLease.generation } : undefined);
      } catch (linkErr) {
        try { removeLaunch(meta.id, { force: true, ...(seams.tmux ? { tmux: seams.tmux } : {}) }); } catch { /* best-effort kill of the unlinked child */ }
        return containLaunchBoundaryFailure(campaignId, itemId, linkErr);
      }
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

    // FG-564 (AC10): reconcile the durable launch linkage with the run the child actually
    // reserved + drove (read from durable state, never from the launch disposition). Fills in
    // the immutable run id and moves the linkage's lifecycle forward. Non-fatal.
    try {
      const settled = getCampaignItem(itemId);
      if (settled) {
        const gen = settled.attemptGeneration > 0 ? settled.attemptGeneration : 1;
        updateItemLaunch(campaignId, itemId, gen, {
          ...(settled.runId ? { runId: settled.runId } : {}),
          state: derived.stopReason === "recovery_needed" ? "observed" : "settled",
        });
      }
    } catch {
      /* best-effort */
    }

    // A drive error re-raises the in-process throw so the CLI renders drive_error. The
    // park is already durable, so the launch record is disposable.
    if (derived.driveError) {
      try { removeLaunch(meta.id, seams.tmux ? { tmux: seams.tmux } : {}); } catch { /* best-effort cleanup */ }
      throw derived.driveError;
    }

    // recovery_needed leaves the launch record for inspection/adoption (FG-564); every
    // other settle is disposable (its durable effects are committed). Annotate the crash
    // record with the process disposition so the operator sees HOW the drive ended.
    //
    // FG-596 (redesign): a `running` mid-flight item ALWAYS has an adoptable run now — the
    // atomic reservation links the run inside the SAME tx that flips the item to running, so
    // the old "running item with no run" crash-mid-claim wedge is no longer representable and
    // needs no separate containment. This is unconditionally the genuine adoptable shape.
    if (derived.stopReason === "recovery_needed" && !isItemSettledOrParked(getCampaignItem(itemId))) {
      const dispositionNote = disposition ? statusLine(disposition) : `waiter: ${outcome.kind}`;
      const [rec] = derived.itemRecords;
      const annotated: CampaignItemRecord = rec
        ? { ...rec, reason: `drive-item process ended without settling the item (${dispositionNote}) — the item is adoptable by its dispatch key; inspect and resolve, then resume` }
        : { itemId, ticketId: itemId, lifecycleStatus: "running", reason: `drive-item process ended without settling the item (${dispositionNote})` };
      return { itemRecords: [annotated], stopReason: "recovery_needed" };
    }

    try { removeLaunch(meta.id, seams.tmux ? { tmux: seams.tmux } : {}); } catch { /* best-effort cleanup */ }
    // FG-750: carry the reconstructed item-scoped-park scope back to the controller so
    // the launch-per-item production path continues with the next independent item too.
    return {
      itemRecords: derived.itemRecords,
      ...(derived.stopReason ? { stopReason: derived.stopReason } : {}),
      ...(derived.stopScope ? { stopScope: derived.stopScope } : {}),
    };
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
    controllerOwner?: string;
    controllerLeaseTtlMs?: number;
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
    ...(opts.controllerOwner ? { controllerOwner: opts.controllerOwner } : {}),
    ...(opts.controllerLeaseTtlMs ? { controllerLeaseTtlMs: opts.controllerLeaseTtlMs } : {}),
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
    controllerOwner?: string;
    controllerLeaseTtlMs?: number;
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

  // FG-750 (RF-2): an operator-driven resume clears the operator-pause marker, so the next
  // item-scoped park is free to continue normally. The controller's own item-park resume
  // never touches the marker — it only continues when the marker is absent.
  clearOperatorPauseMarker(id);
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
    ...(opts.controllerOwner ? { controllerOwner: opts.controllerOwner } : {}),
    ...(opts.controllerLeaseTtlMs ? { controllerLeaseTtlMs: opts.controllerLeaseTtlMs } : {}),
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

  // FG-722 (FG-477 child E): the failed-primary SELECTION is the evaluator's
  // terminal classification (classifyRunTerminalState -> failedPhases), exactly the
  // migration FG-721 shipped in reconcileTerminalOutcome's fallback (same file).
  // failedPhases is the set of steps whose OWN primaries terminally failed with no
  // complete replacement, so on the PIPELINE lane this drops the two shapes the old
  // `parentId === undefined && status === 'failed'` scan wrongly counted: a
  // SUPERSEDED failed primary (a request-changes replacement completed the same
  // phase) and a failed AD-HOC invoke row (never a workflow phase). Within each
  // pipeline failed phase every terminally-failed primary is selected via the
  // evaluator's own phase-primary predicate (isPhasePrimaryRow), not a re-derived
  // parentId scan.
  //
  // Only a PIPELINE run has a loadable workflow YAML — mirror the executor's own
  // taskHasPipelineFinalize guard (used at the resume liveness probe above). An
  // invoke-family run (run.workflow 'invoke'/'invoke_chain') has no workflow file, so
  // pass workflow=undefined and let classifyRunTerminalState take its invoke shape
  // (the failed single-task ad-hoc row IS its own terminal phase). That invoke row
  // is an AD-HOC row, which isPhasePrimaryRow deliberately EXCLUDES — so the
  // selection below is LANE-AWARE: the invoke lane selects the failed primary via
  // isAdHocInvokeRow, not isPhasePrimaryRow, or a genuine transient invoke failure
  // would be dropped and wrongly refused. campaign.projectDir is guaranteed non-null
  // by the ship-eligibility guard above. The FailureKind classification / evidence
  // construction below stays in src/campaign.
  const runTasks = tasksForRun(runId);
  let workflow: Workflow | undefined;
  if (taskHasPipelineFinalize(run)) {
    try {
      workflow = loadWorkflow(run.workflow, { projectDir: campaign.projectDir });
    } catch {
      return refuse(
        `its run ${runId} workflow '${run.workflow}' could not be loaded, so its failed workflow phases cannot be classified; inspect it (\`forge show ${runId}\`), then re-plan or abandon`,
      );
    }
  }
  const failedPhases = classifyRunTerminalState(workflow, runTasks)?.failedPhases ?? [];
  // Lane-aware primary selection. The PIPELINE lane's failed phases are workflow
  // steps whose OWN primaries failed, selected via isPhasePrimaryRow — which
  // deliberately EXCLUDES ad-hoc invoke rows (a superseded/ad-hoc failed row must
  // not count as a phase failure). The INVOKE lane (workflow undefined) has no
  // workflow steps at all: classifyInvokeTerminalState makes each failed TOP-LEVEL
  // row (its whole universe is `parentId === undefined`) its own terminal phase, so
  // the re-selection here must cover that SAME universe or it drops a row the
  // classification already named. A top-level invoke-lane row is either an ad-hoc
  // invoke row (dispatchSource "invoke" — the marker every `forge invoke` / campaign
  // invoke-lane dispatch stamps) OR a marker-less top-level row (a legacy row, or a
  // driven row whose dispatch did not stamp the marker), which isPhasePrimaryRow
  // covers. FG-722 selected the invoke lane via isAdHocInvokeRow ALONE, which
  // silently required the marker — so a marker-less top-level failed invoke row
  // (e.g. a cancelled docs_only item) was counted into failedPhases but dropped
  // here, collapsing the specific cancel refusal into the generic "no failed
  // primary" one. `isPhasePrimaryRow(t) || isAdHocInvokeRow(t)` is exactly
  // classifyInvokeTerminalState's top-level universe (ad-hoc invoke rows are always
  // top-level), so the re-selection matches the classification row-for-row. Both
  // predicates are evaluator-owned — no parentId scan.
  const isFailedPrimary =
    workflow === undefined ? (t: Task) => isPhasePrimaryRow(t) || isAdHocInvokeRow(t) : isPhasePrimaryRow;
  const failedPrimaries = failedPhases.flatMap((phase) =>
    runTasks.filter((t) => t.phase === phase && isFailedPrimary(t) && t.status === "failed"),
  );
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
      // FG-596: a retry is the ONLY operation that mints a NEW logical generation. Bump it
      // here rather than clearing runId without one, so the next dispatch derives a DISTINCT
      // dispatch key (a delayed completion from the prior attempt cannot be mistaken for
      // this one) — and the next drive's atomic reservation REUSES this bumped generation
      // unchanged rather than re-allocating. Bumped in-line (one CAS with the reset) so it
      // shares this paused-guarded transaction.
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
