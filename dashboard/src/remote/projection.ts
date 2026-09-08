// FG-781: the Remote Board PROJECTION CONTRACT — a positive-allowlist, project-scoped,
// read-only assembly of the five remote DTOs the Remote Board surface exposes.
//
// WHY THIS MODULE EXISTS. The Remote Board enlarges the dashboard's trust boundary from a
// trusted loopback consumer to a surface a later trusted proxy (FG-782/FG-784) can front.
// The reused internal query/projection functions in queries.ts / attention-inbox / campaign
// report carry loopback-only payloads: host filesystem paths, launch argv, CI/remote-control
// URLs, review artifacts, dispatcher/lease control-plane detail, and — crucially — CROSS-
// PROJECT holder/aggregate rows. None of that may cross the remote boundary.
//
// THE DISCIPLINE (protected invariant #6). Every remote DTO here is a POSITIVE ALLOWLIST:
// each field is copied EXPLICITLY from its source, one named property at a time. No mapper
// spreads a source object, returns a source object, or does `{ ...source }`. That is the ONE
// property that keeps the contract sealed as the internal shapes evolve: when a reused query
// grows a new field (a new path, a new URL, a new cross-project column), it lands in the
// internal shape and simply never reaches a remote DTO, because no mapper here names it.
// projection.contract.test.ts enforces this two ways — a runtime injection test (forbidden
// fields planted on the source objects never appear in the output) and a source-drift scrape
// (no mapper may spread a source), so the seal cannot rot silently.
//
// SCOPE (protected invariants #3/#4). The assembler consumes an EXPLICIT, server-resolved
// member-dir scope (RemoteProjectGrant.memberDirs) and the resolved ProjectRecord. It NEVER
// consults a client projectKey/projectDir parameter, and it NEVER calls resolveProjectScope:
// that resolver applies the FG-745 owner-convergence WIDENING (an owner key pulls in a
// separately-identified artifact's member dirs), which is correct for the local operator
// board but wrong here — the remote board is pinned STRICTLY to the granted project's OWN
// member dirs. This is a deliberate, documented divergence; projection.integration.test.ts
// seeds the FG-745 sibling case and proves the widened dirs never enter the projection.
//
// FRESHNESS (protected invariant #8). The response is a discriminated envelope carrying an
// explicit generation stamp and one of five states — live / stale / host-unavailable /
// unauthorized / unsupported. Data is present ONLY for live and stale; every closed/refused
// state carries `board: null`, so cached data can never be rendered as live.

import type { ProjectRecord } from "@forge/projects";
import type { Campaign } from "@forge/types";
import { runInReadOnlyDbScope } from "@forge/store-db";
import { assembleCampaignSummaries, type CampaignSummary } from "@forge/campaign-report";
import {
  attentionInbox,
  backlogTruthForProject,
  currentActivity,
  queueBoard,
  type BacklogTicket,
  type BacklogTruth,
  type QueueBoard,
  type QueueBoardRow,
  type QueueBoardView,
} from "../queries.js";
import type { InboxEnvelope, AttentionItem } from "../attention-inbox.js";
import type { CurrentActivityWithRetention } from "@forge/current-activity";

// ─── envelope + state discriminator (FG-781 AC5, contract half) ─────────────────

/** The five distinct states a remote board response can be in. `live` and `stale` carry
 *  data; the other three are refusals/degradations that carry NO project data. The set is
 *  closed so a client renders one of exactly five honest states and can never read a cached
 *  payload as live. */
export const REMOTE_BOARD_STATES = ["live", "stale", "host-unavailable", "unauthorized", "unsupported"] as const;
export type RemoteBoardState = (typeof REMOTE_BOARD_STATES)[number];

export type RemoteBoardEnvelope = {
  state: RemoteBoardState;
  /** ISO timestamp of the read that produced `board`. Never fabricated from "now" when the
   *  board is null — it is the generation stamp of the refusal itself. */
  generatedAt: string;
  /** Monotonic freshness stamp (epoch ms of the generating read). A client compares
   *  successive generations to know whether a payload advanced; it is the explicit half of
   *  "never present cached data as live". */
  generation: number;
  /** The project-scoped board — present ONLY for `live`/`stale`, null for every refusal. */
  board: RemoteBoard | null;
};

