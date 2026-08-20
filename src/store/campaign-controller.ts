// FG-564 (Slice 5b, D1/AC7/AC10): the durable campaign-controller store.
//
// Two durable responsibilities the ticket makes novel-in-this-slice, both keyed on
// the store's own clock (storeNowMs — never an independently-sourced process clock,
// so two forge processes with skewed clocks can never disagree about expiry) and
// mutated only through owner/generation-scoped compare-and-set (FG-548: every write
// takes its lock IMMEDIATELY via writeTransaction / BEGIN IMMEDIATE):
//
//   1. THE CAMPAIGN-CONTROLLER LEASE (campaign_controller_leases). The campaign
//      `running` status is NOT a singleton fence — it cannot distinguish two
//      controller instances. This lease fences the ONE live physical driver. An
//      instance-stable owner (campaign@<campaignId>@<controllerInstanceId>) renews it
//      while it owns the item loop / physical drive; a REPLACEMENT controller MUST NOT
//      renew or impersonate the prior controller and takes over only AFTER expiry,
//      bumping the generation. The generation is the fencing token: once a takeover
//      bumps it, the EXPIRED original owner's stale generation can never renew, write,
//      advance, audit, or re-drive (AC7). Mirrors publication_lane's expiry-only rule.
//
//   2. THE ITEM-ATTEMPT LAUNCH LINKAGE (campaign_item_launches). FG-596's launch
//      receives a random source_launch_id locally; this makes the relationship between
//      (campaignId, itemId, attemptGeneration) and that launch DURABLE before a
//      continuation waiter is relied on, so recovery discovers it DIRECTLY — never by
//      parsing launch names, argv, or timestamps (AC10). Each row carries an IMMUTABLE
//      born-under fencing token (the lease owner+generation the launch was born under);
//      AC-ADOPT-DRIVE compares it against the currently-held lease immediately before
//      any physical re-drive.

import { getDb, writeTransaction } from "./db.js";
import { storeNowMs } from "./publications.js";
import { nowIso } from "../util/ids.js";

// ── campaign-controller lease ─────────────────────────────────────────────────

export type CampaignLease = {
  campaignId: string;
  owner: string;
  generation: number;
  leaseExpiresAtMs: number;
  createdAt: string;
  updatedAt: string;
};

type CampaignLeaseRow = {
  campaign_id: string;
  owner: string;
  generation: number;
  lease_expires_at_ms: number;
  created_at: string;
  updated_at: string;
};

