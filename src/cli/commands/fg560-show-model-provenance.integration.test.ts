// FG-560 (step 9): the `forge show <task>` OPERATOR SURFACE for mapping-path
// provenance. A persisted task row carries resolved_mapping_path +
// resolved_capability_source (step 3); show renders them on their OWN line,
// distinct from the profile-selection provenance (resolvedBy). Legacy rows carry
// none and render unchanged. Driven through the REAL registered command.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { Command } from "commander";
import { makeInMemoryDb, setDbForTest } from "../../store/db.js";
import { insertRun } from "../../store/runs.js";
import { insertTask } from "../../store/tasks.js";
import { registerShow } from "./show.js";
import type { Run, Task } from "../../types/index.js";

let db: DatabaseInstance;
let prev: DatabaseInstance | null;

const RUN: Run = {
  id: "run-fg560-show",
  workflow: "feature",
  title: "fg560 show provenance",
  status: "active",
  createdAt: "2026-08-15T10:00:00Z",
};

function makeTask(id: string, over: Partial<Task> = {}): Task {
  return {
    id,
    runId: RUN.id,
    phase: "build",
    agentRole: "engineer",
    status: "complete",
    taskPackage: { taskId: id, runId: RUN.id, phase: "build", role: "engineer", inputs: {}, composedSystemPrompt: "" },
    createdAt: "2026-08-15T10:00:00Z",
    ...over,
  } as Task;
}

async function runShow(id: string, args: string[] = []): Promise<string> {
  const program = new Command();
  program.exitOverride();
  registerShow(program);
  const lines: string[] = [];
  const realLog = console.log;
  console.log = (...a: unknown[]) => { lines.push(a.map(String).join(" ")); };
  try {
    await program.parseAsync(["node", "forge", "show", id, ...args]);
    return lines.join("\n");
  } finally {
    console.log = realLog;
  }
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

test("show (human): an EXACT activity mapping renders a distinct `mapping:` line", async () => {
  insertTask(makeTask("task-exact", {
    agentAlias: "reasoning",
    agentModel: "claude-opus-4-8",
    resolvedProfile: "claude-subscription",
    resolvedProvider: "anthropic",
    resolvedAuth: "subscription",
    resolvedBy: "defaults.activity.reasoning",
    resolvedCapabilitySource: "explicit",
    resolvedMappingPath: "exact",
  }));
  const out = await runShow("task-exact");
  assert.match(out, /profile:\s+claude-subscription/);
  assert.match(out, /mapping:\s+exact/);
  assert.doesNotMatch(out, /activity_unmapped/);
});

test("show (human): a DEFAULT-FALLBACK for an explicit activity is labelled distinctly and never as satisfied", async () => {
  insertTask(makeTask("task-fallback", {
    agentAlias: "reasoning",
    agentModel: "us.anthropic.claude-sonnet-4-6",
    resolvedProfile: "claude-bedrock",
    resolvedProvider: "anthropic",
    resolvedAuth: "bedrock",
    resolvedBy: "overrides.agents.engineer",
    resolvedCapabilitySource: "explicit",
    resolvedMappingPath: "default-fallback",
  }));
  const out = await runShow("task-fallback");
  assert.match(out, /mapping:\s+default-fallback/);
  assert.match(out, /EXPLICIT activity is NOT mapped/);
  assert.match(out, /activity_unmapped/);
});

test("show (--json): mapping-path provenance rides in diagnostic.modelProvenance alongside resolvedBy", async () => {
  insertTask(makeTask("task-json", {
    agentAlias: "reasoning",
    agentModel: "claude-opus-4-8",
    resolvedProfile: "claude-subscription",
    resolvedProvider: "anthropic",
    resolvedAuth: "subscription",
    resolvedBy: "defaults.activity.reasoning",
    resolvedCapabilitySource: "explicit",
    resolvedMappingPath: "exact",
  }));
  const out = await runShow("task-json", ["--json"]);
  const parsed = JSON.parse(out) as {
    task: { resolvedMappingPath?: string; resolvedCapabilitySource?: string; resolvedBy?: string };
    diagnostic: { modelProvenance: { mappingPath: string; capabilitySource: string; resolvedBy: string; activityUnmapped: boolean } | null };
  };
  // The task row itself carries the durable axes.
  assert.equal(parsed.task.resolvedMappingPath, "exact");
  assert.equal(parsed.task.resolvedCapabilitySource, "explicit");
  // And the diagnostic block names them readably alongside resolvedBy (separate axis).
  assert.ok(parsed.diagnostic.modelProvenance);
  assert.equal(parsed.diagnostic.modelProvenance!.mappingPath, "exact");
  assert.equal(parsed.diagnostic.modelProvenance!.resolvedBy, "defaults.activity.reasoning");
  assert.equal(parsed.diagnostic.modelProvenance!.activityUnmapped, false);
});

test("show (legacy task): NO mapping line, and diagnostic.modelProvenance is null — unchanged", async () => {
  insertTask(makeTask("task-legacy", { agentModel: "claude-sonnet-4-6" }));
  const human = await runShow("task-legacy");
  assert.doesNotMatch(human.replace(/agent_role|agentRole/g, ""), /mapping:/);

  const json = await runShow("task-legacy", ["--json"]);
  const parsed = JSON.parse(json) as { diagnostic: { modelProvenance: unknown } };
  assert.equal(parsed.diagnostic.modelProvenance, null);
});
