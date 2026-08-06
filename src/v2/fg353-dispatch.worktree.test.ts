// FG-353 dispatch-level integration tests.
//
// Exercises the fan-out integration worktree: after all children complete, forge
// merges their branches sequentially (index order, --no-ff) into a dedicated
// integration branch, fan-out reds review the integrated tree, and the
// integration branch is fast-forward merged to HEAD before the parent completes.
//
// Covers:
//   (1) Explicit bind-mount path: FORGE_WORKTREES=0 → fanout completes without
//       any integration branch (byte-for-byte unchanged from pre-FG-353).
//   (1b) Default-on path (FG-345): NO switch set on darwin → the same fan-out
//       isolates — children in private workspaces, the red on the publication
//       candidate, the candidate's commit landing in run.projectDir.
//   (2) Child branches merged into integration branch in child index order.
//   (3) Fan-out red /project mount is the integration worktree, not projectDir.
//   (4) Child merge conflict → merge_conflict on parent, reds never dispatched.
//   (5) Successful gate path: integration branch merges to HEAD.
//   (6) Cleanup: proven-merged worktrees removed; conflict state retained.
//   (7) Re-entry after forced gate advance: no reintegration, no red re-dispatch,
//       integration merges to HEAD.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { tasksForRun } from "../store/tasks.js";
import { startRun } from "./startRun.js";
import { runNext, type DockerExecFn } from "./runNext.js";
import type { Workflow } from "./schema.js";
import { failureKindForTask } from "./failure-kind.js";
import { integrationWorktreeDir, taskDir, CLONES_DIR, PUBLICATIONS_DIR } from "../util/paths.js";
import { allPublicationAttempts } from "../store/publications.js";
import { gate } from "./gate.js";
import { integrationBranchName } from "./worktree-lifecycle.js";
import { publishFlatAsGeneration } from "./seed-generation.testkit.js";

// ─── Workflow fixtures ────────────────────────────────────────────────────────

// Two-step fanout: source (planner) provides an items array; build (engineer)
// fans out over it with max_concurrency: 2 and no reds.
const FANOUT_WORKFLOW: Workflow = {
  name: "fg353-fanout-test",
  description: "FG-353 dispatch-level integration test: fanout, no reds",
  review_mode: "legacy_verdict",
  inputs: [],
  steps: [
    {
      id: "source",
      agent: "planner",
      gate: "auto",
      manual: false,
      depends_on: [],
      runtime: "fg353-dispatch-test",
      reds: [],
    },
    {
      id: "build",
      agent: "engineer",
      gate: "auto",
      manual: false,
      depends_on: ["source"],
      runtime: "fg353-dispatch-test",
      reds: [],
      fanout: {
        from_upstream: { step: "source", array_key: "items", input_key: "item" },
        max_concurrency: 2,
        failure_mode: "continue",
      },
    },
  ],
};

// Same as FANOUT_WORKFLOW but the build step has one authoritative red.
const FANOUT_WITH_RED_WORKFLOW: Workflow = {
  name: "fg353-fanout-red-test",
  description: "FG-353 dispatch-level integration test: fanout with authoritative red",
  review_mode: "legacy_verdict",
  inputs: [],
  steps: [
    {
      id: "source",
      agent: "planner",
      gate: "auto",
      manual: false,
      depends_on: [],
      runtime: "fg353-dispatch-test",
      reds: [],
    },
    {
      id: "build",
      agent: "engineer",
      gate: "auto",
      manual: false,
      depends_on: ["source"],
      runtime: "fg353-dispatch-test",
      reds: [
        { agent: "red-narrow", authority: "authoritative", gate_on_verdict: true },
      ],
      fanout: {
        from_upstream: { step: "source", array_key: "items", input_key: "item" },
        max_concurrency: 2,
        failure_mode: "continue",
      },
    },
  ],
};

// Three-step workflow: source → build (fanout, gate:verdict, authoritative red)
// → downstream (auto gate). Used to assert that forced re-entry on a verdict-gated
// fanout parent completes (not awaiting_gate) and unblocks downstream.
const FANOUT_VERDICT_DOWNSTREAM_WORKFLOW: Workflow = {
  name: "fg353-fanout-verdict-downstream-test",
  description: "FG-353 fanout with gate:verdict and downstream step",
  review_mode: "legacy_verdict",
  inputs: [],
  steps: [
    {
      id: "source",
      agent: "planner",
      gate: "auto",
      manual: false,
      depends_on: [],
      runtime: "fg353-dispatch-test",
      reds: [],
    },
    {
      id: "build",
      agent: "engineer",
      gate: "verdict",
      manual: false,
      depends_on: ["source"],
      runtime: "fg353-dispatch-test",
      reds: [
        { agent: "red-narrow", authority: "authoritative", gate_on_verdict: true },
      ],
      fanout: {
        from_upstream: { step: "source", array_key: "items", input_key: "item" },
        max_concurrency: 2,
        failure_mode: "continue",
      },
    },
    {
      id: "downstream",
      agent: "engineer",
      gate: "auto",
      manual: false,
      depends_on: ["build"],
      runtime: "fg353-dispatch-test",
      reds: [],
    },
  ],
};

// Three-step workflow: source → build (fanout, gate:human, authoritative red)
// → downstream (auto gate). Used to assert that forced re-entry on a human-gated
// fanout parent completes (not awaiting_gate) and unblocks downstream.
// gate:human (like gate:verdict) calls finalizePrimary which returns awaiting_gate;
// the FG-353 fix must bypass finalizePrimary in the gateForced re-entry path
// regardless of gate type.
const FANOUT_HUMAN_DOWNSTREAM_WORKFLOW: Workflow = {
  name: "fg353-fanout-human-downstream-test",
  description: "FG-353 fanout with gate:human and downstream step",
  review_mode: "legacy_verdict",
  inputs: [],
  steps: [
    {
      id: "source",
      agent: "planner",
      gate: "auto",
      manual: false,
      depends_on: [],
      runtime: "fg353-dispatch-test",
      reds: [],
    },
    {
      id: "build",
      agent: "engineer",
      gate: "human",
      manual: false,
      depends_on: ["source"],
      runtime: "fg353-dispatch-test",
      reds: [
        { agent: "red-narrow", authority: "authoritative", gate_on_verdict: true },
      ],
      fanout: {
        from_upstream: { step: "source", array_key: "items", input_key: "item" },
        max_concurrency: 2,
        failure_mode: "continue",
      },
    },
    {
      id: "downstream",
      agent: "engineer",
      gate: "auto",
      manual: false,
      depends_on: ["build"],
      runtime: "fg353-dispatch-test",
      reds: [],
    },
  ],
};

// ─── Shared harness ───────────────────────────────────────────────────────────

let db: DatabaseInstance;
let prev: DatabaseInstance | null;
const tmpDirs: string[] = [];

const ENV_VARS = [
  "FORGE_WORKTREES",
  "FORGE_NO_WORKTREES",
  "FORGE_WORKTREE_IGNORE_DIRTY",
  "FORGE_WORKTREES_EPHEMERAL",
  "ANTHROPIC_API_KEY",
] as const;
const savedEnv: Partial<Record<(typeof ENV_VARS)[number], string>> = {};

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);

  for (const k of ENV_VARS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }

  process.env.ANTHROPIC_API_KEY = "sk-stub";
  // FG-345: isolation is default-ON and the default follows process.platform, so
  // clearing the switch above no longer means "off". Pin it; the cases that want
  // worktree mode set "1" themselves and still win, and case (1b) — the one that
  // proves the DEFAULT on this dispatch path — deletes the pin outright.
  process.env.FORGE_WORKTREES = "0";

  ensureDispatchTestRuntime();
});

afterEach(() => {
  setDbForTest(prev as DatabaseInstance);
  db.close();

  for (const k of ENV_VARS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k] as string;
  }

  setPlatform(process.platform);

  for (const dir of tmpDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch { /* best-effort */ }
  }
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function setPlatform(p: string): void {
  Object.defineProperty(process, "platform", { value: p, configurable: true });
}

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "forge-fg353-disp-"));
  tmpDirs.push(dir);
  return dir;
}

function initGitRepo(dir: string): void {
  execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@forge.test"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Forge Test"], { cwd: dir, stdio: "ignore" });
  writeFileSync(join(dir, "README.md"), "# test\n");
  execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: dir, stdio: "ignore" });
}

// FG-621: a task workspace is a `git clone`, which inherits none of the source
// repo's LOCAL config, so a simulated agent commit must carry its own identity —
// exactly as the agent container supplies one via GIT_AUTHOR_*/GIT_COMMITTER_*.
const AGENT_IDENTITY = ["-c", "user.name=Agent", "-c", "user.email=agent@forge.test"];

function ensureDispatchTestRuntime(): void {
  const forgeHome = process.env.FORGE_HOME!;
  const runtimePath = join(forgeHome, "runtimes", "fg353-dispatch-test.yml");
  mkdirSync(dirname(runtimePath), { recursive: true });
  writeFileSync(
    runtimePath,
    `name: fg353-dispatch-test
description: FG-353 dispatch test runtime stub
image: test-image:latest
models:
  default: test-model
auth:
  mode: apikey
env: {}
mounts:
  - host: "\${TASK_DIR}"
    container: /task
    mode: rw
  - host: "\${PROJECT_DIR}"
    container: /project
    mode: "\${PROJECT_MODE:-rw}"
invocation:
  command: echo
  args: ["stub"]
container:
  name: "forge-\${TASK_ID}"
  remove_on_exit: true
result:
  file: /task/result.json
`,
  );
  publishFlatAsGeneration(process.env.FORGE_HOME!);
}

// Write the FANOUT_WITH_RED_WORKFLOW YAML so gate() can load it by name.
function ensureFanoutRedWorkflowYaml(): void {
  const forgeHome = process.env.FORGE_HOME!;
  const wfPath = join(forgeHome, "workflows", "fg353-fanout-red-test.yml");
  if (!existsSync(wfPath)) {
  mkdirSync(dirname(wfPath), { recursive: true });
  writeFileSync(
    wfPath,
    `name: fg353-fanout-red-test
description: FG-353 fanout with authoritative red
inputs: []
steps:
  - id: source
    agent: planner
    gate: auto
    manual: false
    depends_on: []
    runtime: fg353-dispatch-test
    reds: []
  - id: build
    agent: engineer
    gate: auto
    manual: false
    depends_on: [source]
    runtime: fg353-dispatch-test
    reds:
      - agent: red-narrow
        authority: authoritative
        gate_on_verdict: true
    fanout:
      from_upstream:
        step: source
        array_key: items
        input_key: item
      max_concurrency: 2
      failure_mode: continue
`,
  );
  }
  publishFlatAsGeneration(process.env.FORGE_HOME!);
}

// Write the FANOUT_VERDICT_DOWNSTREAM_WORKFLOW YAML so gate() can load it by name.
function ensureFanoutVerdictDownstreamWorkflowYaml(): void {
  const forgeHome = process.env.FORGE_HOME!;
  const wfPath = join(forgeHome, "workflows", "fg353-fanout-verdict-downstream-test.yml");
  if (!existsSync(wfPath)) {
  mkdirSync(dirname(wfPath), { recursive: true });
  writeFileSync(
    wfPath,
    `name: fg353-fanout-verdict-downstream-test
description: FG-353 fanout with gate:verdict and downstream step
inputs: []
steps:
  - id: source
    agent: planner
    gate: auto
    manual: false
    depends_on: []
    runtime: fg353-dispatch-test
    reds: []
  - id: build
    agent: engineer
    gate: verdict
    manual: false
    depends_on: [source]
    runtime: fg353-dispatch-test
    reds:
      - agent: red-narrow
        authority: authoritative
        gate_on_verdict: true
    fanout:
      from_upstream:
        step: source
        array_key: items
        input_key: item
      max_concurrency: 2
      failure_mode: continue
  - id: downstream
    agent: engineer
    gate: auto
    manual: false
    depends_on: [build]
    runtime: fg353-dispatch-test
    reds: []
`,
  );
  }
  publishFlatAsGeneration(process.env.FORGE_HOME!);
}

// Write the FANOUT_HUMAN_DOWNSTREAM_WORKFLOW YAML so gate() can load it by name.
function ensureFanoutHumanDownstreamWorkflowYaml(): void {
  const forgeHome = process.env.FORGE_HOME!;
  const wfPath = join(forgeHome, "workflows", "fg353-fanout-human-downstream-test.yml");
  if (!existsSync(wfPath)) {
  mkdirSync(dirname(wfPath), { recursive: true });
  writeFileSync(
    wfPath,
    `name: fg353-fanout-human-downstream-test
description: FG-353 fanout with gate:human and downstream step
inputs: []
steps:
  - id: source
    agent: planner
    gate: auto
    manual: false
    depends_on: []
    runtime: fg353-dispatch-test
    reds: []
  - id: build
    agent: engineer
    gate: human
    manual: false
    depends_on: [source]
    runtime: fg353-dispatch-test
    reds:
      - agent: red-narrow
        authority: authoritative
        gate_on_verdict: true
    fanout:
      from_upstream:
        step: source
        array_key: items
        input_key: item
      max_concurrency: 2
      failure_mode: continue
  - id: downstream
    agent: engineer
    gate: auto
    manual: false
    depends_on: [build]
    runtime: fg353-dispatch-test
    reds: []
`,
  );
  }
  publishFlatAsGeneration(process.env.FORGE_HOME!);
}

