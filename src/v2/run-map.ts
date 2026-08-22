// FG-348 [B]: buildRunMap — the ONE pure projection from a run's already-fetched
// rows (+ its loaded Workflow, or undefined) into the RunMapGraph contract. Both
// the dashboard query (runMap) and the CLI JSON surface (`forge explain run`)
// call this and return its output unreshaped, so they are byte-identical by
// construction.
//
// PURE: no db, no disk, no fs. The WORKFLOW layer (phases, dependency edges,
// fanout intent, gate types, red attachment) comes from the Workflow via
// classifyTaskLineage; the EXECUTION layer (statuses, retries, children, reds)
// comes from the task rows. When the Workflow is undefined/unresolvable the graph
// renders execution shape from task rows alone with inferred labels and NEVER
// throws.

import type { Run, Task } from "../types/index.js";
import type { Workflow, Step } from "./schema.js";
import {
  classifyTaskLineage,
  isAdHocInvokeRow,
  isFanoutChildRow,
  isOnRejectRecoveryRow,
  isPhasePrimaryRow,
  type LineageKind,
} from "./lifecycle-evaluator.js";
import {
  RUN_EXPLAIN_VERSION,
  type FanoutGroup,
  type ModelBadge,
  type NodeLineage,
  type RedAttachment,
  type RunHeader,
  type RunMapEdge,
  type RunMapGraph,
  type RunMapNode,
  type RunMapPhase,
} from "./run-explain-types.js";

/** The minimal verdict shape the run-map needs: which red reviewed which primary.
 *  A projection of the verdicts table (task_id=primary, red_task_id=red). */
export type RunMapVerdict = {
  taskId: string;
  redTaskId: string;
  redRole: string;
};

export type BuildRunMapInput = {
  run: Run;
  tasks: Task[];
  verdicts: RunMapVerdict[];
  /** The loaded workflow, or undefined when it could not be resolved. */
  workflow?: Workflow;
  /** Where the resolved workflow came from, for the override warning. */
  workflowSource?: "host" | "project";
};

/** The task row facts carried verbatim in a node's `native`. */
function nativeNode(t: Task): unknown {
  return {
    id: t.id,
    phase: t.phase,
    agentRole: t.agentRole,
    status: t.status,
    parentId: t.parentId ?? null,
    createdAt: t.createdAt,
    agentAlias: t.agentAlias ?? null,
    agentModel: t.agentModel ?? null,
    resolvedProfile: t.resolvedProfile ?? null,
  };
}

/** Compact model/profile badge. `inferred` when there is no policy-mode
 *  resolution record (resolvedProfile absent = legacy alias resolution). */
function modelBadge(t: Task): ModelBadge | undefined {
  const alias = t.agentAlias;
  const model = t.agentModel;
  const profile = t.resolvedProfile;
  if (alias === undefined && model === undefined && profile === undefined) return undefined;
  const badge: ModelBadge = {};
  if (alias !== undefined) badge.alias = alias;
  if (model !== undefined) badge.model = model;
  if (profile !== undefined) badge.profile = profile;
  if (profile === undefined) badge.inferred = true;
  return badge;
}

/** Best-effort per-row lineage when there is no workflow to classify against.
 *  red_review is unreachable without the workflow's reds list, so a red child
 *  degrades to fanout_child/unknown here — the honest answer. */
function degradedLineage(t: Task): NodeLineage {
  if (isAdHocInvokeRow(t)) return "adhoc_invoke";
  if (isOnRejectRecoveryRow(t)) return "on_reject_recovery";
  if (isFanoutChildRow(t)) return "fanout_child";
  if (isPhasePrimaryRow(t)) return "primary";
  return "unknown";
}

function runHeader(run: Run): RunHeader {
  const header: RunHeader = {
    runId: run.id,
    workflow: run.workflow,
    title: run.title,
    status: run.status,
    createdAt: run.createdAt,
  };
  if (run.projectDir !== undefined) header.projectDir = run.projectDir;
  if (run.reviewMode !== undefined) header.reviewMode = run.reviewMode;
  return header;
}

function workflowPhases(workflow: Workflow): { phases: RunMapPhase[]; edges: RunMapEdge[] } {
  const phases: RunMapPhase[] = workflow.steps.map((s) => {
    const phase: RunMapPhase = {
      id: s.id,
      label: s.id,
      gate: s.gate,
      dependsOn: s.depends_on,
      fanout: s.fanout !== undefined,
      manual: s.manual,
      reds: s.reds.map((r) => r.agent),
      native: s,
    };
    if (s.agent !== undefined) phase.role = s.agent;
    return phase;
  });
  const edges: RunMapEdge[] = [];
  for (const s of workflow.steps) {
    for (const dep of s.depends_on) edges.push({ from: dep, to: s.id });
  }
  return { phases, edges };
}

