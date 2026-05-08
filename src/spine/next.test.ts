import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldAutoFinalize } from "./next.js";
import type { Workflow, Task, AgentRef } from "../types/index.js";

const AGENT: AgentRef = { role: "framer", agentDir: "/x", alias: "spec-writer", model: "m" };

function workflowWithPhases(phaseNames: string[]): Workflow {
  return {
    name: "investigation",
    description: "",
    phases: phaseNames.map((name) => ({ name, agents: [AGENT], gate: "auto" })),
  };
}

function task(phase: string, status: Task["status"]): Task {
  return {
    id: "t-" + phase + "-" + status,
    runId: "r",
    phase,
    agentRole: "framer",
    status,
    taskPackage: { taskId: "t", runId: "r", phase, role: "framer", inputs: {}, composedSystemPrompt: "" },
    createdAt: "2026-05-08T00:00:00Z",
  };
}

test("shouldAutoFinalize: true when all tasks complete on terminal phase", () => {
  const wf = workflowWithPhases(["only"]);
  const tasks = [task("only", "complete"), task("only", "complete")];
  assert.equal(shouldAutoFinalize(wf, "only", tasks), true);
});

test("shouldAutoFinalize: false when terminal phase has any non-complete task", () => {
  const wf = workflowWithPhases(["only"]);
  assert.equal(shouldAutoFinalize(wf, "only", [task("only", "complete"), task("only", "running")]), false);
  assert.equal(shouldAutoFinalize(wf, "only", [task("only", "awaiting_gate")]), false);
  assert.equal(shouldAutoFinalize(wf, "only", [task("only", "failed")]), false);
});

test("shouldAutoFinalize: false when phase has a successor (not terminal)", () => {
  const wf = workflowWithPhases(["first", "second"]);
  const tasks = [task("first", "complete")];
  assert.equal(shouldAutoFinalize(wf, "first", tasks), false);
});

test("shouldAutoFinalize: true on the last phase of a multi-phase workflow", () => {
  const wf = workflowWithPhases(["first", "last"]);
  const tasks = [task("last", "complete")];
  assert.equal(shouldAutoFinalize(wf, "last", tasks), true);
});

test("shouldAutoFinalize: false when refreshed tasks list is empty", () => {
  const wf = workflowWithPhases(["only"]);
  assert.equal(shouldAutoFinalize(wf, "only", []), false);
});
