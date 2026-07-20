// FG-564 (Slice 5b, AC5/AC6/AC-ADOPT-DRIVE): the CAMPAIGN adapter over the shared
// consumer-core. It injects the campaign PhysicalDispatch + the campaign recover filter
// into the ONE shared engine (extract, not copy — the orchestrator adapter is
// continuation-consumer.ts).
//
// TWO DISTINCT DURABLE IDENTITY SPACES — never conflated:
//   1. The FG-562 continuation dispatch RECEIPT authorizes exactly one item-boundary
//      advance (N -> N+1 or finalization). The campaign side NEVER uses that receipt with
//      runByDispatchKey as a second parallel authority to find or create the item-run.
//   2. The FG-596 item-attempt dispatch KEY (deriveCampaignItemDispatchKey) identifies
//      exactly one physical item-run. reserveCampaignDriveDispatch is the SOLE create/adopt
//      authority for it. After the continuation claim authorizes N+1, the campaign dispatch
//      calls the reservation for N+1's attempt generation, then records the resulting
//      immutable run identity — the reservation stays authoritative for item-run dedup.
//
// AC-ADOPT-DRIVE (binding): FG-596 physically drives ONLY a `created` reservation; an
// `adopted` reservation is linked but never re-driven by FG-596. Converting an adopted
// reservation into a physical re-drive is THIS adapter's job and is gated on the controller
// holding BOTH the continuation claim (we only reach dispatch AFTER the claim is granted)
// AND the LIVE persisted campaign-controller owner/generation lease (AC7). The lease is
// checked immediately before physical work; a controller without it is FENCED and STOPS
// (throws → the core leaves the slot recoverable, never falsely advanced). `lost` launches
// nothing and can never be marked advanced.

import {
  reserveCampaignDriveDispatch as realReserveCampaignDriveDispatch,
  type CampaignDriveReservation,
} from "../store/campaigns.js";
import {
  acquireCampaignLease,
  campaignLeaseHeldBy as realCampaignLeaseHeldBy,
  getItemLaunch as realGetItemLaunch,
  type CampaignLease,
  type ItemLaunch,
} from "../store/campaign-controller.js";
import { getCampaignItem as realGetCampaignItem } from "../store/campaigns.js";
import {
  consumeCore,
  recoverInFlightCore,
  assertFullIdentity as coreAssertFullIdentity,
  type ConsumeOutcome,
  type ContinuationIdentity,
  type CoreConsumeDeps,
  type PhysicalDispatch,
} from "../v2/consumer-core.js";
import type { NextAction } from "../store/continuations.js";

export type { ContinuationIdentity } from "../v2/consumer-core.js";

/** The deterministic continuation id for a campaign item — stable as (campaignId, itemId)
 *  across attempts (AC3). The attempt identity lives in the phase, not the continuation id. */
export function campaignContinuationId(campaignId: string, itemId: string): string {
  return `${campaignId}::${itemId}`;
}

/** The attempt-scoped phase (AC3 / contract-correction 2): rearming a retry binds a NEW
 *  sourceLaunchId AND a new attempt phase, so a delayed prior-attempt completion cannot
 *  advance a new attempt. */
export function campaignItemPhase(itemId: string, attempt: number): string {
  return `drive:${itemId}#${attempt}`;
}

/** The structured nextAction naming the ACTUAL next item (contract-correction 3) — never
 *  an opaque shell string, never the completed item's id. */
export function driveCampaignItemAction(campaignId: string, nextItemId: string): NextAction {
  return { kind: "drive_campaign_item", campaignId, itemId: nextItemId };
}
export function finalizeCampaignAction(campaignId: string): NextAction {
  return { kind: "finalize_campaign", campaignId };
}

/** The lease identity the controller currently holds — the fence for AC-ADOPT-DRIVE. */
export type HeldLease = { owner: string; generation: number };

/** The physical launch/re-drive seam. Given a reserved item-run, it launches (created) or
 *  re-drives (adopted) the item's drive-item process. Fire-and-forget (async): the run row
 *  already exists durably (created inside the reservation tx), so a crash here still leaves
 *  the run adoptable. In production it is wired to launchDriveItemUnderForge; a test injects
 *  an in-process fake. Item outcome is DERIVED from durable state after the wake — never
 *  from what this returns. */
