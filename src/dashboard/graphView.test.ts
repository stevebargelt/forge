// Tests for graphView.ts data transformer (#85). Pure function over
// PhaseShape — no DOM, no rendering, just shape assertions.

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildGraphData } from "./graphView.js";
import type { PhaseShape } from "./phaseShape.js";

function phase(
  name: string,
  status: PhaseShape["status"],
  overrides: Partial<PhaseShape> = {}
): PhaseShape {
  return {
    name,
    agentRoles: [],
    gate: "human",
    isManual: false,
    hasFanout: false,
    hasReds: false,
    status,
    taskCounts: { total: 0, running: 0, complete: 0, failed: 0, pending: 0, awaitingGate: 0, awaitingRed: 0, awaitingHuman: 0, blockedByRed: 0 },
    ...overrides,
  };
}

test("buildGraphData produces one node per phase", () => {
  const shape: PhaseShape[] = [
    phase("brief", "done"),
    phase("architect", "running"),
    phase("build", "pending"),
  ];
  const g = buildGraphData(shape);
  assert.equal(g.nodes.length, 3);
  assert.deepEqual(g.nodes.map((n) => n.data.label), ["brief", "architect", "build"]);
});

test("buildGraphData emits linear edges between sequential phases", () => {
  const shape: PhaseShape[] = [
    phase("brief", "done"),
    phase("architect", "running"),
    phase("build", "pending"),
  ];
  const g = buildGraphData(shape);
  // 3 phases → 2 linear edges
  const linear = g.edges.filter((e) => e.data.kind === "linear");
  assert.equal(linear.length, 2);
  assert.equal(linear[0]!.data.source, "n:brief");
  assert.equal(linear[0]!.data.target, "n:architect");
  assert.equal(linear[1]!.data.source, "n:architect");
  assert.equal(linear[1]!.data.target, "n:build");
});

test("buildGraphData emits onReject back-edges when a phase has onReject", () => {
  const shape: PhaseShape[] = [
    phase("brief", "done"),
    phase("ui-review", "done", { onReject: "brief", isManual: true }),
    phase("architect", "running", { onReject: "brief" }),
  ];
  const g = buildGraphData(shape);
  const onReject = g.edges.filter((e) => e.data.kind === "onReject");
  assert.equal(onReject.length, 2);
  assert.equal(onReject[0]!.data.source, "n:ui-review");
  assert.equal(onReject[0]!.data.target, "n:brief");
  assert.equal(onReject[0]!.data.label, "reject");
  assert.equal(onReject[1]!.data.source, "n:architect");
  assert.equal(onReject[1]!.data.target, "n:brief");
});

test("buildGraphData carries status, counts, and fanout metadata onto node data", () => {
  const shape: PhaseShape[] = [
    phase("investigate", "running", {
      hasFanout: true,
      taskCounts: { total: 16, running: 3, complete: 12, failed: 1, pending: 0, awaitingGate: 0, awaitingRed: 0, awaitingHuman: 0, blockedByRed: 0 },
      fanoutDots: ["done", "done", "done", "done", "done", "done", "done", "done", "done", "done", "done", "done", "running", "running", "running", "failed"],
    }),
  ];
  const g = buildGraphData(shape);
  const node = g.nodes[0]!;
  assert.equal(node.data.status, "running");
  assert.equal(node.data.taskCounts.total, 16);
  assert.equal(node.data.hasFanout, true);
  assert.ok(node.data.fanoutDots);
  assert.equal(node.data.fanoutDots!.length, 16);
});

test("buildGraphData carries reds metadata", () => {
  const shape: PhaseShape[] = [
    phase("build", "running", {
      hasReds: true,
      redsAuthority: "authoritative",
    }),
  ];
  const g = buildGraphData(shape);
  assert.equal(g.nodes[0]!.data.hasReds, true);
  assert.equal(g.nodes[0]!.data.redsAuthority, "authoritative");
});

test("buildGraphData with empty phaseShape produces empty graph", () => {
  const g = buildGraphData([]);
  assert.equal(g.nodes.length, 0);
  assert.equal(g.edges.length, 0);
});

test("buildGraphData with single-phase workflow produces one node, no edges", () => {
  const g = buildGraphData([phase("only", "running")]);
  assert.equal(g.nodes.length, 1);
  assert.equal(g.edges.length, 0);
});

test("node + edge ids are stable + unique", () => {
  const shape: PhaseShape[] = [
    phase("a", "done"),
    phase("b", "running", { onReject: "a" }),
  ];
  const g = buildGraphData(shape);
  const ids = new Set<string>();
  for (const n of g.nodes) ids.add(n.data.id);
  for (const e of g.edges) ids.add(e.data.id);
  // 2 nodes + 1 linear + 1 onReject = 4 unique ids
  assert.equal(ids.size, 4);
});

test("isManual + redsAuthority preserved on node data when present", () => {
  const shape: PhaseShape[] = [
    phase("ui-review", "done", { isManual: true, hasReds: false }),
    phase("build", "running", { isManual: false, hasReds: true, redsAuthority: "authoritative" }),
  ];
  const g = buildGraphData(shape);
  assert.equal(g.nodes[0]!.data.isManual, true);
  assert.equal(g.nodes[1]!.data.isManual, false);
  assert.equal(g.nodes[1]!.data.redsAuthority, "authoritative");
});
