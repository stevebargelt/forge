// FG-425 (AC5): ONE truthful final disposition after a lost mutex — driven through
// the PRODUCTION boundary, not through the publisher in isolation.
//
// THE DEFECT THIS PINS. A publisher whose ref advance has LANDED and which then loses
// the publication window used to return a TERMINAL `refused` — over an attempt still
// recorded `publishing`. runNext mapped that to `publication_refused` and FAILED the
// task, with retry advice reading "Nothing was published; the target is unchanged".
// AD-5 recovery then converged the very same attempt to `published`, and nothing ever
// went back and told the task. Two durable records, contradicting each other, with the
// failed one inviting a retry of work that was already on the target.
//
// So every test here reads the DURABLE rows and the RENDERED OPERATOR STRINGS —
// task.status, the task.failed events, the publication_attempts row, `forge show`'s
// next-command, the retry-policy advice, `forge advise`, the campaign report — because
// the defect was never in the publisher's return value alone. It was in what the rest
// of forge went on to say about it.
//
// The window is entered the way production enters it: the publisher's lease is stolen
// mid-window (a deschedule longer than the mutex TTL — laptop suspend, SIGSTOP, a
// paused container, a long GC stall), through the AD-5 seam, inside a REAL runNext
// dispatch against a REAL git target. Nothing here is probed, signalled, or reaped:
// the steal is a durable-lease takeover, which is the only mechanism AD-7 permits.
//
// ─── FG-676 (BD-9): was anything in this file GREEN BECAUSE OF THE RESURRECTION? ───
//
// FG-681 records tests failing with `expected awaiting_gate, actual failed` — the same
// state pair FG-676's resurrection produces — that are red on the darwin host and green
// in CI at the same commit. So it was possible that a currently-green assertion here was
// green only because reconciliation resurrected a terminal row, and that removing the
// resurrection would turn it red. That had to be DETERMINED, not assumed.
//
// DETERMINED, by running both FG-425 worktree files before and after the fix:
//
//   src/v2/fg425-lost-window-disposition.worktree.test.ts — UNAFFECTED. Every test here
//   drives a `gate: auto` step (the WORKFLOW below), and the resurrection only ever fired
//   through finalizePrimary's `human`/`verdict` branches. Nothing in this file expected
//   `awaiting_gate` at all before FG-676; the new test below is the first. The two
//   cancel-stands tests (6) were already protected by the cancel half of the same guard,
//   and the crash-stranded repair test (4) — which fabricates its contradiction with a
//   bare `UPDATE tasks SET status='failed'` and NO task.failed event — is exactly the
//   no-evidence default the FG-676 guard leaves untouched. It still reconciles.
//
//   src/campaign/fg425-campaign-lost-window.worktree.test.ts — UNAFFECTED, same reason:
//   `gate: auto` throughout, no awaiting_gate expectation anywhere in it. Left unchanged.
//
// NO ASSERTION IN EITHER FILE WAS ADJUSTED. Both were green before the fix and green
// after it, with the same assertions.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { tasksForRun, getTask } from "../store/tasks.js";
import { eventsForTask } from "../store/events.js";
import { getRun } from "../store/runs.js";
import {
  publicationAttemptsForTask,
  releasePublicationMutex,
  setPublicationClockOffsetForTest,
  tryAcquirePublicationMutex,
} from "../store/publications.js";
import { failureKindForTask } from "./failure-kind.js";
import { retryPolicy } from "./retry-policy.js";
import { adviseRun } from "./advise.js";
import { retry, PublishedTaskRetryError } from "./retry.js";
import { gate as doGate } from "./gate.js";
import { projectIdentity } from "./project-identity.js";
import { startRun } from "./startRun.js";
import { runNext, recoverPublicationByHand, type DockerExecFn } from "./runNext.js";
import {
  MUTEX_TTL_MS,
  publishIntegration,
  setPublisherSeamsForTest,
  type ValidationResult,
} from "./integration-publisher.js";
import { localTargetFor, readTargetSha } from "./publication-target.js";
import { deriveNextCommandForTask, deriveNextCommandForRun, publicationRecoveryMessage, publicationAfterCancelMessage } from "../cli/commands/show.js";
import { performCancel } from "../cli/commands/cancel.js";
import type { Workflow } from "./schema.js";
import { publishFlatAsGeneration } from "./seed-generation.testkit.js";

const WORKFLOW: Workflow = {
  name: "fg425-ac5-test",
  description: "FG-425 AC5: one truthful disposition after a lost mutex",
  review_mode: "legacy_verdict",
  inputs: [],
  steps: [
    {
      id: "build",
      agent: "engineer",
      gate: "auto",
      manual: false,
      depends_on: [],
      runtime: "fg425-ac5-test",
      reds: [],
    },
  ],
};

/** FG-676: the same shape, on a HUMAN-GATED step — the only shape the defect fires on.
 *  A `gate: auto` primary lands through markTaskComplete, whose CAS has refused a
 *  terminal row since AWN-2; the resurrection lived on the `human`/`verdict` branches. */
const HUMAN_GATE_WORKFLOW: Workflow = {
  name: "fg676-gate-human-test",
  description: "FG-676: a human-gated step whose publication reconcile must not resurrect a gate rejection",
  review_mode: "legacy_verdict",
  inputs: [],
  steps: [
    {
      id: "build",
      agent: "engineer",
      gate: "human",
      manual: false,
      depends_on: [],
      runtime: "fg425-ac5-test",
      reds: [],
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
  process.env.FORGE_WORKTREES = "1";
  process.env.FORGE_WORKTREE_IGNORE_DIRTY = "1";
  setPlatform("darwin");
  ensureRuntime();
});

afterEach(() => {
  setPublisherSeamsForTest({});
  setPublicationClockOffsetForTest(0);
  setDbForTest(prev as DatabaseInstance);
  db.close();
  for (const k of ENV_VARS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k] as string;
  }
  setPlatform(process.platform);
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
  const dir = mkdtempSync(join(tmpdir(), "fg425-ac5-"));
  tmpDirs.push(dir);
  git(dir, ["init", "-b", "main"]);
  git(dir, ["config", "user.email", "test@forge.test"]);
  git(dir, ["config", "user.name", "Forge Test"]);
  writeFileSync(join(dir, "README.md"), "# test\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-q", "-m", "initial"]);
  return dir;
}

