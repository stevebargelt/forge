// FG-342 E2E regression: dual-fanout research-synthesis shape.
//
// The exact integration gap that shipped FG-342: dispatchFanoutStep did not
// write the parent aggregate to <runDir>/<parentId>/result.json. When
// deriveUpstream ran for the downstream synthesize step it found no file and
// returned result: undefined for both research-primary and research-skeptic.
// The synthesize step received two upstream entries with result: undefined,
// silently dropping all per-claim children.
//
// These tests exercise the exact workflow shape that exposed the bug:
//   frame → [research-primary, research-skeptic] (parallel fanouts) → synthesize
// with two lanes, each producing distinct per-child findings.
//
// Covers:
//   1. Full E2E: synthesize receives both aggregates with children populated
//   2. Disk shape: {status, children:[{index,status,childTaskId,result}]}
//   3. Index pairing: children[N] carries lane-N findings (distinct per-index)
//   4. Fail-phase: failed child still writes inspectable aggregate to disk

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { runNext, type DockerExecFn } from "./runNext.js";
import { startRun } from "./startRun.js";
import { tasksForRun } from "../store/tasks.js";
import { taskDir } from "../util/paths.js";
import type { Workflow } from "./schema.js";
import { publishFlatAsGeneration } from "./seed-generation.testkit.js";

// ---------------------------------------------------------------------------
// Dual-fanout workflow: mirrors research-synthesis shape
// frame → [research-primary, research-skeptic] → synthesize
// ---------------------------------------------------------------------------

const DUAL_FANOUT_WORKFLOW: Workflow = {
  name: "fg342-e2e-dual-fanout",
  description: "FG-342 E2E: two fanout parents feeding one synthesis step",
  review_mode: "legacy_verdict",
  inputs: [],
  steps: [
    {
      id: "frame",
      agent: "research-framer",
      gate: "auto",
      manual: false,
      depends_on: [],
      runtime: "claude",
      reds: [],
    },
    {
      id: "research-primary",
      agent: "researcher",
      gate: "auto",
      manual: false,
      depends_on: ["frame"],
      runtime: "claude",
      reds: [],
      fanout: {
        from_upstream: { step: "frame", array_key: "lanes", input_key: "lane" },
        max_concurrency: 4,
        failure_mode: "continue",
      },
    },
    {
      id: "research-skeptic",
      agent: "skeptic",
      gate: "auto",
      manual: false,
      depends_on: ["frame"],
      runtime: "claude",
      reds: [],
      fanout: {
        from_upstream: { step: "frame", array_key: "lanes", input_key: "lane" },
        max_concurrency: 4,
        failure_mode: "continue",
      },
    },
    {
      id: "synthesize",
      agent: "synthesizer",
      gate: "auto",
      manual: false,
      depends_on: ["research-primary", "research-skeptic"],
      runtime: "claude",
      reds: [],
    },
  ],
};

