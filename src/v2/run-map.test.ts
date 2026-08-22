// FG-348 [B]: buildRunMap unit spec. Proves the workflow layer groups fanout
// children and attaches reds via verdicts, and that a run whose workflow won't
// load degrades to an execution-layer graph with inferred labels without throwing.

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRunMap, type RunMapVerdict } from "./run-map.js";
import { RUN_EXPLAIN_VERSION } from "./run-explain-types.js";
import type { Run, Task, TaskPackage } from "../types/index.js";
import type { Workflow, Step } from "./schema.js";

function mkStep(opts: Partial<Step> & { id: string }): Step {
  return { depends_on: [], reds: [], manual: false, runtime: "claude", gate: "auto", ...opts } as Step;
}

function mkWorkflow(steps: Step[]): Workflow {
  return { name: "feature", description: "test", review_mode: "legacy_verdict", inputs: [], steps };
}

function mkRun(opts: Partial<Run> = {}): Run {
  return {
    id: "run1",
    workflow: "feature",
    title: "Test run",
    status: "active",
    createdAt: "2026-08-01T00:00:00.000Z",
    ...opts,
  };
}

let seq = 0;
function mkTask(opts: {
  id: string;
  phase: string;
  parentId?: string;
  agentRole?: string;
  createdAt?: string;
  status?: Task["status"];
  inputs?: Record<string, unknown>;
  dispatchSource?: TaskPackage["dispatchSource"];
  agentAlias?: string;
  agentModel?: string;
  resolvedProfile?: string;
}): Task {
  const taskPackage: TaskPackage = {
    taskId: opts.id,
    runId: "run1",
    phase: opts.phase,
    role: opts.agentRole ?? "engineer",
    inputs: opts.inputs ?? {},
    composedSystemPrompt: "",
    ...(opts.dispatchSource ? { dispatchSource: opts.dispatchSource } : { dispatchSource: "workflow" }),
  };
  return {
    id: opts.id,
    runId: "run1",
    ...(opts.parentId ? { parentId: opts.parentId } : {}),
    phase: opts.phase,
    agentRole: opts.agentRole ?? "engineer",
    status: opts.status ?? "complete",
    ...(opts.agentAlias !== undefined ? { agentAlias: opts.agentAlias } : {}),
    ...(opts.agentModel !== undefined ? { agentModel: opts.agentModel } : {}),
    ...(opts.resolvedProfile !== undefined ? { resolvedProfile: opts.resolvedProfile } : {}),
    taskPackage,
    createdAt: opts.createdAt ?? `2026-08-01T00:00:0${seq++ % 10}.000Z`,
  };
}

const WORKFLOW = mkWorkflow([
  mkStep({ id: "plan", agent: "tech-lead" }),
  mkStep({
    id: "build",
    agent: "engineer",
    depends_on: ["plan"],
    gate: "verdict",
    reds: [
      { agent: "red-wide", authority: "authoritative", gate_on_verdict: true },
      { agent: "shipping-reviewer", authority: "authoritative", gate_on_verdict: true },
    ],
    fanout: {
      from_upstream: { step: "plan", array_key: "steps", input_key: "step" },
      agent_map: {},
      max_concurrency: 4,
      failure_mode: "fail-phase",
    },
  } as Partial<Step> & { id: string }),
]);

test("carries the contract version", () => {
  const graph = buildRunMap({ run: mkRun(), tasks: [], verdicts: [], workflow: WORKFLOW });
  assert.equal(graph.version, RUN_EXPLAIN_VERSION);
});

test("workflow layer: phases, edges, gate types from the loaded workflow", () => {
  const graph = buildRunMap({ run: mkRun(), tasks: [], verdicts: [], workflow: WORKFLOW });
  assert.equal(graph.workflowResolved, true);
  assert.deepEqual(
    graph.phases.map((p) => p.id),
    ["plan", "build"],
  );
  const build = graph.phases.find((p) => p.id === "build")!;
  assert.equal(build.fanout, true);
  assert.equal(build.gate, "verdict");
  assert.deepEqual(build.reds, ["red-wide", "shipping-reviewer"]);
  assert.deepEqual(graph.edges, [{ from: "plan", to: "build" }]);
});

test("groups fanout children under their phase with the primary as parent", () => {
  const planPrimary = mkTask({ id: "t-plan", phase: "plan", agentRole: "tech-lead" });
  const buildParent = mkTask({ id: "t-build", phase: "build", agentRole: "engineer" });
  const child1 = mkTask({ id: "c1", phase: "build", parentId: "t-build", inputs: { fanoutIndex: 0 } });
  const child2 = mkTask({ id: "c2", phase: "build", parentId: "t-build", inputs: { fanoutIndex: 1 } });
  const graph = buildRunMap({
    run: mkRun(),
    tasks: [planPrimary, buildParent, child1, child2],
    verdicts: [],
    workflow: WORKFLOW,
  });
  assert.equal(graph.fanoutGroups.length, 1);
  const group = graph.fanoutGroups[0]!;
  assert.equal(group.phase, "build");
  assert.equal(group.parentTaskId, "t-build");
  assert.deepEqual(group.childTaskIds.sort(), ["c1", "c2"]);
  assert.equal(group.count, 2);
});