function ensureRuntime(): void {
  const runtimePath = join(process.env.FORGE_HOME!, "runtimes", "fg425-ac5-test.yml");
  mkdirSync(dirname(runtimePath), { recursive: true });
  writeFileSync(
    runtimePath,
    `name: fg425-ac5-test
description: FG-425 AC5 test runtime stub
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

/** `forge publish recover` runs OUTSIDE a wave: it has an attempt id and nothing else,
 *  so it reloads the run's workflow from disk exactly as `forge next` does. The
 *  installed YAML is therefore part of the production shape this test drives. */
function ensureWorkflowOnDisk(wf: Workflow = WORKFLOW): void {
  const path = join(process.env.FORGE_HOME!, "workflows", `${wf.name}.yml`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    `name: ${wf.name}
description: ${JSON.stringify(wf.description)}
inputs: []
steps:
  - id: build
    agent: engineer
    gate: ${wf.steps[0]!.gate}
    runtime: fg425-ac5-test
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

/** The agent: commits `file` on its task branch, exactly as a real one does. */
function stubExec(file: string): DockerExecFn {
  return async ({ args, stdoutPath, stderrPath }) => {
    const mount = findProjectMountHost(args)!;
    writeFileSync(stderrPath, "");
    mkdirSync(dirname(join(mount, file)), { recursive: true });
    writeFileSync(join(mount, file), "the agent's output\n");
    git(mount, ["add", "."]);
    git(mount, [...AGENT_IDENTITY, "commit", "-q", "-m", "primary output"]);
    const dir = dirname(stdoutPath);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "result.json"), JSON.stringify({ status: "complete", tests_run: 1, files_modified: [file] }));
    writeFileSync(stdoutPath, "stub stdout");
    writeFileSync(join(dir, "container.stderr.log"), "");
    return 0;
  };
}

/** THE LOST WINDOW, induced the way production produces it.
 *
 *  The publisher's ref advance has landed and its checkout has not run. Its lease is
 *  then taken over — the durable-timestamp takeover AD-7 defines, and the ONLY thing a
 *  deschedule past the TTL looks like from the outside. Nothing probes the publisher,
 *  nothing signals it: a thief simply finds the lease lapsed and takes the mutex, and
 *  the publisher's next renew (immediately before its `read-tree`) fails.
 *
 *  `holdFor` is how long the thief keeps the window before releasing it. Released, the
 *  publisher re-takes it and converges in-run. Held forever, the publisher's bounded
 *  wait gives up and reports the NON-TERMINAL recovery_pending. */
function stealWindowAfterRefAdvance(projectDir: string, opts: { holdFor?: number } = {}): { thief: string } {
  const thief = "thief-attempt";
  const key = projectIdentity(projectDir).key;
  setPublisherSeamsForTest({
    convergeWaitMs: 2_000,
    afterRefAdvance: () => {
      // The deschedule: from the store's clock, the publisher's lease lapsed long ago.
      setPublicationClockOffsetForTest(MUTEX_TTL_MS + 60_000);
      const got = tryAcquirePublicationMutex({ projectKey: key, attemptId: thief, runId: "thief-run", ttlMs: MUTEX_TTL_MS });
      assert.equal(got.acquired, true, "precondition: the thief must take the window from the lapsed lease");
      if (opts.holdFor !== undefined) {
        // The event loop is free while the publisher polls for the window, so a timer
        // is how the thief gives it back — the ordinary case: a short window closes.
        setTimeout(() => releasePublicationMutex(key, thief), opts.holdFor);
      }
    },
  });
  return { thief };
}

function primaryOf(runId: string) {
  return tasksForRun(runId).find((t) => t.phase === "build" && t.parentId === undefined)!;
}

function eventTypes(taskId: string): string[] {
  return eventsForTask(taskId).map((e) => e.eventType);
}

/** Every operator-facing string forge would put in front of a human about this task.
 *  The AC is asserted against THESE, not against the JSON — a variant handled by the
 *  evaluator and inert at the render path does not satisfy it. */
function operatorSurfaces(runId: string, taskId: string): string[] {
  const task = getTask(taskId)!;
  const run = getRun(runId)!;
  const tasks = tasksForRun(runId);
  const kind = failureKindForTask(taskId);
  const policy = retryPolicy(kind, taskId);
  const advice = adviseRun(run, tasks);
  const attempt = publicationAttemptsForTask(taskId)[0];
  return [
    task.error ?? "",
    deriveNextCommandForTask(task.status, kind, taskId),
    deriveNextCommandForRun(runId, tasks),
    policy.reason,
    policy.advice ?? "",
    advice.summary,
    advice.command,
    attempt && task.status === "awaiting_recovery" ? publicationRecoveryMessage(attempt) : "",
  ];
}

/** The two sentences the AC forbids over a ref that carries the candidate. */
function assertNoFalseUnpublishedClaim(surfaces: string[]): void {
  for (const s of surfaces) {
    assert.doesNotMatch(
      s,
      /[Nn]othing (was |from this task was )published/,
      `an operator surface claims nothing was published while the target ref carries the candidate:\n  "${s}"`,
    );
    assert.doesNotMatch(
      s,
      /the target is unchanged/,
      `an operator surface claims the target is unchanged while the ref carries the candidate:\n  "${s}"`,
    );
  }
}

// ─── (1) the AC's production-boundary regression: in-run convergence ──────────
//
// The window comes back (a real one closes in seconds — it is a CAS, a ref write and a
// checkout), so the publisher re-takes it and runs AD-5 convergence for its OWN attempt.
// ONE disposition comes out, and it is the true one: published.

