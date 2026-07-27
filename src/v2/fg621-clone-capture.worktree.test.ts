// FG-621 — COMPLETION CAPTURE and BASE SELECTION, over real git and the real
// dispatch path.
//
// The capture ordering is a CONTRACT, not an implementation detail (the ticket's
// architect-gate decision):
//
//   1. safety-commit remaining clone state, TRACKED AND UNTRACKED;
//   2. resolve the clone's branch tip;
//   3. fetch it into the PARENT's ref namespace under the deterministic name —
//      a real durable ref, never FETCH_HEAD;
//   4. VERIFY the fetched parent ref equals the resolved clone tip;
//   5. hand that ref to the publisher;
//   6. no later clone-side commit.
//
// Step 6 is enforced structurally by OMITTING `CandidateSource.worktreePath` for
// a clone source: the publisher's autoCommitSource can only mutate a source it
// was told the path of. The clone and the parent are DIFFERENT repositories, so a
// post-fetch commit in the clone would advance only the clone's ref and be
// silently absent from the candidate.
//
// The dispatch-level tests below run the REAL runNext with a stub docker exec
// standing in for the agent container. setPlatform("darwin") is required because
// preflightWorktreeGate hard-fails on Linux by decision (FG-358), which FG-621
// inherits unchanged.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { Database as DatabaseInstance } from "better-sqlite3";

import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { insertTask, tasksForRun } from "../store/tasks.js";
import {
  latestPublishedShaForRun,
  publicationAttemptsForTask,
  recordPublicationIntent,
  setPublicationClockOffsetForTest,
  updatePublicationAttempt,
} from "../store/publications.js";
import { CLONES_DIR } from "../util/paths.js";
import { startRun } from "./startRun.js";
import { runNext, type DockerExecFn } from "./runNext.js";
import type { Workflow } from "./schema.js";
import { captureTaskClone, createTaskClone, worktreeBranchName } from "./worktree-lifecycle.js";
import { publishFlatAsGeneration } from "./seed-generation.testkit.js";

const RUNTIME = "fg621-capture-test";

// ─── Workflow fixtures ────────────────────────────────────────────────────────

const SINGLE: Workflow = {
  name: "fg621-capture-single",
  description: "FG-621 capture: one mutating step",
  inputs: [],
  steps: [
    { id: "build", agent: "engineer", gate: "auto", manual: false, depends_on: [], runtime: RUNTIME, reds: [] },
  ],
};

const SEQUENTIAL: Workflow = {
  name: "fg621-capture-sequential",
  description: "FG-621 base selection: two sequential mutating steps",
  inputs: [],
  steps: [
    { id: "build", agent: "engineer", gate: "auto", manual: false, depends_on: [], runtime: RUNTIME, reds: [] },
    { id: "verify", agent: "test-engineer", gate: "auto", manual: false, depends_on: ["build"], runtime: RUNTIME, reds: [] },
  ],
};

const FANOUT: Workflow = {
  name: "fg621-capture-fanout",
  description: "FG-621 base selection: one fan-out wave",
  inputs: [],
  steps: [
    { id: "source", agent: "planner", gate: "auto", manual: false, depends_on: [], runtime: RUNTIME, reds: [] },
    {
      id: "build",
      agent: "engineer",
      gate: "auto",
      manual: false,
      depends_on: ["source"],
      runtime: RUNTIME,
      reds: [],
      fanout: {
        from_upstream: { step: "source", array_key: "items", input_key: "item" },
        max_concurrency: 3,
        failure_mode: "continue",
      },
    },
  ],
};

// ─── Harness ──────────────────────────────────────────────────────────────────

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

function setPlatform(p: string): void {
  Object.defineProperty(process, "platform", { value: p, configurable: true });
}

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
  for (const k of ENV_VARS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  ensureRuntime();
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

function tmpRoot(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `forge-fg621-${label}-`));
  tmpDirs.push(dir);
  return dir;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function makeRepo(): string {
  const dir = tmpRoot("repo");
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "test@forge.test");
  git(dir, "config", "user.name", "Forge Test");
  writeFileSync(join(dir, "README.md"), "# fg621 capture\n");
  writeFileSync(join(dir, "tracked.ts"), "export const version = 1;\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "initial");
  return dir;
}

