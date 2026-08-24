// FG-428/FG-443/FG-502: `forge campaign reconcile <campaign-id>` — on-demand
// operator recovery for a campaign item wedged on a stale historical
// authoritative red-fail (FG-428), parked at a human gate because its ticket
// was delivered through a re-routed, non-pipeline lane rather than the feature
// run itself (FG-443), or parked failed/blockerKind='campaign_system' by one of
// executor.ts's own salvage/gap/fallback producers when the ticket was actually
// delivered out-of-band (FG-502).
//
// This is a TRUST-GATE WRITE PATH: it can mark an item shipped/complete. It
// accepts no operator-supplied evidence ARGUMENT of any kind — every fact is
// re-derived from durable Forge/git/backlog/host-verification records via
// reconcile-collect.ts + reconcile-evidence.ts for the scope-blocked shape, or
// reconcile-outofband-collect.ts + reconcile-outofband-evidence.ts for the
// awaiting_gate/non-pipeline shape AND the failed/campaign_system shape (same
// evidence bar, distinct audit event kind — see each evidence module's header
// for what it requires). An item is mutated ONLY when its branch's facts all
// hold AND the campaign is still 'paused' at write time; every refusal leaves
// state untouched.
//
// This is NOT the automatic reconciliation on the normal outcome path (FG-427) —
// that runs during driveWorkflowItem; this is the operator-triggered recovery
// command, sharing the same evidence-derivation logic. Neither branch calls
// tryTransitionCampaign — campaign-level completion happens exclusively via
// driveRemainingItems's existing bottom-of-loop transition once every item
// lands in a terminal lifecycle status.

import { resolve } from "node:path";
import { getDb, writeTransaction } from "../store/db.js";
import {
  getCampaign,
  listCampaignItems,
  updateCampaignItemIfCampaignPaused,
  updateCampaignItemIfCampaignCompleteAndShape,
} from "../store/campaigns.js";
import { logEvent } from "../store/events.js";
import type { EventType } from "../store/events.js";
import type { CheckStatusProvider } from "../store/host-verifications.js";
import { insertHostVerification } from "../store/host-verifications.js";
import { nowIso } from "../util/ids.js";
import { collectReconcileEvidence, runAndRecordHostVerification, probeCiEvidenceForBackfill } from "./reconcile-collect.js";
import { evaluateReconcileEvidence } from "./reconcile-evidence.js";
import { collectOutOfBandEvidence } from "./reconcile-outofband-collect.js";
import {
  evaluateOutOfBandEvidence,
  authoritativeOutcomeContribution,
  composeOutOfBandEligibility,
} from "./reconcile-outofband-evidence.js";
import type { CampaignItem, CampaignItemLifecycleStatus } from "../types/index.js";

export type ReconcileItemStatus = "shipped" | "refused" | "not_applicable" | "evidence_recorded";

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