test("FG-425 (AC5): a lost window AFTER the ref advance converges IN-RUN — the attempt publishes, the task completes, and no surface ever says nothing was published", async () => {
  const repo = makeRepo();
  const base = git(repo, ["rev-parse", "HEAD"]);
  const target = localTargetFor(projectIdentity(repo).canonicalDir);
  const { runId } = startRun({ workflow: WORKFLOW, title: "ac5-converge", projectDir: repo, inputs: {} });

  stealWindowAfterRefAdvance(repo, { holdFor: 30 });
  const result = await runNext({ runId: runId, workflow: WORKFLOW, dockerExec: stubExec("src/feature.ts") });

  const task = primaryOf(runId);
  const attempt = publicationAttemptsForTask(task.id)[0]!;

  // THE PUBLICATION. Converged, not guessed: the ref carried the candidate all along.
  assert.equal(attempt.state, "published", "the attempt converged to published — the disposition the REF proves");
  assert.equal(attempt.publishedSha, attempt.candidateSha, "AD-6: what landed IS the recorded candidate");
  assert.equal(readTargetSha(target), attempt.publishedSha, "the target ref carries it");
  assert.notEqual(readTargetSha(target), base, "the target moved off the base");

  // REF, INDEX AND WORKTREE. The checkout the lost window interrupted was re-run.
  assert.equal(readFileSync(join(repo, "src/feature.ts"), "utf8"), "the agent's output\n", "the worktree converged");
  assert.equal(git(repo, ["status", "--porcelain"]), "", "index and worktree agree with the ref — the target is CLEAN");

  // THE TASK. One disposition, matching the publication.
  assert.equal(task.status, "complete", `the task must land on the truth its publication recorded: ${task.error ?? ""}`);
  assert.equal(result.failedSteps.length, 0, "no failed step");
  assert.deepEqual(result.awaitingRecovery, [], "nothing was left awaiting recovery — it converged in-run");
  assert.equal(result.completedSteps.includes("build"), true);

  // NO PREMATURE TERMINAL CLAIM. Not at any point, not in the event stream.
  const events = eventTypes(task.id);
  assert.equal(events.includes("task.failed"), false, "the task was NEVER failed");
  assert.equal(events.includes("publication.refused"), false, "and no refusal was ever recorded over a publishing attempt");
  assert.equal(events.includes("publication.window_lost"), true, "the lost window IS recorded — as what it was");
  assert.equal(failureKindForTask(task.id), undefined, "there is no failure kind: nothing failed");

  assertNoFalseUnpublishedClaim(operatorSurfaces(runId, task.id));
});

// ─── (2) the bounded-wait fallback: RECOVERABLE, never a terminal refusal ─────
//
// The window does not come back within the bound. There is still no terminal truth to
// tell — and the one thing forge may not do is invent one. The task lands in an
// explicit RECOVERABLE state and STAYS there until convergence settles the attempt.

test("FG-425 (AC5): a window that never frees yields a NON-TERMINAL awaiting_recovery — never a terminal refusal over a `publishing` attempt", async () => {
  const repo = makeRepo();
  const target = localTargetFor(projectIdentity(repo).canonicalDir);
  const { runId } = startRun({ workflow: WORKFLOW, title: "ac5-pending", projectDir: repo, inputs: {} });

  const { thief } = stealWindowAfterRefAdvance(repo); // held, never released
  const result = await runNext({ runId: runId, workflow: WORKFLOW, dockerExec: stubExec("src/feature.ts") });

  const task = primaryOf(runId);
  const attempt = publicationAttemptsForTask(task.id)[0]!;

  // THE INVARIANT. A terminal refusal may never be returned over a `publishing` attempt.
  assert.equal(attempt.state, "publishing", "the attempt is still inside the window — nothing terminalized it");
  assert.equal(readTargetSha(target), attempt.candidateSha, "and the ref DOES carry the candidate");
  assert.equal(task.status, "awaiting_recovery", "so the task is RECOVERABLE, not failed");
  assert.deepEqual(result.awaitingRecovery, ["build"], "and `forge next` reports it apart from failures");
  assert.deepEqual(result.failedSteps, [], "it is NOT a failed step");

  const events = eventTypes(task.id);
  assert.equal(events.includes("task.failed"), false, "NO premature task failure");
  assert.equal(events.includes("publication.refused"), false, "NO refusal recorded");
  assert.equal(failureKindForTask(task.id), undefined, "and therefore no publication_refused failure kind");

  // THE OPERATOR SURFACES. Every one of them, and none may claim nothing landed.
  const surfaces = operatorSurfaces(runId, task.id);
  assertNoFalseUnpublishedClaim(surfaces);
  assert.match(
    deriveNextCommandForTask(task.status, undefined, task.id),
    /do NOT retry/i,
    "`forge show`'s next-command must steer AWAY from the retry that would duplicate published work",
  );
  assert.match(adviseRun(getRun(runId)!, tasksForRun(runId)).summary, /may ALREADY be published/i);
  assert.match(publicationRecoveryMessage(attempt), /UNSETTLED/);

  // AND NO RETRY CAN GET PAST IT.
  await assert.rejects(
    () => retry(task.id),
    /may ALREADY be published|publish it twice/i,
    "`forge retry` must refuse an unsettled publication by name",
  );
  // Nor a gate — force-advancing would write a terminal row over a `publishing` attempt.
  await assert.rejects(
    () => doGate(task.id, "advance", "override", { force: true }),
    /not settled|nothing to gate/i,
    "`forge gate --force` must refuse it too: there is no human decision that settles a publication",
  );

  // ── the window closes. The NEXT wave converges and reconciles. ──────────────
  releasePublicationMutex(projectIdentity(repo).key, thief);
  setPublisherSeamsForTest({});
  const after = await runNext({ runId: runId, workflow: WORKFLOW, dockerExec: stubExec("src/feature.ts") });

  const settled = getTask(task.id)!;
  const converged = publicationAttemptsForTask(task.id)[0]!;
  assert.equal(converged.state, "published", "AD-5 convergence settled the attempt from the three SHAs");
  assert.equal(settled.status, "complete", "and the TASK was reconciled onto it — the contradiction never stands");
  assert.equal(readTargetSha(target), converged.publishedSha, "the ref carries the candidate");
  assert.equal(readFileSync(join(repo, "src/feature.ts"), "utf8"), "the agent's output\n", "worktree converged");
  assert.equal(git(repo, ["status", "--porcelain"]), "", "index and worktree agree — the target is clean");
  assert.equal(
    eventTypes(task.id).includes("task.publication_reconciled"),
    true,
    "and the reconciliation is on the durable record, not merely implied by the status",
  );
  assert.equal(after.runStatus, "complete", "the RUN reaches the matching truthful state too");
  assert.equal(publicationAttemptsForTask(task.id).length, 1, "and nothing was published a second time");
});