function ensureRuntime(): void {
  const runtimePath = join(process.env.FORGE_HOME!, "runtimes", `${RUNTIME}.yml`);
  mkdirSync(dirname(runtimePath), { recursive: true });
  writeFileSync(
    runtimePath,
    `name: ${RUNTIME}
description: FG-621 capture test runtime stub
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

/** The host path docker was told to mount at /project — the task's workspace. */
function projectMountHost(dockerArgs: string[]): string | undefined {
  for (let i = 0; i < dockerArgs.length - 1; i++) {
    if (dockerArgs[i] === "-v" && dockerArgs[i + 1]!.includes(":/project:")) {
      return dockerArgs[i + 1]!.split(":")[0];
    }
  }
  return undefined;
}

/** The task id docker was told to name the container after. */
function taskIdOf(dockerArgs: string[]): string {
  const i = dockerArgs.indexOf("--name");
  return i >= 0 ? (dockerArgs[i + 1] ?? "").replace(/^forge-/, "") : "";
}

function writeTaskResult(stdoutPath: string, result: unknown): void {
  const dir = dirname(stdoutPath);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "result.json"), JSON.stringify(result));
  writeFileSync(stdoutPath, "stub stdout");
  writeFileSync(join(dir, "container.stderr.log"), "");
}

function armWorktreeMode(): void {
  setPlatform("darwin");
  process.env.FORGE_WORKTREES = "1";
  process.env.FORGE_WORKTREE_IGNORE_DIRTY = "1";
}

// ── Capture mechanics, against the primitive (AC 5, AC 3) ─────────────────────

test("fg621 (AC 5): capture fetches the agent's OWN commits into the parent under the deterministic name, and VERIFIES the two agree", () => {
  const repo = makeRepo();
  const base = git(repo, "rev-parse", "HEAD").trim();
  const clone = createTaskClone(repo, "run-cap", "t-commits", base);
  const branch = worktreeBranchName("run-cap", "t-commits");

  // The agent commits freely in its own repository — twice, so this proves a
  // whole commit SET travels, not just a tip.
  writeFileSync(join(clone.clonePath, "first.ts"), "export const a = 1;\n");
  git(clone.clonePath, "add", ".");
  git(clone.clonePath, "-c", "user.email=a@b.c", "-c", "user.name=Agent", "commit", "-q", "-m", "agent commit 1");
  writeFileSync(join(clone.clonePath, "second.ts"), "export const b = 2;\n");
  git(clone.clonePath, "add", ".");
  git(clone.clonePath, "-c", "user.email=a@b.c", "-c", "user.name=Agent", "commit", "-q", "-m", "agent commit 2");
  const tip = git(clone.clonePath, "rev-parse", branch).trim();

  // Before capture, the parent still sits on the anchor at the base.
  assert.equal(git(repo, "rev-parse", branch).trim(), base, "an agent commit is not published by existing");

  const capture = captureTaskClone(repo, clone.clonePath, "run-cap", "t-commits");
  assert.ok(capture.ok, capture.ok ? "" : capture.error);
  assert.equal(capture.commit, tip);
  assert.equal(capture.safetyCommitted, false, "nothing was dirty, so nothing was safety-committed");

  assert.equal(git(repo, "rev-parse", `refs/heads/${branch}`).trim(), tip, "a real durable ref, never FETCH_HEAD");
  const subjects = git(repo, "log", "--format=%s", `${base}..${branch}`).trim().split("\n");
  assert.deepEqual(subjects, ["agent commit 2", "agent commit 1"], "the whole commit set arrived, in order");
});

test("fg621 (AC 3): a clone left with a TRACKED edit and an UNTRACKED file has both in the captured tip", () => {
  const repo = makeRepo();
  const base = git(repo, "rev-parse", "HEAD").trim();
  const clone = createTaskClone(repo, "run-cap", "t-dirty", base);

  writeFileSync(join(clone.clonePath, "tracked.ts"), "export const version = 2;\n"); // tracked modification
  writeFileSync(join(clone.clonePath, "untracked.ts"), "export const brand = 'new';\n"); // never added

  const capture = captureTaskClone(repo, clone.clonePath, "run-cap", "t-dirty");
  assert.ok(capture.ok, capture.ok ? "" : capture.error);
  assert.equal(capture.safetyCommitted, true, "Forge safety-committed what the agent left behind");

  const tree = git(repo, "ls-tree", "--name-only", "-r", capture.commit).trim().split("\n");
  assert.ok(tree.includes("untracked.ts"), "the untracked half exists NOWHERE else — losing it is a discard");
  assert.equal(
    git(repo, "show", `${capture.commit}:tracked.ts`).trim(),
    "export const version = 2;",
    "and the tracked edit is the agent's, not the base's",
  );
  assert.equal(git(clone.clonePath, "status", "--porcelain").trim(), "", "the clone is clean once captured");
});

test("fg621 (AC 5): the fully-uncommitted case still captures — the agent committing nothing is the safety net's whole point", () => {
  const repo = makeRepo();
  const base = git(repo, "rev-parse", "HEAD").trim();
  const clone = createTaskClone(repo, "run-cap", "t-nocommit", base);
  writeFileSync(join(clone.clonePath, "only-output.ts"), "export const all = 'of it';\n");

  const capture = captureTaskClone(repo, clone.clonePath, "run-cap", "t-nocommit");
  assert.ok(capture.ok, capture.ok ? "" : capture.error);
  assert.notEqual(capture.commit, base, "the safety commit advanced the branch");
  assert.match(
    git(repo, "ls-tree", "--name-only", "-r", capture.commit),
    /only-output\.ts/,
    "and the parent can now reach work the agent never committed",
  );
});

test("fg621: capture REFUSES a clone that is not on its own task branch — a name that does not describe the work is not a capture", () => {
  const repo = makeRepo();
  const base = git(repo, "rev-parse", "HEAD").trim();
  const clone = createTaskClone(repo, "run-cap", "t-wander", base);
  git(clone.clonePath, "checkout", "-q", "-b", "somewhere-else");
  writeFileSync(join(clone.clonePath, "elsewhere.ts"), "export const lost = true;\n");

  const capture = captureTaskClone(repo, clone.clonePath, "run-cap", "t-wander");
  assert.equal(capture.ok, false);
  assert.match(capture.ok ? "" : capture.error, /not on refs\/heads\/forge\/run-cap\/t-wander/);
  assert.ok(existsSync(join(clone.clonePath, "elsewhere.ts")), "and the refusal retains the clone rather than disposing of it");
});

// ── AC 3 through the REAL dispatch path ───────────────────────────────────────

test("fg621 (AC 3, end to end): both halves of an agent's output reach the published project tree", async () => {
  armWorktreeMode();
  const repo = makeRepo();
  const { runId } = startRun({ workflow: SINGLE, title: "fg621 ac3", inputs: {}, projectDir: repo });

  const stubExec: DockerExecFn = async ({ args, stdoutPath, stderrPath }) => {
    const ws = projectMountHost(args)!;
    writeFileSync(stderrPath, "");
    // Agent commits one file itself (private commit authority) …
    writeFileSync(join(ws, "committed-by-agent.ts"), "export const own = true;\n");
    git(ws, "add", ".");
    git(ws, "-c", "user.email=a@b.c", "-c", "user.name=Agent", "commit", "-q", "-m", "agent's own commit");
    // … and leaves a tracked edit plus an untracked file behind at exit.
    writeFileSync(join(ws, "tracked.ts"), "export const version = 99;\n");
    writeFileSync(join(ws, "left-untracked.ts"), "export const dirty = true;\n");
    writeTaskResult(stdoutPath, {
      status: "complete",
      tests_run: 1,
      files_modified: ["committed-by-agent.ts", "tracked.ts", "left-untracked.ts"],
    });
    return 0;
  };

  const wave = await runNext({ runId, workflow: SINGLE, dockerExec: stubExec });
  assert.deepEqual(wave.completedSteps, ["build"], "the step must complete");

  assert.ok(existsSync(join(repo, "committed-by-agent.ts")), "the agent's own commit was retrieved");
  assert.ok(existsSync(join(repo, "left-untracked.ts")), "and the untracked half the safety commit captured");
  assert.equal(readFileSync(join(repo, "tracked.ts"), "utf8"), "export const version = 99;\n", "and the tracked edit");
});

// ── AC 4: base selection, asserted on the RECORDED row ────────────────────────

test("fg621 (AC 4): a sequential task's recorded base_sha IS its predecessor's recorded published_sha", async () => {
  armWorktreeMode();
  const repo = makeRepo();
  const { runId } = startRun({ workflow: SEQUENTIAL, title: "fg621 ac4 sequential", inputs: {}, projectDir: repo });

  const stubExec: DockerExecFn = async ({ args, stdoutPath, stderrPath }) => {
    const ws = projectMountHost(args)!;
    const taskId = taskIdOf(args);
    writeFileSync(stderrPath, "");
    writeFileSync(join(ws, `${taskId}.ts`), `export const step = "${taskId}";\n`);
    writeTaskResult(stdoutPath, { status: "complete", tests_run: 1, files_modified: [`${taskId}.ts`] });
    return 0;
  };

  await runNext({ runId, workflow: SEQUENTIAL, dockerExec: stubExec });
  const second = await runNext({ runId, workflow: SEQUENTIAL, dockerExec: stubExec });
  assert.deepEqual(second.completedSteps, ["verify"], "the second step must run");

  const tasks = tasksForRun(runId);
  const build = tasks.find((t) => t.phase === "build")!;
  const verify = tasks.find((t) => t.phase === "verify")!;

  const receipt = publicationAttemptsForTask(build.id).find((a) => a.state === "published");
  assert.ok(receipt?.publishedSha, "the predecessor recorded a publication receipt");
  assert.equal(
    verify.baseSha,
    receipt.publishedSha,
    "AC 4 read off the DB rows, not inferred: the successor's workspace was created from the exact accepted " +
      "predecessor candidate — the RECEIPT, not a re-read of HEAD",
  );
  assert.notEqual(verify.baseSha, build.baseSha, "and the base genuinely moved between the two steps");
});

test("fg621 (AC 4): every sibling of one fan-out wave records the SAME base", async () => {
  armWorktreeMode();
  const repo = makeRepo();
  const { runId } = startRun({ workflow: FANOUT, title: "fg621 ac4 fanout", inputs: {}, projectDir: repo });

  const stubExec: DockerExecFn = async ({ args, stdoutPath, stderrPath }) => {
    const taskId = taskIdOf(args);
    writeFileSync(stderrPath, "");
    if (taskId.startsWith("task-source")) {
      writeTaskResult(stdoutPath, { status: "complete", tests_run: 1, items: ["alpha", "beta", "gamma"] });
      return 0;
    }
    const ws = projectMountHost(args)!;
    writeFileSync(join(ws, `${taskId}.ts`), `export const child = "${taskId}";\n`);
    writeTaskResult(stdoutPath, { status: "complete", tests_run: 1, files_modified: [`${taskId}.ts`] });
    return 0;
  };

  await runNext({ runId, workflow: FANOUT, dockerExec: stubExec });
  const wave = await runNext({ runId, workflow: FANOUT, dockerExec: stubExec });
  assert.deepEqual(
    wave.completedSteps,
    ["build"],
    `the fan-out step must complete; task states: ${JSON.stringify(tasksForRun(runId).map((t) => [t.id, t.status, t.error]))}`,
  );

  const children = tasksForRun(runId).filter((t) => t.phase === "build" && t.parentId !== undefined);
  assert.equal(children.length, 3, "three siblings ran");
  const bases = new Set(children.map((c) => c.baseSha));
  assert.equal(bases.size, 1, `siblings must share ONE recorded base, got: ${[...bases].join(", ")}`);
  assert.ok([...bases][0], "and it is recorded, not null");
});

// ── AC 6: candidate identity through the existing publisher interfaces ────────

test("fg621 (AC 6): the tree the GATE observed is byte-for-byte the tree that was published", async () => {
  armWorktreeMode();
  const repo = makeRepo();
  const observedDir = tmpRoot("observed");

  // THE GATE ITSELF is the capture point. runIntegrationGate runs `npm run
  // test:unit` with cwd = the candidate worktree, so this script records the
  // commit and tree the gate ACTUALLY looked at. Comparing candidateSha to
  // publishedSha alone would be self-consistent even if the gate had observed a
  // different tree — which is precisely the failure AC 6 exists to exclude.
  writeFileSync(
    join(repo, "package.json"),
    JSON.stringify({
      name: "fg621-ac6-fixture",
      version: "0.0.0",
      private: true,
      scripts: {
        "test:unit":
          `git rev-parse HEAD > ${join(observedDir, "sha")} && git rev-parse HEAD^{tree} > ${join(observedDir, "tree")}`,
      },
    }),
  );
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "gate fixture");

  const { runId } = startRun({ workflow: SINGLE, title: "fg621 ac6", inputs: {}, projectDir: repo });
  const stubExec: DockerExecFn = async ({ args, stdoutPath, stderrPath }) => {
    const ws = projectMountHost(args)!;
    writeFileSync(stderrPath, "");
    writeFileSync(join(ws, "candidate-content.ts"), "export const shipped = true;\n");
    writeTaskResult(stdoutPath, { status: "complete", tests_run: 1, files_modified: ["candidate-content.ts"] });
    return 0;
  };

  const wave = await runNext({ runId, workflow: SINGLE, dockerExec: stubExec });
  assert.deepEqual(wave.completedSteps, ["build"], "the step must complete");

  const observedSha = readFileSync(join(observedDir, "sha"), "utf8").trim();
  const observedTree = readFileSync(join(observedDir, "tree"), "utf8").trim();
  assert.ok(observedSha, "the gate really ran against a candidate — otherwise this test is vacuous");

  const task = tasksForRun(runId).find((t) => t.phase === "build")!;
  const receipt = publicationAttemptsForTask(task.id).find((a) => a.state === "published");
  assert.ok(receipt, "a publication receipt was recorded");
  assert.equal(receipt.candidateSha, observedSha, "the recorded candidate IS the commit the gate observed");
  assert.equal(receipt.publishedSha, receipt.candidateSha, "and publication is bound to that exact candidate");

  const publishedTree = git(repo, "rev-parse", `${receipt.publishedSha}^{tree}`).trim();
  assert.equal(publishedTree, observedTree, "the published TREE is byte-for-byte the tree that passed the gate");
  assert.ok(existsSync(join(repo, "candidate-content.ts")), "and the checkout carries it");
});

