// FG-524: the validation contract (FG-523) reaches the fanout implementer-child
// completion seam — via a PARENT-HOLD, not a child-hold.
//
// A fanout implementer CHILD finalizes through markTaskComplete, not
// finalizePrimary, so FG-523's holdIfValidationContractFails never sees it. This
// suite drives the REAL dispatchFanoutStep (through runNext) with a child that
// returns `status: complete` and NO tests_run and NO no_validation_reason waiver.
// The single evaluator (evaluateValidationContract) is consulted once per completed
// child; when it holds, the PARENT lands awaiting_gate with the SAME named-reason
// semantics FG-523 gives a primary — and the run does not wedge.
//
// The recovery verb is `forge gate <parentId> --advance`. In worktree mode the held
// parent has a captured-but-unpublished integration branch, so the advance must
// REPUBLISH the reused children (running the reds now, inside the publisher's
// validation span) rather than complete in place and drop the branch (the
// FG-353/FG-425 publish-on-advance invariant).
//
// Controls:
//   - positive: a compliant child (tests_run > 0) and a waivered child complete and
//     publish normally — no hold.
//   - non-implementer: a `docs` child returning complete-without-tests_run does NOT
//     hold the parent (the evaluator returns held:false for non-implementer roles).

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { tasksForRun } from "../store/tasks.js";
import { eventsForTask } from "../store/events.js";
import { allPublicationAttempts } from "../store/publications.js";
import { verdictsForTask } from "../store/verdicts.js";
import { startRun } from "./startRun.js";
import { runNext, type DockerExecFn } from "./runNext.js";
import { gate } from "./gate.js";
import { performCancel } from "../cli/commands/cancel.js";
import { integrationWorktreeDir } from "../util/paths.js";
import { integrationBranchName, integrationBranchExists } from "./worktree-lifecycle.js";
import { failureKindForTask } from "./failure-kind.js";
import type { Workflow } from "./schema.js";
import { publishFlatAsGeneration } from "./seed-generation.testkit.js";

// ─── Workflow fixtures ────────────────────────────────────────────────────────

// source (planner) → build (engineer, fanout, authoritative red). Implementer
// children; a red so the advance re-entry proves the reds run inside alsoValidate.
const FANOUT_IMPLEMENTER_WF: Workflow = {
  name: "fg524-fanout-impl-test",
  description: "FG-524: fanout implementer child validation-hold",
  review_mode: "legacy_verdict",
  inputs: [],
  steps: [
    { id: "source", agent: "planner", gate: "auto", manual: false, depends_on: [], runtime: "fg524-test", reds: [] },
    {
      id: "build",
      agent: "engineer",
      gate: "auto",
      manual: false,
      depends_on: ["source"],
      runtime: "fg524-test",
      reds: [{ agent: "red-narrow", authority: "authoritative", gate_on_verdict: true }],
      fanout: {
        from_upstream: { step: "source", array_key: "items", input_key: "item" },
        max_concurrency: 2,
        failure_mode: "continue",
      },
    },
  ],
};

// Same shape but the fanout agent is `docs` — a NON-implementer role.
const FANOUT_NONIMPL_WF: Workflow = {
  name: "fg524-fanout-nonimpl-test",
  description: "FG-524: fanout NON-implementer child is unaffected",
  review_mode: "legacy_verdict",
  inputs: [],
  steps: [
    { id: "source", agent: "planner", gate: "auto", manual: false, depends_on: [], runtime: "fg524-test", reds: [] },
    {
      id: "build",
      agent: "docs",
      gate: "auto",
      manual: false,
      depends_on: ["source"],
      runtime: "fg524-test",
      reds: [],
      fanout: {
        from_upstream: { step: "source", array_key: "items", input_key: "item" },
        max_concurrency: 2,
        failure_mode: "continue",
      },
    },
  ],
};

