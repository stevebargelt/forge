// Forge core types. v2 — workflow names are arbitrary YAML strings, not a fixed
// union. Phase/AgentRef/RedConfig/FanoutConfig types removed; v2 uses schema.ts.

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
};

export type Verdict = {
  verdict: "pass" | "fail" | "inconclusive";
  confidence: number;
  findings: Finding[];
  notes?: string;
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
  | "awaiting_human_input"
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
  status: TaskStatus;
  taskPackage: TaskPackage;
  result?: unknown;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
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