// Fail-phase workflow: one fanout step with failure_mode=fail-phase.
// synthesize should never be dispatched; parent result.json must still land.
const FAIL_PHASE_WORKFLOW: Workflow = {
  name: "fg342-e2e-fail-phase",
  description: "FG-342 E2E: fail-phase aggregate still inspectable on disk",
  review_mode: "legacy_verdict",
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

// ---------------------------------------------------------------------------
// Runtime stub (idempotent — shared across tests in the same FORGE_HOME)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Routing exec: maps task-ID prefixes to per-child results.
// Children have IDs: task-{stepId}-{index}-{nanoid}
// e.g. task-research-primary-0-xxxxx, task-research-skeptic-1-xxxxx
// ---------------------------------------------------------------------------

type PrefixResult = { prefix: string; result: unknown; exitCode?: number };

function makeRoutingExec(routes: PrefixResult[]): DockerExecFn {
  return async ({ args, stdoutPath, stderrPath }) => {
    const nameIdx = args.indexOf("--name");
    const fullName = nameIdx >= 0 ? (args[nameIdx + 1] ?? "") : "";
    const taskId = fullName.replace(/^forge-/, "");

    const route = routes.find((r) => taskId.startsWith(r.prefix));
    const dir = dirname(stdoutPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    writeFileSync(stdoutPath, "stub stdout");
    writeFileSync(stderrPath, "");

    if (route && route.exitCode !== undefined && route.exitCode !== 0) {
      // Failing child: leave result.json empty (runContainer pre-writes "")
      // so exitCode !== 0 && !resultRaw triggers the failure path.
      return route.exitCode;
    }

    const result = route ? route.result : { status: "complete" };
    writeFileSync(join(dir, "result.json"), JSON.stringify(result));
    return 0;
  };
}

function dualFanoutExec(): DockerExecFn {
  return makeRoutingExec([
    {
      prefix: "task-frame-",
      result: { status: "complete", lanes: ["lane-alpha", "lane-beta"] },
    },
    {
      prefix: "task-research-primary-0-",
      result: { status: "complete", findings: ["primary: alpha lane evidence"] },
    },
    {
      prefix: "task-research-primary-1-",
      result: { status: "complete", findings: ["primary: beta lane evidence"] },
    },
    {
      prefix: "task-research-skeptic-0-",
      result: { status: "complete", counterFindings: ["skeptic: alpha lane challenge"] },
    },
    {
      prefix: "task-research-skeptic-1-",
      result: { status: "complete", counterFindings: ["skeptic: beta lane challenge"] },
    },
    {
      prefix: "task-synthesize-",
      result: { status: "complete", synthesis: "analysis complete" },
    },
  ]);
}

// ---------------------------------------------------------------------------
// Test 1: synthesize receives both aggregates with children populated
// ---------------------------------------------------------------------------

test("FG-342 E2E: synthesize receives both fanout aggregates — result.children populated for both research-primary and research-skeptic", async () => {
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  ensureRuntime();

  const { runId } = startRun({
    workflow: DUAL_FANOUT_WORKFLOW,
    title: "fg342-e2e-both-aggregates",
    inputs: {},
    projectDir: "/tmp/test-project",
  });

  const exec = dualFanoutExec();
  await runNext({ runId, workflow: DUAL_FANOUT_WORKFLOW, dockerExec: exec }); // wave 1: frame
  await runNext({ runId, workflow: DUAL_FANOUT_WORKFLOW, dockerExec: exec }); // wave 2: research-primary + research-skeptic
  await runNext({ runId, workflow: DUAL_FANOUT_WORKFLOW, dockerExec: exec }); // wave 3: synthesize

  const tasks = tasksForRun(runId);
  const synthTask = tasks.find((t) => t.phase === "synthesize")!;
  assert.ok(synthTask, "synthesize task must exist");
  assert.equal(synthTask.status, "complete", "synthesize must complete — both fanout parents must have written result.json");

  type UpstreamEntry = {
    phase: string;
    agentRole: string;
    taskId: string;
    result: {
      status: string;
      children: Array<{ index: number; status: string; childTaskId: string; result: unknown }>;
    };
  };
  const upstream = (synthTask.taskPackage.inputs as Record<string, unknown>)["upstream"] as UpstreamEntry[];
  assert.ok(Array.isArray(upstream), "inputs.upstream must be an array");
  assert.equal(upstream.length, 2, "synthesize must see exactly 2 upstream entries (one per fanout parent)");

  const primaryEntry = upstream.find((u) => u.phase === "research-primary");
  const skepticEntry = upstream.find((u) => u.phase === "research-skeptic");
  assert.ok(primaryEntry, "upstream must include research-primary entry");
  assert.ok(skepticEntry, "upstream must include research-skeptic entry");

  // FG-342: neither result may be undefined — both fanout parents must have
  // written result.json to disk before synthesize was dispatched.
  assert.notEqual(
    primaryEntry.result,
    undefined,
    "FG-342: research-primary upstream result must not be undefined",
  );
  assert.notEqual(
    skepticEntry.result,
    undefined,
    "FG-342: research-skeptic upstream result must not be undefined",
  );

  assert.ok(primaryEntry.result.children, "research-primary result must have children array");
  assert.ok(skepticEntry.result.children, "research-skeptic result must have children array");
  assert.equal(primaryEntry.result.children.length, 2, "research-primary must have 2 children (one per lane)");
  assert.equal(skepticEntry.result.children.length, 2, "research-skeptic must have 2 children (one per lane)");

  for (const child of primaryEntry.result.children) {
    assert.notEqual(child.result, undefined, `FG-342: research-primary child[${child.index}].result must not be undefined`);
    assert.notEqual(child.result, null, `research-primary child[${child.index}].result must not be null`);
  }
  for (const child of skepticEntry.result.children) {
    assert.notEqual(child.result, undefined, `FG-342: research-skeptic child[${child.index}].result must not be undefined`);
    assert.notEqual(child.result, null, `research-skeptic child[${child.index}].result must not be null`);
  }
});

// ---------------------------------------------------------------------------
// Test 2: aggregate on disk has correct shape for both fanout parents
// ---------------------------------------------------------------------------

test("FG-342 E2E: aggregate on disk has correct shape — {status, children:[{index,status,childTaskId,result}]} for both fanout parents", async () => {
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  ensureRuntime();

  const { runId } = startRun({
    workflow: DUAL_FANOUT_WORKFLOW,
    title: "fg342-e2e-disk-shape",
    inputs: {},
    projectDir: "/tmp/test-project",
  });

  const exec = dualFanoutExec();
  await runNext({ runId, workflow: DUAL_FANOUT_WORKFLOW, dockerExec: exec }); // wave 1: frame
  await runNext({ runId, workflow: DUAL_FANOUT_WORKFLOW, dockerExec: exec }); // wave 2: both fanouts

  const tasks = tasksForRun(runId);

  for (const phase of ["research-primary", "research-skeptic"] as const) {
    const parent = tasks.find((t) => t.phase === phase && t.parentId === undefined)!;
    assert.ok(parent, `${phase} parent task must exist`);
    assert.equal(parent.status, "complete", `${phase} parent must be complete`);

    const resultPath = join(taskDir(runId, parent.id), "result.json");
    assert.ok(
      existsSync(resultPath),
      `FG-342: ${phase} parent result.json must exist on disk at ${resultPath}`,
    );

    const onDisk = JSON.parse(readFileSync(resultPath, "utf8")) as {
      status: string;
      children: Array<{ index: number; status: string; childTaskId: string; result: unknown }>;
    };

    // Top-level shape
    assert.equal(typeof onDisk.status, "string", `${phase} aggregate must have a status string`);
    assert.equal(onDisk.status, "complete", `${phase} aggregate status must be "complete" when all children succeed`);
    assert.ok(Array.isArray(onDisk.children), `${phase} aggregate must have a children array`);
    assert.equal(onDisk.children.length, 2, `${phase} aggregate must have exactly 2 children (one per lane)`);

    // Per-child shape
    for (const child of onDisk.children) {
      assert.equal(typeof child.index, "number", `${phase} child must have numeric index`);
      assert.ok(child.index === 0 || child.index === 1, `${phase} child index must be 0 or 1`);
      assert.equal(typeof child.status, "string", `${phase} child must have status string`);
      assert.equal(child.status, "complete", `${phase} child must have status "complete"`);
      assert.equal(typeof child.childTaskId, "string", `${phase} child must have string childTaskId`);
      assert.ok(child.childTaskId.length > 0, `${phase} child childTaskId must not be empty`);
      assert.notEqual(child.result, undefined, `FG-342: ${phase} child[${child.index}].result must not be undefined`);
      assert.notEqual(child.result, null, `${phase} child[${child.index}].result must not be null`);
    }

    // Index ordering: children are sorted by index (0 first, 1 second)
    const indices = onDisk.children.map((c) => c.index);
    assert.deepEqual([...indices].sort((a, b) => a - b), indices, `${phase} children must be ordered by index`);
  }
});

// ---------------------------------------------------------------------------
// Test 3: children paired by index — distinct per-lane findings
// ---------------------------------------------------------------------------

test("FG-342 E2E: children paired correctly by index — children[0] carries lane-alpha findings, children[1] carries lane-beta findings", async () => {
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  ensureRuntime();

  const { runId } = startRun({
    workflow: DUAL_FANOUT_WORKFLOW,
    title: "fg342-e2e-index-pairing",
    inputs: {},
    projectDir: "/tmp/test-project",
  });

  const exec = dualFanoutExec();
  await runNext({ runId, workflow: DUAL_FANOUT_WORKFLOW, dockerExec: exec }); // wave 1: frame
  await runNext({ runId, workflow: DUAL_FANOUT_WORKFLOW, dockerExec: exec }); // wave 2: both fanouts
  await runNext({ runId, workflow: DUAL_FANOUT_WORKFLOW, dockerExec: exec }); // wave 3: synthesize

  const tasks = tasksForRun(runId);

  // Verify disk content for research-primary
  const primaryParent = tasks.find((t) => t.phase === "research-primary" && t.parentId === undefined)!;
  const primaryOnDisk = JSON.parse(
    readFileSync(join(taskDir(runId, primaryParent.id), "result.json"), "utf8"),
  ) as { status: string; children: Array<{ index: number; result: Record<string, unknown[]> }> };

  const primary0 = primaryOnDisk.children.find((c) => c.index === 0)!;
  const primary1 = primaryOnDisk.children.find((c) => c.index === 1)!;
  assert.ok(primary0, "research-primary must have child at index 0");
  assert.ok(primary1, "research-primary must have child at index 1");
  assert.ok(
    (primary0.result["findings"] as string[] | undefined)?.[0]?.includes("alpha"),
    "research-primary child[0] must carry lane-alpha findings",
  );
  assert.ok(
    (primary1.result["findings"] as string[] | undefined)?.[0]?.includes("beta"),
    "research-primary child[1] must carry lane-beta findings",
  );

  // Verify disk content for research-skeptic
  const skepticParent = tasks.find((t) => t.phase === "research-skeptic" && t.parentId === undefined)!;
  const skepticOnDisk = JSON.parse(
    readFileSync(join(taskDir(runId, skepticParent.id), "result.json"), "utf8"),
  ) as { status: string; children: Array<{ index: number; result: Record<string, unknown[]> }> };

  const skeptic0 = skepticOnDisk.children.find((c) => c.index === 0)!;
  const skeptic1 = skepticOnDisk.children.find((c) => c.index === 1)!;
  assert.ok(skeptic0, "research-skeptic must have child at index 0");
  assert.ok(skeptic1, "research-skeptic must have child at index 1");
  assert.ok(
    (skeptic0.result["counterFindings"] as string[] | undefined)?.[0]?.includes("alpha"),
    "research-skeptic child[0] must carry lane-alpha counter-findings",
  );
  assert.ok(
    (skeptic1.result["counterFindings"] as string[] | undefined)?.[0]?.includes("beta"),
    "research-skeptic child[1] must carry lane-beta counter-findings",
  );

  // Verify the same per-index pairing reaches synthesize's inputs.upstream
  type UpstreamEntry = {
    phase: string;
    result: {
      children: Array<{ index: number; result: Record<string, unknown[]> }>;
    };
  };
  const synthTask = tasks.find((t) => t.phase === "synthesize")!;
  const upstream = (synthTask.taskPackage.inputs as Record<string, unknown>)["upstream"] as UpstreamEntry[];
  const primaryUpstream = upstream.find((u) => u.phase === "research-primary")!;
  const skepticUpstream = upstream.find((u) => u.phase === "research-skeptic")!;

  const synthPrimary0 = primaryUpstream.result.children.find((c) => c.index === 0)!;
  const synthSkeptic1 = skepticUpstream.result.children.find((c) => c.index === 1)!;
  assert.ok(
    (synthPrimary0.result["findings"] as string[] | undefined)?.[0]?.includes("alpha"),
    "synthesize upstream: research-primary child[0] must carry lane-alpha findings",
  );
  assert.ok(
    (synthSkeptic1.result["counterFindings"] as string[] | undefined)?.[0]?.includes("beta"),
    "synthesize upstream: research-skeptic child[1] must carry lane-beta counter-findings",
  );
});

// ---------------------------------------------------------------------------
// Test 4: fail-phase — failed child still writes inspectable aggregate to disk
// ---------------------------------------------------------------------------

test("FG-342 E2E: fail-phase — failed fanout child still writes inspectable aggregate to disk", async () => {
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  ensureRuntime();

  const { runId } = startRun({
    workflow: FAIL_PHASE_WORKFLOW,
    title: "fg342-e2e-fail-phase",
    inputs: {},
    projectDir: "/tmp/test-project",
  });

  // research-1 child fails: exits non-zero, result.json stays empty
  const exec = makeRoutingExec([
    {
      prefix: "task-plan-",
      result: { status: "complete", claims: ["claim-a", "claim-b"] },
    },
    {
      prefix: "task-research-0-",
      result: { status: "complete", findings: ["found it for claim-a"] },
    },
    {
      prefix: "task-research-1-",
      result: null,  // not used — exitCode forces failure
      exitCode: 1,
    },
  ]);

  await runNext({ runId, workflow: FAIL_PHASE_WORKFLOW, dockerExec: exec }); // wave 1: plan
  await runNext({ runId, workflow: FAIL_PHASE_WORKFLOW, dockerExec: exec }); // wave 2: research fanout (one child fails)

  const tasks = tasksForRun(runId);

  // Parent task is marked failed because failure_mode=fail-phase
  const researchParent = tasks.find((t) => t.phase === "research" && t.parentId === undefined)!;
  assert.ok(researchParent, "research parent task must exist");
  assert.equal(researchParent.status, "failed", "research parent must be failed (failure_mode=fail-phase, one child failed)");

  // FG-342 key assertion: result.json MUST still be on disk even though the parent failed.
  // A downstream operator or debug tool needs to inspect which children succeeded/failed.
  const resultPath = join(taskDir(runId, researchParent.id), "result.json");
  assert.ok(
    existsSync(resultPath),
    `FG-342: fail-phase parent result.json must still exist on disk at ${resultPath} — aggregate must be written before failure is recorded`,
  );

  const onDisk = JSON.parse(readFileSync(resultPath, "utf8")) as {
    status: string;
    children: Array<{ index: number; status: string; childTaskId: string; result?: unknown }>;
  };

  // Aggregate status is "partial" (not all children complete)
  assert.equal(
    onDisk.status,
    "partial",
    "fail-phase aggregate status must be 'partial' when at least one child failed",
  );
  assert.ok(Array.isArray(onDisk.children), "fail-phase aggregate must have children array");
  assert.equal(onDisk.children.length, 2, "aggregate must include both children (successful and failed)");

  const succeededChild = onDisk.children.find((c) => c.index === 0);
  const failedChild = onDisk.children.find((c) => c.index === 1);
  assert.ok(succeededChild, "aggregate must include child at index 0");
  assert.ok(failedChild, "aggregate must include child at index 1");

  assert.equal(succeededChild.status, "complete", "child[0] must be complete in the aggregate");
  assert.notEqual(succeededChild.result, undefined, "child[0].result must be present (real finding)");

  assert.equal(failedChild.status, "failed", "child[1] must be marked failed in the aggregate");

  // Synthesize must NOT have been dispatched — fail-phase blocked the run
  const synthTask = tasks.find((t) => t.phase === "synthesize");
  assert.equal(synthTask, undefined, "synthesize must not be dispatched when fanout fails with fail-phase");
});