// FG-753 (AC4 / FG-692): the evidence-backfill path of --terminal-recovery. An
// item that is NOT a residual shape but is ALREADY complete/shipped can still
// keep the campaign verdict at complete_with_issues when its DONE-AUDIT is
// gapped — no covering source='ci' row exists at the item's candidate for the
// derived gate list (the live FG-692 case: source='host' rows only, test:extended
// unrunnable on macOS, so no source='ci' row). This closes that gap CI-ONLY.
//
// RF-2/RF-3 (root fix): the backfill NEVER runs the local gate list and NEVER
// mints a source='host' row. It probes CI coverage DIRECTLY via
// probeCiEvidenceForBackfill (the same verified findCoveringGateEvidence provider
// path the residual capture uses, WITHOUT the runGate local-exec fallback) and
// decides BEFORE minting anything. IFF authenticated whole-workflow source='ci'
// evidence covers the candidate, it records EXACTLY ONE source='ci' row (via
// insertHostVerification — INV-9 proven identity, NULL-canonical declines) AND
// emits the ci_evidence_backfilled event in ONE writeTransaction — so a row is
// never durable without its event (INV-7/RF-1), and the event is never emitted
// without the row. Otherwise it is a MUTATION-FREE named refusal: no row of ANY
// source, no event, the item row byte-identical.
//
// It NEVER mutates the item (it already shipped — there is nothing to re-derive)
// and NEVER touches the run graph (INV-8): the recorded evidence is the whole
// value, and report.ts's doneAuditGapAction/computeVerdict re-derive the verdict
// ON READ. "Done-audit gapped" is decided from the EXISTING coverage logic
// (collectReconcileEvidence → evaluateGateListCoverage), the same check
// report.ts and done-audit/collect.ts consume — not a new rule.
//
// Returns null when the item is not a backfill candidate (its gate coverage
// already passes — an idempotent no-op, so it falls through to not_applicable);
// otherwise an evidence_recorded / refused result. The probe is gated on the gap
// AND on ticket-done + a base-reachable candidate, so a not-yet-gapped item, a
// not-done ticket, or an unreachable/malformed candidate makes no provider call
// and writes no row (INV-7 mutation-free named refusal, INV-10 argv sha guard).
function backfillDoneAuditEvidence(
  campaignId: string,
  projectDir: string,
  item: CampaignItem,
  collect: typeof collectReconcileEvidence,
  checkStatusProvider: CheckStatusProvider | undefined,
  decidedBy: string | undefined
): ReconcileItemResult | null {
  const collected = collect(projectDir, item);
  const gateCovered = !!(collected.hostVerification && collected.hostVerification.passed);
  if (gateCovered) return null; // not gapped — the covering row already exists; no-op

  // The gate coverage is the gap. It is only closeable by recording evidence when
  // the ticket is done and its candidate is a base-reachable commit — otherwise the
  // gap is a ticket/commit gap no CI evidence can fill; refuse mutation-free, no probe.
  const missing: string[] = [];
  if (collected.ticketStatus !== "done") missing.push("ticket_status_not_done");
  if (!collected.ticketClosedCommit) missing.push("ticket_closed_commit_missing");
  else if (collected.closedCommitReachableOnBase !== true) missing.push("closed_commit_not_reachable_on_base_branch");
  if (missing.length > 0) {
    return { ticketId: item.ticketId, status: "refused", missing };
  }

  // CI-ONLY probe: does authenticated whole-workflow source='ci' evidence cover the
  // candidate? Decided BEFORE any mint — no runGate, no local exec, so no source='host'
  // row can ever close this gap (RF-2, INV-1/INV-4). An uncovered probe (no CI
  // evidence, a host-only row, a partially-red/pending workflow, a foreign-sha or an
  // unreachable provider) is a mutation-free refusal.
  const probe = probeCiEvidenceForBackfill(projectDir, item.ticketId, collected.ticketClosedCommit!, checkStatusProvider);
  if (probe.status !== "covered") {
    // RF-2 (INV-7): surface the probe's CONCRETE uncovered reason (dirty tree /
    // candidate would not cover / no authenticated CI evidence / scattered run
    // identity / provider unreachable) rather than laundering every distinct cause
    // into a generic lane_evidence_missing — the refusal must NAME the missing or
    // failing evidence so the operator can diagnose WHY the backfill refused.
    return { ticketId: item.ticketId, status: "refused", missing: [probe.reason] };
  }

  // RF-1/RF-3: the source='ci' mint and its ci_evidence_backfilled audit event commit
  // in ONE transaction — a throw (e.g. a failed event insert) rolls the row back too,
  // so a backfill can never leave a source='ci' row durable without its covering event,
  // and there is no post-mint decision that could commit a row on its own. RF-2: that
  // same transaction re-checks campaign.status='complete' at write time, so a concurrent
  // flip out of 'complete' between the probe and this write makes the mint a zero-row
  // no-op (no row, no event) — the CI trust row is never minted outside terminal-recovery
  // scope. No item write, no lifecycle CAS: the recorded evidence is the whole value and
  // the verdict derives on read. A failed atomic write degrades to the mutation-free
  // refusal below rather than crashing the reconcile loop.
  let recorded = false;
  try {
    recorded = writeTransaction(() => {
      // RF-2 (INV-7/INV-8): re-check campaign.status='complete' INSIDE this write
      // transaction, mirroring the residual CAS's status subquery. writeTransaction is
      // BEGIN IMMEDIATE, so a concurrent transition out of 'complete' between the
      // up-front check and here either committed before this tx took the write lock
      // (observed here) or is serialized behind it. A no-longer-complete campaign makes
      // the whole write a zero-row no-op — no source='ci' row, no ci_evidence_backfilled
      // event — so the backfill can never mint a CI trust row outside terminal-recovery scope.
      const current = getCampaign(campaignId);
      if (!current || current.status !== "complete") return false;
      insertHostVerification({
        ticketId: item.ticketId,
        projectDir,
        commitSha: probe.commitSha,
        gateName: probe.gate,
        command: probe.gate,
        exitCode: 0,
        runId: item.runId ?? null,
        recordedAt: nowIso(),
        source: "ci",
        ciUrl: probe.ciUrl,
      });
      // A distinct audit kind so the trail separates "residual item re-derived" from
      // "done-audit evidence backfilled for an already-shipped item". RF-3: the common
      // immutable provider run identity is retained here (alongside ciUrl) so the mint is
      // anchored to a verifiable run identity (anti-replay/audit).
      logEvent("campaign_item.ci_evidence_backfilled", {
        runId: item.runId,
        payload: {
          campaignId,
          itemId: item.id,
          ticketId: item.ticketId,
          evidence: { source: "ci", commitSha: probe.commitSha, gate: probe.gate, ciUrl: probe.ciUrl, runIdentity: probe.runIdentity, checks: probe.checks },
          decidedBy: decidedBy ?? "operator",
          decidedAt: nowIso(),
        },
      });
      return true;
    });
  } catch (err) {
    console.error(
      `reconcile: done-audit evidence backfill failed for ${item.ticketId} — row and event rolled back, no partial write: ${(err as Error).message ?? String(err)}`
    );
    recorded = false;
  }

  if (!recorded) {
    // The atomic write failed and rolled back — no covering ci row exists.
    // Mutation-free named refusal.
    return { ticketId: item.ticketId, status: "refused", missing: ["lane_evidence_missing"] };
  }
  return { ticketId: item.ticketId, status: "evidence_recorded" };
}