test("fg621 (AC 6): a clone source is handed to the publisher WITHOUT a worktreePath — no post-fetch clone-side commit is possible", () => {
  const src = readFileSync(new URL("./runNext.ts", import.meta.url), "utf8");

  // The publisher's autoCommitSource is guarded by `if (src.worktreePath)`. For a
  // clone the two are different REPOSITORIES, so a commit there after the fetch
  // would advance only the clone's ref. Omission — not a convention — is what
  // makes that impossible.
  const sources = [...src.matchAll(/sources:\s*\[([\s\S]*?)\]/g)].map((m) => m[1]!);
  assert.ok(sources.length >= 3, `expected every publish call site to be matched, found ${sources.length}`);
  for (const block of sources) {
    assert.doesNotMatch(
      block,
      /worktreePath/,
      `a publish source in runNext.ts still carries a worktreePath:\n${block}\n` +
        "That re-opens autoCommitSource on an already-captured clone, which the FG-621 capture ordering forbids.",
    );
  }
});

// ── Provisioning order: durable state BEFORE on-disk and ref state ────────────

test("fg621: the task row NAMES the workspace before any of it is created — a crash in that window cannot leak invisibly", async () => {
  armWorktreeMode();
  const repo = makeRepo();
  const { runId } = startRun({ workflow: SINGLE, title: "fg621 provisioning order", inputs: {}, projectDir: repo });

  // Break clone creation at its very first step by putting a FILE where the
  // run's clones directory has to go, so nothing on disk and no ref is ever
  // created. Nothing sweeps the clones root by scanning it — the reaper is keyed
  // on the recorded path — so if the row were only written after creation, every
  // crash inside that window would leak a workspace no pass ever looks at again.
  mkdirSync(CLONES_DIR, { recursive: true });
  writeFileSync(join(CLONES_DIR, runId), "not a directory\n");

  let containersStarted = 0;
  const stubExec: DockerExecFn = async () => {
    containersStarted += 1;
    return 0;
  };
  await runNext({ runId, workflow: SINGLE, dockerExec: stubExec });

  const task = tasksForRun(runId).find((t) => t.phase === "build")!;
  assert.equal(task.status, "failed", `provisioning must fail; got ${task.status}: ${task.error}`);
  assert.equal(containersStarted, 0, "and no container ran");
  // The row DID name the workspace across the creation window — that is what
  // makes a crash in it recoverable. But the failure lane ran to completion here
  // and proved nothing is on disk, so it reconciles the row with the disk rather
  // than leaving a path every consumer but the reaper reads as "a workspace
  // exists here". Recorded first, created second, unrecorded when proven absent.
  assert.equal(
    existsSync(join(CLONES_DIR, runId, task.id)),
    false,
    "fixture: creation never got as far as a directory",
  );
  assert.equal(task.worktreePath, undefined, "so the row names no workspace — a path with nothing behind it is a phantom");
  assert.equal(task.baseSha, undefined, "and the base goes with it: they are the one fact");

  rmSync(join(CLONES_DIR, runId), { force: true });
});