/** The five allowlist DTOs the remote board carries. `projectSummary`, plus the combined
 *  `backlog`/`queue` (the backlog/queue projection), `campaigns`, `inbox`, and `activity`. */
export type RemoteBoard = {
  projectSummary: RemoteProjectSummary;
  backlog: RemoteBacklogProjection;
  queue: RemoteQueueProjection;
  campaigns: RemoteCampaignSummary[];
  inbox: RemoteInbox;
  activity: RemoteActivitySummary;
};

// ─── DTO 1: project summary ─────────────────────────────────────────────────────
//
// Allowlisted from ProjectRecord. Deliberately EXCLUDES every host path (projectDir,
// primaryCheckout, projectDirs, checkouts), the github URL, the readme first line (repo
// content), and the owner/purpose/classification identity fields.

export type RemoteProjectSummary = {
  projectKey: string;
  label: string;
  color: string;
  description: string | null;
  lastRunAt: string | null;
  runCount: number;
  inFlightCount: number;
  liveSessions: number;
};

export function toRemoteProjectSummary(project: ProjectRecord): RemoteProjectSummary {
  return {
    projectKey: project.key,
    label: project.label,
    color: project.color,
    description: project.description ?? null,
    lastRunAt: project.lastRunAt ?? null,
    runCount: project.runCount,
    inFlightCount: project.inFlightCount,
    liveSessions: project.liveSessions,
  };
}

// ─── DTO 2a: backlog projection ─────────────────────────────────────────────────
//
// Allowlisted from BacklogTruth/BacklogTicket. EXCLUDES the ticket `body` (arbitrary free
// content) and `closedCommit` (a git SHA). Titles are the ticket's own board-facing label.

export type RemoteBacklogTicket = {
  id: string;
  type: string;
  status: string;
  title: string;
  epic: string | null;
  created: string | null;
  closed: string | null;
  related: string[];
};

export type RemoteBacklogProjection = {
  /** null = this repository has no ticket truth (never imported / not registered). */
  projectKey: string | null;
  storageMode: "db" | "markdown" | null;
  tickets: RemoteBacklogTicket[];
};

export function toRemoteBacklogTicket(ticket: BacklogTicket): RemoteBacklogTicket {
  return {
    id: ticket.id,
    type: ticket.type,
    status: ticket.status,
    title: ticket.title,
    epic: ticket.epic ?? null,
    created: ticket.created ?? null,
    closed: ticket.closed ?? null,
    related: ticket.related ? [...ticket.related] : [],
  };
}

export function toRemoteBacklog(truth: BacklogTruth): RemoteBacklogProjection {
  return {
    projectKey: truth.projectKey,
    storageMode: truth.storageMode,
    tickets: truth.tickets.map(toRemoteBacklogTicket),
  };
}

// ─── DTO 2b: queue projection ───────────────────────────────────────────────────
//
// Allowlisted from QueueBoard. Each row carries only the ticket-level board facts; the
// EXCLUDED surfaces are the ones that leak: reservation (claim owner / launch / run ids),
// blockers[].detail and readiness.gaps/refinementProposal (free-text host detail),
// enqueuedBy/note, scanReason/scanDetail, and — most importantly — the whole `dispatcher`
// panel (lease owner/host/pid, the autonomous-dispatch control plane) and `capacity`
// (cross-project holder rows: other projects' keys, tickets, launches). The free-text
// `wait.reason` is dropped too; only the closed `wait.kind` vocabulary survives. `views` is
// a partition of ticket ids into columns — ids only, safe to carry.

export type RemoteQueueRow = {
  ticketId: string;
  title: string;
  type: string;
  status: string;
  rank: number | null;
  queued: boolean;
  blocked: boolean;
  inProgress: boolean;
  executionState: string;
  view: QueueBoardView;
  /** The closed wait-kind vocabulary only — never the free-text dispatcher reason. */
  waitKind: string | null;
};

export type RemoteQueueProjection = {
  projectKey: string | null;
  storageMode: "db" | "markdown" | null;
  queueAvailable: boolean;
  unavailableReason: string | null;
  version: number;
  rows: RemoteQueueRow[];
  views: Record<QueueBoardView, string[]>;
};

