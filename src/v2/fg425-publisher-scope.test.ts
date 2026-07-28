// FG-425: the scope boundary, and the mechanical completion checks.
//
// Two jobs here.
//
// (1) THE NEGATIVE SCOPE TEST. The publisher is worktree-mode-scoped
//     (FORGE_WORKTREES=1, opt-in). A non-worktree run bind-mounts the shared
//     project dir, does no merge, and runs no gate — and must therefore touch NO
//     lane, NO publication lock, and NO gate. This is pinned behaviorally (drive a
//     real non-worktree run; assert the publication tables stay empty) so a later
//     refactor cannot quietly route the default path into the lane.
//
// (2) THE MECHANICAL COMPLETION CHECKS. Cheap source-level assertions that catch
//     the regressions a behavioral test would miss — in particular a FIFTH
//     merge-then-gate site added later, which is exactly how this defect got to
//     four sites in the first place.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { publishFlatAsGeneration } from "./seed-generation.testkit.js";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { allLaneEntries, allPublicationAttempts, publicationMutexHolder } from "../store/publications.js";
import { projectIdentity } from "./project-identity.js";
import { startRun } from "./startRun.js";
import { runNext, type DockerExecFn } from "./runNext.js";
import type { Workflow } from "./schema.js";

const SRC_V2 = dirname(new URL(import.meta.url).pathname);

function src(name: string): string {
  return readFileSync(join(SRC_V2, name), "utf8");
}

/** Source with comments stripped. Every guard below scans for CODE: the prose in
 *  these files deliberately NAMES the machinery it is refusing to use (the FG-353
 *  helpers, the process-supervision layer, `db.transaction(fn).immediate()`), and
 *  must stay free to do so — a guard that fires on a comment would push the next
 *  maintainer into deleting the explanation rather than obeying it. */
function code(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
}

// ── (1) the negative scope test ───────────────────────────────────────────────

const WORKFLOW: Workflow = {
  name: "fg425-scope-test",
  description: "FG-425 scope: a non-worktree run must not touch the publisher",
  inputs: [],
  steps: [
    {
      id: "build",
      agent: "engineer",
      gate: "auto",
      manual: false,
      depends_on: [],
      runtime: "fg425-scope-test",
      reds: [],
    },
  ],
};

let db: DatabaseInstance;
let prev: DatabaseInstance | null;
const tmpDirs: string[] = [];
const ENV_VARS = ["FORGE_WORKTREES", "FORGE_NO_WORKTREES", "ANTHROPIC_API_KEY"] as const;
const savedEnv: Partial<Record<(typeof ENV_VARS)[number], string>> = {};

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
  for (const k of ENV_VARS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  // FG-345: isolation is default-ON and the default is platform-dependent, so
  // clearing FORGE_WORKTREES no longer means "off". This file's subject is the
  // NON-worktree lane; say so explicitly or the outcome follows process.platform.
  process.env.FORGE_WORKTREES = "0";

  const runtimePath = join(process.env.FORGE_HOME!, "runtimes", "fg425-scope-test.yml");
  mkdirSync(dirname(runtimePath), { recursive: true });
  writeFileSync(
    runtimePath,
    `name: fg425-scope-test
description: FG-425 scope test runtime stub
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
  // FG-583: dispatch reads only a published generation — publish the flat runtime.
  publishFlatAsGeneration(process.env.FORGE_HOME!);
});

afterEach(() => {
  setDbForTest(prev as DatabaseInstance);
  db.close();
  for (const k of ENV_VARS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k] as string;
  }
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("FG-425 (SCOPE): worktree mode OFF routes through NO lane, NO publication lock, and NO gate", async () => {
  // FORGE_WORKTREES is pinned off in beforeEach — this is the bind-mount lane.
  const projectDir = mkdtempSync(join(tmpdir(), "fg425-scope-"));
  tmpDirs.push(projectDir);

  const { runId } = startRun({
    workflow: WORKFLOW,
    title: "fg425 scope",
    inputs: {},
    projectDir,
  });

  const stubExec: DockerExecFn = async ({ stdoutPath, stderrPath }) => {
    const dir = dirname(stdoutPath);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "result.json"), JSON.stringify({ status: "complete", tests_run: 1, files_modified: [] }));
    writeFileSync(stdoutPath, "stub stdout");
    writeFileSync(stderrPath, "");
    return 0;
  };

  const wave = await runNext({ runId, workflow: WORKFLOW, dockerExec: stubExec });
  assert.deepEqual(wave.completedSteps, ["build"], "the non-worktree path still completes normally");
  assert.deepEqual(wave.failedSteps, []);

  // The whole publisher is untouched. Not "used and cleaned up" — never entered.
  assert.deepEqual(allPublicationAttempts(), [], "a non-worktree run must record NO publication attempt");
  assert.deepEqual(allLaneEntries(), [], "…and must never enqueue on the lane");
  assert.equal(
    publicationMutexHolder(projectIdentity(projectDir).key),
    undefined,
    "…and must never take the publication mutex",
  );
});

// ── (2) mechanical completion checks ──────────────────────────────────────────

// The defect was "the gate runs against the publish target". The fix is only
// complete if NO caller can still do that. runNext.ts is where all four sites
// lived; the check is that it no longer reaches the gate at all — the gate is now
// reachable only through the publisher, which only ever points it at a candidate
// worktree. A fifth site added later re-imports it, and this fails.
test("FG-425 (COMPLETION): runNext.ts no longer invokes the integration gate — the gate is reachable only via the publisher, against a candidate", () => {
  const runNextSrc = src("runNext.ts");

  assert.doesNotMatch(
    runNextSrc,
    /\brunIntegrationGate\s*\(/,
    "runNext.ts still CALLS runIntegrationGate. Every gate invocation must go through the publisher, which runs it " +
      "against the per-attempt candidate worktree — never against the publish target.",
  );
  assert.doesNotMatch(
    runNextSrc,
    /from\s+"\.\/integration-gate\.js"/,
    "runNext.ts still IMPORTS the integration gate — a fifth merge-then-gate site is one edit away.",
  );
  assert.doesNotMatch(
    runNextSrc,
    /\bmergeIntegrationBranchToHead\s*\(|\bmergeWorktreeBranch\s*\(/,
    "runNext.ts still merges directly to the publish target. All four former sites must route through publishIntegration().",
  );

  // And the gate the publisher runs is pointed at the candidate, not the target.
  const publisherSrc = src("integration-publisher.ts");
  assert.match(publisherSrc, /runIntegrationGate\(dir\)/, "the publisher's default validation gates a candidate dir");
});

// AD-7, as a diff-level guard. The abandoned design's whole process-supervision
// layer must not creep back in through the lane's "is that holder really dead?"
// question — which is precisely the question this design is built never to ask.
test("FG-425 (AD-7): no PID probe, process-group signal, reap, or liveness classification anywhere in the publisher", () => {
  const files = [
    "integration-publisher.ts",
    "publication-lane.ts",
    "publication-target.ts",
    "project-identity.ts",
  ];
  const banned: { pattern: RegExp; what: string }[] = [
    { pattern: /process\.kill\s*\(/, what: "a process signal" },
    { pattern: /\bpidAlive\b|\bisAlive\b/, what: "a pid-liveness probe" },
    { pattern: /liveRunLockHolder/, what: "the fixed-staleness lock holder probe (see the ADR: an explicit NEGATIVE model)" },
    { pattern: /\bpgid\b|process-group|setsid|detached:\s*true/i, what: "a process-group sidecar" },
    { pattern: /\breap\w*\s*\(/i, what: "a reaper" },
    { pattern: /leaderToken|LeaderProbe|leaderCommandOf|GateGroupRecord/, what: "the abandoned leader-nonce machinery" },
  ];
  for (const file of files) {
    const body = code(src(file));
    for (const { pattern, what } of banned) {
      assert.doesNotMatch(
        body,
        pattern,
        `${file} contains ${what}. AD-7 is binding: a crashed attempt is ABANDONED and any retry uses a NEW worktree. ` +
          `An orphaned gate process group is a resource LEAK (FG-356's problem), never a correctness gate. ` +
          `If you are writing code to determine whether another process is really dead, re-read the ADR.`,
      );
    }
  }
});