test("fg621: a workspace that SURVIVES a failed setup keeps its row — the recorded path is the only thing that will ever find it", async () => {
  armWorktreeMode();
  const repo = makeRepo();
  const { runId } = startRun({ workflow: SINGLE, title: "fg621 surviving workspace", inputs: {}, projectDir: repo });

  // The create-only refusal: a directory already sits at this task's workspace
  // identity. createTaskClone refuses rather than reusing or force-deleting it —
  // an agent may have written to it — and the failure lane must not sweep it
  // either. Clearing the row here would strand the directory permanently: nothing
  // scans the clones root, so the recorded path is the only handle on it.
  // A pending row for the phase, so the workspace identity — and therefore the
  // directory to pre-create — is known before dispatch resolves it.
  const taskId = "task-build-fg621survivor";
  insertTask({
    id: taskId,
    runId,
    phase: "build",
    agentRole: "engineer",
    status: "pending",
    taskPackage: { taskId, runId, phase: "build", role: "engineer", inputs: {}, composedSystemPrompt: "" },
    createdAt: "2026-07-27T00:00:00Z",
  });
  const clonePath = join(CLONES_DIR, runId, taskId);
  mkdirSync(clonePath, { recursive: true });
  writeFileSync(join(clonePath, "agent-output.ts"), "export const work = 1;\n");

  let containersStarted = 0;
  const stubExec: DockerExecFn = async () => {
    containersStarted += 1;
    return 0;
  };
  await runNext({ runId, workflow: SINGLE, dockerExec: stubExec });

  const task = tasksForRun(runId).find((t) => t.phase === "build")!;
  assert.equal(task.status, "failed", `the refusal must fail the task; got ${task.status}`);
  assert.match(String(task.error), /already exists/, `the failure must be the create-only refusal, got: ${task.error}`);
  assert.equal(containersStarted, 0, "and no container ran");
  assert.equal(existsSync(join(clonePath, "agent-output.ts")), true, "the pre-existing workspace is never swept");
  assert.equal(task.worktreePath, clonePath, "and the row still names it, because something really is there");

  rmSync(join(CLONES_DIR, runId), { recursive: true, force: true });
});

