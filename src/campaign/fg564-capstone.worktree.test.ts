// FG-564 (Slice 5b, AC9) — THE UNIFIED CAPSTONE. One run in which a campaign advances N -> N+1
// with BOTH items shipping through the REAL runNext + the REAL integration-publisher, across the
// FG-596 per-item launch boundary, under the campaign-controller lease — and the advance itself
// is the PRODUCTION consumer (consumeCampaignContinuation) claiming the boundary and DRIVING
// item N+1. Every one of the FIVE durable state levels (task, run, campaign-item, campaign,
// publication) converges on the truth, DERIVED FROM DURABLE ROWS, for BOTH items.
//
// WHY THIS FILE EXISTS (AC9, no deferral). The two halves of AC9's proof previously lived apart:
//   * fg596-a4-launch-convergence.worktree.test.ts ships a SINGLE real item through the real
//     publisher across the launch boundary — but has no campaign continuation / N->N+1 advance;
//   * fg564-capstone.integration.test.ts advances the N->N+1 continuation through the production
//     consumer + real store + real FG-596 reservation — but the item's drive writes come from an
//     INJECTED seam, not the real publisher.
// AC9 requires ONE run combining them: the real publisher AND the N->N+1 campaign-continuation
// advance, five-level convergence read back from durable rows. This is that run; it supersedes
// the deferral ticket (deleted with this change).
//
// The shape mirrors production exactly:
//   1. driveRemainingItems(controllerOwner) — the P0-A recorder path — drives item N through the
//      REAL launchDriveItemUnderForge + real publisher, records the durable item-attempt launch
//      linkage AND the N->N+1 boundary continuation, then pauses before N+1 (a controller that
//      died / a cooperative pause between items). Item N+1 is left pending, campaign running.
//   2. The continuation advance goes through consumeCampaignContinuation -> consumeCore -> the
//      campaign adapter's lease-gated FG-596 reservation: it CLAIMS the boundary exactly once,
//      the reservation CREATES item N+1's run, and the injected drive seam runs that run through
//      the REAL runNext + real publisher (driveWorkflowItem). N+1 ships as a RESULT of the advance.
//
// Only the docker exec and the tmux/subprocess boundaries are stubbed — the project's standard
// injection seams. The publisher, lane, mutex, convergence, executor drive loop, campaign store,
// campaign-controller lease, durable launch linkage, FG-562 continuation claim and FG-596
// reservation are all the production article. Worktree mode is darwin-only (FG-358), so the
// platform is spoofed exactly as the sibling publisher/campaign suites do.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { setPublicationClockOffsetForTest } from "../store/publications.js";
import { writeTicket } from "../backlog/structured.js";
import {
  approveCampaign,
  getCampaign,
  getCampaignItem,
  listCampaignItems,
  deriveCampaignItemDispatchKey,
  tryTransitionCampaignToRunning,
} from "../store/campaigns.js";
import { getRun, runByDispatchKey } from "../store/runs.js";
import { getTask, tasksForRun } from "../store/tasks.js";
import { publicationAttemptsForTask } from "../store/publications.js";
import { getContinuation } from "../store/continuations.js";
import { acquireCampaignLease, getItemLaunch } from "../store/campaign-controller.js";
import { projectIdentity } from "../v2/project-identity.js";
import { localTargetFor, readTargetSha } from "../v2/publication-target.js";
import { setPublisherSeamsForTest } from "../v2/integration-publisher.js";
import { runNext, type DockerExecFn, type RunNextResult } from "../v2/runNext.js";
import { publishFlatAsGeneration } from "../v2/seed-generation.testkit.js";
import type { Workflow } from "../v2/schema.js";
import { realWaitHarness, LAUNCHES_DIR, type LaunchStatus, type LaunchView, type TmuxRunner } from "../v2/launch.js";
import type { InvokeArgs, InvokeResult } from "../v2/invoke.js";
import { planCampaign, type ItemModeOverride } from "./planner.js";
import {
  driveRemainingItems,
  driveOneCampaignItem,
  launchDriveItemUnderForge,
  prepareCampaignItemDispatch,
  setExecutorDoneAuditMapForTest,
  type DriveItemLaunchFn,
  type DriveOneItemResult,
} from "./executor.js";
import {
  consumeCampaignContinuation,
  campaignContinuationId,
  driveCampaignItemAction,
  type CampaignDispatchDeps,
  type ContinuationIdentity,
} from "./continuation-adapter.js";

