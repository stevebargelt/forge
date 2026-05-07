import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { insertRun } from "../store/runs.js";
import { insertTask } from "../store/tasks.js";
import { deriveFanoutInputs } from "./gate.js";
import { createPhaseTasks } from "./next.js";
import type { Run, Task, Workflow, Phase, AgentRef } from "../types/index.js";

let db: DatabaseInstance;
let prev: DatabaseInstance | null;

const RUN: Run = {
  id: "run-fan",
  workflow: "investigation",
  title: "test",
  status: "active",
  createdAt: "2026-05-06T00:00:00Z",
};

const FRAMER: AgentRef = { role: "framer", agentDir: "/x", model: "m" };
const INVESTIGATOR: AgentRef = { role: "investigator", agentDir: "/x", model: "m" };

function workflow(): Workflow {
  return {
    name: "investigation",
    description: "",
    phases: [
      { name: "frame", agents: [FRAMER], gate: "human" },
      {
        name: "investigate",
        agents: [INVESTIGATOR],
        gate: "human",
        fanoutFromUpstream: { arrayKey: "claims", inputKey: "claim" },
      },
      { name: "synthesize", agents: [FRAMER], gate: "auto" },
    ],
  };
}

function makeUpstreamTask(id: string, result: unknown): Task {
  return {
    id,
    runId: RUN.id,
    phase: "frame",
    agentRole: "framer",
    status: "complete",
    taskPackage: { taskId: id, runId: RUN.id, phase: "frame", role: "framer", inputs: {}, composedSystemPrompt: "" },
    result,
    createdAt: "2026-05-06T00:00:00Z",
  };
}

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
  insertRun(RUN);
});

afterEach(() => {
  setDbForTest(prev as DatabaseInstance);
  db.close();
});

// ---------- deriveFanoutInputs ----------

test("deriveFanoutInputs: undefined when phase has no fanoutFromUpstream", () => {
  const phase = { fanoutFromUpstream: undefined };
  const out = deriveFanoutInputs(phase, [makeUpstreamTask("u1", { claims: ["a", "b"] })]);
  assert.equal(out, undefined);
});

test("deriveFanoutInputs: undefined when no completed upstream tasks", () => {
  const phase = { fanoutFromUpstream: { arrayKey: "claims" } };
  const out = deriveFanoutInputs(phase, []);
  assert.equal(out, undefined);
});

test("deriveFanoutInputs: undefined when upstream lacks arrayKey", () => {
  const phase = { fanoutFromUpstream: { arrayKey: "claims" } };
  const out = deriveFanoutInputs(phase, [makeUpstreamTask("u1", { other: "data" })]);
  assert.equal(out, undefined);
});

test("deriveFanoutInputs: undefined when arrayKey is empty array", () => {
  const phase = { fanoutFromUpstream: { arrayKey: "claims" } };
  const out = deriveFanoutInputs(phase, [makeUpstreamTask("u1", { claims: [] })]);
  assert.equal(out, undefined);
});

test("deriveFanoutInputs: produces one input per array entry under explicit inputKey", () => {
  const phase = { fanoutFromUpstream: { arrayKey: "claims", inputKey: "claim" } };
  const out = deriveFanoutInputs(phase, [
    makeUpstreamTask("u1", { claims: ["c1", "c2", "c3"] }),
  ]);
  assert.deepEqual(out, [{ claim: "c1" }, { claim: "c2" }, { claim: "c3" }]);
});

test("deriveFanoutInputs: defaults inputKey to singular(arrayKey)", () => {
  const phase = { fanoutFromUpstream: { arrayKey: "lenses" } }; // no explicit inputKey
  const out = deriveFanoutInputs(phase, [
    makeUpstreamTask("u1", { lenses: ["security", "perf"] }),
  ]);
  assert.deepEqual(out, [{ lens: "security" }, { lens: "perf" }]);
});