/** FG-564 (FIX round 5): the lane the shared authority resolved — the LANE IDENTITY the
 *  driver seam uses to select the SAME physical driver (pipeline -> runNext, invoke/invoke_chain
 *  -> the real invoke path) as the normal drive, off this result rather than a re-derived guess. */
export type CampaignItemDriver = "pipeline" | "invoke" | "invoke_chain";

/** The lane-aware preparation result: the driver identity + the createRun that mints the correct
 *  run shape INSIDE the reservation tx. All filesystem reads (workflow YAML, ticket) happen in
 *  the prepare call, OUTSIDE the reservation. */
export type PreparedItemDispatch = {
  driver: CampaignItemDriver;
  createRun: (ctx: { dispatchKey: string; attemptGeneration: number }) => string;
};

export type DriveItemSeam = (ctx: {
  campaignId: string;
  itemId: string;
  runId: string;
  attemptGeneration: number;
  mode: "created" | "adopted";
  /** The resolved lane identity — the seam drives via the SAME physical path the normal drive
   *  uses for this lane (a launched drive-item child re-reads it off the durable run). */
  driver: CampaignItemDriver;
  /** The current lease owner/generation — recorded as the launch linkage's IMMUTABLE
   *  born-under fencing token when the executor persists the linkage at real launch time. */
  controllerOwner: string;
  controllerGeneration: number;
}) => void;

export type CampaignDispatchDeps = {
  /** The lease identity the controller currently holds. */
  lease: HeldLease;
  /** The ONE lane-aware dispatch-preparation authority (executor.prepareCampaignItemDispatch,
   *  injected to avoid a circular import). Resolves the lane + filesystem inputs OUTSIDE the
   *  reservation and yields the driver identity + the createRun that mints the correct run shape
   *  INSIDE it. THROWS (fail closed, before the reservation) on a missing ticket / projectDir /
   *  unresolved workflow / non-dispatching lane — leaving the continuation recoverable. */
  prepareItemDispatch: (ctx: { campaignId: string; itemId: string }) => PreparedItemDispatch;
  /** The physical launch/re-drive seam. */
  driveItem: DriveItemSeam;
  /** Injectable seams (default to the real store primitives). */
  reserve?: (opts: {
    campaignId: string;
    itemId: string;
    createRun: (ctx: { dispatchKey: string; attemptGeneration: number }) => string;
  }) => CampaignDriveReservation;
  leaseHeldBy?: (campaignId: string, owner: string, generation: number) => boolean;
  /** Resolve the prior item-attempt launch linkage for the current attempt of this item, if
   *  one exists (the adopted re-drive path). Its IMMUTABLE born-under fencing token is compared
   *  to the currently-held lease BEFORE any durable reservation. Defaults to the real store. */
  priorItemLaunch?: (campaignId: string, itemId: string) => ItemLaunch | undefined;
};

/** The SAME attempt-generation formula reserveCampaignDriveDispatch / recordDriveItemLaunchLinkage
 *  use: reuse a persisted non-zero generation, else the first attempt is 1. */
function defaultPriorItemLaunch(campaignId: string, itemId: string): ItemLaunch | undefined {
  const item = realGetCampaignItem(itemId);
  if (!item || item.campaignId !== campaignId) return undefined;
  const gen = item.attemptGeneration > 0 ? item.attemptGeneration : 1;
  return realGetItemLaunch(campaignId, itemId, gen);
}

/**
 * The campaign PhysicalDispatch: translate an authorized item-boundary advance into the
 * FG-596 reservation (the sole item-run authority) under the AC-ADOPT-DRIVE lease gate.
 * A `lost` reservation or a fenced adopt THROWS — the core then leaves the slot recoverable
 * (blocked), never marked advanced.
 */