// AD-4: the publisher must not route through the FG-353 prune-then-create helpers.
// They force-delete the worktree at a deterministic (runId, parentTaskId) path —
// which, on an AD-1 rebuild, would destroy the very evidence AD-1 requires be kept.
test("FG-425 (AD-4): the publisher does not use the FG-353 prune-then-create helpers, and they are unmodified", () => {
  const publisherSrc = code(src("integration-publisher.ts"));
  assert.doesNotMatch(
    publisherSrc,
    /createIntegrationWorktree|integrationWorktreeDir/,
    "the publisher must NOT route through the FG-353 helpers: they are keyed on (runId, parentTaskId) and are " +
      "PRUNE-THEN-CREATE, so an AD-1 rebuild through them would force-delete the first attempt's tree — the evidence " +
      "a publish_base_churn park is required to preserve.",
  );
  assert.match(
    publisherSrc,
    /publicationWorktreeDir/,
    "the publisher keys its worktree on the ATTEMPT (and its rebuild ordinal), per AD-4",
  );

  // The helpers themselves keep their prune-then-create behavior for the fan-out
  // child-merge role, which is a different job with a different contract.
  const lifecycle = src("worktree-lifecycle.ts");
  assert.match(lifecycle, /Prune-then-create for retry safety/, "the FG-353 helper's contract is unchanged");
});

// FG-548's shape: the lane is the highest-contention cross-process write path in
// the system. A deferred txn that reads first and upgrades to a writer mid-flight
// is exactly the SQLITE_BUSY failure that ticket is about.
test("FG-425: every lane/attempt mutation takes its write lock IMMEDIATELY (BEGIN IMMEDIATE), never a deferred upgrade", () => {
  const store = code(readFileSync(join(SRC_V2, "..", "store", "publications.ts"), "utf8"));

  const transactions = [...store.matchAll(/db\.transaction\(/g)];
  const immediates = [...store.matchAll(/\}\)\.immediate\(\)/g)];
  assert.ok(transactions.length > 0, "the store must actually use transactions");
  assert.equal(
    transactions.length,
    immediates.length,
    `${transactions.length} db.transaction(...) blocks but only ${immediates.length} .immediate() calls — a deferred ` +
      "write txn on the lane is FG-548's SQLITE_BUSY shape. Every mutation here must BEGIN IMMEDIATE.",
  );
});
