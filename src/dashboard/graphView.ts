// #85 graph view — data transformer that takes a run + phaseShape + tasks
// and produces cytoscape-friendly {nodes, edges} JSON for the graph modal.
//
// Responsibility split (mirrors phaseShape.ts):
//  - graphView.ts (this file) is pure data — no DOM, no rendering, just
//    JSON in / JSON out. Unit-testable in isolation.
//  - The dashboard's html.ts owns the modal shell, cytoscape import, and
//    layout/style configuration.
//
// V0 scope: phase nodes status-coded per design Component Library, linear
// edges between sequential phases. Defers fanout cluster, retry chains,
// onReject back-edges, side panel, minimap to v1 (architecture in BACKLOG
// #85). The data shape is forward-compatible — once the renderer learns
// how to draw fanout clusters, this transformer adds them.

import type { PhaseShape } from "./phaseShape.js";
import type { Run, Task } from "../types/index.js";

// Cytoscape's ele JSON format — we don't depend on cytoscape's types here
// to keep this file pure. The structure matches what cy.add() consumes.
export type CyNode = {
  data: {
    id: string;
    label: string;
    // PhaseStatus from phaseShape, used by the renderer to choose styling
    // (matches the Component Library's node/* atoms).
    status: PhaseShape["status"];
    // Counts for the node's sublabel ("3 tasks · 2 done · 1 running").
    taskCounts: PhaseShape["taskCounts"];
    // True for phases that fan out — the renderer may draw a cluster vs a
    // single node depending on whether fanoutDots is non-empty.
    hasFanout: boolean;
    hasReds: boolean;
    redsAuthority?: PhaseShape["redsAuthority"];
    isManual: boolean;
    // V1 will use this to draw per-task subnodes inside a cluster. V0
    // ignores it.
    fanoutDots?: PhaseShape["fanoutDots"];
  };
};

export type CyEdge = {
  data: {
    id: string;
    source: string;
    target: string;
    // "linear" = next-phase forward edge.
    // "onReject" = curved back-edge (v1).
    // "retry" = retry chain (v1).
    kind: "linear" | "onReject" | "retry";
    // Optional label rendered on the edge (gate decision, "reject", etc.)
    label?: string;
  };
};

export type GraphData = {
  nodes: CyNode[];
  edges: CyEdge[];
};

// Build cytoscape data from the run's phase shape. V0: linear forward
// edges only; phase nodes carry status + counts + metadata.
//
// `_run` and `_tasks` are accepted but unused in v0 (they'll feed retry
// chains and gate-decision labels in v1). Listed in the signature so the
// caller doesn't need to refactor when v1 lands.
export function buildGraphData(
  phaseShape: PhaseShape[],
  _run?: Run,
  _tasks?: Task[]
): GraphData {
  const nodes: CyNode[] = phaseShape.map((p) => ({
    data: {
      id: nodeId(p.name),
      label: p.name,
      status: p.status,
      taskCounts: p.taskCounts,
      hasFanout: p.hasFanout,
      hasReds: p.hasReds,
      ...(p.redsAuthority !== undefined ? { redsAuthority: p.redsAuthority } : {}),
      isManual: p.isManual,
      ...(p.fanoutDots !== undefined ? { fanoutDots: p.fanoutDots } : {}),
    },
  }));

  // Linear edges: phase[i] → phase[i+1].
  const edges: CyEdge[] = [];
  for (let i = 0; i < phaseShape.length - 1; i++) {
    const from = phaseShape[i]!;
    const to = phaseShape[i + 1]!;
    edges.push({
      data: {
        id: edgeId(from.name, to.name, "linear"),
        source: nodeId(from.name),
        target: nodeId(to.name),
        kind: "linear",
      },
    });
  }

  // onReject back-edges: when a phase has onReject set, draw a back-edge
  // to the target phase. Renderer may draw curved + dashed in v1; v0
  // emits the data and lets the renderer choose styling.
  for (const p of phaseShape) {
    if (p.onReject) {
      edges.push({
        data: {
          id: edgeId(p.name, p.onReject, "onReject"),
          source: nodeId(p.name),
          target: nodeId(p.onReject),
          kind: "onReject",
          label: "reject",
        },
      });
    }
  }

  return { nodes, edges };
}

// Node + edge id helpers. Stable across renders so cytoscape's diff is cheap.
function nodeId(phaseName: string): string {
  return "n:" + phaseName;
}

function edgeId(from: string, to: string, kind: CyEdge["data"]["kind"]): string {
  return "e:" + kind + ":" + from + "->" + to;
}
