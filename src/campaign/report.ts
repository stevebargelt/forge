import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { getCampaign, listCampaignItems } from "../store/campaigns.js";
import { getRun } from "../store/runs.js";
import { tasksForRun } from "../store/tasks.js";
import { verdictsForRun } from "../store/verdicts.js";
import { listTickets, readTicket } from "../backlog/structured.js";
import { evaluateReadiness } from "../readiness/readiness.js";
import type { ReadinessResult } from "../readiness/readiness.js";
import { evaluateDoneAudit } from "../done-audit/done-audit.js";
import type { DoneAuditResult } from "../done-audit/done-audit.js";
import { collectDoneAuditInput } from "../done-audit/collect.js";

// Test-only override — lets unit tests inject a known done-audit map without
// a real git repo or host verification recorder. Same pattern as setDbForTest.
let _testDoneAuditMapOverride: Map<string, DoneAuditResult> | null = null;
export function setDoneAuditMapForTest(map: Map<string, DoneAuditResult> | null): Map<string, DoneAuditResult> | null {
  const prev = _testDoneAuditMapOverride;
  _testDoneAuditMapOverride = map;
  return prev;
}
import { resolvePlan, sourceInputToPlannerInput, getItemPlanEntry } from "./planner.js";
import type { PlanMode } from "./planner.js";
import type { Campaign, CampaignItem } from "../types/index.js";
import { campaignBlocker, probeCampaignSystemRetryEvidence, evaluateCampaignSystemShipEligibility } from "./executor.js";
import { collectOutOfBandEvidence } from "./reconcile-outofband-collect.js";
import { evaluateOutOfBandEvidence } from "./reconcile-outofband-evidence.js";
import { collectReconcileEvidence } from "./reconcile-collect.js";
import { evaluateReconcileEvidence, describeMissingReason, AUTHORITATIVE_OUTCOME_MISSING_CODES } from "./reconcile-evidence.js";

function computeCurrentPlanHash(campaign: Campaign): string | null {
  if (!campaign.projectDir) return null;
  if (!existsSync(campaign.projectDir) || !existsSync(join(campaign.projectDir, "backlog"))) return null;
  try {
    const plannerInput = sourceInputToPlannerInput(campaign.sourceInput);
    const { planHash } = resolvePlan(plannerInput, {
      projectDir: campaign.projectDir,
      mode: campaign.mode as PlanMode,
    });
    return planHash;
  } catch {
    return null;
  }
}

// Host-local operational state (operator notes, scratch dirs) that must not block
// shipped-work reporting. Duplicated in done-audit/collect.ts on purpose: both call
// sites parse `git status --porcelain` independently and must not disagree.
function isHostLocalNoisePath(path: string): boolean {
  return path === "backlog/notes.md" || path.startsWith(".forge-scratch/");
}

function filterDirtyPorcelainLines(output: string): string[] {
  return output
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .filter((line) => !isHostLocalNoisePath(line.slice(3)));
}

function computeDirtyGitState(projectDir: string): string | null {
  try {
    const output = execFileSync("git", ["status", "--porcelain"], {
      cwd: projectDir,
      encoding: "utf8",
      timeout: 5000,
    });
    const lines = filterDirtyPorcelainLines(output);
    return lines.length > 0 ? lines.join("\n") : null;
  } catch {
    return null;
  }
}

function findInFlightItem(items: CampaignItem[]): CampaignItem | undefined {
  return items.find(
    (i) => i.lifecycleStatus !== "pending" && i.lifecycleStatus !== "complete" && i.lifecycleStatus !== "failed"
  );
}

function unresolvedBlockedItem(items: CampaignItem[]): CampaignItem | undefined {
  return items.find((i) => i.lifecycleStatus === "failed" && i.outcome === "blocked");
}

function unrefinedReadinessItem(items: CampaignItem[]): CampaignItem | undefined {
  return items.find(
    (i) => i.lifecycleStatus === "pending" && i.outcome === "held" && i.blockerKind === "readiness"
  );
}

// FG-489: mirrors campaign.ts's recoveryGuidanceMessage — same recovery_needed
// scenario (item stuck in an indeterminate lifecycle state), surfaced here on
// the show/report next-action fields instead of start/resume stderr. Must not
// tell the operator to hand-edit the DB; once the run is confirmed dead and the
// item lands on a transient (auth/infrastructure) blockerKind, `forge campaign
// retry` — not a raw reset — is the supported path.
function recoveryNeededAction(campaignId: string, item: CampaignItem): string {
  const runPart = item.runId ? ` run ${item.runId}` : "the run";
  const showHint = item.runId ? ` ${item.runId}` : "";
  return `recovery needed: item ${item.ticketId} is ${item.lifecycleStatus} — inspect ${runPart} (forge show${showHint}); if it turns out to be a transient failure (auth/infrastructure), \`forge campaign retry ${campaignId} ${item.ticketId}\` once the campaign is paused will reset it for a clean re-dispatch`;
}

// FG-489: same retryable-kind set as executor.ts's RETRYABLE_BLOCKER_KINDS and
// campaign.ts's — auth/infrastructure are transient host/environment failures
// eligible for `forge campaign retry`; everything else (scope/verdict failures,
// lane_escalation, etc.) needs operator re-plan/escalate/abandon, not a reset.
const RETRYABLE_BLOCKER_KINDS = new Set(["auth", "infrastructure"]);

function blockedItemGuidance(campaignId: string, blockedItem: CampaignItem): string {
  const kind = blockedItem.blockerKind ?? "unknown";
  const retryHint =
    blockedItem.blockerKind && RETRYABLE_BLOCKER_KINDS.has(blockedItem.blockerKind)
      ? ` — transient: \`forge campaign retry ${campaignId} ${blockedItem.ticketId}\` will reset it`
      : "";
  return `resolve blocker ${blockedItem.ticketId} (${kind})${retryHint} then resume`;
}

// FG-460: shared single definition of the authoritative-outcome codes (see
// reconcile-evidence.ts) — was a hand-mirrored duplicate here. outOfBandHost-
// VerificationHint below relies on this excluding host-verification (a not-yet-
// captured item must still surface the hint, not be suppressed as ineligible).
function hasUnresolvedAuthoritativeOutcome(projectDir: string, item: CampaignItem): boolean {
  const evaluated = evaluateReconcileEvidence(collectReconcileEvidence(projectDir, item));
  return evaluated.missing.some((m) => AUTHORITATIVE_OUTCOME_MISSING_CODES.has(m));
}

