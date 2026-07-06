// Forge core types. v2 — workflow names are arbitrary YAML strings, not a fixed
// union. Phase/AgentRef/RedConfig/FanoutConfig types removed; v2 uses schema.ts.

import type { DoneAuditResult } from "../done-audit/done-audit.js";
export type { DoneAuditResult };

export type GateType = "human" | "auto" | "verdict";

export type RedAuthority = "triage" | "specialist" | "authoritative";

// Optional discipline tag carried on a task. Set when the agent role is a
// specialist (frontend-specialist, backend-specialist, security-advisor,
// agentic-platform-builder). Threads through audit + future routing logic.
export type AgentDiscipline = "frontend" | "backend" | "infosec" | "platform";

export type TaskInputs = { [key: string]: unknown };

export type TaskPackage = {
  taskId: string;
  runId: string;
  phase: string;
  role: string;
  inputs: TaskInputs;
  composedSystemPrompt: string;
  artifact?: string;
  spec?: string;
  failureModes?: string[];
};

export type Finding = {
  severity: "high" | "medium" | "low";
  summary: string;
  evidence: string;
  hypothesis: string;
  // #147 evidence-anchoring. When all three are present, the finding gets
  // mechanically validated: validate-findings.ts checks that quoted_text
  // appears at file:line ±3 in the project source. Findings without these
  // pass through un-anchored (intended for prose-y artifacts like architect
  // outputs where source-anchoring isn't always applicable). Partial sets
  // (e.g. file+line but no quoted_text) are treated as un-anchored.
  file?: string;
  line?: number;
  quoted_text?: string;
  // AWN-5 review-quality fields (all optional for back-compat with older reds):
  finding_type?: string;          // correctness | security | performance | style | maintainability | docs_drift | ...
  confidence?: number;            // 0..1, per-finding (distinct from verdict confidence)
  affected_files?: string[];      // all files implicated (file/line stays the anchor)
  recommended_fix?: string;       // concrete remediation
  disposition?: "confirmed" | "residual_risk"; // confirmed issue vs flagged residual risk
};

export type Verdict = {
  verdict: "pass" | "fail" | "inconclusive";
  confidence: number;
  findings: Finding[];
  notes?: string;
  invariants_verified?: string[]; // AWN-5: which contract/spec invariants this red checked
};

export type AgentResult = {
  taskId: string;
  status: "complete" | "failed";
  output: unknown;
  error?: string;
};

export type RunStatus = "active" | "complete" | "abandoned";
export type TaskStatus =
  | "pending"
  | "running"
  | "awaiting_gate"
  | "awaiting_red"
  | "complete"
  | "failed"
  | "blocked_by_red";

export type Run = {
  id: string;
  // v2: workflow is an arbitrary YAML name (see seeds/workflows/*.yml).
  workflow: string;
  title: string;
  status: RunStatus;
  createdAt: string;
  completedAt?: string;
  metadata?: Record<string, unknown>;
  // Project directory mounted at /project on every spawn. Set on first `forge next
  // --project <path>` and reused by subsequent calls + the dashboard's run-next
  // button. Override by passing --project again (warns on change).
  projectDir?: string;
};

export type Task = {
  id: string;
  runId: string;
  parentId?: string;
  phase: string;
  agentRole: string;
  // Logical model alias declared in the workflow (e.g. "spec-writer"). Captured at
  // task creation; null for legacy rows pre-#38.
  agentAlias?: string;
  // Resolved model id that ran (or will run) the task — what claude --model received.
  // Captured at task creation alongside agentAlias; null for legacy rows.
  agentModel?: string;
  // AWN-7 model resolution record (policy mode only). All undefined in legacy
  // mode (no model-policy.yml) and for pre-AWN-7 rows. agentAlias/agentModel
  // above carry the capability alias + concrete model; these add the named
  // policy decision that explains the selection.
  resolvedProfile?: string; // named profile chosen (e.g. "claude-bedrock")
  resolvedProvider?: string; // e.g. "anthropic"
  resolvedAuth?: string; // EFFECTIVE auth mode — never "auto"
  resolvedBy?: string; // rule that selected the profile (e.g. "overrides.agents.red-security")
  status: TaskStatus;
  taskPackage: TaskPackage;
  result?: unknown;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
  // FG-351: git worktree path for this task. Set before container starts (when
  // FORGE_WORKTREES=1); readable after process restart. Null for tasks that ran
  // without worktree isolation. Branch identity is derived deterministically as
  // forge/<runId>/<taskId> and does not need a separate column.
  worktreePath?: string;
};

export type DispatchResult = {
  spawned: number;
  succeeded: number;
  failed: number;
  taskIds: string[];
};

export type GateDecision = "advance" | "reject" | "request-changes";

export type VerdictRow = {
  id: string;
  taskId: string;
  redTaskId: string;
  redRole: string;
  verdict: Verdict["verdict"];
  confidence: number;
  authority: RedAuthority;
  findings: Finding[];
  createdAt: string;
};

// Ops intelligence substrate (#250). The shared, consumer-neutral contract for a
// "needs attention" incident detected from the blackboard. One detection core;
// the orchestrator, dashboard, notifications, and /orient each own their own
// policy over this shape. Read-only by construction — incidents describe state,
// they never mutate it.