/** Extract the host-side path from -v <host>:/project:<mode> docker args. */
function findProjectMountHost(dockerArgs: string[]): string | undefined {
  for (let i = 0; i < dockerArgs.length - 1; i++) {
    if (dockerArgs[i] === "-v" && dockerArgs[i + 1]!.includes(":/project:")) {
      return dockerArgs[i + 1]!.split(":")[0];
    }
  }
  return undefined;
}

/** Extract the task ID from the --name forge-<taskId> docker arg. */
function extractTaskId(args: string[]): string {
  const nameIdx = args.indexOf("--name");
  return nameIdx >= 0 ? (args[nameIdx + 1] ?? "").replace(/^forge-/, "") : "";
}

/** Write a successful result.json and logs into the task dir. */
function writeTaskResult(stdoutPath: string, result: unknown): void {
  const dir = dirname(stdoutPath);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "result.json"), JSON.stringify(result));
  writeFileSync(stdoutPath, "stub stdout");
  writeFileSync(join(dir, "container.stderr.log"), "");
}

// ─── (1) Explicit bind-mount path unchanged ──────────────────────────────────
//
// FORGE_WORKTREES=0 → fanout completes without creating an integration branch.
// No git operations, no worktrees — behavior is byte-for-byte unchanged.
//
// This is the EXPLICIT off, not a default: since FG-345 an unset switch resolves
// from process.platform (darwin on), so the pre-FG-353 shape is now reached by
// pinning the switch off. The default an operator actually meets on darwin is
// case (1b) below.

test("fg353 (1): FORGE_WORKTREES=0 => fanout bind-mounts and completes without integration branch", async () => {
  // The suite/beforeEach pin IS the explicit off — assert it rather than assume it.
  assert.equal(
    process.env.FORGE_WORKTREES,
    "0",
    "this case is the explicitly-off arm; an unset switch would resolve from the platform (FG-345)",
  );
  const projectDir = "/tmp/test-project";

  const { runId } = startRun({
    workflow: FANOUT_WORKFLOW,
    title: "fg353 explicit bind-mount test",
    inputs: {},
    projectDir,
  });

  const stubExec: DockerExecFn = async ({ args, stdoutPath, stderrPath }) => {
    const taskId = extractTaskId(args);
    writeFileSync(stderrPath, "");
    if (taskId.startsWith("task-source-")) {
      writeTaskResult(stdoutPath, { status: "complete", tests_run: 1, items: ["item-a", "item-b"] });
    } else {
      writeTaskResult(stdoutPath, { status: "complete", tests_run: 1 });
    }
    return 0;
  };

  // Wave 1: source step.
  const wave1 = await runNext({ runId, workflow: FANOUT_WORKFLOW, dockerExec: stubExec });
  assert.deepEqual(wave1.completedSteps, ["source"], "source must complete in wave 1");

  // Wave 2: fanout build step (children + parent).
  const wave2 = await runNext({ runId, workflow: FANOUT_WORKFLOW, dockerExec: stubExec });
  assert.deepEqual(wave2.completedSteps, ["build"], "build must complete in wave 2");
  assert.deepEqual(wave2.failedSteps, [], "no steps must fail");

  // Confirm no integration branch was created.
  const allTasks = tasksForRun(runId);
  const parentTask = allTasks.find((t) => t.phase === "build" && t.parentId === undefined);
  assert.ok(parentTask, "fanout parent task must exist");
  assert.equal(parentTask!.status, "complete", "parent must be complete");
  // No integration branch should exist in /tmp/test-project (which isn't a git repo,
  // confirming we never attempted any git operations with the switch pinned off).
  assert.equal(
    parentTask!.worktreePath,
    undefined,
    "parent task must have no worktreePath with FORGE_WORKTREES=0",
  );
  const children = allTasks.filter(
    (t) => t.parentId === parentTask!.id && !t.agentRole.startsWith("red-"),
  );
  assert.equal(children.length, 2, "two children must exist");
  for (const child of children) {
    assert.equal(
      child.worktreePath,
      undefined,
      `child ${child.id} must have no worktreePath with FORGE_WORKTREES=0`,
    );
  }
});

// ─── (1b) Default-on fan-out: no switch set on darwin → the ISOLATED path ─────
//
// FG-345 made isolation default-ON on darwin, so the fan-out an operator now gets
// is the isolated one. Every other worktree case in this file ARMS the switch,
// which cannot prove a default — this one DELETES it (undoing both src/test-setup.ts's
// suite pin and beforeEach's) and asserts the independently-dispatched fan-out path
// isolates anyway, all the way through the red and the publication:
//   · each child runs in its own managed workspace, never run.projectDir;
//   · all siblings share ONE wave base (FG-621);
//   · the red reviews the publication candidate, and the commit it reviewed is the
//     commit that lands on the target.

test("fg353 (1b): NO worktree switch set on darwin => fan-out isolates, red reviews the candidate, candidate lands in projectDir", async () => {
  setPlatform("darwin");
  delete process.env.FORGE_WORKTREES;
  assert.equal(process.env.FORGE_WORKTREES, undefined, "the default must be exercised, not configured");
  assert.equal(process.env.FORGE_NO_WORKTREES, undefined, "the default must be exercised, not configured");

  const repo = makeTmpDir();
  initGitRepo(repo);
  const baseSha = execFileSync("git", ["rev-parse", "HEAD^{commit}"], {
    cwd: repo,
    encoding: "utf8",
  }).trim();

  const { runId } = startRun({
    workflow: FANOUT_WITH_RED_WORKFLOW,
    title: "fg353 default-on fanout",
    inputs: {},
    projectDir: repo,
  });

  const capturedMounts: { taskId: string; projectMount: string }[] = [];

  const stubExec: DockerExecFn = async ({ args, stdoutPath, stderrPath }) => {
    const taskId = extractTaskId(args);
    const projectMount = findProjectMountHost(args) ?? "";
    capturedMounts.push({ taskId, projectMount });
    writeFileSync(stderrPath, "");

    if (taskId.startsWith("task-source-")) {
      writeTaskResult(stdoutPath, { status: "complete", tests_run: 1, items: ["item-a", "item-b"] });
    } else if (taskId.startsWith("task-build-0-")) {
      writeFileSync(join(projectMount, "child0.ts"), "export const child0 = 0;\n");
      writeTaskResult(stdoutPath, { status: "complete", tests_run: 1 });
    } else if (taskId.startsWith("task-build-1-")) {
      writeFileSync(join(projectMount, "child1.ts"), "export const child1 = 1;\n");
      writeTaskResult(stdoutPath, { status: "complete", tests_run: 1 });
    } else if (taskId.startsWith("task-red-build-")) {
      writeTaskResult(stdoutPath, { status: "complete", verdict: "pass", confidence: 1.0, findings: [] });
    } else {
      writeTaskResult(stdoutPath, { status: "complete", tests_run: 1 });
    }
    return 0;
  };

  const wave1 = await runNext({ runId, workflow: FANOUT_WITH_RED_WORKFLOW, dockerExec: stubExec });
  assert.deepEqual(wave1.completedSteps, ["source"], "the default path must dispatch the source step");

  const wave2 = await runNext({ runId, workflow: FANOUT_WITH_RED_WORKFLOW, dockerExec: stubExec });
  assert.deepEqual(wave2.completedSteps, ["build"], "the default path must complete the fan-out");
  assert.deepEqual(wave2.failedSteps, [], "the default path must not fail");

  const allTasks = tasksForRun(runId);
  const parentTask = allTasks.find((t) => t.phase === "build" && t.parentId === undefined);
  assert.ok(parentTask, "fanout parent task must exist");
  const parentId = parentTask!.id;

  // Every child got a PRIVATE workspace at the deterministic path, recorded on its
  // row — before FG-345 this same env bind-mounted the operator's checkout.
  const children = allTasks
    .filter((t) => t.parentId === parentId && !t.agentRole.startsWith("red-"))
    .sort((a, b) => a.id.localeCompare(b.id));
  assert.equal(children.length, 2, "two children must exist");
  for (const child of children) {
    assert.ok(
      child.worktreePath,
      `child ${child.id} must have tasks.worktree_path recorded on the default path`,
    );
    assert.equal(
      child.worktreePath,
      join(CLONES_DIR, runId, child.id),
      "the child workspace must be the deterministic per-(run, task) path under the managed clones root",
    );
    assert.equal(child.baseSha, baseSha, "the recorded base SHA must be the repo HEAD the wave was cut from");
    const capture = capturedMounts.find((c) => c.taskId === child.id);
    assert.ok(capture, `child ${child.id} must have been dispatched`);
    assert.equal(capture!.projectMount, child.worktreePath, "/project must be mounted from the child's workspace");
    assert.notEqual(capture!.projectMount, repo, "the operator's checkout must NOT be what a child got");
  }
  // FG-621's invariant, as FG-584 narrowed it in the commit that made the
  // narrowing necessary: ONE BASE PER CONCURRENTLY-DISPATCHED GROUP, not one per
  // wave. An ordered plan item's workspace has to be cut from a candidate that
  // already contains its prerequisite, so a dependent's base necessarily differs
  // from its prerequisite's. This fan-out declares no `depends_on` edges, so it is
  // exactly ONE group and the two rules coincide here — which is why the assertion
  // itself is unchanged. The ordered case is covered by
  // fg584-ordered-fanout.worktree.test.ts.
  assert.equal(
    children[0]!.baseSha,
    children[1]!.baseSha,
    "FG-621 (narrowed by FG-584): one base per concurrently-dispatched group — and an unordered wave is one group",
  );

  // The red reviewed the publication candidate, never the publish target.
  const redCapture = capturedMounts.find((c) => c.taskId.startsWith("task-red-build-"));
  assert.ok(redCapture, "the fan-out red must have been dispatched on the default path");
  assert.notEqual(redCapture!.projectMount, repo, "red /project must NOT be run.projectDir (the publish target)");
  assert.ok(
    redCapture!.projectMount.startsWith(PUBLICATIONS_DIR),
    `red /project must be the publisher's candidate worktree (under ${PUBLICATIONS_DIR}), got ${redCapture!.projectMount}`,
  );

  // …and the commit the red reviewed is the commit the target now carries.
  const attempt = allPublicationAttempts().find((a) => a.taskId === parentId);
  assert.ok(attempt, "a publication attempt must have been recorded on the default path");
  assert.equal(attempt!.state, "published");
  assert.equal(attempt!.publishedSha, attempt!.candidateSha, "publishedSha === candidateSha (AD-6)");
  assert.equal(
    redCapture!.projectMount,
    attempt!.worktreePath,
    "the tree the red reviewed must be the candidate worktree whose commit was published",
  );
  const targetSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
  assert.equal(targetSha, attempt!.candidateSha, "the target must carry exactly the commit the red reviewed");
  assert.notEqual(targetSha, baseSha, "the integrated child work must actually have landed on the target");

  // Both children's work reached run.projectDir through the integration.
  assert.ok(existsSync(join(repo, "child0.ts")), "child0.ts must exist in run.projectDir on the default path");
  assert.ok(existsSync(join(repo, "child1.ts")), "child1.ts must exist in run.projectDir on the default path");
});

// ─── (2) Child branches merged into integration branch in index order ─────────
//
// FORGE_WORKTREES=1 → child 0 writes child0.ts and child 1 writes child1.ts
// (different files, no conflict). Both are merged into the integration branch
// in child index order (0 then 1, --no-ff). Integration merges to HEAD.

