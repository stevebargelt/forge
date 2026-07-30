// FG-425 corrective (VERIFY): the publication failure kinds, through the PRODUCTION
// classification path — not the mapper in isolation.
//
// The chain a real operator's failure travels, end to end, is four hops:
//
//   publishIntegration returns a PublishOutcome
//     → runNext's publicationFailureKind() maps it to a FailureKind
//       → failTask writes a DURABLE task.failed event carrying failure_kind
//         → classifyFailureKind() (campaign policy) reads that kind off the event
//           and decides whether the whole campaign holds
//
// Every existing test covers ONE hop: the publisher suites assert the PublishOutcome,
// and the failure-policy suite asserts the FailureKind→BlockerKind table. Nothing
// asserts that the outcome a real publication actually produces reaches the table as
// the kind the table has an entry for. A publisher that returned `refused` where the
// mapper expected `parked` — or a park reason the campaign policy has no row for —
// would pass both halves and still route the operator to the wrong blocker.
//
// So each test here drives a REAL run through runNext against a REAL git target, makes
// the publication fail the way the ticket names, and then reads the failure kind back
// OFF THE DURABLE EVENT — the same read path `forge show`, `forge watch` and the
// campaign use — before asking the campaign policy what it means.
//
//   dirty_publish_target → git_state   (AD-3, refused before any mutation)
//   publish_base_churn   → git_state   (AD-1's bound, an external writer)
//   publication_refused  → git_state   (the checkout could not be applied; rolled back)
//   lane_taken_over      → scope       (the lane WORKING — scoped to one item)

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { getDb, makeInMemoryDb, setDbForTest } from "../store/db.js";
import { tasksForRun } from "../store/tasks.js";
import { allPublicationAttempts, laneForProject } from "../store/publications.js";
import { failureKindForTask } from "./failure-kind.js";
import { classifyFailureKind } from "../campaign/policy.js";
import { projectIdentity } from "./project-identity.js";
import { startRun } from "./startRun.js";
import { runNext, type DockerExecFn } from "./runNext.js";
import type { Workflow } from "./schema.js";
import { publishFlatAsGeneration } from "./seed-generation.testkit.js";

// An authoritative red gives this file a hook INSIDE the publisher's validation span:
// the red runs against the candidate, in the lane turn, before the publication window.
// That is the only place a test can act on the world the way the ticket's races do —
// an external writer moving the target, a lane lease lapsing — through the real path.
const WORKFLOW: Workflow = {
  name: "fg425-kinds-test",
  description: "FG-425: publication failure kinds through the real dispatch path",
  review_mode: "legacy_verdict",
  inputs: [],
  steps: [
    {
      id: "build",
      agent: "engineer",
      gate: "auto",
      manual: false,
      depends_on: [],
      runtime: "fg425-kinds-test",
      reds: [{ agent: "red-narrow", authority: "authoritative", gate_on_verdict: true }],
    },
  ],
};

const PASS_VERDICT = { status: "complete", tests_run: 1, verdict: "pass", confidence: 1, findings: [] };

let db: DatabaseInstance;
let prev: DatabaseInstance | null;
const tmpDirs: string[] = [];
const readOnly: string[] = [];

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
  process.env.FORGE_WORKTREES = "1";
  process.env.FORGE_WORKTREE_IGNORE_DIRTY = "1";
  setPlatform("darwin");
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
  for (const d of readOnly.splice(0)) {
    try { chmodSync(d, 0o700); } catch { /* already gone */ }
  }
  for (const dir of tmpDirs.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

function setPlatform(p: string): void {
  Object.defineProperty(process, "platform", { value: p, configurable: true });
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

// FG-621: a task workspace is a `git clone`, which inherits none of the source
// repo's LOCAL config, so a simulated agent commit must carry its own identity —
// exactly as the agent container supplies one via GIT_AUTHOR_*/GIT_COMMITTER_*.
const AGENT_IDENTITY = ["-c", "user.name=Agent", "-c", "user.email=agent@forge.test"];

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "fg425-kinds-"));
  tmpDirs.push(dir);
  git(dir, ["init", "-b", "main"]);
  git(dir, ["config", "user.email", "test@forge.test"]);
  git(dir, ["config", "user.name", "Forge Test"]);
  writeFileSync(join(dir, "README.md"), "# test\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-q", "-m", "initial"]);
  return dir;
}

/** An EXTERNAL writer pushing to the target mid-run — the thing publish_base_churn
 *  exists to name. A real commit on the target's checked-out branch. */
function externalCommit(dir: string, file: string): string {
  writeFileSync(join(dir, file), "an external writer's commit\n");
  git(dir, ["add", file]);
  git(dir, ["commit", "-q", "-m", `external: ${file}`]);
  return git(dir, ["rev-parse", "HEAD"]);
}

