// FG-425 (AC5), the CAMPAIGN half: one truthful disposition after a lost publication
// window — asserted on the CAMPAIGN ITEM, through the production campaign path.
//
// WHY THIS FILE EXISTS. AC5 requires that the owning task, the run AND the campaign
// item all reach a mutually truthful state after a lost-window publication. The task
// and run halves are pinned by src/v2/fg425-lost-window-disposition.worktree.test.ts.
// The campaign half was asserted BY CONSTRUCTION only: executor.ts's new
// `awaiting_recovery` branch (the recoveringTask park) had no production-path
// regression behind it — the only campaign tests naming `awaitingRecovery` were
// fixture runNext stubs returning an empty array, which can never exercise the branch
// and can never notice if the branch is wrong.
//
// So this file drives the REAL thing, and nothing here is hand-written into the DB:
//
//   * a REAL campaign (planCampaign → approveCampaign → startCampaign) over a REAL
//     git repo and a REAL backlog ticket;
//   * a REAL workflow run, driven by the REAL executor drive loop into the REAL
//     runNext, which reaches the REAL publishIntegration;
//   * a REAL lost window — the publisher's ref advance LANDS and its durable lease is
//     then taken over (the AD-7 durable-timestamp takeover, the only mechanism there
//     is: nothing is probed, signalled, nonced or reaped);
//   * REAL recovery, driven the way the code actually invokes it, and the way the
//     item's own requestedHumanAction tells the operator to invoke it.
//
// Only the docker exec boundary is stubbed — the project's standard DockerExecFn
// injection seam. The publisher, the lane, the mutex, the AD-5 convergence, the
// executor drive loop and the campaign store are all the production article.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { writeTicket } from "../backlog/structured.js";
import { approveCampaign, getCampaign, getCampaignItem, listCampaignItems } from "../store/campaigns.js";
import { getRun } from "../store/runs.js";
import { getTask, tasksForRun } from "../store/tasks.js";
import { eventsForTask } from "../store/events.js";
import {
  publicationAttemptsForTask,
  releasePublicationMutex,
  setPublicationClockOffsetForTest,
  tryAcquirePublicationMutex,
} from "../store/publications.js";
import { failureKindForTask } from "../v2/failure-kind.js";
import { projectIdentity } from "../v2/project-identity.js";
import { localTargetFor, readTargetSha } from "../v2/publication-target.js";
import { MUTEX_TTL_MS, setPublisherSeamsForTest } from "../v2/integration-publisher.js";
import { runNext, type DockerExecFn, type RunNextResult } from "../v2/runNext.js";
import { publishFlatAsGeneration } from "../v2/seed-generation.testkit.js";
import type { Workflow } from "../v2/schema.js";
import type { InvokeArgs, InvokeResult } from "../v2/invoke.js";
import { planCampaign, type ItemModeOverride } from "./planner.js";
import { startCampaign, resumeCampaign, setExecutorDoneAuditMapForTest } from "./executor.js";

const RUNTIME_NAME = "fg425-campaign-runtime";
const WORKFLOW_NAME = "fg425-campaign-feature";
const TICKET_ID = "FG-900";
const AGENT_FILE = "src/feature.ts";
const AGENT_OUTPUT = "the agent's output\n";

let db: DatabaseInstance;
let prev: DatabaseInstance | null;
let projectDir: string;

const ENV_VARS = [
  "FORGE_WORKTREES",
  "FORGE_NO_WORKTREES",
  "FORGE_WORKTREE_IGNORE_DIRTY",
  "FORGE_WORKTREES_EPHEMERAL",
  "ANTHROPIC_API_KEY",
] as const;
const savedEnv: Partial<Record<(typeof ENV_VARS)[number], string>> = {};

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "t@t.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "t@t.com",
    },
  }).trim();
}

/** A real git project with the campaign's backlog ticket COMMITTED — the publish
 *  target must be clean, which is exactly what AD-3's preflight demands of it. */
function makeProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "fg425-campaign-"));
  git(dir, ["init", "-b", "main"]);
  git(dir, ["config", "user.email", "test@forge.test"]);
  git(dir, ["config", "user.name", "Forge Test"]);
  writeFileSync(join(dir, "README.md"), "# test\n");
  writeTicket(dir, {
    id: TICKET_ID,
    type: "story",
    status: "active",
    title: `${TICKET_ID}: a campaign item whose publication loses the window`,
    body: "## Problem\nThe publication window can be lost after the ref advance.\n\n## Goal\nThe campaign item tells the truth about it.\n\n## Acceptance Criteria\n- The item never claims the work must be retried\n",
  });
  git(dir, ["add", "."]);
  git(dir, ["commit", "-q", "-m", "initial"]);
  return dir;
}

function ensureRuntime(): void {
  const path = join(process.env.FORGE_HOME!, "runtimes", `${RUNTIME_NAME}.yml`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    `name: ${RUNTIME_NAME}
description: FG-425 campaign test runtime stub
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

/** The executor loads the workflow from disk on every drive AND every resume, so the
 *  installed YAML is part of the production shape under test. An AUTHORITATIVE red is
 *  what lets the item legitimately SHIP: it runs inside the publisher (alsoValidate,
 *  against the candidate) BEFORE the ref advance, so its passing verdict is on the
 *  record before the window is ever lost. */
function ensureWorkflow(): void {
  const path = join(process.env.FORGE_HOME!, "workflows", `${WORKFLOW_NAME}.yml`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    `name: ${WORKFLOW_NAME}
description: "FG-425 campaign: a single build step whose publication loses the window"
inputs: []
steps:
  - id: build
    agent: engineer
    gate: auto
    manual: false
    depends_on: []
    runtime: ${RUNTIME_NAME}
    reds:
      - agent: red-narrow
        authority: authoritative
        gate_on_verdict: true
`,
  );
  publishFlatAsGeneration(process.env.FORGE_HOME!);
}

const WORKFLOW: Workflow = {
  name: WORKFLOW_NAME,
  description: "FG-425 campaign: a single build step whose publication loses the window",
  review_mode: "legacy_verdict" as const,
  inputs: [],
  steps: [
    {
      id: "build",
      agent: "engineer",
      gate: "auto",
      manual: false,
      depends_on: [],
      runtime: RUNTIME_NAME,
      reds: [{ agent: "red-narrow", authority: "authoritative", gate_on_verdict: true }],
    },
  ],
};

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

/** Counts how many times the BLUE agent actually ran. The AC's "not executed twice"
 *  is asserted on this: a recovery that re-dispatched the engineer would redo work
 *  whose candidate is already on the target. */
let blueDispatches = 0;

/** The agents. The engineer commits its output on its task branch, exactly as a real
 *  one does; the red passes on the candidate it is shown. */
const stubExec: DockerExecFn = async ({ args, stdoutPath, stderrPath }) => {
  const taskId = extractTaskId(args);
  const dir = dirname(stdoutPath);
  mkdirSync(dir, { recursive: true });
  writeFileSync(stderrPath, "");
  writeFileSync(join(dir, "container.stderr.log"), "");
  writeFileSync(stdoutPath, "stub stdout");

  if (taskId.startsWith("task-red-")) {
    writeFileSync(
      join(dir, "result.json"),
      JSON.stringify({ status: "complete", tests_run: 1, verdict: "pass", confidence: 1, findings: [] }),
    );
    return 0;
  }

  blueDispatches++;
  const mount = findProjectMountHost(args)!;
  mkdirSync(dirname(join(mount, AGENT_FILE)), { recursive: true });
  writeFileSync(join(mount, AGENT_FILE), AGENT_OUTPUT);
  git(mount, ["add", "."]);
  git(mount, ["commit", "-q", "-m", "primary output"]);
  writeFileSync(
    join(dir, "result.json"),
    JSON.stringify({ status: "complete", tests_run: 1, files_modified: [AGENT_FILE] }),
  );
  return 0;
};

/** The REAL runNext with only the docker boundary stubbed, capped against a runaway
 *  drive loop (a test-harness safety net, not a mock of anything under test). */
function makeCappedRunNext(cap: number) {
  let calls = 0;
  return async (args: { runId: string; workflow: Workflow }): Promise<RunNextResult> => {
    if (++calls > cap) {
      throw new Error(`test safety guard: runNext was called ${calls} times in one drive`);
    }
    return runNext({ ...args, dockerExec: stubExec });
  };
}

const dispatchMustNotBeCalled = async (_args: InvokeArgs): Promise<InvokeResult> => {
  throw new Error("opts.dispatch must not be called — full_feature never uses the invoke lane");
};

/** THE LOST WINDOW, induced the way production produces it (the same seam and the same
 *  mechanism as fg425-lost-window-disposition.worktree.test.ts).
 *
 *  The publisher's ref advance has LANDED and its checkout has not run. Its lease is
 *  then taken over — a deschedule longer than the mutex TTL (laptop suspend, SIGSTOP,
 *  a paused container, a long GC stall) is indistinguishable from this, and a durable
 *  lease takeover is the ONLY mechanism AD-7 permits. Held and never released, the
 *  publisher's bounded wait gives up and reports the NON-TERMINAL recovery_pending. */
function stealWindowAfterRefAdvance(dir: string): { thief: string } {
  const thief = "thief-attempt";
  const key = projectIdentity(dir).key;
  setPublisherSeamsForTest({
    convergeWaitMs: 2_000,
    afterRefAdvance: () => {
      setPublicationClockOffsetForTest(MUTEX_TTL_MS + 60_000);
      const got = tryAcquirePublicationMutex({
        projectKey: key,
        attemptId: thief,
        runId: "thief-run",
        ttlMs: MUTEX_TTL_MS,
      });
      assert.equal(got.acquired, true, "precondition: the thief must take the window from the lapsed lease");
    },
  });
  return { thief };
}

/** The window closes and the world returns to normal: the thief releases, the seams
 *  come off. Everything after this is production behaviour with nothing injected. */
function windowClosesForGood(thief: string): void {
  releasePublicationMutex(projectIdentity(projectDir).key, thief);
  setPublisherSeamsForTest({});
  setPublicationClockOffsetForTest(0);
}

function primaryOf(runId: string) {
  return tasksForRun(runId).find((t) => t.phase === "build" && t.parentId === undefined)!;
}

/** Worktree mode is darwin-only (FG-358: the Linux node_modules bind-mount gap), and a
 *  publication only happens behind a worktree. The sibling publisher suites spoof the
 *  platform for exactly this reason — the code under test is the publisher, not the
 *  host check that decides whether to provision the tree. */
const REAL_PLATFORM = process.platform;

function setPlatform(p: string): void {
  Object.defineProperty(process, "platform", { value: p, configurable: true });
}

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
  blueDispatches = 0;
  for (const k of ENV_VARS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  process.env.FORGE_WORKTREES = "1";
  process.env.FORGE_WORKTREE_IGNORE_DIRTY = "1";
  setPlatform("darwin");
  projectDir = makeProject();
  ensureRuntime();
  ensureWorkflow();
  setExecutorDoneAuditMapForTest(
    new Map([[TICKET_ID, { outcome: "pass" as const, checks: [], gaps: [], requestedAction: null }]]),
  );
});

afterEach(() => {
  setExecutorDoneAuditMapForTest(null);
  setPublisherSeamsForTest({});
  setPublicationClockOffsetForTest(0);
  setDbForTest(prev as DatabaseInstance);
  db.close();
  setPlatform(REAL_PLATFORM);
  rmSync(projectDir, { recursive: true, force: true });
  for (const k of ENV_VARS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k] as string;
  }
});

/** Plans, approves and drives a single-item campaign until its publication loses the
 *  window. Returns everything the assertions need, having already established the
 *  preconditions the AC is about. */
async function driveIntoTheLostWindow() {
  const itemOverrides: Record<string, ItemModeOverride> = {
    [TICKET_ID]: {
      lane: "full_feature",
      workflowName: WORKFLOW_NAME,
      laneRationale: "FG-425 campaign lost-window regression",
    },
  };
  const { campaign } = planCampaign(
    { kind: "list", ticketIds: [TICKET_ID], itemOverrides },
    { projectDir, mode: "sequential" },
  );
  approveCampaign(campaign.id, { rationale: "approved for the FG-425 campaign regression" });

  const { thief } = stealWindowAfterRefAdvance(projectDir);
  const result = await startCampaign(campaign.id, {
    dispatch: dispatchMustNotBeCalled,
    runNextFn: makeCappedRunNext(10),
  });

  const item = listCampaignItems(campaign.id)[0]!;
  const runId = item.runId!;
  return { campaign, item, runId, thief, result };
}

// ─── (1) the park: the item tells the truth, and NOTHING is redone ─────────────
//
// The window is lost after the ref advance, so the candidate IS on the target and the
// attempt is still `publishing`. The campaign item must say exactly that: not failed
// (nothing failed), not retried (the work is already published), and not fallen through
// to the no-progress backstop (which would mislabel it awaiting_gate and send the
// operator to a gate that does not exist).

test(
  "FG-425 (AC5) campaign: a lost publication window parks the item as awaiting_recovery — never failed, never retried, and the candidate is published exactly once",
  { timeout: 120_000 },
  async () => {
    const target = localTargetFor(projectIdentity(projectDir).canonicalDir);
    const { campaign, runId, result } = await driveIntoTheLostWindow();

    const task = primaryOf(runId);
    const attempt = publicationAttemptsForTask(task.id)[0]!;

    // THE PUBLICATION: unsettled, and the ref carries the candidate. This is the state
    // the whole AC is about — nothing may claim a terminal disposition over it.
    assert.equal(attempt.state, "publishing", "the attempt is still inside the window — nothing terminalized it");
    assert.equal(readTargetSha(target), attempt.candidateSha, "and the target ref DOES carry the candidate");

    // THE TASK (the half already proven — asserted here as this test's precondition).
    assert.equal(task.status, "awaiting_recovery", "the owning task is RECOVERABLE, not failed");

    // THE CAMPAIGN ITEM — the half that had no production-path regression until now.
    const item = getCampaignItem(listCampaignItems(campaign.id)[0]!.id)!;
    assert.equal(
      item.lifecycleStatus,
      "awaiting_recovery",
      `the campaign item must park on the truth, not on a guess (got ${item.lifecycleStatus}/${item.blockerKind ?? "no blocker"})`,
    );
    assert.equal(item.blockerKind, "git_state", "the blocker names the surface that is actually unsettled");
    assert.notEqual(item.lifecycleStatus, "failed", "the item must NOT be failed — nothing failed");
    assert.notEqual(item.outcome, "blocked", "and it must carry no blocked outcome");
    assert.notEqual(
      item.lifecycleStatus,
      "awaiting_gate",
      "and it must NOT fall through to the no-progress backstop, which would send the operator to a gate that does not exist",
    );

    // WHAT THE OPERATOR IS TOLD. The one thing they must not do is retry.
    const action = item.requestedHumanAction ?? "";
    assert.match(action, /do NOT retry/i, "the item must steer the operator AWAY from the retry that would duplicate published work");
    assert.doesNotMatch(action, /[Nn]othing (was |from this task was )published/, "no surface may claim nothing was published while the ref carries the candidate");
    assert.doesNotMatch(action, /the target is unchanged/, "nor that the target is unchanged");

    // THE CAMPAIGN. Paused and resumable — not abandoned, not wedged.
    assert.equal(result.stopReason, "paused", "the campaign parks; it does not report a failure");
    assert.equal(getCampaign(campaign.id)!.status, "paused");
    assert.equal(result.itemRecords[0]!.lifecycleStatus, "awaiting_recovery");

    // NOTHING WAS DONE TWICE, and nothing failed.
    assert.equal(blueDispatches, 1, "the engineer ran ONCE — the lost window must not re-dispatch the work");
    assert.equal(publicationAttemptsForTask(task.id).length, 1, "exactly one publication attempt was ever enqueued");
    assert.equal(result.itemRecords.length, 1, "and one item record");
    assert.equal(
      eventsForTask(task.id).map((e) => e.eventType).includes("task.failed"),
      false,
      "the task was NEVER failed",
    );
    assert.equal(failureKindForTask(task.id), undefined, "and there is no failure kind: nothing failed");
  },
);

// ─── (2) the recovery: every surface converges on ONE truth ────────────────────
//
// THE PROOF OBLIGATION. The item's own requestedHumanAction tells the operator to run
// `forge campaign resume <id>` to "converge the publication (AD-5) and reconcile the
// task onto what actually landed". This test takes that promise literally and drives
// exactly that command — the production entry point, `resumeCampaign`, as the CLI calls
// it — and then holds all FOUR surfaces up against each other:
//
//     the publication attempt · the owning task · the run · the campaign item
//
// Every pair must agree. A published attempt beside a failed task is the AC5 defect; a
// complete task beside an item still parked on `awaiting_recovery` is the SAME defect,
// one surface further out — and it is the one this file exists to catch.

test(
  "FG-425 (AC5) campaign: `forge campaign resume` converges the publication and lands the attempt, the task, the run AND the campaign item on ONE mutually truthful state",
  { timeout: 120_000 },
  async () => {
    const target = localTargetFor(projectIdentity(projectDir).canonicalDir);
    const { campaign, runId, thief } = await driveIntoTheLostWindow();

    const task = primaryOf(runId);
    const unsettled = publicationAttemptsForTask(task.id)[0]!;
    assert.equal(unsettled.state, "publishing", "precondition: the attempt is unsettled inside the window");
    assert.equal(getCampaignItem(listCampaignItems(campaign.id)[0]!.id)!.lifecycleStatus, "awaiting_recovery", "precondition: the item is parked on it");
    assert.match(
      getCampaignItem(listCampaignItems(campaign.id)[0]!.id)!.requestedHumanAction ?? "",
      /campaign resume/,
      "precondition: the item points the operator at `forge campaign resume` — so that command had better converge it",
    );

    // The window closes (the lease lapsed; nothing was probed or reaped) and the
    // operator types exactly what forge told them to type. Nothing else runs.
    windowClosesForGood(thief);
    const resumed = await resumeCampaign(campaign.id, {
      dispatch: dispatchMustNotBeCalled,
      runNextFn: makeCappedRunNext(10),
    });

    // ── SURFACE 1: THE PUBLICATION ATTEMPT ──────────────────────────────────────
    const attempt = publicationAttemptsForTask(task.id)[0]!;
    assert.equal(attempt.state, "published", "AD-5 convergence settled the attempt from the three SHAs");
    assert.equal(attempt.publishedSha, attempt.candidateSha, "AD-6: what landed IS the recorded candidate");
    assert.equal(readTargetSha(target), attempt.publishedSha, "the target ref carries it");
    assert.equal(readFileSync(join(projectDir, AGENT_FILE), "utf8"), AGENT_OUTPUT, "the interrupted checkout was finished");
    assert.equal(git(projectDir, ["status", "--porcelain", "--untracked-files=no"]), "", "and the target is CLEAN — ref, index and worktree agree");

    // ── SURFACE 2: THE OWNING TASK ──────────────────────────────────────────────
    const settled = getTask(task.id)!;
    assert.equal(settled.status, "complete", `the task was reconciled onto its publication: ${settled.error ?? ""}`);
    assert.equal(failureKindForTask(task.id), undefined, "with no failure kind");
    assert.equal(
      eventsForTask(task.id).map((e) => e.eventType).includes("task.publication_reconciled"),
      true,
      "and the reconciliation is on the durable record, not merely implied by the status",
    );

    // ── SURFACE 3: THE RUN ──────────────────────────────────────────────────────
    assert.equal(getRun(runId)!.status, "complete", "the run reaches the matching truthful state");

    // ── SURFACE 4: THE CAMPAIGN ITEM — the clause this file exists to prove ─────
    const item = getCampaignItem(listCampaignItems(campaign.id)[0]!.id)!;
    assert.equal(
      item.lifecycleStatus,
      "complete",
      `the campaign item must converge onto the publication that actually landed — it is still ${item.lifecycleStatus}` +
        `${item.blockerKind ? ` (${item.blockerKind})` : ""}, which CONTRADICTS a published attempt and a complete task`,
    );
    assert.equal(item.outcome, "shipped", "the item shipped — the candidate is on the target and its red passed");
    assert.equal(item.blockerKind, undefined, "a shipped item carries no residual blocker");
    assert.doesNotMatch(
      item.requestedHumanAction ?? "",
      /do NOT retry|converge|recovery/i,
      "and it no longer asks the operator to recover what is already recovered",
    );

    // ── EVERY PAIR AGREES, AND NOTHING WAS DONE TWICE ───────────────────────────
    assert.equal(resumed.stopReason, "complete", "the campaign itself reports completion, not another park");
    assert.equal(getCampaign(campaign.id)!.status, "complete", "and its durable status agrees");
    assert.equal(blueDispatches, 1, "the engineer ran exactly ONCE across the whole lifecycle — recovery re-published, it did not re-execute");
    assert.equal(publicationAttemptsForTask(task.id).length, 1, "and exactly one publication attempt exists — the candidate was never published twice");
    assert.equal(
      tasksForRun(runId).filter((t) => t.phase === "build" && t.parentId === undefined).length,
      1,
      "no replacement primary was ever minted to redo work that was already on the target",
    );
    assert.equal(attempt.attemptId, unsettled.attemptId, "the SAME attempt converged — recovery settled it, it did not start a new one");
  },
);

// ─── (3) the OTHER recovery door: the wave sweep ───────────────────────────────
//
// The item's guidance names two commands: `forge campaign resume <id>` and `forge next
// <runId>`. This is the second one — the AD-5 wave sweep, which runNext runs at the top
// of every wave (recoverUnfinishedPublications, then the awaiting_recovery reconcile).
//
// It is here for two reasons. First, it pins the half that DOES work as a regression in
// its own right: the sweep converges the attempt, reconciles the task and settles the
// run, and a campaign resume AFTER it lands the item on the same truth. Second, it is
// the control for the test above: it proves the convergence this file demands is
// REACHABLE on this exact fixture — so a red in (2) is an ordering defect in the
// executor's drive loop, not an assertion asking for something the publisher cannot do.

test(
  "FG-425 (AC5) campaign: the AD-5 wave sweep converges the publication, and the campaign item then reconciles onto it — attempt, task, run and item agree, with nothing re-executed",
  { timeout: 120_000 },
  async () => {
    const target = localTargetFor(projectIdentity(projectDir).canonicalDir);
    const { campaign, runId, thief } = await driveIntoTheLostWindow();

    const task = primaryOf(runId);
    const unsettled = publicationAttemptsForTask(task.id)[0]!;
    assert.equal(unsettled.state, "publishing", "precondition: the attempt is unsettled inside the window");
    assert.match(
      getCampaignItem(listCampaignItems(campaign.id)[0]!.id)!.requestedHumanAction ?? "",
      new RegExp(`forge next ${runId}`),
      "precondition: the item names this exact command as the other way to converge",
    );

    // The window closes, and the operator runs `forge next <runId>`: the wave whose top
    // is the AD-5 sweep. Nothing is injected past this point.
    windowClosesForGood(thief);
    await runNext({ runId, workflow: WORKFLOW, dockerExec: stubExec });

    // The publication, the task and the run all settle on the truth the REF proves.
    const attempt = publicationAttemptsForTask(task.id)[0]!;
    assert.equal(attempt.state, "published", "the sweep converged the attempt from the three SHAs");
    assert.equal(attempt.publishedSha, attempt.candidateSha, "AD-6: what landed IS the recorded candidate");
    assert.equal(readTargetSha(target), attempt.publishedSha, "the target ref carries it");
    assert.equal(readFileSync(join(projectDir, AGENT_FILE), "utf8"), AGENT_OUTPUT, "the interrupted checkout was finished");
    assert.equal(git(projectDir, ["status", "--porcelain", "--untracked-files=no"]), "", "and the target is CLEAN");
    assert.equal(getTask(task.id)!.status, "complete", "the task was reconciled onto its publication");
    assert.equal(getRun(runId)!.status, "complete", "and the run reached the matching truthful state");

    // The campaign item is the LAST surface to converge, and it does so on the resume
    // that follows — the run behind it is terminal, so the item reconciles from the
    // run's authoritative outcome rather than by re-driving anything.
    const resumed = await resumeCampaign(campaign.id, {
      dispatch: dispatchMustNotBeCalled,
      runNextFn: makeCappedRunNext(10),
    });

    const item = getCampaignItem(listCampaignItems(campaign.id)[0]!.id)!;
    assert.equal(item.lifecycleStatus, "complete", `the item converged onto the publication that landed (got ${item.lifecycleStatus})`);
    assert.equal(item.outcome, "shipped", "and it shipped");
    assert.equal(
      resumed.stopReason,
      "complete",
      "the campaign must COMPLETE once its only item has shipped. It parks instead: the ship never cleared the item's " +
        "'git_state' blockerKind, and git_state is a SHARED blocker — so driveWorkflowItem's terminal branch reads the " +
        "stale stamp off a SHIPPED item and re-pauses the whole campaign on a blocker that no longer exists. In a " +
        "multi-item campaign that stalls every item behind one that succeeded",
    );

    // AND NOTHING WAS DONE TWICE.
    assert.equal(blueDispatches, 1, "the engineer ran exactly ONCE — recovery re-published, it never re-executed");
    assert.equal(publicationAttemptsForTask(task.id).length, 1, "exactly one publication attempt — the candidate was never published twice");
    assert.equal(attempt.attemptId, unsettled.attemptId, "and it is the SAME attempt, converged");
    assert.equal(
      tasksForRun(runId).filter((t) => t.phase === "build" && t.parentId === undefined).length,
      1,
      "no replacement primary was minted to redo work already on the target",
    );
  },
);

// ─── (4) the residual blocker: a SHIPPED item may not still be blocked ─────────
//
// The last pair that has to agree. The awaiting_recovery park is the first campaign park
// that stamps a blockerKind ('git_state') onto an item that is EXPECTED to go on and
// ship — every other blockerKind-stamping park is terminal, and the gate:human park
// deliberately stamps none. reconcileTerminalOutcome's ship branch writes
// {lifecycleStatus: complete, outcome: shipped} and does NOT clear blockerKind, so the
// stamp outlives the condition it described: the item ships carrying "git_state", a
// blocker on a publication that has demonstrably converged.
//
// This is the project's own invariant, not one invented here — fg410-executor-item-reset
// asserts it in as many words ("shipped item must carry no residual blockerKind").

test(
  "FG-425 (AC5) campaign: an item that SHIPS after an awaiting_recovery park carries NO residual blocker — a shipped item that is still 'blocked by git_state' contradicts its own publication",
  { timeout: 120_000 },
  async () => {
    const { campaign, runId, thief } = await driveIntoTheLostWindow();
    const task = primaryOf(runId);

    assert.equal(
      getCampaignItem(listCampaignItems(campaign.id)[0]!.id)!.blockerKind,
      "git_state",
      "precondition: the park stamps the item with the blocker it is waiting on",
    );

    windowClosesForGood(thief);
    await runNext({ runId, workflow: WORKFLOW, dockerExec: stubExec });
    await resumeCampaign(campaign.id, { dispatch: dispatchMustNotBeCalled, runNextFn: makeCappedRunNext(10) });

    const item = getCampaignItem(listCampaignItems(campaign.id)[0]!.id)!;
    assert.equal(item.lifecycleStatus, "complete", "precondition: the item shipped");
    assert.equal(item.outcome, "shipped");
    assert.equal(
      publicationAttemptsForTask(task.id)[0]!.state,
      "published",
      "precondition: and the git state it was blocked on is SETTLED — the candidate is published",
    );

    assert.equal(
      item.blockerKind,
      undefined,
      "a shipped item must carry no residual blockerKind: the 'git_state' blocker outlived the unsettled publication that justified it, " +
        "leaving a durable row that is simultaneously 'shipped' and 'blocked on git state'",
    );
  },
);
