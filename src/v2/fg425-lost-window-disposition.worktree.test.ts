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
import { deriveNextCommandForTask, deriveNextCommandForRun, publicationRecoveryMessage } from "../cli/commands/show.js";
import type { Workflow } from "./schema.js";

const WORKFLOW: Workflow = {
  name: "fg425-ac5-test",
  description: "FG-425 AC5: one truthful disposition after a lost mutex",
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
}

/** `forge publish recover` runs OUTSIDE a wave: it has an attempt id and nothing else,
 *  so it reloads the run's workflow from disk exactly as `forge next` does. The
 *  installed YAML is therefore part of the production shape this test drives. */
function ensureWorkflowOnDisk(): void {
  const path = join(process.env.FORGE_HOME!, "workflows", `${WORKFLOW.name}.yml`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    `name: ${WORKFLOW.name}
description: ${JSON.stringify(WORKFLOW.description)}
inputs: []
steps:
  - id: build
    agent: engineer
    gate: auto
    runtime: fg425-ac5-test
`,
  );
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
    git(mount, ["commit", "-q", "-m", "primary output"]);
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