test("fg353 (2): child branches merged into integration branch in index order", async () => {
  setPlatform("darwin");
  process.env.FORGE_WORKTREES = "1";
  process.env.FORGE_WORKTREE_IGNORE_DIRTY = "1";
  process.env.FORGE_WORKTREES_EPHEMERAL = "1";

  const repo = makeTmpDir();
  initGitRepo(repo);

  const { runId } = startRun({
    workflow: FANOUT_WORKFLOW,
    title: "fg353 ordered child merge test",
    inputs: {},
    projectDir: repo,
  });

  const stubExec: DockerExecFn = async ({ args, stdoutPath, stderrPath }) => {
    const taskId = extractTaskId(args);
    const projectMount = findProjectMountHost(args);
    writeFileSync(stderrPath, "");

    if (taskId.startsWith("task-source-")) {
      writeTaskResult(stdoutPath, { status: "complete", tests_run: 1, items: ["item-a", "item-b"] });
    } else if (taskId.startsWith("task-build-0-")) {
      // Child 0: write child0.ts (leave uncommitted for auto-commit by mergeChildIntoIntegration).
      assert.ok(projectMount, "child 0 must have /project mount");
      writeFileSync(join(projectMount!, "child0.ts"), "export const child0 = 0;\n");
      writeTaskResult(stdoutPath, { status: "complete", tests_run: 1 });
    } else if (taskId.startsWith("task-build-1-")) {
      // Child 1: write child1.ts.
      assert.ok(projectMount, "child 1 must have /project mount");
      writeFileSync(join(projectMount!, "child1.ts"), "export const child1 = 1;\n");
      writeTaskResult(stdoutPath, { status: "complete", tests_run: 1 });
    } else {
      writeTaskResult(stdoutPath, { status: "complete", tests_run: 1 });
    }
    return 0;
  };

  const wave1 = await runNext({ runId, workflow: FANOUT_WORKFLOW, dockerExec: stubExec });
  assert.deepEqual(wave1.completedSteps, ["source"]);

  const wave2 = await runNext({ runId, workflow: FANOUT_WORKFLOW, dockerExec: stubExec });
  assert.deepEqual(wave2.completedSteps, ["build"], "build must complete");
  assert.deepEqual(wave2.failedSteps, [], "no steps must fail");

  // Both files must be present in run.projectDir (integration merged to HEAD).
  assert.ok(existsSync(join(repo, "child0.ts")), "child0.ts must exist in repo after integration merge");
  assert.ok(existsSync(join(repo, "child1.ts")), "child1.ts must exist in repo after integration merge");

  // Check that child-0 was merged into the integration branch BEFORE child-1.
  // The integration was ff-only merged to HEAD, so HEAD's git log shows the
  // --no-ff merge commits: child-1 (newest/top) then child-0 (older).
  const allTasks = tasksForRun(runId);
  const parentTask = allTasks.find((t) => t.phase === "build" && t.parentId === undefined);
  assert.ok(parentTask, "fanout parent task must exist");

  const children = allTasks
    .filter((t) => t.parentId === parentTask!.id && !t.agentRole.startsWith("red-"))
    .sort((a, b) => {
      const ia = typeof a.taskPackage?.inputs?.["fanoutIndex"] === "number"
        ? (a.taskPackage.inputs["fanoutIndex"] as number) : 0;
      const ib = typeof b.taskPackage?.inputs?.["fanoutIndex"] === "number"
        ? (b.taskPackage.inputs["fanoutIndex"] as number) : 0;
      return ia - ib;
    });
  assert.equal(children.length, 2, "two children must exist");

  const child0Id = children[0]!.id;
  const child1Id = children[1]!.id;

  // git log --first-parent --format=%s: most recent commit first.
  // child-1 was merged second → appears at a lower index (newer).
  // child-0 was merged first → appears at a higher index (older).
  const gitLog = execFileSync("git", ["log", "--first-parent", "--format=%s"], {
    cwd: repo,
    encoding: "utf8",
  }).trim();
  const logLines = gitLog.split("\n").filter(Boolean);

  const child0Idx = logLines.findIndex((l) => l.includes(child0Id));
  const child1Idx = logLines.findIndex((l) => l.includes(child1Id));

  assert.ok(child0Idx >= 0, `child-0 merge commit (${child0Id}) must appear in git log`);
  assert.ok(child1Idx >= 0, `child-1 merge commit (${child1Id}) must appear in git log`);
  assert.ok(
    child0Idx > child1Idx,
    `child-0 merge (index ${child0Idx}) must be older than child-1 merge (index ${child1Idx}) in git log`,
  );
});

// ─── (3) Fan-out red /project mount is the PUBLICATION CANDIDATE ──────────────
//
// CONTRACT NARROWED BY FG-425 (2026-07-13). This test used to pin the red's mount
// to the FG-353 integration worktree specifically. It is now the publisher's
// per-attempt CANDIDATE worktree — which the ticket's acceptance criteria require:
//
//   "Validation (tests / integration gate / reds / review) runs against a candidate
//    commit C built in a dedicated integration worktree — never against the publish
//    target."
//   "The commit published to the target is byte-identical to the commit that was
//    validated (publishedSha === candidateSha)."
//
// The two cannot both be true of the FG-353 integration worktree: it is built on
// whatever base the run started from, whereas the candidate is rebuilt on the base
// actually being published to (and rebuilt AGAIN, with the reds re-run, if that base
// moves — AD-1). Reviewing the integration tree would mean reviewing a tree that
// merely resembles what ships.
//
// The INVARIANT this test exists to protect is unchanged and still asserted: the red
// reviews a merged integration tree, and NEVER run.projectDir (the publish target)
// and never an individual child worktree. It is now additionally asserted that the
// tree the red reviewed is the exact commit that got published.

test("fg353 (3): fan-out red /project mount is the publication candidate — never projectDir, and it is the exact commit published", async () => {
  setPlatform("darwin");
  process.env.FORGE_WORKTREES = "1";
  process.env.FORGE_WORKTREE_IGNORE_DIRTY = "1";
  process.env.FORGE_WORKTREES_EPHEMERAL = "1";

  const repo = makeTmpDir();
  initGitRepo(repo);

  const { runId } = startRun({
    workflow: FANOUT_WITH_RED_WORKFLOW,
    title: "fg353 red project mount test",
    inputs: {},
    projectDir: repo,
  });

  const capturedMounts: { taskId: string; projectMount: string }[] = [];

  const stubExec: DockerExecFn = async ({ args, stdoutPath, stderrPath }) => {
    const taskId = extractTaskId(args);
    const projectMount = findProjectMountHost(args) ?? "";
    capturedMounts.push({ taskId, projectMount });
    writeFileSync(stderrPath, "");

    if (taskId.startsWith("task-source-")) {
      writeTaskResult(stdoutPath, { status: "complete", tests_run: 1, items: ["item-a", "item-b"] });
    } else if (taskId.startsWith("task-build-0-")) {
      if (projectMount) writeFileSync(join(projectMount, "child0.ts"), "export const child0 = 0;\n");
      writeTaskResult(stdoutPath, { status: "complete", tests_run: 1 });
    } else if (taskId.startsWith("task-build-1-")) {
      if (projectMount) writeFileSync(join(projectMount, "child1.ts"), "export const child1 = 1;\n");
      writeTaskResult(stdoutPath, { status: "complete", tests_run: 1 });
    } else if (taskId.startsWith("task-red-build-")) {
      // Red passes — no blocking.
      writeTaskResult(stdoutPath, { status: "complete", verdict: "pass", confidence: 1.0, findings: [] });
    } else {
      writeTaskResult(stdoutPath, { status: "complete", tests_run: 1 });
    }
    return 0;
  };

  const wave1 = await runNext({ runId, workflow: FANOUT_WITH_RED_WORKFLOW, dockerExec: stubExec });
  assert.deepEqual(wave1.completedSteps, ["source"]);

  const wave2 = await runNext({ runId, workflow: FANOUT_WITH_RED_WORKFLOW, dockerExec: stubExec });
  assert.deepEqual(wave2.completedSteps, ["build"], "build must complete after passing red");

  // Find the fanout parent to compute the expected integration path.
  const allTasks = tasksForRun(runId);
  const parentTask = allTasks.find((t) => t.phase === "build" && t.parentId === undefined);
  assert.ok(parentTask, "fanout parent task must exist");
  const parentId = parentTask!.id;

  const expectedIntegrationPath = integrationWorktreeDir(runId, parentId);

  // The red reviewed a PUBLICATION CANDIDATE worktree.
  const redCapture = capturedMounts.find((c) => c.taskId.startsWith("task-red-build-"));
  assert.ok(redCapture, "red task must have been dispatched");
  assert.notEqual(redCapture!.projectMount, repo, "red /project must NOT be run.projectDir (the publish target)");
  assert.ok(
    redCapture!.projectMount.startsWith(PUBLICATIONS_DIR),
    `red /project must be the publisher's candidate worktree (under ${PUBLICATIONS_DIR}), got ${redCapture!.projectMount}`,
  );

  // And it is the EXACT tree that got published: the attempt's candidateSha is what
  // landed on the target, and the worktree the red was mounted on is that attempt's.
  const attempt = allPublicationAttempts().find((a) => a.taskId === parentId);
  assert.ok(attempt, "a publication attempt must have been recorded for the parent");
  assert.equal(attempt!.state, "published");
  assert.equal(attempt!.publishedSha, attempt!.candidateSha, "publishedSha === candidateSha (AD-6)");
  assert.equal(
    redCapture!.projectMount,
    attempt!.worktreePath,
    "the tree the red reviewed must be the candidate worktree whose commit was published",
  );
  const targetSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
  assert.equal(targetSha, attempt!.candidateSha, "the target now carries exactly the commit the red reviewed");

  // Child invocations must NOT use the integration path and must not be the target.
  const childCaptures = capturedMounts.filter(
    (c) => (c.taskId.startsWith("task-build-0-") || c.taskId.startsWith("task-build-1-")),
  );
  assert.equal(childCaptures.length, 2, "exactly two child invocations expected");
  for (const cc of childCaptures) {
    assert.notEqual(
      cc.projectMount,
      expectedIntegrationPath,
      `child invocation ${cc.taskId} /project must NOT be the integration path`,
    );
    assert.notEqual(cc.projectMount, repo, "child /project must not be run.projectDir directly");
  }
});

// ─── (4) Child merge conflict → merge_conflict on parent, reds never dispatched
//
// FORGE_WORKTREES=1. Child 0 and child 1 both write 'shared.ts' with different
// content. After child 0 is merged into the integration branch, merging child 1
// creates a genuine git conflict. The parent task fails with merge_conflict and
// no red tasks are created.

test("fg353 (4): child merge conflict => merge_conflict on parent, reds never dispatched", async () => {
  setPlatform("darwin");
  process.env.FORGE_WORKTREES = "1";
  process.env.FORGE_WORKTREE_IGNORE_DIRTY = "1";
  process.env.FORGE_WORKTREES_EPHEMERAL = "1";

  const repo = makeTmpDir();
  initGitRepo(repo);

  const { runId } = startRun({
    workflow: FANOUT_WORKFLOW,
    title: "fg353 merge conflict test",
    inputs: {},
    projectDir: repo,
  });

  const stubExec: DockerExecFn = async ({ args, stdoutPath, stderrPath }) => {
    const taskId = extractTaskId(args);
    const projectMount = findProjectMountHost(args);
    writeFileSync(stderrPath, "");

    if (taskId.startsWith("task-source-")) {
      writeTaskResult(stdoutPath, { status: "complete", tests_run: 1, items: ["item-a", "item-b"] });
    } else if (taskId.startsWith("task-build-0-")) {
      assert.ok(projectMount, "child 0 must have /project mount");
      // Child 0: write and commit shared.ts with content A.
      writeFileSync(join(projectMount!, "shared.ts"), "export const shared = 'A';\n");
      execFileSync("git", ["add", "."], { cwd: projectMount!, stdio: "ignore" });
      execFileSync("git", [...AGENT_IDENTITY, "commit", "-m", "child0: shared.ts = A"], { cwd: projectMount!, stdio: "ignore" });
      writeTaskResult(stdoutPath, { status: "complete", tests_run: 1 });
    } else if (taskId.startsWith("task-build-1-")) {
      assert.ok(projectMount, "child 1 must have /project mount");
      // Child 1: write and commit shared.ts with content B (conflicts with A).
      writeFileSync(join(projectMount!, "shared.ts"), "export const shared = 'B';\n");
      execFileSync("git", ["add", "."], { cwd: projectMount!, stdio: "ignore" });
      execFileSync("git", [...AGENT_IDENTITY, "commit", "-m", "child1: shared.ts = B"], { cwd: projectMount!, stdio: "ignore" });
      writeTaskResult(stdoutPath, { status: "complete", tests_run: 1 });
    } else {
      writeTaskResult(stdoutPath, { status: "complete", tests_run: 1 });
    }
    return 0;
  };

  const wave1 = await runNext({ runId, workflow: FANOUT_WORKFLOW, dockerExec: stubExec });
  assert.deepEqual(wave1.completedSteps, ["source"]);

  const wave2 = await runNext({ runId, workflow: FANOUT_WORKFLOW, dockerExec: stubExec });
  assert.deepEqual(wave2.failedSteps, ["build"], "build must fail due to merge conflict");
  assert.deepEqual(wave2.completedSteps, [], "no steps must complete");

  // Parent task must be failed with merge_conflict.
  const allTasks = tasksForRun(runId);
  const parentTask = allTasks.find((t) => t.phase === "build" && t.parentId === undefined);
  assert.ok(parentTask, "fanout parent task must exist");
  assert.equal(parentTask!.status, "failed", "parent status must be failed");
  assert.equal(
    failureKindForTask(parentTask!.id),
    "merge_conflict",
    "failure kind must be merge_conflict",
  );

  // No red tasks must exist — the merge conflict aborted before reds were dispatched.
  const redTasks = allTasks.filter(
    (t) => t.parentId === parentTask!.id && t.agentRole.startsWith("red-"),
  );
  assert.equal(redTasks.length, 0, "no red tasks must be created when child merge conflicts");

  // Integration branch must still exist (retained for inspection).
  const intBranch = integrationBranchName(runId, parentTask!.id);
  let intBranchExists = false;
  try {
    execFileSync("git", ["rev-parse", "--verify", intBranch], { cwd: repo, stdio: "ignore" });
    intBranchExists = true;
  } catch { /* branch does not exist */ }
  assert.ok(intBranchExists, "integration branch must be retained after merge conflict");
});

// ─── (5) Successful gate path merges integration branch into run.projectDir HEAD
//
// FORGE_WORKTREES=1, FANOUT_WITH_RED_WORKFLOW. Children complete, integration
// built, red passes. Integration merges to HEAD so child0.ts and child1.ts are
// present in run.projectDir after the wave.