// ── AC 4: WHICH receipt is the base — publish time, scoped by target ──────────

test("fg621 (AC 4): the base is the receipt that PUBLISHED last, not the one whose intent was recorded last", () => {
  const target = "local:/tmp/fg621-base#main";
  const recorded = (attemptId: string, taskId: string, t: string): void => {
    recordPublicationIntent({
      attemptId,
      projectKey: "fg621-base",
      canonicalDir: "/tmp/fg621-base",
      runId: "run-base",
      taskId,
      target: t,
      leaseTtlMs: 60_000,
    });
  };

  // `early` records its intent FIRST and publishes LAST — the shape an attempt
  // that parked and rebuilt leaves behind. Intent order names `late`'s candidate;
  // the last thing actually published is `early`'s.
  recorded("a-early", "t-early", target);
  recorded("a-late", "t-late", target);
  setPublicationClockOffsetForTest(1000);
  updatePublicationAttempt("a-late", { state: "published", publishedSha: "b".repeat(40) });
  setPublicationClockOffsetForTest(2000);
  updatePublicationAttempt("a-early", { state: "published", publishedSha: "a".repeat(40) });
  setPublicationClockOffsetForTest(0);

  assert.equal(
    latestPublishedShaForRun("run-base", target),
    "a".repeat(40),
    "ordering by intent time hands the next task a base that is not the last thing published",
  );
});

