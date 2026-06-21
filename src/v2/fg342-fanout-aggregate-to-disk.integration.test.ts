// FG-342 regression: fan-out parent's aggregate result.json must be written to
// disk so downstream depends_on steps receive the children via deriveUpstream.
//
// This is the exact integration gap that let FG-342 ship: the research-synthesis
// synthesize step received result: undefined for research-primary and
// research-skeptic because neither fanout parent had a result.json on disk.

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { runNext, type DockerExecFn } from "./runNext.js";
import { startRun } from "./startRun.js";
import { tasksForRun } from "../store/tasks.js";
import { taskDir } from "../util/paths.js";
import type { Workflow } from "./schema.js";

// 3-step workflow: plan → research (fanout) → synthesize (depends_on research).
// Mirrors the research-synthesis shape that exposed FG-342.
const WORKFLOW: Workflow = {
  name: "fg342-test",
  description: "FG-342 regression test workflow",
  inputs: [],
  steps: [
    {
      id: "plan",
      agent: "planner",
      gate: "auto",
      manual: false,
      depends_on: [],
      runtime: "claude",
      reds: [],
    },
    {
      id: "research",
      agent: "researcher",
      gate: "auto",
      manual: false,
      depends_on: ["plan"],
      runtime: "claude",
      reds: [],
      fanout: {
        from_upstream: { step: "plan", array_key: "claims", input_key: "claim" },
        max_concurrency: 4,
        failure_mode: "fail-phase",
      },
    },
    {
      id: "synthesize",
      agent: "synthesizer",
      gate: "auto",
      manual: false,
      depends_on: ["research"],
      runtime: "claude",
      reds: [],
    },
  ],
};

function ensureRuntime(): void {
  const runtimePath = join(process.env.FORGE_HOME!, "runtimes", "claude.yml");
  if (existsSync(runtimePath)) return;
  mkdirSync(dirname(runtimePath), { recursive: true });
  writeFileSync(runtimePath, `name: claude
description: test stub runtime
image: test-image:latest
models:
  default: test-model
auth:
  mode: apikey
mounts:
  - { host: "\${TASK_DIR}", container: /task }
invocation:
  command: echo
  args: ["stub"]
container:
  name: "forge-\${TASK_ID}"
result:
  file: /task/result.json
`);
}

function makeRoutingExec(rules: Array<{ matches: (id: string) => boolean; result: unknown }>): DockerExecFn {
  return async ({ args, stdoutPath, stderrPath }) => {
    const nameIdx = args.indexOf("--name");
    const fullName = nameIdx >= 0 ? (args[nameIdx + 1] ?? "") : "";
    const taskId = fullName.replace(/^forge-/, "");
    const rule = rules.find((r) => r.matches(taskId));
    const dir = dirname(stdoutPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const result = rule ? rule.result : { status: "complete" };
    writeFileSync(join(dir, "result.json"), JSON.stringify(result));
    writeFileSync(stdoutPath, "stub stdout");
    writeFileSync(stderrPath, "");
    return 0;
  };
}

test("FG-342: fanout parent writes aggregate to result.json on disk after children complete", async () => {
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  ensureRuntime();

  const { runId } = startRun({
    workflow: WORKFLOW,
    title: "fg342-disk-test",
    inputs: {},
    projectDir: "/tmp/test-project",
  });

  const claims = ["claim-a", "claim-b"];
  const exec = makeRoutingExec([
    {
      matches: (id) => id.startsWith("task-plan-"),
      result: { status: "complete", claims },
    },
    {
      matches: (id) => id.startsWith("task-research-"),
      result: { status: "complete", findings: ["evidence found"] },
    },
  ]);

  await runNext({ runId, workflow: WORKFLOW, dockerExec: exec }); // wave 1: plan
  await runNext({ runId, workflow: WORKFLOW, dockerExec: exec }); // wave 2: research fanout

  const tasks = tasksForRun(runId);
  const researchParent = tasks.find((t) => t.phase === "research" && t.parentId === undefined)!;
  assert.ok(researchParent, "research parent task must exist");
  assert.equal(researchParent.status, "complete");

  // FG-342: result.json must exist on disk for the fanout parent
  const resultPath = join(taskDir(runId, researchParent.id), "result.json");
  assert.ok(existsSync(resultPath), `fanout parent result.json must exist on disk at ${resultPath}`);

  const onDisk = JSON.parse(readFileSync(resultPath, "utf8")) as {
    status: string;
    children: Array<{ index: number; status: string; childTaskId: string; result: unknown }>;
  };
  assert.equal(onDisk.status, "complete");
  assert.equal(onDisk.children.length, 2, "aggregate must include both claim children");
  assert.ok(onDisk.children.every((c) => c.status === "complete"), "all children complete in aggregate");
  assert.ok(
    onDisk.children.every((c) => c.result !== undefined),
    "each child must carry its actual result (not undefined) in the aggregate",
  );
});

test("FG-342: deriveUpstream delivers fanout aggregate with children to downstream depends_on step", async () => {
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  ensureRuntime();

  const { runId } = startRun({
    workflow: WORKFLOW,
    title: "fg342-upstream-test",
    inputs: {},
    projectDir: "/tmp/test-project",
  });

  const claims = ["claim-x", "claim-y"];
  const exec = makeRoutingExec([
    {
      matches: (id) => id.startsWith("task-plan-"),
      result: { status: "complete", claims },
    },
    {
      matches: (id) => id.startsWith("task-research-"),
      result: { status: "complete", findings: ["supporting evidence"] },
    },
    {
      matches: (id) => id.startsWith("task-synthesize-"),
      result: { status: "complete", synthesis: "done" },
    },
  ]);

  await runNext({ runId, workflow: WORKFLOW, dockerExec: exec }); // wave 1: plan
  await runNext({ runId, workflow: WORKFLOW, dockerExec: exec }); // wave 2: research fanout
  await runNext({ runId, workflow: WORKFLOW, dockerExec: exec }); // wave 3: synthesize

  const tasks = tasksForRun(runId);
  const synthTask = tasks.find((t) => t.phase === "synthesize")!;
  assert.ok(synthTask, "synthesize task must exist");
  assert.equal(synthTask.status, "complete");

  // The synthesize task's inputs.upstream must include the research aggregate
  const upstream = (synthTask.taskPackage.inputs as Record<string, unknown>)["upstream"] as Array<{
    phase: string;
    agentRole: string;
    taskId: string;
    result: { status: string; children: Array<{ index: number; status: string; result: unknown }> };
  }>;
  assert.ok(Array.isArray(upstream), "inputs.upstream must be an array");

  const researchEntry = upstream.find((u) => u.phase === "research");
  assert.ok(researchEntry, "upstream must include an entry for the research phase");

  // FG-342: result must NOT be undefined
  assert.ok(
    researchEntry.result !== undefined,
    "FG-342: research upstream result must not be undefined — fanout parent result.json must have been on disk",
  );
  assert.ok(researchEntry.result.children, "research upstream result must have children array");
  assert.equal(researchEntry.result.children.length, 2, "both claim children must appear in upstream");
  assert.ok(
    researchEntry.result.children.every((c) => c.result !== undefined),
    "FG-342: child results must not be undefined when synthesize reads upstream — disk write must carry real findings",
  );
});