// ─── (2b) the HAND half: `forge publish recover` settles the TASK too ────────
//
// The ADR names two mechanisms that clear `awaiting_recovery`: the next `forge next`,
// and `forge publish recover` by hand. The hand one used to be only HALF a recovery —
// it converged the attempt and synchronized the target, then left the task that owns
// it parked in `awaiting_recovery` with `forge show` still calling the publication
// unsettled, until some later wave happened to run the other half. A `published`
// attempt beside a task that disagrees with it is the SAME contradiction AC5 forbids;
// it just arrives by a different door. So: NO `forge next` runs after the recovery in
// this test. The hand command settles the attempt, the task, the run and the operator
// surfaces on its own, or it is not the mechanism the ADR says it is.

test("FG-425 (AC4): `forge publish recover` is the WHOLE recovery — it converges the attempt AND reconciles the owning task, with no `forge next` after it", async () => {
  ensureWorkflowOnDisk();
  const repo = makeRepo();
  const target = localTargetFor(projectIdentity(repo).canonicalDir);
  const { runId } = startRun({ workflow: WORKFLOW, title: "ac4-hand-recovery", projectDir: repo, inputs: {} });

  // Held, never released: the wave's bounded wait gives up and parks the task.
  const { thief } = stealWindowAfterRefAdvance(repo);
  await runNext({ runId: runId, workflow: WORKFLOW, dockerExec: stubExec("src/feature.ts") });

  const task = primaryOf(runId);
  const unsettled = publicationAttemptsForTask(task.id)[0]!;
  assert.equal(unsettled.state, "publishing", "precondition: the attempt is unsettled INSIDE the window");
  assert.equal(task.status, "awaiting_recovery", "precondition: and its task is parked on it");
  assert.match(
    publicationRecoveryMessage(unsettled),
    /publish recover/,
    "precondition: `forge show` points the operator at the HAND command — so that command had better finish the job",
  );

  // The crashed holder's lease lapses (a durable timestamp — AD-7; never a probe), and
  // the operator types exactly what forge told them to. Nothing else runs.
  releasePublicationMutex(projectIdentity(repo).key, thief);
  setPublisherSeamsForTest({});
  const { outcome, task: reported } = recoverPublicationByHand(unsettled.attemptId);

  // THE PUBLICATION — converged from the three SHAs, and the target synchronized.
  const attempt = publicationAttemptsForTask(task.id)[0]!;
  assert.equal(outcome.kind, "published", "AD-5 convergence settled the attempt");
  assert.equal(attempt.state, "published");
  assert.equal(attempt.publishedSha, attempt.candidateSha, "AD-6: what landed IS the recorded candidate");
  assert.equal(readTargetSha(target), attempt.publishedSha, "the target ref carries it");
  assert.equal(readFileSync(join(repo, "src/feature.ts"), "utf8"), "the agent's output\n", "the worktree converged");
  assert.equal(git(repo, ["status", "--porcelain"]), "", "index and worktree agree with the ref — the target is CLEAN");

  // THE DURABLE TASK AND CAMPAIGN — the half that used to be missing.
  const settled = getTask(task.id)!;
  assert.equal(settled.status, "complete", `the TASK was reconciled by the hand command itself: ${settled.error ?? ""}`);
  assert.equal(
    eventTypes(task.id).includes("task.publication_reconciled"),
    true,
    "and the reconciliation is on the durable record, not merely implied by the status",
  );
  assert.equal(getRun(runId)!.status, "complete", "the RUN reaches the matching truthful state — without another wave");
  assert.equal(publicationAttemptsForTask(task.id).length, 1, "nothing was published a second time");

  // WHAT THE OPERATOR IS TOLD — by the command itself, and by every surface after it.
  assert.deepEqual(
    reported,
    { taskId: task.id, runId, status: "complete" },
    "`forge publish recover` reports the task it reconciled — the operator never has to go look",
  );
  const surfaces = operatorSurfaces(runId, task.id);
  assertNoFalseUnpublishedClaim(surfaces);
  for (const s of surfaces) {
    assert.doesNotMatch(s, /UNSETTLED/i, `a surface still calls the publication unsettled after recovery:\n  "${s}"`);
    assert.doesNotMatch(s, /publish recover/, `a surface still tells the operator to recover what is already recovered:\n  "${s}"`);
  }

  // IDEMPOTENT. Re-running it re-derives nothing and un-completes nothing.
  const again = recoverPublicationByHand(unsettled.attemptId);
  assert.equal(again.outcome.kind, "published", "the RECORDED disposition is reported, not re-derived");
  assert.equal(publicationAttemptsForTask(task.id)[0]!.publishedSha, attempt.publishedSha, "the publishedSha is never rewritten");
  assert.equal(getTask(task.id)!.status, "complete", "and the task stays complete");
  assert.equal(readTargetSha(target), attempt.publishedSha, "the target ref is untouched by the second run");
});

// ─── (3) retry safety ─────────────────────────────────────────────────────────