// FG-443: distinguishes an awaiting_gate item that was actually delivered outside
// the feature pipeline (re-routed lane) — and is therefore completable via the
// evidence-gated `forge campaign reconcile` out-of-band path — from a genuine
// unfinished human gate. Only awaiting_gate items with no blockerKind are ever
// out-of-band candidates (see reconcile.ts's isOutOfBand routing); best-effort —
// any collection/evaluation error falls through to the generic gate text.
// FG-444: shared text for the out-of-band eligibility hint — used both for the
// single top-level Next action line (via outOfBandCompletableAction below) and
// for the per-item hint lines in show/report, so the two surfaces never drift.
export function formatOutOfBandEligibleHint(ticketId: string): string {
  return `${ticketId} delivered out-of-band — eligible for evidence-gated completion via forge campaign reconcile`;
}

// FG-511: the retry counterpart to formatOutOfBandEligibleHint — shared by the
// single top-level next-action line and the per-item hint lines in show/report.
export function formatCampaignSystemRetryHint(campaignId: string, ticketId: string): string {
  return `${ticketId}'s run failed on transient (auth/infrastructure) evidence and never shipped — eligible for an evidence-gated reset via \`forge campaign retry ${campaignId} ${ticketId}\`, then resume`;
}

function outOfBandCompletableAction(campaign: Campaign, item: CampaignItem): string | null {
  // FG-444 fix: `forge campaign reconcile` refuses categorically unless the
  // campaign is paused (see reconcile.ts's paused-only guard) — this display
  // must gate on the same condition or it can claim eligibility reconcile will
  // never honor (e.g. for an abandoned campaign).
  if (campaign.status !== "paused") return null;
  if (item.lifecycleStatus !== "awaiting_gate" || item.blockerKind) return null;
  if (!campaign.projectDir) return null;
  try {
    const evaluated = evaluateOutOfBandEvidence(collectOutOfBandEvidence(campaign.projectDir, item));
    if (!evaluated.eligible) return null;
    // FG-458: an item WITH a runId must also agree with the run's own
    // authoritative-review outcome — otherwise this hint would point the
    // operator at `forge campaign reconcile` for a row reconcile itself now
    // refuses (see reconcile.ts's out-of-band branch).
    if (item.runId && hasUnresolvedAuthoritativeOutcome(campaign.projectDir, item)) {
      return null;
    }
    return formatOutOfBandEligibleHint(item.ticketId);
  } catch {
    // best-effort — fall through to the generic gate text
  }
  return null;
}

// FG-502: mirrors reconcile.ts's isCampaignSystemRecoverable routing predicate
// (kept independent here — this module never imports reconcile.ts) — the
// recoverable shape is blockerKind 'campaign_system' with lifecycleStatus
// 'failed' OR 'blocked_by_red', not an enumerated producer list.
// executor.ts producers include (non-exhaustive) reconcileTerminalOutcome's
// run-status-incomplete salvage, done-audit-gap, and unresolved-outcome-
// fallback paths, and infrastructure failures such as a workflow-YAML load
// error (all leaving lifecycleStatus:'failed'); plus driveWorkflowItem's
// inconclusive-verdict park, which leaves lifecycleStatus:'blocked_by_red'.
// An item matching either combination may have actually shipped out-of-band
// despite the campaign-level failure. This predicate and the hints below are
// a read-only preview mirror: they never write, and `forge campaign reconcile`
// re-derives the same evidence independently as the sole write path.
function isCampaignSystemRecoverable(item: CampaignItem): boolean {
  return (
    item.blockerKind === "campaign_system" &&
    (item.lifecycleStatus === "failed" || item.lifecycleStatus === "blocked_by_red")
  );
}

// FG-502: the campaign_system counterpart to outOfBandCompletableAction — same
// paused-only gate (reconcile refuses categorically unless paused), routed off
// isCampaignSystemRecoverable instead of the awaiting_gate/no-blockerKind shape.
// FG-511 (round 2): the out-of-band + authoritative-outcome composition it used to
// spell out inline is now executor.ts's evaluateCampaignSystemShipEligibility —
// the SAME function `forge campaign retry`'s probe refuses on, so this hint and
// that refusal can never disagree about whether the item shipped.
function campaignSystemCompletableHint(campaign: Campaign, item: CampaignItem): string | null {
  if (campaign.status !== "paused") return null;
  if (!isCampaignSystemRecoverable(item)) return null;
  if (!campaign.projectDir) return null;
  try {
    return evaluateCampaignSystemShipEligibility(campaign.projectDir, item).eligible
      ? formatOutOfBandEligibleHint(item.ticketId)
      : null;
  } catch {
    // best-effort — fall through to no hint
  }
  return null;
}

// FG-502: memoize like outOfBandCompletableAction's memoizeOutOfBandCompletableAction
// — the underlying evaluators shell out to git, and this hint is evaluated both
// for the top-level next-action computation and for every per-item row.
function memoizeCampaignSystemCompletableHint(): (campaign: Campaign, item: CampaignItem) => string | null {
  const cache = new Map<string, string | null>();
  return (campaign: Campaign, item: CampaignItem) => {
    if (!cache.has(item.ticketId)) {
      cache.set(item.ticketId, campaignSystemCompletableHint(campaign, item));
    }
    return cache.get(item.ticketId) ?? null;
  };
}

// FG-440: distinguishes "the required host gate hasn't run yet — will be
// captured automatically on the next reconcile/drive run" from "the gate ran
// for real and failed" for a scope-blocked item, so the report never renders a
// genuine failure as something pending or overridable. Only meaningful for
// blockerKind==='scope' items (out-of-band items use their own hint below);
// best-effort — any collection/evaluation error yields no hint.
function scopeBlockedHostVerificationHint(campaign: Campaign, item: CampaignItem): string | null {
  if (item.blockerKind !== "scope") return null;
  if (!campaign.projectDir) return null;
  try {
    const evaluated = evaluateReconcileEvidence(collectReconcileEvidence(campaign.projectDir, item));
    const hostReason = evaluated.missing.find(
      (m) => m === "host_verification_not_recorded" || m === "host_verification_recorded_but_failed"
    );
    return hostReason ? describeMissingReason(hostReason) : null;
  } catch {
    return null;
  }
}

