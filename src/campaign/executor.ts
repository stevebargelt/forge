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
  updateCampaignItemIfCampaignRunning,
  updateCampaignPlanForReapproval,
  tryTransitionCampaign,
  tryTransitionCampaignToRunning,
} from "../store/campaigns.js";
import { getDb } from "../store/db.js";
import { logEvent } from "../store/events.js";
import { tasksForRun } from "../store/tasks.js";
import type { Campaign, CampaignItem, CampaignItemLifecycleStatus, CampaignItemOutcome, BlockerKind, Run } from "../types/index.js";
import { resolvePlan, sourceInputToPlannerInput, getItemPlanEntry } from "./planner.js";
import type { PlannerInput, PlanMode, ExecutionLane, ItemModeOverride } from "./planner.js";
import { listTickets } from "../backlog/structured.js";
import type { StructuredTicket } from "../backlog/structured.js";
import { getRun, insertRun, updateRunStatus } from "../store/runs.js";
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
import { emitMilestone } from "../notify/milestone.js";
import type { MilestoneKind } from "../notify/milestone.js";

// FG-516: the milestone emitter notifyCampaignPause routes through. Injectable
// (mirrors the done-audit override below) ONLY so a test can prove that an
// emitter throw never breaks the safety-critical park.
let _campaignNotifyEmitter: typeof emitMilestone = emitMilestone;
export function setCampaignNotifyEmitterForTest(fn: typeof emitMilestone | null): void {
  _campaignNotifyEmitter = fn ?? emitMilestone;
}

// FG-516: the run a no-run park scopes its milestone to. A held or recovery park
// has no run of its OWN (the item was never dispatched, or its run was lost), but
// emitMilestone is run-scoped. Any real run belonging to the SAME campaign is a
// coherent anchor: the milestone is about the campaign pausing, its dedupe key is
// still per campaign+item, and the run-scoped audit trail lands under a run in the
// campaign it describes. Returns the first item's run so the same held item scopes
// to the same run across resumes (keeping the persistent dedupe stable). Undefined
// only when NO item in the whole campaign ever produced a run (e.g. every item
// held from the start) — that residual campaign-scoped case still needs a schema
// change, deferred to FG-517.
function pickCampaignFallbackRunId(campaignId: string): string | undefined {
  for (const it of listCampaignItems(campaignId)) {
    if (it.runId && getRun(it.runId)) return it.runId;
  }
  return undefined;
}

