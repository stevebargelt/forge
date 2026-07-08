// runNext-spec integration test — verifies FG-270: the ## Spec section in
// renderTaskPackage, fed by buildRedSpec(), which walks workflow steps for
// architecture-advisor and tech-lead roles and composes their results into
// TaskPackage.spec.
//
// Tests:
//   1. renderTaskPackage emits ## Spec with architect intent and tech-lead plan
//      when upstream architecture-advisor and tech-lead tasks are complete.
//   2. renderTaskPackage omits ## Spec entirely on the bare-invoke path (no
//      architecture-advisor / tech-lead steps in the workflow).
//   3. buildRedSpec returns undefined when those upstream tasks are absent —
//      verified by the red taskPackage.spec being absent in the DB.

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { runNext, type DockerExecFn } from "./runNext.js";
import { startRun } from "./startRun.js";
import { tasksForRun } from "../store/tasks.js";
import { taskDir } from "../util/paths.js";
import type { Workflow } from "./schema.js";

// ─── helpers (mirrors runNext.integration.test.ts patterns) ────────────────────────────

function makeRoutingExec(
  rules: Array<{ matches: (taskId: string) => boolean; result: unknown; exitCode?: number }>,
): DockerExecFn {
  return async ({ args, stdoutPath, stderrPath }) => {
    const nameIdx = args.indexOf("--name");
    const fullName = nameIdx >= 0 ? (args[nameIdx + 1] ?? "") : "";
    const taskId = fullName.replace(/^forge-/, "");
    const rule = rules.find((r) => r.matches(taskId));
    const dir = dirname(stdoutPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "result.json"),
      JSON.stringify(rule?.result ?? { status: "complete" }),
    );
    writeFileSync(stdoutPath, "stub stdout");
    writeFileSync(stderrPath, "");
    return rule?.exitCode ?? 0;
  };
}

