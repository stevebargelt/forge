import { getDb } from "./db.js";
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
  };
  getDb()
    .prepare(
      `INSERT INTO campaigns (id, status, source_kind, source_input, mode, created_at, updated_at, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      campaign.id,
      campaign.status,
      campaign.sourceKind,
      JSON.stringify(campaign.sourceInput),
      campaign.mode,
      campaign.createdAt,
      campaign.updatedAt,
      campaign.metadata ? JSON.stringify(campaign.metadata) : null
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
  getDb()
    .prepare(`UPDATE campaigns SET status = ?, updated_at = ? WHERE id = ?`)
    .run(status, nowIso(), id);
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