// FG-452: the out-of-band counterpart to scopeBlockedHostVerificationHint above —
// an out-of-band code-touching item that isn't eligible yet SOLELY because it has
// no covering passing host-verification row must point the operator at
// `forge campaign reconcile` (which captures that gate — see reconcile.ts's
// out-of-band needsCapture), not the generic architect-gate text that
// outOfBandCompletableAction / requestedHumanAction would otherwise surface.
// missing === ["lane_evidence_missing"] alone is exactly the shape reconcile's
// needsCapture gate acts on: ticket done, closedCommit present and reachable on
// base, only the lane evidence (host verification for a code-touching commit, or
// the non_code_diff classification) still unresolved. Best-effort — any
// collection/evaluation error yields no hint.
function outOfBandHostVerificationHint(campaign: Campaign, item: CampaignItem): string | null {
  if (item.lifecycleStatus !== "awaiting_gate" || item.blockerKind) return null;
  if (!campaign.projectDir) return null;
  try {
    const evaluated = evaluateOutOfBandEvidence(collectOutOfBandEvidence(campaign.projectDir, item));
    if (evaluated.eligible) return null;
    if (evaluated.missing.length === 1 && evaluated.missing[0] === "lane_evidence_missing") {
      // FG-458: only the lane evidence is missing — but if this item has a runId
      // and its own run carries an unresolved authoritative fail, `forge campaign
      // reconcile` would refuse it anyway (see reconcile.ts's out-of-band branch).
      // Pointing the operator at reconcile here would be misleading — surface the
      // run-evidence refusal reason instead.
      if (item.runId && hasUnresolvedAuthoritativeOutcome(campaign.projectDir, item)) {
        return null;
      }
      return (
        "lane_evidence_missing (no covering passing host-verification row recorded yet for this out-of-band " +
        "delivery — run `forge campaign reconcile` to capture a real host-verification gate and re-check)"
      );
    }
  } catch {
    // best-effort — fall through to no hint
  }
  return null;
}

// FG-502: the campaign_system counterpart to outOfBandHostVerificationHint —
// same missing===["lane_evidence_missing"] shape, same FG-458 runId guard,
// routed off isCampaignSystemRecoverable instead of the awaiting_gate shape.
// Not memoized, matching outOfBandHostVerificationHint's own un-memoized calls.
function campaignSystemLaneEvidenceHint(campaign: Campaign, item: CampaignItem): string | null {
  if (!isCampaignSystemRecoverable(item)) return null;
  if (!campaign.projectDir) return null;
  try {
    const evaluated = evaluateOutOfBandEvidence(collectOutOfBandEvidence(campaign.projectDir, item));
    if (evaluated.eligible) return null;
    if (evaluated.missing.length === 1 && evaluated.missing[0] === "lane_evidence_missing") {
      if (item.runId && hasUnresolvedAuthoritativeOutcome(campaign.projectDir, item)) {
        return null;
      }
      return (
        "lane_evidence_missing (no covering passing host-verification row recorded yet for this out-of-band " +
        "delivery — run `forge campaign reconcile` to capture a real host-verification gate and re-check)"
      );
    }
  } catch {
    // best-effort — fall through to no hint
  }
  return null;
}

// FG-511: a campaign_system item whose run never shipped — so neither reconcile
// hint above applies — is still recoverable when the run's durable task evidence
// proves the failure was transient. Calls retryCampaignItem's OWN probe (a
// read-only evaluator) behind the same guards retryCampaignItem applies before
// reaching it: paused campaign, failed/blocked lifecycle, campaign_system
// blockerKind. Anything the probe refuses yields no hint, so the operator never
// sees a `forge campaign retry` pointer for a retry that would refuse — including
// the round-2 shape where transient run evidence and real ship evidence coexist:
// the probe checks evaluateCampaignSystemShipEligibility first and refuses,
// naming reconcile. Un-memoized, matching campaignSystemLaneEvidenceHint.
function campaignSystemRetryHint(campaign: Campaign, item: CampaignItem): string | null {
  if (campaign.status !== "paused") return null;
  if (item.blockerKind !== "campaign_system") return null;
  if (!(item.lifecycleStatus === "failed" && item.outcome === "blocked")) return null;
  return probeCampaignSystemRetryEvidence(campaign, item).ok
    ? formatCampaignSystemRetryHint(campaign.id, item.ticketId)
    : null;
}

// FG-444 fix: outOfBandCompletableAction shells out to git (via
// collectOutOfBandEvidence/hasUnresolvedAuthoritativeOutcome) — memoize per
// ticketId so a single assemble call evaluates each item at most once, even
// though both the Next-action computation and the per-item row need it.
function memoizeOutOfBandCompletableAction(): (campaign: Campaign, item: CampaignItem) => string | null {
  const cache = new Map<string, string | null>();
  return (campaign: Campaign, item: CampaignItem) => {
    if (!cache.has(item.ticketId)) {
      cache.set(item.ticketId, outOfBandCompletableAction(campaign, item));
    }
    return cache.get(item.ticketId) ?? null;
  };
}

// FG-502: combines the two campaign_system hints into the single action string
// slotted in place of blockedItemGuidance's generic text — same two-step shape
// (`outOfBand ?? reconcileHint ?? requestedHumanAction`) the awaiting_gate
// gateParkedItem branch below already uses. Returns null when neither hint
// applies, so callers fall through to the plain blockedItemGuidance text.
// FG-511: precedence, most authoritative evidence first — ship-eligible => point at
// reconcile; else transient run evidence => point at retry; else fall through to the
// generic inspect/re-plan/abandon text. Delivered work is completed from its own
// evidence, never re-dispatched, so the retry hint comes LAST. The ordering here is
// belt-and-braces: campaignSystemRetryHint's probe independently refuses a
// ship-eligible item, so the per-item campaignSystemRetryEligible flag agrees with
// this top-level next-action even though it is computed separately.
function campaignSystemRecoverableAction(
  campaign: Campaign,
  item: CampaignItem,
  getCampaignSystemCompletableHint: (campaign: Campaign, item: CampaignItem) => string | null
): string | null {
  const eligible = getCampaignSystemCompletableHint(campaign, item);
  if (eligible) return eligible;
  const laneHint = campaignSystemLaneEvidenceHint(campaign, item);
  if (laneHint) return `run \`forge campaign reconcile\` to capture host verification for ${item.ticketId} and complete it`;
  return campaignSystemRetryHint(campaign, item);
}