export function toRemoteQueueRow(row: QueueBoardRow): RemoteQueueRow {
  return {
    ticketId: row.ticketId,
    title: row.title,
    type: row.type,
    status: row.status,
    rank: row.rank,
    queued: row.queued,
    blocked: row.blocked,
    inProgress: row.inProgress,
    executionState: row.executionState,
    view: row.view,
    waitKind: row.wait ? row.wait.kind : null,
  };
}

export function toRemoteQueue(board: QueueBoard): RemoteQueueProjection {
  // `views` is a Record<view, ticketId[]>; rebuild it column by column so a future field on
  // the source record can never ride along, and so the arrays are copies, not aliases.
  const views = {} as Record<QueueBoardView, string[]>;
  for (const view of Object.keys(board.views) as QueueBoardView[]) {
    views[view] = [...board.views[view]];
  }
  return {
    projectKey: board.projectKey,
    storageMode: board.storageMode,
    queueAvailable: board.queueAvailable,
    unavailableReason: board.unavailableReason,
    version: board.version,
    rows: board.rows.map(toRemoteQueueRow),
    views,
  };
}

// ─── DTO 3: campaign summary ────────────────────────────────────────────────────
//
// Allowlisted from CampaignSummary. EXCLUDES `projectDir` (a host path). Counts are this
// project's own, not a cross-project aggregate.

export type RemoteCampaignSummary = {
  campaignId: string;
  goal: string | null;
  mode: string;
  status: string;
  verdict: string;
  createdAt: string;
  updatedAt: string;
  counts: { shipped: number; blocked: number; held: number; skipped: number; failed: number; total: number };
  currentItem: { ticketId: string; title: string | null } | null;
};

export function toRemoteCampaignSummary(summary: CampaignSummary): RemoteCampaignSummary {
  return {
    campaignId: summary.campaignId,
    goal: summary.goal,
    mode: summary.mode,
    status: summary.status,
    verdict: summary.verdict,
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt,
    counts: {
      shipped: summary.counts.shipped,
      blocked: summary.counts.blocked,
      held: summary.counts.held,
      skipped: summary.counts.skipped,
      failed: summary.counts.failed,
      total: summary.counts.total,
    },
    currentItem: summary.currentItem
      ? { ticketId: summary.currentItem.ticketId, title: summary.currentItem.title }
      : null,
  };
}

// ─── DTO 4: attention inbox ─────────────────────────────────────────────────────
//
// Allowlisted from InboxEnvelope/AttentionItem. EXCLUDES the envelope `scope` (which carries
// projectDirs paths) and the item `links.projectDir`/`links.projectLabel`; only the id-only
// association links survive.

export type RemoteInboxLinks = {
  runId: string | null;
  taskId: string | null;
  ticketId: string | null;
  campaignId: string | null;
  itemId: string | null;
};

export type RemoteInboxItem = {
  id: string;
  kind: string;
  severity: string | null;
  startedAt: string | null;
  reason: string;
  requestedAction: string;
  source: string;
  links: RemoteInboxLinks;
};

export type RemoteInbox = {
  generatedAt: string;
  items: RemoteInboxItem[];
  empty: boolean;
  degraded: string[];
};

/** RF-1 (FG-781 AC4): `reason`/`requestedAction` are operator-authored free text on the
 *  attention source — the only unbounded strings that cross the remote boundary. Invariant #6
 *  forbids the DTO from carrying arbitrary filesystem paths or credentials/auth metadata, so
 *  every free-text field is passed through this redactor first: a defense-in-depth denylist
 *  layered UNDER the positive field allowlist (the allowlist keeps unnamed fields out; this
 *  keeps a path or secret from riding inside a named one). It is deliberately conservative —
 *  on a read-only remote surface an over-redacted word is strictly safer than a leaked path. */
