// Phase shape — dashboard pill row data. v1 derived this from a TypeScript
// Workflow object. v2 loads workflows from YAML; the pill row needs a
// v2-aware rewrite (filed as fast-follow). For now this file exports just
// the types; queries.ts returns an empty array and the client renders no
// pills.
//
// Reviving the pill row: write buildPhaseShape(workflow: v2.Workflow, tasks: Task[])
// against src/v2/schema's Workflow shape. The v1 Phase fields the dashboard
// consumes are: name, agents[].role, gate, fanout, fanoutFromUpstream, reds.
// v2's equivalent fields: steps[].id, steps[].agent, steps[].gate,
// steps[].fanout, steps[].reds. Mostly a renaming exercise.

import type { TaskStatus, RedAuthority } from "../types/index.js";

export type GateType = "human" | "auto" | "verdict";

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
  name: string;
  agentRoles: string[];
  gate: GateType;
  isManual: boolean;
  hasFanout: boolean;
  fanoutConcurrency?: number;
  fanoutFromUpstream?: { arrayKey: string; inputKey?: string };
  hasReds: boolean;
  redsAuthority?: RedAuthority;
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
  fanoutDots?: PhaseStatus[];
};

// Stub so any leftover importer compiles cleanly. Returns no pills.
export function buildPhaseShape(..._args: unknown[]): PhaseShape[] {
  return [];
}

// Stub for the same reason — was a single-phase helper.
export function buildPhaseShapeForPhase(..._args: unknown[]): PhaseShape | undefined {
  return undefined;
}

// taskStatusToPhase + compareTaskAttention were internal helpers; preserve the
// status mapping for any client-side use though.
export function _taskStatusToPhase(s: TaskStatus): PhaseStatus {
  if (s === "complete") return "done";
  return s as PhaseStatus;
}