function ensureRuntime(): void {
  const runtimePath = join(process.env.FORGE_HOME!, "runtimes", "fg425-kinds-test.yml");
  mkdirSync(dirname(runtimePath), { recursive: true });
  writeFileSync(
    runtimePath,
    `name: fg425-kinds-test
description: FG-425 failure-kind test runtime stub
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

function findProjectMountHost(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-v" && typeof args[i + 1] === "string") {
      const [host, container] = args[i + 1]!.split(":");
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

/** The agent: commits `file` on its task branch. `onRed` fires when the red reviews
 *  the candidate — INSIDE the publisher's validation span, in its lane turn, before
 *  the publication window opens. */
function stubExec(file: string, onRed?: (n: number) => void): DockerExecFn {
  let reds = 0;
  return async ({ args, stdoutPath, stderrPath }) => {
    const taskId = extractTaskId(args);
    const mount = findProjectMountHost(args)!;
    writeFileSync(stderrPath, "");

    if (taskId.startsWith("task-red-")) {
      onRed?.(++reds);
      writeTaskResult(stdoutPath, PASS_VERDICT);
      return 0;
    }
    mkdirSync(dirname(join(mount, file)), { recursive: true });
    writeFileSync(join(mount, file), "the agent's output\n");
    git(mount, ["add", "."]);
    git(mount, [...AGENT_IDENTITY, "commit", "-q", "-m", "primary output"]);
    writeTaskResult(stdoutPath, { status: "complete", tests_run: 1, files_modified: [file] });
    return 0;
  };
}

/** The publication's failure, read back the way the operator's tooling reads it: off
 *  the DURABLE task.failed event, then through the campaign's blocker classification.
 *  Nothing here inspects the PublishOutcome — that is the point. */
function durableFailureOf(runId: string): { kind: string | undefined; blocker: string } {
  const primary = tasksForRun(runId).find((t) => t.phase === "build" && t.parentId === undefined)!;
  const kind = failureKindForTask(primary.id);
  return { kind, blocker: classifyFailureKind(kind) };
}

// ─── dirty_publish_target → git_state ─────────────────────────────────────────

test("FG-425 (AC3): an untracked file/directory collision reaches the operator as `dirty_publish_target` → git_state, with the target ref unmoved", async () => {
  const repo = makeRepo();
  const base = git(repo, ["rev-parse", "HEAD"]);

  // The operator's untracked FILE sits where the candidate needs a DIRECTORY — the
  // prefix shape exact-equality used to miss, which reached the target as a post-CAS
  // checkout failure instead of AD-3's named blocker.
  writeFileSync(join(repo, "conf"), "the operator's UNTRACKED note — never destroy this\n");

  const { runId } = startRun({ workflow: WORKFLOW, title: "fg425 dirty", inputs: {}, projectDir: repo });
  await runNext({ runId, workflow: WORKFLOW, dockerExec: stubExec("conf/settings.json") });

  const { kind, blocker } = durableFailureOf(runId);
  assert.equal(
    kind,
    "dirty_publish_target",
    "the AD-3 park must reach the durable event as `dirty_publish_target` — the named blocker with the remediation " +
      "that actually clears it (commit/move the file), not a generic publication refusal",
  );
  assert.equal(
    blocker,
    "git_state",
    "and the campaign must classify it git_state: the dirt is in the SHARED publish target, so every remaining " +
      "item would validate a full candidate and be refused at exactly the same place",
  );

  assert.equal(git(repo, ["rev-parse", "refs/heads/main"]), base, "and the target ref never moved");
  assert.equal(
    execFileSync("cat", [join(repo, "conf")], { encoding: "utf8" }),
    "the operator's UNTRACKED note — never destroy this\n",
    "with the operator's untracked file byte-for-byte intact",
  );
  const attempt = allPublicationAttempts()[0]!;
  assert.equal(attempt.state, "parked");
  assert.equal(attempt.parkReason, "dirty_publish_target", "and the durable publication record agrees");
});

// ─── publish_base_churn → git_state ───────────────────────────────────────────

test("FG-425 (AD-1): an EXTERNAL writer moving the target twice reaches the operator as `publish_base_churn` → git_state, with nothing unvalidated published", async () => {
  const repo = makeRepo();

  // The red reviews each candidate. Every time it does, an external writer lands a
  // commit on the target — so the CAS finds the base moved, forge rebuilds on the new
  // base (AD-1), re-validates, and finds it moved AGAIN. Two is the bound: park.
  const exec = stubExec("agent-work.ts", (n) => { externalCommit(repo, `external-${n}.txt`); });

  const { runId } = startRun({ workflow: WORKFLOW, title: "fg425 churn", inputs: {}, projectDir: repo });
  await runNext({ runId, workflow: WORKFLOW, dockerExec: exec });

  const { kind, blocker } = durableFailureOf(runId);
  assert.equal(
    kind,
    "publish_base_churn",
    "AD-1's bound must reach the operator as `publish_base_churn` — the kind whose advice is FIND THE OTHER " +
      "WRITER, never 'raise the rebuild bound'",
  );
  assert.equal(blocker, "git_state", "and it holds the campaign: the contention is on the shared target");

  assert.equal(
    existsSync(join(repo, "agent-work.ts")),
    false,
    "and NOTHING was published: a candidate validated against a base the target no longer carries must never land",
  );
  const attempt = allPublicationAttempts()[0]!;
  assert.equal(attempt.state, "parked");
  assert.equal(attempt.parkReason, "publish_base_churn");
  assert.equal(attempt.publishedSha, undefined, "the record claims no publication");
  assert.equal(attempt.rebuildCount, 1, "and it rebuilt exactly once before parking (AD-1: two validations, max)");
});

// ─── publication_refused → git_state ──────────────────────────────────────────

test("FG-425: a checkout that cannot be applied reaches the operator as `publication_refused` → git_state, with the ref rolled back", async () => {
  const repo = makeRepo();

  // A tracked directory the operator has made read-only. AD-3's preflight cannot see
  // this — the tree is clean and there are no untracked files — so the ref advances
  // and `read-tree -m -u` fails on the far side of the CAS. The publisher still owns
  // the window, so it undoes its own ref advance by CAS and refuses.
  mkdirSync(join(repo, "locked"), { recursive: true });
  writeFileSync(join(repo, "locked", "keep.txt"), "tracked\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-q", "-m", "tracked dir"]);
  const base = git(repo, ["rev-parse", "HEAD"]);
  chmodSync(join(repo, "locked"), 0o500);
  readOnly.push(join(repo, "locked"));

  const { runId } = startRun({ workflow: WORKFLOW, title: "fg425 refused", inputs: {}, projectDir: repo });
  await runNext({ runId, workflow: WORKFLOW, dockerExec: stubExec("locked/added.ts") });

  const { kind, blocker } = durableFailureOf(runId);
  assert.equal(
    kind,
    "publication_refused",
    "a refusal from inside the window must reach the operator as `publication_refused`, whose contract is 'nothing " +
      "was published; the target is unchanged'",
  );
  assert.equal(blocker, "git_state", "and the campaign holds on it — the target's state is what forge cannot pass");

  assert.equal(
    git(repo, ["rev-parse", "refs/heads/main"]),
    base,
    "AND THE CONTRACT HOLDS: the ref advance was ROLLED BACK by CAS. `publication_refused` promising an unchanged " +
      "target while the ref carried a half-published candidate would be a lie the next AD-3 pre-check pays for.",
  );
  assert.equal(
    git(repo, ["status", "--porcelain"]),
    "",
    "the target is byte-for-byte where it started — nothing published, nothing staged, nothing to clean up",
  );
  const attempt = allPublicationAttempts()[0]!;
  assert.equal(attempt.state, "failed");
  assert.equal(attempt.publishedSha, undefined, "and the record claims no publication");
});

// ─── lane_taken_over → scope ──────────────────────────────────────────────────

test("FG-425 (AD-2/AD-7): a lane owner stepped past reaches the operator as `lane_taken_over` → scope — it does NOT hold the campaign", async () => {
  const repo = makeRepo();
  const base = git(repo, ["rev-parse", "HEAD"]);
  const key = projectIdentity(repo).key;

  // While our attempt is validating its candidate (the red is reviewing it), its lane
  // lease lapses and a later attempt steps past it — the durable end-state a takeover
  // leaves. AD-7: a timestamp ran out; nothing was probed, signalled, or reaped.
  const exec = stubExec("agent-work.ts", () => {
    const entry = laneForProject(key)[0];
    assert.ok(entry, "setup: the publisher must be holding a lane entry while its candidate validates");
    getDb().prepare(`UPDATE publication_lane SET state = 'abandoned' WHERE attempt_id = ?`).run(entry.attemptId);
  });

  const { runId } = startRun({ workflow: WORKFLOW, title: "fg425 lane", inputs: {}, projectDir: repo });
  await runNext({ runId, workflow: WORKFLOW, dockerExec: exec });

  const { kind, blocker } = durableFailureOf(runId);
  assert.equal(
    kind,
    "lane_taken_over",
    "a taken-over owner must reach the operator as `lane_taken_over` — a NAMED terminal outcome (no TypeError, no " +
      "hang), whose remedy is simply to retry: a retry enqueues a NEW attempt with a fresh worktree",
  );
  assert.equal(
    blocker,
    "scope",
    "and it must NOT hold the campaign. This is the lane WORKING, not a fault: nothing was published, the target " +
      "is untouched, and no other item is impaired. Pausing the whole campaign for it would be a self-inflicted stall.",
  );

  assert.equal(git(repo, ["rev-parse", "refs/heads/main"]), base, "nothing was published — the target is untouched");
  assert.equal(git(repo, ["status", "--porcelain"]), "", "and clean");
  const attempt = allPublicationAttempts()[0]!;
  assert.equal(attempt.state, "parked");
  assert.equal(attempt.parkReason, "lane_taken_over");
  assert.equal(attempt.publishedSha, undefined);
});