export function makeCampaignDispatch(deps: CampaignDispatchDeps): PhysicalDispatch {
  const reserve = deps.reserve ?? realReserveCampaignDriveDispatch;
  const leaseHeldBy = deps.leaseHeldBy ?? realCampaignLeaseHeldBy;
  const priorItemLaunch = deps.priorItemLaunch ?? defaultPriorItemLaunch;

  return (args) => {
    const action = args.nextAction;
    if (action.kind === "finalize_campaign") {
      // The boundary advance itself finalizes the campaign — there is no item-run to create.
      // markAdvanced with no ids records the finalization boundary durably.
      return {};
    }
    if (action.kind !== "drive_campaign_item") {
      throw new Error(
        `campaign dispatch: unsupported nextAction.kind='${action.kind}'. ` +
          `Supported: 'drive_campaign_item', 'finalize_campaign'.`,
      );
    }
    const campaignId = String((action as { campaignId?: unknown }).campaignId ?? "");
    const itemId = String((action as { itemId?: unknown }).itemId ?? "");
    if (!campaignId || !itemId) {
      throw new Error(`campaign dispatch: drive_campaign_item requires { campaignId, itemId }`);
    }

    // P1-E (AC-ADOPT-DRIVE ordering) + AC7 + P0-B: AUTHORIZE BEFORE any durable
    // reservation/mutation, so a fenced controller performs NO durable write.
    //   1. We must hold the LIVE campaign-controller lease.
    if (!leaseHeldBy(campaignId, deps.lease.owner, deps.lease.generation)) {
      throw new Error(
        `AC-ADOPT-DRIVE: controller does not hold the live campaign-controller lease ` +
          `(${deps.lease.owner}#${deps.lease.generation}) — FENCED from driving ${campaignId}/${itemId} ` +
          `(no durable write). Takeover is only possible after lease expiry.`,
      );
    }
    //   2. P0-B (C7 double-driver fence): if a prior item-attempt launch linkage exists (an
    //      adopted re-drive), its IMMUTABLE born-under token must EQUAL the lease we hold. A
    //      mismatch (a newer generation now owns after takeover) means this run was born under
    //      a DIFFERENT owner/generation — fence, do not re-drive, do not mutate.
    const prior = priorItemLaunch(campaignId, itemId);
    if (prior && (prior.controllerOwner !== deps.lease.owner || prior.controllerGeneration !== deps.lease.generation)) {
      throw new Error(
        `C7 fence: ${campaignId}/${itemId} launch linkage was born under ` +
          `${prior.controllerOwner}#${prior.controllerGeneration}, but the live lease is held by ` +
          `${deps.lease.owner}#${deps.lease.generation} — FENCED (no durable write). A newer generation ` +
          `now owns after takeover; the born-under driver must not re-drive/advance/audit.`,
      );
    }

    // FG-564 (FIX round 5): resolve the lane + filesystem inputs through the ONE shared authority
    // BEFORE the reservation, so every filesystem read (loadWorkflow / ticket resolution) happens
    // OUTSIDE the reservation write transaction — for the recover caller exactly as for the normal
    // drive. A fail-closed input (missing ticket / projectDir / unresolved workflow / non-dispatch
    // lane) THROWS here, before any reserve — the item stays pending, no run minted, and the core
    // leaves the continuation recoverable (blocked), never falsely advanced.
    const prepared = deps.prepareItemDispatch({ campaignId, itemId });

    // AC5: reserveCampaignDriveDispatch is the SOLE create/adopt authority. The continuation
    // receipt (args.dispatchKey) is NOT used to find or create the item-run. createRun runs
    // INSIDE the tx and does NO filesystem read (prepared captured the resolved inputs).
    const reservation = reserve({
      campaignId,
      itemId,
      createRun: prepared.createRun,
    });

    if (reservation.status === "lost") {
      // AC5: lost launches nothing and must NEVER be marked advanced. A throw leaves the
      // continuation recoverable (the core returns `blocked`).
      throw new Error(
        `campaign dispatch: reservation lost for ${campaignId}/${itemId} — nothing launched, not advanced`,
      );
    }

    const { runId, attemptGeneration } = reservation;

    // AC-ADOPT-DRIVE + AC7: re-check the lease is STILL held immediately before physical work —
    // the drive stays fenced for the whole interval (a takeover between authorization and here
    // fences us before we launch).
    if (!leaseHeldBy(campaignId, deps.lease.owner, deps.lease.generation)) {
      throw new Error(
        `AC-ADOPT-DRIVE: lost the live campaign-controller lease ` +
          `(${deps.lease.owner}#${deps.lease.generation}) before physical work on ` +
          `${campaignId}/${itemId} — FENCED from ${reservation.status === "adopted" ? "re-driving" : "driving"}.`,
      );
    }

    // Physically launch (created) or re-drive (adopted). The DURABLE item-attempt launch
    // linkage is recorded INSIDE driveItem, at the item's real launch time with the concrete
    // sourceLaunchId assigned by startLaunch (executor step 5) — NEVER here with the CURRENT
    // continuation's launch id, which belongs to the COMPLETED item, not the one being driven.
    // Fire-and-forget: the run row is durable (created inside the reservation tx), so a crash
    // here leaves it adoptable. Item outcome is derived from durable state after the wake.
    deps.driveItem({
      campaignId,
      itemId,
      runId,
      attemptGeneration,
      mode: reservation.status,
      driver: prepared.driver,
      controllerOwner: deps.lease.owner,
      controllerGeneration: deps.lease.generation,
    });
    return { runId };
  };
}