test("FG-425 (AC5): a re-dispatch that meets an attempt already recorded `published` does NOT re-publish", async () => {
  const repo = makeRepo();
  const target = localTargetFor(projectIdentity(repo).canonicalDir);
  const { runId } = startRun({ workflow: WORKFLOW, title: "ac5-retry-safety", projectDir: repo, inputs: {} });

  await runNext({ runId: runId, workflow: WORKFLOW, dockerExec: stubExec("src/feature.ts") });
  const task = primaryOf(runId);
  const published = publicationAttemptsForTask(task.id)[0]!;
  assert.equal(published.state, "published", "precondition: the work landed");
  const refAfterPublish = readTargetSha(target);

  // (a) THE PUBLISHER ITSELF is idempotent per task: re-driving the publication step —
  //     what a gate-forced re-entry and the reconciler both do — republishes NOTHING.
  const again = await publishIntegration({
    runId: runId,
    taskId: task.id,
    projectDir: repo,
    sources: [{ branch: `forge/${runId}/${task.id}`, label: "re-drive" }],
    lane: { pollMs: 10, log: () => {} },
    alsoValidate: (): ValidationResult => ({ ok: true }),
  });
  assert.equal(again.kind, "published", "it reports the publication that already landed");
  if (again.kind !== "published") return;
  assert.equal(again.attemptId, published.attemptId, "the SAME attempt — no second one was ever recorded");
  assert.equal(
    publicationAttemptsForTask(task.id).length,
    1,
    "no new publication intent: a task whose work is on the target must not enqueue another attempt",
  );
  assert.equal(readTargetSha(target), refAfterPublish, "and the target ref did not move");
  assert.equal(
    eventTypes(task.id).includes("publication.already_published"),
    true,
    "the no-op is on the record — an operator can see WHY nothing happened",
  );

  // (b) `forge retry` refuses outright, naming the published SHA. It mints a NEW task
  //     id, so the publisher's per-task guard could never see it — the refusal has to
  //     live here, where the lineage is still visible.
  await assert.rejects(
    () => retry(task.id),
    (e: Error) => {
      assert.equal(e instanceof PublishedTaskRetryError, true, `expected PublishedTaskRetryError, got ${e.name}`);
      assert.match(e.message, /ALREADY published/);
      assert.match(e.message, new RegExp(published.publishedSha!.slice(0, 12)));
      return true;
    },
  );
  assert.equal(readTargetSha(target), refAfterPublish, "the refused retry moved nothing");
});

// ─── (4) the contradiction is REPAIRED, however it arrived ────────────────────
//
// A `published` attempt whose task says `failed` is the defect itself — the shape a
// pre-fix build wrote on every lost window, and the shape a crash between the
// publisher returning and the task landing can still produce. The rule is about the
// CONTRADICTION, not about how it got there: convergence reconciles the owning task.

test("FG-425 (AC5): a task recorded `failed` beside a `published` attempt is RECONCILED onto the truth — the contradiction never survives a wave", async () => {
  const repo = makeRepo();
  const target = localTargetFor(projectIdentity(repo).canonicalDir);
  const { runId } = startRun({ workflow: WORKFLOW, title: "ac5-repair", projectDir: repo, inputs: {} });

  await runNext({ runId: runId, workflow: WORKFLOW, dockerExec: stubExec("src/feature.ts") });
  const task = primaryOf(runId);
  const attempt = publicationAttemptsForTask(task.id)[0]!;
  assert.equal(attempt.state, "published", "precondition: the candidate landed");

  // Forge the exact contradictory pair the old code produced: the publication stands,
  // the task claims it failed with nothing published.
  db.prepare(`UPDATE tasks SET status = 'failed', error = ? WHERE id = ?`).run(
    "publication was refused: nothing was published; the target is unchanged",
    task.id,
  );
  db.prepare(`UPDATE runs SET status = 'active' WHERE id = ?`).run(runId);
  assert.equal(getTask(task.id)!.status, "failed", "precondition: the contradiction is in the DB");

  await runNext({ runId: runId, workflow: WORKFLOW, dockerExec: stubExec("src/feature.ts") });

  const repaired = getTask(task.id)!;
  assert.equal(repaired.status, "complete", "the task was reconciled onto the publication that actually landed");
  assert.equal(
    eventTypes(task.id).includes("task.publication_reconciled"),
    true,
    "and the repair is durable and auditable, not silent",
  );
  assert.equal(publicationAttemptsForTask(task.id).length, 1, "nothing was republished to repair it");
  assert.equal(readTargetSha(target), attempt.publishedSha, "and the target ref is untouched by the repair");
  assertNoFalseUnpublishedClaim(operatorSurfaces(runId, task.id));
});

// ─── (5) a REAL refusal still fails the task ─────────────────────────────────
//
// The fix must not make refusals unfalsifiable. When the ref genuinely does NOT carry
// the candidate, `publication_refused` is the truth — and "nothing was published; the
// target is unchanged" is then exactly what the operator must be told.

test("FG-425 (AC5): an attempt whose ref advance never landed still converges to a TERMINAL refusal — the fix does not make every publication un-failable", async () => {
  const repo = makeRepo();
  const { runId } = startRun({ workflow: WORKFLOW, title: "ac5-true-refusal", projectDir: repo, inputs: {} });
  const base = git(repo, ["rev-parse", "HEAD"]);
  const target = localTargetFor(projectIdentity(repo).canonicalDir);

  // The publisher records the intent and dies BEFORE the CAS: the ref is still at base.
  // AD-5 convergence reads that off the three SHAs and abandons the attempt — nothing
  // of it is on the target, and the task must say so.
  await runNext({ runId: runId, workflow: WORKFLOW, dockerExec: stubExec("src/feature.ts") });
  const task = primaryOf(runId);
  const attempt = publicationAttemptsForTask(task.id)[0]!;

  db.prepare(`UPDATE publication_attempts SET state = 'publishing', published_sha = NULL WHERE attempt_id = ?`)
    .run(attempt.attemptId);
  db.prepare(`UPDATE tasks SET status = 'awaiting_recovery' WHERE id = ?`).run(task.id);
  db.prepare(`UPDATE runs SET status = 'active' WHERE id = ?`).run(runId);
  git(repo, ["reset", "--hard", base]); // the ref never carried the candidate
  assert.equal(readTargetSha(target), base, "precondition: the target sits at the validated base");

  await runNext({ runId: runId, workflow: WORKFLOW, dockerExec: stubExec("src/feature.ts") });

  const settled = getTask(task.id)!;
  assert.equal(settled.status, "failed", "nothing landed, so this IS a terminal failure");
  assert.equal(failureKindForTask(task.id), "publication_refused", "with the truthful kind");
  assert.equal(publicationAttemptsForTask(task.id)[0]!.state, "abandoned", "and the attempt is settled, not left publishing");
  assert.match(
    retryPolicy(failureKindForTask(task.id), task.id).reason,
    /[Nn]othing was published/,
    "and HERE the retry advice SHOULD say nothing was published — because nothing was",
  );
});

