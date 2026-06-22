// FG-350 integration test: control-plane receipts record DISPATCH-TIME truth.
//
// The critical property under test: once a manifest is written, mutating the
// host/project config does NOT change the recorded receipt. A receipt is frozen
// at dispatch time — "RECORDED truth, not recomputed from current config."

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  writeFileSync,
  mkdirSync,
  existsSync,
  readFileSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { invoke } from "./invoke.js";
import { runNext } from "./runNext.js";
import { startRun } from "./startRun.js";
import { tasksForRun } from "../store/tasks.js";
import { taskDir } from "../util/paths.js";
import type { TaskManifest } from "./task-manifest.js";
import type { DockerExecFn } from "./docker-exec.js";
import type { Workflow } from "./schema.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Stub dockerExec that writes a minimal result.json and returns 0. */
function makeStubExec(): DockerExecFn {
  return async ({ stdoutPath, stderrPath }) => {
    const dir = dirname(stdoutPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "result.json"), JSON.stringify({ status: "complete" }));
    writeFileSync(stdoutPath, "{}");
    writeFileSync(stderrPath, "");
    return 0;
  };
}

/** Minimal claude runtime YAML written into FORGE_HOME/runtimes so loadRuntime succeeds. */
function ensureClaudeRuntime(): void {
  const p = join(process.env.FORGE_HOME!, "runtimes", "claude.yml");
  if (existsSync(p)) return;
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(
    p,
    `name: claude
description: fg350 test stub
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
`
  );
}

/** Build a minimal routing-policy.yml YAML string for a single route. */
function routingPolicyYaml(responsible: string): string {
  return `version: 1
governance:
  accountable: human
routes:
  feature-work:
    responsible: ${responsible}
    path: invoke
    consulted: []
    required_followups: []
    informed: []
    force_rules: []
`;
}

// ---------------------------------------------------------------------------
// FG-350: dispatch-time truth — the core property
// ---------------------------------------------------------------------------

