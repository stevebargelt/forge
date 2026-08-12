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
  // FG-507/FG-512: dispatch provenance recorded at row creation. `invoke` is
  // stamped by `forge invoke` (and the ad-hoc rows `forge retry` re-dispatches);
  // `workflow` is stamped by every runner-side creation site (runNext.ts primaries,
  // reds, fanout parents/children, manual steps; gate.ts on_reject recovery and
  // request-changes replacement rows). Deliberately NOT an `inputs` key — inputs are
  // rendered into the agent's task package, and this is control-plane provenance
  // the agent must never see. Read by taskDispatchKind (src/v2/run-kind.ts), which
  // otherwise has to INFER ad-hoc-ness from phase-vs-step-id structure and cannot
  // distinguish an invoke task from a workflow whose step id is `task`. With FG-512
  // this marker is TOTAL for new rows; only legacy pre-provenance rows are marker-less.
  dispatchSource?: "invoke" | "workflow";
  // FG-654: the protocol stamp THE COMPOSE THAT PRODUCED composedSystemPrompt resolved.
  // It rides the package rather than being re-derived at manifest-write time on purpose:
  // the two reads are minutes and a `forge upgrade` apart, so a fresh read can name a
  // generation the container was never given — or, if the seed went stale in that window,
  // name none at all for a covered role that did dispatch. The prompt and its receipt come
  // from ONE read or they are not a receipt. Undefined for an uncovered role, and for a
  // package whose prompt is a refusal (no container starts).
  agentProtocol?: { role: string; sha256: string; source: string };
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

export type RunStatus = "active" | "complete" | "failed" | "abandoned";
export type TaskStatus =
  | "pending"
  | "running"
  | "awaiting_gate"
  | "awaiting_red"
  | "complete"
  | "failed"
  | "blocked_by_red"
  // FG-425 (AC5): the task's publication attempt advanced the target ref and then
  // lost the publication window before its disposition could be settled. NON-TERMINAL
  // and RECOVERABLE: the attempt is still `publishing`, so no terminal claim about it
  // may be made — least of all a refusal saying nothing was published, which would
  // invite a retry of work that already landed. `forge next` converges the attempt
  // (AD-5) and reconciles this task onto the truth; `forge publish recover <attemptId>`
  // does it by hand.
  | "awaiting_recovery";

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
  // FG-638: which review authority model settles this run. Exactly one per run —
  // the column is NOT NULL DEFAULT 'legacy_verdict', so a run written before the
  // ledger existed (and one written by an older binary today) resolves to the
  // verdict/blocked_by_red model rather than to nothing.
  reviewMode?: ReviewMode;
};

export type ReviewMode = "legacy_verdict" | "legacy_review_loop" | "evidence_led";

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
  // FG-621: the commit this task's private clone was created AT, recorded with
  // worktreePath before the container starts. Undefined on the linked-worktree
  // and shared-mount paths, and on pre-FG-621 rows.
  baseSha?: string;
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
  // FG-523 (F16): the red's gate_on_verdict config as of dispatch. null (or
  // absent, on a row read before the column existed) means "unknown" and blocks
  // — see verdictBlocksGate in v2/gate.ts, the one rule both sites apply.
  gateOnVerdict?: boolean | null;
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

// FG-676: `resurrected_gate_decision` — a task row sitting at `awaiting_gate`
// whose event stream's latest terminal fact is a gate rejection. The row
// contradicts its own history: a human decided the task, and a later write moved
// it back to a state no agent runs for and no gate decision resolves. Repaired by
// `forge ops repair <taskId>` (operator-invoked; nothing self-heals it).
export type IncidentKind = "retry_orphan" | "inconsistent_run_state" | "reconcile_candidate" | "orphaned_work_may_persist" | "oom_killed" | "orphaned_needs_finalize" | "stuck_run" | "container_reap_failed" | "resurrected_gate_decision";

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

// FG-703 (step 5): the durable audit record annotated onto an adjudicated
// incident when it is surfaced through the operator READ surface
// (`forge ops check --include-adjudicated`). It is NEVER attached in the default
// suppressing path — an incident only carries this when it was retired by
// `forge ops adjudicate` AND its CURRENT identity still matches the recorded one
// (a materially-changed incident reappears as unresolved with no annotation).
// Mirrors the fields performAdjudicate writes into the ops.adjudicated payload.
export type IncidentAdjudication = {
  /** The disposition recorded — only ever `no_unique_work` today. */
  outcome: string;
  /** WHY the operator retired the incident (durable audit history). */
  rationale: string;
  /** WHO adjudicated (the recorded actor). */
  actor: string;
  /** When the adjudication was recorded (ISO timestamp). */
  at: string;
  /** The canonical identity this adjudication was recorded against (== the
   *  incident's current identity, or it would not be annotated). */
  identity: string;
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
  /** FG-703: the canonical adjudication identity, present ONLY on an
   *  `orphaned_work_may_persist` incident (the sole adjudicable kind). It is the
   *  exact `--identity` compare-and-set token `forge ops adjudicate` requires, so
   *  an operator reads it off `ops check` and copies it in. Other incident kinds
   *  have no adjudication path and never carry it (an identity there would be
   *  meaningless). Derived by the ONE shared computeAdjudicationIdentity. */
  identity?: string;
  /** FG-703: present ONLY on an adjudicated incident surfaced under
   *  `forge ops check --include-adjudicated`. Absent in the default suppressing
   *  path, so default results are byte-for-byte unchanged. */
  adjudication?: IncidentAdjudication;
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
  // FG-596: the LOGICAL attempt generation for this item — a monotonic counter
  // bumped only on a genuinely new attempt (initial dispatch or explicit retry) and
  // reused unchanged on restart/reattach/recovery/re-drive. 0 is the "never
  // allocated" default (fresh rows and legacy pre-FG-596 rows read back 0); a real
  // attempt is >= 1. Feeds the deterministic drive-item dispatch key so a later
  // slice (FG-564) can recover a dead drive-item by key without duplicating it.
  attemptGeneration: number;
  createdAt: string;
  updatedAt: string;
};