test("deriveFanoutInputs: singularize handles -ies → -y", () => {
  const phase = { fanoutFromUpstream: { arrayKey: "stories" } };
  const out = deriveFanoutInputs(phase, [makeUpstreamTask("u1", { stories: ["a"] })]);
  assert.deepEqual(out, [{ story: "a" }]);
});

test("deriveFanoutInputs: singularize is a no-op for words not ending in s/ies/ses", () => {
  const phase = { fanoutFromUpstream: { arrayKey: "data" } };
  const out = deriveFanoutInputs(phase, [makeUpstreamTask("u1", { data: ["x"] })]);
  // 'data' doesn't end in 's' so singularize returns it unchanged
  assert.deepEqual(out, [{ data: "x" }]);
});

test("deriveFanoutInputs: singularize trailing-s case (claims → claim)", () => {
  const phase = { fanoutFromUpstream: { arrayKey: "claims" } };
  const out = deriveFanoutInputs(phase, [makeUpstreamTask("u1", { claims: ["c"] })]);
  assert.deepEqual(out, [{ claim: "c" }]);
});

test("deriveFanoutInputs: object entries pass through verbatim", () => {
  const phase = { fanoutFromUpstream: { arrayKey: "tasks", inputKey: "task" } };
  const out = deriveFanoutInputs(phase, [
    makeUpstreamTask("u1", {
      tasks: [{ id: 1, title: "a" }, { id: 2, title: "b" }],
    }),
  ]);
  assert.deepEqual(out, [
    { task: { id: 1, title: "a" } },
    { task: { id: 2, title: "b" } },
  ]);
});

// ---------- createPhaseTasks: upstream-context bridge ----------

test("createPhaseTasks: first phase (no upstream) gets empty inputs", () => {
  const wf = workflow();
  const created = createPhaseTasks(RUN, wf, "frame");
  assert.equal(created.length, 1);
  assert.deepEqual(created[0]!.taskPackage.inputs, {});
});

test("createPhaseTasks: downstream phase with no fanout gets inputs.upstream", () => {
  const wf = workflow();
  // Seed a completed upstream blue task (no fanout from this one in our config)
  insertTask({
    id: "frame-1",
    runId: RUN.id,
    phase: "frame",
    agentRole: "framer",
    status: "complete",
    taskPackage: {
      taskId: "frame-1",
      runId: RUN.id,
      phase: "frame",
      role: "framer",
      inputs: {},
      composedSystemPrompt: "",
    },
    result: { summary: "framed it" },
    createdAt: "2026-05-06T00:00:00Z",
  });
  // Create the synthesize phase (downstream of investigate, but for this test we test the
  // upstream-bridge directly by creating after frame).
  const wf2 = {
    ...wf,
    phases: [wf.phases[0]!, { name: "downstream", agents: [INVESTIGATOR], gate: "auto" } as Phase],
  };
  const created = createPhaseTasks(RUN, wf2, "downstream");
  assert.equal(created.length, 1);
  const inputs = created[0]!.taskPackage.inputs;
  assert.ok(Array.isArray(inputs.upstream));
  const up = inputs.upstream as Array<{ taskId: string; agentRole: string; result: unknown }>;
  assert.equal(up.length, 1);
  assert.equal(up[0]!.agentRole, "framer");
  assert.deepEqual(up[0]!.result, { summary: "framed it" });
});