/** CP4: the campaign surface carries the COMPLETE phase-bound identity and MUST be
 *  consumerKind='campaign'. */
export function assertFullIdentity(identity: Partial<ContinuationIdentity>): asserts identity is ContinuationIdentity {
  coreAssertFullIdentity(identity, "campaign");
}

export type CampaignConsumeDeps = Omit<CoreConsumeDeps, "dispatch"> & {
  campaign: CampaignDispatchDeps;
};

/**
 * Consume a campaign continuation on wake (normal delivery OR watchdog). The controller's
 * campaign-controller lease identity (deps.campaign.lease) fences the physical drive; the
 * FG-562 claim owner (deps.owner) claims the ONE boundary advance. They are the same stable
 * controller identity.
 */
export function consumeCampaignContinuation(
  identity: ContinuationIdentity,
  deps: CampaignConsumeDeps,
): ConsumeOutcome {
  assertFullIdentity(identity);
  const { campaign, ...core } = deps;
  return consumeCore(identity, { ...core, dispatch: makeCampaignDispatch(campaign) });
}

/**
 * AC5/AC8 restart-replay recovery for the campaign consumer: adopt every in-flight campaign
 * dispatch (consumer-scoped filter) via the receipt, re-driving through the SAME lease-gated
 * reservation authority — NEVER a duplicate item-run.
 */
export function recoverInFlightCampaignDispatches(deps: CampaignConsumeDeps): ConsumeOutcome[] {
  const { campaign, ...core } = deps;
  return recoverInFlightCore({ ...core, dispatch: makeCampaignDispatch(campaign) }, "campaign");
}

export type RecoverCampaignResult =
  /** AC8: the prior controller's lease is still LIVE — recovery FAILS CLOSED. A replacement
   *  must not act while the lease is live; it may only take over after expiry. */
  | { status: "lease_held_live"; lease: CampaignLease }
  /** The lease was acquired (fresh), renewed (same instance), or taken over (after expiry).
   *  Every in-flight campaign continuation/run was adopted through the lease-gated
   *  reservation authority — no item reset, no replacement run. */
  | { status: "recovered"; lease: CampaignLease; mode: "created" | "renewed" | "took_over"; adopted: ConsumeOutcome[] };

/**
 * AC8 (D2) — the running-campaign takeover entry point. A campaign whose controller died is
 * recovered WITHOUT manual SQL and WITHOUT resetting the item or minting a replacement run:
 *
 *   1. Acquire the campaign-controller lease. If a DIFFERENT owner still holds a LIVE lease,
 *      FAIL CLOSED (`lease_held_live`) — never act while the prior lease is live.
 *   2. Only after grant (fresh / same-instance renew / post-expiry takeover), adopt every
 *      in-flight campaign continuation through the SAME lease-gated reservation authority —
 *      `adopted` reservations resolve to the ONE existing run; nothing is duplicated or reset.
 *
 * The item-loop CONTINUATION (driving remaining pending items) is the caller's job via the
 * existing drive path, now fenced by the lease this call holds.
 */
export function recoverCampaign(
  opts: {
    campaignId: string;
    owner: string;
    ttlMs: number;
    campaign: Omit<CampaignDispatchDeps, "lease">;
  } & Omit<CoreConsumeDeps, "dispatch" | "owner">,
): RecoverCampaignResult {
  const { campaignId, owner, ttlMs, campaign, ...core } = opts;
  const grant = acquireCampaignLease({ campaignId, owner, ttlMs });
  if (!grant.granted) {
    return { status: "lease_held_live", lease: grant.lease };
  }
  const lease: HeldLease = { owner, generation: grant.lease.generation };
  const adopted = recoverInFlightCampaignDispatches({ ...core, owner, campaign: { ...campaign, lease } });
  return { status: "recovered", lease: grant.lease, mode: grant.mode, adopted };
}
