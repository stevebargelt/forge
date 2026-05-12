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
    fanoutDots?: PhaseShape["fanoutDots"];
    // Cytoscape compound-node parent reference. Set on per-task child
    // nodes within a fanout phase; points to the phase node id. Renderer
    // hides/shows children based on collapse/expand state.
    parent?: string;
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

// Build cytoscape data from the run's phase shape. v1 emits:
//  - one parent node per phase (always)
//  - per-task child nodes for fanout phases, parented to the phase node
//    via cytoscape's compound-node mechanism (data.parent = phase id)
//  - linear forward edges between sequential phases
//  - onReject back-edges
//
// `_run` and `_tasks` are accepted but unused — they'll feed retry chains
// (#99) and gate-decision labels in a later version. Listed in the
// signature so the caller doesn't need to refactor when those land.
export function buildGraphData(
  phaseShape: PhaseShape[],
  _run?: Run,
  _tasks?: Task[]
): GraphData {
  const nodes: CyNode[] = [];
  for (const p of phaseShape) {
    nodes.push({
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
    });
    // Fanout child nodes: one per task, parented to the phase node.
    // Renderer can hide/show children to implement collapse/expand. Each
    // child carries its own per-task status from fanoutDots (which is in
    // task creation order — see phaseShape.ts).
    if (p.hasFanout && p.fanoutDots && p.fanoutDots.length > 0) {
      p.fanoutDots.forEach((dotStatus, i) => {
        nodes.push({
          data: {
            id: childNodeId(p.name, i),
            label: p.name + " · " + (i + 1),
            status: dotStatus,
            taskCounts: { total: 1, running: 0, complete: 0, failed: 0, pending: 0, awaitingGate: 0, awaitingRed: 0, awaitingHuman: 0, blockedByRed: 0 },
            hasFanout: false,
            hasReds: false,
            isManual: false,
            parent: nodeId(p.name),
          },
        });
      });
    }
  }

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

// Per-task child node id within a fanout phase. Index is the task's
// position in fanoutDots (creation order).
function childNodeId(phaseName: string, index: number): string {
  return "n:" + phaseName + ":t" + index;
}

function edgeId(from: string, to: string, kind: CyEdge["data"]["kind"]): string {
  return "e:" + kind + ":" + from + "->" + to;
}