test("createPhaseTasks: upstream excludes red tasks from the bridge", () => {
  const wf = workflow();
  insertTask({
    id: "frame-1",
    runId: RUN.id,
    phase: "frame",
    agentRole: "framer",
    status: "complete",
    taskPackage: {
      taskId: "frame-1",
      runId: RUN.id,
      phase: "frame",
      role: "framer",
      inputs: {},
      composedSystemPrompt: "",
    },
    result: { good: true },
    createdAt: "2026-05-06T00:00:00Z",
  });
  insertTask({
    id: "red-frame-1",
    runId: RUN.id,
    phase: "frame",
    agentRole: "red-wide",
    parentId: "frame-1",
    status: "complete",
    taskPackage: {
      taskId: "red-frame-1",
      runId: RUN.id,
      phase: "frame",
      role: "red-wide",
      inputs: {},
      composedSystemPrompt: "",
    },
    result: { verdict: "pass", confidence: 0.9, findings: [] },
    createdAt: "2026-05-06T00:00:00Z",
  });

  const wf2 = {
    ...wf,
    phases: [wf.phases[0]!, { name: "downstream", agents: [INVESTIGATOR], gate: "auto" } as Phase],
  };
  const created = createPhaseTasks(RUN, wf2, "downstream");
  const up = created[0]!.taskPackage.inputs.upstream as Array<{ agentRole: string }>;
  assert.equal(up.length, 1);
  assert.equal(up[0]!.agentRole, "framer");
  // Red role should be excluded
  assert.equal(up.some((t) => t.agentRole.startsWith("red-")), false);
});

test("createPhaseTasks: explicit perAgentInputs are merged with upstream context", () => {
  const wf = workflow();
  // Seed completed upstream
  insertTask({
    id: "frame-1",
    runId: RUN.id,
    phase: "frame",
    agentRole: "framer",
    status: "complete",
    taskPackage: {
      taskId: "frame-1",
      runId: RUN.id,
      phase: "frame",
      role: "framer",
      inputs: {},
      composedSystemPrompt: "",
    },
    result: { claims: ["c1", "c2"] },
    createdAt: "2026-05-06T00:00:00Z",
  });

  // Use createPhaseTasks with explicit perAgentInputs (simulates fanout-from-upstream caller)
  const created = createPhaseTasks(RUN, wf, "investigate", {
    perAgentInputs: [{ claim: "c1" }, { claim: "c2" }],
  });
  assert.equal(created.length, 2);
  for (const t of created) {
    assert.ok(t.taskPackage.inputs.claim, "claim key should be preserved");
    assert.ok(t.taskPackage.inputs.upstream, "upstream key should be added");
  }
  assert.equal(created[0]!.taskPackage.inputs.claim, "c1");
  assert.equal(created[1]!.taskPackage.inputs.claim, "c2");
});

test("createPhaseTasks: commonInputs is merged into every created task", () => {
  const wf = workflow();
  // Two-claim fanout, with rejection metadata that should appear in BOTH tasks.
  insertTask({
    id: "frame-2",
    runId: RUN.id,
    phase: "frame",
    agentRole: "framer",
    status: "complete",
    taskPackage: {
      taskId: "frame-2",
      runId: RUN.id,
      phase: "frame",
      role: "framer",
      inputs: {},
      composedSystemPrompt: "",
    },
    result: { claims: ["c1", "c2"] },
    createdAt: "2026-05-06T00:00:00Z",
  });

  const created = createPhaseTasks(RUN, wf, "investigate", {
    perAgentInputs: [{ claim: "c1" }, { claim: "c2" }],
    commonInputs: { rejectedRationale: "out of scope", rejectedTaskId: "earlier-task" },
  });
  assert.equal(created.length, 2);
  for (const t of created) {
    assert.equal(t.taskPackage.inputs.rejectedRationale, "out of scope");
    assert.equal(t.taskPackage.inputs.rejectedTaskId, "earlier-task");
    assert.ok(t.taskPackage.inputs.claim, "per-agent input still present");
    assert.ok(t.taskPackage.inputs.upstream, "upstream still injected");
  }
});

test("createPhaseTasks: per-agent inputs win over commonInputs on key collision", () => {
  const wf = workflow();
  const created = createPhaseTasks(RUN, wf, "frame", {
    perAgentInputs: [{ source: "specific" }],
    commonInputs: { source: "common" },
  });
  assert.equal(created.length, 1);
  assert.equal(
    created[0]!.taskPackage.inputs.source,
    "specific",
    "per-agent input takes precedence"
  );
});
