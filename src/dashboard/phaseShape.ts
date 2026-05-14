// Phase shape — dashboard pill row data.
//
// Computes a per-step view of a run for the dashboard: static step metadata
// (gate, reds, fanout) + dynamic per-step task aggregates (status counts,
// primary status, fanout dots).
//
// v2: reads the YAML Workflow from src/v2/schema. The pill row renders one
// pill per step in workflow.steps order. PhaseShape's public field names
// stay v1-shaped (name/agentRoles/etc.) so the dashboard client (html.ts
// CLIENT_JS) renders unchanged.

import type { Workflow, Step, RedDef } from "../v2/schema.js";
import type { Task, TaskStatus, RedAuthority } from "../types/index.js";

export type GateType = "human" | "auto" | "verdict" | "none";

export type PhaseStatus =
  | "pending"
  | "running"
  | "awaiting_red"
  | "awaiting_gate"
  | "awaiting_human_input"
  | "blocked_by_red"
  | "failed"
  | "done";

export type PhaseShape = {
  /** Step id (v1 called this `name`; kept as `name` for client compat). */
  name: string;
  /** v2 steps have at most one agent. Kept as an array for client compat. */
  agentRoles: string[];
  gate: GateType;
  /** True for `manual: true` steps. */
  isManual: boolean;
  /** True when the step declares a `fanout:` block. */
  hasFanout: boolean;
  fanoutConcurrency?: number;
  /** Surfaced for the modal/preview. v2 names: from_upstream.array_key, input_key. */
  fanoutFromUpstream?: { arrayKey: string; inputKey?: string };
  hasReds: boolean;
  /** Collapsed across all reds: authoritative if ANY red is authoritative. */
  redsAuthority?: RedAuthority;
  /** Collapsed across all reds: true if ANY red has gate_on_verdict. */
  redsGateOnVerdict?: boolean;
  onReject?: string;
  status: PhaseStatus;
  taskCounts: {
    total: number;
    running: number;
    complete: number;
    failed: number;
    pending: number;
    awaitingGate: number;
    awaitingRed: number;
    awaitingHuman: number;
    blockedByRed: number;
  };
  /** For fanout steps: per-task status in creation order. */
  fanoutDots?: PhaseStatus[];
};

function taskStatusToPhase(s: TaskStatus): PhaseStatus {
  if (s === "complete") return "done";
  return s as PhaseStatus;
}

function aggregatePhaseStatus(tasks: Task[]): PhaseStatus {
  if (tasks.length === 0) return "pending";
  const has = (s: TaskStatus) => tasks.some((t) => t.status === s);
  if (has("blocked_by_red")) return "blocked_by_red";
  if (has("running")) return "running";
  if (has("awaiting_red")) return "awaiting_red";
  if (has("awaiting_human_input")) return "awaiting_human_input";
  if (has("awaiting_gate")) return "awaiting_gate";
  if (has("failed") && !tasks.every((t) => t.status === "complete")) return "failed";
  if (tasks.every((t) => t.status === "complete")) return "done";
  if (tasks.every((t) => t.status === "complete" || t.status === "failed")) return "failed";
  return "pending";
}

function countTasks(tasks: Task[]) {
  const c = {
    total: tasks.length,
    running: 0,
    complete: 0,
    failed: 0,
    pending: 0,
    awaitingGate: 0,
    awaitingRed: 0,
    awaitingHuman: 0,
    blockedByRed: 0,
  };
  for (const t of tasks) {
    if (t.status === "running") c.running++;
    else if (t.status === "complete") c.complete++;
    else if (t.status === "failed") c.failed++;
    else if (t.status === "pending") c.pending++;
    else if (t.status === "awaiting_gate") c.awaitingGate++;
    else if (t.status === "awaiting_red") c.awaitingRed++;
    else if (t.status === "awaiting_human_input") c.awaitingHuman++;
    else if (t.status === "blocked_by_red") c.blockedByRed++;
  }
  return c;
}