const RUNTIME_NAME = "fg564-capstone-runtime";
const WORKFLOW_NAME = "fg564-capstone-feature";
const TICKET_IDS = ["FG-940", "FG-941"] as const;

const WORKFLOW: Workflow = {
  name: WORKFLOW_NAME,
  description: "FG-564 capstone: a single build step that ships through the real publisher",
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

function makeProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "fg564-capstone-"));
  git(dir, ["init", "-b", "main"]);
  git(dir, ["config", "user.email", "test@forge.test"]);
  git(dir, ["config", "user.name", "Forge Test"]);
  writeFileSync(join(dir, "README.md"), "# test\n");
  for (const id of TICKET_IDS) {
    writeTicket(dir, {
      id,
      type: "story",
      status: "active",
      title: `${id}: a campaign item driven to shipped under a launch`,
      body: "## Problem\nA full_feature item must ship through the real publisher under a per-item launch.\n\n## Goal\nEvery durable surface converges on the truth.\n\n## Acceptance Criteria\n- The item ships exactly once and every surface agrees\n",
    });
  }
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
description: FG-564 capstone test runtime stub
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

function ensureWorkflow(): void {
  const path = join(process.env.FORGE_HOME!, "workflows", `${WORKFLOW_NAME}.yml`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    `name: ${WORKFLOW_NAME}
description: "FG-564 capstone: a single build step that ships through the real publisher"
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

/** How many times the BLUE (engineer) agent actually ran — across BOTH items it must be exactly
 *  one per item (no re-execution across the launch boundary or the advance). */
let blueDispatches = 0;

/** The agents. The engineer commits a UNIQUELY-named file per dispatch (so two sequential items
 *  never collide on the target); the red passes on the candidate it is shown. */
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
  const agentFile = `src/feature-${blueDispatches}.ts`;
  const mount = findProjectMountHost(args)!;
  mkdirSync(dirname(join(mount, agentFile)), { recursive: true });
  writeFileSync(join(mount, agentFile), `the agent's output ${blueDispatches}\n`);
  git(mount, ["add", "."]);
  git(mount, ["commit", "-q", "-m", `primary output ${blueDispatches}`]);
  writeFileSync(
    join(dir, "result.json"),
    JSON.stringify({ status: "complete", tests_run: 1, files_modified: [agentFile] }),
  );
  return 0;
};

function makeCappedRunNext(cap: number): (args: { runId: string; workflow: Workflow }) => Promise<RunNextResult> {
  let calls = 0;
  return async (args: { runId: string; workflow: Workflow }): Promise<RunNextResult> => {
    if (++calls > cap) {
      throw new Error(`test safety guard: runNext was called ${calls} times`);
    }
    return runNext({ ...args, dockerExec: stubExec });
  };
}

const dispatchMustNotBeCalled = async (_args: InvokeArgs): Promise<InvokeResult> => {
  throw new Error("opts.dispatch must not be called — full_feature never uses the invoke lane");
};

const REAL_PLATFORM = process.platform;
function setPlatform(p: string): void {
  Object.defineProperty(process, "platform", { value: p, configurable: true });
}

function primaryOf(runId: string) {
  return tasksForRun(runId).find((t) => t.phase === "build" && t.parentId === undefined)!;
}

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
  blueDispatches = 0;
  setPublicationClockOffsetForTest(0);
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
    new Map(TICKET_IDS.map((id) => [id, { outcome: "pass" as const, checks: [], gaps: [], requestedAction: null }])),
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

function planApprovedTwoItemCampaign() {
  const itemOverrides: Record<string, ItemModeOverride> = {};
  for (const id of TICKET_IDS) {
    itemOverrides[id] = { lane: "full_feature", workflowName: WORKFLOW_NAME, laneRationale: "FG-564 capstone" };
  }
  const { campaign } = planCampaign(
    { kind: "list", ticketIds: [...TICKET_IDS], itemOverrides },
    { projectDir, mode: "sequential" },
  );
  approveCampaign(campaign.id, { rationale: "approved for the FG-564 AC9 capstone" });
  return campaign;
}

/** A tmux stub that CARRIES the real drive-item launch (identical to the FG-596 A4 harness): on
 *  respawn-pane it parses the drive-item ids out of the shell-quoted argv, runs the item's REAL
 *  drive in-process, then writes a genuine exit record so the REAL wait harness wakes on honest
 *  evidence. */
function makeDriveTmux(runDrive: (cid: string, itemId: string) => Promise<void>) {
  const calls: string[][] = [];
  const alive = new Set<string>();
  const drives: Promise<void>[] = [];
  const state = { respawnCmd: "", newSessionCwd: "" };
  const tmux: TmuxRunner = (args) => {
    calls.push(args);
    switch (args[0]) {
      case "-V":
        return "tmux 3.4\n";
      case "new-session": {
        alive.add(args[args.indexOf("-s") + 1]!);
        const ci = args.indexOf("-c");
        if (ci >= 0) state.newSessionCwd = args[ci + 1]!;
        return;
      }
      case "set-option":
        return;
      case "respawn-pane": {
        const session = args[args.indexOf("-t") + 1]!.replace(/:$/, "");
        const id = session.replace(/^forge-/, "");
        state.respawnCmd = args[args.length - 1]!;
        const m = /'drive-item' '([^']+)' '([^']+)'/.exec(state.respawnCmd);
        assert.ok(m, `respawn-pane carries a drive-item argv: ${state.respawnCmd}`);
        drives.push(
          (async () => {
            let code = 0;
            try {
              // Faithful to production: the drive-item CHILD is a separate process that boots
              // AFTER the parent returns from startLaunch and records the durable launch linkage
              // (launchDriveItemUnderForge records it synchronously right after startLaunch). Yield
              // a microtask so the in-process child runs after that record — otherwise the enforced
              // born-under fence would read a linkage that does not exist yet and deny a legitimate
              // launched drive.
              await Promise.resolve();
              await runDrive(m![1]!, m![2]!);
            } catch {
              code = 1;
            }
            const exitPath = join(LAUNCHES_DIR, id, "exit");
            writeFileSync(`${exitPath}.tmp`, JSON.stringify({ code, signal: null }));
            renameSync(`${exitPath}.tmp`, exitPath);
          })(),
        );
        return;
      }
      case "kill-session":
        alive.delete(args[args.indexOf("-t") + 1]!);
        return;
      case "has-session":
        if (!alive.has(args[2]!)) throw new Error("no such session");
        return;
      case "display-message":
        return args.includes("#{pane_dead}") ? "0\n" : "4242\n";
      default:
        return;
    }
  };
  return { tmux, calls, drives, state };
}

const TERMINAL: LaunchStatus = { state: "exited_ok", code: 0 };
function terminalReader(id: string): LaunchView {
  return { id, status: TERMINAL } as unknown as LaunchView;
}

/** Assert the FIVE durable levels for one shipped campaign item, each DERIVED FROM DURABLE ROWS,
 *  and return the item's run id. */
function assertFiveLevelConvergence(campaignId: string, itemId: string): string {
  const target = localTargetFor(projectIdentity(projectDir).canonicalDir);
  const item = getCampaignItem(itemId)!;
  const runId = item.runId!;
  const task = primaryOf(runId);

  // (5) PUBLICATION — the real publisher ran to completion and the REAL target carries it.
  const attempts = publicationAttemptsForTask(task.id);
  assert.equal(attempts.length, 1, `${itemId}: exactly one publication attempt — never published twice`);
  assert.equal(attempts[0]!.state, "published", `${itemId}: the publication SETTLED as published (real publisher ran)`);
  assert.equal(attempts[0]!.publishedSha, attempts[0]!.candidateSha, `${itemId}: what landed IS the candidate`);
  assert.equal(readTargetSha(target), attempts[0]!.publishedSha, `${itemId}: the REAL target ref carries the published sha`);

  // (1) TASK — complete, no failure.
  assert.equal(getTask(task.id)!.status, "complete", `${itemId}: the owning task is complete`);
  // (2) RUN — the matching truthful terminal state, resolvable by the durable FG-596 key.
  assert.equal(getRun(runId)!.status, "complete", `${itemId}: the run reaches the matching truthful state`);
  const fgKey = deriveCampaignItemDispatchKey(campaignId, itemId, item.attemptGeneration);
  assert.equal(runByDispatchKey(fgKey)?.id, runId, `${itemId}: the run resolves by its durable FG-596 dispatch key`);
  // (3) CAMPAIGN-ITEM — shipped, linked to the one run, no residual blocker.
  assert.equal(item.lifecycleStatus, "complete", `${itemId}: the campaign item converged onto the shipped truth`);
  assert.equal(item.outcome, "shipped", `${itemId}: the item shipped`);
  assert.equal(item.blockerKind, undefined, `${itemId}: a shipped item carries no residual blocker`);
  // Cross-level agreement — one run id threads task, run, item AND publication.
  assert.equal(task.runId, runId);
  assert.equal(attempts[0]!.runId, runId, `${itemId}: the publication is keyed to the one run`);
  return runId;
}

test(
  "FG-564 AC9 capstone: item N ships through the real publisher under the controller loop (P0-A recorder), then the N -> N+1 continuation advance — the production consumer — CREATES and ships item N+1 through the real publisher; five-level convergence for both, derived from durable rows",
  { timeout: 240_000 },
  async () => {
    const campaign = planApprovedTwoItemCampaign();
    assert.ok(tryTransitionCampaignToRunning(campaign.id), "precondition: the campaign is running");
    const planned = listCampaignItems(campaign.id).sort((a, b) => a.itemOrder - b.itemOrder);
    assert.equal(planned.length, 2, "precondition: the campaign has two items (N and N+1)");
    const itemN = planned[0]!;
    const itemNext = planned[1]!;

    // ── STAGE 1: the PRODUCTION controller loop drives item N through the REAL launch boundary ──
    // driveRemainingItems(controllerOwner) holds the campaign-controller lease, launches the REAL
    // launchDriveItemUnderForge for item N (only the tmux boundary injected — the child runs the
    // item's REAL startRun + runNext + real publisher), records the durable launch linkage AND the
    // P0-A N->N+1 boundary continuation, then a cooperative pause halts the loop BEFORE item N+1.
    const driveTmux = makeDriveTmux(async (cid, id) => {
      await driveOneCampaignItem(cid, id, {
        dispatch: dispatchMustNotBeCalled,
        projectDir,
        mode: "sequential",
        runNextFn: makeCappedRunNext(12),
      });
    });
    const realLauncher = launchDriveItemUnderForge(["forge"], {
      tmux: driveTmux.tmux,
      makeWaitHarness: (id) =>
        realWaitHarness(id, { tmux: driveTmux.tmux, reconcileMs: 25, timeoutMs: 120_000, invalidBoundMs: 1_000 }),
    });
    // Drive ONLY item N: for N delegate to the real launcher; for N+1 pause the loop (the exact
    // between-items moment a controller can die / cooperatively pause), leaving N+1 pending.
    const driveOnlyN: DriveItemLaunchFn = async (cid, id) => {
      if (id === itemN.id) return realLauncher(cid, id);
      return { itemRecords: [], stopReason: "paused" } as DriveOneItemResult;
    };

    const controllerOwner = `campaign@${campaign.id}@capstone`;
    const stage1 = await driveRemainingItems(campaign.id, {
      dispatch: dispatchMustNotBeCalled,
      projectDir,
      mode: "sequential",
      launchDriveItem: driveOnlyN,
      controllerOwner,
    });
    await Promise.all(driveTmux.drives);

    assert.equal(stage1.stopReason, "paused", "the loop paused between items, leaving N+1 pending");
    assert.equal(getCampaign(campaign.id)!.status, "running", "(4) CAMPAIGN: still running across the boundary");
    assert.equal(getCampaignItem(itemNext.id)!.lifecycleStatus, "pending", "item N+1 is still pending — never driven by the loop");

    // Item N shipped through the REAL publisher — five-level convergence, derived from durable rows.
    const runN = assertFiveLevelConvergence(campaign.id, itemN.id);
    assert.equal(blueDispatches, 1, "item N ran the engineer exactly once");

    // The P0-A recorder wrote the N->N+1 boundary continuation, bound to item N's durable linkage.
    const contId = campaignContinuationId(campaign.id, itemN.id);
    const cont = getContinuation(contId);
    assert.ok(cont, "the N->N+1 boundary continuation was durably recorded by the controller (P0-A recorder)");
    assert.deepEqual(
      cont!.nextAction,
      driveCampaignItemAction(campaign.id, itemNext.id),
      "the continuation's nextAction explicitly names the NEXT item (contract correction 3)",
    );
    const freshN = getCampaignItem(itemN.id)!;
    const linkageN = getItemLaunch(campaign.id, itemN.id, freshN.attemptGeneration)!;
    assert.ok(linkageN, "item N's durable launch linkage exists");
    assert.equal(cont!.sourceLaunchId, linkageN.sourceLaunchId, "the continuation binds item N's durable launch linkage — no heuristic");

    // ── STAGE 2: the ADVANCE, through the PRODUCTION consumer, CREATES and drives item N+1 ──────
    // Re-acquire the (released-at-pause) controller lease and advance the recorded continuation
    // through consumeCampaignContinuation -> consumeCore -> the campaign adapter. It claims the
    // boundary exactly once; the lease-gated FG-596 reservation CREATES item N+1's run (the SOLE
    // item-run authority); and the injected drive seam runs that run through the REAL runNext +
    // real publisher. N+1 ships as a direct RESULT of the advance.
    const grant = acquireCampaignLease({ campaignId: campaign.id, owner: controllerOwner, ttlMs: 5 * 60 * 1000 });
    assert.ok(grant.granted, "the controller re-acquires the lease to advance the boundary");
    const lease = { owner: controllerOwner, generation: grant.lease.generation };

    let createdRunId: string | undefined;
    let driveMode: string | undefined;
    let drivePromise: Promise<unknown> = Promise.resolve();
    const prepareItemDispatch: CampaignDispatchDeps["prepareItemDispatch"] = ({ campaignId: cid, itemId: iid }) => {
      // FG-564 (FIX round 5): the advance resolves N+1's lane + fs inputs and materializes its run
      // through the ONE lane-aware production authority (prepareCampaignItemDispatch) — the SAME one
      // runCampaignRecovery wires and the normal drive path uses. It resolves the item's REAL
      // workflow (from the plan entry's workflowName) + ticket OUTSIDE the tx, and its createRun
      // real-startRuns the run INSIDE the reservation. No private startRun substitution.
      const plan = prepareCampaignItemDispatch({ campaignId: cid, itemId: iid }, { projectDir });
      return {
        driver: plan.driver,
        createRun: (ctx) => {
          const runId = plan.createRun(ctx);
          createdRunId = runId;
          return runId;
        },
      };
    };
    // STAGE 2 drives item N+1 through the REAL launch boundary — exactly as production's
    // recovery/consumer composition does (runCampaignRecovery wires driveItem to
    // launchDriveItemUnderForge). The launched child runs the REAL `campaign drive-item` route
    // (driveOneCampaignItem with enforceFence) and its durable-linkage fence: it adopts the run
    // the lease-gated reservation CREATED and drives THAT run through the REAL runNext + real
    // publisher. Only the tmux/subprocess boundary is injected — the fence, the reservation, the
    // durable launch linkage, the executor drive loop, and the publisher are the production article.
    const advanceTmux = makeDriveTmux(async (cid, id) => {
      await driveOneCampaignItem(cid, id, {
        dispatch: dispatchMustNotBeCalled,
        projectDir,
        mode: "sequential",
        runNextFn: makeCappedRunNext(12),
        enforceFence: true,
      });
    });
    const advanceLauncher = launchDriveItemUnderForge(["forge"], {
      tmux: advanceTmux.tmux,
      makeWaitHarness: (id) =>
        realWaitHarness(id, { tmux: advanceTmux.tmux, reconcileMs: 25, timeoutMs: 120_000, invalidBoundMs: 1_000 }),
    });
    const driveItem: CampaignDispatchDeps["driveItem"] = ({ campaignId: cid, itemId: iid, mode }) => {
      driveMode = mode;
      // Fire-and-forget through the real launcher, as production does. The run row is durable
      // (created inside the reservation tx), so the advance can mark the boundary advanced while
      // the launched child physically drives; we await the launch + its drive below.
      drivePromise = advanceLauncher(cid, iid);
    };

    const identity: ContinuationIdentity = {
      continuationId: contId,
      sourceLaunchId: cont!.sourceLaunchId,
      consumerKind: "campaign",
      currentPhase: cont!.currentPhase,
      nextAction: cont!.nextAction,
    };
    const advance = consumeCampaignContinuation(identity, {
      owner: controllerOwner,
      readLaunch: terminalReader,
      campaign: { lease, prepareItemDispatch, driveItem },
    });
    await drivePromise;
    await Promise.all(advanceTmux.drives);

    assert.equal(advance.kind, "advanced", `the N->N+1 boundary advanced through the production consumer (got ${advance.kind})`);
    assert.equal(getContinuation(contId)!.state, "advanced", "the continuation is durably advanced exactly once");
    assert.equal(driveMode, "created", "the advance's reservation CREATED item N+1's run and drove it — the SOLE item-run authority");
    assert.ok(createdRunId, "the reservation created item N+1's run");

    // The advance recorded item N+1's created run as the boundary's dispatched run, and it is the
    // ONE run resolvable by item N+1's durable FG-596 key.
    const itemNextAfter = getCampaignItem(itemNext.id)!;
    const nextKey = deriveCampaignItemDispatchKey(campaign.id, itemNext.id, itemNextAfter.attemptGeneration);
    assert.equal(runByDispatchKey(nextKey)?.id, createdRunId, "item N+1's ONE run resolves by its durable FG-596 key");
    if (advance.kind === "advanced") {
      assert.equal(getContinuation(contId)!.dispatchedRunId, createdRunId, "the boundary advance recorded item N+1's real run id");
    }

    // Item N+1 shipped through the REAL publisher as a result of the advance — five-level
    // convergence, derived from durable rows.
    const runNextItem = assertFiveLevelConvergence(campaign.id, itemNext.id);
    assert.equal(runNextItem, createdRunId, "the shipped item N+1 run is the one the advance created");
    assert.notEqual(runN, runNextItem, "each item drove its OWN distinct real run");
    assert.equal(blueDispatches, 2, "the engineer ran exactly once per item — nothing was executed twice across the boundary");
  },
);
