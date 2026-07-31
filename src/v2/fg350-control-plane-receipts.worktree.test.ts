// FG-350 integration test: control-plane receipts record DISPATCH-TIME truth.
//
// The critical property under test: once a manifest is written, mutating the
// host/project config does NOT change the recorded receipt. A receipt is frozen
// at dispatch time — "RECORDED truth, not recomputed from current config."

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cpSync,
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
import { assetRoot } from "./asset-root.js";
import type { Workflow } from "./schema.js";
import { publishFlatAsGeneration } from "./seed-generation.testkit.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Stub dockerExec that writes a minimal result.json and returns 0. */
function makeStubExec(): DockerExecFn {
  return async ({ stdoutPath, stderrPath }) => {
    const dir = dirname(stdoutPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    // tests_run: the implementer primary is held before reds dispatch without it (FG-523).
    writeFileSync(join(dir, "result.json"), JSON.stringify({ status: "complete", tests_run: 4, tests_passed: 4 }));
    writeFileSync(stdoutPath, "{}");
    writeFileSync(stderrPath, "");
    return 0;
  };
}

/** Minimal claude runtime YAML written into FORGE_HOME/runtimes so loadRuntime succeeds. */
function ensureClaudeRuntime(): void {
  const p = join(process.env.FORGE_HOME!, "runtimes", "claude.yml");
  if (!existsSync(p)) {
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
  publishFlatAsGeneration(process.env.FORGE_HOME!);
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
  review_mode: "legacy_verdict",
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

// ---------------------------------------------------------------------------
// FG-350 fix1: red forceCount reflects primary-role force constraints
// ---------------------------------------------------------------------------

const WORKFLOW_WITH_REDS: Workflow = {
  name: "fg350-with-reds",
  description: "FG-350: step with a red for receipt accuracy tests",
  review_mode: "legacy_verdict",
  inputs: [],
  steps: [
    {
      id: "work",
      agent: "engineer",
      gate: "auto",
      manual: false,
      depends_on: [],
      runtime: "claude",
      reds: [{ agent: "red-narrow", authority: "authoritative", gate_on_verdict: true }],
    },
  ],
};

test("FG-350 fix1: red forceCount reflects primary-role force constraints, not red-role constraints", async () => {
  // Isolated FORGE_HOME: write a force constraint scoped to the PRIMARY agent
  // ("engineer") so failureModes.length === 1. Without the fix, the receipt
  // recorded forceCount=0 (filtered under the red's own role "red-narrow").
  const origForgeHome = process.env.FORGE_HOME;
  const isolatedHome = mkdtempSync(join(tmpdir(), "forge-fg350-fix1-"));
  process.env.FORGE_HOME = isolatedHome;
  // FG-654: an isolated $FORGE_HOME stands in for a HOST, so it is provisioned with the
  // agent seeds exactly as install-seeds.sh provisions one. Without them the covered roles
  // this case dispatches are refused at compose for a missing Forge protocol region — a
  // true refusal, but not the subject of this test.
  cpSync(join(assetRoot(), "seeds", "agents"), join(isolatedHome, "agents"), { recursive: true });
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  const projectDir = mkdtempSync(join(tmpdir(), "forge-fg350-fix1-proj-"));
  try {
    const runtimeDir = join(isolatedHome, "runtimes");
    mkdirSync(runtimeDir, { recursive: true });
    writeFileSync(join(runtimeDir, "claude.yml"), `name: claude
description: fix1 test stub
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

    const constraintsDir = join(isolatedHome, "constraints");
    mkdirSync(constraintsDir, { recursive: true });
    writeFileSync(join(constraintsDir, "test-force-engineer.md"), `---
id: test-force-engineer
level: force
roles: [engineer]
antiPrompt: "do not skip tests"
---
Do not skip tests.
`);

    publishFlatAsGeneration(process.env.FORGE_HOME!);

    const { runId } = startRun({
      workflow: WORKFLOW_WITH_REDS,
      title: "fg350 fix1 test",
      inputs: {},
      projectDir,
    });
    await runNext({ runId, workflow: WORKFLOW_WITH_REDS, dockerExec: makeStubExec() });

    const allTasks = tasksForRun(runId);
    const redTasks = allTasks.filter((t) => t.parentId !== undefined);
    assert.ok(redTasks.length > 0, "at least one red task must exist");

    const redManifest = JSON.parse(
      readFileSync(join(taskDir(runId, redTasks[0]!.id), "manifest.json"), "utf8"),
    ) as TaskManifest;
    assert.ok(redManifest.controlPlane !== undefined, "red must have controlPlane receipt");
    assert.equal(
      redManifest.controlPlane!.constraints.forceCount,
      1,
      "red forceCount must equal the primary-role force constraints passed as failureModes (1), not 0",
    );
  } finally {
    process.env.FORGE_HOME = origForgeHome;
    rmSync(isolatedHome, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// FG-350 fix2: sentinel runtime records concrete declared name
// ---------------------------------------------------------------------------

test("FG-350 fix2: sentinel 'claude' runtime records the concrete declared name in the receipt", async () => {
  // Isolated FORGE_HOME with only claude-apikey.yml (no claude.yml) forces sentinel
  // resolution: loadRuntimeWithSource("claude") → resolvedName="claude-apikey".
  // Without the fix, the receipt recorded name:"claude" (the sentinel); after the
  // fix it records the YAML-declared name "claude-apikey".
  const origForgeHome = process.env.FORGE_HOME;
  const isolatedHome = mkdtempSync(join(tmpdir(), "forge-fg350-fix2-"));
  process.env.FORGE_HOME = isolatedHome;
  // FG-654: an isolated $FORGE_HOME stands in for a HOST, so it is provisioned with the
  // agent seeds exactly as install-seeds.sh provisions one. Without them the covered roles
  // this case dispatches are refused at compose for a missing Forge protocol region — a
  // true refusal, but not the subject of this test.
  cpSync(join(assetRoot(), "seeds", "agents"), join(isolatedHome, "agents"), { recursive: true });
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  const projectDir = mkdtempSync(join(tmpdir(), "forge-fg350-fix2-proj-"));
  try {
    // Write ONLY claude-apikey.yml — no claude.yml so sentinel resolution fires.
    const runtimeDir = join(isolatedHome, "runtimes");
    mkdirSync(runtimeDir, { recursive: true });
    writeFileSync(join(runtimeDir, "claude-apikey.yml"), `name: claude-apikey
description: fix2 test stub
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

    publishFlatAsGeneration(process.env.FORGE_HOME!);

    const r = await invoke({
      agentRole: "engineer",
      task: "test sentinel runtime",
      projectDir,
      dockerExec: makeStubExec(),
    });

    assert.equal(r.status, "complete", `invoke must succeed; error: ${r.error ?? "(none)"}`);
    const manifest = JSON.parse(
      readFileSync(join(taskDir(r.runId, r.taskId), "manifest.json"), "utf8"),
    ) as TaskManifest;
    assert.ok(manifest.controlPlane !== undefined, "controlPlane must be present");
    assert.equal(
      manifest.controlPlane!.runtime.name,
      "claude-apikey",
      "sentinel-resolved runtime must record the concrete YAML-declared name 'claude-apikey'",
    );
    assert.notEqual(
      manifest.controlPlane!.runtime.name,
      "claude",
      "the sentinel name 'claude' must NOT be recorded in the receipt",
    );
    // FG-366: the outer execution-metadata runtime.name must agree with
    // controlPlane.runtime.name — no intra-manifest sentinel-vs-resolved split.
    assert.equal(
      manifest.runtime?.name,
      "claude-apikey",
      "outer manifest.runtime.name must record the resolved concrete runtime, matching controlPlane.runtime.name",
    );
  } finally {
    process.env.FORGE_HOME = origForgeHome;
    rmSync(isolatedHome, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// FG-366: sentinel runtime records the concrete name on the runNext/pipeline
// path too (fix2 above only exercised invoke — this closes that gap), and the
// outer manifest.runtime.name (pre-FG-350 execution-metadata block) must match
// controlPlane.runtime.name rather than the requested sentinel.
// ---------------------------------------------------------------------------

test("FG-366: sentinel 'claude' runtime records the concrete declared name on the runNext/pipeline path", async () => {
  // Mirrors FG-350 fix2, but dispatches via startRun+runNext (pipeline path)
  // instead of invoke — the invoke-only coverage gap this ticket closes.
  const origForgeHome = process.env.FORGE_HOME;
  const isolatedHome = mkdtempSync(join(tmpdir(), "forge-fg366-pipe-"));
  process.env.FORGE_HOME = isolatedHome;
  // FG-654: an isolated $FORGE_HOME stands in for a HOST, so it is provisioned with the
  // agent seeds exactly as install-seeds.sh provisions one. Without them the covered roles
  // this case dispatches are refused at compose for a missing Forge protocol region — a
  // true refusal, but not the subject of this test.
  cpSync(join(assetRoot(), "seeds", "agents"), join(isolatedHome, "agents"), { recursive: true });
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  const projectDir = mkdtempSync(join(tmpdir(), "forge-fg366-pipe-proj-"));
  try {
    // Write ONLY claude-apikey.yml — no claude.yml so sentinel resolution fires.
    const runtimeDir = join(isolatedHome, "runtimes");
    mkdirSync(runtimeDir, { recursive: true });
    writeFileSync(join(runtimeDir, "claude-apikey.yml"), `name: claude-apikey
description: fg366 pipeline test stub
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

    publishFlatAsGeneration(process.env.FORGE_HOME!);

    const { runId } = startRun({
      workflow: SINGLE_STEP_WORKFLOW,
      title: "fg366 pipeline sentinel test",
      inputs: {},
      projectDir,
    });
    await runNext({ runId, workflow: SINGLE_STEP_WORKFLOW, dockerExec: makeSimpleExec() });

    const tasks = tasksForRun(runId).filter((t) => t.parentId === undefined);
    assert.equal(tasks.length, 1, "one primary task expected");
    const manifest = JSON.parse(
      readFileSync(join(taskDir(runId, tasks[0]!.id), "manifest.json"), "utf8"),
    ) as TaskManifest;

    assert.ok(manifest.controlPlane !== undefined, "controlPlane must be present");
    assert.equal(
      manifest.controlPlane!.runtime.name,
      "claude-apikey",
      "sentinel-resolved runtime must record the concrete YAML-declared name in controlPlane on the pipeline path too",
    );

    // FG-366: the outer execution-metadata runtime.name must agree with
    // controlPlane.runtime.name — no intra-manifest sentinel-vs-resolved split.
    assert.ok(manifest.runtime !== undefined, "outer runtime block must be present");
    assert.equal(
      manifest.runtime!.name,
      "claude-apikey",
      "outer manifest.runtime.name must record the resolved concrete runtime, matching controlPlane.runtime.name",
    );
    assert.equal(
      manifest.runtime!.name,
      manifest.controlPlane!.runtime.name,
      "outer runtime.name and controlPlane.runtime.name must never disagree",
    );
  } finally {
    process.env.FORGE_HOME = origForgeHome;
    rmSync(isolatedHome, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// FG-350 fix3: invalid docs-surfaces.yml records source built-in + warning
// ---------------------------------------------------------------------------

test("FG-350 fix3: invalid docs-surfaces.yml records source built-in and a warning", async () => {
  ensureClaudeRuntime();
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  const projectDir = mkdtempSync(join(tmpdir(), "forge-fg350-fix3-"));
  try {
    // Write an invalid docs-surfaces.yml (wrong key — schema requires `surfaces:`).
    const forgeDir = join(projectDir, ".forge");
    mkdirSync(forgeDir, { recursive: true });
    writeFileSync(join(forgeDir, "docs-surfaces.yml"), "wrong_key: [something]\n");

    const r = await invoke({
      agentRole: "engineer",
      task: "test docs-surfaces fallback",
      projectDir,
      dockerExec: makeStubExec(),
    });

    assert.equal(r.status, "complete", `invoke must succeed; error: ${r.error ?? "(none)"}`);
    const manifest = JSON.parse(
      readFileSync(join(taskDir(r.runId, r.taskId), "manifest.json"), "utf8"),
    ) as TaskManifest;
    assert.ok(manifest.controlPlane !== undefined, "controlPlane must be present");
    assert.equal(
      manifest.controlPlane!.docsSurfaces.source,
      "built-in",
      "invalid docs-surfaces.yml must fall back to source='built-in'",
    );
    assert.ok(
      Array.isArray(manifest.controlPlane!.warnings) && manifest.controlPlane!.warnings!.length > 0,
      "a warning must be recorded when docs-surfaces.yml is present but invalid",
    );
    assert.ok(
      manifest.controlPlane!.warnings!.some((w) => w.includes("docs-surfaces")),
      "the warning must reference docs-surfaces.yml",
    );
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// FG-350 fix4: red task records ro mountMode, primary records rw
// ---------------------------------------------------------------------------

test("FG-350 fix4: red task manifest records mountMode ro, primary task records rw", async () => {
  ensureClaudeRuntime();
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  const projectDir = mkdtempSync(join(tmpdir(), "forge-fg350-fix4-"));
  try {
    const { runId } = startRun({
      workflow: WORKFLOW_WITH_REDS,
      title: "fg350 fix4 mount test",
      inputs: {},
      projectDir,
    });
    await runNext({ runId, workflow: WORKFLOW_WITH_REDS, dockerExec: makeStubExec() });

    const allTasks = tasksForRun(runId);
    const primaryTask = allTasks.find((t) => t.parentId === undefined);
    const redTasks = allTasks.filter((t) => t.parentId !== undefined);

    assert.ok(primaryTask !== undefined, "primary task must exist");
    assert.ok(redTasks.length > 0, "at least one red task must exist");

    const primaryManifest = JSON.parse(
      readFileSync(join(taskDir(runId, primaryTask!.id), "manifest.json"), "utf8"),
    ) as TaskManifest;
    assert.ok(primaryManifest.controlPlane !== undefined, "primary must have controlPlane receipt");
    assert.equal(
      primaryManifest.controlPlane!.mountMode,
      "rw",
      "primary task must record mountMode='rw'",
    );

    const redManifest = JSON.parse(
      readFileSync(join(taskDir(runId, redTasks[0]!.id), "manifest.json"), "utf8"),
    ) as TaskManifest;
    assert.ok(redManifest.controlPlane !== undefined, "red must have controlPlane receipt");
    assert.equal(
      redManifest.controlPlane!.mountMode,
      "ro",
      "red task must record mountMode='ro' (read-only project mount)",
    );
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// FG-350 fix5: invoke with readOnlyProject:true records mountMode="ro"
// ---------------------------------------------------------------------------

test("FG-350 fix5: invoke with readOnlyProject:true records mountMode='ro' in controlPlane receipt", async () => {
  ensureClaudeRuntime();
  process.env.ANTHROPIC_API_KEY = "sk-stub";

  const projectDir = mkdtempSync(join(tmpdir(), "forge-fg350-fix5-"));
  try {
    const r = await invoke({
      agentRole: "red-wide",
      task: "audit the project read-only",
      projectDir,
      readOnlyProject: true,
      dockerExec: makeStubExec(),
    });

    assert.equal(r.status, "complete", `invoke must succeed; error: ${r.error ?? "(none)"}`);
    const manifest = JSON.parse(
      readFileSync(join(taskDir(r.runId, r.taskId), "manifest.json"), "utf8"),
    ) as TaskManifest;
    assert.ok(manifest.controlPlane !== undefined, "controlPlane must be present");
    assert.equal(
      manifest.controlPlane!.mountMode,
      "ro",
      "invoke with readOnlyProject:true must record mountMode='ro', not hardcoded 'rw'",
    );
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});

test("FG-350 fix5: invoke without readOnlyProject records mountMode='rw' in controlPlane receipt", async () => {
  ensureClaudeRuntime();
  process.env.ANTHROPIC_API_KEY = "sk-stub";

  const projectDir = mkdtempSync(join(tmpdir(), "forge-fg350-fix5b-"));
  try {
    const r = await invoke({
      agentRole: "engineer",
      task: "do rw work",
      projectDir,
      dockerExec: makeStubExec(),
    });

    assert.equal(r.status, "complete", `invoke must succeed; error: ${r.error ?? "(none)"}`);
    const manifest = JSON.parse(
      readFileSync(join(taskDir(r.runId, r.taskId), "manifest.json"), "utf8"),
    ) as TaskManifest;
    assert.ok(manifest.controlPlane !== undefined, "controlPlane must be present");
    assert.equal(
      manifest.controlPlane!.mountMode,
      "rw",
      "invoke without readOnlyProject must record mountMode='rw'",
    );
  } finally {
    rmSync(projectDir, { recursive: true, force: true });
  }
});
