// FG-425: the ORDER a publication is conditional on, at the dispatch layer.
//
// The ticket's step order is:
//
//     validate candidate C (tests, integration gate, reds, review) → short lock → CAS-publish C
//
// The first cut of the publisher fixed the GATE (it moved off the publish target
// and onto the candidate) but still published BEFORE the reds ran. A red-REJECTED
// candidate had therefore already reached the target — which defeats the whole
// point: a red that can only reject work that has already shipped is not a gate,
// it is a notification.
//
// Two properties here, and they are the two the build reds named:
//
//   (1) a red REJECTION publishes NOTHING. The target is provably still at the
//       base the candidate was built on.
//   (2) an AD-1 moved-base REBUILD re-runs the FULL validation set for the NEW
//       candidate — the reds included. A rebuild that re-ran only the integration
//       gate would publish a rebuilt tree that no red ever looked at.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { tasksForRun } from "../store/tasks.js";
import { allPublicationAttempts } from "../store/publications.js";
import { startRun } from "./startRun.js";
import { runNext, type DockerExecFn } from "./runNext.js";
import { gate } from "./gate.js";
import type { Workflow } from "./schema.js";
import { publishFlatAsGeneration } from "./seed-generation.testkit.js";

// A step with an AUTHORITATIVE red: a fail from it blocks the gate, which is what
// makes it a rejection of the candidate rather than an advisory note.
const WORKFLOW_WITH_AUTHORITATIVE_RED: Workflow = {
  name: "fg425-red-test",
  description: "FG-425: publication is conditional on the reds",
  review_mode: "legacy_verdict",
  inputs: [],
  steps: [
    {
      id: "build",
      agent: "engineer",
      gate: "auto",
      manual: false,
      depends_on: [],
      runtime: "fg425-red-test",
      reds: [{ agent: "red-narrow", authority: "authoritative", gate_on_verdict: true }],
    },
  ],
};

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
  ensureRuntime();
  ensureWorkflowYaml();
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

function setPlatform(p: string): void {
  Object.defineProperty(process, "platform", { value: p, configurable: true });
}

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "forge-fg425-red-"));
  tmpDirs.push(dir);
  return dir;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

// FG-621: a task workspace is a `git clone`, which inherits none of the source
// repo's LOCAL config, so a simulated agent commit must carry its own identity —
// exactly as the agent container supplies one via GIT_AUTHOR_*/GIT_COMMITTER_*.
const AGENT_IDENTITY = ["-c", "user.name=Agent", "-c", "user.email=agent@forge.test"];

function initGitRepo(dir: string): void {
  git(dir, ["init", "-b", "main"]);
  git(dir, ["config", "user.email", "test@forge.test"]);
  git(dir, ["config", "user.name", "Forge Test"]);
  writeFileSync(join(dir, "README.md"), "# test\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-m", "initial"]);
}