// Collapse the v2 reds[] array (each with its own authority + gate_on_verdict)
// into a single pill-rendered badge. Rule: pessimistic — if ANY red is
// authoritative, the step's pill renders authoritative; same for gate_on_verdict.
// Mirrors how the runner decides whether a red-fail blocks (any
// authoritative+gating fail blocks).
function collapseReds(reds: RedDef[]): { authority: RedAuthority; gateOnVerdict: boolean } | undefined {
  if (reds.length === 0) return undefined;
  const authoritative = reds.some((r) => r.authority === "authoritative");
  const gating = reds.some((r) => r.gate_on_verdict);
  return {
    authority: authoritative ? "authoritative" : "specialist",
    gateOnVerdict: gating,
  };
}

/** Per-step shape, given the v2 Step + the tasks belonging to it.
 *
 *  Excludes red child tasks (parentId set) from the aggregate. Red tasks
 *  are a separate concern from the user's POV — the pill reflects the
 *  primary task's progress, not red children.
 *
 *  Collapses retry chains (#78) to terminal-only: when a failed task is
 *  retried, a new task row is inserted with parentId pointing at the
 *  failed one. The aggregate keeps only the terminal task in each chain
 *  to avoid double-counting. */
export function buildPhaseShapeForStep(step: Step, allRunTasks: Task[]): PhaseShape {
  // Primary tasks for this step: phase === step.id, no parentId.
  const primary = allRunTasks.filter(
    (t) => t.phase === step.id && t.parentId === undefined,
  );

  // Retry collapse: drop tasks whose id is some other task's parentId.
  // Conservative — only collapses within the same step (parentId === task.id
  // for tasks in `primary`).
  const supersededIds = new Set<string>();
  for (const t of allRunTasks) {
    if (t.parentId && primary.some((p) => p.id === t.parentId)) {
      // The parent has a child in some context (red OR retry). Only treat as
      // superseded if the child is also in this step's primary list (retry
      // pattern). Red children have parentId set but they're NOT primary
      // tasks of this step.
      if (primary.some((p) => p.id === t.id)) supersededIds.add(t.parentId);
    }
  }
  const stepTasks = primary.filter((t) => !supersededIds.has(t.id));

  const reds = collapseReds(step.reds);
  const hasReds = reds !== undefined;

  const shape: PhaseShape = {
    name: step.id,
    agentRoles: step.agent ? [step.agent] : [],
    gate: step.gate as GateType,
    isManual: step.manual,
    hasFanout: !!step.fanout,
    ...(step.fanout?.max_concurrency !== undefined ? { fanoutConcurrency: step.fanout.max_concurrency } : {}),
    ...(step.fanout
      ? {
          fanoutFromUpstream: {
            arrayKey: step.fanout.from_upstream.array_key,
            inputKey: step.fanout.from_upstream.input_key,
          },
        }
      : {}),
    hasReds,
    ...(reds ? { redsAuthority: reds.authority, redsGateOnVerdict: reds.gateOnVerdict } : {}),
    ...(step.on_reject ? { onReject: step.on_reject } : {}),
    status: aggregatePhaseStatus(stepTasks),
    taskCounts: countTasks(stepTasks),
  };

  if (step.fanout) {
    // For fanout steps, the pill shows one dot per fanout child task. Order
    // by createdAt for stable rendering. Fanout children have parentId
    // pointing at the synthetic parent (the primary task for this step), so
    // they're NOT in `primary` — fetch them separately.
    const primaryIds = new Set(primary.map((p) => p.id));
    const fanoutChildren = allRunTasks
      .filter((t) => t.phase === step.id && t.parentId && primaryIds.has(t.parentId))
      .slice()
      .sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || ""));
    shape.fanoutDots = fanoutChildren.map((t) => taskStatusToPhase(t.status));
  }

  return shape;
}

/** Build the full pill-row data for a run. One PhaseShape per step in
 *  workflow.steps order. */
export function buildPhaseShape(workflow: Workflow, allRunTasks: Task[]): PhaseShape[] {
  return workflow.steps.map((s) => buildPhaseShapeForStep(s, allRunTasks));
}
