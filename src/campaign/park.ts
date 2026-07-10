// FG-516 — the parking capability, isolated. This module is the ONLY campaign-side
// place that imports the running→paused CAS (tryTransitionCampaign for that pair),
// so the "notify without a committed pause" wedge class is unrepresentable from
// executor.ts BY CONSTRUCTION: executor never sees the raw CAS, only parkCampaign.
// completeCampaign / resumeCampaignToRunning are the two non-park lifecycle
// transitions executor still needs, wrapped here so executor can drop the raw
// tryTransitionCampaign import entirely.
import { getCampaignItem, listCampaignItems, tryTransitionCampaign, updateCampaignItem } from "../store/campaigns.js";
import { getRun } from "../store/runs.js";
import { emitMilestone } from "../notify/milestone.js";
import type { MilestoneKind } from "../notify/milestone.js";
import type { BlockerKind } from "../types/index.js";

// FG-516: the milestone emitter notifyCampaignPause routes through. Injectable
// (mirrors the done-audit override in executor) ONLY so a test can prove that an
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
// held from the start) — that residual case needs a campaign-scoped emission path
// (new notify machinery: emitMilestone hard-requires a real run), NOT a schema
// change: events.run_id is already nullable. Deferred to FG-517.
export function pickCampaignFallbackRunId(campaignId: string): string | undefined {
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

// FG-516 (structural close of the park-payload class) — a park's blocker/action
// context is REQUIRED and type-checked at the call site: a parkCampaign call that
// supplies no composed context does not COMPILE. This closes the "pushed body
// lacks the `blocker: <kind>` field" class the two invoke-lane findings hit, the
// same way module isolation closed the "notify without a committed pause" class —
// by construction, not by scanning call shapes.
export type ParkContext =
  // The caller hands parkCampaign fresh context. parkCampaign renders
  // `blocker: <blockerKind>` in the pushed body and persists requestedHumanAction
  // onto the item if it lacks one, so notifyCampaignPause's item-reading body
  // composition works. It deliberately does NOT persist blockerKind onto the item:
  // an awaiting_gate item with NO blockerKind is the out-of-band reconcile marker
  // (reconcile.ts isOutOfBand / report.ts / FG-483's parked-item assertion all key
  // off that absence), so the kind feeds the body label only, never the row.
  | { blockerKind: BlockerKind; requestedHumanAction: string }
  // The item row ALREADY carries what notifyCampaignPause needs — a persisted
  // blockerKind (or an opts.bodyBlockerKind body-only label) plus a
  // requestedHumanAction — so the body composes from the item exactly as today.
  | { exemption: "item-carries-context" }
  // A documented deferral where composing real context is out of scope. ONLY the
  // FG-518 resume-probe workflow-load-failure park uses this.
  | { exemption: "known-gap"; ticket: `FG-${number}` };

// FG-516 (finding B) — THE park boundary. Every running→paused park goes through
// here: it performs the CAS transition itself and notifies ONLY when the CAS
// committed, then returns the CAS result so call sites keep their existing control
// flow. This makes the "notify without a committed pause" wedge class
// unrepresentable — a concurrent operator `forge campaign pause` (the documented
// manual-pause exemption) that wins the CAS first leaves committed=false, so this
// stale driver pushes nothing. The notify is awaited and never throws (see
// notifyCampaignPause), so a throw-park helper can await it before rethrowing and
// know the milestone is settled before control returns to the CLI. Because this is
// the ONLY module importing tryTransitionCampaign for the running→paused pair,
// executor.ts cannot spell that CAS at all — the guard test now enforces that by
// construction, not by scanning call shapes.
//
// `itemId` accepts an array for the campaign-level held-items pause: one CAS,
// then a milestone per held item (each de-duped independently by its own key).
export async function parkCampaign(
  campaignId: string,
  itemId: string | string[],
  kind: MilestoneKind,
  context: ParkContext,
  opts?: { fallbackRunId?: string; bodyBlockerKind?: string },
): Promise<boolean> {
  const committed = tryTransitionCampaign(campaignId, "running", "paused");
  if (committed) {
    // The composed arm feeds its kind to the BODY label and persists its action
    // if the item has none — never persisting blockerKind (see ParkContext).
    const composed = "blockerKind" in context ? context : undefined;
    for (const id of Array.isArray(itemId) ? itemId : [itemId]) {
      let bodyBlockerKind = opts?.bodyBlockerKind;
      if (composed) {
        const item = getCampaignItem(id);
        if (item && !item.requestedHumanAction) {
          updateCampaignItem(id, { requestedHumanAction: composed.requestedHumanAction });
        }
        bodyBlockerKind = composed.blockerKind;
      }
      await notifyCampaignPause(campaignId, id, kind, opts?.fallbackRunId, bodyBlockerKind);
    }
  }
  return committed;
}

// The running→complete campaign transition. Not a park (no notify), but wrapped
// here so executor.ts never imports tryTransitionCampaign. Same return semantics as
// the raw CAS.
export function completeCampaign(campaignId: string): boolean {
  return tryTransitionCampaign(campaignId, "running", "complete");
}

// The paused→running resume transition (the REVERSE of a park — a legitimate,
// operator-driven direction). Wrapped here for the same construction reason:
// executor.ts must not spell tryTransitionCampaign at all. Same return semantics.
export function resumeCampaignToRunning(campaignId: string): boolean {
  return tryTransitionCampaign(campaignId, "paused", "running");
}