// ─── (6) a CANCEL is terminal, and recovery may never resurrect it ────────────
//
// THE DEFECT THIS PINS (round 2 of the AC5 fix). The repair above was scoped to "a
// `failed` task beside a `published` attempt is the contradiction, however it arrived".
// That is true of a crash-stranded row. It is FALSE of a row that is failed because a
// HUMAN CANCELLED IT — there the terminal state is intent, not damage. `forge cancel`
// writes exactly that failed row, so a cancel that races a lost-window publication was
// later OVERRIDDEN: reconciliation walked the cancelled task back through
// awaiting_recovery and COMPLETED it. A cancel that a background sweep can undo is not
// a cancel.
//
// The two properties are BOTH non-negotiable, and the fix must not trade one for the
// other: the cancel STANDS (terminal, never resurrected), AND the operator is still
// told the candidate is on the target — silence there would just re-create the AC5
// contradiction from the cancel direction.
//
// The cancel is driven through the PRODUCTION path (`performCancel`, the function
// `forge cancel` calls), and the distinction is read from the durable evidence it
// writes — never inferred from `failed`, which is the same status both ways.

/** The operator cancels this task, exactly as `forge cancel <taskId>` does. The docker
 *  kill is the only thing stubbed: there is no container in this test. */
function cancelTask(taskId: string): void {
  const outcome = performCancel(taskId, {}, () => {}, () => false);
  assert.equal(outcome.kind, "task-cancelled", `precondition: the cancel must land: ${JSON.stringify(outcome)}`);
}

test("FG-425: a CANCELLED task whose publication then converges to `published` STAYS cancelled — recovery never resurrects it, and the operator is still told the candidate landed", async () => {
  const repo = makeRepo();
  const target = localTargetFor(projectIdentity(repo).canonicalDir);
  const { runId } = startRun({ workflow: WORKFLOW, title: "cancel-vs-recovery", projectDir: repo, inputs: {} });

  // The window is lost after the ref advance and never comes back inside the wave, so
  // the task parks in awaiting_recovery over an attempt still `publishing`.
  const { thief } = stealWindowAfterRefAdvance(repo);
  await runNext({ runId: runId, workflow: WORKFLOW, dockerExec: stubExec("src/feature.ts") });

  const task = primaryOf(runId);
  assert.equal(task.status, "awaiting_recovery", "precondition: the task is parked on an unsettled publication");
  assert.equal(publicationAttemptsForTask(task.id)[0]!.state, "publishing", "precondition: the attempt is unsettled");

  // THE HUMAN DECIDES: stop this. `forge cancel` fails the task with kind `cancelled`
  // and writes the task.cancelled event — the durable evidence a crash cannot forge.
  cancelTask(task.id);
  const cancelled = getTask(task.id)!;
  assert.equal(cancelled.status, "failed", "precondition: a cancel lands as a terminal `failed` row");
  assert.equal(failureKindForTask(task.id), "cancelled", "precondition: with the cancelled failure kind");
  assert.equal(eventTypes(task.id).includes("task.cancelled"), true, "precondition: and the durable cancel event");

  // The window frees and a wave runs. AD-5 converges the ATTEMPT from the ref (it
  // carries the candidate — that is durable fact, and the record must say so).
  releasePublicationMutex(projectIdentity(repo).key, thief);
  setPublisherSeamsForTest({});
  await runNext({ runId: runId, workflow: WORKFLOW, dockerExec: stubExec("src/feature.ts") });

  // THE INVARIANT: the cancel WON.
  const after = getTask(task.id)!;
  assert.equal(after.status, "failed", "the cancelled task is STILL terminal — recovery did not resurrect it");
  assert.equal(failureKindForTask(task.id), "cancelled", "and it is still recorded as a cancel, not re-kinded");
  const events = eventTypes(task.id);
  assert.equal(
    events.includes("task.publication_reconciled"),
    false,
    "the cancelled task was NEVER walked onto the publication — no reconciliation was recorded for it",
  );
  assert.equal(
    events.lastIndexOf("task.awaiting_recovery") < events.indexOf("task.cancelled"),
    true,
    "and it was never pushed back through awaiting_recovery after the cancel",
  );
  assert.equal(events.includes("task.completed"), false, "the cancelled task was never completed");
  // NOR IS THE RUN RESURRECTED THROUGH IT. (The run does reach `complete` — that is
  // forge's SETTLED semantics, which any terminally-failed step produces, cancel or
  // not. What must never happen is the cancelled work being counted as done or quietly
  // re-driven: no completed primary in the phase, and no replacement task minted to
  // redo what the human just stopped.)
  const primaries = tasksForRun(runId).filter((t) => t.phase === "build" && t.parentId === undefined);
  assert.deepEqual(primaries.map((t) => t.id), [task.id], "no replacement primary was dispatched to redo the cancelled work");
  assert.equal(primaries.every((t) => t.status !== "complete"), true, "and the cancelled phase has NO completed primary");

  // AND THE PUBLICATION RECORD STILL TELLS THE TRUTH: the candidate IS on the target.
  const attempt = publicationAttemptsForTask(task.id)[0]!;
  assert.equal(attempt.state, "published", "the attempt converged to the disposition the REF proves");
  assert.equal(attempt.publishedSha, attempt.candidateSha, "AD-6: what landed IS the recorded candidate");
  assert.equal(readTargetSha(target), attempt.publishedSha, "and the target ref carries it");
  assert.equal(publicationAttemptsForTask(task.id).length, 1, "nothing was published a second time");

  // THE OPERATOR IS TOLD. Cancelling did not un-publish the candidate, and no surface
  // may imply it did — the same AC5 rule, arriving from the cancel direction.
  const surfaces = operatorSurfaces(runId, task.id);
  const shown = publicationAfterCancelMessage(attempt);
  assertNoFalseUnpublishedClaim([...surfaces, shown]);
  assert.match(shown, new RegExp(attempt.publishedSha!.slice(0, 12)), "the published sha is discoverable in what forge RENDERS");
  assert.match(shown, /ALREADY CARRIES/, "and it says plainly that the target carries this task's work");
  assert.equal(
    eventTypes(task.id).includes("task.published_after_cancel"),
    true,
    "and it is on the durable record too — not only in a rendered string",
  );

  // IDEMPOTENT: a second wave neither resurrects the task nor re-announces the event.
  await runNext({ runId: runId, workflow: WORKFLOW, dockerExec: stubExec("src/feature.ts") });
  assert.equal(getTask(task.id)!.status, "failed", "still cancelled after another wave");
  assert.equal(
    eventTypes(task.id).filter((e) => e === "task.published_after_cancel").length,
    1,
    "and the announcement is made ONCE, not once per wave",
  );
});