test("fg353 (5): successful gate path merges integration branch into run.projectDir HEAD", async () => {
  setPlatform("darwin");
  process.env.FORGE_WORKTREES = "1";
  process.env.FORGE_WORKTREE_IGNORE_DIRTY = "1";
  process.env.FORGE_WORKTREES_EPHEMERAL = "1";

  const repo = makeTmpDir();
  initGitRepo(repo);

  const { runId } = startRun({
    workflow: FANOUT_WITH_RED_WORKFLOW,
    title: "fg353 successful gate path test",
    inputs: {},
    projectDir: repo,
  });

  const stubExec: DockerExecFn = async ({ args, stdoutPath, stderrPath }) => {
    const taskId = extractTaskId(args);
    const projectMount = findProjectMountHost(args);
    writeFileSync(stderrPath, "");

    if (taskId.startsWith("task-source-")) {
      writeTaskResult(stdoutPath, { status: "complete", tests_run: 1, items: ["item-a", "item-b"] });
    } else if (taskId.startsWith("task-build-0-")) {
      if (projectMount) writeFileSync(join(projectMount, "child0.ts"), "export const child0 = 0;\n");
      writeTaskResult(stdoutPath, { status: "complete", tests_run: 1 });
    } else if (taskId.startsWith("task-build-1-")) {
      if (projectMount) writeFileSync(join(projectMount, "child1.ts"), "export const child1 = 1;\n");
      writeTaskResult(stdoutPath, { status: "complete", tests_run: 1 });
    } else if (taskId.startsWith("task-red-build-")) {
      writeTaskResult(stdoutPath, { status: "complete", verdict: "pass", confidence: 1.0, findings: [] });
    } else {
      writeTaskResult(stdoutPath, { status: "complete", tests_run: 1 });
    }
    return 0;
  };

  const wave1 = await runNext({ runId, workflow: FANOUT_WITH_RED_WORKFLOW, dockerExec: stubExec });
  assert.deepEqual(wave1.completedSteps, ["source"]);

  const wave2 = await runNext({ runId, workflow: FANOUT_WITH_RED_WORKFLOW, dockerExec: stubExec });
  assert.deepEqual(wave2.completedSteps, ["build"], "build must complete after red passes");
  assert.deepEqual(wave2.failedSteps, [], "no steps must fail");

  // Both child files must be in run.projectDir (integration merged to HEAD).
  assert.ok(
    existsSync(join(repo, "child0.ts")),
    "child0.ts must exist in run.projectDir after integration→HEAD merge",
  );
  assert.ok(
    existsSync(join(repo, "child1.ts")),
    "child1.ts must exist in run.projectDir after integration→HEAD merge",
  );

  const allTasks = tasksForRun(runId);
  const parentTask = allTasks.find((t) => t.phase === "build" && t.parentId === undefined);
  assert.equal(parentTask!.status, "complete", "parent must be complete");
});

// ─── (6) Cleanup: proven-merged worktrees removed; conflict state retained ────
//
// Two sub-scenarios in sequence (fresh runs, no interference):
//   A. No-conflict run: child and integration worktrees are removed after
//      integration merges to HEAD (provenMerged cleanup).
//   B. Conflict run: integration worktree and ALL child worktrees are retained
//      because removeWorktreeIfSafe is never called on the failure path.

test("fg353 (6): cleanup removes proven-merged child/integration worktrees; conflict state retained", async () => {
  setPlatform("darwin");
  process.env.FORGE_WORKTREES = "1";
  process.env.FORGE_WORKTREE_IGNORE_DIRTY = "1";
  process.env.FORGE_WORKTREES_EPHEMERAL = "1";

  // ── Sub-scenario A: successful run ─────────────────────────────────────────

  const repoA = makeTmpDir();
  initGitRepo(repoA);

  const { runId: runIdA } = startRun({
    workflow: FANOUT_WORKFLOW,
    title: "fg353 cleanup test - success",
    inputs: {},
    projectDir: repoA,
  });

  const stubA: DockerExecFn = async ({ args, stdoutPath, stderrPath }) => {
    const taskId = extractTaskId(args);
    const projectMount = findProjectMountHost(args);
    writeFileSync(stderrPath, "");
    if (taskId.startsWith("task-source-")) {
      writeTaskResult(stdoutPath, { status: "complete", tests_run: 1, items: ["item-a", "item-b"] });
    } else if (taskId.startsWith("task-build-0-")) {
      if (projectMount) writeFileSync(join(projectMount, "child0.ts"), "export const x = 0;\n");
      writeTaskResult(stdoutPath, { status: "complete", tests_run: 1 });
    } else if (taskId.startsWith("task-build-1-")) {
      if (projectMount) writeFileSync(join(projectMount, "child1.ts"), "export const y = 1;\n");
      writeTaskResult(stdoutPath, { status: "complete", tests_run: 1 });
    } else {
      writeTaskResult(stdoutPath, { status: "complete", tests_run: 1 });
    }
    return 0;
  };

  await runNext({ runId: runIdA, workflow: FANOUT_WORKFLOW, dockerExec: stubA });
  const wave2A = await runNext({ runId: runIdA, workflow: FANOUT_WORKFLOW, dockerExec: stubA });
  assert.deepEqual(wave2A.completedSteps, ["build"], "sub-scenario A: build must complete");

  // Child and integration worktrees must be removed (provenMerged cleanup).
  const tasksA = tasksForRun(runIdA);
  const parentA = tasksA.find((t) => t.phase === "build" && t.parentId === undefined)!;
  const childrenA = tasksA.filter((t) => t.parentId === parentA.id && !t.agentRole.startsWith("red-"));
  for (const child of childrenA) {
    assert.ok(child.worktreePath, `child ${child.id} must have worktreePath set`);
    assert.equal(
      existsSync(child.worktreePath!),
      false,
      `child ${child.id} worktree directory must be removed after proven-merged cleanup`,
    );
  }
  const integPathA = integrationWorktreeDir(runIdA, parentA.id);
  assert.equal(
    existsSync(integPathA),
    false,
    "integration worktree must be removed after proven-merged cleanup",
  );

  // ── Sub-scenario B: conflict run ───────────────────────────────────────────

  const repoB = makeTmpDir();
  initGitRepo(repoB);

  const { runId: runIdB } = startRun({
    workflow: FANOUT_WORKFLOW,
    title: "fg353 cleanup test - conflict",
    inputs: {},
    projectDir: repoB,
  });

  const stubB: DockerExecFn = async ({ args, stdoutPath, stderrPath }) => {
    const taskId = extractTaskId(args);
    const projectMount = findProjectMountHost(args);
    writeFileSync(stderrPath, "");
    if (taskId.startsWith("task-source-")) {
      writeTaskResult(stdoutPath, { status: "complete", tests_run: 1, items: ["item-a", "item-b"] });
    } else if (taskId.startsWith("task-build-0-")) {
      assert.ok(projectMount, "child 0 must have /project mount");
      writeFileSync(join(projectMount!, "shared.ts"), "export const shared = 'A';\n");
      execFileSync("git", ["add", "."], { cwd: projectMount!, stdio: "ignore" });
      execFileSync("git", [...AGENT_IDENTITY, "commit", "-m", "child0: conflict"], { cwd: projectMount!, stdio: "ignore" });
      writeTaskResult(stdoutPath, { status: "complete", tests_run: 1 });
    } else if (taskId.startsWith("task-build-1-")) {
      assert.ok(projectMount, "child 1 must have /project mount");
      writeFileSync(join(projectMount!, "shared.ts"), "export const shared = 'B';\n");
      execFileSync("git", ["add", "."], { cwd: projectMount!, stdio: "ignore" });
      execFileSync("git", [...AGENT_IDENTITY, "commit", "-m", "child1: conflict"], { cwd: projectMount!, stdio: "ignore" });
      writeTaskResult(stdoutPath, { status: "complete", tests_run: 1 });
    } else {
      writeTaskResult(stdoutPath, { status: "complete", tests_run: 1 });
    }
    return 0;
  };

  await runNext({ runId: runIdB, workflow: FANOUT_WORKFLOW, dockerExec: stubB });
  const wave2B = await runNext({ runId: runIdB, workflow: FANOUT_WORKFLOW, dockerExec: stubB });
  assert.deepEqual(wave2B.failedSteps, ["build"], "sub-scenario B: build must fail with conflict");

  // Integration worktree must be retained for inspection.
  const tasksB = tasksForRun(runIdB);
  const parentB = tasksB.find((t) => t.phase === "build" && t.parentId === undefined)!;
  const integPathB = integrationWorktreeDir(runIdB, parentB.id);
  assert.ok(
    existsSync(integPathB),
    "integration worktree directory must be retained after merge conflict",
  );

  // Child worktrees must also be retained (removeWorktreeIfSafe is never called on failure).
  const childrenB = tasksB.filter((t) => t.parentId === parentB.id && !t.agentRole.startsWith("red-"));
  for (const child of childrenB) {
    if (child.worktreePath) {
      assert.ok(
        existsSync(child.worktreePath),
        `child ${child.id} worktree must be retained after merge conflict`,
      );
    }
  }
});

// ─── (7) Re-entry after forced gate advance ───────────────────────────────────
//
// FORGE_WORKTREES=1, FANOUT_WITH_RED_WORKFLOW.
// (a) Wave 1+2: children complete, integration built, red returns authoritative
//     fail → parent blocked_by_red. Integration branch and child worktrees retained.
// (b) gate(parentId, 'advance', ..., { force: true }) → parent becomes pending
//     with gateForced=true in inputs.
// (c) Wave 3 (re-entry): dispatchFanoutStep detects gateForced, skips child
//     dispatch and red dispatch, merges integration to HEAD, cleans up.
//     No new children or reds are created. Parent completes.

test("fg353 (7): re-entry after forced gate advance — no reintegration, no red re-dispatch, integration merges to HEAD", async () => {
  setPlatform("darwin");
  process.env.FORGE_WORKTREES = "1";
  process.env.FORGE_WORKTREE_IGNORE_DIRTY = "1";
  process.env.FORGE_WORKTREES_EPHEMERAL = "1";

  const repo = makeTmpDir();
  initGitRepo(repo);
  ensureFanoutRedWorkflowYaml();

  const { runId } = startRun({
    workflow: FANOUT_WITH_RED_WORKFLOW,
    title: "fg353 re-entry test",
    inputs: {},
    projectDir: repo,
  });

  // The fail verdict includes a finding that survives validateVerdict and gradeFindings
  // so it triggers authoritativeFail = true on the fanout parent.
  const FAIL_VERDICT = {
    status: "complete", tests_run: 1,
    verdict: "fail",
    confidence: 0.9,
    findings: [
      {
        severity: "high",
        summary: "fg353 test finding",
        evidence: "test evidence",
        hypothesis: "test hypothesis",
      },
    ],
  };

  let wave3ExecCount = 0;

  const stubExec: DockerExecFn = async ({ args, stdoutPath, stderrPath }) => {
    const taskId = extractTaskId(args);
    const projectMount = findProjectMountHost(args);
    writeFileSync(stderrPath, "");

    if (taskId.startsWith("task-source-")) {
      writeTaskResult(stdoutPath, { status: "complete", tests_run: 1, items: ["item-a", "item-b"] });
    } else if (taskId.startsWith("task-build-0-")) {
      if (projectMount) writeFileSync(join(projectMount, "child0.ts"), "export const child0 = 0;\n");
      writeTaskResult(stdoutPath, { status: "complete", tests_run: 1 });
    } else if (taskId.startsWith("task-build-1-")) {
      if (projectMount) writeFileSync(join(projectMount, "child1.ts"), "export const child1 = 1;\n");
      writeTaskResult(stdoutPath, { status: "complete", tests_run: 1 });
    } else if (taskId.startsWith("task-red-build-")) {
      // Red returns authoritative fail → parent will be blocked_by_red.
      writeTaskResult(stdoutPath, FAIL_VERDICT);
    } else {
      wave3ExecCount++;
      writeTaskResult(stdoutPath, { status: "complete", tests_run: 1 });
    }
    return 0;
  };

  // ── Wave 1: source step ────────────────────────────────────────────────────
  const wave1 = await runNext({ runId, workflow: FANOUT_WITH_RED_WORKFLOW, dockerExec: stubExec });
  assert.deepEqual(wave1.completedSteps, ["source"]);

  // ── Wave 2: fanout (children + integration + red fails) ───────────────────
  const wave2 = await runNext({ runId, workflow: FANOUT_WITH_RED_WORKFLOW, dockerExec: stubExec });
  assert.ok(
    wave2.awaitingGate.includes("build") || wave2.failedSteps.includes("build"),
    "build must be blocked or awaiting gate after authoritative fail",
  );

  // Record counts after wave 2.
  const tasksAfterWave2 = tasksForRun(runId);
  const parentTask = tasksAfterWave2.find((t) => t.phase === "build" && t.parentId === undefined);
  assert.ok(parentTask, "fanout parent task must exist");
  const parentId = parentTask!.id;
  assert.equal(parentTask!.status, "blocked_by_red", "parent must be blocked_by_red after authoritative fail");

  const initialChildCount = tasksAfterWave2.filter(
    (t) => t.parentId === parentId && !t.agentRole.startsWith("red-"),
  ).length;
  const initialRedCount = tasksAfterWave2.filter(
    (t) => t.parentId === parentId && t.agentRole.startsWith("red-"),
  ).length;
  assert.equal(initialChildCount, 2, "two children after wave 2");
  assert.equal(initialRedCount, 1, "one red after wave 2");

  // Integration branch and child worktrees must be retained (not merged/cleaned yet).
  const integPath = integrationWorktreeDir(runId, parentId);
  assert.ok(existsSync(integPath), "integration worktree must be retained when parent is blocked_by_red");

  // ── Force-advance via gate ────────────────────────────────────────────────
  await gate(parentId, "advance", "forced: fg353 test", { force: true });

  const tasksAfterGate = tasksForRun(runId);
  const parentAfterGate = tasksAfterGate.find((t) => t.id === parentId);
  assert.ok(parentAfterGate, "parent must still exist after gate");
  assert.equal(parentAfterGate!.status, "pending", "parent must be pending after gate force-advance");
  assert.strictEqual(
    parentAfterGate!.taskPackage?.inputs?.["gateForced"],
    true,
    "gateForced flag must be set on parent inputs",
  );

  // ── Wave 3: re-entry — no new containers, integration merges to HEAD ───────
  const wave3ExecsBefore = wave3ExecCount;
  const wave3 = await runNext({ runId, workflow: FANOUT_WITH_RED_WORKFLOW, dockerExec: stubExec });
  assert.deepEqual(wave3.completedSteps, ["build"], "build must complete in wave 3 via re-entry");
  assert.deepEqual(wave3.failedSteps, [], "no steps must fail in wave 3");

  // No new containers must have been dispatched in wave 3.
  assert.equal(
    wave3ExecCount,
    wave3ExecsBefore,
    "no new docker execs must be triggered in wave 3 re-entry",
  );

  const tasksAfterWave3 = tasksForRun(runId);
  const parentAfterWave3 = tasksAfterWave3.find((t) => t.id === parentId);
  assert.equal(parentAfterWave3!.status, "complete", "parent must be complete after wave 3");

  // No new children or reds must have been created.
  const finalChildCount = tasksAfterWave3.filter(
    (t) => t.parentId === parentId && !t.agentRole.startsWith("red-"),
  ).length;
  const finalRedCount = tasksAfterWave3.filter(
    (t) => t.parentId === parentId && t.agentRole.startsWith("red-"),
  ).length;
  assert.equal(finalChildCount, initialChildCount, "no new children must be dispatched in wave 3");
  assert.equal(finalRedCount, initialRedCount, "no new reds must be dispatched in wave 3");

  // Both child files must be in run.projectDir (integration merged to HEAD in re-entry).
  assert.ok(
    existsSync(join(repo, "child0.ts")),
    "child0.ts must be in run.projectDir after re-entry integration merge",
  );
  assert.ok(
    existsSync(join(repo, "child1.ts")),
    "child1.ts must be in run.projectDir after re-entry integration merge",
  );

  // Integration worktree must be removed (provenMerged cleanup in re-entry path).
  assert.equal(
    existsSync(integPath),
    false,
    "integration worktree must be removed after re-entry proven-merge cleanup",
  );

  // Child worktrees must be removed (provenMerged cleanup in re-entry path).
  const childrenAfterWave3 = tasksAfterWave3.filter(
    (t) => t.parentId === parentId && !t.agentRole.startsWith("red-"),
  );
  for (const child of childrenAfterWave3) {
    if (child.worktreePath) {
      assert.equal(
        existsSync(child.worktreePath),
        false,
        `child ${child.id} worktree must be removed after re-entry proven-merge cleanup`,
      );
    }
  }
});

