import { createHash } from "node:crypto";
import { getDb, writeTransaction } from "./db.js";
import { runByDispatchKey, getRun, updateRunStatus } from "./runs.js";
import { isCampaignTransitionAllowed } from "../types/index.js";
import type {
  Campaign,
  CampaignItem,
  CampaignStatus,
  CampaignItemLifecycleStatus,
  CampaignItemOutcome,
  BlockerKind,
  ContinuePolicy,
  SourceKind,
} from "../types/index.js";
import { nowIso, newCampaignId, newCampaignItemId } from "../util/ids.js";
import { provenPhysical } from "../util/path-identity.js";

type CampaignRow = {
  id: string;
  status: string;
  source_kind: string;
  source_input: string;
  mode: string;
  created_at: string;
  updated_at: string;
  metadata: string | null;
  plan_hash: string | null;
  approved_by: string | null;
  approved_at: string | null;
  approval_rationale: string | null;
  approved_plan_hash: string | null;
  project_dir: string | null;
};

type CampaignItemRow = {
  id: string;
  campaign_id: string;
  item_order: number;
  ticket_id: string;
  run_id: string | null;
  branch: string | null;
  worktree_path: string | null;
  pr_url: string | null;
  lifecycle_status: string;
  outcome: string | null;
  blocker_kind: string | null;
  continue_policy: string | null;
  reason: string | null;
  requested_human_action: string | null;
  attempt_generation: number;
  created_at: string;
  updated_at: string;
};

function rowToCampaign(row: CampaignRow): Campaign {
  return {
    id: row.id,
    status: row.status as CampaignStatus,
    sourceKind: row.source_kind as SourceKind,
    sourceInput: JSON.parse(row.source_input) as Record<string, unknown>,
    mode: row.mode,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    metadata: row.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : undefined,
    planHash: row.plan_hash ?? undefined,
    approvedBy: row.approved_by ?? undefined,
    approvedAt: row.approved_at ?? undefined,
    approvalRationale: row.approval_rationale ?? undefined,
    approvedPlanHash: row.approved_plan_hash ?? undefined,
    projectDir: row.project_dir ?? undefined,
  };
}