// FG-521: the ONE derivation of the done-audit-gap next-action for a complete
// campaign. `campaign show` used to return "complete — none" unconditionally
// while `campaign report` consulted the doneAuditMap — two parallel machines
// over the same data, so a completed campaign with unresolved gaps contradicted
// itself across the two surfaces. Both now project this; neither re-filters.
// Returns null when no shipped item has an unresolved audit gap.
function doneAuditGapAction(items: CampaignItem[], doneAuditMap: Map<string, DoneAuditResult>): string | null {
  const unauditedShipped = items.filter(
    (i) => i.outcome === "shipped" && doneAuditMap.get(i.ticketId)?.outcome !== "pass"
  );
  if (unauditedShipped.length === 0) return null;
  const actions = unauditedShipped
    .map((i) => doneAuditMap.get(i.ticketId)?.requestedAction ?? `re-audit ${i.ticketId}`)
    .join("; ");
  return `shipped items have unresolved done-audit gaps — ${actions}`;
}

// FG-521: the done-audit map both assemble paths derive their gap answer from.
// Best-effort per item, exactly as assembleCampaignReport built it inline before;
// tests may inject an override. Each assemble call builds it at most once (the
// same one-evaluation-per-assemble discipline as memoizeOutOfBandCompletableAction),
// and collectDoneAuditInput shells out to git per item — so assembleCampaignShow
// only builds it for the one status whose next-action consults it (complete).
function buildDoneAuditMap(campaign: Campaign, items: CampaignItem[]): Map<string, DoneAuditResult> {
  if (_testDoneAuditMapOverride !== null) return _testDoneAuditMapOverride;
  const map = new Map<string, DoneAuditResult>();
  if (campaign.projectDir && existsSync(campaign.projectDir)) {
    for (const item of items) {
      try {
        map.set(item.ticketId, evaluateDoneAudit(collectDoneAuditInput(campaign.projectDir, item)));
      } catch {
        // leave entry absent (→ doneAuditState: null for this item)
      }
    }
  }
  return map;
}

function computeNextShowAction(
  campaign: Campaign,
  items: CampaignItem[],
  doneAuditMap: Map<string, DoneAuditResult>,
  getOutOfBandCompletableAction: (campaign: Campaign, item: CampaignItem) => string | null,
  getCampaignSystemCompletableHint: (campaign: Campaign, item: CampaignItem) => string | null
): string {
  if (campaign.status === "running") {
    const inf = findInFlightItem(items);
    if (inf && inf.lifecycleStatus !== "running") return recoveryNeededAction(campaign.id, inf);
    return "running";
  }
  if (campaign.status === "complete") return doneAuditGapAction(items, doneAuditMap) ?? "complete — none";
  if (campaign.status === "failed") return "failed — investigate";
  if (campaign.status === "abandoned") return "abandoned — none";

  const intent = campaign.status === "planned" ? "start" : "resume";
  const blocker = campaignBlocker(campaign, items, intent);
  if (blocker === null) {
    if (intent === "start") return "start";
    const blockedItem = unresolvedBlockedItem(items);
    if (blockedItem) {
      if (blockedItem.blockerKind === "campaign_system") {
        const campaignSystemAction = campaignSystemRecoverableAction(campaign, blockedItem, getCampaignSystemCompletableHint);
        if (campaignSystemAction) return campaignSystemAction;
      }
      return blockedItemGuidance(campaign.id, blockedItem);
    }
    const gateParkedItem = items.find((i) => i.lifecycleStatus === "awaiting_gate" || i.lifecycleStatus === "blocked_by_red");
    if (gateParkedItem) {
      // FG-502: a blocked_by_red item can ALSO be the campaign_system shape (e.g.
      // driveWorkflowItem's inconclusive-verdict park) — route it through the
      // same campaign_system hint the failed-shape branch above uses,
      // same as unresolvedBlockedItem's campaign_system check, before falling
      // through to the awaiting_gate-shaped out-of-band checks below.
      if (gateParkedItem.blockerKind === "campaign_system") {
        const campaignSystemAction = campaignSystemRecoverableAction(campaign, gateParkedItem, getCampaignSystemCompletableHint);
        if (campaignSystemAction) return campaignSystemAction;
      }
      const outOfBand = getOutOfBandCompletableAction(campaign, gateParkedItem);
      if (outOfBand) return outOfBand;
      const reconcileHint = outOfBandHostVerificationHint(campaign, gateParkedItem);
      if (reconcileHint) return `run \`forge campaign reconcile\` to capture host verification for ${gateParkedItem.ticketId} and complete it`;
      if (gateParkedItem.requestedHumanAction) return gateParkedItem.requestedHumanAction;
    }
    const readinessHeld = items.find((i) => i.outcome === "held" && i.blockerKind === "readiness");
    if (readinessHeld) return `refine ${readinessHeld.ticketId} then resume`;
    return "resume";
  }
  if (blocker === "recovery_needed") return recoveryNeededAction(campaign.id, findInFlightItem(items)!);
  if (blocker === "not_approved") return "approve";
  if (blocker === "dry_run_not_executable") return "dry_run: re-plan with --mode pilot or --mode sequential to execute";
  if (blocker === "stale_plan") return "stale: re-plan";
  if (blocker === "plan_unresolvable") return "plan can no longer be resolved (a source ticket may have been deleted) — re-plan with forge campaign plan";
  if (blocker === "no_project_dir") return "campaign has no stored project directory — re-plan";
  if (blocker === "invalid_project_dir") return "project directory missing or has no backlog — fix the path / re-plan";
  if (blocker === "not_planned") return `cannot start: campaign is ${campaign.status}`;
  if (blocker === "not_paused") return `cannot resume: campaign is ${campaign.status}`;
  return `blocked: ${blocker} — resolve before ${intent}`;
}

export type SafetyToContinue =
  | "can_resume"
  | "can_start"
  | "terminal"
  | "running"
  | "needs_approval"
  | "stale"
  | "recovery_needed"
  | "dry_run_not_executable"
  | "needs_resolution";

export type CampaignVerdict = "all_shipped" | "complete_with_issues" | "not_complete";