// ─── (8) Integration setup throw => parent FAILED, not wedged ─────────────────
//
// FORGE_WORKTREES=1. After children complete successfully, the integration
// worktree creation fails because a blocking FILE (not a directory) has been
// pre-created at the integration worktree path. git worktree add genuinely fails
// with a real error. The try/catch in dispatchFanoutStep must transition the
// parent to FAILED (not leave it running/wedged). No reds must be dispatched.

test("fg353 (8): integration worktree create throws => parent FAILED, not wedged", async () => {
  setPlatform("darwin");
  process.env.FORGE_WORKTREES = "1";
  process.env.FORGE_WORKTREE_IGNORE_DIRTY = "1";
  process.env.FORGE_WORKTREES_EPHEMERAL = "1";

  const repo = makeTmpDir();
  initGitRepo(repo);

  const { runId } = startRun({
    workflow: FANOUT_WORKFLOW,
    title: "fg353 integration throw test",
    inputs: {},
    projectDir: repo,
  });

  let childrenRan = false;

  const stubExec: DockerExecFn = async ({ args, stdoutPath, stderrPath }) => {
    const taskId = extractTaskId(args);
    const projectMount = findProjectMountHost(args);
    writeFileSync(stderrPath, "");

    if (taskId.startsWith("task-source-")) {
      writeTaskResult(stdoutPath, { status: "complete", tests_run: 1, items: ["item-a", "item-b"] });
    } else if (taskId.startsWith("task-build-0-") || taskId.startsWith("task-build-1-")) {
      if (projectMount) {
        const filename = taskId.startsWith("task-build-0-") ? "child0.ts" : "child1.ts";
        writeFileSync(join(projectMount, filename), "export const x = 1;\n");
      }
      // Pre-create a blocking FILE (not a directory) at the integration worktree
      // path so git worktree add genuinely fails. The fanout parent is already in
      // the DB by the time children run (inserted before batch dispatch).
      if (!childrenRan) {
        const parentTask = tasksForRun(runId).find(
          (t) => t.phase === "build" && t.parentId === undefined,
        );
        if (parentTask) {
          const integPath = integrationWorktreeDir(runId, parentTask.id);
          mkdirSync(dirname(integPath), { recursive: true });
          writeFileSync(integPath, "blocking-file: not a directory");
        }
        childrenRan = true;
      }
      writeTaskResult(stdoutPath, { status: "complete", tests_run: 1 });
    } else {
      writeTaskResult(stdoutPath, { status: "complete", tests_run: 1 });
    }
    return 0;
  };

  const wave1 = await runNext({ runId, workflow: FANOUT_WORKFLOW, dockerExec: stubExec });
  assert.deepEqual(wave1.completedSteps, ["source"]);

  const wave2 = await runNext({ runId, workflow: FANOUT_WORKFLOW, dockerExec: stubExec });

  // Verify children ran (and the blocking file was created) during wave 2.
  assert.ok(childrenRan, "child stubs must have run during wave 2");

  // Build must fail due to real git failure — NOT wedged as running.
  assert.deepEqual(wave2.failedSteps, ["build"], "build must fail when integration worktree create throws");
  assert.deepEqual(wave2.completedSteps, [], "no steps must complete");

  const allTasks = tasksForRun(runId);
  const parentTask = allTasks.find((t) => t.phase === "build" && t.parentId === undefined);
  assert.ok(parentTask, "fanout parent must exist");
  assert.equal(parentTask!.status, "failed", "parent must be 'failed', not 'running' (wedged)");
  assert.equal(
    failureKindForTask(parentTask!.id),
    "merge_conflict",
    "failure kind must be merge_conflict for integration setup throw",
  );

  // No reds must be dispatched — integration aborted before reds.
  const redTasks = allTasks.filter(
    (t) => t.parentId === parentTask!.id && t.agentRole.startsWith("red-"),
  );
  assert.equal(redTasks.length, 0, "no red tasks must be created when integration setup throws");
});

// ─── (10) Failed child's worktree retained on partial success (no-discard) ────
//
// FORGE_WORKTREES=1, FANOUT_WORKFLOW (no reds, failure_mode: continue).
// 3 children: child 0 succeeds, child 1 FAILS, child 2 succeeds.
// After integration merges children 0+2 to HEAD:
//   - Proven-merged children (0, 2) worktrees REMOVED.
//   - Failed child (1) worktree RETAINED — never integrated, no-discard applies.

test("fg353 (10): failed child worktree retained on partial success — no-discard regression", async () => {
  setPlatform("darwin");
  process.env.FORGE_WORKTREES = "1";
  process.env.FORGE_WORKTREE_IGNORE_DIRTY = "1";
  process.env.FORGE_WORKTREES_EPHEMERAL = "1";

  const repo = makeTmpDir();
  initGitRepo(repo);

  const { runId } = startRun({
    workflow: FANOUT_WORKFLOW,
    title: "fg353 no-discard partial success test",
    inputs: {},
    projectDir: repo,
  });

  const stubExec: DockerExecFn = async ({ args, stdoutPath, stderrPath }) => {
    const taskId = extractTaskId(args);
    const projectMount = findProjectMountHost(args);
    writeFileSync(stderrPath, "");

    if (taskId.startsWith("task-source-")) {
      // Return 3 items so we get 3 fanout children.
      writeTaskResult(stdoutPath, { status: "complete", tests_run: 1, items: ["item-a", "item-b", "item-c"] });
    } else if (taskId.startsWith("task-build-0-")) {
      if (projectMount) writeFileSync(join(projectMount, "child0.ts"), "export const child0 = 0;\n");
      writeTaskResult(stdoutPath, { status: "complete", tests_run: 1 });
    } else if (taskId.startsWith("task-build-1-")) {
      // Child 1 fails — non-zero exit code, no result.json written.
      // Its worktree must be RETAINED after the parent completes.
      return 1;
    } else if (taskId.startsWith("task-build-2-")) {
      if (projectMount) writeFileSync(join(projectMount, "child2.ts"), "export const child2 = 2;\n");
      writeTaskResult(stdoutPath, { status: "complete", tests_run: 1 });
    } else {
      writeTaskResult(stdoutPath, { status: "complete", tests_run: 1 });
    }
    return 0;
  };

  const wave1 = await runNext({ runId, workflow: FANOUT_WORKFLOW, dockerExec: stubExec });
  assert.deepEqual(wave1.completedSteps, ["source"]);

  // Wave 2: 3 children + integration (children 0+2 only) + HEAD merge. Parent
  // completes despite child 1 failure because failure_mode === 'continue'.
  const wave2 = await runNext({ runId, workflow: FANOUT_WORKFLOW, dockerExec: stubExec });
  assert.deepEqual(wave2.completedSteps, ["build"], "build must complete despite one child failing");
  assert.deepEqual(wave2.failedSteps, [], "no steps must fail at the step level");

  // child0.ts and child2.ts must be in repo (integrated to HEAD).
  assert.ok(existsSync(join(repo, "child0.ts")), "child0.ts must be in repo after integration merge");
  assert.ok(existsSync(join(repo, "child2.ts")), "child2.ts must be in repo after integration merge");

  const allTasks = tasksForRun(runId);
  const parentTask = allTasks.find((t) => t.phase === "build" && t.parentId === undefined)!;
  assert.equal(parentTask.status, "complete", "parent must be complete");

  const children = allTasks.filter(
    (t) => t.parentId === parentTask.id && !t.agentRole.startsWith("red-"),
  );
  assert.equal(children.length, 3, "three fanout children must exist");

  const failedChild = children.find(
    (c) =>
      typeof c.taskPackage?.inputs?.["fanoutIndex"] === "number" &&
      (c.taskPackage.inputs["fanoutIndex"] as number) === 1,
  );
  assert.ok(failedChild, "failed child (index 1) must exist in DB");
  assert.equal(failedChild!.status, "failed", "child 1 must be failed in DB");
  assert.ok(failedChild!.worktreePath, "failed child must have worktreePath recorded");

  // KEY ASSERTION: failed child's worktree must be RETAINED — it was never
  // merged into the integration branch, so no-discard applies.
  assert.ok(
    existsSync(failedChild!.worktreePath!),
    "failed child 1 worktree must be RETAINED — it was never merged, no-discard applies",
  );

  // Proven-merged children (0 and 2) must have their worktrees removed.
  const succeededChildren = children.filter((c) => c.status === "complete");
  assert.equal(succeededChildren.length, 2, "two children must have succeeded (indices 0 and 2)");
  for (const child of succeededChildren) {
    if (child.worktreePath) {
      assert.equal(
        existsSync(child.worktreePath),
        false,
        `proven-merged child ${child.id} (index ${child.taskPackage?.inputs?.["fanoutIndex"]}) worktree must be removed`,
      );
    }
  }
});

// ─── (11) Forced re-entry with missing integration branch => FAILED (not silently complete)
//
// FORGE_WORKTREES=1, FANOUT_WITH_RED_WORKFLOW.
// After wave 2 (parent blocked_by_red), the integration branch and worktree are
// manually deleted to simulate lost state (disk cleared, manual cleanup, etc.).
// Wave 3 (forced re-entry) must detect the missing integration branch and
// FAIL the parent loudly — not silently complete without merging child work.

