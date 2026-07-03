// FG-428/FG-443: `forge campaign reconcile <campaign-id>` — on-demand operator
// recovery for a campaign item wedged on a stale historical authoritative
// red-fail (FG-428), or parked at a human gate because its ticket was delivered
// through a re-routed, non-pipeline lane rather than the feature run itself
// (FG-443).
//
// This is a TRUST-GATE WRITE PATH: it can mark an item shipped/complete. It
// accepts no operator-supplied evidence ARGUMENT of any kind — every fact is
// re-derived from durable Forge/git/backlog/host-verification records via
// reconcile-collect.ts + reconcile-evidence.ts for the scope-blocked shape, or
// reconcile-outofband-collect.ts + reconcile-outofband-evidence.ts for the
// awaiting_gate/non-pipeline shape (see each evidence module's header for what
// it requires). An item is mutated ONLY when its branch's facts all hold AND
// the campaign is still 'paused' at write time; every refusal leaves state
// untouched.
//
// This is NOT the automatic reconciliation on the normal outcome path (FG-427) —
// that runs during driveWorkflowItem; this is the operator-triggered recovery
// command, sharing the same evidence-derivation logic. Neither branch calls
// tryTransitionCampaign — campaign-level completion happens exclusively via
// driveRemainingItems's existing bottom-of-loop transition once every item
// lands in a terminal lifecycle status.

import { getDb } from "../store/db.js";
import { getCampaign, listCampaignItems, updateCampaignItemIfCampaignPaused } from "../store/campaigns.js";
import { logEvent } from "../store/events.js";
import type { EventType } from "../store/events.js";
import { nowIso } from "../util/ids.js";
import { collectReconcileEvidence } from "./reconcile-collect.js";
import { evaluateReconcileEvidence } from "./reconcile-evidence.js";
import { collectOutOfBandEvidence } from "./reconcile-outofband-collect.js";
import { evaluateOutOfBandEvidence } from "./reconcile-outofband-evidence.js";
import type { CampaignItemLifecycleStatus } from "../types/index.js";

export type ReconcileItemStatus = "shipped" | "refused" | "not_applicable";

export type ReconcileItemResult = {
  ticketId: string;
  status: ReconcileItemStatus;
  missing?: string[];
};

export type ReconcileCampaignResult = {
  ok: boolean;
  reason?: string;
  items: ReconcileItemResult[];
};

// The two lifecycle shapes a scope-blocking authoritative-verdict failure can leave
// an item in: the terminal shape (driveWorkflowItem's reconcileTerminalOutcome) and
// the parked shape (blocked_by_red, awaiting a gate that never came).
const RECONCILABLE_LIFECYCLE_STATUSES: ReadonlySet<CampaignItemLifecycleStatus> = new Set([
  "failed",
  "blocked_by_red",
]);

export function reconcileCampaign(
  campaignId: string,
  opts: {
    decidedBy?: string;
    collectEvidence?: typeof collectReconcileEvidence;
    collectOutOfBandEvidence?: typeof collectOutOfBandEvidence;
  } = {}
): ReconcileCampaignResult {
  const campaign = getCampaign(campaignId);
  if (!campaign) {
    return { ok: false, reason: `campaign ${campaignId} not found`, items: [] };
  }
  // Paused-only guard, cheap up-front rejection: a running campaign must not be
  // reconciled concurrently with an in-flight resume/start. This check alone is
  // NOT the guard against the race — see updateCampaignItemIfCampaignPaused below,
  // which re-verifies atomically at the moment of each write.
  if (campaign.status !== "paused") {
    return {
      ok: false,
      reason: `campaign ${campaignId} is not paused (status: ${campaign.status}) — reconcile only runs against a paused campaign`,
      items: [],
    };
  }
  if (!campaign.projectDir) {
    return { ok: false, reason: `campaign ${campaignId} has no stored project directory`, items: [] };
  }

  const projectDir = campaign.projectDir;
  const collect = opts.collectEvidence ?? collectReconcileEvidence;
  const collectOutOfBand = opts.collectOutOfBandEvidence ?? collectOutOfBandEvidence;
  const items = listCampaignItems(campaignId);
  const results: ReconcileItemResult[] = [];

  for (const item of items) {
    const isScopeBlocked =
      item.blockerKind === "scope" && RECONCILABLE_LIFECYCLE_STATUSES.has(item.lifecycleStatus);
    // executor.ts:451-460's gate:human path is the ONLY producer of 'awaiting_gate'
    // and it never sets blockerKind — that absence is exactly what distinguishes an
    // out-of-band-eligible item from a scope-blocked one (which always carries
    // blockerKind: 'scope').
    const isOutOfBand = item.lifecycleStatus === "awaiting_gate" && !item.blockerKind;

    if (!isScopeBlocked && !isOutOfBand) {
      results.push({ ticketId: item.ticketId, status: "not_applicable" });
      continue;
    }

    let eligible: boolean;
    let missing: string[];
    let evidence: unknown;
    let eventType: EventType;

    if (isScopeBlocked) {
      const evaluated = evaluateReconcileEvidence(collect(projectDir, item));
      eligible = evaluated.eligible;
      missing = evaluated.missing;
      evidence = evaluated.evidence;
      eventType = "campaign_item.evidence_reconciled";
    } else {
      const evaluated = evaluateOutOfBandEvidence(collectOutOfBand(projectDir, item));
      eligible = evaluated.eligible;
      missing = evaluated.missing;
      evidence = evaluated.evidence;
      eventType = "campaign_item.out_of_band_reconciled";
    }

    if (!eligible) {
      results.push({ ticketId: item.ticketId, status: "refused", missing });
      continue;
    }

    // Atomic: the paused-guard, the item transition, and the audit event all land
    // in one transaction. updateCampaignItemIfCampaignPaused's WHERE clause reads
    // campaigns.status as part of the same UPDATE statement, so a concurrent
    // resume/start that flips the campaign out of 'paused' between our up-front
    // check (above) and this write is caught here: the write becomes a no-op and
    // no audit event is logged.
    const shipped = getDb().transaction(() => {
      const applied = updateCampaignItemIfCampaignPaused(item.id, campaignId, {
        lifecycleStatus: "complete",
        outcome: "shipped",
        blockerKind: undefined,
        reason: undefined,
        requestedHumanAction: undefined,
      });
      if (!applied) return false;
      logEvent(eventType, {
        runId: item.runId,
        payload: {
          campaignId,
          itemId: item.id,
          ticketId: item.ticketId,
          evidence,
          decidedBy: opts.decidedBy ?? "operator",
          decidedAt: nowIso(),
        },
      });
      return true;
    })();

    if (!shipped) {
      // The campaign left 'paused' mid-reconcile — stop here rather than keep
      // mutating items against a campaign state we can no longer trust.
      return {
        ok: false,
        reason: `campaign ${campaignId} left 'paused' during reconcile — item ${item.ticketId} was not mutated`,
        items: results,
      };
    }

    results.push({ ticketId: item.ticketId, status: "shipped" });
  }

  return { ok: true, items: results };
}