/** Detection certainty, NOT repairability. `db-confirmed` = the condition is a
 *  pure DB fact (e.g. a pending task under a terminal run). `db-candidate` =
 *  likely, but the DB can't distinguish it from a benign case (e.g. "stalled" vs
 *  "waiting on a human"), so it needs out-of-band confirmation before any
 *  destructive action. `external-required` = undetectable without a probe
 *  (auth/docker/log) — follow-on, not MVP. */
export type IncidentConfidence = "db-confirmed" | "db-candidate" | "external-required";

export type IncidentSeverity = "low" | "medium" | "high";

/** `repair` = a concrete command safely resolves it. `repair_unavailable` = the
 *  condition is real but no current command safely fixes it (carries command:
 *  null). `investigate` / `escalate` = needs a human/orchestrator judgment. */
export type RecommendedActionType = "repair" | "repair_unavailable" | "investigate" | "escalate";

/** How much latitude the orchestrator has. `auto-safe` may only ride on a
 *  `db-confirmed` incident — you cannot safely auto-act on something the DB
 *  can't fully confirm (enforced by makeIncident). `ask` = surface to the user
 *  for the call. `manual-only` = no automated path. */
export type IncidentAutonomy = "auto-safe" | "ask" | "manual-only";

export type RecommendedAction = {
  type: RecommendedActionType;
  autonomy: IncidentAutonomy;
  /** The CLI command the orchestrator could run, or null when none applies
   *  (always null for `repair_unavailable`). */
  command: string | null;
  reason: string;
};

export type IncidentKind = "retry_orphan" | "inconsistent_run_state" | "reconcile_candidate" | "orphaned_work_may_persist" | "oom_killed" | "stuck_run";

export type VerificationCommand = {
  command: string;
  context: "host" | "container";
};

export type MissingContextItem = {
  field: string;
  reason: string;
  required: boolean;
};

export type ReviewerContextPacket = {
  backlog: {
    id: string;
    title: string;
    type: 'idea' | 'epic' | 'story';
    body: string;
    status: 'active' | 'done' | 'blocked' | 'deferred';
    acceptanceCriteria: string;
    nonGoals: string;
    parentEpic: string;
  } | null;
  operatorAsk: string | null;
  architectDecisions: unknown | null;
  techLeadPlan: unknown | null;
  requestChangesHistory: Array<{
    taskId: string;
    rationale: string;
    decidedAt: string;
    verdictFindings: Finding[];
  }>;
  redFindings: VerdictRow[];
  engineerSummary: unknown | null;
  git: {
    commitSha?: string;
    diffRange?: string;
    changedFiles: string[];
    worktreePath?: string;
  };
  verificationCommands: VerificationCommand[];
  deferredScope: Array<{
    description: string;
    followUpTicketId?: string;
  }>;
  doneAudit: DoneAuditResult | null;
  missingContext: MissingContextItem[];
};

export type Incident = {
  kind: IncidentKind;
  severity: IncidentSeverity;
  confidence: IncidentConfidence;
  runId: string;
  taskId: string | null;
  /** Human-readable facts that justify the incident. */
  evidence: string[];
  recommendedAction: RecommendedAction;
};

// ── Campaign Runner types (FG-390) ─────────────────────────────────────────

export type CampaignStatus = "planned" | "running" | "paused" | "complete" | "failed" | "abandoned";

export const CAMPAIGN_TRANSITIONS: Record<CampaignStatus, CampaignStatus[]> = {
  planned:   ["running", "abandoned"],
  running:   ["paused", "complete", "failed", "abandoned"],
  paused:    ["running", "abandoned"],
  complete:  [],
  failed:    [],
  abandoned: [],
};

export function isCampaignTransitionAllowed(from: CampaignStatus, to: CampaignStatus): boolean {
  return (CAMPAIGN_TRANSITIONS[from] as CampaignStatus[]).includes(to);
}

// Campaign item lifecycle reuses the run/task status vocabulary — the states
// (pending → running → complete/failed/blocked_by_red/awaiting_gate) map
// directly to item progression without a campaign-specific parallel enum.
export type CampaignItemLifecycleStatus = TaskStatus;

export type CampaignItemOutcome = "shipped" | "blocked" | "skipped" | "held" | "needs_refinement" | "failed";

export type BlockerKind =
  | "scope"
  | "readiness"
  | "tests"
  | "merge_conflict"
  | "auth"
  | "dependency"
  | "git_state"
  | "infrastructure"
  | "campaign_system"
  | "human_decision"
  // FG-442: an item's agent reported outgrowing its approved execution lane.
  | "lane_escalation";

export type ContinuePolicy = "continue_allowed" | "hold_dependents" | "hold_campaign";

export type SourceKind = "list" | "epic" | "mixed";

export type Campaign = {
  id: string;
  status: CampaignStatus;
  sourceKind: SourceKind;
  sourceInput: Record<string, unknown>;
  mode: string;
  createdAt: string;
  updatedAt: string;
  metadata?: Record<string, unknown>;
  planHash?: string;
  approvedBy?: string;
  approvedAt?: string;
  approvalRationale?: string;
  approvedPlanHash?: string;
  projectDir?: string;
};

export type CampaignItem = {
  id: string;
  campaignId: string;
  itemOrder: number;
  ticketId: string;
  runId?: string;
  branch?: string;
  worktreePath?: string;
  prUrl?: string;
  lifecycleStatus: CampaignItemLifecycleStatus;
  outcome?: CampaignItemOutcome;
  blockerKind?: BlockerKind;
  continuePolicy?: ContinuePolicy;
  reason?: string;
  requestedHumanAction?: string;
  createdAt: string;
  updatedAt: string;
};