test("FG-425: `forge publish recover` on a CANCELLED task converges the attempt but REFUSES to resurrect the task — and reports the sha that landed", async () => {
  ensureWorkflowOnDisk();
  const repo = makeRepo();
  const target = localTargetFor(projectIdentity(repo).canonicalDir);
  const { runId } = startRun({ workflow: WORKFLOW, title: "cancel-vs-hand-recovery", projectDir: repo, inputs: {} });

  const { thief } = stealWindowAfterRefAdvance(repo);
  await runNext({ runId: runId, workflow: WORKFLOW, dockerExec: stubExec("src/feature.ts") });
  const task = primaryOf(runId);
  const unsettled = publicationAttemptsForTask(task.id)[0]!;
  assert.equal(unsettled.state, "publishing", "precondition: the attempt is unsettled");

  cancelTask(task.id);
  releasePublicationMutex(projectIdentity(repo).key, thief);
  setPublisherSeamsForTest({});

  // The hand half of recovery — the other door into the same reconciliation. It must
  // refuse the resurrection too, or the guard is only half a guard.
  const { outcome, task: reported, publishedAfterCancel } = recoverPublicationByHand(unsettled.attemptId);

  assert.equal(outcome.kind, "published", "AD-5 convergence settles the ATTEMPT — the ref carries the candidate");
  const attempt = publicationAttemptsForTask(task.id)[0]!;
  assert.equal(attempt.state, "published");
  assert.equal(readTargetSha(target), attempt.publishedSha, "the target ref carries it");

  const settled = getTask(task.id)!;
  assert.equal(settled.status, "failed", "the CANCELLED task is not resurrected by the hand command either");
  assert.equal(failureKindForTask(task.id), "cancelled", "and it is still a cancel");
  assert.equal(reported, undefined, "so there is no 'reconciled onto it' to report — nothing was reconciled");
  assert.notEqual(publishedAfterCancel, undefined, "instead the operator is told the candidate landed anyway");
  assert.equal(publishedAfterCancel!.publishedSha, attempt.publishedSha, "naming the sha that is on the target");
  assert.equal(publishedAfterCancel!.taskId, task.id);
  assert.equal(
    eventTypes(task.id).includes("task.publication_reconciled"),
    false,
    "and no reconciliation was recorded over the cancel",
  );
});

// ─── (7) FG-676: a GATE REJECTION is a decision too, and reconcile may not undo it ──
//
// THE DEFECT THIS PINS. (6) established the rule for a cancel; this is the same rule
// arriving through the other human verb, and it was NOT covered. `forge gate <task>
// request-changes` fails the superseded task — and then a later publication-reconcile
// sweep walked it back through awaiting_recovery and landed it, through the step's own
// `human` gate, at `awaiting_gate` with its error NULLed. The row then contradicted its
// own event stream (`status: awaiting_gate` beside `failure: gate_rejected`), and it was
// a PHANTOM BLOCKER: no agent ever runs for a task in that state and no gate decision
// resolves it, so a run that took one request-changes could never reach `complete`.
// Observed 4/4 times on run run-fg-609-…-99204e and once on run-fg-678-…-6745ba.
//
// The writer swap the ticket originally named would NOT have caught it: the reconcile
// path deliberately launders `failed` to `awaiting_recovery` before the finalizer's CAS
// can see it, so the CAS passes. The fix is in the SELECTION predicate, and only a test
// that drives the SWEEP proves it — a writer-level unit test passes against an unfixed
// system.
//
// Repeated reconciliation is not optional here. Today the second sweep is a no-op only
// because the first already moved the row out of the selection set, so a test asserting
// "still terminal" after ONE sweep proves less than it appears to. This drives two waves
// AND the hand door, then lets the replacement primary finish the run.

function buildPrimaries(runId: string) {
  return tasksForRun(runId).filter((t) => t.phase === "build" && t.parentId === undefined);
}

function awaitingADecision(runId: string): string[] {
  return tasksForRun(runId).filter((t) => t.status === "awaiting_gate").map((t) => t.id);
}

/** Every event index of `type` that falls AFTER the task's last task.failed. The
 *  resurrection was invisible in a bare `includes` check — the rejected task legitimately
 *  carries a task.awaiting_gate from BEFORE the human decided. */
function eventsAfterLastFailure(taskId: string, type: string): number {
  const types = eventTypes(taskId);
  const failedAt = types.lastIndexOf("task.failed");
  assert.notEqual(failedAt, -1, `precondition: ${taskId} must carry a task.failed`);
  return types.slice(failedAt + 1).filter((t) => t === type).length;
}