test("fg353 (11): forced re-entry in worktree mode with integration branch absent => FAILED, not silently complete", async () => {
  setPlatform("darwin");
  process.env.FORGE_WORKTREES = "1";
  process.env.FORGE_WORKTREE_IGNORE_DIRTY = "1";
  process.env.FORGE_WORKTREES_EPHEMERAL = "1";

  const repo = makeTmpDir();
  initGitRepo(repo);
  ensureFanoutRedWorkflowYaml();

  const { runId } = startRun({
    workflow: FANOUT_WITH_RED_WORKFLOW,
    title: "fg353 missing integration branch re-entry test",
    inputs: {},
    projectDir: repo,
  });

  const FAIL_VERDICT = {
    status: "complete", tests_run: 1,
    verdict: "fail",
    confidence: 0.9,
    findings: [
      {
        severity: "high",
        summary: "fg353 test finding",
        evidence: "test evidence",
        hypothesis: "test hypothesis",
      },
    ],
  };

  const stubExec: DockerExecFn = async ({ args, stdoutPath, stderrPath }) => {
    const taskId = extractTaskId(args);
    const projectMount = findProjectMountHost(args);
    writeFileSync(stderrPath, "");
    if (taskId.startsWith("task-source-")) {
      writeTaskResult(stdoutPath, { status: "complete", tests_run: 1, items: ["item-a", "item-b"] });
    } else if (taskId.startsWith("task-build-0-")) {
      if (projectMount) writeFileSync(join(projectMount, "child0.ts"), "export const child0 = 0;\n");
      writeTaskResult(stdoutPath, { status: "complete", tests_run: 1 });
    } else if (taskId.startsWith("task-build-1-")) {
      if (projectMount) writeFileSync(join(projectMount, "child1.ts"), "export const child1 = 1;\n");
      writeTaskResult(stdoutPath, { status: "complete", tests_run: 1 });
    } else if (taskId.startsWith("task-red-build-")) {
      writeTaskResult(stdoutPath, FAIL_VERDICT);
    } else {
      writeTaskResult(stdoutPath, { status: "complete", tests_run: 1 });
    }
    return 0;
  };

  // ── Wave 1: source ─────────────────────────────────────────────────────────
  await runNext({ runId, workflow: FANOUT_WITH_RED_WORKFLOW, dockerExec: stubExec });

  // ── Wave 2: children + integration + red fails → blocked_by_red ───────────
  await runNext({ runId, workflow: FANOUT_WITH_RED_WORKFLOW, dockerExec: stubExec });

  const tasksAfterWave2 = tasksForRun(runId);
  const parentTask = tasksAfterWave2.find((t) => t.phase === "build" && t.parentId === undefined);
  assert.ok(parentTask, "fanout parent must exist");
  assert.equal(parentTask!.status, "blocked_by_red", "parent must be blocked_by_red after wave 2");

  // Confirm integration worktree exists before we delete it.
  const integPath = integrationWorktreeDir(runId, parentTask!.id);
  const intBranch = integrationBranchName(runId, parentTask!.id);
  assert.ok(existsSync(integPath), "integration worktree must exist before manual deletion");

  // ── Manually remove the integration branch and worktree ───────────────────
  // Simulates lost state between blocked_by_red and force-advance.
  execFileSync("git", ["worktree", "remove", "--force", integPath], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["branch", "-D", intBranch], { cwd: repo, stdio: "ignore" });
  assert.equal(existsSync(integPath), false, "integration worktree must be gone after manual deletion");

  // ── Force-advance via gate ────────────────────────────────────────────────
  await gate(parentTask!.id, "advance", "forced: fg353 missing integration test", { force: true });

  const tasksAfterGate = tasksForRun(runId);
  const parentAfterGate = tasksAfterGate.find((t) => t.id === parentTask!.id);
  assert.equal(parentAfterGate!.status, "pending", "parent must be pending after gate force-advance");
  assert.strictEqual(
    parentAfterGate!.taskPackage?.inputs?.["gateForced"],
    true,
    "gateForced must be set",
  );

  // ── Wave 3: re-entry with missing integration branch → FAILED ─────────────
  const wave3 = await runNext({ runId, workflow: FANOUT_WITH_RED_WORKFLOW, dockerExec: stubExec });
  assert.deepEqual(
    wave3.failedSteps,
    ["build"],
    "build must FAIL in wave 3 when integration branch missing",
  );
  assert.deepEqual(
    wave3.completedSteps,
    [],
    "build must NOT silently complete with missing integration branch",
  );

  const finalTasks = tasksForRun(runId);
  const finalParent = finalTasks.find((t) => t.id === parentTask!.id);
  assert.equal(finalParent!.status, "failed", "parent must be FAILED, not silently complete");
  assert.equal(
    failureKindForTask(finalParent!.id),
    "merge_conflict",
    "failure kind must be merge_conflict for missing integration branch",
  );

  // Child files must NOT be in run.projectDir — integration merge never happened.
  assert.equal(
    existsSync(join(repo, "child0.ts")),
    false,
    "child0.ts must NOT be in run.projectDir — integration merge must not have happened",
  );
  assert.equal(
    existsSync(join(repo, "child1.ts")),
    false,
    "child1.ts must NOT be in run.projectDir — integration merge must not have happened",
  );
});

// ─── (9) Missing/malformed result.json on forced re-entry => FAILED, not crash ─
//
// FORGE_WORKTREES=1, FANOUT_WITH_RED_WORKFLOW.
// (a) Wave 1+2: children complete, red returns authoritative fail → parent blocked_by_red.
// (b) Corrupt the saved result.json for the parent task.
// (c) gate(parentId, 'advance', ..., { force: true }) → parent becomes pending with gateForced=true.
// (d) Wave 3: re-entry must NOT crash runNext — missing/malformed result.json must
//     transition the parent to FAILED (not throw, not leave wedged as 'running').

test("fg353 (9): missing/malformed result.json on forced re-entry => parent FAILED, not crash", async () => {
  setPlatform("darwin");
  process.env.FORGE_WORKTREES = "1";
  process.env.FORGE_WORKTREE_IGNORE_DIRTY = "1";
  process.env.FORGE_WORKTREES_EPHEMERAL = "1";

  const repo = makeTmpDir();
  initGitRepo(repo);
  ensureFanoutRedWorkflowYaml();

  const { runId } = startRun({
    workflow: FANOUT_WITH_RED_WORKFLOW,
    title: "fg353 missing result.json re-entry test",
    inputs: {},
    projectDir: repo,
  });

  const FAIL_VERDICT = {
    status: "complete", tests_run: 1,
    verdict: "fail",
    confidence: 0.9,
    findings: [
      {
        severity: "high",
        summary: "fg353 test finding",
        evidence: "test evidence",
        hypothesis: "test hypothesis",
      },
    ],
  };

  const stubExec: DockerExecFn = async ({ args, stdoutPath, stderrPath }) => {
    const taskId = extractTaskId(args);
    const projectMount = findProjectMountHost(args);
    writeFileSync(stderrPath, "");

    if (taskId.startsWith("task-source-")) {
      writeTaskResult(stdoutPath, { status: "complete", tests_run: 1, items: ["item-a", "item-b"] });
    } else if (taskId.startsWith("task-build-0-")) {
      if (projectMount) writeFileSync(join(projectMount, "child0.ts"), "export const child0 = 0;\n");
      writeTaskResult(stdoutPath, { status: "complete", tests_run: 1 });
    } else if (taskId.startsWith("task-build-1-")) {
      if (projectMount) writeFileSync(join(projectMount, "child1.ts"), "export const child1 = 1;\n");
      writeTaskResult(stdoutPath, { status: "complete", tests_run: 1 });
    } else if (taskId.startsWith("task-red-build-")) {
      // Red returns authoritative fail → parent will be blocked_by_red.
      writeTaskResult(stdoutPath, FAIL_VERDICT);
    } else {
      writeTaskResult(stdoutPath, { status: "complete", tests_run: 1 });
    }
    return 0;
  };

  // ── Wave 1: source ─────────────────────────────────────────────────────────
  await runNext({ runId, workflow: FANOUT_WITH_RED_WORKFLOW, dockerExec: stubExec });

  // ── Wave 2: children + integration + red fails → parent blocked_by_red ────
  await runNext({ runId, workflow: FANOUT_WITH_RED_WORKFLOW, dockerExec: stubExec });

  const tasksAfterWave2 = tasksForRun(runId);
  const parentTask = tasksAfterWave2.find((t) => t.phase === "build" && t.parentId === undefined);
  assert.ok(parentTask, "fanout parent must exist");
  assert.equal(parentTask!.status, "blocked_by_red", "parent must be blocked_by_red after wave 2");

  // ── Corrupt the saved result.json ─────────────────────────────────────────
  const resultPath = join(taskDir(runId, parentTask!.id), "result.json");
  writeFileSync(resultPath, "NOT VALID JSON {{{");

  // ── Force-advance via gate ────────────────────────────────────────────────
  await gate(parentTask!.id, "advance", "forced: fg353 missing result test", { force: true });

  const tasksAfterGate = tasksForRun(runId);
  const parentAfterGate = tasksAfterGate.find((t) => t.id === parentTask!.id);
  assert.equal(parentAfterGate!.status, "pending", "parent must be pending after gate force-advance");

  // ── Wave 3: re-entry — malformed result.json must not crash runNext ───────
  // Must NOT throw. Must transition parent to 'failed', not leave it running/wedged.
  let wave3Error: Error | undefined;
  let wave3: Awaited<ReturnType<typeof runNext>> | undefined;
  try {
    wave3 = await runNext({ runId, workflow: FANOUT_WITH_RED_WORKFLOW, dockerExec: stubExec });
  } catch (e) {
    wave3Error = e as Error;
  }

  assert.equal(wave3Error, undefined, "runNext must NOT throw on malformed result.json");
  assert.ok(wave3, "runNext must return a result");
  assert.deepEqual(wave3!.failedSteps, ["build"], "build must fail due to malformed result.json");
  assert.deepEqual(wave3!.completedSteps, [], "no steps must complete");

  const finalTasks = tasksForRun(runId);
  const finalParent = finalTasks.find((t) => t.id === parentTask!.id);
  assert.ok(finalParent, "parent must still exist after wave 3");
  assert.equal(finalParent!.status, "failed", "parent must be 'failed', not 'running' (wedged)");

  // No new reds or children must have been dispatched.
  const newRedTasks = finalTasks.filter(
    (t) => t.parentId === parentTask!.id && t.agentRole.startsWith("red-"),
  );
  const initialRedCount = tasksAfterWave2.filter(
    (t) => t.parentId === parentTask!.id && t.agentRole.startsWith("red-"),
  ).length;
  assert.equal(newRedTasks.length, initialRedCount, "no new red tasks must be created in wave 3");

  // No integration->HEAD merge must have happened (result read failed before merge).
  assert.equal(
    existsSync(join(repo, "child0.ts")),
    false,
    "child0.ts must NOT be in run.projectDir — integration merge must not have happened",
  );
});

// ─── (12) merge --abort leaves integration worktree in clean non-MERGING state ─
//
// FORGE_WORKTREES=1. Children write the same file with different content so that
// merging child 1 into the integration branch (after child 0 is already merged)
// creates a genuine git conflict. The FG-353 code calls git merge --abort after
// the conflict to ensure the integration worktree is not left in MERGING state.
//
// This test asserts BOTH:
//   A. The integration worktree directory is RETAINED for inspection.
//   B. The integration worktree is in a CLEAN state — MERGE_HEAD is absent,
//      meaning git merge --abort ran successfully and the worktree is not in
//      "all conflicts fixed but you are still merging" limbo.
//
// This is independent of tests 4 and 6 which assert retention and failure kind
// but do NOT verify the post-abort clean state of the integration worktree.