// FG-516: notify the operator that an UNATTENDED campaign park just happened —
// the silent-wedge class this ticket closes. Called AFTER the running→paused
// transition succeeds, so the durable pause is never gated on the notification.
// One milestone per campaign+item via a stable dedupe key, scoped to the item's
// own run when it has one, else to a campaign-scoped fallback run so held /
// no-run parks still push (findings F2/F3). emitMilestone's persistent run-scoped
// dedupe then suppresses a re-park of the same item after resume. A notify failure
// must NEVER propagate — the park is the safety-critical half — so every error is
// swallowed.
async function notifyCampaignPause(
  campaignId: string,
  itemId: string,
  kind: MilestoneKind,
  fallbackRunId?: string,
  bodyBlockerKind?: string,
): Promise<void> {
  try {
    const item = getCampaignItem(itemId);
    if (!item) return;
    const runId =
      item.runId && getRun(item.runId)
        ? item.runId
        : fallbackRunId && getRun(fallbackRunId)
          ? fallbackRunId
          : undefined;
    // No run anywhere in the campaign to scope a (run-scoped) milestone to →
    // nothing to emit. getRun guards the emitMilestone "run not found" throw.
    if (!runId) return;
    const detail: string[] = [];
    // FG-516 (finding F2): the docs promise every campaign-park body leads with a
    // blocker kind. Recoverable gate/drive parks deliberately persist NO blockerKind
    // on the item (that unset field is the FG-441 reattach / reconcile marker, so we
    // must not persist one), so the caller composes a body-only label for those
    // shapes. Prefer the persisted kind when present; fall back to the composed one.
    const blockerKind = item.blockerKind ?? bodyBlockerKind;
    if (blockerKind) detail.push(`blocker: ${blockerKind}`);
    if (item.requestedHumanAction) detail.push(item.requestedHumanAction);
    await _campaignNotifyEmitter({
      runId,
      kind,
      title: `Campaign ${campaignId} paused — ${item.ticketId} needs attention`,
      body: detail.length > 0 ? detail.join(" — ") : `campaign ${campaignId} parked ${item.ticketId}`,
      dedupeKey: `campaign-pause:${campaignId}:${item.ticketId}`,
      // FG-516 (finding A): the dedupe KEY is already campaign+item-stable, but the
      // SCOPE must be global — `forge campaign retry` clears the item's runId, so a
      // re-park lands on a NEW run and a run-scoped scan would re-notify the same
      // campaign+item. Global scope suppresses the repeat across runs.
      dedupeScope: "global",
    });
  } catch (err) {
    console.error(
      `FG-516: campaign pause notify failed (park unaffected): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// FG-516 (finding B) — THE park boundary. Every running→paused park in this file
// goes through here: it performs the CAS transition itself and notifies ONLY when
// the CAS committed, then returns the CAS result so call sites keep their existing
// control flow. This makes the "notify without a committed pause" wedge class
// unrepresentable — a concurrent operator `forge campaign pause` (the documented
// manual-pause exemption) that wins the CAS first leaves committed=false, so this
// stale driver pushes nothing. The notify is awaited and never throws (see
// notifyCampaignPause), so a throw-park helper can await it before rethrowing and
// know the milestone is settled before control returns to the CLI. A structural
// guard test (executor-park-boundary) asserts no site calls tryTransitionCampaign
// (.., "running", "paused") or notifyCampaignPause directly outside this function.
//
// `itemId` accepts an array for the campaign-level held-items pause: one CAS,
// then a milestone per held item (each de-duped independently by its own key).
async function parkCampaign(
  campaignId: string,
  itemId: string | string[],
  kind: MilestoneKind,
  opts?: { fallbackRunId?: string; bodyBlockerKind?: string },
): Promise<boolean> {
  const committed = tryTransitionCampaign(campaignId, "running", "paused");
  if (committed) {
    for (const id of Array.isArray(itemId) ? itemId : [itemId]) {
      await notifyCampaignPause(campaignId, id, kind, opts?.fallbackRunId, opts?.bodyBlockerKind);
    }
  }
  return committed;
}

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
    if (await parkCampaign(campaignId, item.id, "decision_needed")) {
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
    if (await parkCampaign(campaignId, item.id, "blocked")) {
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
    if (await parkCampaign(campaignId, item.id, "blocked")) {
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
    await parkCampaign(campaignId, itemId, "blocked", { bodyBlockerKind: "drive_error" });
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
    await parkCampaign(campaignId, itemId, "blocked", { fallbackRunId: pickCampaignFallbackRunId(campaignId) });
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
  let noProgressStreak = 0;
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
        await parkCampaign(campaignId, itemId, "blocked");
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
      await parkCampaign(campaignId, itemId, "blocked");
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
          await parkCampaign(campaignId, itemId, "blocked");
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
          await parkCampaign(campaignId, itemId, "blocked");
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
        await parkCampaign(campaignId, itemId, "decision_needed", { bodyBlockerKind: "human_gate" });
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
      await parkCampaign(campaignId, itemId, "blocked", { bodyBlockerKind: "no_progress" });
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

  const shipped = getDb().transaction(() => {
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
  })();

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
export async function driveRemainingItems(
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
            await parkCampaign(campaignId, item.id, "blocked");
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
            const shipped = getDb().transaction(() => {
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
            })();
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
        await parkCampaign(campaignId, item.id, "blocked", { fallbackRunId: pickCampaignFallbackRunId(campaignId) });
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
        await parkCampaign(campaignId, item.id, "blocked", { fallbackRunId: pickCampaignFallbackRunId(campaignId) });
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
          await parkCampaign(campaignId, item.id, "blocked");
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
      await parkCampaign(campaignId, item.id, "blocked", { fallbackRunId: pickCampaignFallbackRunId(campaignId) });
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
          metadata: { campaignId, ticketId: item.ticketId, itemId: item.id },
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
        if (await parkCampaign(campaignId, item.id, "blocked")) {
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
      try {
        const startResult = doStartRun({
          workflow: loadedWorkflow,
          title: item.ticketId,
          inputs,
          projectDir: opts.projectDir,
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
            metadata: { campaignId, ticketId: item.ticketId, itemId: item.id },
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
      const runId = newRunId(item.ticketId);
      insertRun({
        id: runId,
        workflow: "invoke_chain",
        title: item.ticketId,
        status: "active",
        createdAt: nowIso(),
        metadata: { invokeChain: ["engineer", "test-engineer"], campaignId, ticketId: item.ticketId, itemId: item.id },
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

      if (finalized.outcome === "parked") {
        updateCampaignItem(item.id, {
          lifecycleStatus: "awaiting_gate",
          requestedHumanAction:
            finalized.missing.length > 0
              ? `agent finished but evidence is incomplete for ${item.ticketId} (${finalized.missing.join(", ")}) — resolve and run \`forge campaign reconcile\`, or resolve manually`
              : `agent finished and ${item.ticketId} looks shipped, but the campaign state changed mid-evaluation — run \`forge campaign resume\` or \`forge campaign reconcile\` to finalize`,
        });
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
        if (await parkCampaign(campaignId, item.id, "decision_needed")) {
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
      const runId = newRunId(item.ticketId);
      insertRun({
        id: runId,
        workflow: "invoke",
        title: item.ticketId,
        status: "active",
        createdAt: nowIso(),
        metadata: { invokeAgent: agentRole, campaignId, ticketId: item.ticketId, itemId: item.id },
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

      if (finalized.outcome === "parked") {
        updateCampaignItem(item.id, {
          lifecycleStatus: "awaiting_gate",
          requestedHumanAction:
            finalized.missing.length > 0
              ? `agent finished but evidence is incomplete for ${item.ticketId} (${finalized.missing.join(", ")}) — resolve and run \`forge campaign reconcile\`, or resolve manually`
              : `agent finished and ${item.ticketId} looks shipped, but the campaign state changed mid-evaluation — run \`forge campaign resume\` or \`forge campaign reconcile\` to finalize`,
        });
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
        if (await parkCampaign(campaignId, item.id, "decision_needed")) {
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

  // All items processed. If any held items remain, campaign → paused (awaiting resume).
  // If no held items, campaign → complete (may be complete_with_issues per report verdict).
  // FG-516 (finding F3): this campaign-level pause is an unattended running→paused
  // park too, so it must not stay silent. Held items have no run of their own, so
  // each milestone is scoped to a campaign fallback run; the per campaign+item
  // dedupe key keeps a re-park across resumes from spamming. Only a campaign with
  // ZERO runs at all (every item held from the start) still can't push — that
  // residual needs a campaign-scoped channel, deferred to FG-517.
  if (anyHeld) {
    const heldItemIds = [...new Set(itemRecords.filter((r) => r.outcome === "held").map((r) => r.itemId))];
    if (await parkCampaign(campaignId, heldItemIds, "blocked", { fallbackRunId: pickCampaignFallbackRunId(campaignId) })) {
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
  const applied = getDb().transaction(() => {
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
    });
    if (!wrote) return false;
    if (evidence) {
      logEvent("campaign_item.campaign_system_retried", {
        runId: retainedRunId,
        payload: { campaignId, itemId: targetItem.id, ticketId, runId: retainedRunId, evidence, decidedAt: nowIso() },
      });
    }
    return true;
  })();
  if (!applied) return { ok: false, reason: "campaign is no longer paused (concurrent state change)" };

  return { ok: true };
}