function ensureRuntime(): void {
  const runtimePath = join(process.env.FORGE_HOME!, "runtimes", "fg425-red-test.yml");
  mkdirSync(dirname(runtimePath), { recursive: true });
  writeFileSync(
    runtimePath,
    `name: fg425-red-test
description: FG-425 red-rejection test runtime stub
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

/** gate.ts re-loads the workflow from disk (it does not take the in-memory one),
 *  so the forced-advance test needs it installed under FORGE_HOME. */
function ensureWorkflowYaml(): void {
  const wfPath = join(process.env.FORGE_HOME!, "workflows", "fg425-red-test.yml");
  mkdirSync(dirname(wfPath), { recursive: true });
  writeFileSync(
    wfPath,
    `name: fg425-red-test
description: "FG-425: publication is conditional on the reds"
inputs: []
steps:
  - id: build
    agent: engineer
    gate: auto
    manual: false
    depends_on: []
    runtime: fg425-red-test
    reds:
      - agent: red-narrow
        authority: authoritative
        gate_on_verdict: true
`,
  );
  publishFlatAsGeneration(process.env.FORGE_HOME!);
}

function findProjectMountHost(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-v" && typeof args[i + 1] === "string") {
      const spec = args[i + 1]!;
      const [host, container] = spec.split(":");
      if (container === "/project") return host;
    }
  }
  return undefined;
}

function extractTaskId(args: string[]): string {
  const i = args.indexOf("--name");
  return i >= 0 ? (args[i + 1] ?? "").replace(/^forge-/, "") : "";
}

function writeTaskResult(stdoutPath: string, result: unknown): void {
  const dir = dirname(stdoutPath);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "result.json"), JSON.stringify(result));
  writeFileSync(stdoutPath, "stub stdout");
  writeFileSync(join(dir, "container.stderr.log"), "");
}

const FAIL_VERDICT = {
  status: "complete",
  tests_run: 1,
  verdict: "fail",
  confidence: 0.9,
  findings: [
    { severity: "high", summary: "the candidate is wrong", evidence: "e", hypothesis: "h" },
  ],
};

const PASS_VERDICT = { status: "complete", tests_run: 1, verdict: "pass", confidence: 1, findings: [] };

// ─── (1) a red REJECTION publishes nothing ────────────────────────────────────

test("FG-425 (finding 1): a red that REJECTS the candidate publishes NOTHING — the target is provably still at baseSha", async () => {
  setPlatform("darwin");
  process.env.FORGE_WORKTREES = "1";
  process.env.FORGE_WORKTREE_IGNORE_DIRTY = "1";

  const repo = makeTmpDir();
  initGitRepo(repo);
  const baseSha = git(repo, ["rev-parse", "HEAD"]);

  let redSawCandidate = false;
  let targetAtRedTime = "";

  const stubExec: DockerExecFn = async ({ args, stdoutPath, stderrPath }) => {
    const taskId = extractTaskId(args);
    const mount = findProjectMountHost(args);
    writeFileSync(stderrPath, "");

    if (taskId.startsWith("task-red-")) {
      // The red reviews the CANDIDATE, and the target has not moved yet.
      redSawCandidate = existsSync(join(mount!, "rejected-work.ts"));
      targetAtRedTime = git(repo, ["rev-parse", "HEAD"]);
      writeTaskResult(stdoutPath, FAIL_VERDICT);
      return 0;
    }
    // The primary commits work on its task branch.
    writeFileSync(join(mount!, "rejected-work.ts"), "export const bad = 1;\n");
    git(mount!, ["add", "."]);
    git(mount!, [...AGENT_IDENTITY, "commit", "-m", "primary output"]);
    writeTaskResult(stdoutPath, { status: "complete", tests_run: 1, files_modified: ["rejected-work.ts"] });
    return 0;
  };

  const { runId } = startRun({
    workflow: WORKFLOW_WITH_AUTHORITATIVE_RED,
    title: "fg425 red rejection",
    inputs: {},
    projectDir: repo,
  });

  await runNext({ runId, workflow: WORKFLOW_WITH_AUTHORITATIVE_RED, dockerExec: stubExec });

  // The red DID review the candidate — the reds are inside the validation set.
  assert.ok(redSawCandidate, "the red must have reviewed the candidate (its /project mount carries the work)");
  assert.equal(targetAtRedTime, baseSha, "the target must still be at baseSha WHILE the red is deciding");

  const primary = tasksForRun(runId).find((t) => t.phase === "build" && t.parentId === undefined);
  assert.equal(primary!.status, "blocked_by_red", "an authoritative red fail blocks the task");

  // ── THE ASSERTION THIS TEST EXISTS FOR ──────────────────────────────────────
  assert.equal(
    git(repo, ["rev-parse", "HEAD"]),
    baseSha,
    "the target ref must be UNCHANGED after a red rejection — a rejected candidate must never reach the target. " +
      "Publishing before the reds ran is the FG-425 defect: it makes a red a notification, not a gate.",
  );
  assert.equal(
    existsSync(join(repo, "rejected-work.ts")),
    false,
    "the rejected candidate's file must NOT be on the publish target",
  );

  // The durable record agrees: the attempt failed validation and published nothing.
  const attempts = allPublicationAttempts();
  assert.equal(attempts.length, 1, "exactly one publication attempt was made");
  assert.equal(attempts[0]!.state, "failed", "the attempt did not publish");
  assert.equal(attempts[0]!.publishedSha, undefined, "and nothing is recorded as published");
});

// ─── (2) force-advancing over the rejection DOES publish ──────────────────────
//
// The other half of the contract, and the reason the ordering fix is safe: because
// a red-rejected candidate is now UNPUBLISHED, "gate advance --force" — the human
// overriding the red — has to actually publish it. Otherwise the fix would silently
// drop the work instead of shipping it.

test("FG-425: force-advancing a blocked_by_red primary PUBLISHES the work it was holding back", async () => {
  setPlatform("darwin");
  process.env.FORGE_WORKTREES = "1";
  process.env.FORGE_WORKTREE_IGNORE_DIRTY = "1";

  const repo = makeTmpDir();
  initGitRepo(repo);
  const baseSha = git(repo, ["rev-parse", "HEAD"]);

  let execCount = 0;
  const stubExec: DockerExecFn = async ({ args, stdoutPath, stderrPath }) => {
    execCount++;
    const taskId = extractTaskId(args);
    const mount = findProjectMountHost(args);
    writeFileSync(stderrPath, "");
    if (taskId.startsWith("task-red-")) {
      writeTaskResult(stdoutPath, FAIL_VERDICT);
      return 0;
    }
    writeFileSync(join(mount!, "overridden-work.ts"), "export const x = 1;\n");
    git(mount!, ["add", "."]);
    git(mount!, [...AGENT_IDENTITY, "commit", "-m", "primary output"]);
    writeTaskResult(stdoutPath, { status: "complete", tests_run: 1, files_modified: ["overridden-work.ts"] });
    return 0;
  };

  const { runId } = startRun({
    workflow: WORKFLOW_WITH_AUTHORITATIVE_RED,
    title: "fg425 forced advance",
    inputs: {},
    projectDir: repo,
  });

  await runNext({ runId, workflow: WORKFLOW_WITH_AUTHORITATIVE_RED, dockerExec: stubExec });
  const primary = tasksForRun(runId).find((t) => t.phase === "build" && t.parentId === undefined)!;
  assert.equal(primary.status, "blocked_by_red");
  assert.equal(git(repo, ["rev-parse", "HEAD"]), baseSha, "nothing published while blocked");

  // The human overrides the red, with the rationale the gate requires.
  await gate(primary.id, "advance", "overriding the red: the finding is a false positive", { force: true });
  const afterGate = tasksForRun(runId).find((t) => t.id === primary.id)!;
  assert.equal(afterGate.status, "pending", "a forced advance re-enters dispatch so the work can be published");
  assert.strictEqual(afterGate.taskPackage?.inputs?.["gateForced"], true);

  const execsBefore = execCount;
  await runNext({ runId, workflow: WORKFLOW_WITH_AUTHORITATIVE_RED, dockerExec: stubExec });

  assert.equal(execCount, execsBefore, "the re-entry must not re-dispatch the agent or the reds — it only publishes");

  const final = tasksForRun(runId).find((t) => t.id === primary.id)!;
  assert.equal(final.status, "complete", "the forced task completes");
  assert.notEqual(git(repo, ["rev-parse", "HEAD"]), baseSha, "the target advanced");
  assert.ok(
    existsSync(join(repo, "overridden-work.ts")),
    "the human's forced advance must PUBLISH the work — otherwise the ordering fix silently drops it",
  );

  const published = allPublicationAttempts().filter((a) => a.state === "published");
  assert.equal(published.length, 1, "the re-entry published exactly once");
  assert.equal(published[0]!.publishedSha, published[0]!.candidateSha, "AD-6");
  assert.equal(git(repo, ["rev-parse", "HEAD"]), published[0]!.publishedSha);
});

// ─── (3) a moved-base rebuild re-runs the REDS, not just the gate ─────────────

test("FG-425 (finding 2): an AD-1 moved-base rebuild re-runs the REDS for the NEW candidate, not just the integration gate", async () => {
  setPlatform("darwin");
  process.env.FORGE_WORKTREES = "1";
  process.env.FORGE_WORKTREE_IGNORE_DIRTY = "1";

  const repo = makeTmpDir();
  initGitRepo(repo);

  // Each red invocation records the candidate it was asked to review.
  const redReviewed: { candidateSha: string; sawExternalCommit: boolean }[] = [];
  let movedBaseOnce = false;

  const stubExec: DockerExecFn = async ({ args, stdoutPath, stderrPath }) => {
    const taskId = extractTaskId(args);
    const mount = findProjectMountHost(args);
    writeFileSync(stderrPath, "");

    if (taskId.startsWith("task-red-")) {
      redReviewed.push({
        candidateSha: git(mount!, ["rev-parse", "HEAD"]),
        // The rebuilt candidate sits on the EXTERNAL writer's commit; the first
        // candidate cannot possibly contain it.
        sawExternalCommit: existsSync(join(mount!, "external.ts")),
      });

      // The FIRST red review happens on the first candidate. While it is running,
      // an EXTERNAL writer moves the target — so the CAS below will lose and the
      // publisher must rebuild on the new base (AD-1) and RE-VALIDATE.
      if (!movedBaseOnce) {
        movedBaseOnce = true;
        writeFileSync(join(repo, "external.ts"), "export const external = 1;\n");
        git(repo, ["add", "."]);
        git(repo, ["commit", "-m", "an external writer moves the target"]);
      }
      writeTaskResult(stdoutPath, PASS_VERDICT);
      return 0;
    }

    writeFileSync(join(mount!, "work.ts"), "export const work = 1;\n");
    git(mount!, ["add", "."]);
    git(mount!, [...AGENT_IDENTITY, "commit", "-m", "primary output"]);
    writeTaskResult(stdoutPath, { status: "complete", tests_run: 1, files_modified: ["work.ts"] });
    return 0;
  };

  const { runId } = startRun({
    workflow: WORKFLOW_WITH_AUTHORITATIVE_RED,
    title: "fg425 rebuild revalidates",
    inputs: {},
    projectDir: repo,
  });

  await runNext({ runId, workflow: WORKFLOW_WITH_AUTHORITATIVE_RED, dockerExec: stubExec });

  const primary = tasksForRun(runId).find((t) => t.phase === "build" && t.parentId === undefined)!;
  assert.equal(primary.status, "complete", "the rebuilt candidate validated and published");

  const attempt = allPublicationAttempts()[0]!;
  assert.equal(attempt.state, "published");
  assert.equal(attempt.rebuildCount, 1, "the base moved once, so exactly one AD-1 rebuild happened");

  // ── THE ASSERTION THIS TEST EXISTS FOR ──────────────────────────────────────
  assert.equal(
    redReviewed.length,
    2,
    "the reds must run TWICE — once for the original candidate and again for the REBUILT one. " +
      "A rebuild that re-ran only the integration gate would publish a tree whose reds never saw it.",
  );
  assert.equal(redReviewed[0]!.sawExternalCommit, false, "the first candidate predates the external writer's commit");
  assert.equal(
    redReviewed[1]!.sawExternalCommit,
    true,
    "the SECOND red review must be of the REBUILT candidate — the one sitting on the new base",
  );
  assert.notEqual(redReviewed[0]!.candidateSha, redReviewed[1]!.candidateSha, "two genuinely different candidates");

  // And what landed is the candidate the second red actually reviewed (AD-6).
  assert.equal(
    attempt.candidateSha,
    redReviewed[1]!.candidateSha,
    "the published commit is the one the reds validated on the new base",
  );
  assert.equal(attempt.publishedSha, attempt.candidateSha, "AD-6");
  assert.equal(git(repo, ["rev-parse", "HEAD"]), attempt.publishedSha);
  // The external writer's commit survives — the publish fast-forwards it, never over it.
  assert.ok(existsSync(join(repo, "external.ts")), "the external writer's commit is preserved");
  assert.ok(existsSync(join(repo, "work.ts")), "and the agent's work is published on top of it");
});
