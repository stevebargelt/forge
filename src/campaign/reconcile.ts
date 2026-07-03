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
import { collectReconcileEvidence, runAndRecordHostVerification } from "./reconcile-collect.js";
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
    runAndRecordHostVerification?: typeof runAndRecordHostVerification;
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
  const runGate = opts.runAndRecordHostVerification ?? runAndRecordHostVerification;
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
      let collected = collect(projectDir, item);
      // FG-440: an item merged THROUGH forge with no PASSING host-verification
      // row covering its actual closedCommit gets a real gate run captured here,
      // in projectDir at its current HEAD — never a checkout of closedCommit.
      // Only fires when closedCommit is a known, reachable commit. This is a
      // passing-row model, not a once-ever model: a covering row that FAILED
      // does not block a re-run — a failed/false-fail result must not
      // permanently wedge the item, since a later real green run supersedes it.
      // Only a covering PASSING row stops further capture attempts. This never
      // reads gate.decided/force-advance events — host-verification stays an
      // independent fact from force-advance.
      const needsCapture =
        !!collected.ticketClosedCommit &&
        collected.closedCommitReachableOnBase === true &&
        !(collected.hostVerification && collected.hostVerification.passed);
      if (needsCapture) {
        // An infra error here (git failure, unexpected throw from an injected
        // gate stub) must degrade only THIS item to its normal not_recorded
        // refusal path below — never crash the whole reconcile loop and take
        // every other item down with it. A gate that runs to completion still
        // has its real exit recorded as-is; this only guards the invocation.
        try {
          runGate(projectDir, item.ticketId, { runId: item.runId ?? null });
        } catch (err) {
          console.error(
            `reconcile: host-verification capture failed for ${item.ticketId} — item degrades to not_recorded: ${(err as Error).message ?? String(err)}`
          );
        }
        collected = collect(projectDir, item);
      }
      const evaluated = evaluateReconcileEvidence(collected);
      eligible = evaluated.eligible;
      missing = evaluated.missing;
      evidence = evaluated.evidence;
      eventType = "campaign_item.evidence_reconciled";
    } else {
      let collected = collectOutOfBand(projectDir, item);
      // FG-452: parity with the scope-blocked needsCapture above — capture only
      // for the CODE-TOUCHING sub-lane. collectOutOfBandEvidence's laneEvidence is
      // {kind:"non_code_diff"} whenever the closing commit touches only non-code
      // paths (that sub-lane needs no host verification at all — see AC4), and
      // {kind:"host_verification", ...} only once a covering PASSING row already
      // exists (see reconcile-outofband-collect.ts's passing-row model). So
      // laneEvidence === null, with ticketClosedCommit present, means exactly
      // "code-touching and not yet covered by a passing row" — the same gate
      // shape as the scope-blocked branch's needsCapture.
      const needsCapture =
        !!collected.ticketClosedCommit &&
        collected.closedCommitReachableOnBase === true &&
        collected.laneEvidence === null;
      if (needsCapture) {
        // Same infra-error isolation as the scope-blocked branch above: a throw
        // here degrades only THIS item to its normal lane_evidence_missing
        // refusal path — never crashes the reconcile loop for other items.
        try {
          runGate(projectDir, item.ticketId, { runId: item.runId ?? null });
        } catch (err) {
          console.error(
            `reconcile: host-verification capture failed for ${item.ticketId} — item degrades to its normal refusal path: ${(err as Error).message ?? String(err)}`
          );
        }
        collected = collectOutOfBand(projectDir, item);
      }
      const evaluated = evaluateOutOfBandEvidence(collected);
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