function computeSafety(campaign: Campaign, items: CampaignItem[]): SafetyToContinue {
  if (campaign.status === "running") {
    const inf = findInFlightItem(items);
    if (inf && inf.lifecycleStatus !== "running") return "recovery_needed";
    return "running";
  }
  if (campaign.status === "complete" || campaign.status === "failed" || campaign.status === "abandoned") {
    return "terminal";
  }

  const intent = campaign.status === "planned" ? "start" : "resume";
  const blocker = campaignBlocker(campaign, items, intent);
  if (blocker === "recovery_needed") return "recovery_needed";
  if (blocker === "not_approved") return "needs_approval";
  if (blocker === "dry_run_not_executable") return "dry_run_not_executable";
  if (blocker === "stale_plan") return "stale";
  if (blocker === "plan_unresolvable") return "stale";
  if (blocker === null) {
    if (intent === "start") return "can_start";
    return (unresolvedBlockedItem(items) || unrefinedReadinessItem(items)) ? "needs_resolution" : "can_resume";
  }
  // not_planned / not_paused / no_project_dir / invalid_project_dir: treat as non-continuable
  return "terminal";
}

function computeVerdict(campaign: Campaign, items: CampaignItem[], doneAuditMap: Map<string, DoneAuditResult>): CampaignVerdict {
  if (campaign.status !== "complete") return "not_complete";
  const allShipped = items.length > 0 && items.every((i) => i.outcome === "shipped");
  if (!allShipped) return "complete_with_issues";
  // All items shipped — require every done-audit to be pass
  const allAuditPass = items.every((i) => doneAuditMap.get(i.ticketId)?.outcome === "pass");
  if (!allAuditPass) return "complete_with_issues";
  return "all_shipped";
}

function computeNextOperatorAction(
  campaign: Campaign,
  verdict: CampaignVerdict,
  items: CampaignItem[],
  doneAuditMap: Map<string, DoneAuditResult>,
  getOutOfBandCompletableAction: (campaign: Campaign, item: CampaignItem) => string | null,
  getCampaignSystemCompletableHint: (campaign: Campaign, item: CampaignItem) => string | null
): string {
  if (campaign.status === "running") {
    const inf = findInFlightItem(items);
    if (inf && inf.lifecycleStatus !== "running") return recoveryNeededAction(campaign.id, inf);
    return "campaign is running — monitor progress";
  }
  if (campaign.status === "complete") {
    if (verdict === "all_shipped") return "none — campaign complete (all items shipped)";
    // FG-521: shared with computeNextShowAction — see doneAuditGapAction.
    const gapAction = doneAuditGapAction(items, doneAuditMap);
    if (gapAction) return gapAction;
    return "review blocked/failed/skipped items";
  }
  if (campaign.status === "failed") return "investigate failure and re-plan or abandon";
  if (campaign.status === "abandoned") return "none — campaign abandoned";

  const intent = campaign.status === "planned" ? "start" : "resume";
  const blocker = campaignBlocker(campaign, items, intent);
  if (blocker === null) {
    if (intent === "start") return "start the campaign";
    // Paused with unresolved blocked item: surface it to guide the operator.
    const blockedItem = unresolvedBlockedItem(items);
    if (blockedItem) {
      if (blockedItem.blockerKind === "campaign_system") {
        const campaignSystemAction = campaignSystemRecoverableAction(campaign, blockedItem, getCampaignSystemCompletableHint);
        if (campaignSystemAction) return campaignSystemAction;
      }
      return blockedItemGuidance(campaign.id, blockedItem);
    }
    // Parked at a human gate or red block: surface the specific gate/block action.
    const gateParkedItem = items.find((i) => i.lifecycleStatus === "awaiting_gate" || i.lifecycleStatus === "blocked_by_red");
    if (gateParkedItem) {
      // FG-502: same campaign_system routing as computeNextShowAction above — a
      // blocked_by_red item can be the campaign_system shape too.
      if (gateParkedItem.blockerKind === "campaign_system") {
        const campaignSystemAction = campaignSystemRecoverableAction(campaign, gateParkedItem, getCampaignSystemCompletableHint);
        if (campaignSystemAction) return campaignSystemAction;
      }
      const outOfBand = getOutOfBandCompletableAction(campaign, gateParkedItem);
      if (outOfBand) return outOfBand;
      const reconcileHint = outOfBandHostVerificationHint(campaign, gateParkedItem);
      if (reconcileHint) return `run \`forge campaign reconcile\` to capture host verification for ${gateParkedItem.ticketId} and complete it`;
      if (gateParkedItem.requestedHumanAction) return gateParkedItem.requestedHumanAction;
    }
    // Blockers resolved but held items remain: resume will reconsider them.
    const heldItems = items.filter((i) => i.outcome === "held");
    if (heldItems.length > 0) {
      const readinessHeld = heldItems.find((i) => i.blockerKind === "readiness");
      if (readinessHeld) return `refine ${readinessHeld.ticketId} then resume`;
      return `resume — ${heldItems.length} held item${heldItems.length === 1 ? "" : "s"} will be reconsidered`;
    }
    return "resume the campaign when ready";
  }
  if (blocker === "recovery_needed") return recoveryNeededAction(campaign.id, findInFlightItem(items)!);
  if (blocker === "not_approved") return "approve the campaign, then start";
  if (blocker === "dry_run_not_executable") return "dry_run: re-plan with --mode pilot or --mode sequential to execute";
  if (blocker === "stale_plan") return "stale: re-plan and re-approve";
  if (blocker === "plan_unresolvable") return "plan can no longer be resolved (a source ticket may have been deleted) — re-plan with forge campaign plan";
  if (blocker === "no_project_dir") return "campaign has no stored project directory — re-plan";
  if (blocker === "invalid_project_dir") return "project directory missing or has no backlog — fix the path / re-plan";
  if (blocker === "not_planned") return `cannot start: campaign is ${campaign.status}`;
  if (blocker === "not_paused") return `cannot resume: campaign is ${campaign.status}`;
  return `blocked: ${blocker} — resolve before ${intent}`;
}