test("FG-676: a gate `request-changes` task whose publication is `published` STAYS terminal across repeated reconciliation — and its run still reaches complete through the replacement", async () => {
  ensureWorkflowOnDisk(HUMAN_GATE_WORKFLOW);
  const repo = makeRepo();
  const target = localTargetFor(projectIdentity(repo).canonicalDir);
  const { runId } = startRun({ workflow: HUMAN_GATE_WORKFLOW, title: "fg676-request-changes", projectDir: repo, inputs: {} });

  // ── WAVE 1: the production sequence, not a fabrication. A real dispatch against a
  //    real git repo, a real candidate published to the real target, and the
  //    human-gated step parking on it.
  const wave1 = await runNext({ runId, workflow: HUMAN_GATE_WORKFLOW, dockerExec: stubExec("src/feature.ts") });
  assert.deepEqual(wave1.awaitingGate, ["build"], "precondition: the human gate parked the primary");

  const rejected = buildPrimaries(runId)[0]!;
  const attempt = publicationAttemptsForTask(rejected.id)[0]!;
  assert.equal(attempt.state, "published", "precondition: a REAL publication attempt, published — nothing fabricated");
  assert.equal(readTargetSha(target), attempt.publishedSha, "precondition: the target ref carries the candidate");
  assert.equal(getTask(rejected.id)!.status, "awaiting_gate", "precondition: parked for the human");
  const publishedResult = getTask(rejected.id)!.result;

  // ── THE HUMAN DECIDES: request-changes. The superseded task is failed with its
  //    rationale, and a replacement primary is minted in the SAME step.
  const { nextTasks } = await doGate(rejected.id, "request-changes", "the migration is missing");
  const replacement = nextTasks[0]!;
  const decided = getTask(rejected.id)!;
  assert.equal(decided.status, "failed", "precondition: request-changes fails the superseded task");
  assert.equal(decided.error, "request-changes; superseded", "precondition: with the error on the row");
  assert.equal(failureKindForTask(rejected.id), "gate_rejected", "precondition: recorded as a gate rejection");
  assert.deepEqual(decided.result, publishedResult, "precondition: and the rejected ARTIFACT is preserved on the row");
  assert.notEqual(replacement.id, rejected.id, "precondition: a distinct replacement primary was minted");
  // The row is now in reconcile's selection set — `failed` beside a `published`
  // attempt — which is precisely how the resurrection got its hands on it.
  assert.equal(publicationAttemptsForTask(rejected.id)[0]!.state, "published");

  // ── SWEEP 1 (a wave). It also dispatches the replacement, which publishes its own
  //    candidate — the run carries on exactly as it does in production.
  await runNext({ runId, workflow: HUMAN_GATE_WORKFLOW, dockerExec: stubExec("src/revision.ts") });
  assertRejectedRowIntact(rejected.id, publishedResult, "after the first reconcile sweep");

  // ── SWEEP 2 (a second wave). NOT redundant: after the fix the row is still IN the
  //    selection set on every sweep, so this is the pass that would have caught a guard
  //    that only worked because the first sweep moved the row out of it.
  await runNext({ runId, workflow: HUMAN_GATE_WORKFLOW, dockerExec: stubExec("src/never-dispatched.ts") });
  assertRejectedRowIntact(rejected.id, publishedResult, "after the second reconcile sweep");

  // ── THE HAND DOOR. `forge publish recover` runs the SAME reconciliation from outside
  //    a wave; a guard that only lives on the wave path is half a guard.
  const hand = recoverPublicationByHand(attempt.attemptId);
  assert.equal(hand.outcome.kind, "published", "the attempt is settled — the hand path re-derives nothing");
  assert.equal(hand.publishedAfterCancel, undefined, "this was not a cancel, so no published-after-cancel report");
  assert.equal(hand.task?.status, "failed", "and what it reports about the task is the TRUTH, not a resurrection");
  assertRejectedRowIntact(rejected.id, publishedResult, "after `forge publish recover`");

  // ── EXACTLY ONE TASK AWAITING A DECISION. The whole operational cost of the defect:
  //    `forge show <run>` listed the superseded revision under Blockers alongside the
  //    live one, so an operator saw two decisions owed where only one was real.
  assert.deepEqual(
    awaitingADecision(runId),
    [replacement.id],
    "exactly ONE task awaits a human decision — the live replacement, never the superseded revision",
  );

  // ── THE REPLACEMENT COMPLETES, and the run reaches `complete` WITH the rejected row
  //    still terminal beside it. Preserving the audit record and unblocking the run are
  //    both required; neither may be traded for the other.
  await doGate(replacement.id, "advance", undefined);
  const finalWave = await runNext({ runId, workflow: HUMAN_GATE_WORKFLOW, dockerExec: stubExec("src/never-dispatched.ts") });
  assert.equal(getTask(replacement.id)!.status, "complete", "the replacement finished");
  assert.equal(getRun(runId)!.status, "complete", "and the RUN reached complete — no phantom blocker held it open");
  assert.equal(finalWave.runStatus, "complete");
  assert.deepEqual(awaitingADecision(runId), [], "nothing is left awaiting a decision");

  // ── THE AUDIT RECORD SURVIVED ALL OF IT, one last time, at the end state.
  assertRejectedRowIntact(rejected.id, publishedResult, "after the run completed");
  assert.equal(
    buildPrimaries(runId).filter((t) => t.status === "complete").length,
    1,
    "exactly one primary in the phase is complete — the replacement, not the superseded revision",
  );
  assert.equal(publicationAttemptsForTask(rejected.id).length, 1, "and nothing was published a second time for it");
});

/** The rejected row is IMMUTABLE AUDIT HISTORY. Every field the resurrection touched,
 *  plus the event stream that has to keep agreeing with it. Re-asserted after each sweep
 *  rather than once at the end: "still terminal at the end" would pass a system that
 *  resurrected the row and then happened to put it back. */
function assertRejectedRowIntact(taskId: string, expectedResult: unknown, when: string): void {
  const row = getTask(taskId)!;
  assert.equal(row.status, "failed", `${when}: the gate-rejected row must still be terminal`);
  assert.equal(row.error, "request-changes; superseded", `${when}: its error must never be NULLed`);
  assert.deepEqual(row.result, expectedResult, `${when}: the rejected artifact must be carried through unchanged`);
  assert.equal(failureKindForTask(taskId), "gate_rejected", `${when}: still a gate rejection`);
  assert.equal(
    eventsAfterLastFailure(taskId, "task.awaiting_gate"),
    0,
    `${when}: NO awaiting-gate event may be appended after the rejection — that is the phantom blocker`,
  );
  assert.equal(
    eventsAfterLastFailure(taskId, "task.publication_reconciled"),
    0,
    `${when}: and no reconciliation may be recorded over a human's decision`,
  );
  assert.equal(
    eventTypes(taskId).includes("task.completed"),
    false,
    `${when}: the superseded revision was never completed`,
  );
}
