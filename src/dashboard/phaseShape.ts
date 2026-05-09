// #71 phase pill row + #71.2 advance-preview helpers.
//
// Computes a "phase shape" view of a run for the dashboard: per-phase static
// metadata (gate type, reds presence, fanout-shape) + dynamic per-phase task
// aggregates (status counts, primary status, fanout progress). The pill row
// renders one pill per shape entry; the gate-panel preview helper consumes
// the same shape to answer "what happens if I advance?"
//
// Workflow definitions are the source of truth — we read the loaded Workflow
// object rather than mirror its shape. That keeps phase metadata coupled to
// the actual workflow files; if a phase rename or red-attachment happens, the
// dashboard reflects it on next page load with no parallel update.
//
// Kept separate from queries.ts because:
//  - queries.ts is DB-only (read-only Database singleton), this is workflow-aware
//  - this is unit-testable in isolation (pure function over Workflow + Task[])
//  - the server route loads the workflow async, then composes the two

import type { Workflow, Phase, Task, TaskStatus, GateType, RedAuthority } from "../types/index.js";

export type PhaseStatus =
  | "pending"        // no tasks yet
  | "running"        // at least one task running
  | "awaiting_red"   // blue done, reds in flight
  | "awaiting_gate"  // tasks waiting on gate
  | "awaiting_human_input"  // manual phase, waiting on human
  | "blocked_by_red" // authoritative red failed
  | "failed"         // any task failed (and nothing earlier-attention)
  | "done";          // all tasks complete

export type PhaseShape = {
  name: string;
  agentRoles: string[];      // empty array for manual phases
  gate: GateType;
  isManual: boolean;         // agents.length === 0
  hasFanout: boolean;        // phase.fanout || phase.fanoutFromUpstream defined
  fanoutConcurrency?: number;
  fanoutFromUpstream?: { arrayKey: string; inputKey?: string };
  hasReds: boolean;
  redsAuthority?: RedAuthority;
  redsGateOnVerdict?: boolean;
  onReject?: string;
  // Dynamic per-phase aggregates (over current run's tasks for this phase):
  status: PhaseStatus;
  taskCounts: { total: number; running: number; complete: number; failed: number; pending: number; awaitingGate: number; awaitingRed: number; awaitingHuman: number; blockedByRed: number };
  // For fanout: ordered status list per task (creation order). The pill row
  // renders one dot per entry, color-coded by status — gives "12 done, 4
  // running, 5 pending" at a glance without reading the task list.
  fanoutDots?: PhaseStatus[];
};

// Map a TaskStatus to the PhaseStatus vocabulary used for rendering. The two
// vocabularies almost match; "complete" → "done" is the only translation.
function taskStatusToPhase(s: TaskStatus): PhaseStatus {
  if (s === "complete") return "done";
  return s as PhaseStatus;
}

// Pick the phase's overall status from its tasks. Attention-ordered: most
// actionable wins. Mirrors the dashboard's compareTaskAttention rank.
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
  const c = { total: tasks.length, running: 0, complete: 0, failed: 0, pending: 0, awaitingGate: 0, awaitingRed: 0, awaitingHuman: 0, blockedByRed: 0 };
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

// Per-phase shape for a single phase, given the phase definition + the tasks
// that belong to it. Excludes red tasks (agentRole prefix "red-") from the
// aggregate — reds are a separate concern, not first-class members of the
// phase from the user's POV.
//
// Collapses retry chains (#78) to their terminal task: when a failed task is
// retried, a new task row is created with parentId pointing at the failed one.
// The audit trail keeps both rows; the phase aggregate keeps only the
// terminal task (newest in each chain). Counting both would double-count —
// e.g. an investigate run with 16 claims, 5 of which had one failed attempt
// before a successful retry, would show as 21 tasks / 5 failed instead of
// 16 done.
export function buildPhaseShapeForPhase(phase: Phase, allRunTasks: Task[]): PhaseShape {
  const allPhaseTasks = allRunTasks.filter(
    (t) => t.phase === phase.name && !t.agentRole.startsWith("red-")
  );
  // Build set of task ids that have been superseded by a same-phase, same-
  // role child via parentId. Those are non-terminal — drop them from the
  // aggregate but keep them in the task list (the list shows the full audit
  // trail via taskHeaderSection's RETRY OF / RETRIED AS).
  const supersededIds = new Set<string>();
  for (const t of allPhaseTasks) {
    if (t.parentId) supersededIds.add(t.parentId);
  }
  const phaseTasks = allPhaseTasks.filter((t) => !supersededIds.has(t.id));
  const isManual = (phase.agents || []).length === 0;
  const hasFanout = !!(phase.fanout || phase.fanoutFromUpstream);
  const hasReds = !!(phase.reds && (phase.reds.wide || phase.reds.narrow));

  const shape: PhaseShape = {
    name: phase.name,
    agentRoles: (phase.agents || []).map((a) => a.role),
    gate: phase.gate,
    isManual,
    hasFanout,
    fanoutConcurrency: phase.fanout?.maxConcurrency,
    fanoutFromUpstream: phase.fanoutFromUpstream
      ? {
          arrayKey: phase.fanoutFromUpstream.arrayKey,
          ...(phase.fanoutFromUpstream.inputKey != null ? { inputKey: phase.fanoutFromUpstream.inputKey } : {}),
        }
      : undefined,
    hasReds,
    redsAuthority: hasReds ? phase.reds!.authority : undefined,
    redsGateOnVerdict: hasReds ? phase.reds!.gateOnVerdict : undefined,
    onReject: phase.onReject,
    status: aggregatePhaseStatus(phaseTasks),
    taskCounts: countTasks(phaseTasks),
  };

  if (hasFanout) {
    // Order by createdAt to keep dot order stable across renders.
    const ordered = phaseTasks.slice().sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || ""));
    shape.fanoutDots = ordered.map((t) => taskStatusToPhase(t.status));
  }

  return shape;
}

// Build the full phaseShape array for a run.
export function buildPhaseShape(workflow: Workflow, allRunTasks: Task[]): PhaseShape[] {
  return workflow.phases.map((p) => buildPhaseShapeForPhase(p, allRunTasks));
}
