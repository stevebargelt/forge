// FG-428: `forge campaign reconcile <campaign-id>` — on-demand operator recovery
// for a campaign item wedged on a stale historical authoritative red-fail.
//
// This is a TRUST-GATE WRITE PATH: it can mark an item shipped. It accepts no
// operator-supplied evidence ARGUMENT of any kind — every fact is re-derived from
// durable Forge/git/backlog/host-verification records via reconcile-collect.ts +
// reconcile-evidence.ts (see reconcile-evidence.ts's header for how the two
// frontmatter-derived facts are still cross-checked against non-editable
// evidence). An item is mutated ONLY when all five facts hold AND the campaign
// is still 'paused' at write time; every refusal leaves state untouched.
//
// This is NOT the automatic reconciliation on the normal outcome path (FG-427) —
// that runs during driveWorkflowItem; this is the operator-triggered recovery
// command, sharing the same evidence-derivation logic.

import { getDb } from "../store/db.js";
import { getCampaign, listCampaignItems, updateCampaignItemIfCampaignPaused } from "../store/campaigns.js";
import { logEvent } from "../store/events.js";
import { nowIso } from "../util/ids.js";
import { collectReconcileEvidence } from "./reconcile-collect.js";
import { evaluateReconcileEvidence } from "./reconcile-evidence.js";
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
  opts: { decidedBy?: string; collectEvidence?: typeof collectReconcileEvidence } = {}
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
  const items = listCampaignItems(campaignId);
  const results: ReconcileItemResult[] = [];

  for (const item of items) {
    if (item.blockerKind !== "scope" || !RECONCILABLE_LIFECYCLE_STATUSES.has(item.lifecycleStatus)) {
      results.push({ ticketId: item.ticketId, status: "not_applicable" });
      continue;
    }

    const collected = collect(projectDir, item);
    const evaluated = evaluateReconcileEvidence(collected);

    if (!evaluated.eligible) {
      results.push({ ticketId: item.ticketId, status: "refused", missing: evaluated.missing });
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
      logEvent("campaign_item.evidence_reconciled", {
        runId: item.runId,
        payload: {
          campaignId,
          itemId: item.id,
          ticketId: item.ticketId,
          evidence: evaluated.evidence,
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
