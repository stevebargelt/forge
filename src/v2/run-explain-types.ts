// FG-348: the versioned, independently-governed contract for the dashboard Run
// Map canvas (GET /api/run/:id/map) and the task-level Explain panel
// (GET /api/task/:id/explain), plus the `forge explain … --json` CLI. Mirrors
// config-graph-types.ts: this is the ONE presentation vocabulary shared by every
// consumer (dashboard client, CLI JSON, orchestrator), and it is deliberately a
// CONTRACT type distinct from the internal resolver/store/schema/manifest types
// it projects.
//
// It imports NOTHING from the resolver/store/loader/schema/task-manifest layers,
// so the vocabulary can be versioned without dragging those internals across the
// boundary. Every projected native fact is carried VERBATIM in a `native` field
// (like ConfigRow.native), so no consumer has to trust the projection over the
// source of truth.
//
// Two axes of degradation, kept INDEPENDENT on purpose:
//   - The Run Map degrades by WORKFLOW: when the workflow definition won't load,
//     the graph renders execution shape from task rows alone with inferred
//     labels, and never throws.
//   - The Task Explain degrades by BLOCK: every block is individually optional,
//     so a receipt-less / legacy task degrades block-by-block (mount inferred,
//     model policy absent, …), not by a coarse run-age heuristic.

export const RUN_EXPLAIN_VERSION = 1;

// ────────────────────────── Run Map graph ──────────────────────────

/** Per-node lineage, mirroring lifecycle-evaluator's LineageKind but declared
 *  locally so this contract imports no evaluator. `unknown` is added for the
 *  degraded (no-workflow) path where lineage cannot be classified. */
export type NodeLineage =
  | "primary"
  | "retry_replacement"
  | "on_reject_recovery"
  | "red_review"
  | "fanout_child"
  | "adhoc_invoke"
  | "legacy_ambiguous_invoke"
  | "unknown";

/** A compact model/profile badge for a node. Every field optional so a legacy
 *  row with no resolution record still renders (as an unknown badge). */
export type ModelBadge = {
  alias?: string;
  model?: string;
  profile?: string;
  /** True when the badge is a best-effort read of a row with no policy-mode
   *  resolution record (legacy alias resolution), not an authoritative one. */
  inferred?: boolean;
};

/** One WORKFLOW-layer phase (a workflow step). Present only when the workflow
 *  definition loaded; when it did not, the graph carries inferred phases derived
 *  from the task rows' `phase` column instead (see `inferred`). */
export type RunMapPhase = {
  /** Step id (workflow layer) or the task rows' phase string (inferred layer). */
  id: string;
  label: string;
  /** step.agent — the role the phase dispatches. Absent for manual steps. */
  role?: string;
  /** Gate type declared by the step: human | verdict | auto | none. */
  gate?: string;
  /** depends_on step ids — the workflow dependency edges. */
  dependsOn: string[];
  /** step declares `fanout`. */
  fanout: boolean;
  manual: boolean;
  /** red agent names declared on the step. */
  reds: string[];
  /** True when this phase was reconstructed from task rows because the workflow
   *  definition was unresolvable — its labels are inferred, not authoritative. */
  inferred?: boolean;
  /** The workflow Step verbatim, when one backs this phase. */
  native?: unknown;
};

/** One phase→phase dependency edge (from depends_on). */
export type RunMapEdge = { from: string; to: string };

/** One EXECUTION-layer node: an actual task row. */
export type RunMapNode = {
  taskId: string;
  phase: string;
  role: string;
  status: string;
  /** Gate type from the backing workflow step, when the workflow resolved. */
  gate?: string;
  lineage: NodeLineage;
  model?: ModelBadge;
  parentId?: string;
  /** True when node facts (lineage, gate) are inferred because the workflow was
   *  unresolvable, or the row is a legacy marker-less row. */
  inferred?: boolean;
  /** The task row's projected identity fields, verbatim. */
  native: unknown;
};

/** A fanout phase's children, grouped so the canvas can render one expandable
 *  group node rather than exploding ~21 children inline. */
export type FanoutGroup = {
  /** The fanout step id (workflow layer) or inferred phase. */
  phase: string;
  /** The fanout parent task id, when one exists in the rows. */
  parentTaskId?: string;
  childTaskIds: string[];
  count: number;
};

/** A red reviewer attached to the primary task it reviewed. `via` records HOW
 *  the attachment was proven: `verdict` (authoritative — a verdicts row names
 *  task_id=primary, red_task_id=red) or `parent` (fallback — parent_id + red
 *  role, used only when no verdict row exists). */