function rowToCampaignItem(row: CampaignItemRow): CampaignItem {
  return {
    id: row.id,
    campaignId: row.campaign_id,
    itemOrder: row.item_order,
    ticketId: row.ticket_id,
    runId: row.run_id ?? undefined,
    branch: row.branch ?? undefined,
    worktreePath: row.worktree_path ?? undefined,
    prUrl: row.pr_url ?? undefined,
    lifecycleStatus: row.lifecycle_status as CampaignItemLifecycleStatus,
    outcome: (row.outcome as CampaignItemOutcome | null) ?? undefined,
    blockerKind: (row.blocker_kind as BlockerKind | null) ?? undefined,
    continuePolicy: (row.continue_policy as ContinuePolicy | null) ?? undefined,
    reason: row.reason ?? undefined,
    requestedHumanAction: row.requested_human_action ?? undefined,
    // FG-596: pre-FG-596 rows / a NULL slip read back as 0 (never-allocated marker).
    attemptGeneration: row.attempt_generation ?? 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createCampaign(opts: {
  sourceKind: SourceKind;
  sourceInput: Record<string, unknown>;
  mode: string;
  metadata?: Record<string, unknown>;
  projectDir?: string;
}): Campaign {
  const now = nowIso();
  const campaign: Campaign = {
    id: newCampaignId(),
    status: "planned",
    sourceKind: opts.sourceKind,
    sourceInput: opts.sourceInput,
    mode: opts.mode,
    createdAt: now,
    updatedAt: now,
    metadata: opts.metadata,
    projectDir: opts.projectDir,
  };
  // FG-693: project_dir keeps the caller's bytes VERBATIM (audit evidence, and what
  // every surface renders); the PROVEN identity goes beside it, or NULL when the
  // filesystem would not confirm the path. Without this writer every new campaign row
  // joined the pre-FG-693 NULL-canonical population permanently, so the legacy read
  // path — the one whose cost is bounded by that population being self-extinguishing —
  // would have grown forever instead of shrinking.
  const canonical = campaign.projectDir ? provenPhysical(campaign.projectDir) : null;
  getDb()
    .prepare(
      `INSERT INTO campaigns (id, status, source_kind, source_input, mode, created_at, updated_at, metadata, project_dir, project_dir_canonical)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      campaign.id,
      campaign.status,
      campaign.sourceKind,
      JSON.stringify(campaign.sourceInput),
      campaign.mode,
      campaign.createdAt,
      campaign.updatedAt,
      campaign.metadata ? JSON.stringify(campaign.metadata) : null,
      campaign.projectDir ?? null,
      canonical
    );
  return campaign;
}

export function getCampaign(id: string): Campaign | undefined {
  const row = getDb()
    .prepare(`SELECT * FROM campaigns WHERE id = ?`)
    .get(id) as CampaignRow | undefined;
  return row ? rowToCampaign(row) : undefined;
}

export function listCampaigns(statusFilter?: CampaignStatus): Campaign[] {
  const rows = statusFilter
    ? (getDb()
        .prepare(`SELECT * FROM campaigns WHERE status = ? ORDER BY created_at DESC`)
        .all(statusFilter) as CampaignRow[])
    : (getDb()
        .prepare(`SELECT * FROM campaigns ORDER BY created_at DESC`)
        .all() as CampaignRow[]);
  return rows.map(rowToCampaign);
}

export function updateCampaignStatus(id: string, status: CampaignStatus): void {
  // Enforces legal state-machine transitions; planned→running race is handled separately by tryTransitionCampaignToRunning's CAS.
  const current = getCampaign(id);
  if (!current) throw new Error(`Campaign ${id} not found`);
  if (!isCampaignTransitionAllowed(current.status, status)) {
    throw new Error(`Illegal campaign transition ${current.status} -> ${status}`);
  }
  getDb()
    .prepare(`UPDATE campaigns SET status = ?, updated_at = ? WHERE id = ?`)
    .run(status, nowIso(), id);
}

export function setPlanHash(id: string, planHash: string): void {
  getDb()
    .prepare(`UPDATE campaigns SET plan_hash = ?, updated_at = ? WHERE id = ?`)
    .run(planHash, nowIso(), id);
}

export function addCampaignItem(opts: {
  campaignId: string;
  itemOrder: number;
  ticketId: string;
}): CampaignItem {
  const now = nowIso();
  const item: CampaignItem = {
    id: newCampaignItemId(),
    campaignId: opts.campaignId,
    itemOrder: opts.itemOrder,
    ticketId: opts.ticketId,
    lifecycleStatus: "pending",
    // FG-596: a fresh item has NOT been dispatched yet — 0 is the never-allocated
    // marker (the DB column DEFAULT 0 supplies the same value for the INSERT below).
    attemptGeneration: 0,
    createdAt: now,
    updatedAt: now,
  };
  getDb()
    .prepare(
      `INSERT INTO campaign_items
         (id, campaign_id, item_order, ticket_id, run_id, branch, worktree_path, pr_url,
          lifecycle_status, outcome, blocker_kind, continue_policy, reason,
          requested_human_action, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      item.id,
      item.campaignId,
      item.itemOrder,
      item.ticketId,
      null,
      null,
      null,
      null,
      item.lifecycleStatus,
      null,
      null,
      null,
      null,
      null,
      item.createdAt,
      item.updatedAt
    );
  return item;
}

export function getCampaignItem(id: string): CampaignItem | undefined {
  const row = getDb()
    .prepare(`SELECT * FROM campaign_items WHERE id = ?`)
    .get(id) as CampaignItemRow | undefined;
  return row ? rowToCampaignItem(row) : undefined;
}

export function listCampaignItems(campaignId: string): CampaignItem[] {
  const rows = getDb()
    .prepare(`SELECT * FROM campaign_items WHERE campaign_id = ? ORDER BY item_order ASC`)
    .all(campaignId) as CampaignItemRow[];
  return rows.map(rowToCampaignItem);
}

export type CampaignItemUpdate = {
  lifecycleStatus?: CampaignItemLifecycleStatus;
  outcome?: CampaignItemOutcome;
  blockerKind?: BlockerKind;
  continuePolicy?: ContinuePolicy;
  reason?: string;
  requestedHumanAction?: string;
  runId?: string;
  branch?: string;
  worktreePath?: string;
  prUrl?: string;
  attemptGeneration?: number;
};

const ITEM_UPDATE_COLUMNS: Record<keyof CampaignItemUpdate, string> = {
  lifecycleStatus: "lifecycle_status",
  outcome: "outcome",
  blockerKind: "blocker_kind",
  continuePolicy: "continue_policy",
  reason: "reason",
  requestedHumanAction: "requested_human_action",
  runId: "run_id",
  branch: "branch",
  worktreePath: "worktree_path",
  prUrl: "pr_url",
  attemptGeneration: "attempt_generation",
};

// FG-410: the three campaign-item writers below used to read the row, merge the
// update over it, and write back all ten mutable columns. Two writers touching
// DISJOINT fields of one item lost the first writer's field: both read before
// either wrote, and the second full-row write restored the stale value it had
// read. This builds a SET clause from only the columns the caller actually named,
// so a writer never writes a column it didn't ask to change — the FG-396
// parallel-lanes prerequisite.
//
// Presence, not definedness, is what selects a column: callers CLEAR fields by
// passing an explicit `undefined` (executor.ts's reset-before-retry paths), which
// must still write NULL, while an absent key must leave the column untouched.
// TypeScript's optional properties make those two cases indistinguishable at the
// type level, so the runtime own-property check is the whole mechanism.
//
// An update naming zero columns still touches updated_at (and, for the guarded
// variants, still reports whether the guard passed) — that is exactly what the
// read-merge-write version did, and no caller depends on it either way.
function buildItemUpdateSet(update: CampaignItemUpdate): { setClause: string; params: unknown[] } {
  const assignments: string[] = [];
  const params: unknown[] = [];
  for (const key of Object.keys(update) as (keyof CampaignItemUpdate)[]) {
    const column = ITEM_UPDATE_COLUMNS[key];
    if (!column) continue;
    assignments.push(`${column} = ?`);
    params.push(update[key] ?? null);
  }
  assignments.push("updated_at = ?");
  params.push(nowIso());
  return { setClause: assignments.join(", "), params };
}

// FG-442: a campaign may also be re-approved while 'paused' — the escalation
// path (updateCampaignPlanForReapproval below) produces a fresh unapproved
// plan_hash on a paused campaign, and this is the SAME confirm/override point
// used at first approval, not a new command. 'planned' stays supported for the
// original pre-execution approval.
//
// FG-442 re-review: the paused-reapproval guard lives entirely in this UPDATE's
// WHERE clause (compare-and-swap), not in a separate SELECT check, so a
// concurrent write can't slip through between a read and this write. It is also
// kept symmetric with the CLI guard (campaign.ts's approve command): a paused
// campaign is only approvable when its plan_hash has actually moved AND no item
// is still blocked on an unresolved lane_escalation — calling this store
// primitive directly must not be a weaker path than going through the CLI.
export function approveCampaign(
  id: string,
  opts: { approvedBy?: string; rationale: string }
): boolean {
  const campaign = getCampaign(id);
  if (!campaign || (campaign.status !== "planned" && campaign.status !== "paused")) return false;
  const result = getDb()
    .prepare(
      `UPDATE campaigns
          SET approved_by = ?, approved_at = ?, approval_rationale = ?,
              approved_plan_hash = plan_hash, updated_at = ?
        WHERE id = ?
          AND (
            status = 'planned'
            OR (
              status = 'paused'
              AND plan_hash IS NOT approved_plan_hash
              AND NOT EXISTS (
                SELECT 1 FROM campaign_items
                WHERE campaign_id = campaigns.id
                  AND lifecycle_status = 'failed'
                  AND outcome = 'blocked'
                  AND blocker_kind = 'lane_escalation'
              )
            )
          )`
    )
    .run(opts.approvedBy ?? null, nowIso(), opts.rationale, nowIso(), id);
  return (result.changes ?? 0) > 0;
}

// FG-442: escalation store primitive. Mutates an EXISTING paused campaign's
// sourceInput + planContent + plan_hash in place, producing a fresh UNAPPROVED
// baseline — there was no prior way to mutate a campaign's planContent or
// re-approve anything but a 'planned' campaign, so 'reuse the approve state
// machine' was not implementable for an outgrown-lane item. Pure DB write; the
// caller (campaign/executor.ts) is responsible for re-resolving the plan via
// resolvePlan so canonicalContent/planHash stay consistent with sourceInput —
// this function does not import campaign/planner.ts to avoid a store->business
// logic circular dependency.
export function updateCampaignPlanForReapproval(
  id: string,
  opts: { sourceInput: Record<string, unknown>; metadata: Record<string, unknown>; planHash: string }
): boolean {
  const result = getDb()
    .prepare(
      `UPDATE campaigns
          SET source_input = ?, metadata = ?, plan_hash = ?, updated_at = ?
        WHERE id = ? AND status = 'paused'`
    )
    .run(JSON.stringify(opts.sourceInput), JSON.stringify(opts.metadata), opts.planHash, nowIso(), id);
  return (result.changes ?? 0) > 0;
}

export function tryTransitionCampaign(id: string, from: CampaignStatus, to: CampaignStatus): boolean {
  const result = getDb()
    .prepare(`UPDATE campaigns SET status = ?, updated_at = ? WHERE id = ? AND status = ?`)
    .run(to, nowIso(), id, from);
  return (result.changes ?? 0) > 0;
}

export function tryTransitionCampaignToRunning(id: string): boolean {
  return tryTransitionCampaign(id, "planned", "running");
}

// FG-750 (RF-2): an operator `forge campaign pause` is a CAMPAIGN-scoped stop and must
// carry a durable named reason (the AC3 invariant) so a cross-process item-scoped-park
// continuation can never mistake it for the controller's own item-park pause and resume
// over it. The CAS running→paused and the durable `operatorPaused` marker are set in ONE
// transaction, so an operator pause that wins the CAS is ALWAYS accompanied by its marker
// — there is no window where the campaign is paused-by-operator without the flag. Returns
// the CAS commit result (false when a concurrent item-park already paused the campaign; in
// that ordering the operator's command reports the campaign is not running, as before).
export function tryOperatorPauseCampaign(id: string): boolean {
  return writeTransaction((): boolean => {
    const db = getDb();
    const iso = nowIso();
    const row = db.prepare(`SELECT metadata FROM campaigns WHERE id = ? AND status = 'running'`).get(id) as
      | { metadata: string | null }
      | undefined;
    if (!row) return false;
    const metadata = row.metadata ? (JSON.parse(row.metadata) as Record<string, unknown>) : {};
    metadata.operatorPaused = true;
    db.prepare(`UPDATE campaigns SET status = 'paused', metadata = ?, updated_at = ? WHERE id = ? AND status = 'running'`)
      .run(JSON.stringify(metadata), iso, id);
    return true;
  });
}

// FG-750 (RF-2): clear the operator-pause marker as part of an operator-driven resume, so
// the NEXT item-scoped park is free to continue normally. The controller's own item-park
// resume never touches this — it only continues when the marker is ABSENT.
export function clearOperatorPauseMarker(id: string): void {
  writeTransaction((): void => {
    const db = getDb();
    const row = db.prepare(`SELECT metadata FROM campaigns WHERE id = ?`).get(id) as
      | { metadata: string | null }
      | undefined;
    if (!row?.metadata) return;
    const metadata = JSON.parse(row.metadata) as Record<string, unknown>;
    if (!("operatorPaused" in metadata)) return;
    delete metadata.operatorPaused;
    db.prepare(`UPDATE campaigns SET metadata = ?, updated_at = ? WHERE id = ?`).run(
      JSON.stringify(metadata),
      nowIso(),
      id,
    );
  });
}

// FG-750 (RF-2): does a durable operator-pause marker hold this campaign? The dispatch
// decision point reads this before an item-scoped-park continuation resumes the campaign —
// a set marker means an operator PAUSED the whole campaign and dispatch must NOT continue.
export function isCampaignOperatorPaused(id: string): boolean {
  const row = getDb().prepare(`SELECT metadata FROM campaigns WHERE id = ?`).get(id) as
    | { metadata: string | null }
    | undefined;
  if (!row?.metadata) return false;
  return (JSON.parse(row.metadata) as Record<string, unknown>).operatorPaused === true;
}

// FG-428: guarded write for `campaign reconcile` — the campaign-status check and
// the item mutation must be a single atomic operation, or a concurrent
// resume/start could flip the campaign out of 'paused' between a plain read and
// this write. The subquery reads campaigns.status as part of the same UPDATE
// statement/transaction, so it can never observe a stale snapshot: if the
// campaign is no longer 'paused' when this statement executes, zero rows change.
// The `campaign_id = ?` clause additionally enforces that id actually belongs to
// campaignId, so a caller cannot mutate one campaign's item by naming a different
// (paused) campaignId.
// Returns true iff the item belonged to campaignId, that campaign was still
// 'paused', and the write landed. FG-410 dropped the pre-read, so a missing item
// and a status mismatch both surface as zero rows changed — both returned false
// before, so the contract is unchanged.
export function updateCampaignItemIfCampaignPaused(
  id: string,
  campaignId: string,
  update: CampaignItemUpdate
): boolean {
  const { setClause, params } = buildItemUpdateSet(update);
  const result = getDb()
    .prepare(
      `UPDATE campaign_items SET ${setClause}
       WHERE id = ?
         AND campaign_id = ?
         AND (SELECT status FROM campaigns WHERE id = ?) = 'paused'`
    )
    .run(...params, id, campaignId, campaignId);
  return (result.changes ?? 0) > 0;
}

// FG-441: guarded write for the campaign-resume evidence-reconcile path — same
// atomicity contract as updateCampaignItemIfCampaignPaused above, but gated on
// 'running' rather than 'paused'. resumeCampaign transitions the campaign
// paused->running BEFORE driveRemainingItems runs (see executor.ts), so by the
// time a resume-reconcile write happens the campaign is already 'running', not
// 'paused' — using the paused-only guard here would make every such write a
// silent no-op. The subquery reads campaigns.status as part of the same UPDATE
// statement, so a concurrent pause/abandon between the evidence check and this
// write is still caught atomically: zero rows change and no optimistic ship occurs.
export function updateCampaignItemIfCampaignRunning(
  id: string,
  campaignId: string,
  update: CampaignItemUpdate
): boolean {
  const { setClause, params } = buildItemUpdateSet(update);
  const result = getDb()
    .prepare(
      `UPDATE campaign_items SET ${setClause}
       WHERE id = ?
         AND campaign_id = ?
         AND (SELECT status FROM campaigns WHERE id = ?) = 'running'`
    )
    .run(...params, id, campaignId, campaignId);
  return (result.changes ?? 0) > 0;
}

// FG-754: the durable marker that distinguishes an item terminalized BECAUSE its
// campaign was abandoned from one that reached 'failed' by genuine work failure.
// Stored in the existing `reason` column (NO schema migration); the `outcome`
// column carries a valid CampaignItemOutcome ('failed'), so no new item-lifecycle
// or outcome enum member is introduced and no terminal-set consumer has to change.
// History (forge campaign show/report) tells the two apart by this prefix.
export const CAMPAIGN_ABANDONED_ITEM_REASON_PREFIX = "campaign_abandoned";

export function campaignAbandonedItemReason(iso: string): string {
  return `${CAMPAIGN_ABANDONED_ITEM_REASON_PREFIX} at ${iso}`;
}

// FG-754: the item lifecycles this abandonment terminalize acts on. The genuinely
// terminal item set is {complete, failed}; every other lifecycle still surfaces as
// live work (runs.ts NON_TERMINAL_TASK_STATES). blocked_by_red is one of those
// non-terminal, reviewer-PARKED states — not a live container — so an abandoned
// campaign that leaves it untouched keeps rendering it forever (RF-1). These five
// are the non-terminal complement EXCEPT 'running', which is deliberately excluded
// (risk #1): a genuinely-running item has a LIVE container, and force-abandoning it
// here would kill work the CLI abandon path never routed through the executor drive
// loop. A running item under an abandoned campaign is left to the executor's own
// abandon handling + the container reaper; the surface vetoes (current-activity /
// inFlight) hide it in the meantime.
const ABANDON_TERMINALIZABLE_LIFECYCLE: readonly CampaignItemLifecycleStatus[] = [
  "pending",
  "awaiting_gate",
  "awaiting_red",
  "blocked_by_red",
  "awaiting_recovery",
];

// FG-754: among terminalizable items, only a PARKED one — no live container — may
// have its still-active linked run force-flipped to 'abandoned'. awaiting_red may
// still have red-review containers in flight, and 'pending' has no dispatched run,
// so they are excluded (risk #1). blocked_by_red IS parked — the red review already
// returned its blocking verdict, so nothing is in flight — and the run-orphan
// invariant lists it in the parked set alongside awaiting_gate / awaiting_recovery
// (RF-2). The item's lifecycle_status IS the primary task's status, so this is the
// parked-task gate.
const ABANDON_RUN_FLIP_PARKED_LIFECYCLE: readonly CampaignItemLifecycleStatus[] = [
  "awaiting_gate",
  "blocked_by_red",
  "awaiting_recovery",
];

// FG-754: guarded item-terminalize CAS, the sibling of updateCampaignItemIfCampaign
// Paused/Running above. Gated on campaign.status='abandoned' AND the item still being
// terminalizable, both read inside the same UPDATE so a concurrent transition can
// never slip a stale snapshot through: if the campaign is not abandoned, or the item
// already terminal (or a live 'running' container), zero rows change. Sets
// lifecycle_status -> 'failed', a valid 'failed' outcome, and the durable abandonment
// marker in `reason`. PRESERVES the row (UPDATE, never DELETE). Returns true iff the
// terminalize landed.
export function terminalizeCampaignItemIfCampaignAbandoned(id: string, campaignId: string): boolean {
  const iso = nowIso();
  const placeholders = ABANDON_TERMINALIZABLE_LIFECYCLE.map(() => "?").join(", ");
  const result = getDb()
    .prepare(
      `UPDATE campaign_items
          SET lifecycle_status = 'failed', outcome = 'failed', reason = ?, updated_at = ?
        WHERE id = ?
          AND campaign_id = ?
          AND lifecycle_status IN (${placeholders})
          AND (SELECT status FROM campaigns WHERE id = ?) = 'abandoned'`
    )
    .run(campaignAbandonedItemReason(iso), iso, id, campaignId, ...ABANDON_TERMINALIZABLE_LIFECYCLE, campaignId);
  return (result.changes ?? 0) > 0;
}

export type CampaignAbandonTerminalization = {
  itemId: string;
  ticketId: string;
  runId: string | null;
  previousLifecycle: CampaignItemLifecycleStatus;
  reason: string;
  runAbandoned: boolean;
};

// FG-754: the batch primitive. Inside ONE BEGIN IMMEDIATE transaction (mirroring
// reserveCampaignDriveDispatch's envelope) terminalizes EVERY non-terminal item of an
// abandoned campaign via the guarded CAS above, and flips each PARKED item's still-
// active linked run to 'abandoned'. No-op (returns []) unless the campaign is actually
// 'abandoned', so an observer can never see campaign='abandoned' with a still-live
// item/run once this commits. Idempotent: a re-run finds every item already terminal
// and changes nothing.
export function terminalizeAbandonedCampaignItems(campaignId: string): CampaignAbandonTerminalization[] {
  return writeTransaction(() => terminalizeAbandonedCampaignItemsTx(campaignId));
}

// Assumes it runs INSIDE a write transaction (called directly by the atomic abandon
// path, or via terminalizeAbandonedCampaignItems' own envelope). Reads the campaign
// status inside the transaction so the atomic-abandon caller's just-committed flip is
// visible.
function terminalizeAbandonedCampaignItemsTx(campaignId: string): CampaignAbandonTerminalization[] {
  const campaign = getCampaign(campaignId);
  if (!campaign || campaign.status !== "abandoned") return [];
  const results: CampaignAbandonTerminalization[] = [];
  for (const item of listCampaignItems(campaignId)) {
    if (!ABANDON_TERMINALIZABLE_LIFECYCLE.includes(item.lifecycleStatus)) continue;
    if (!terminalizeCampaignItemIfCampaignAbandoned(item.id, campaignId)) continue;
    let runAbandoned = false;
    if (item.runId && ABANDON_RUN_FLIP_PARKED_LIFECYCLE.includes(item.lifecycleStatus)) {
      const run = getRun(item.runId);
      // Flip only a genuinely-active run of a parked item; never cross a run that has
      // already reached its own terminal truth (updateRunStatus enforces the same).
      if (run && run.status === "active") {
        updateRunStatus(item.runId, "abandoned");
        runAbandoned = true;
      }
    }
    const updated = getCampaignItem(item.id);
    results.push({
      itemId: item.id,
      ticketId: item.ticketId,
      runId: item.runId ?? null,
      previousLifecycle: item.lifecycleStatus,
      reason: updated?.reason ?? campaignAbandonedItemReason(nowIso()),
      runAbandoned,
    });
  }
  return results;
}

// FG-754: the atomic abandon primitive for `forge campaign abandon` (step 2). CAS the
// campaign from→abandoned and, only if that flip wins, terminalize its items + parked
// runs — ALL in one transaction, so status-flip + item + run terminalize commit
// together. `transitioned` is false when the CAS lost (someone else moved the campaign
// off `from` first); no terminalize runs in that case.
export function abandonCampaignAndTerminalizeItems(
  campaignId: string,
  from: CampaignStatus
): { transitioned: boolean; terminalizations: CampaignAbandonTerminalization[] } {
  return writeTransaction(() => {
    const flipped = getDb()
      .prepare(`UPDATE campaigns SET status = 'abandoned', updated_at = ? WHERE id = ? AND status = ?`)
      .run(nowIso(), campaignId, from);
    if ((flipped.changes ?? 0) === 0) return { transitioned: false, terminalizations: [] };
    return { transitioned: true, terminalizations: terminalizeAbandonedCampaignItemsTx(campaignId) };
  });
}

export type AbandonedReapCandidate = {
  campaignId: string;
  itemId: string;
  ticketId: string;
  lifecycleStatus: CampaignItemLifecycleStatus;
  runId: string | null;
};

// FG-754: the reaper's candidate set (step 5) — every terminalizable item of an
// ALREADY-abandoned campaign. The JOIN to campaigns is the entire AC4 correctness
// guarantee: a paused/planned/running campaign's items are structurally unreachable,
// so the reaper can never touch them. Pure read (no transaction); used by --dry-run to
// list identities and by the live run to know which campaigns to batch.
export function listAbandonedReapCandidates(): AbandonedReapCandidate[] {
  const placeholders = ABANDON_TERMINALIZABLE_LIFECYCLE.map(() => "?").join(", ");
  const rows = getDb()
    .prepare(
      `SELECT ci.campaign_id, ci.id, ci.ticket_id, ci.lifecycle_status, ci.run_id
         FROM campaign_items ci
         JOIN campaigns c ON c.id = ci.campaign_id
        WHERE c.status = 'abandoned'
          AND ci.lifecycle_status IN (${placeholders})
        ORDER BY ci.campaign_id ASC, ci.item_order ASC`
    )
    .all(...ABANDON_TERMINALIZABLE_LIFECYCLE) as Array<{
    campaign_id: string;
    id: string;
    ticket_id: string;
    lifecycle_status: string;
    run_id: string | null;
  }>;
  return rows.map((r) => ({
    campaignId: r.campaign_id,
    itemId: r.id,
    ticketId: r.ticket_id,
    lifecycleStatus: r.lifecycle_status as CampaignItemLifecycleStatus,
    runId: r.run_id ?? null,
  }));
}

// FG-753: guarded write for `campaign reconcile --terminal-recovery` — the
// terminal analogue of updateCampaignItemIfCampaignPaused/Running. A `complete`
// campaign has NO paused/running gate holding back a concurrent drive, so unlike
// those two variants atomicity here rests on a compare-and-set of the item's
// STILL-RESIDUAL shape (the lifecycleStatus + blockerKind observed at collect
// time) folded into the same UPDATE as the campaigns.status='complete' subquery.
// If the item has since been re-derived or concurrently mutated (its shape
// moved), OR the campaign is no longer 'complete', zero rows change and no
// optimistic ship occurs — the SAME single-statement guarantee the paused/running
// variants get from their status subquery. `blocker_kind IS ?` (not `= ?`) so the
// out-of-band residual shape (NULL blocker) binds correctly rather than matching
// nothing. Returns true iff the item belonged to campaignId, that campaign was
// still 'complete', the item still carried the observed residual shape, and the
// write landed.
export function updateCampaignItemIfCampaignCompleteAndShape(
  id: string,
  campaignId: string,
  observedShape: { lifecycleStatus: CampaignItemLifecycleStatus; blockerKind: BlockerKind | null },
  update: CampaignItemUpdate
): boolean {
  const { setClause, params } = buildItemUpdateSet(update);
  const result = getDb()
    .prepare(
      `UPDATE campaign_items SET ${setClause}
       WHERE id = ?
         AND campaign_id = ?
         AND (SELECT status FROM campaigns WHERE id = ?) = 'complete'
         AND lifecycle_status = ?
         AND blocker_kind IS ?`
    )
    .run(...params, id, campaignId, campaignId, observedShape.lifecycleStatus, observedShape.blockerKind);
  return (result.changes ?? 0) > 0;
}

export function updateCampaignItem(id: string, update: CampaignItemUpdate): void {
  const { setClause, params } = buildItemUpdateSet(update);
  getDb()
    .prepare(`UPDATE campaign_items SET ${setClause} WHERE id = ?`)
    .run(...params, id);
}

// FG-596 (redesign): the ONE atomic pre-dispatch transaction for a run-producing lane.
// Establishes the COMPLETE pre-dispatch invariant — generation, dispatch key, run row,
// item linkage, and the pending→running CAS — in a SINGLE BEGIN IMMEDIATE transaction, so
// no partial shape ("running item with no run", "run created but not linked") is ever
// representable. Only after this commits may the physical dispatch (container work,
// runNext) begin, OUTSIDE the transaction.
//
// The five steps, atomically:
//   1. allocate OR reuse the logical attempt generation — allocate (0 → 1) only for a
//      genuinely new attempt; REUSE a persisted non-zero generation on a re-drive of the
//      SAME attempt (an explicit retry is the only thing that bumps it, out of band), so
//      the derived key stays stable and the in-flight run stays adoptable;
//   2. derive the deterministic dispatch_key = H(campaignId, itemId, generation);
//   3. if a run ALREADY exists at that key (a crash-window re-drive, or a concurrent
//      winner), ADOPT it — link it and mark the item running, creating NOTHING;
//   4. otherwise CAS the item pending→running (gated on the campaign still running);
//   5. only if that CAS won, create the run row (stamped with the key + generation, via
//      the caller's createRun) and link its id onto the item.
//
// A concurrent LOSER — a second drive of the same item — is handled by construction: its
// tx runs after the winner commits (BEGIN IMMEDIATE serializes writers), so it observes
// the persisted generation and the winner's run at the derived key and ADOPTS it. It
// allocates no new generation and creates no second run. If the item is no longer
// drivable (campaign paused/abandoned, or the item parked out from under it) it returns
// `lost` and creates nothing.
//
// createRun MUST insert exactly one run row (stamped with the passed dispatchKey +
// attemptGeneration) and return its id; it runs INSIDE this transaction, so if it throws
// the whole reservation rolls back and NO partial state survives (crash-before-commit →
// item still pending, no run). It must not open its own transaction.
export type CampaignDriveReservation =
  | { status: "created"; runId: string; attemptGeneration: number; dispatchKey: string }
  | { status: "adopted"; runId: string; attemptGeneration: number; dispatchKey: string }
  | { status: "lost" };

export function reserveCampaignDriveDispatch(opts: {
  campaignId: string;
  itemId: string;
  createRun: (ctx: { dispatchKey: string; attemptGeneration: number }) => string;
}): CampaignDriveReservation {
  const { campaignId, itemId, createRun } = opts;
  return writeTransaction(() => {
    const item = getCampaignItem(itemId);
    if (!item || item.campaignId !== campaignId) return { status: "lost" } as const;

    // (1) reuse a persisted generation (>0); allocate the first one (0 → 1) otherwise.
    const attemptGeneration = item.attemptGeneration > 0 ? item.attemptGeneration : 1;
    // (2) derive the deterministic key from the resolved generation.
    const dispatchKey = deriveCampaignItemDispatchKey(campaignId, itemId, attemptGeneration);
    const now = nowIso();

    // (3) ADOPT an already-created run at this key (crash-window re-drive, or the winner a
    // concurrent loser now observes). Link + mark running, gated on the campaign still
    // running and the item still drivable — never resurrect a terminal/parked item.
    const existing = runByDispatchKey(dispatchKey);
    if (existing) {
      const adopted = getDb()
        .prepare(
          `UPDATE campaign_items SET run_id = ?, lifecycle_status = 'running', attempt_generation = ?, updated_at = ?
           WHERE id = ?
             AND campaign_id = ?
             AND lifecycle_status IN ('pending', 'running')
             AND (SELECT status FROM campaigns WHERE id = ?) = 'running'`
        )
        .run(existing.id, attemptGeneration, now, itemId, campaignId, campaignId);
      if ((adopted.changes ?? 0) === 0) return { status: "lost" } as const;
      return { status: "adopted", runId: existing.id, attemptGeneration, dispatchKey } as const;
    }

    // (4) CLAIM the item pending→running (persisting the generation), gated on the campaign
    // still running. A losing tx (item already off 'pending', or a paused/abandoned
    // campaign) changes nothing and creates no run.
    const claimed = getDb()
      .prepare(
        `UPDATE campaign_items SET lifecycle_status = 'running', attempt_generation = ?, updated_at = ?
         WHERE id = ?
           AND campaign_id = ?
           AND lifecycle_status = 'pending'
           AND (SELECT status FROM campaigns WHERE id = ?) = 'running'`
      )
      .run(attemptGeneration, now, itemId, campaignId, campaignId);
    if ((claimed.changes ?? 0) === 0) return { status: "lost" } as const;

    // (5) create the stamped run row and link it — inside the same tx, so the row insert,
    // the linkage, and the CAS above commit together or not at all.
    const runId = createRun({ dispatchKey, attemptGeneration });
    getDb()
      .prepare(`UPDATE campaign_items SET run_id = ?, updated_at = ? WHERE id = ?`)
      .run(runId, nowIso(), itemId);
    return { status: "created", runId, attemptGeneration, dispatchKey } as const;
  });
}

// FG-596 (A6): guarded item park for the launch-boundary containment. Applies the update
// ONLY while the item is still 'pending' — its pre-drive state. If the drive-item child
// already reserved and dispatched the item (pending→running inside
// reserveCampaignDriveDispatch) in the launch race, this is a no-op (returns false) and the
// containment must NOT clobber the live drive nor pause the campaign behind it. Same
// single-statement CAS shape as the campaign-status guards above; the 'pending' precondition
// is shared with the reservation's claim so the two can never both win.
export function updateCampaignItemIfPending(
  id: string,
  campaignId: string,
  update: CampaignItemUpdate,
): boolean {
  const { setClause, params } = buildItemUpdateSet(update);
  const result = getDb()
    .prepare(
      `UPDATE campaign_items SET ${setClause}
       WHERE id = ?
         AND campaign_id = ?
         AND lifecycle_status = 'pending'`
    )
    .run(...params, id, campaignId);
  return (result.changes ?? 0) > 0;
}

// FG-596: the DETERMINISTIC dispatch key for a campaign item's drive-item run. A pure
// function of (campaignId, itemId, PERSISTED attemptGeneration) — NEVER of a run-row
// count, a run id, or the random launch id — so a recovery re-derives the SAME key
// from durable state and resolves the ONE in-flight run via runByDispatchKey instead
// of duplicating it. Deliberately NOT the FG-562 continuations.deriveDispatchKey: the
// two identity spaces are distinct and must not collide. Stamped into run
// metadata.dispatchKey (the same slot startRun uses) on all three dispatch lanes.
export function deriveCampaignItemDispatchKey(
  campaignId: string,
  itemId: string,
  attemptGeneration: number,
): string {
  const h = createHash("sha256");
  // JSON-encode the tuple so the fields are unambiguously delimited: JSON escapes any
  // quote/backslash in an id, so ('a b','c') and ('a','b c') can never collide the
  // way an un-escaped join would.
  h.update(`campaign-item-drive ${JSON.stringify([campaignId, itemId, attemptGeneration])}`);
  return `ci-${h.digest("hex").slice(0, 32)}`;
}