test("attaches reds to their reviewed primary via verdicts (authoritative)", () => {
  const buildParent = mkTask({ id: "t-build", phase: "build", agentRole: "engineer" });
  const red = mkTask({ id: "r-wide", phase: "build", parentId: "t-build", agentRole: "red-wide" });
  const verdicts: RunMapVerdict[] = [{ taskId: "t-build", redTaskId: "r-wide", redRole: "red-wide" }];
  const graph = buildRunMap({ run: mkRun(), tasks: [buildParent, red], verdicts, workflow: WORKFLOW });
  assert.equal(graph.redAttachments.length, 1);
  assert.deepEqual(graph.redAttachments[0], {
    redTaskId: "r-wide",
    redRole: "red-wide",
    primaryTaskId: "t-build",
    via: "verdict",
  });
});

test("reds attach via parent_id fallback only when no verdict row exists", () => {
  const buildParent = mkTask({ id: "t-build", phase: "build", agentRole: "engineer" });
  const red = mkTask({ id: "r-ship", phase: "build", parentId: "t-build", agentRole: "shipping-reviewer" });
  const graph = buildRunMap({ run: mkRun(), tasks: [buildParent, red], verdicts: [], workflow: WORKFLOW });
  assert.equal(graph.redAttachments.length, 1);
  assert.equal(graph.redAttachments[0]!.via, "parent");
  assert.equal(graph.redAttachments[0]!.primaryTaskId, "t-build");
});

test("verdict attachment is preferred over parent for the same red", () => {
  const buildParent = mkTask({ id: "t-build", phase: "build", agentRole: "engineer" });
  const red = mkTask({ id: "r-wide", phase: "build", parentId: "t-build", agentRole: "red-wide" });
  const verdicts: RunMapVerdict[] = [{ taskId: "t-build", redTaskId: "r-wide", redRole: "red-wide" }];
  const graph = buildRunMap({ run: mkRun(), tasks: [buildParent, red], verdicts, workflow: WORKFLOW });
  const forRed = graph.redAttachments.filter((a) => a.redTaskId === "r-wide");
  assert.equal(forRed.length, 1);
  assert.equal(forRed[0]!.via, "verdict");
});

test("model badge is inferred (legacy) when no resolvedProfile is present", () => {
  const t = mkTask({ id: "t-build", phase: "build", agentAlias: "coding", agentModel: "claude-x" });
  const graph = buildRunMap({ run: mkRun(), tasks: [t], verdicts: [], workflow: WORKFLOW });
  const node = graph.nodes.find((n) => n.taskId === "t-build")!;
  assert.equal(node.model?.alias, "coding");
  assert.equal(node.model?.inferred, true);
});

test("model badge is authoritative when resolvedProfile is present", () => {
  const t = mkTask({ id: "t-build", phase: "build", agentAlias: "coding", resolvedProfile: "claude-bedrock" });
  const graph = buildRunMap({ run: mkRun(), tasks: [t], verdicts: [], workflow: WORKFLOW });
  const node = graph.nodes.find((n) => n.taskId === "t-build")!;
  assert.equal(node.model?.profile, "claude-bedrock");
  assert.notEqual(node.model?.inferred, true);
});

test("degrades to an execution-layer graph without throwing when the workflow is undefined", () => {
  const planPrimary = mkTask({ id: "t-plan", phase: "plan", agentRole: "tech-lead" });
  const buildParent = mkTask({ id: "t-build", phase: "build", agentRole: "engineer" });
  let graph!: ReturnType<typeof buildRunMap>;
  assert.doesNotThrow(() => {
    graph = buildRunMap({ run: mkRun(), tasks: [planPrimary, buildParent], verdicts: [], workflow: undefined });
  });
  assert.equal(graph.workflowResolved, false);
  // Phases reconstructed from task rows, all marked inferred.
  assert.deepEqual(
    graph.phases.map((p) => p.id).sort(),
    ["build", "plan"],
  );
  assert.ok(graph.phases.every((p) => p.inferred === true));
  assert.ok(graph.nodes.every((n) => n.inferred === true));
  assert.ok(graph.warnings.some((w) => /workflow definition could not be loaded/i.test(w)));
});

test("adds a project-override warning when the workflow came from the project", () => {
  const graph = buildRunMap({
    run: mkRun(),
    tasks: [],
    verdicts: [],
    workflow: WORKFLOW,
    workflowSource: "project",
  });
  assert.ok(graph.warnings.some((w) => /project workflow override is active/i.test(w)));
});

test("degraded graph still classifies fanout children by fanoutIndex", () => {
  const buildParent = mkTask({ id: "t-build", phase: "build", agentRole: "engineer" });
  const child = mkTask({ id: "c1", phase: "build", parentId: "t-build", inputs: { fanoutIndex: 0 } });
  const graph = buildRunMap({ run: mkRun(), tasks: [buildParent, child], verdicts: [], workflow: undefined });
  const childNode = graph.nodes.find((n) => n.taskId === "c1")!;
  assert.equal(childNode.lineage, "fanout_child");
});
