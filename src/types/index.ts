// Forge core types — see Harness Spine Sketch for authoritative definitions.

export type WorkflowName =
  | "feature-design-provided"
  | "feature-design-needed"
  | "investigation"
  | "codebase-assessment"
  | "ui-design"
  | "design-revise";

export type GateType = "human" | "auto" | "verdict";

export type RedAuthority = "triage" | "specialist" | "authoritative";

export type AgentRef = {
  role: string;
  agentDir: string;
  // Logical model name as declared in the workflow (e.g. "spec-writer",
  // "fast-orchestrator"). Preserved on the AgentRef for audit-trail purposes
  // (#38) so a task can record both alias and resolved model.
  alias: string;
  // Resolved model id — what's actually passed to claude --model. Determined
  // at agent-ref construction time from BEDROCK_MAP / DIRECT_MAP / env var
  // overrides / LiteLLM passthrough. See workflows/_agentRefs.ts.
  model: string;
};

export type RedConfig = {
  wide?: AgentRef;
  narrow?: AgentRef;
  parallel: boolean;
  authority: RedAuthority;
  gateOnVerdict: boolean;
};

export type FanoutConfig = {
  maxConcurrency: number;
  failureMode: "fail-phase" | "retry-once" | "continue";
};

export type ConstraintRef = {
  path: string;
};

export type Phase = {
  name: string;
  agents: AgentRef[];
  reds?: RedConfig;
  gate: GateType;
  fanout?: FanoutConfig;
  workflowAdditions?: string;
  onReject?: string;
  // Fanout-from-upstream: when this phase is created, read the named array key
  // from the upstream phase's task result and create one task per array entry.
  // The entry is placed in inputs under `fanoutInputKey` (defaults to the singular
  // form of the array key — "claims" → "claim", "lenses" → "lens").
  fanoutFromUpstream?: {
    arrayKey: string;       // key in the upstream task's result, e.g. "claims" or "lenses"
    inputKey?: string;      // key in this task's inputs; default: singular(arrayKey)
  };
};

export type Workflow = {
  name: WorkflowName;
  description: string;
  phases: Phase[];
  constraints?: ConstraintRef[];
};

export type ConstraintLevel = "suggest" | "force";

export type Constraint = {
  id: string;
  level: ConstraintLevel;
  roles: string[];
  workflows: WorkflowName[];
  phases?: string[];
  body: string;
  antiPrompt?: string;
};

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
  | "complete"
  | "failed"
  | "blocked_by_red";

export type Run = {
  id: string;
  workflow: WorkflowName;
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