function ensureRuntime(): void {
  const runtimePath = join(process.env.FORGE_HOME!, "runtimes", "claude.yml");
  if (existsSync(runtimePath)) return;
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

// ─── workflow fixtures ──────────────────────────────────────────────────────

// Three-step workflow: architecture-advisor → tech-lead → engineer (with red).
// After the first two steps complete, buildRedSpec should find both upstream
// outputs and include them in the red's ## Spec section.
const FULL_SPEC_WORKFLOW: Workflow = {
  name: "test-spec-full",
  description: "architect + tech-lead + engineer with authoritative red",
  inputs: [],
  steps: [
    {
      id: "arch",
      agent: "architecture-advisor",
      gate: "auto",
      manual: false,
      depends_on: [],
      runtime: "claude",
      reds: [],
    },
    {
      id: "plan",
      agent: "tech-lead",
      gate: "auto",
      manual: false,
      depends_on: ["arch"],
      runtime: "claude",
      reds: [],
    },
    {
      id: "build",
      agent: "engineer",
      gate: "verdict",
      manual: false,
      depends_on: ["plan"],
      runtime: "claude",
      reds: [{ agent: "red-wide", authority: "authoritative", gate_on_verdict: true }],
    },
  ],
};

// Single-step workflow: engineer with red, no architect or tech-lead.
// This represents a bare `forge invoke` path where buildRedSpec has no
// upstream spec tasks to walk.
const BARE_INVOKE_WORKFLOW: Workflow = {
  name: "test-spec-bare",
  description: "engineer with red, no architect/tech-lead",
  inputs: [],
  steps: [
    {
      id: "build",
      agent: "engineer",
      gate: "verdict",
      manual: false,
      depends_on: [],
      runtime: "claude",
      reds: [{ agent: "red-wide", authority: "authoritative", gate_on_verdict: true }],
    },
  ],
};

// ─── tests ──────────────────────────────────────────────────────────────────

test("FG-270 (1): renderTaskPackage emits ## Spec with architect intent and tech-lead plan when upstream tasks are complete", async () => {
  ensureRuntime();
  process.env.ANTHROPIC_API_KEY = "sk-stub";

  const { runId } = startRun({
    workflow: FULL_SPEC_WORKFLOW,
    title: "spec section — full pipeline",
    inputs: {},
    projectDir: "/tmp/test-project",
  });

  const architectResult = {
    status: "complete",
    risks: ["database schema may change"],
    approach: "event sourcing preferred",
  };
  const techLeadResult = {
    status: "complete",
    plan: "incremental rollout strategy",
    steps: ["migrate schema", "deploy service"],
  };

  const exec = makeRoutingExec([
    {
      // architecture-advisor step → phase "arch"
      matches: (id) => id.startsWith("task-arch-"),
      result: architectResult,
    },
    {
      // tech-lead step → phase "plan"
      matches: (id) => id.startsWith("task-plan-"),
      result: techLeadResult,
    },
    {
      // engineer primary → phase "build" (task-build-*, NOT task-red-build-*)
      matches: (id) => id.startsWith("task-build-"),
      result: { status: "complete", diff_summary: "implemented it", files_modified: [] },
    },
    {
      // red on "build" step → task-red-build-*
      matches: (id) => id.startsWith("task-red-build-"),
      result: { status: "complete", verdict: "pass", confidence: 0.9, findings: [] },
    },
  ]);

  // Wave 1: architecture-advisor
  const w1 = await runNext({ runId, workflow: FULL_SPEC_WORKFLOW, dockerExec: exec });
  assert.deepEqual(w1.dispatchedSteps, ["arch"]);
  assert.deepEqual(w1.completedSteps, ["arch"]);

  // Wave 2: tech-lead
  const w2 = await runNext({ runId, workflow: FULL_SPEC_WORKFLOW, dockerExec: exec });
  assert.deepEqual(w2.dispatchedSteps, ["plan"]);
  assert.deepEqual(w2.completedSteps, ["plan"]);

  // Wave 3: engineer + red (reds dispatch synchronously after the primary)
  const w3 = await runNext({ runId, workflow: FULL_SPEC_WORKFLOW, dockerExec: exec });
  assert.deepEqual(w3.dispatchedSteps, ["build"]);

  // Locate the red task (parentId === primary engineer task's id)
  const tasks = tasksForRun(runId);
  const primary = tasks.find((t) => t.phase === "build" && t.parentId === undefined);
  assert.ok(primary, "engineer primary task must exist");
  const red = tasks.find((t) => t.parentId === primary!.id && t.agentRole === "red-wide");
  assert.ok(red, "red-wide task must exist as child of engineer primary");

  // Read the red's rendered package.md from disk
  const redPkg = readFileSync(join(taskDir(runId, red!.id), "package.md"), "utf8");

  // The ## Spec section must be present
  assert.ok(redPkg.includes("## Spec"), "red package.md must include ## Spec section");

  // Both upstream intent/plan subsections must appear
  assert.ok(
    redPkg.includes("### Architect intent"),
    "## Spec must include ### Architect intent subsection",
  );
  assert.ok(
    redPkg.includes("### Tech-lead plan"),
    "## Spec must include ### Tech-lead plan subsection",
  );

  // The actual content from each upstream result must be rendered
  assert.ok(
    redPkg.includes("event sourcing preferred"),
    "## Spec must render architect result content",
  );
  assert.ok(
    redPkg.includes("incremental rollout strategy"),
    "## Spec must render tech-lead result content",
  );

  // ## Spec must appear before ## Artifact under review (ordering)
  const specIdx = redPkg.indexOf("## Spec");
  const artifactIdx = redPkg.indexOf("## Artifact under review");
  assert.ok(
    specIdx !== -1 && artifactIdx !== -1 && specIdx < artifactIdx,
    "## Spec must precede ## Artifact under review in the rendered package",
  );

  // The red's in-DB taskPackage.spec must also be set (the spec string is stored)
  assert.ok(
    typeof red!.taskPackage.spec === "string" && red!.taskPackage.spec.length > 0,
    "red taskPackage.spec must be a non-empty string in the DB",
  );
});

test("FG-270 (2): renderTaskPackage omits ## Spec entirely on bare-invoke path (no architect/tech-lead steps)", async () => {
  ensureRuntime();
  process.env.ANTHROPIC_API_KEY = "sk-stub";

  const { runId } = startRun({
    workflow: BARE_INVOKE_WORKFLOW,
    title: "spec section — bare invoke",
    inputs: {},
    projectDir: "/tmp/test-project",
  });

  const exec = makeRoutingExec([
    {
      matches: (id) => id.startsWith("task-build-"),
      result: { status: "complete", diff_summary: "done", files_modified: [] },
    },
    {
      matches: (id) => id.startsWith("task-red-build-"),
      result: { status: "complete", verdict: "pass", confidence: 0.9, findings: [] },
    },
  ]);

  // Single wave: engineer + red
  const w1 = await runNext({ runId, workflow: BARE_INVOKE_WORKFLOW, dockerExec: exec });
  assert.deepEqual(w1.dispatchedSteps, ["build"]);

  const tasks = tasksForRun(runId);
  const primary = tasks.find((t) => t.phase === "build" && t.parentId === undefined);
  assert.ok(primary, "engineer primary task must exist");
  const red = tasks.find((t) => t.parentId === primary!.id && t.agentRole === "red-wide");
  assert.ok(red, "red-wide task must exist");

  const redPkg = readFileSync(join(taskDir(runId, red!.id), "package.md"), "utf8");

  // The ## Spec header must be completely absent
  assert.ok(
    !redPkg.includes("## Spec"),
    "red package.md must NOT include ## Spec on bare-invoke path (no architect/tech-lead steps)",
  );

  // Sanity: the artifact section is still present (the rest of the package renders normally)
  assert.ok(
    redPkg.includes("## Artifact under review"),
    "red package.md must still include ## Artifact under review",
  );
});

test("FG-270 (3): buildRedSpec returns undefined when no architect/tech-lead tasks — red taskPackage.spec is absent", async () => {
  ensureRuntime();
  process.env.ANTHROPIC_API_KEY = "sk-stub";

  const { runId } = startRun({
    workflow: BARE_INVOKE_WORKFLOW,
    title: "buildRedSpec undefined — bare invoke",
    inputs: {},
    projectDir: "/tmp/test-project",
  });

  const exec = makeRoutingExec([
    {
      matches: (id) => id.startsWith("task-build-"),
      result: { status: "complete", diff_summary: "done", files_modified: [] },
    },
    {
      matches: (id) => id.startsWith("task-red-build-"),
      result: { status: "complete", verdict: "pass", confidence: 0.9, findings: [] },
    },
  ]);

  await runNext({ runId, workflow: BARE_INVOKE_WORKFLOW, dockerExec: exec });

  const tasks = tasksForRun(runId);
  const primary = tasks.find((t) => t.phase === "build" && t.parentId === undefined);
  assert.ok(primary, "engineer primary task must exist");
  const red = tasks.find((t) => t.parentId === primary!.id && t.agentRole === "red-wide");
  assert.ok(red, "red-wide task must exist");

  // buildRedSpec returns undefined when no architecture-advisor/tech-lead tasks
  // exist → the spec field must not be set on the red's taskPackage.
  assert.equal(
    red!.taskPackage.spec,
    undefined,
    "red taskPackage.spec must be undefined when buildRedSpec finds no architect/tech-lead tasks",
  );
});