/** Phases reconstructed from the task rows when the workflow won't load. No
 *  dependency edges are knowable, so they are omitted; every phase is inferred. */
function inferredPhases(tasks: Task[]): RunMapPhase[] {
  const order: string[] = [];
  const seen = new Set<string>();
  const sorted = [...tasks].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  for (const t of sorted) {
    if (!seen.has(t.phase)) {
      seen.add(t.phase);
      order.push(t.phase);
    }
  }
  return order.map((phase) => ({
    id: phase,
    label: phase,
    dependsOn: [],
    fanout: false,
    manual: false,
    reds: [],
    inferred: true,
  }));
}

export function buildRunMap(input: BuildRunMapInput): RunMapGraph {
  const { run, tasks, verdicts, workflow, workflowSource } = input;
  const warnings: string[] = [];

  const kinds: Map<string, LineageKind> | undefined = workflow
    ? classifyTaskLineage(workflow, tasks)
    : undefined;

  const stepsById = new Map<string, Step>(workflow ? workflow.steps.map((s) => [s.id, s]) : []);

  let phases: RunMapPhase[];
  let edges: RunMapEdge[];
  if (workflow) {
    const built = workflowPhases(workflow);
    phases = built.phases;
    edges = built.edges;
  } else {
    phases = inferredPhases(tasks);
    edges = [];
    warnings.push(
      "Workflow definition could not be loaded — showing execution shape from task rows with inferred labels.",
    );
  }

  if (workflowSource === "project") {
    warnings.push("Project workflow override is active.");
  }

  const nodes: RunMapNode[] = tasks.map((t) => {
    const lineage: NodeLineage = kinds ? (kinds.get(t.id) ?? "unknown") : degradedLineage(t);
    const step = stepsById.get(t.phase);
    const node: RunMapNode = {
      taskId: t.id,
      phase: t.phase,
      role: t.agentRole,
      status: t.status,
      lineage,
      native: nativeNode(t),
    };
    if (t.parentId !== undefined) node.parentId = t.parentId;
    if (step?.gate !== undefined) node.gate = step.gate;
    const badge = modelBadge(t);
    if (badge !== undefined) node.model = badge;
    if (!workflow || lineage === "legacy_ambiguous_invoke" || lineage === "unknown") {
      node.inferred = true;
    }
    return node;
  });

  // Fanout grouping: children (fanout_child) grouped under their phase, with the
  // phase's primary as the parent. Rendered as one expandable group so a
  // ~21-child fanout never explodes inline.
  const fanoutGroups: FanoutGroup[] = [];
  const childrenByPhase = new Map<string, Task[]>();
  for (const t of tasks) {
    const lineage: NodeLineage = kinds ? (kinds.get(t.id) ?? "unknown") : degradedLineage(t);
    if (lineage !== "fanout_child") continue;
    const arr = childrenByPhase.get(t.phase) ?? [];
    arr.push(t);
    childrenByPhase.set(t.phase, arr);
  }
  for (const [phase, children] of childrenByPhase) {
    const primary = tasks.find(
      (t) => t.phase === phase && isPhasePrimaryRow(t),
    );
    const group: FanoutGroup = {
      phase,
      childTaskIds: children.map((c) => c.id),
      count: children.length,
    };
    if (primary !== undefined) group.parentTaskId = primary.id;
    fanoutGroups.push(group);
  }

  // Red attachment: verdicts are authoritative (task_id=primary, red_task_id=red).
  // A red row with NO verdict falls back to parent_id + red role.
  const redAttachments: RedAttachment[] = [];
  const coveredReds = new Set<string>();
  for (const v of verdicts) {
    redAttachments.push({
      redTaskId: v.redTaskId,
      redRole: v.redRole,
      primaryTaskId: v.taskId,
      via: "verdict",
    });
    coveredReds.add(v.redTaskId);
  }
  for (const t of tasks) {
    if (coveredReds.has(t.id)) continue;
    const lineage: NodeLineage = kinds ? (kinds.get(t.id) ?? "unknown") : degradedLineage(t);
    if (lineage !== "red_review") continue;
    if (t.parentId === undefined) continue;
    redAttachments.push({
      redTaskId: t.id,
      redRole: t.agentRole,
      primaryTaskId: t.parentId,
      via: "parent",
    });
  }

  return {
    version: RUN_EXPLAIN_VERSION,
    run: runHeader(run),
    workflowResolved: workflow !== undefined,
    phases,
    edges,
    nodes,
    fanoutGroups,
    redAttachments,
    warnings,
  };
}