export function reconcileCampaign(
  campaignId: string,
  opts: {
    decidedBy?: string;
    // FG-753: the terminal-recovery branch of `campaign reconcile`. Strictly
    // conjunctive with campaign.status==='complete' below — the terminal path is
    // reachable ONLY when (terminalRecovery AND status==='complete'). Default
    // (flag absent) is the unchanged paused-only reconcile.
    terminalRecovery?: boolean;
    // FG-753 (INV-6): if given, must match the campaign's stored projectDir, or
    // the whole reconcile refuses mutation-free (confused-deputy guard). The
    // campaign always binds to its stored projectDir regardless.
    repo?: string;
    // FG-753: threaded straight into runAndRecordHostVerification's CI-evidence
    // consult (findCoveringGateEvidence). Absent in production (the gh-backed
    // default provider is used); tests inject a stub so no real GitHub call is
    // made. Applies to both modes — undefined preserves existing behavior.
    checkStatusProvider?: CheckStatusProvider;
    collectEvidence?: typeof collectReconcileEvidence;
    collectOutOfBandEvidence?: typeof collectOutOfBandEvidence;
    runAndRecordHostVerification?: typeof runAndRecordHostVerification;
  } = {}
): ReconcileCampaignResult {
  const campaign = getCampaign(campaignId);
  if (!campaign) {
    return { ok: false, reason: `campaign ${campaignId} not found`, items: [] };
  }
  // FG-753: the two modes NEVER overlap. Default (no flag) refuses any non-paused
  // campaign exactly as before (reconcile.ts:81-87). --terminal-recovery refuses
  // any non-complete campaign — so a paused campaign under the flag also refuses.
  // The status subquery inside the guarded writer (paused vs complete+shape) is
  // what actually protects each write against a concurrent flip; this up-front
  // check is only the cheap rejection.
  if (opts.terminalRecovery) {
    if (campaign.status !== "complete") {
      return {
        ok: false,
        reason: `campaign ${campaignId} is not complete (status: ${campaign.status}) — --terminal-recovery only runs against a complete (terminal) campaign`,
        items: [],
      };
    }
  } else if (campaign.status !== "paused") {
    return {
      ok: false,
      reason: `campaign ${campaignId} is not paused (status: ${campaign.status}) — reconcile only runs against a paused campaign`,
      items: [],
    };
  }
  if (!campaign.projectDir) {
    return { ok: false, reason: `campaign ${campaignId} has no stored project directory`, items: [] };
  }
  // FG-753 (INV-6): a --repo that does not name the campaign's stored projectDir
  // refuses mutation-free — nothing is collected, no gate runs, no item mutates.
  // projectDir is always bound to the campaign's stored dir below, never to --repo.
  if (opts.repo !== undefined && resolve(opts.repo) !== campaign.projectDir) {
    return {
      ok: false,
      reason: `--repo ${resolve(opts.repo)} does not match campaign ${campaignId}'s stored project directory ${campaign.projectDir} — refusing (INV-6 repo binding)`,
      items: [],
    };
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
    // executor.ts's gate:human path and its invoke-lane finalize sites (FG-442
    // review: a non-shipped invoke-lane outcome parks rather than completes) are the
    // only producers of 'awaiting_gate', and neither sets blockerKind — that absence
    // is exactly what distinguishes an out-of-band-eligible item from a scope-blocked
    // one (which always carries blockerKind: 'scope').
    const isOutOfBand = item.lifecycleStatus === "awaiting_gate" && !item.blockerKind;
    // FG-502: the recoverable shape is blockerKind:'campaign_system' with
    // lifecycleStatus 'failed' OR 'blocked_by_red' — not an enumerated
    // producer list. executor.ts producers include (non-exhaustive)
    // reconcileTerminalOutcome's run.status!=='complete' salvage, done-audit
    // gap after a passing verdict, unresolved-outcome fallback, and
    // infrastructure failures such as a workflow-YAML load error (all leaving
    // lifecycleStatus:'failed'); driveWorkflowItem's gate:verdict park on an
    // inconclusive aggregate verdict leaves lifecycleStatus:'blocked_by_red'
    // — so this check must cover both statuses, not just 'failed'. It stays
    // its own check (rather than folding into RECONCILABLE_LIFECYCLE_STATUSES)
    // because that set is scope-only by name, even though its status values
    // happen to coincide.
    const isCampaignSystemRecoverable =
      item.blockerKind === "campaign_system" &&
      (item.lifecycleStatus === "failed" || item.lifecycleStatus === "blocked_by_red");

    if (!isScopeBlocked && !isOutOfBand && !isCampaignSystemRecoverable) {
      // FG-753 (AC4): an already-shipped item is never a residual shape, so it
      // reaches here — but its done-audit can still be gapped, holding the
      // campaign verdict at complete_with_issues. Terminal-recovery backfills
      // that evidence (the FG-692 case). Any other item (a truly inert one, or
      // the paused-mode default) still falls through to not_applicable.
      if (opts.terminalRecovery && item.outcome === "shipped") {
        const backfilled = backfillDoneAuditEvidence(
          campaignId,
          projectDir,
          item,
          collect,
          opts.checkStatusProvider,
          opts.decidedBy
        );
        if (backfilled) {
          results.push(backfilled);
          continue;
        }
      }
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
          runGate(projectDir, item.ticketId, { runId: item.runId ?? null, itemId: item.id, campaignId: item.campaignId, checkStatusProvider: opts.checkStatusProvider });
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
      // FG-458/FG-460/FG-502: an out-of-band OR campaign_system-recoverable item
      // WITH a runId must ALSO agree with the run's own authoritative-review
      // outcome — the SAME fact, via the SAME shared helper, that `forge campaign
      // resume` uses for the out-of-band shape (awaiting_gate, no blockerKind, has
      // a runId — see executor.ts's FG-441 reattach path). Evaluated FIRST, before
      // the lane-evidence needsCapture gate run below: an unresolved authoritative
      // fail refuses regardless of lane evidence — no reason to spend a real
      // host-verification gate run finding that out. No shortcut for the
      // campaign_system cause: it runs the identical sequence as isOutOfBand.
      const authoritative = authoritativeOutcomeContribution(item.runId ? collect(projectDir, item) : null);

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
        authoritative.missing.length === 0 &&
        !!collected.ticketClosedCommit &&
        collected.closedCommitReachableOnBase === true &&
        collected.laneEvidence === null;
      if (needsCapture) {
        // Same infra-error isolation as the scope-blocked branch above: a throw
        // here degrades only THIS item to its normal lane_evidence_missing
        // refusal path — never crashes the reconcile loop for other items.
        try {
          runGate(projectDir, item.ticketId, { runId: item.runId ?? null, itemId: item.id, campaignId: item.campaignId, checkStatusProvider: opts.checkStatusProvider });
        } catch (err) {
          console.error(
            `reconcile: host-verification capture failed for ${item.ticketId} — item degrades to its normal refusal path: ${(err as Error).message ?? String(err)}`
          );
        }
        collected = collectOutOfBand(projectDir, item);
      }
      // FG-460: the SAME shared composition resume uses (minus the capture above,
      // which is reconcile-only) — so the two paths reach the same verdict for
      // the same evidence by construction.
      const composed = composeOutOfBandEligibility({
        outOfBand: evaluateOutOfBandEvidence(collected),
        authoritative,
        hasRunId: !!item.runId,
      });
      eligible = composed.eligible;
      missing = composed.missing;
      evidence = composed.evidence;
      // FG-502: same evidence bar as the out-of-band shape, but a distinct audit
      // event kind so the trail can tell "delivered out-of-band via a re-routed
      // lane" apart from "recovered from a campaign-system salvage/gap/fallback
      // failure that turned out to be already-shipped."
      eventType = isCampaignSystemRecoverable
        ? "campaign_item.campaign_system_reconciled"
        : "campaign_item.out_of_band_reconciled";
    }

    if (!eligible) {
      results.push({ ticketId: item.ticketId, status: "refused", missing });
      continue;
    }

    // Atomic: the status/shape guard, the item transition, and the audit event all
    // land in one transaction. Both guarded writers read campaigns.status as part
    // of the same UPDATE statement, so a concurrent flip out of the required status
    // between our up-front check (above) and this write is caught here: the write
    // becomes a no-op and no audit event is logged.
    //
    // FG-753: the ONLY thing the terminal branch changes at the write point is WHICH
    // guarded writer runs — the paused-status writer, or the complete-status +
    // residual-shape-CAS writer. Because a complete campaign has no paused/running
    // gate, the terminal writer's compare-and-set on the shape OBSERVED at read time
    // (item.lifecycleStatus + item.blockerKind) is what prevents a double-ship /
    // stale-read race in its place. The five mutated columns are identical in both.
    const shipTo = {
      lifecycleStatus: "complete" as const,
      outcome: "shipped" as const,
      blockerKind: undefined,
      reason: undefined,
      requestedHumanAction: undefined,
    };
    const shipped = writeTransaction(() => {
      const applied = opts.terminalRecovery
        ? updateCampaignItemIfCampaignCompleteAndShape(
            item.id,
            campaignId,
            { lifecycleStatus: item.lifecycleStatus, blockerKind: item.blockerKind ?? null },
            shipTo
          )
        : updateCampaignItemIfCampaignPaused(item.id, campaignId, shipTo);
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
    });

    if (!shipped) {
      // The guarded write became a no-op — the campaign left its required status
      // mid-reconcile (paused mode), or (terminal mode) the item's residual shape
      // changed under us (already re-derived / concurrently mutated) or the campaign
      // left 'complete'. Stop here rather than keep mutating against state we can no
      // longer trust.
      return {
        ok: false,
        reason: opts.terminalRecovery
          ? `campaign ${campaignId} item ${item.ticketId} was not mutated — the campaign left 'complete' or the item's residual shape changed during terminal recovery`
          : `campaign ${campaignId} left 'paused' during reconcile — item ${item.ticketId} was not mutated`,
        items: results,
      };
    }

    results.push({ ticketId: item.ticketId, status: "shipped" });
  }

  return { ok: true, items: results };
}
