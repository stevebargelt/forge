// FG-519 fanout: the fanout upstream read (dispatchFanoutStep, runNext.ts ~:1411)
// now resolves its source phase via resolvePhasePrimary — the same canonical rule
// as deriveUpstream and the ready queue. The engineer's unit tests cover the
// helper and deriveUpstream directly; this drives the fanout expansion through the
// REAL dispatchFanoutStep (via runNext) over a MIXED source phase.
//
// Shape: frame → research (fanout.from_upstream = frame). The `frame` phase is
// healed to [complete older, failed newer] before the fanout dispatches. The
// fanout must expand from the COMPLETE frame row's array (the failed newer row
// never wrote a result and would expand to zero / crash). Pre-parity, the inline
// filter selected `status === "complete"` — resolvePhasePrimary preserves that
// exactly (COMPLETE_LIKE === {"complete"}); this test pins the parity through the
// live dispatch, not just the helper.

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { runNext, type DockerExecFn } from "./runNext.js";
import { startRun } from "./startRun.js";
import { tasksForRun, getTask, insertTask } from "../store/tasks.js";
import { finalizeOrphanedPrimaries } from "./reconcile.js";
import { taskDir } from "../util/paths.js";
import type { Workflow } from "./schema.js";
import type { Task } from "../types/index.js";
import { publishFlatAsGeneration } from "./seed-generation.testkit.js";

function ensureRuntime(): void {
  const runtimePath = join(process.env.FORGE_HOME!, "runtimes", "claude.yml");
  if (!existsSync(runtimePath)) {
    mkdirSync(dirname(runtimePath), { recursive: true });
    writeFileSync(
      runtimePath,
      `name: claude
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
`,
    );
  }
  publishFlatAsGeneration(process.env.FORGE_HOME!);
}

type PrefixResult = { prefix: string; result: unknown };

function makeRoutingExec(routes: PrefixResult[], invoked: string[]): DockerExecFn {
  return async ({ args, stdoutPath, stderrPath }) => {
    const nameIdx = args.indexOf("--name");
    const fullName = nameIdx >= 0 ? (args[nameIdx + 1] ?? "") : "";
    const taskId = fullName.replace(/^forge-/, "");
    invoked.push(taskId);
    const route = routes.find((r) => taskId.startsWith(r.prefix));
    const dir = dirname(stdoutPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(stdoutPath, "stub stdout");
    writeFileSync(stderrPath, "");
    writeFileSync(join(dir, "result.json"), JSON.stringify(route ? route.result : { status: "complete" }));
    return 0;
  };
}

function mkTask(opts: { id: string; runId: string; phase: string; status: Task["status"]; createdAt: string }): Task {
  return {
    id: opts.id,
    runId: opts.runId,
    phase: opts.phase,
    agentRole: "engineer",
    status: opts.status,
    taskPackage: { taskId: opts.id, runId: opts.runId, phase: opts.phase, role: "engineer", inputs: {}, composedSystemPrompt: "PROMPT" },
    createdAt: opts.createdAt,
  };
}

const FANOUT_WF: Workflow = {
  name: "fg519-fanout",
  description: "FG-519: fanout expands from a healed [complete + failed-newer] source phase",
  inputs: [],
  steps: [
    { id: "frame", agent: "framer", gate: "auto", manual: false, depends_on: [], runtime: "claude", reds: [] },
    {
      id: "research",
      agent: "researcher",
      gate: "auto",
      manual: false,
      depends_on: ["frame"],
      runtime: "claude",
      reds: [],
      fanout: { from_upstream: { step: "frame", array_key: "lanes", input_key: "lane" }, max_concurrency: 4, failure_mode: "continue" },
    },
  ],
};

test("FG-519 fanout E2E: over a healed [complete older, failed newer] source phase, the real dispatchFanoutStep expands from the COMPLETE frame row's array", async () => {
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  ensureRuntime();

  const invoked: string[] = [];
  const exec = makeRoutingExec(
    [
      { prefix: "task-frame-", result: { status: "complete", lanes: ["lane-alpha", "lane-beta", "lane-gamma"] } },
      { prefix: "task-research-0-", result: { status: "complete", finding: "alpha" } },
      { prefix: "task-research-1-", result: { status: "complete", finding: "beta" } },
      { prefix: "task-research-2-", result: { status: "complete", finding: "gamma" } },
    ],
    invoked,
  );

  const { runId } = startRun({
    workflow: FANOUT_WF,
    title: "fg519 fanout mixed phase",
    inputs: {},
    projectDir: "/tmp/test-project",
  });

  // Wave 1: real dispatch → frame completes (real complete primary + result.json,
  // and task.result persisted — dispatchFanoutStep reads task.result).
  const wave1 = await runNext({ runId, workflow: FANOUT_WF, dockerExec: exec });
  assert.deepEqual(wave1.completedSteps, ["frame"], "frame must complete on wave 1");
  const frameComplete = tasksForRun(runId).find((t) => t.phase === "frame" && t.parentId === undefined && t.status === "complete");
  assert.ok(frameComplete, "a complete frame primary must exist");

  // Heal a duplicate-primary into the frame phase → [complete older, failed newer].
  insertTask(mkTask({ id: "task-frame-DUP", runId, phase: "frame", status: "pending", createdAt: "2999-01-01T00:00:00.000Z" }));
  const changes = finalizeOrphanedPrimaries(runId);
  assert.ok(changes.some((c) => c.taskId === "task-frame-DUP" && c.to === "failed"), "real heal must fail the duplicate frame primary");
  assert.equal(getTask("task-frame-DUP")!.status, "failed", "frame phase is now [complete older, failed newer]");

  // Wave 2: real fanout dispatch. Expansion source must be the COMPLETE row's
  // `lanes` array (3 lanes), not the failed newer row (no result → zero children).
  await runNext({ runId, workflow: FANOUT_WF, dockerExec: exec });

  const tasks = tasksForRun(runId);
  const researchParent = tasks.find((t) => t.phase === "research" && t.parentId === undefined);
  assert.ok(researchParent, "research fanout parent must exist");
  const children = tasks.filter((t) => t.phase === "research" && t.parentId === researchParent!.id);
  assert.equal(children.length, 3, "fanout must expand to 3 children — one per lane in the COMPLETE frame row's array");

  // Each child received its lane value keyed by input_key — proves the array came
  // from the complete row, and index-pairing is intact.
  const lanes = children
    .map((c) => (c.taskPackage.inputs as Record<string, unknown>)["lane"])
    .sort();
  assert.deepEqual(lanes, ["lane-alpha", "lane-beta", "lane-gamma"], "children carry the complete frame row's lanes, not the failed row's (absent) array");

  // Parent aggregate landed on disk and the children actually ran.
  const parentResultPath = join(taskDir(runId, researchParent!.id), "result.json");
  assert.ok(existsSync(parentResultPath), "fanout parent aggregate result.json must be on disk");
  const agg = JSON.parse(readFileSync(parentResultPath, "utf8")) as { children: Array<{ result: unknown }> };
  assert.equal(agg.children.length, 3, "aggregate records all 3 children");
  assert.ok(invoked.filter((id) => id.startsWith("task-research-")).length === 3, "3 research child containers dispatched");
});
