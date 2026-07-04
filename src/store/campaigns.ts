import { getDb } from "./db.js";
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
  getDb()
    .prepare(
      `INSERT INTO campaigns (id, status, source_kind, source_input, mode, created_at, updated_at, metadata, project_dir)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
      campaign.projectDir ?? null
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
};

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
// 'paused', and the write landed.
export function updateCampaignItemIfCampaignPaused(
  id: string,
  campaignId: string,
  update: CampaignItemUpdate
): boolean {
  const existing = getCampaignItem(id);
  if (!existing) return false;
  const next = { ...existing, ...update };
  const result = getDb()
    .prepare(
      `UPDATE campaign_items SET
         lifecycle_status = ?, outcome = ?, blocker_kind = ?, continue_policy = ?,
         reason = ?, requested_human_action = ?, run_id = ?, branch = ?,
         worktree_path = ?, pr_url = ?, updated_at = ?
       WHERE id = ?
         AND campaign_id = ?
         AND (SELECT status FROM campaigns WHERE id = ?) = 'paused'`
    )
    .run(
      next.lifecycleStatus,
      next.outcome ?? null,
      next.blockerKind ?? null,
      next.continuePolicy ?? null,
      next.reason ?? null,
      next.requestedHumanAction ?? null,
      next.runId ?? null,
      next.branch ?? null,
      next.worktreePath ?? null,
      next.prUrl ?? null,
      nowIso(),
      id,
      campaignId,
      campaignId
    );
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
  const existing = getCampaignItem(id);
  if (!existing) return false;
  const next = { ...existing, ...update };
  const result = getDb()
    .prepare(
      `UPDATE campaign_items SET
         lifecycle_status = ?, outcome = ?, blocker_kind = ?, continue_policy = ?,
         reason = ?, requested_human_action = ?, run_id = ?, branch = ?,
         worktree_path = ?, pr_url = ?, updated_at = ?
       WHERE id = ?
         AND campaign_id = ?
         AND (SELECT status FROM campaigns WHERE id = ?) = 'running'`
    )
    .run(
      next.lifecycleStatus,
      next.outcome ?? null,
      next.blockerKind ?? null,
      next.continuePolicy ?? null,
      next.reason ?? null,
      next.requestedHumanAction ?? null,
      next.runId ?? null,
      next.branch ?? null,
      next.worktreePath ?? null,
      next.prUrl ?? null,
      nowIso(),
      id,
      campaignId,
      campaignId
    );
  return (result.changes ?? 0) > 0;
}

export function updateCampaignItem(id: string, update: CampaignItemUpdate): void {
  const existing = getCampaignItem(id);
  if (!existing) return;
  const next = { ...existing, ...update };
  getDb()
    .prepare(
      `UPDATE campaign_items SET
         lifecycle_status = ?, outcome = ?, blocker_kind = ?, continue_policy = ?,
         reason = ?, requested_human_action = ?, run_id = ?, branch = ?,
         worktree_path = ?, pr_url = ?, updated_at = ?
       WHERE id = ?`
    )
    .run(
      next.lifecycleStatus,
      next.outcome ?? null,
      next.blockerKind ?? null,
      next.continuePolicy ?? null,
      next.reason ?? null,
      next.requestedHumanAction ?? null,
      next.runId ?? null,
      next.branch ?? null,
      next.worktreePath ?? null,
      next.prUrl ?? null,
      nowIso(),
      id
    );
}