export type ShowItemRow = {
  ticketId: string;
  title: string | null;
  lifecycleStatus: string;
  outcome: string | null;
  blockerKind: string | null;
  continuePolicy: string | null;
  runId: string | null;
  reason: string | null;
  requestedHumanAction: string | null;
  readiness: ReadinessResult | null;
  hostVerificationReconcileHint: string | null;
  // FG-444: per-item out-of-band completion eligibility (the same evaluator the
  // Next action line uses for the first parked item, applied to EVERY item).
  outOfBandEligible: boolean;
  // FG-502: per-item campaign_system recovery eligibility — a failed item whose
  // blockerKind is 'campaign_system' that turns out to be delivered out-of-band,
  // using the same evidence bar as outOfBandEligible above.
  campaignSystemEligible: boolean;
  // FG-511: per-item campaign_system RETRY eligibility — the disjoint case:
  // the item never shipped, and its run's durable task evidence proves the
  // failure was transient, so `forge campaign retry` (not reconcile) recovers it.
  campaignSystemRetryEligible: boolean;
  // FG-442: policy-derived execution lane, per item.
  lane: string;
  laneRationale: string;
  materialLaneAssumptions: string[];
};

export type ShowResult = {
  campaignId: string;
  status: string;
  mode: string;
  approvedPlanHash: string | null;
  currentPlanHash: string | null;
  planStale: boolean | null;
  projectDir: string | null;
  activeItem: { ticketId: string; runId: string } | null;
  items: ShowItemRow[];
  nextAction: string;
};

export function assembleCampaignShow(id: string): ShowResult | null {
  const campaign = getCampaign(id);
  if (!campaign) return null;

  const items = listCampaignItems(id);
  const currentPlanHash = computeCurrentPlanHash(campaign);

  const planStale =
    campaign.approvedPlanHash && currentPlanHash
      ? currentPlanHash !== campaign.approvedPlanHash
      : null;

  // Build title + readiness map (best-effort)
  const titleMap = new Map<string, string>();
  const readinessMap = new Map<string, ReadinessResult>();
  if (campaign.projectDir && existsSync(campaign.projectDir)) {
    try {
      const tickets = listTickets(campaign.projectDir);
      for (const t of tickets) {
        titleMap.set(t.id, t.title);
        try {
          readinessMap.set(t.id, evaluateReadiness(t));
        } catch {
          // ignore per-ticket errors
        }
      }
    } catch {
      // ignore
    }
  }

  const activeItem = items.find((i) => i.lifecycleStatus === "running") ?? null;

  const planContentForShow = campaign.metadata?.["planContent"] as Record<string, unknown> | undefined;

  const getOutOfBandCompletableAction = memoizeOutOfBandCompletableAction();
  const getCampaignSystemCompletableHint = memoizeCampaignSystemCompletableHint();

  const itemRows: ShowItemRow[] = items.map((i) => {
    const planEntry = getItemPlanEntry(planContentForShow, i.ticketId);
    return {
      ticketId: i.ticketId,
      title: titleMap.get(i.ticketId) ?? null,
      lifecycleStatus: i.lifecycleStatus,
      outcome: i.outcome ?? null,
      blockerKind: i.blockerKind ?? null,
      continuePolicy: i.continuePolicy ?? null,
      runId: i.runId ?? null,
      reason: i.reason ?? null,
      requestedHumanAction: i.requestedHumanAction ?? null,
      readiness: readinessMap.get(i.ticketId) ?? null,
      hostVerificationReconcileHint:
        scopeBlockedHostVerificationHint(campaign, i) ??
        outOfBandHostVerificationHint(campaign, i) ??
        campaignSystemLaneEvidenceHint(campaign, i),
      outOfBandEligible: getOutOfBandCompletableAction(campaign, i) !== null,
      campaignSystemEligible: getCampaignSystemCompletableHint(campaign, i) !== null,
      campaignSystemRetryEligible: campaignSystemRetryHint(campaign, i) !== null,
      lane: planEntry.lane,
      laneRationale: planEntry.laneRationale,
      materialLaneAssumptions: planEntry.materialLaneAssumptions,
    };
  });

  // FG-521: show's complete-campaign next-action is a projection of report's
  // done-audit-gap derivation, so the two surfaces can never contradict each
  // other. Only a complete campaign's next-action consults the map, and
  // building it shells out to git per item (collectDoneAuditInput) — so don't
  // pay that cost on every `campaign show` of a running/paused campaign.
  const doneAuditMap =
    campaign.status === "complete"
      ? buildDoneAuditMap(campaign, items)
      : new Map<string, DoneAuditResult>();

  const nextAction = computeNextShowAction(campaign, items, doneAuditMap, getOutOfBandCompletableAction, getCampaignSystemCompletableHint);

  return {
    campaignId: campaign.id,
    status: campaign.status,
    mode: campaign.mode,
    approvedPlanHash: campaign.approvedPlanHash ?? null,
    currentPlanHash,
    planStale,
    projectDir: campaign.projectDir ?? null,
    activeItem: activeItem
      ? { ticketId: activeItem.ticketId, runId: activeItem.runId ?? "" }
      : null,
    items: itemRows,
    nextAction,
  };
}

export type TaskSummary = {
  phase: string;
  agentRole: string;
  status: string;
};

export type VerdictSummary = {
  taskId: string;
  phase: string;
  verdict: string;
  authority: string;
  findingsCount: number;
};

export type ReportItemRow = ShowItemRow & {
  branch: string | null;
  worktreePath: string | null;
  prUrl: null;
  commit: string | null;
  verificationState: null;
  doneAuditState: DoneAuditResult | null;
  hostVerificationDetail: string | null;
  reviewerResult: null;
  // Workflow execution traceability (FG-423)
  executionMode: string;
  workflowName: string | null;
  agentRole: string | null;
  taskSummaries: TaskSummary[];
  verdictSummaries: VerdictSummary[];
};

export type ReportGroupings = {
  shipped: string[];
  blocked: string[];
  held: string[];
  skipped: string[];
  failed: string[];
};

export type ReportResult = {
  campaignId: string;
  sourceInput: Record<string, unknown>;
  goal: string | null;
  mode: string;
  status: string;
  approvedPlanHash: string | null;
  currentPlanHash: string | null;
  safetyToContinue: SafetyToContinue;
  verdict: CampaignVerdict;
  items: ReportItemRow[];
  groupings: ReportGroupings;
  dirtyGitState: string | null;
  deferredScope: unknown[];
  followUpTickets: unknown[];
  nextOperatorAction: string;
};