test("fg621 (AC 4): a receipt for ANOTHER target is never this target's base", () => {
  const mine = "local:/tmp/fg621-base#main";
  const theirs = "remote:origin#main";
  for (const [attemptId, taskId, target] of [
    ["a-mine", "t-mine", mine],
    ["a-theirs", "t-theirs", theirs],
  ] as Array<[string, string, string]>) {
    recordPublicationIntent({
      attemptId,
      projectKey: "fg621-base",
      canonicalDir: "/tmp/fg621-base",
      runId: "run-target",
      taskId,
      target,
      leaseTtlMs: 60_000,
    });
  }
  setPublicationClockOffsetForTest(1000);
  updatePublicationAttempt("a-mine", { state: "published", publishedSha: "c".repeat(40) });
  setPublicationClockOffsetForTest(2000);
  updatePublicationAttempt("a-theirs", { state: "published", publishedSha: "d".repeat(40) });
  setPublicationClockOffsetForTest(0);

  assert.equal(
    latestPublishedShaForRun("run-target", mine),
    "c".repeat(40),
    "the newest receipt overall landed somewhere else — basing this target's next task on it would build on a tree that never landed here",
  );
  assert.equal(latestPublishedShaForRun("run-target", theirs), "d".repeat(40), "and each target reads its own");
});