// Same as FANOUT_IMPLEMENTER_WF but the build step declares NO reds. This is the
// RF-2 (review-011263445508) case: a validation-held worktree fanout with zero reds
// must still REPUBLISH the captured integration branch on advance, not complete in
// place and drop it.
const FANOUT_IMPLEMENTER_NO_REDS_WF: Workflow = {
  name: "fg524-fanout-impl-noreds-test",
  description: "FG-524 RF-2: validation-held worktree fanout with no reds must publish on advance",
  review_mode: "legacy_verdict",
  inputs: [],
  steps: [
    { id: "source", agent: "planner", gate: "auto", manual: false, depends_on: [], runtime: "fg524-test", reds: [] },
    {
      id: "build",
      agent: "engineer",
      gate: "auto",
      manual: false,
      depends_on: ["source"],
      runtime: "fg524-test",
      reds: [],
      fanout: {
        from_upstream: { step: "source", array_key: "items", input_key: "item" },
        max_concurrency: 2,
        failure_mode: "continue",
      },
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
  ensureRuntime();
});

// ─── FG-712: a child cancelled after its container returns but before its
// completion CAS must be treated as failed by the aggregate. The cancel goes
// through performCancel (the production `forge cancel` path), not a mocked CAS.
// Its valid result is deliberately missing tests_run: if this outcome were still
// reported complete, the parent would incorrectly validation-hold it as well as
// merge/publish its captured worktree.

test("FG-712: a fanout child whose completion CAS loses to forge cancel is failed and excluded from validation and publication", async () => {
  setPlatform("darwin");
  process.env.FORGE_WORKTREES = "1";
  process.env.FORGE_WORKTREE_IGNORE_DIRTY = "1";
  process.env.FORGE_WORKTREES_EPHEMERAL = "1";

  const repo = makeTmpDir();
  initGitRepo(repo);
  const dockerBin = makeTmpDir();
  const dockerLog = join(dockerBin, "docker-calls.log");
  writeFileSync(dockerLog, "");
  writeFileSync(dockerBin + "/docker", `#!/bin/sh\necho "$@" >> "${dockerLog}"\n`);
  chmodSync(dockerBin + "/docker", 0o755);
  const priorPath = process.env.PATH;
  process.env.PATH = `${dockerBin}:${priorPath ?? ""}`;

  try {
    const { runId } = startRun({
      workflow: FANOUT_IMPLEMENTER_NO_REDS_WF,
      title: "FG-712 fanout lost completion CAS",
      inputs: {},
      projectDir: repo,
    });

    const stubExec: DockerExecFn = async ({ args, stdoutPath, stderrPath }) => {
      const taskId = extractTaskId(args);
      const projectMount = findProjectMountHost(args);
      writeFileSync(stderrPath, "");
      if (taskId.startsWith("task-source-")) {
        writeTaskResult(stdoutPath, { status: "complete", tests_run: 1, items: ["cancelled", "published"] });
      } else if (taskId.startsWith("task-build-0-")) {
        if (projectMount) writeFileSync(join(projectMount, "cancelled-child.ts"), "export const cancelled = true;\n");
        writeTaskResult(stdoutPath, { status: "complete" });
        // The container has produced a valid result, then the real cancel path
        // wins before runFanoutChild reaches markTaskComplete.
        const cancelled = performCancel(taskId, {}, () => {}, () => true);
        assert.equal(cancelled.kind, "task-cancelled", "precondition: forge cancel must terminally fail the live child row");
      } else if (taskId.startsWith("task-build-1-")) {
        if (projectMount) writeFileSync(join(projectMount, "published-child.ts"), "export const published = true;\n");
        writeTaskResult(stdoutPath, { status: "complete", tests_run: 1 });
      } else {
        writeTaskResult(stdoutPath, { status: "complete", tests_run: 1 });
      }
      return 0;
    };

    await runNext({ runId, workflow: FANOUT_IMPLEMENTER_NO_REDS_WF, dockerExec: stubExec });
    const wave = await runNext({ runId, workflow: FANOUT_IMPLEMENTER_NO_REDS_WF, dockerExec: stubExec });
    assert.deepEqual(wave.completedSteps, ["build"], "continue mode publishes only the genuinely completed sibling");
    assert.deepEqual(wave.awaitingGate, [], "the cancelled child's result is not sent to validation");

    const parent = tasksForRun(runId).find((task) => task.phase === "build" && task.parentId === undefined)!;
    const children = tasksForRun(runId).filter((task) => task.parentId === parent.id && !task.agentRole.startsWith("red-"));
    const lost = children.find((task) => task.taskPackage.inputs["fanoutIndex"] === 0)!;
    const completed = children.find((task) => task.taskPackage.inputs["fanoutIndex"] === 1)!;
    assert.equal(lost.status, "failed", "the cancelled child remains terminally failed after its completion CAS loses");
    assert.equal(failureKindForTask(lost.id), "cancelled", "the production cancel decision remains durable");
    assert.equal(eventsForTask(lost.id).some((event) => event.eventType === "task.completed"), false, "lost-CAS child is never announced as completed");

    const aggregate = parent.result as { status: string; children: Array<{ childTaskId: string; status: string; result?: unknown }> };
    const lostOutcome = aggregate.children.find((child) => child.childTaskId === lost.id)!;
    assert.equal(lostOutcome.status, "failed", "runFanoutChild returns the lost-CAS outcome as failed to the aggregate");
    assert.equal(lostOutcome.result, undefined, "the cancelled result is unavailable to validation or publication");
    assert.equal(aggregate.status, "partial", "the parent does not count the cancelled child as completed");
    assert.equal(completed.status, "complete", "the unaffected sibling still completes");

    assert.equal(existsSync(join(repo, "cancelled-child.ts")), false, "cancelled child worktree is never merged or published");
    assert.ok(existsSync(join(repo, "published-child.ts")), "the genuinely completed sibling is still published");
    assert.equal(allPublicationAttempts().filter((attempt) => attempt.taskId === parent.id && attempt.state === "published").length, 1, "only the aggregate of completed children is published");

    // FG-492's retention invariant remains in force: retain a child whose CAS
    // lost. The sibling and source are reaped, but no docker rm targets the lost
    // child (fg492-gate-container-reap.test.ts covers the shared reap mechanism).
    const dockerCalls = readFileSync(dockerLog, "utf8");
    assert.doesNotMatch(dockerCalls, new RegExp(`rm -f -v forge-${lost.id}`), "lost-CAS child container is retained, not reaped");
    assert.match(dockerCalls, new RegExp(`rm -f -v forge-${completed.id}`), "completed sibling still follows the normal reap path");
  } finally {
    process.env.PATH = priorPath;
  }
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
  const dir = mkdtempSync(join(tmpdir(), "forge-fg524-"));
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

function ensureRuntime(): void {
  const runtimePath = join(process.env.FORGE_HOME!, "runtimes", "fg524-test.yml");
  mkdirSync(dirname(runtimePath), { recursive: true });
  writeFileSync(
    runtimePath,
    `name: fg524-test
description: FG-524 dispatch test runtime stub
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

// Write the implementer workflow YAML so gate() (which reloads from disk) can find it.
function ensureImplementerWorkflowYaml(): void {
  const wfPath = join(process.env.FORGE_HOME!, "workflows", "fg524-fanout-impl-test.yml");
  mkdirSync(dirname(wfPath), { recursive: true });
  writeFileSync(
    wfPath,
    `name: fg524-fanout-impl-test
description: "FG-524: fanout implementer child validation-hold"
inputs: []
steps:
  - id: source
    agent: planner
    gate: auto
    manual: false
    depends_on: []
    runtime: fg524-test
    reds: []
  - id: build
    agent: engineer
    gate: auto
    manual: false
    depends_on: [source]
    runtime: fg524-test
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
  publishFlatAsGeneration(process.env.FORGE_HOME!);
}

// The no-reds variant's YAML (gate() reloads the workflow from disk by name).
function ensureImplementerNoRedsWorkflowYaml(): void {
  const wfPath = join(process.env.FORGE_HOME!, "workflows", "fg524-fanout-impl-noreds-test.yml");
  mkdirSync(dirname(wfPath), { recursive: true });
  writeFileSync(
    wfPath,
    `name: fg524-fanout-impl-noreds-test
description: "FG-524 RF-2: validation-held worktree fanout with no reds must publish on advance"
inputs: []
steps:
  - id: source
    agent: planner
    gate: auto
    manual: false
    depends_on: []
    runtime: fg524-test
    reds: []
  - id: build
    agent: engineer
    gate: auto
    manual: false
    depends_on: [source]
    runtime: fg524-test
    reds: []
    fanout:
      from_upstream:
        step: source
        array_key: items
        input_key: item
      max_concurrency: 2
      failure_mode: continue
`,
  );
  publishFlatAsGeneration(process.env.FORGE_HOME!);
}

function findProjectMountHost(dockerArgs: string[]): string | undefined {
  for (let i = 0; i < dockerArgs.length - 1; i++) {
    if (dockerArgs[i] === "-v" && dockerArgs[i + 1]!.includes(":/project:")) {
      return dockerArgs[i + 1]!.split(":")[0];
    }
  }
  return undefined;
}

function extractTaskId(args: string[]): string {
  const nameIdx = args.indexOf("--name");
  return nameIdx >= 0 ? (args[nameIdx + 1] ?? "").replace(/^forge-/, "") : "";
}

function writeTaskResult(stdoutPath: string, result: unknown): void {
  const dir = dirname(stdoutPath);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "result.json"), JSON.stringify(result));
  writeFileSync(stdoutPath, "stub stdout");
  writeFileSync(join(dir, "container.stderr.log"), "");
}

const PASS_VERDICT = { status: "complete", tests_run: 1, verdict: "pass", confidence: 1, findings: [] };

// ─── (1) Negative + recovery: a non-compliant implementer child HOLDS the parent,
//         and `forge gate <parentId> --advance` republishes the reused children. ──

test("fg524 (1): a fanout implementer child completing with no tests_run and no waiver HOLDS the parent at awaiting_gate; advance republishes the reused children", async () => {
  setPlatform("darwin");
  process.env.FORGE_WORKTREES = "1";
  process.env.FORGE_WORKTREE_IGNORE_DIRTY = "1";
  process.env.FORGE_WORKTREES_EPHEMERAL = "1";

  const repo = makeTmpDir();
  initGitRepo(repo);
  const baseSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
  ensureImplementerWorkflowYaml();

  const { runId } = startRun({
    workflow: FANOUT_IMPLEMENTER_WF,
    title: "fg524 negative+recovery",
    inputs: {},
    projectDir: repo,
  });

  // Track which task ids were invoked in the CURRENT wave.
  let currentWave: string[] = [];
  const stubExec: DockerExecFn = async ({ args, stdoutPath, stderrPath }) => {
    const taskId = extractTaskId(args);
    const projectMount = findProjectMountHost(args);
    currentWave.push(taskId);
    writeFileSync(stderrPath, "");

    if (taskId.startsWith("task-source-")) {
      writeTaskResult(stdoutPath, { status: "complete", tests_run: 1, items: ["item-a", "item-b"] });
    } else if (taskId.startsWith("task-build-0-")) {
      // The OFFENDING child: complete with NO tests_run and NO waiver. It still
      // commits work so the integration branch has content to publish on advance.
      if (projectMount) writeFileSync(join(projectMount, "child0.ts"), "export const child0 = 0;\n");
      writeTaskResult(stdoutPath, { status: "complete" });
    } else if (taskId.startsWith("task-build-1-")) {
      // Compliant sibling.
      if (projectMount) writeFileSync(join(projectMount, "child1.ts"), "export const child1 = 1;\n");
      writeTaskResult(stdoutPath, { status: "complete", tests_run: 3 });
    } else if (taskId.startsWith("task-red-build-")) {
      writeTaskResult(stdoutPath, PASS_VERDICT);
    } else {
      writeTaskResult(stdoutPath, { status: "complete", tests_run: 1 });
    }
    return 0;
  };

  // ── Wave 1: source ─────────────────────────────────────────────────────────
  currentWave = [];
  const wave1 = await runNext({ runId, workflow: FANOUT_IMPLEMENTER_WF, dockerExec: stubExec });
  assert.deepEqual(wave1.completedSteps, ["source"], "source completes in wave 1");

  // ── Wave 2: fanout — the non-compliant child holds the PARENT ──────────────
  currentWave = [];
  const wave2 = await runNext({ runId, workflow: FANOUT_IMPLEMENTER_WF, dockerExec: stubExec });
  assert.ok(wave2.awaitingGate.includes("build"), "the fanout build step must land awaiting_gate");
  assert.deepEqual(wave2.failedSteps, [], "the held parent must NOT wedge the run into a failure");

  const tasksW2 = tasksForRun(runId);
  const parent = tasksW2.find((t) => t.phase === "build" && t.parentId === undefined);
  assert.ok(parent, "fanout parent must exist");
  const parentId = parent!.id;
  assert.equal(parent!.status, "awaiting_gate", "the PARENT (not the child) is held awaiting_gate");

  const children = tasksW2.filter((t) => t.parentId === parentId && !t.agentRole.startsWith("red-"));
  assert.equal(children.length, 2, "both children exist");
  for (const c of children) {
    assert.equal(c.status, "complete", "each child individually completed — the hold is on the parent aggregate");
  }
  const offending = children.find((c) => (c.taskPackage.inputs["fanoutIndex"] as number) === 0)!;

  // The named reason came from the single evaluator and names the offending child.
  const holdEvent = eventsForTask(parentId).find(
    (e) => e.eventType === "task.awaiting_gate" && (e.payload as { kind?: string })?.kind === "validation_contract",
  );
  assert.ok(holdEvent, "a task.awaiting_gate event with kind=validation_contract must be recorded on the parent");
  const reason = (holdEvent!.payload as { reason: string }).reason;
  assert.match(reason, /validation contract/, "reason is the evaluator's named reason");
  assert.ok(reason.includes(offending.id), `reason must name the offending child id (${offending.id}); got: ${reason}`);
  assert.match(reason, /forge gate .* --advance/, "reason names the recovery verb");

  // Nothing published yet: the reds never ran (the hold fires BEFORE reds) and the
  // target is still at baseSha.
  assert.equal(
    currentWave.some((id) => id.startsWith("task-red-build-")),
    false,
    "no red is dispatched in wave 2 — the validation hold fires before the reds",
  );
  assert.equal(
    execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim(),
    baseSha,
    "nothing is published while the parent is held",
  );
  assert.equal(
    allPublicationAttempts().filter((a) => a.taskId === parentId).length,
    0,
    "no publication attempt for the held fanout parent (the source step's own publish is unrelated)",
  );
  // The integration branch was captured (built before the hold) and retained.
  assert.ok(existsSync(integrationWorktreeDir(runId, parentId)), "integration worktree retained for the advance to republish");

  // ── Recovery: forge gate <parentId> --advance (no --force: awaiting_gate) ───
  await gate(parentId, "advance", "steve advances the validation hold");
  const parentAfterGate = tasksForRun(runId).find((t) => t.id === parentId)!;
  assert.equal(parentAfterGate.status, "pending", "advance re-enters dispatch (pending), it does not complete in place");
  assert.strictEqual(parentAfterGate.taskPackage?.inputs?.["gateForced"], true, "gateForced set for the re-entry");

  // ── Wave 3: re-entry PUBLISHES the reused children, reds run now ────────────
  currentWave = [];
  const wave3 = await runNext({ runId, workflow: FANOUT_IMPLEMENTER_WF, dockerExec: stubExec });
  assert.deepEqual(wave3.completedSteps, ["build"], "build completes on the advance re-entry");
  assert.deepEqual(wave3.failedSteps, [], "no step fails on re-entry");

  const finalParent = tasksForRun(runId).find((t) => t.id === parentId)!;
  assert.equal(finalParent.status, "complete", "parent completes after the advance republish");

  // The reds ran NOW — inside the publisher's validation span — not before the hold.
  assert.equal(
    currentWave.some((id) => id.startsWith("task-red-build-")),
    true,
    "the red is dispatched on the advance re-entry (reds run inside alsoValidate)",
  );
  // The children were REUSED, never re-dispatched.
  assert.equal(
    currentWave.some((id) => id.startsWith("task-build-0-") || id.startsWith("task-build-1-")),
    false,
    "the completed children are reused on re-entry, never re-dispatched",
  );
  const childrenAfter = tasksForRun(runId).filter((t) => t.parentId === parentId && !t.agentRole.startsWith("red-"));
  assert.equal(childrenAfter.length, 2, "no new children were created on re-entry");

  // The publish actually happened: both children's work is on the target.
  const published = allPublicationAttempts().filter((a) => a.state === "published" && a.taskId === parentId);
  assert.equal(published.length, 1, "the advance re-entry published exactly once");
  assert.ok(existsSync(join(repo, "child0.ts")), "the offending child's work is published on advance");
  assert.ok(existsSync(join(repo, "child1.ts")), "the compliant child's work is published on advance");
  assert.notEqual(
    execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim(),
    baseSha,
    "the target advanced — the reused children were actually shipped, not dropped",
  );
});

// ─── (2) Positive control: a compliant child and a WAIVERED child complete and
//         publish normally — no hold. ────────────────────────────────────────────

test("fg524 (2): a compliant child and a no_validation_reason-waivered child complete and publish — no hold", async () => {
  setPlatform("darwin");
  process.env.FORGE_WORKTREES = "1";
  process.env.FORGE_WORKTREE_IGNORE_DIRTY = "1";
  process.env.FORGE_WORKTREES_EPHEMERAL = "1";

  const repo = makeTmpDir();
  initGitRepo(repo);
  const baseSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();

  const { runId } = startRun({
    workflow: FANOUT_IMPLEMENTER_WF,
    title: "fg524 positive control",
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
      writeTaskResult(stdoutPath, { status: "complete", tests_run: 5 });
    } else if (taskId.startsWith("task-build-1-")) {
      // No tests_run, but a valid waiver — the same field FG-523 honors for primaries.
      if (projectMount) writeFileSync(join(projectMount, "child1.ts"), "export const child1 = 1;\n");
      writeTaskResult(stdoutPath, { status: "complete", no_validation_reason: "config-only change, nothing to test" });
    } else if (taskId.startsWith("task-red-build-")) {
      writeTaskResult(stdoutPath, PASS_VERDICT);
    } else {
      writeTaskResult(stdoutPath, { status: "complete", tests_run: 1 });
    }
    return 0;
  };

  await runNext({ runId, workflow: FANOUT_IMPLEMENTER_WF, dockerExec: stubExec });
  const wave2 = await runNext({ runId, workflow: FANOUT_IMPLEMENTER_WF, dockerExec: stubExec });
  assert.deepEqual(wave2.completedSteps, ["build"], "build completes normally — no hold");
  assert.deepEqual(wave2.awaitingGate, [], "neither the compliant nor the waivered child holds the parent");

  const parent = tasksForRun(runId).find((t) => t.phase === "build" && t.parentId === undefined)!;
  assert.equal(parent.status, "complete", "parent completes on the first pass");
  assert.ok(existsSync(join(repo, "child0.ts")), "compliant child work published");
  assert.ok(existsSync(join(repo, "child1.ts")), "waivered child work published");
  assert.notEqual(
    execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim(),
    baseSha,
    "the target advanced on the first pass",
  );

  // The waiver left an audit record, exactly like the primary path.
  const waiverEvent = eventsForTask(
    tasksForRun(runId).find(
      (t) => t.parentId === parent.id && (t.taskPackage.inputs["fanoutIndex"] as number) === 1,
    )!.id,
  ).find((e) => e.eventType === "task.decision" && (e.payload as { kind?: string })?.kind === "validation_waiver");
  assert.ok(waiverEvent, "the waivered child records a validation_waiver decision event");
});

// ─── (3) Non-implementer control: a `docs` child completing without tests_run
//         does NOT hold the parent. ─────────────────────────────────────────────

test("fg524 (3): a NON-implementer (docs) fanout child completing without tests_run does NOT hold the parent", async () => {
  setPlatform("darwin");
  process.env.FORGE_WORKTREES = "1";
  process.env.FORGE_WORKTREE_IGNORE_DIRTY = "1";
  process.env.FORGE_WORKTREES_EPHEMERAL = "1";

  const repo = makeTmpDir();
  initGitRepo(repo);

  const { runId } = startRun({
    workflow: FANOUT_NONIMPL_WF,
    title: "fg524 non-implementer control",
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
      // A docs child with NO tests_run — would hold if it were an implementer.
      if (projectMount) writeFileSync(join(projectMount, "doc0.md"), "# doc0\n");
      writeTaskResult(stdoutPath, { status: "complete" });
    } else if (taskId.startsWith("task-build-1-")) {
      if (projectMount) writeFileSync(join(projectMount, "doc1.md"), "# doc1\n");
      writeTaskResult(stdoutPath, { status: "complete" });
    } else {
      writeTaskResult(stdoutPath, { status: "complete" });
    }
    return 0;
  };

  await runNext({ runId, workflow: FANOUT_NONIMPL_WF, dockerExec: stubExec });
  const wave2 = await runNext({ runId, workflow: FANOUT_NONIMPL_WF, dockerExec: stubExec });
  assert.deepEqual(wave2.completedSteps, ["build"], "the docs fanout completes normally");
  assert.deepEqual(wave2.awaitingGate, [], "a non-implementer child does NOT hold the parent");

  const parent = tasksForRun(runId).find((t) => t.phase === "build" && t.parentId === undefined)!;
  assert.equal(parent.status, "complete", "the docs fanout parent completes without a validation hold");
  const holdEvent = eventsForTask(parent.id).find(
    (e) => e.eventType === "task.awaiting_gate" && (e.payload as { kind?: string })?.kind === "validation_contract",
  );
  assert.equal(holdEvent, undefined, "no validation_contract hold for a non-implementer child");
});

// ─── (4) NON-worktree validation-held advance: the step's reds MUST run on the
//         advance re-entry — a non-worktree fanout published nothing, but its
//         children's work must not reach `complete` red-unreviewed (FG-524 item 1). ──

test("fg524 (4): a NON-worktree validation-held fanout parent runs the step's reds on advance — child work never completes red-unreviewed", async () => {
  // Non-worktree mode: children write directly to projectDir, there is no
  // integration branch. The hold still fires BEFORE any red runs (inherited from
  // FG-523), so the advance must RUN the reds now rather than complete in place.
  process.env.FORGE_NO_WORKTREES = "1";

  const repo = makeTmpDir();
  initGitRepo(repo);
  ensureImplementerWorkflowYaml();

  const { runId } = startRun({
    workflow: FANOUT_IMPLEMENTER_WF,
    title: "fg524 non-worktree validation hold",
    inputs: {},
    projectDir: repo,
  });

  let currentWave: string[] = [];
  const stubExec: DockerExecFn = async ({ args, stdoutPath, stderrPath }) => {
    const taskId = extractTaskId(args);
    const projectMount = findProjectMountHost(args);
    currentWave.push(taskId);
    writeFileSync(stderrPath, "");

    if (taskId.startsWith("task-source-")) {
      writeTaskResult(stdoutPath, { status: "complete", tests_run: 1, items: ["item-a", "item-b"] });
    } else if (taskId.startsWith("task-build-0-")) {
      // The OFFENDING child: complete with NO tests_run and NO waiver.
      if (projectMount) writeFileSync(join(projectMount, "child0.ts"), "export const child0 = 0;\n");
      writeTaskResult(stdoutPath, { status: "complete" });
    } else if (taskId.startsWith("task-build-1-")) {
      if (projectMount) writeFileSync(join(projectMount, "child1.ts"), "export const child1 = 1;\n");
      writeTaskResult(stdoutPath, { status: "complete", tests_run: 3 });
    } else if (taskId.startsWith("task-red-build-")) {
      writeTaskResult(stdoutPath, PASS_VERDICT);
    } else {
      writeTaskResult(stdoutPath, { status: "complete", tests_run: 1 });
    }
    return 0;
  };

  // ── Wave 1: source ─────────────────────────────────────────────────────────
  currentWave = [];
  const wave1 = await runNext({ runId, workflow: FANOUT_IMPLEMENTER_WF, dockerExec: stubExec });
  assert.deepEqual(wave1.completedSteps, ["source"], "source completes in wave 1");

  // ── Wave 2: fanout — the non-compliant child holds the PARENT, before any red ──
  currentWave = [];
  const wave2 = await runNext({ runId, workflow: FANOUT_IMPLEMENTER_WF, dockerExec: stubExec });
  assert.ok(wave2.awaitingGate.includes("build"), "the fanout build step must land awaiting_gate");
  assert.deepEqual(wave2.failedSteps, [], "the held parent must NOT wedge the run into a failure");
  assert.equal(
    currentWave.some((id) => id.startsWith("task-red-build-")),
    false,
    "no red is dispatched in wave 2 — the validation hold fires BEFORE the reds",
  );

  const parent = tasksForRun(runId).find((t) => t.phase === "build" && t.parentId === undefined)!;
  const parentId = parent.id;
  assert.equal(parent.status, "awaiting_gate", "the parent is held awaiting_gate in non-worktree mode too");
  assert.equal(
    verdictsForTask(parentId).length,
    0,
    "no verdict exists while the parent is held — the reds have never run",
  );

  // ── Recovery: forge gate <parentId> --advance ──────────────────────────────
  await gate(parentId, "advance", "steve advances the non-worktree validation hold");
  const parentAfterGate = tasksForRun(runId).find((t) => t.id === parentId)!;
  assert.equal(
    parentAfterGate.status,
    "pending",
    "advance re-enters dispatch (pending), it does NOT complete in place — the reds still have to run",
  );
  assert.strictEqual(parentAfterGate.taskPackage?.inputs?.["gateForced"], true, "gateForced set for the re-entry");

  // ── Wave 3: re-entry RUNS the reds against projectDir, then completes ───────
  currentWave = [];
  const wave3 = await runNext({ runId, workflow: FANOUT_IMPLEMENTER_WF, dockerExec: stubExec });
  assert.deepEqual(wave3.completedSteps, ["build"], "build completes on the advance re-entry");
  assert.deepEqual(wave3.failedSteps, [], "no step fails on re-entry");

  const finalParent = tasksForRun(runId).find((t) => t.id === parentId)!;
  assert.equal(finalParent.status, "complete", "parent completes after the reds run on advance");

  // THE INVARIANT: the reds actually ran on the non-worktree advance — child work
  // did not reach `complete` red-unreviewed.
  assert.equal(
    currentWave.some((id) => id.startsWith("task-red-build-")),
    true,
    "the step's red IS dispatched on the non-worktree advance re-entry — child work is never completed red-unreviewed",
  );
  assert.ok(
    verdictsForTask(parentId).length > 0,
    "a verdict now exists — the reds ran before the parent completed",
  );

  // The children were REUSED, never re-dispatched.
  assert.equal(
    currentWave.some((id) => id.startsWith("task-build-0-") || id.startsWith("task-build-1-")),
    false,
    "the completed children are reused on re-entry, never re-dispatched",
  );
  const childrenAfter = tasksForRun(runId).filter((t) => t.parentId === parentId && !t.agentRole.startsWith("red-"));
  assert.equal(childrenAfter.length, 2, "no new children were created on re-entry");
});

// ─── (5) RF-2 (review-011263445508): a validation-held WORKTREE fanout with NO
//         reds must PUBLISH the captured integration branch on advance, not
//         complete in place and drop it. The build gate condition used to require
//         step.reds.length > 0, so a no-reds step in worktree mode fell through to
//         the in-place markTaskComplete and silently dropped every child's work. ──

test("fg524 (5) RF-2: a validation-held WORKTREE fanout with NO reds PUBLISHES the reused children on advance — the integration branch is not dropped", async () => {
  setPlatform("darwin");
  process.env.FORGE_WORKTREES = "1";
  process.env.FORGE_WORKTREE_IGNORE_DIRTY = "1";
  process.env.FORGE_WORKTREES_EPHEMERAL = "1";

  const repo = makeTmpDir();
  initGitRepo(repo);
  const baseSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
  ensureImplementerNoRedsWorkflowYaml();

  const { runId } = startRun({
    workflow: FANOUT_IMPLEMENTER_NO_REDS_WF,
    title: "fg524 RF-2 no-reds worktree publish",
    inputs: {},
    projectDir: repo,
  });

  let currentWave: string[] = [];
  const stubExec: DockerExecFn = async ({ args, stdoutPath, stderrPath }) => {
    const taskId = extractTaskId(args);
    const projectMount = findProjectMountHost(args);
    currentWave.push(taskId);
    writeFileSync(stderrPath, "");

    if (taskId.startsWith("task-source-")) {
      writeTaskResult(stdoutPath, { status: "complete", tests_run: 1, items: ["item-a", "item-b"] });
    } else if (taskId.startsWith("task-build-0-")) {
      // The OFFENDING child: complete with NO tests_run and NO waiver — holds the parent.
      if (projectMount) writeFileSync(join(projectMount, "child0.ts"), "export const child0 = 0;\n");
      writeTaskResult(stdoutPath, { status: "complete" });
    } else if (taskId.startsWith("task-build-1-")) {
      if (projectMount) writeFileSync(join(projectMount, "child1.ts"), "export const child1 = 1;\n");
      writeTaskResult(stdoutPath, { status: "complete", tests_run: 3 });
    } else {
      writeTaskResult(stdoutPath, { status: "complete", tests_run: 1 });
    }
    return 0;
  };

  // ── Wave 1: source ─────────────────────────────────────────────────────────
  await runNext({ runId, workflow: FANOUT_IMPLEMENTER_NO_REDS_WF, dockerExec: stubExec });

  // ── Wave 2: fanout — the non-compliant child holds the PARENT (no reds involved) ──
  const wave2 = await runNext({ runId, workflow: FANOUT_IMPLEMENTER_NO_REDS_WF, dockerExec: stubExec });
  assert.ok(wave2.awaitingGate.includes("build"), "the no-reds fanout build step must land awaiting_gate");
  assert.deepEqual(wave2.failedSteps, [], "the held parent must NOT wedge the run into a failure");

  const parent = tasksForRun(runId).find((t) => t.phase === "build" && t.parentId === undefined)!;
  const parentId = parent.id;
  assert.equal(parent.status, "awaiting_gate", "the parent is held awaiting_gate");
  assert.equal(verdictsForTask(parentId).length, 0, "no verdict exists — this step has no reds and none ran");

  // Nothing published while held: the integration branch was captured and retained.
  assert.equal(
    execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim(),
    baseSha,
    "nothing is published while the parent is held",
  );
  assert.ok(
    existsSync(integrationWorktreeDir(runId, parentId)),
    "integration worktree retained for the advance to republish",
  );

  // ── Recovery: forge gate <parentId> --advance ──────────────────────────────
  await gate(parentId, "advance", "steve advances the no-reds worktree validation hold");
  const parentAfterGate = tasksForRun(runId).find((t) => t.id === parentId)!;
  // THE FIX: with zero reds, a worktree hold must STILL re-enter to publish — not
  // complete in place. Before RF-2 this asserted "complete" (branch dropped).
  assert.equal(
    parentAfterGate.status,
    "pending",
    "advance re-enters dispatch (pending) to PUBLISH — it must NOT complete in place and drop the branch",
  );
  assert.strictEqual(parentAfterGate.taskPackage?.inputs?.["gateForced"], true, "gateForced set for the re-entry");

  // ── Wave 3: re-entry PUBLISHES the reused children ─────────────────────────
  currentWave = [];
  const wave3 = await runNext({ runId, workflow: FANOUT_IMPLEMENTER_NO_REDS_WF, dockerExec: stubExec });
  assert.deepEqual(wave3.completedSteps, ["build"], "build completes on the advance re-entry");
  assert.deepEqual(wave3.failedSteps, [], "no step fails on re-entry");

  const finalParent = tasksForRun(runId).find((t) => t.id === parentId)!;
  assert.equal(finalParent.status, "complete", "parent completes after the advance republish");

  // The children were REUSED, never re-dispatched.
  assert.equal(
    currentWave.some((id) => id.startsWith("task-build-0-") || id.startsWith("task-build-1-")),
    false,
    "the completed children are reused on re-entry, never re-dispatched",
  );

  // THE INVARIANT: the captured integration branch was PUBLISHED, not dropped.
  const published = allPublicationAttempts().filter((a) => a.state === "published" && a.taskId === parentId);
  assert.equal(published.length, 1, "the advance re-entry published exactly once");
  assert.ok(existsSync(join(repo, "child0.ts")), "the offending child's work is published on advance");
  assert.ok(existsSync(join(repo, "child1.ts")), "the sibling child's work is published on advance");
  assert.notEqual(
    execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim(),
    baseSha,
    "the target advanced — the reused children were actually shipped, not dropped with the branch",
  );
});

// ─── (6) RF-1 (review-0d62a33de7c3): a validation-held WORKTREE fanout whose
//         integration branch has DISAPPEARED must FAIL LOUDLY on advance, not
//         silently complete over the (now unrecoverable) child work.
//
//         The sibling blocked_by_red path already refuses this exact state — worktree
//         mode on, integration branch gone — with a named merge_conflict failure
//         (fg353 test 8). A validation hold reaches the SAME re-entry with
//         redsAlreadyRan=false; before RF-1 the loud-failure arm required
//         redsAlreadyRan, so the validation-hold path fell through to the in-place
//         markTaskComplete and asserted success over the dropped branch. Asserted with
//         a step that DECLARES reds — the arm the original no-reds framing would have
//         missed, since a step with reds re-enters gate.ts even when the branch is
//         gone. ──

test("fg524 (6) RF-1: a validation-held WORKTREE fanout whose integration branch has vanished FAILS LOUDLY on advance — it does NOT silently complete over the dropped child work", async () => {
  setPlatform("darwin");
  process.env.FORGE_WORKTREES = "1";
  process.env.FORGE_WORKTREE_IGNORE_DIRTY = "1";
  process.env.FORGE_WORKTREES_EPHEMERAL = "1";

  const repo = makeTmpDir();
  initGitRepo(repo);
  const baseSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
  ensureImplementerWorkflowYaml();

  const { runId } = startRun({
    workflow: FANOUT_IMPLEMENTER_WF,
    title: "fg524 RF-1 missing integration branch on validation-hold advance",
    inputs: {},
    projectDir: repo,
  });

  let currentWave: string[] = [];
  const stubExec: DockerExecFn = async ({ args, stdoutPath, stderrPath }) => {
    const taskId = extractTaskId(args);
    const projectMount = findProjectMountHost(args);
    currentWave.push(taskId);
    writeFileSync(stderrPath, "");

    if (taskId.startsWith("task-source-")) {
      writeTaskResult(stdoutPath, { status: "complete", tests_run: 1, items: ["item-a", "item-b"] });
    } else if (taskId.startsWith("task-build-0-")) {
      // The OFFENDING child: complete with NO tests_run and NO waiver — holds the parent.
      if (projectMount) writeFileSync(join(projectMount, "child0.ts"), "export const child0 = 0;\n");
      writeTaskResult(stdoutPath, { status: "complete" });
    } else if (taskId.startsWith("task-build-1-")) {
      if (projectMount) writeFileSync(join(projectMount, "child1.ts"), "export const child1 = 1;\n");
      writeTaskResult(stdoutPath, { status: "complete", tests_run: 3 });
    } else if (taskId.startsWith("task-red-build-")) {
      writeTaskResult(stdoutPath, PASS_VERDICT);
    } else {
      writeTaskResult(stdoutPath, { status: "complete", tests_run: 1 });
    }
    return 0;
  };

  // ── Wave 1: source ─────────────────────────────────────────────────────────
  await runNext({ runId, workflow: FANOUT_IMPLEMENTER_WF, dockerExec: stubExec });

  // ── Wave 2: fanout — the non-compliant child holds the PARENT, before any red ──
  const wave2 = await runNext({ runId, workflow: FANOUT_IMPLEMENTER_WF, dockerExec: stubExec });
  assert.ok(wave2.awaitingGate.includes("build"), "the fanout build step must land awaiting_gate");

  const parent = tasksForRun(runId).find((t) => t.phase === "build" && t.parentId === undefined)!;
  const parentId = parent.id;
  assert.equal(parent.status, "awaiting_gate", "the parent is held awaiting_gate");
  assert.equal(
    verdictsForTask(parentId).length,
    0,
    "no verdict exists — the reds never ran (the hold fires before reds; redsAlreadyRan will be false on advance)",
  );

  // ── Absent the integration branch (and its worktree) — lost state between the
  //    hold and the advance. This is the state fg353 test 8 exercises for the
  //    blocked_by_red sibling; here it is a VALIDATION hold. ──
  const integPath = integrationWorktreeDir(runId, parentId);
  const intBranch = integrationBranchName(runId, parentId);
  assert.ok(existsSync(integPath), "integration worktree must exist before manual deletion");
  execFileSync("git", ["worktree", "remove", "--force", integPath], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["branch", "-D", intBranch], { cwd: repo, stdio: "ignore" });
  assert.equal(
    integrationBranchExists(repo, runId, parentId),
    false,
    "precondition: the integration branch is gone before the advance",
  );

  // ── Advance the validation hold. The step declares reds, so gate.ts re-enters
  //    (pending + gateForced) even with the branch gone — routing the decision to
  //    runNext, exactly where the loud-failure arm lives. ──
  await gate(parentId, "advance", "steve advances a validation hold whose branch has vanished");
  const parentAfterGate = tasksForRun(runId).find((t) => t.id === parentId)!;
  assert.equal(parentAfterGate.status, "pending", "advance re-enters dispatch (pending), it does not complete in place");
  assert.strictEqual(parentAfterGate.taskPackage?.inputs?.["gateForced"], true, "gateForced set for the re-entry");

  // ── Wave 3: re-entry with the branch gone → FAIL LOUDLY, never silently complete ──
  currentWave = [];
  const wave3 = await runNext({ runId, workflow: FANOUT_IMPLEMENTER_WF, dockerExec: stubExec });
  assert.deepEqual(
    wave3.failedSteps,
    ["build"],
    "build must FAIL on the advance re-entry when the integration branch is missing",
  );
  assert.deepEqual(
    wave3.completedSteps,
    [],
    "build must NOT silently complete over the dropped child work",
  );

  const finalParent = tasksForRun(runId).find((t) => t.id === parentId)!;
  assert.equal(finalParent.status, "failed", "the parent is FAILED, not silently complete");
  assert.equal(
    failureKindForTask(parentId),
    "merge_conflict",
    "the named failure kind is merge_conflict — the same the blocked_by_red sibling raises",
  );

  // Nothing was published: the child work is NOT on the target, and no publication landed.
  assert.equal(
    execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim(),
    baseSha,
    "the target did NOT advance — no child work was shipped over the missing branch",
  );
  assert.equal(existsSync(join(repo, "child0.ts")), false, "child0.ts must NOT reach the target — the merge never happened");
  assert.equal(existsSync(join(repo, "child1.ts")), false, "child1.ts must NOT reach the target — the merge never happened");
  assert.equal(
    allPublicationAttempts().filter((a) => a.state === "published" && a.taskId === parentId).length,
    0,
    "no publication attempt succeeded for the parent whose branch vanished",
  );
});