export function assembleCampaignReport(id: string): ReportResult | null {
  const campaign = getCampaign(id);
  if (!campaign) return null;

  const items = listCampaignItems(id);
  const currentPlanHash = computeCurrentPlanHash(campaign);

  // Build title + commit + readiness map (best-effort)
  const titleMap = new Map<string, string>();
  const commitMap = new Map<string, string>();
  const readinessMap = new Map<string, ReadinessResult>();
  if (campaign.projectDir && existsSync(campaign.projectDir)) {
    try {
      const tickets = listTickets(campaign.projectDir);
      for (const t of tickets) {
        titleMap.set(t.id, t.title);
        if (t.closedCommit) commitMap.set(t.id, t.closedCommit);
        try {
          readinessMap.set(t.id, evaluateReadiness(t));
        } catch {
          // ignore per-ticket errors
        }
      }
    } catch {
      // ignore
    }
    // Also try readTicket for items with outcome=shipped that might be in done/
    for (const item of items) {
      if (item.outcome === "shipped" && !commitMap.has(item.ticketId)) {
        try {
          const t = readTicket(campaign.projectDir, item.ticketId);
          if (t.closedCommit) commitMap.set(t.id, t.closedCommit);
          if (t.title) titleMap.set(t.id, t.title);
        } catch {
          // ignore
        }
      }
    }
  }

  // Build done-audit map (best-effort, per item). Tests may inject an override map.
  const doneAuditMap = buildDoneAuditMap(campaign, items);

  const safetyToContinue = computeSafety(campaign, items);
  const verdict = computeVerdict(campaign, items, doneAuditMap);
  const getOutOfBandCompletableAction = memoizeOutOfBandCompletableAction();
  const getCampaignSystemCompletableHint = memoizeCampaignSystemCompletableHint();
  const nextOperatorAction = computeNextOperatorAction(
    campaign,
    verdict,
    items,
    doneAuditMap,
    getOutOfBandCompletableAction,
    getCampaignSystemCompletableHint
  );

  const goal =
    campaign.metadata?.["goal"] !== undefined
      ? String(campaign.metadata["goal"])
      : null;

  const planContent = campaign.metadata?.["planContent"] as Record<string, unknown> | undefined;

  const itemRows: ReportItemRow[] = items.map((i) => {
    const planEntry = getItemPlanEntry(planContent, i.ticketId);
    // FG-442: label is driven by the item's underlying dispatch mechanism
    // (executionMode), which planner.ts derives from the lane — 'invoke' labels
    // as "invoke (escape hatch)" whether it's the pre-FG-442 manual override or
    // one of the docs_only/test_only/review_only/research_only lanes (same
    // underlying mechanism: a single opts.dispatch invoke to a stored role).
    const executionMode =
      planEntry.executionMode === "invoke"
        ? "invoke (escape hatch)"
        : planEntry.executionMode === "invoke_chain"
          ? "invoke chain (engineer -> test-engineer)"
          : planEntry.executionMode === "none"
            ? "no dispatch"
            : "workflow";
    const agentRole = planEntry.executionMode === "invoke" ? (planEntry.agentRole ?? null) : null;

    let workflowName: string | null = planEntry.executionMode === "workflow" ? (planEntry.workflowName ?? "feature") : null;
    let taskSummaries: TaskSummary[] = [];
    let verdictSummaries: VerdictSummary[] = [];

    if (i.runId) {
      // workflowName from run record is authoritative over canonicalContent
      try {
        const run = getRun(i.runId);
        if (run && planEntry.executionMode === "workflow") {
          workflowName = run.workflow;
        }
      } catch {
        // best-effort — log omit, leave workflowName from canonicalContent
      }

      // Task and verdict summaries — follow best-effort pattern from doneAuditState
      try {
        const tasks = tasksForRun(i.runId);
        taskSummaries = tasks.map((t) => ({ phase: t.phase, agentRole: t.agentRole, status: t.status }));

        const taskPhaseMap = new Map(tasks.map((t) => [t.id, t.phase]));
        const verdicts = verdictsForRun(i.runId);
        verdictSummaries = verdicts.map((v) => ({
          taskId: v.taskId,
          phase: taskPhaseMap.get(v.taskId) ?? "",
          verdict: v.verdict,
          authority: v.authority,
          findingsCount: v.findings.length,
        }));
      } catch {
        // best-effort — leave summaries empty if run record not yet present
      }
    }

    return {
      ticketId: i.ticketId,
      title: titleMap.get(i.ticketId) ?? null,
      lifecycleStatus: i.lifecycleStatus,
      outcome: i.outcome ?? null,
      blockerKind: i.blockerKind ?? null,
      continuePolicy: i.continuePolicy ?? null,
      runId: i.runId ?? null,
      reason: i.reason ?? null,
      requestedHumanAction: i.requestedHumanAction ?? null,
      readiness: readinessMap.get(i.ticketId) ?? null,
      branch: i.branch ?? null,
      worktreePath: i.worktreePath ?? null,
      prUrl: null,
      commit: commitMap.get(i.ticketId) ?? null,
      verificationState: null,
      doneAuditState: doneAuditMap.get(i.ticketId) ?? null,
      hostVerificationDetail:
        doneAuditMap.get(i.ticketId)?.checks.find((c) => c.name === "host_verification")?.detail ?? null,
      hostVerificationReconcileHint:
        scopeBlockedHostVerificationHint(campaign, i) ??
        outOfBandHostVerificationHint(campaign, i) ??
        campaignSystemLaneEvidenceHint(campaign, i),
      outOfBandEligible: getOutOfBandCompletableAction(campaign, i) !== null,
      campaignSystemEligible: getCampaignSystemCompletableHint(campaign, i) !== null,
      campaignSystemRetryEligible: campaignSystemRetryHint(campaign, i) !== null,
      reviewerResult: null,
      lane: planEntry.lane,
      laneRationale: planEntry.laneRationale,
      materialLaneAssumptions: planEntry.materialLaneAssumptions,
      executionMode,
      workflowName,
      agentRole,
      taskSummaries,
      verdictSummaries,
    };
  });

  const groupings: ReportGroupings = {
    shipped: items.filter((i) => i.outcome === "shipped").map((i) => i.ticketId),
    blocked: items.filter((i) => i.outcome === "blocked").map((i) => i.ticketId),
    held: items.filter((i) => i.outcome === "held").map((i) => i.ticketId),
    skipped: items.filter((i) => i.outcome === "skipped").map((i) => i.ticketId),
    failed: items.filter((i) => i.outcome === "failed" || i.outcome === "needs_refinement").map((i) => i.ticketId),
  };

  const dirtyGitState =
    campaign.projectDir && existsSync(campaign.projectDir)
      ? computeDirtyGitState(campaign.projectDir)
      : null;

  return {
    campaignId: campaign.id,
    sourceInput: campaign.sourceInput,
    goal,
    mode: campaign.mode,
    status: campaign.status,
    approvedPlanHash: campaign.approvedPlanHash ?? null,
    currentPlanHash,
    safetyToContinue,
    verdict,
    items: itemRows,
    groupings,
    dirtyGitState,
    deferredScope: [],
    followUpTickets: [],
    nextOperatorAction,
  };
}