test("FG-350 int: controlPlane receipt records dispatch-time routing truth, not current config", async () => {
  ensureClaudeRuntime();
  process.env.ANTHROPIC_API_KEY = "sk-stub";

  const projectDir = mkdtempSync(join(tmpdir(), "forge-fg350-int-"));
  try {
    // Place the routing-policy.yml inside the project's .forge dir so
    // resolvePolicyPath() resolves it as source='project'.
    const forgeDir = join(projectDir, ".forge");
    mkdirSync(forgeDir, { recursive: true });
    const policyPath = join(forgeDir, "routing-policy.yml");
    writeFileSync(policyPath, routingPolicyYaml("original-team"));

    // Dispatch via invoke with the route key. The receipt captures:
    //   controlPlane.routing.responsible = 'original-team'
    //   controlPlane.routing.routeKey    = 'feature-work'
    const r = await invoke({
      agentRole: "engineer",
      task: "ship the feature",
      projectDir,
      routeKey: "feature-work",
      dockerExec: makeStubExec(),
    });

    assert.equal(r.status, "complete", `invoke must succeed; error: ${r.error ?? "(none)"}`);

    // Read the manifest.json written at dispatch time.
    const dir = taskDir(r.runId, r.taskId);
    const manifestPath = join(dir, "manifest.json");
    assert.ok(existsSync(manifestPath), "manifest.json must exist after invoke");

    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as TaskManifest;
    assert.ok(manifest.controlPlane !== undefined, "controlPlane must be present in the manifest");

    const cp = manifest.controlPlane!;
    assert.ok(cp.routing !== undefined, "routing receipt must be present when routeKey was provided");
    assert.equal(cp.routing!.routeKey, "feature-work");
    assert.equal(
      cp.routing!.responsible,
      "original-team",
      "routing.responsible must reflect dispatch-time config"
    );
    assert.equal(cp.routing!.pathType, "invoke");
    assert.deepEqual(cp.routing!.requiredFollowups, []);
    assert.equal(cp.routing!.source, "project", "policy resolved from project dir");

    // Workflow is synthetic (forge invoke builds it in-memory, no YAML file).
    assert.equal(cp.workflow.source, "synthetic");
    assert.equal(cp.workflow.name, "invoke");

    // Runtime was loaded from workspace FORGE_HOME (no project override written).
    assert.equal(cp.runtime.source, "host");

    // Model policy: none written, so it must be absent.
    assert.equal(cp.modelPolicy.source, "absent");

    // -----------------------------------------------------------------------
    // NOW mutate the config: overwrite the policy so responsible='new-team'.
    // This simulates a config change AFTER the run was dispatched.
    // -----------------------------------------------------------------------
    writeFileSync(policyPath, routingPolicyYaml("new-team"));

    // Re-read the SAME manifest.json — nothing should have changed.
    const manifestAfter = JSON.parse(readFileSync(manifestPath, "utf8")) as TaskManifest;
    assert.ok(manifestAfter.controlPlane?.routing !== undefined, "routing receipt must still be present");
    assert.equal(
      manifestAfter.controlPlane!.routing!.responsible,
      "original-team",
      "manifest must still reflect dispatch-time 'original-team' after config is mutated to 'new-team'"
    );
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// FG-350: no routeKey → no routing receipt
// ---------------------------------------------------------------------------

test("FG-350 int: controlPlane receipt omits routing when no routeKey provided", async () => {
  ensureClaudeRuntime();
  process.env.ANTHROPIC_API_KEY = "sk-stub";

  const projectDir = mkdtempSync(join(tmpdir(), "forge-fg350-noroute-"));
  try {
    const r = await invoke({
      agentRole: "engineer",
      task: "just run this",
      projectDir,
      // no routeKey
      dockerExec: makeStubExec(),
    });

    assert.equal(r.status, "complete", `invoke must succeed; error: ${r.error ?? "(none)"}`);

    const dir = taskDir(r.runId, r.taskId);
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as TaskManifest;

    assert.ok(manifest.controlPlane !== undefined, "controlPlane must be present");
    assert.equal(
      manifest.controlPlane!.routing,
      undefined,
      "routing must be absent when no routeKey was provided"
    );
    assert.equal(manifest.controlPlane!.workflow.source, "synthetic");
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// FG-350: pipeline task (runNext) resolves workflow source from filesystem
// when workflowReceipt is absent from run metadata (no false host fallback)
// ---------------------------------------------------------------------------

const SINGLE_STEP_WORKFLOW: Workflow = {
  name: "fg350-pipe",
  description: "FG-350: single-step pipeline for receipt tests",
  inputs: [],
  steps: [
    {
      id: "work",
      agent: "engineer",
      gate: "auto",
      manual: false,
      depends_on: [],
      runtime: "claude",
      reds: [],
    },
  ],
};

const FANOUT_WORKFLOW: Workflow = {
  name: "fg350-fanout",
  description: "FG-350: fanout workflow for child receipt tests",
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
      id: "build",
      agent: "engineer",
      gate: "auto",
      manual: false,
      depends_on: ["plan"],
      runtime: "claude",
      reds: [],
      fanout: {
        from_upstream: { step: "plan", array_key: "items", input_key: "item" },
        max_concurrency: 4,
        failure_mode: "continue",
      },
    },
  ],
};

function makeSimpleExec(result: unknown = { status: "complete" }): DockerExecFn {
  return async ({ stdoutPath, stderrPath }) => {
    const dir = dirname(stdoutPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "result.json"), JSON.stringify(result));
    writeFileSync(stdoutPath, "");
    writeFileSync(stderrPath, "");
    return 0;
  };
}

test("FG-350 int: runNext pipeline resolves workflow source from filesystem when workflowReceipt absent", async () => {
  ensureClaudeRuntime();
  process.env.ANTHROPIC_API_KEY = "sk-stub";

  const projectDir = mkdtempSync(join(tmpdir(), "forge-fg350-pipe-"));
  try {
    // Write the workflow YAML to the PROJECT dir (project override → source='project').
    // startRun is called WITHOUT workflowSource, so workflowReceipt is absent in
    // run metadata. resolveWorkflowSource must probe the filesystem to get the
    // correct source — not fall back to "host" blindly.
    const wfDir = join(projectDir, ".forge", "workflows");
    mkdirSync(wfDir, { recursive: true });
    writeFileSync(join(wfDir, "fg350-pipe.yml"), `name: fg350-pipe
description: FG-350 test
inputs: []
steps:
  - id: work
    agent: engineer
    gate: auto
`);

    const { runId } = startRun({
      workflow: SINGLE_STEP_WORKFLOW,
      title: "fg350 pipe test",
      inputs: {},
      projectDir,
      // No workflowSource — simulates a caller that doesn't record it.
    });

    await runNext({ runId, workflow: SINGLE_STEP_WORKFLOW, dockerExec: makeSimpleExec() });

    const tasks = tasksForRun(runId).filter((t) => t.parentId === undefined);
    assert.equal(tasks.length, 1, "one primary task expected");
    const task = tasks[0]!;
    const manifestPath = join(taskDir(runId, task.id), "manifest.json");
    assert.ok(existsSync(manifestPath), "manifest.json must exist");

    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as TaskManifest;
    assert.ok(manifest.controlPlane !== undefined, "controlPlane must be present");
    assert.equal(
      manifest.controlPlane!.workflow.source,
      "project",
      "workflow source must be 'project' (resolved from filesystem, not falsely 'host')"
    );
    assert.ok(
      manifest.controlPlane!.workflow.path?.includes(projectDir),
      "workflow path must be inside projectDir"
    );
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// FG-350: fanout child tasks receive a controlPlane receipt
// ---------------------------------------------------------------------------

test("FG-350 int: fanout child tasks receive controlPlane receipt in manifest", async () => {
  ensureClaudeRuntime();
  process.env.ANTHROPIC_API_KEY = "sk-stub";

  const projectDir = mkdtempSync(join(tmpdir(), "forge-fg350-fanout-"));
  try {
    const { runId } = startRun({
      workflow: FANOUT_WORKFLOW,
      title: "fg350 fanout test",
      inputs: {},
      projectDir,
    });

    // Wave 1: dispatch the plan step (returns items array for fanout).
    const planExec = makeSimpleExec({ status: "complete", items: ["a", "b"] });
    await runNext({ runId, workflow: FANOUT_WORKFLOW, dockerExec: planExec });

    // Wave 2: dispatch fanout children (one per item).
    const childExec = makeSimpleExec({ status: "complete" });
    await runNext({ runId, workflow: FANOUT_WORKFLOW, dockerExec: childExec });

    // Find a fanout child task (has parentId set).
    const allTasks = tasksForRun(runId);
    const children = allTasks.filter((t) => t.parentId !== undefined);
    assert.ok(children.length >= 2, `expected at least 2 fanout children, got ${children.length}`);

    // Every child must have a controlPlane receipt in its manifest.
    for (const child of children) {
      const dir = taskDir(runId, child.id);
      const manifestPath = join(dir, "manifest.json");
      assert.ok(existsSync(manifestPath), `fanout child ${child.id} must have manifest.json`);
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as TaskManifest;
      assert.ok(
        manifest.controlPlane !== undefined,
        `fanout child ${child.id} must have controlPlane in manifest`
      );
      assert.equal(
        manifest.controlPlane!.workflow.name,
        FANOUT_WORKFLOW.name,
        "fanout child controlPlane must record the workflow name"
      );
    }
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// FG-350: legacy manifests (no controlPlane key) are parseable
// ---------------------------------------------------------------------------

test("FG-350 int: manifest without controlPlane key is parseable (legacy compat)", () => {
  // Write a raw JSON file that mimics a pre-FG-350 manifest — no controlPlane key.
  const dir = mkdtempSync(join(tmpdir(), "forge-fg350-legacy-"));
  try {
    const legacy = {
      taskId: "task-legacy-abc",
      runId: "run-legacy-xyz",
      files: {
        prompt: "CLAUDE.md",
        package: "package.md",
        result: "result.json",
        stdout: "container.stdout.log",
        stderr: "container.stderr.log",
      },
      container: { name: "forge-task-legacy-abc" },
      auth: { profileRequested: false, stateMounted: false },
      // controlPlane deliberately absent
    };
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(legacy, null, 2));

    const parsed = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as TaskManifest;
    assert.equal(parsed.controlPlane, undefined, "legacy manifest must parse with controlPlane === undefined");
    assert.equal(parsed.taskId, "task-legacy-abc");
    assert.equal(parsed.runId, "run-legacy-xyz");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