export type RedAttachment = {
  redTaskId: string;
  redRole: string;
  primaryTaskId: string;
  via: "verdict" | "parent";
};

export type RunHeader = {
  runId: string;
  workflow: string;
  title: string;
  status: string;
  createdAt: string;
  projectDir?: string;
  reviewMode?: string;
};

/** The versioned Run Map contract both the CLI and the dashboard consume
 *  UNMODIFIED. `workflowResolved: false` means the workflow definition would not
 *  load and the whole graph is the execution-only, inferred-label fallback. */
export type RunMapGraph = {
  version: number;
  run: RunHeader;
  workflowResolved: boolean;
  phases: RunMapPhase[];
  edges: RunMapEdge[];
  nodes: RunMapNode[];
  fanoutGroups: FanoutGroup[];
  redAttachments: RedAttachment[];
  warnings: string[];
};

// ────────────────────────── Task Explain ──────────────────────────

/** How authoritative a block is. `recorded` = read from the task's manifest
 *  receipt (authoritative for what the task actually ran under). `inferred` =
 *  the block's specific receipt sub-record was absent, so it is a best-effort
 *  reconstruction. `unknown` = no manifest at all (the task predates
 *  manifest.json). */
export type ExplainBlockStatus = "recorded" | "inferred" | "unknown";

export type WorkflowSourceBlock = {
  name?: string;
  /** host | project | synthetic | unknown, verbatim from the receipt. */
  source?: string;
  path?: string;
  status: ExplainBlockStatus;
  native?: unknown;
};

export type ModelResolutionBlock = {
  alias?: string;
  model?: string;
  profile?: string;
  provider?: string;
  auth?: string;
  costTier?: string;
  resolvedBy?: string;
  capabilitySource?: string;
  mappingPath?: string;
  status: ExplainBlockStatus;
  native?: unknown;
};

export type RuntimeBlock = {
  name?: string;
  kind?: string;
  logFormat?: string;
  promptStrategy?: string;
  authStrategy?: string;
  status: ExplainBlockStatus;
  native?: unknown;
};

export type MountModeBlock = {
  /** rw = read-write (primary/fanout); ro = read-only (reds). */
  mountMode?: "rw" | "ro";
  projectDir?: string;
  invocationCwd?: string;
  resolvedFromSubdir?: boolean;
  explicitSubproject?: boolean;
  status: ExplainBlockStatus;
  native?: unknown;
};

export type GateDecisionEntry = {
  decision: string;
  rationale?: string;
  decidedBy: string;
  decidedAt: string;
};

export type GateBlock = {
  /** Gate type from the backing workflow step, when known. */
  gateType?: string;
  decisions: GateDecisionEntry[];
  status: ExplainBlockStatus;
};

export type RedEntry = {
  redTaskId: string;
  redRole: string;
  verdict: string;
  confidence: number;
  authority: string;
  findingCount: number;
};

export type RedsBlock = {
  reds: RedEntry[];
  status: ExplainBlockStatus;
};

export type UpstreamInput = {
  key: string;
  /** A compact, redaction-safe SHAPE summary of the input value — its type and
   *  length/count, NEVER any of the raw value's content, which may be large or
   *  carry secrets a structural redactor cannot catch (FG-348 RF-3/RF-4). */
  summary: string;
};

export type UpstreamInputsBlock = {
  inputs: UpstreamInput[];
  status: ExplainBlockStatus;
};

export type ArtifactRef = {
  /** e.g. "result", "stdout", "stderr", "manifest". */
  kind: string;
  name: string;
  available: boolean;
};

/** The versioned Task Explain contract. Every block optional so a receipt-less
 *  legacy task degrades block-by-block. `warnings` carries the ticket's
 *  prominent degradation callouts (mount inferred, model policy absent, predates
 *  manifest.json, project workflow override active, …), plus any receipt-recorded
 *  warnings verbatim. */
export type TaskExplain = {
  version: number;
  taskId: string;
  runId: string;
  role: string;
  status: string;
  warnings: string[];
  workflowSource?: WorkflowSourceBlock;
  modelResolution?: ModelResolutionBlock;
  runtime?: RuntimeBlock;
  mountMode?: MountModeBlock;
  gate?: GateBlock;
  reds?: RedsBlock;
  upstream?: UpstreamInputsBlock;
  artifacts?: ArtifactRef[];
};