export function renderCampaignReportHuman(result: ReportResult): string[] {
  const lines: string[] = [];
  lines.push(`Campaign Report: ${result.campaignId}`);
  lines.push(`Status:          ${result.status}`);
  lines.push(`Mode:            ${result.mode}`);
  if (result.goal) lines.push(`Goal:            ${result.goal}`);
  lines.push(`Verdict:         ${result.verdict}`);
  lines.push(`Safety:          ${result.safetyToContinue}`);
  lines.push(`Approved hash:   ${result.approvedPlanHash ?? "(none)"}`);
  if (result.currentPlanHash) lines.push(`Current hash:    ${result.currentPlanHash}`);
  if (result.dirtyGitState) lines.push(`Dirty git state:\n${result.dirtyGitState}`);
  lines.push("Items:");
  for (const item of result.items) {
    const titleStr = item.title ? ` — ${item.title}` : "";
    const outcomeStr = item.outcome ? ` outcome=${item.outcome}` : "";
    const commitStr = item.commit ? ` commit=${item.commit}` : "";
    const branchStr = item.branch ? ` branch=${item.branch}` : "";
    const worktreeStr = item.worktreePath ? ` worktree=${item.worktreePath}` : "";
    const blockerStr = item.blockerKind ? ` blocker=${item.blockerKind}` : "";
    const runStr = item.runId ? ` [run: ${item.runId}]` : "";
    lines.push(`  ${item.ticketId}${titleStr}: ${item.lifecycleStatus}${outcomeStr}${commitStr}${branchStr}${worktreeStr}${blockerStr}${runStr}`);
    lines.push(`    lane: ${item.lane} — ${item.laneRationale}`);
    if (item.materialLaneAssumptions.length > 0) {
      lines.push(`    lane-assumptions: ${item.materialLaneAssumptions.join("; ")}`);
    }
    if (item.blockerKind === "lane_escalation") {
      // FG-442: an escalation reads distinctly from a scope block — it invalidated
      // the approved plan basis, not just this one item.
      lines.push(`    LANE ESCALATION: item outgrew its approved lane — the whole campaign is paused pending re-approval of a new plan basis`);
    }
    if (item.reason) lines.push(`    reason: ${item.reason}`);
    if (item.requestedHumanAction) lines.push(`    action: ${item.requestedHumanAction}`);
    if (item.readiness && (item.readiness.outcome === "needs_refinement" || item.readiness.outcome === "blocked" || (item.outcome === "held" && item.blockerKind === "readiness"))) {
      lines.push(`    readiness: ${item.readiness.outcome}`);
      if (item.readiness.gaps.length > 0) lines.push(`    gaps: ${item.readiness.gaps.join("; ")}`);
      if (item.readiness.refinementProposal) lines.push(`    refinement: ${item.readiness.refinementProposal}`);
    }
    if (item.doneAuditState) {
      lines.push(`    done-audit: ${item.doneAuditState.outcome}`);
      if (item.hostVerificationDetail) lines.push(`    host-verification: ${item.hostVerificationDetail}`);
      if (item.doneAuditState.outcome !== "pass") {
        if (item.doneAuditState.gaps.length > 0) lines.push(`    audit-gaps: ${item.doneAuditState.gaps.join("; ")}`);
        if (item.doneAuditState.requestedAction) lines.push(`    audit-action: ${item.doneAuditState.requestedAction}`);
      }
    }
    if (item.hostVerificationReconcileHint) lines.push(`    host-verification-status: ${item.hostVerificationReconcileHint}`);
    if (item.outOfBandEligible) lines.push(`    out-of-band-eligible: ${formatOutOfBandEligibleHint(item.ticketId)}`);
    if (item.campaignSystemEligible) lines.push(`    campaign-system-recoverable: ${formatOutOfBandEligibleHint(item.ticketId)}`);
    if (item.campaignSystemRetryEligible) lines.push(`    campaign-system-retryable: ${formatCampaignSystemRetryHint(result.campaignId, item.ticketId)}`);
    // Execution mode and workflow traceability — the mechanism underlying the lane.
    if (item.executionMode === "invoke (escape hatch)") {
      lines.push(`    execution: invoke (escape hatch)${item.agentRole ? ` [role=${item.agentRole}]` : ""}`);
    } else if (item.executionMode === "invoke chain (engineer -> test-engineer)" || item.executionMode === "no dispatch") {
      lines.push(`    execution: ${item.executionMode}`);
    } else {
      const wfLabel = item.workflowName ? ` [workflow=${item.workflowName}]` : "";
      lines.push(`    execution: workflow${wfLabel}`);
    }
    if (item.taskSummaries.length > 0) {
      const taskStr = item.taskSummaries.map((t) => `${t.phase}(${t.status})`).join(", ");
      lines.push(`    tasks: ${taskStr}`);
    }
    if (item.verdictSummaries.length > 0) {
      const vStr = item.verdictSummaries
        .map((v) => `${v.verdict}/${v.authority}${v.findingsCount > 0 ? ` (${v.findingsCount} finding${v.findingsCount === 1 ? "" : "s"})` : ""}`)
        .join(", ");
      lines.push(`    verdicts: ${vStr}`);
    }
  }
  lines.push("Groupings:");
  lines.push(`  shipped: ${result.groupings.shipped.join(", ") || "(none)"}`);
  lines.push(`  blocked: ${result.groupings.blocked.join(", ") || "(none)"}`);
  lines.push(`  held:    ${result.groupings.held.join(", ") || "(none)"}`);
  lines.push(`  skipped: ${result.groupings.skipped.join(", ") || "(none)"}`);
  lines.push(`  failed:  ${result.groupings.failed.join(", ") || "(none)"}`);
  lines.push(`Next operator action: ${result.nextOperatorAction}`);
  return lines;
}