const REMOTE_REDACTED = "[redacted]";
const REMOTE_FREE_TEXT_REDACTIONS: readonly RegExp[] = [
  // key=value / key: value credential pairs (token, secret, password, api_key, bearer, …).
  /\b(?:tokens?|secrets?|passwords?|passwd|pwd|api[_-]?keys?|access[_-]?keys?|secret[_-]?keys?|auth(?:orization)?|bearer|credentials?)\b\s*[:=]\s*\S+/gi,
  // Known credential token shapes (GitHub/OpenAI/Slack/AWS prefixes).
  /\b(?:ghp|gho|ghs|ghr|ghu|sk|xox[baprs]|AKIA|ASIA)[A-Za-z0-9_-]{8,}\b/g,
  // Windows absolute path.
  /[A-Za-z]:\\[^\s"']+/g,
  // POSIX absolute path (two or more segments), so a lone "/" or a fraction like "9/8" is left.
  /\/(?:[\w.@~%+-]+\/)+[\w.@~%+-]*/g,
  // Generic high-entropy token: 24+ chars mixing letters and digits (catches opaque secrets).
  /\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{24,}\b/g,
];

export function redactRemoteFreeText(text: string): string {
  let out = text;
  for (const pattern of REMOTE_FREE_TEXT_REDACTIONS) out = out.replace(pattern, REMOTE_REDACTED);
  return out;
}

export function toRemoteInboxItem(item: AttentionItem): RemoteInboxItem {
  return {
    id: item.id,
    kind: item.kind,
    severity: item.severity,
    startedAt: item.startedAt,
    reason: redactRemoteFreeText(item.reason),
    requestedAction: redactRemoteFreeText(item.requestedAction),
    source: item.source,
    links: {
      runId: item.links.runId,
      taskId: item.links.taskId,
      ticketId: item.links.ticketId,
      campaignId: item.links.campaignId,
      itemId: item.links.itemId,
    },
  };
}

export function toRemoteInbox(envelope: InboxEnvelope): RemoteInbox {
  return {
    generatedAt: envelope.generatedAt,
    items: envelope.items.map(toRemoteInboxItem),
    empty: envelope.empty,
    degraded: [...envelope.degraded],
  };
}

// ─── DTO 5: current-activity summary ────────────────────────────────────────────
//
// Allowlisted from CurrentActivity. This is a SUMMARY: the launch buckets carry host argv
// (`command`/`commandLine`), host paths (`projectDir`) and CI/remote URLs, so none of the
// launch/CI rows are surfaced — only their COUNTS. The agent rows carry a minimal id/label
// set with NO projectDir and NO argv. `requiredCiState` is the closed section-state
// vocabulary, never the per-observation URLs.

export type RemoteActivityAgent = {
  runId: string;
  taskId: string;
  runTitle: string;
  workflow: string;
  agentRole: string;
  phase: string;
  status: string;
  startedAt: string | null;
};

export type RemoteActivitySummary = {
  generatedAt: string;
  agents: RemoteActivityAgent[];
  counts: {
    agents: number;
    hostVerifications: number;
    launches: number;
    ciWaits: number;
    operatorWaits: number;
  };
  requiredCiState: string;
  hasLiveWork: boolean;
};

export function toRemoteActivitySummary(activity: CurrentActivityWithRetention): RemoteActivitySummary {
  const agents: RemoteActivityAgent[] = activity.agents.map((agent) => ({
    runId: agent.runId,
    taskId: agent.taskId,
    runTitle: agent.runTitle,
    workflow: agent.workflow,
    agentRole: agent.agentRole,
    phase: agent.phase,
    status: agent.status,
    startedAt: agent.startedAt,
  }));
  return {
    generatedAt: activity.generatedAt,
    agents,
    counts: {
      agents: activity.agents.length,
      hostVerifications: activity.hostVerification.length,
      launches: activity.launches.length,
      ciWaits: activity.ciWaits.length,
      operatorWaits: activity.operatorWaits.length,
    },
    requiredCiState: activity.requiredCi.state,
    hasLiveWork:
      activity.agents.length > 0 ||
      activity.hostVerification.length > 0 ||
      activity.ciWaits.length > 0 ||
      activity.operatorWaits.length > 0,
  };
}

// ─── grant + assembler ──────────────────────────────────────────────────────────

/** The server-authoritative grant the assembler consumes. Both fields are resolved from the
 *  verified identity's project-scope grant, NEVER from a client parameter. `memberDirs` is
 *  the STRICT, un-widened member-dir set — deliberately NOT resolveProjectScope's
 *  owner-convergence widening (see the module header). */
export type RemoteProjectGrant = {
  project: ProjectRecord;
  memberDirs: readonly string[];
};

export type AssembleRemoteBoardOptions = {
  /** Injected clock for determinism; defaults to Date.now(). */
  nowMs?: number;
  /** When the caller knows the read is served from a degraded/behind host, it downgrades the
   *  envelope to `stale` so the client never renders it as live. Defaults to a live read. */
  stale?: boolean;
};

/** Recent-campaign clamp — the same default the local /api/campaigns route uses. */
const REMOTE_CAMPAIGN_LIMIT = 50;

/** Assemble the five project-scoped remote DTOs into a `live` (or `stale`) envelope.
 *
 *  Every read is scoped STRICTLY to the granted member dirs: currentActivity/attentionInbox
 *  take the explicit dir scope; queueBoard/backlogTruthForProject take the resolved record
 *  (a per-project, id-addressed read) and queueBoard is passed an EMPTY registry so no
 *  foreign capacity-holder row is even resolved; campaigns are filtered to campaigns whose
 *  projectDir is one of the granted member dirs. No client projectKey/projectDir is consulted
 *  and resolveProjectScope is never called. */
export function assembleRemoteBoard(
  grant: RemoteProjectGrant,
  options: AssembleRemoteBoardOptions = {},
): RemoteBoardEnvelope {
  const nowMs = options.nowMs ?? Date.now();
  const scope: readonly string[] = [...grant.memberDirs];
  const memberSet = new Set(scope);

  const board = runInReadOnlyDbScope((): RemoteBoard => {
    const truth = backlogTruthForProject(grant.project);
    // Empty registry: capacity-holder resolution needs the registry to name OTHER projects'
    // slots; passing [] structurally suppresses every cross-project holder row before it can
    // be built. We drop the capacity panel from the DTO anyway, but this keeps the source
    // read itself project-local.
    const queue = queueBoard(grant.project, []);
    const inbox = attentionInbox(scope, nowMs);
    const activity = currentActivity(scope, undefined, nowMs);
    const accepts = (campaign: Campaign): boolean =>
      campaign.projectDir !== undefined && memberSet.has(campaign.projectDir);
    const campaigns = assembleCampaignSummaries(accepts, REMOTE_CAMPAIGN_LIMIT);

    return {
      projectSummary: toRemoteProjectSummary(grant.project),
      backlog: toRemoteBacklog(truth),
      queue: toRemoteQueue(queue),
      campaigns: campaigns.map(toRemoteCampaignSummary),
      inbox: toRemoteInbox(inbox),
      activity: toRemoteActivitySummary(activity),
    };
  });

  return {
    state: options.stale ? "stale" : "live",
    generatedAt: new Date(nowMs).toISOString(),
    generation: nowMs,
    board,
  };
}

// ─── refusal / degradation envelopes (no project data) ──────────────────────────
//
// The closed-state constructors. Every one carries `board: null` — the structural half of
// "a refusal never leaks project data". Step 3's handler returns `refusedRemoteBoard(...)`
// on every request in FG-781 (no transport adapter is wired, so identity is always absent).

function closedEnvelope(state: RemoteBoardState, nowMs: number): RemoteBoardEnvelope {
  return { state, generatedAt: new Date(nowMs).toISOString(), generation: nowMs, board: null };
}

/** No verified identity / project-scope grant / capability — refuse without project data. */
export function unauthorizedRemoteBoard(nowMs: number = Date.now()): RemoteBoardEnvelope {
  return closedEnvelope("unauthorized", nowMs);
}

/** The host store could not be read (unavailable / pre-tables / malformed). */
export function hostUnavailableRemoteBoard(nowMs: number = Date.now()): RemoteBoardEnvelope {
  return closedEnvelope("host-unavailable", nowMs);
}

/** The request named a capability or surface the remote board does not implement. */
export function unsupportedRemoteBoard(nowMs: number = Date.now()): RemoteBoardEnvelope {
  return closedEnvelope("unsupported", nowMs);
}