test("fg353 (12): merge --abort leaves integration worktree in clean non-MERGING state after child conflict", async () => {
  setPlatform("darwin");
  process.env.FORGE_WORKTREES = "1";
  process.env.FORGE_WORKTREE_IGNORE_DIRTY = "1";
  process.env.FORGE_WORKTREES_EPHEMERAL = "1";

  const repo = makeTmpDir();
  initGitRepo(repo);

  const { runId } = startRun({
    workflow: FANOUT_WORKFLOW,
    title: "fg353 merge-abort clean state test",
    inputs: {},
    projectDir: repo,
  });

  const stubExec: DockerExecFn = async ({ args, stdoutPath, stderrPath }) => {
    const taskId = extractTaskId(args);
    const projectMount = findProjectMountHost(args);
    writeFileSync(stderrPath, "");

    if (taskId.startsWith("task-source-")) {
      writeTaskResult(stdoutPath, { status: "complete", tests_run: 1, items: ["item-a", "item-b"] });
    } else if (taskId.startsWith("task-build-0-")) {
      assert.ok(projectMount, "child 0 must have /project mount");
      // Child 0 commits shared.ts = 'A' on its branch.
      writeFileSync(join(projectMount!, "shared.ts"), "export const shared = 'A';\n");
      execFileSync("git", ["add", "."], { cwd: projectMount!, stdio: "ignore" });
      execFileSync("git", [...AGENT_IDENTITY, "commit", "-m", "child0: shared = A"], { cwd: projectMount!, stdio: "ignore" });
      writeTaskResult(stdoutPath, { status: "complete", tests_run: 1 });
    } else if (taskId.startsWith("task-build-1-")) {
      assert.ok(projectMount, "child 1 must have /project mount");
      // Child 1 commits shared.ts = 'B' (will conflict with child 0 in integration).
      writeFileSync(join(projectMount!, "shared.ts"), "export const shared = 'B';\n");
      execFileSync("git", ["add", "."], { cwd: projectMount!, stdio: "ignore" });
      execFileSync("git", [...AGENT_IDENTITY, "commit", "-m", "child1: shared = B"], { cwd: projectMount!, stdio: "ignore" });
      writeTaskResult(stdoutPath, { status: "complete", tests_run: 1 });
    } else {
      writeTaskResult(stdoutPath, { status: "complete", tests_run: 1 });
    }
    return 0;
  };

  const wave1 = await runNext({ runId, workflow: FANOUT_WORKFLOW, dockerExec: stubExec });
  assert.deepEqual(wave1.completedSteps, ["source"]);

  const wave2 = await runNext({ runId, workflow: FANOUT_WORKFLOW, dockerExec: stubExec });
  assert.deepEqual(wave2.failedSteps, ["build"], "build must fail due to child merge conflict");
  assert.deepEqual(wave2.completedSteps, [], "no steps must complete");

  const allTasks = tasksForRun(runId);
  const parentTask = allTasks.find((t) => t.phase === "build" && t.parentId === undefined);
  assert.ok(parentTask, "fanout parent task must exist");
  assert.equal(parentTask!.status, "failed", "parent must be failed");
  assert.equal(failureKindForTask(parentTask!.id), "merge_conflict", "failure kind must be merge_conflict");

  const integPath = integrationWorktreeDir(runId, parentTask!.id);

  // (A) Integration worktree directory must be RETAINED for inspection.
  assert.ok(
    existsSync(integPath),
    "integration worktree directory must be retained after child merge conflict",
  );

  // (B) Integration worktree must be in CLEAN (non-MERGING) state.
  // git merge --abort was called in mergeChildIntoIntegration after the conflict;
  // if it ran successfully, MERGE_HEAD must be absent.
  let mergeHeadSha = "";
  try {
    mergeHeadSha = execFileSync(
      "git",
      ["rev-parse", "--verify", "MERGE_HEAD"],
      { cwd: integPath, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
  } catch {
    // Expected: non-zero exit means MERGE_HEAD does not exist → abort succeeded.
    mergeHeadSha = "";
  }
  assert.equal(
    mergeHeadSha,
    "",
    "MERGE_HEAD must be absent in integration worktree after merge --abort — " +
      "worktree must not be left in MERGING state",
  );

  // Confirm git status shows no conflict markers (UU/AA/DD = unmerged paths).
  const porcelain = execFileSync(
    "git",
    ["status", "--porcelain=v1"],
    { cwd: integPath, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  );
  const hasConflictMarkers =
    porcelain.split("\n").some((line) => /^(UU|AA|DD|AU|UA|DU|UD) /.test(line));
  assert.equal(
    hasConflictMarkers,
    false,
    "integration worktree must have no unmerged (conflict-marker) paths in git status after merge --abort",
  );
});

// ─── (13) Forced re-entry HEAD-merge failure => FAILED with merge_conflict, integration retained
//
// FORGE_WORKTREES=1, FANOUT_WITH_RED_WORKFLOW.
// Extends test 7 (re-entry success) by making the integration→HEAD --ff-only
// merge FAIL at re-entry rather than succeed.
//
// Setup:
//   Waves 1+2: children complete, integration built, red returns authoritative
//   fail → parent blocked_by_red. Integration branch and worktree retained.
//
//   After wave 2, a commit is made DIRECTLY on run.projectDir's HEAD branch
//   (main) so it diverges from the integration branch's base commit. Now
//   git merge --ff-only <integration> fails ("Not possible to fast-forward").
//
//   gate(parentId, 'advance', ..., { force: true }) → parent pending + gateForced.
//
//   Wave 3 re-entry: the target has MOVED off the base the integration branch was
//   built from.
//
// CONTRACT CHANGED BY FG-425 (2026-07-13). This test used to assert that a diverged
// HEAD FAILED the parent with merge_conflict, because the old path published with
// `git merge --ff-only <integration>` into the target and a fast-forward was no
// longer possible. Under the serialized integration publisher a moved base is the
// case the design exists to HANDLE, not to fail on: the publisher builds the
// candidate on the target's CURRENT base, runs the integration gate against THAT
// merged tree, and CAS-publishes the exact commit it gated (ticket step 8 / AD-1).
//
// So a NON-CONFLICTING divergence now publishes — and, unlike the old --ff-only
// path, what lands has actually been validated. A divergence that genuinely
// CONFLICTS still fails and retains its evidence; that is covered at the publisher
// layer in fg425-publication-cas.worktree.test.ts ("a source that conflicts with
// the moved base").
//
// This is independent of test 7 (covers re-entry SUCCESS on an unmoved base) and
// test 11 (covers a missing integration branch).

test("fg353 (13): forced re-entry with a MOVED target — the publisher rebuilds on the new base, gates it, and publishes (supersedes the old --ff-only failure)", async () => {
  setPlatform("darwin");
  process.env.FORGE_WORKTREES = "1";
  process.env.FORGE_WORKTREE_IGNORE_DIRTY = "1";
  process.env.FORGE_WORKTREES_EPHEMERAL = "1";

  const repo = makeTmpDir();
  initGitRepo(repo);
  ensureFanoutRedWorkflowYaml();

  const { runId } = startRun({
    workflow: FANOUT_WITH_RED_WORKFLOW,
    title: "fg353 re-entry head-merge-failure test",
    inputs: {},
    projectDir: repo,
  });

  const FAIL_VERDICT = {
    status: "complete", tests_run: 1,
    verdict: "fail",
    confidence: 0.9,
    findings: [
      {
        severity: "high",
        summary: "fg353 test finding",
        evidence: "test evidence",
        hypothesis: "test hypothesis",
      },
    ],
  };

  const stubExec: DockerExecFn = async ({ args, stdoutPath, stderrPath }) => {
    const taskId = extractTaskId(args);
    const projectMount = findProjectMountHost(args);
    writeFileSync(stderrPath, "");

    if (taskId.startsWith("task-source-")) {
      writeTaskResult(stdoutPath, { status: "complete", tests_run: 1, items: ["item-a", "item-b"] });
    } else if (taskId.startsWith("task-build-0-")) {
      if (projectMount) writeFileSync(join(projectMount, "child0.ts"), "export const child0 = 0;\n");
      writeTaskResult(stdoutPath, { status: "complete", tests_run: 1 });
    } else if (taskId.startsWith("task-build-1-")) {
      if (projectMount) writeFileSync(join(projectMount, "child1.ts"), "export const child1 = 1;\n");
      writeTaskResult(stdoutPath, { status: "complete", tests_run: 1 });
    } else if (taskId.startsWith("task-red-build-")) {
      // Red returns authoritative fail → parent will be blocked_by_red.
      writeTaskResult(stdoutPath, FAIL_VERDICT);
    } else {
      writeTaskResult(stdoutPath, { status: "complete", tests_run: 1 });
    }
    return 0;
  };

  // ── Wave 1: source step ────────────────────────────────────────────────────
  const wave1 = await runNext({ runId, workflow: FANOUT_WITH_RED_WORKFLOW, dockerExec: stubExec });
  assert.deepEqual(wave1.completedSteps, ["source"]);

  // ── Wave 2: children + integration built + red fails → blocked_by_red ─────
  const wave2 = await runNext({ runId, workflow: FANOUT_WITH_RED_WORKFLOW, dockerExec: stubExec });
  assert.ok(
    wave2.awaitingGate.includes("build") || wave2.failedSteps.includes("build"),
    "build must be blocked or awaiting gate after authoritative red fail",
  );

  const tasksAfterWave2 = tasksForRun(runId);
  const parentTask = tasksAfterWave2.find((t) => t.phase === "build" && t.parentId === undefined);
  assert.ok(parentTask, "fanout parent task must exist");
  const parentId = parentTask!.id;
  assert.equal(parentTask!.status, "blocked_by_red", "parent must be blocked_by_red after authoritative fail");

  const integPath = integrationWorktreeDir(runId, parentId);
  const intBranch = integrationBranchName(runId, parentId);
  assert.ok(existsSync(integPath), "integration worktree must exist after wave 2");

  // ── Advance HEAD in repo so it diverges from the integration branch base ───
  // The integration branch was created from HEAD (initial commit). After children
  // merged in, integration is ahead of HEAD. Committing directly to repo main
  // makes HEAD diverge from the integration branch — so --ff-only will fail.
  writeFileSync(join(repo, "diverging-commit.ts"), "export const diverge = true;\n");
  execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
  execFileSync(
    "git",
    ["-c", "user.name=forge", "-c", "user.email=forge@local",
     "commit", "-m", "diverge HEAD from integration base"],
    { cwd: repo, stdio: "ignore" },
  );

  // Verify HEAD actually diverged (git merge --ff-only should now fail).
  // Not strictly required but guards against a mis-constructed test.
  let headMergeWouldFail = false;
  try {
    execFileSync("git", ["merge", "--no-commit", "--ff-only", intBranch], {
      cwd: repo,
      stdio: ["ignore", "ignore", "ignore"],
    });
    // If it succeeded, abort it and mark as not diverged.
    execFileSync("git", ["merge", "--abort"], { cwd: repo, stdio: "ignore" });
  } catch {
    headMergeWouldFail = true;
  }
  assert.ok(headMergeWouldFail, "pre-condition: HEAD must have diverged so --ff-only would fail");

  // ── Force-advance via gate ────────────────────────────────────────────────
  await gate(parentId, "advance", "forced: fg353 head-merge-failure test", { force: true });

  const tasksAfterGate = tasksForRun(runId);
  const parentAfterGate = tasksAfterGate.find((t) => t.id === parentId);
  assert.equal(parentAfterGate!.status, "pending", "parent must be pending after gate force-advance");
  assert.strictEqual(
    parentAfterGate!.taskPackage?.inputs?.["gateForced"],
    true,
    "gateForced flag must be set",
  );

  // ── Wave 3: re-entry — the target has moved off the integration branch's base ──
  // FG-425: this is no longer a failure. The publisher captures the CURRENT base,
  // merges the integration branch onto it in a fresh candidate worktree, gates that
  // merged tree, and publishes the exact commit it gated.
  const wave3 = await runNext({ runId, workflow: FANOUT_WITH_RED_WORKFLOW, dockerExec: stubExec });
  assert.deepEqual(
    wave3.failedSteps,
    [],
    "a NON-CONFLICTING moved base must not fail the run — the publisher rebuilds on it (FG-425 step 8)",
  );
  assert.deepEqual(wave3.completedSteps, ["build"], "build must complete after the rebuild-and-publish");

  const finalTasks = tasksForRun(runId);
  const finalParent = finalTasks.find((t) => t.id === parentId);
  assert.equal(finalParent!.status, "complete", "parent must be COMPLETE after publishing onto the moved base");

  // What landed is a MERGE of the integration branch onto the diverged commit —
  // and, crucially, it was gated in the candidate worktree BEFORE it landed. The
  // old --ff-only path could never produce this; it just failed.
  assert.ok(existsSync(join(repo, "child0.ts")), "child0.ts must be on the target");
  assert.ok(existsSync(join(repo, "child1.ts")), "child1.ts must be on the target");
  assert.ok(
    existsSync(join(repo, "diverging-commit.ts")),
    "the external writer's commit must survive — the publish fast-forwards it, never rewrites over it",
  );

  // A published attempt reclaims its evidence: the integration worktree/branch are
  // cleaned up, exactly as on the unmoved-base success path (test 7).
  assert.equal(existsSync(integPath), false, "the integration worktree is reclaimed after a successful publish");
  void intBranch;
});

// ─── (14) Forced re-entry with gate:verdict — parent COMPLETE (not awaiting_gate) ─
//
// This is the canonical FG-353 regression: the feature.yml fan-out build step uses
// gate:verdict. Without the fix, forced re-entry bounces the parent back to
// awaiting_gate instead of completing. With the fix it must complete directly.
//
// FORGE_WORKTREES=1, FANOUT_VERDICT_DOWNSTREAM_WORKFLOW (gate:verdict + downstream).
// Wave 1: source completes.
// Wave 2: children complete, integration built, red authoritative-fails → blocked_by_red.
// gate(parentId, "advance", ..., { force: true }) → parent pending + gateForced=true.
// Wave 3 (re-entry): parent must be COMPLETE (NOT awaiting_gate), integration merged to
//   HEAD (both child files in run.projectDir), no new children or reds dispatched.
// Wave 4: downstream step dispatches/completes (proving the gate actually advanced).

test("fg353 (14): forced re-entry on gate:verdict fanout — parent COMPLETE not awaiting_gate, downstream advances", async () => {
  setPlatform("darwin");
  process.env.FORGE_WORKTREES = "1";
  process.env.FORGE_WORKTREE_IGNORE_DIRTY = "1";
  process.env.FORGE_WORKTREES_EPHEMERAL = "1";

  const repo = makeTmpDir();
  initGitRepo(repo);
  ensureFanoutVerdictDownstreamWorkflowYaml();

  const { runId } = startRun({
    workflow: FANOUT_VERDICT_DOWNSTREAM_WORKFLOW,
    title: "fg353 verdict re-entry test",
    inputs: {},
    projectDir: repo,
  });

  const FAIL_VERDICT = {
    status: "complete", tests_run: 1,
    verdict: "fail",
    confidence: 0.9,
    findings: [
      {
        severity: "high",
        summary: "fg353 verdict gate test finding",
        evidence: "test evidence",
        hypothesis: "test hypothesis",
      },
    ],
  };

  let wave3ExecCount = 0;
  let downstreamDispatched = false;

  const stubExec: DockerExecFn = async ({ args, stdoutPath, stderrPath }) => {
    const taskId = extractTaskId(args);
    const projectMount = findProjectMountHost(args);
    writeFileSync(stderrPath, "");

    if (taskId.startsWith("task-source-")) {
      writeTaskResult(stdoutPath, { status: "complete", tests_run: 1, items: ["item-a", "item-b"] });
    } else if (taskId.startsWith("task-build-0-")) {
      if (projectMount) writeFileSync(join(projectMount, "child0.ts"), "export const child0 = 0;\n");
      writeTaskResult(stdoutPath, { status: "complete", tests_run: 1 });
    } else if (taskId.startsWith("task-build-1-")) {
      if (projectMount) writeFileSync(join(projectMount, "child1.ts"), "export const child1 = 1;\n");
      writeTaskResult(stdoutPath, { status: "complete", tests_run: 1 });
    } else if (taskId.startsWith("task-red-build-")) {
      // Red returns authoritative fail → parent will be blocked_by_red.
      writeTaskResult(stdoutPath, FAIL_VERDICT);
    } else if (taskId.startsWith("task-downstream-")) {
      downstreamDispatched = true;
      writeTaskResult(stdoutPath, { status: "complete", tests_run: 1 });
    } else {
      wave3ExecCount++;
      writeTaskResult(stdoutPath, { status: "complete", tests_run: 1 });
    }
    return 0;
  };

  // ── Wave 1: source step ────────────────────────────────────────────────────
  const wave1 = await runNext({ runId, workflow: FANOUT_VERDICT_DOWNSTREAM_WORKFLOW, dockerExec: stubExec });
  assert.deepEqual(wave1.completedSteps, ["source"]);

  // ── Wave 2: fanout (children + integration + red fails) ───────────────────
  const wave2 = await runNext({ runId, workflow: FANOUT_VERDICT_DOWNSTREAM_WORKFLOW, dockerExec: stubExec });
  assert.ok(
    wave2.awaitingGate.includes("build") || wave2.failedSteps.includes("build"),
    "build must be blocked or awaiting gate after authoritative red fail",
  );

  const tasksAfterWave2 = tasksForRun(runId);
  const parentTask = tasksAfterWave2.find((t) => t.phase === "build" && t.parentId === undefined);
  assert.ok(parentTask, "fanout parent task must exist");
  const parentId = parentTask!.id;
  assert.equal(parentTask!.status, "blocked_by_red", "parent must be blocked_by_red after authoritative fail");

  const initialChildCount = tasksAfterWave2.filter(
    (t) => t.parentId === parentId && !t.agentRole.startsWith("red-"),
  ).length;
  const initialRedCount = tasksAfterWave2.filter(
    (t) => t.parentId === parentId && t.agentRole.startsWith("red-"),
  ).length;
  assert.equal(initialChildCount, 2, "two children after wave 2");
  assert.equal(initialRedCount, 1, "one red after wave 2");

  // Integration branch must be retained (not merged/cleaned yet).
  const integPath = integrationWorktreeDir(runId, parentId);
  assert.ok(existsSync(integPath), "integration worktree must be retained when parent is blocked_by_red");

  // ── Force-advance via gate ────────────────────────────────────────────────
  await gate(parentId, "advance", "forced: fg353 verdict gate test", { force: true });

  const tasksAfterGate = tasksForRun(runId);
  const parentAfterGate = tasksAfterGate.find((t) => t.id === parentId);
  assert.equal(parentAfterGate!.status, "pending", "parent must be pending after gate force-advance");
  assert.strictEqual(
    parentAfterGate!.taskPackage?.inputs?.["gateForced"],
    true,
    "gateForced flag must be set on parent inputs",
  );

  // ── Wave 3: re-entry — must COMPLETE, not bounce to awaiting_gate ─────────
  const wave3ExecsBefore = wave3ExecCount;
  const wave3 = await runNext({ runId, workflow: FANOUT_VERDICT_DOWNSTREAM_WORKFLOW, dockerExec: stubExec });

  // KEY ASSERTION: build must complete in wave 3, NOT go to awaiting_gate.
  // This is the canonical FG-353 regression on gate:verdict fan-out parents.
  assert.deepEqual(wave3.completedSteps, ["build"], "build must COMPLETE in wave 3 re-entry — NOT awaiting_gate");
  assert.equal(wave3.awaitingGate.includes("build"), false, "build must NOT bounce to awaiting_gate in wave 3");
  assert.deepEqual(wave3.failedSteps, [], "no steps must fail in wave 3");

  // No new containers must have been dispatched in wave 3 (no child/red re-dispatch).
  assert.equal(wave3ExecCount, wave3ExecsBefore, "no new docker execs in wave 3 re-entry");

  const tasksAfterWave3 = tasksForRun(runId);
  const parentAfterWave3 = tasksAfterWave3.find((t) => t.id === parentId);
  assert.equal(parentAfterWave3!.status, "complete", "parent must be complete after wave 3");

  // No new children or reds must have been created.
  const finalChildCount = tasksAfterWave3.filter(
    (t) => t.parentId === parentId && !t.agentRole.startsWith("red-"),
  ).length;
  const finalRedCount = tasksAfterWave3.filter(
    (t) => t.parentId === parentId && t.agentRole.startsWith("red-"),
  ).length;
  assert.equal(finalChildCount, initialChildCount, "no new children dispatched in wave 3");
  assert.equal(finalRedCount, initialRedCount, "no new reds dispatched in wave 3");

  // Integration merged to HEAD — both child files must be in run.projectDir.
  assert.ok(
    existsSync(join(repo, "child0.ts")),
    "child0.ts must be in run.projectDir after re-entry integration merge",
  );
  assert.ok(
    existsSync(join(repo, "child1.ts")),
    "child1.ts must be in run.projectDir after re-entry integration merge",
  );

  // Integration worktree must be removed (provenMerged cleanup).
  assert.equal(
    existsSync(integPath),
    false,
    "integration worktree must be removed after re-entry proven-merge cleanup",
  );

  // ── Wave 4: downstream step must dispatch (gate actually advanced) ─────────
  const wave4 = await runNext({ runId, workflow: FANOUT_VERDICT_DOWNSTREAM_WORKFLOW, dockerExec: stubExec });
  assert.deepEqual(wave4.completedSteps, ["downstream"], "downstream step must complete in wave 4");
  assert.ok(downstreamDispatched, "downstream container must have been dispatched in wave 4");
});

// ─── (15) Forced re-entry with gate:human — parent COMPLETE (not awaiting_gate) ─
//
// Independent variant of test 14 using gate:human on the fanout build step.
// Proves the FG-353 fix is gate-type-agnostic: the gateForced re-entry block
// calls markTaskComplete directly (bypassing finalizePrimary), so the parent
// completes regardless of whether the step has gate:verdict or gate:human.
// Without the fix, finalizePrimary would return awaiting_gate for gate:human
// just as it would for gate:verdict.
//
// FORGE_WORKTREES=1, FANOUT_HUMAN_DOWNSTREAM_WORKFLOW (gate:human + authoritative red + downstream).
// Wave 1: source completes.
// Wave 2: children complete, integration built, red authoritative-fails → blocked_by_red.
// gate(parentId, "advance", ..., { force: true }) → parent pending + gateForced=true.
// Wave 3 (re-entry): parent must be COMPLETE (NOT awaiting_gate), integration merged to
//   HEAD (both child files in run.projectDir), no new children or reds dispatched.
// Wave 4: downstream step dispatches/completes (proving the gate actually advanced).

test("fg353 (15): forced re-entry on gate:human fanout — parent COMPLETE not awaiting_gate, downstream advances", async () => {
  setPlatform("darwin");
  process.env.FORGE_WORKTREES = "1";
  process.env.FORGE_WORKTREE_IGNORE_DIRTY = "1";
  process.env.FORGE_WORKTREES_EPHEMERAL = "1";

  const repo = makeTmpDir();
  initGitRepo(repo);
  ensureFanoutHumanDownstreamWorkflowYaml();

  const { runId } = startRun({
    workflow: FANOUT_HUMAN_DOWNSTREAM_WORKFLOW,
    title: "fg353 human-gate re-entry test",
    inputs: {},
    projectDir: repo,
  });

  const FAIL_VERDICT = {
    status: "complete", tests_run: 1,
    verdict: "fail",
    confidence: 0.9,
    findings: [
      {
        severity: "high",
        summary: "fg353 human gate test finding",
        evidence: "test evidence",
        hypothesis: "test hypothesis",
      },
    ],
  };

  let wave3ExecCount = 0;
  let downstreamDispatched = false;

  const stubExec: DockerExecFn = async ({ args, stdoutPath, stderrPath }) => {
    const taskId = extractTaskId(args);
    const projectMount = findProjectMountHost(args);
    writeFileSync(stderrPath, "");

    if (taskId.startsWith("task-source-")) {
      writeTaskResult(stdoutPath, { status: "complete", tests_run: 1, items: ["item-a", "item-b"] });
    } else if (taskId.startsWith("task-build-0-")) {
      if (projectMount) writeFileSync(join(projectMount, "child0.ts"), "export const child0 = 0;\n");
      writeTaskResult(stdoutPath, { status: "complete", tests_run: 1 });
    } else if (taskId.startsWith("task-build-1-")) {
      if (projectMount) writeFileSync(join(projectMount, "child1.ts"), "export const child1 = 1;\n");
      writeTaskResult(stdoutPath, { status: "complete", tests_run: 1 });
    } else if (taskId.startsWith("task-red-build-")) {
      // Red returns authoritative fail → parent will be blocked_by_red.
      writeTaskResult(stdoutPath, FAIL_VERDICT);
    } else if (taskId.startsWith("task-downstream-")) {
      downstreamDispatched = true;
      writeTaskResult(stdoutPath, { status: "complete", tests_run: 1 });
    } else {
      wave3ExecCount++;
      writeTaskResult(stdoutPath, { status: "complete", tests_run: 1 });
    }
    return 0;
  };

  // ── Wave 1: source step ────────────────────────────────────────────────────
  const wave1 = await runNext({ runId, workflow: FANOUT_HUMAN_DOWNSTREAM_WORKFLOW, dockerExec: stubExec });
  assert.deepEqual(wave1.completedSteps, ["source"]);

  // ── Wave 2: fanout (children + integration + red fails) ───────────────────
  const wave2 = await runNext({ runId, workflow: FANOUT_HUMAN_DOWNSTREAM_WORKFLOW, dockerExec: stubExec });
  assert.ok(
    wave2.awaitingGate.includes("build") || wave2.failedSteps.includes("build"),
    "build must be blocked or awaiting gate after authoritative red fail",
  );

  const tasksAfterWave2 = tasksForRun(runId);
  const parentTask = tasksAfterWave2.find((t) => t.phase === "build" && t.parentId === undefined);
  assert.ok(parentTask, "fanout parent task must exist");
  const parentId = parentTask!.id;
  assert.equal(parentTask!.status, "blocked_by_red", "parent must be blocked_by_red after authoritative fail");

  const initialChildCount = tasksAfterWave2.filter(
    (t) => t.parentId === parentId && !t.agentRole.startsWith("red-"),
  ).length;
  const initialRedCount = tasksAfterWave2.filter(
    (t) => t.parentId === parentId && t.agentRole.startsWith("red-"),
  ).length;
  assert.equal(initialChildCount, 2, "two children after wave 2");
  assert.equal(initialRedCount, 1, "one red after wave 2");

  // Integration branch must be retained (not merged/cleaned yet).
  const integPath = integrationWorktreeDir(runId, parentId);
  assert.ok(existsSync(integPath), "integration worktree must be retained when parent is blocked_by_red");

  // ── Force-advance via gate ────────────────────────────────────────────────
  await gate(parentId, "advance", "forced: fg353 human gate test", { force: true });

  const tasksAfterGate = tasksForRun(runId);
  const parentAfterGate = tasksAfterGate.find((t) => t.id === parentId);
  assert.equal(parentAfterGate!.status, "pending", "parent must be pending after gate force-advance");
  assert.strictEqual(
    parentAfterGate!.taskPackage?.inputs?.["gateForced"],
    true,
    "gateForced flag must be set on parent inputs",
  );

  // ── Wave 3: re-entry — must COMPLETE, not bounce to awaiting_gate ─────────
  // gate:human finalizePrimary returns awaiting_gate; the fix bypasses finalizePrimary
  // and calls markTaskComplete directly in the gateForced re-entry block.
  const wave3ExecsBefore = wave3ExecCount;
  const wave3 = await runNext({ runId, workflow: FANOUT_HUMAN_DOWNSTREAM_WORKFLOW, dockerExec: stubExec });

  // KEY ASSERTION: build must complete in wave 3, NOT go to awaiting_gate.
  // This is the gate:human variant of the FG-353 regression (gate:verdict was test 14).
  assert.deepEqual(wave3.completedSteps, ["build"], "build must COMPLETE in wave 3 re-entry — NOT awaiting_gate");
  assert.equal(wave3.awaitingGate.includes("build"), false, "build must NOT bounce to awaiting_gate in wave 3");
  assert.deepEqual(wave3.failedSteps, [], "no steps must fail in wave 3");

  // No new containers must have been dispatched in wave 3 (no child/red re-dispatch).
  assert.equal(wave3ExecCount, wave3ExecsBefore, "no new docker execs in wave 3 re-entry");

  const tasksAfterWave3 = tasksForRun(runId);
  const parentAfterWave3 = tasksAfterWave3.find((t) => t.id === parentId);
  assert.equal(parentAfterWave3!.status, "complete", "parent must be complete after wave 3");

  // No new children or reds must have been created.
  const finalChildCount = tasksAfterWave3.filter(
    (t) => t.parentId === parentId && !t.agentRole.startsWith("red-"),
  ).length;
  const finalRedCount = tasksAfterWave3.filter(
    (t) => t.parentId === parentId && t.agentRole.startsWith("red-"),
  ).length;
  assert.equal(finalChildCount, initialChildCount, "no new children dispatched in wave 3");
  assert.equal(finalRedCount, initialRedCount, "no new reds dispatched in wave 3");

  // Integration merged to HEAD — both child files must be in run.projectDir.
  assert.ok(
    existsSync(join(repo, "child0.ts")),
    "child0.ts must be in run.projectDir after re-entry integration merge",
  );
  assert.ok(
    existsSync(join(repo, "child1.ts")),
    "child1.ts must be in run.projectDir after re-entry integration merge",
  );

  // Integration worktree must be removed (provenMerged cleanup).
  assert.equal(
    existsSync(integPath),
    false,
    "integration worktree must be removed after re-entry proven-merge cleanup",
  );

  // ── Wave 4: downstream step must dispatch (gate actually advanced) ─────────
  const wave4 = await runNext({ runId, workflow: FANOUT_HUMAN_DOWNSTREAM_WORKFLOW, dockerExec: stubExec });
  assert.deepEqual(wave4.completedSteps, ["downstream"], "downstream step must complete in wave 4");
  assert.ok(downstreamDispatched, "downstream container must have been dispatched in wave 4");
});