function toLease(r: CampaignLeaseRow): CampaignLease {
  return {
    campaignId: r.campaign_id,
    owner: r.owner,
    generation: r.generation,
    leaseExpiresAtMs: r.lease_expires_at_ms,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export type LeaseGrant =
  /** We hold the lease at the returned generation, valid until `lease.leaseExpiresAtMs`.
   *  `created` = first ever lease; `renewed` = we re-acquired our OWN lease (same owner,
   *  same generation — a same-instance restart or a live renewal); `took_over` = a prior
   *  owner's lease was strictly expired and we adopted it, bumping the generation (AC8). */
  | { granted: true; lease: CampaignLease; mode: "created" | "renewed" | "took_over" }
  /** A DIFFERENT owner holds a still-LIVE lease. A replacement cannot renew or impersonate
   *  it (D1); takeover is only possible AFTER expiry. `lease` is the live holder's row so
   *  a running-campaign takeover (AC8) can FAIL CLOSED and report who still owns it. */
  | { granted: false; reason: "held_by_live_owner"; lease: CampaignLease };

export function getCampaignLease(campaignId: string): CampaignLease | undefined {
  const row = getDb()
    .prepare(`SELECT * FROM campaign_controller_leases WHERE campaign_id = ?`)
    .get(campaignId) as CampaignLeaseRow | undefined;
  return row ? toLease(row) : undefined;
}

/**
 * Acquire, renew, or take over the campaign-controller lease for `owner`, in ONE
 * immediate transaction so the read-decide-write can never race a concurrent
 * controller. Semantics (all against the store's own clock):
 *   - no lease yet            → CREATE at generation 1.
 *   - our OWN lease (owner matches — a takeover changes the owner, so an owner match
 *                    proves nobody stepped past us) → RENEW at the SAME generation
 *                    (a same-instance restart re-adopts its own lease without waiting
 *                    for it to expire against itself).
 *   - a DIFFERENT owner, lease STRICTLY expired → TAKE OVER, bumping the generation
 *                    (the fresh controller becomes the fenced driver; the expired
 *                    former owner's stale generation is now unusable — AC7/AC8).
 *   - a DIFFERENT owner, lease still LIVE        → DENIED (held_by_live_owner). A
 *                    replacement must fail closed and wait for expiry (D2).
 */
export function acquireCampaignLease(opts: {
  campaignId: string;
  owner: string;
  ttlMs: number;
}): LeaseGrant {
  const { campaignId, owner, ttlMs } = opts;
  return writeTransaction((): LeaseGrant => {
    const db = getDb();
    const now = storeNowMs();
    const iso = nowIso();
    const existing = getCampaignLease(campaignId);

    if (!existing) {
      db.prepare(
        `INSERT INTO campaign_controller_leases
           (campaign_id, owner, generation, lease_expires_at_ms, created_at, updated_at)
         VALUES (?, ?, 1, ?, ?, ?)`,
      ).run(campaignId, owner, now + ttlMs, iso, iso);
      const lease = getCampaignLease(campaignId);
      return { granted: true, lease: lease as CampaignLease, mode: "created" };
    }

    if (existing.owner === owner) {
      // Our own lease. Renew at the SAME generation, scoped to (owner, generation) so a
      // concurrent takeover that already stepped past us (owner/generation changed) makes
      // this a no-op and we re-read the winner below.
      const res = db
        .prepare(
          `UPDATE campaign_controller_leases
              SET lease_expires_at_ms = ?, updated_at = ?
            WHERE campaign_id = ? AND owner = ? AND generation = ?`,
        )
        .run(now + ttlMs, iso, campaignId, owner, existing.generation);
      if ((res.changes ?? 0) > 0) {
        return { granted: true, lease: getCampaignLease(campaignId) as CampaignLease, mode: "renewed" };
      }
      const after = getCampaignLease(campaignId) as CampaignLease;
      return { granted: false, reason: "held_by_live_owner", lease: after };
    }

    // A different owner holds it. Only a STRICTLY-expired lease may be taken over.
    if (existing.leaseExpiresAtMs < now) {
      const res = db
        .prepare(
          `UPDATE campaign_controller_leases
              SET owner = ?, generation = ?, lease_expires_at_ms = ?, updated_at = ?
            WHERE campaign_id = ? AND generation = ? AND lease_expires_at_ms < ?`,
        )
        .run(owner, existing.generation + 1, now + ttlMs, iso, campaignId, existing.generation, now);
      if ((res.changes ?? 0) > 0) {
        return { granted: true, lease: getCampaignLease(campaignId) as CampaignLease, mode: "took_over" };
      }
      // Lost the takeover race to another fresh controller; report the current holder.
      return { granted: false, reason: "held_by_live_owner", lease: getCampaignLease(campaignId) as CampaignLease };
    }

    return { granted: false, reason: "held_by_live_owner", lease: existing };
  });
}

/**
 * Renew OUR live lease across a span the physical drive can block in (D1: the lease
 * must remain valid for the whole physical-drive ownership interval). Scoped to
 * (campaign_id, owner, generation) AND a still-live expiry — a renewal after a
 * takeover already bumped the generation, or after our own lease strictly expired,
 * returns false so the caller FAILS CLOSED rather than driving under a dead lease.
 */
export function renewCampaignLease(
  campaignId: string,
  owner: string,
  generation: number,
  ttlMs: number,
): boolean {
  return writeTransaction((): boolean => {
    const now = storeNowMs();
    const res = getDb()
      .prepare(
        `UPDATE campaign_controller_leases
            SET lease_expires_at_ms = ?, updated_at = ?
          WHERE campaign_id = ? AND owner = ? AND generation = ? AND lease_expires_at_ms >= ?`,
      )
      .run(now + ttlMs, nowIso(), campaignId, owner, generation, now);
    return (res.changes ?? 0) > 0;
  });
}

/**
 * AC-ADOPT-DRIVE authorization predicate: does `owner`@`generation` hold the LIVE
 * campaign-controller lease AT THIS INSTANT? True only when the row exists, the owner
 * and generation match exactly, and the lease has not expired. This is the check made
 * immediately before physical work and re-checked across the drive — an expired former
 * owner (stale generation, or a lease that lapsed) is fenced and returns false.
 */
export function campaignLeaseHeldBy(campaignId: string, owner: string, generation: number): boolean {
  const now = storeNowMs();
  const row = getDb()
    .prepare(
      `SELECT 1 FROM campaign_controller_leases
        WHERE campaign_id = ? AND owner = ? AND generation = ? AND lease_expires_at_ms >= ?`,
    )
    .get(campaignId, owner, generation, now);
  return row !== undefined;
}

/** Release/settle the lease when the campaign becomes terminal or durably parks (D1).
 *  Owner/generation-scoped so a stale controller can never clear the live holder's lease. */
export function releaseCampaignLease(campaignId: string, owner: string, generation: number): boolean {
  return writeTransaction((): boolean => {
    const res = getDb()
      .prepare(
        `DELETE FROM campaign_controller_leases
          WHERE campaign_id = ? AND owner = ? AND generation = ?`,
      )
      .run(campaignId, owner, generation);
    return (res.changes ?? 0) > 0;
  });
}

// ── item-attempt launch linkage ───────────────────────────────────────────────

/** The lifecycle of a durable item-attempt launch linkage. The linkage is recorded
 *  `launched` FIRST (before the continuation is recorded), so a crash after the launch
 *  but before recordContinuation still leaves a durable row recovery discovers directly
 *  (C7). It advances as the ordered, idempotently-repairable protocol proceeds. */
export type ItemLaunchState = "launched" | "continuation_recorded" | "observed" | "advanced" | "settled";

export type ItemLaunch = {
  campaignId: string;
  itemId: string;
  attemptGeneration: number;
  sourceLaunchId: string;
  /** Immutable born-under fencing token: the lease owner the launch was born under. */
  controllerOwner: string;
  /** Immutable born-under fencing token: the lease generation the launch was born under. */
  controllerGeneration: number;
  runId?: string;
  state: ItemLaunchState;
  createdAt: string;
  updatedAt: string;
};

type ItemLaunchRow = {
  campaign_id: string;
  item_id: string;
  attempt_generation: number;
  source_launch_id: string;
  controller_owner: string;
  controller_generation: number;
  run_id: string | null;
  state: string;
  created_at: string;
  updated_at: string;
};

function toItemLaunch(r: ItemLaunchRow): ItemLaunch {
  return {
    campaignId: r.campaign_id,
    itemId: r.item_id,
    attemptGeneration: r.attempt_generation,
    sourceLaunchId: r.source_launch_id,
    controllerOwner: r.controller_owner,
    controllerGeneration: r.controller_generation,
    ...(r.run_id !== null ? { runId: r.run_id } : {}),
    state: r.state as ItemLaunchState,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/**
 * Record (or idempotently re-affirm) the durable item-attempt launch linkage. Called
 * FIRST at launch time — before recordContinuation and before the waiter is armed — so
 * recovery discovers it directly (AC10). The born-under fencing token
 * (controllerOwner + controllerGeneration) is IMMUTABLE: an INSERT sets it once; a
 * re-record of the SAME (campaignId, itemId, attemptGeneration) NEVER overwrites the
 * born-under owner/generation or the source_launch_id with a different value (a
 * conflicting re-record is a bug — the composite key already fences a distinct attempt
 * into its own row). Re-recording the identical linkage is idempotently successful and
 * may fill in a NULL run_id or advance the state forward.
 */
export function recordItemLaunch(rec: {
  campaignId: string;
  itemId: string;
  attemptGeneration: number;
  sourceLaunchId: string;
  controllerOwner: string;
  controllerGeneration: number;
  runId?: string;
  state?: ItemLaunchState;
}): ItemLaunch {
  return writeTransaction((): ItemLaunch => {
    const db = getDb();
    const iso = nowIso();
    const state = rec.state ?? "launched";
    // Idempotent, immutable-token upsert. ON CONFLICT keeps the born-under
    // owner/generation and the source_launch_id, only ever moving run_id from NULL and
    // touching updated_at + state. A conflicting source_launch_id / born-under token
    // therefore CANNOT overwrite the original — the linkage is immutable once born.
    db.prepare(
      `INSERT INTO campaign_item_launches
         (campaign_id, item_id, attempt_generation, source_launch_id,
          controller_owner, controller_generation, run_id, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(campaign_id, item_id, attempt_generation) DO UPDATE SET
         run_id = COALESCE(campaign_item_launches.run_id, excluded.run_id),
         state = excluded.state,
         updated_at = excluded.updated_at`,
    ).run(
      rec.campaignId,
      rec.itemId,
      rec.attemptGeneration,
      rec.sourceLaunchId,
      rec.controllerOwner,
      rec.controllerGeneration,
      rec.runId ?? null,
      state,
      iso,
      iso,
    );
    return getItemLaunch(rec.campaignId, rec.itemId, rec.attemptGeneration) as ItemLaunch;
  });
}

export function getItemLaunch(
  campaignId: string,
  itemId: string,
  attemptGeneration: number,
): ItemLaunch | undefined {
  const row = getDb()
    .prepare(
      `SELECT * FROM campaign_item_launches
        WHERE campaign_id = ? AND item_id = ? AND attempt_generation = ?`,
    )
    .get(campaignId, itemId, attemptGeneration) as ItemLaunchRow | undefined;
  return row ? toItemLaunch(row) : undefined;
}

/** Resolve a linkage from a launch id directly (source_launch_id is uniquely indexed) —
 *  the recovery path that turns an observed launch back into its item-attempt identity
 *  without ANY heuristic name/argv matching (AC10). */
export function itemLaunchBySourceLaunch(sourceLaunchId: string): ItemLaunch | undefined {
  const row = getDb()
    .prepare(`SELECT * FROM campaign_item_launches WHERE source_launch_id = ?`)
    .get(sourceLaunchId) as ItemLaunchRow | undefined;
  return row ? toItemLaunch(row) : undefined;
}

/** The recovery discovery set: every item-attempt launch linkage NOT yet settled,
 *  optionally scoped to one campaign. Ordered oldest-first so the longest-stuck launch
 *  is reconciled first. A replacement controller enumerates these to rediscover
 *  in-flight launches directly (AC10) — no launch-name archaeology. */
export function inFlightItemLaunches(opts: { campaignId?: string } = {}): ItemLaunch[] {
  const rows = opts.campaignId
    ? (getDb()
        .prepare(
          `SELECT * FROM campaign_item_launches
            WHERE campaign_id = ? AND state != 'settled' ORDER BY created_at ASC`,
        )
        .all(opts.campaignId) as ItemLaunchRow[])
    : (getDb()
        .prepare(`SELECT * FROM campaign_item_launches WHERE state != 'settled' ORDER BY created_at ASC`)
        .all() as ItemLaunchRow[]);
  return rows.map(toItemLaunch);
}

/**
 * FG-737: REFRESH a SETTLED linkage's born-under fencing token so a legitimate new controller
 * re-drives instead of fencing forever against a stale owner/generation.
 *
 * The born-under token (controller_owner + controller_generation) is normally IMMUTABLE
 * (recordItemLaunch never rewrites it), because it fences a genuinely IN-FLIGHT attempt against a
 * foreign live controller (FG-564 double-driver prevention). But once an attempt has SETTLED —
 * run_id IS NULL, no in-flight authority to protect — a linkage still pinned to a prior
 * controller's `cli-<pid>` owner strands a held item: no later controller ever holds the lease
 * under that born-under owner, so the drive-item fence denies forever.
 *
 * This REFRESH is GUARDED on `run_id IS NULL`: a linkage that carries a run id is genuinely
 * in-flight and its born-under authority is NOT touched — FG-564 stays intact.
 *
 * It is ALSO guarded on `token` still being the LIVE lease holder, coupled ATOMICALLY into the
 * UPDATE via an EXISTS against campaign_controller_leases. Without this, a stale launcher whose
 * lease was already taken over — or a TOCTOU between the caller's lease read and this write —
 * could rebind a settled linkage's born-under token to a NON-current owner/generation, re-wedging
 * the held item (the legit successor then fences because born-under != the live lease). Because the
 * lease-holder check lives in the same statement as the write, no window exists between verifying
 * the holder and rewriting the token. Only the caller actually holding the current lease rebinds;
 * a stale caller no-ops. Returns true when a settled row was actually refreshed (no row / an
 * in-flight row / a non-holder token → false, no-op).
 */
export function refreshItemLaunchBornUnder(
  campaignId: string,
  itemId: string,
  attemptGeneration: number,
  token: { owner: string; generation: number },
): boolean {
  return writeTransaction((): boolean => {
    const res = getDb()
      .prepare(
        `UPDATE campaign_item_launches
            SET controller_owner = ?, controller_generation = ?, updated_at = ?
          WHERE campaign_id = ? AND item_id = ? AND attempt_generation = ?
            AND run_id IS NULL
            AND EXISTS (
              SELECT 1 FROM campaign_controller_leases l
               WHERE l.campaign_id = campaign_item_launches.campaign_id
                 AND l.owner = ?
                 AND l.generation = ?
            )`,
      )
      .run(token.owner, token.generation, nowIso(), campaignId, itemId, attemptGeneration, token.owner, token.generation);
    return (res.changes ?? 0) > 0;
  });
}

/** Advance a linkage's lifecycle state and/or fill in the resolved run id. run_id is
 *  IMMUTABLE once set (COALESCE keeps the first non-null), matching the immutable
 *  dispatch identity the FG-562 primitive enforces on continuations. */
export function updateItemLaunch(
  campaignId: string,
  itemId: string,
  attemptGeneration: number,
  update: { runId?: string; state?: ItemLaunchState },
): boolean {
  return writeTransaction((): boolean => {
    const assignments: string[] = [];
    const params: unknown[] = [];
    if (update.state !== undefined) {
      assignments.push("state = ?");
      params.push(update.state);
    }
    if (update.runId !== undefined) {
      assignments.push("run_id = COALESCE(run_id, ?)");
      params.push(update.runId);
    }
    assignments.push("updated_at = ?");
    params.push(nowIso());
    const res = getDb()
      .prepare(
        `UPDATE campaign_item_launches SET ${assignments.join(", ")}
          WHERE campaign_id = ? AND item_id = ? AND attempt_generation = ?`,
      )
      .run(...params, campaignId, itemId, attemptGeneration);
    return (res.changes ?? 0) > 0;
  });
}
