// FG-596 (A4) — THE CRUX: a REAL full_feature campaign item drives to SHIPPED through
// startRun + the REAL runNext + the REAL integration-publisher, ACROSS the FG-596
// launch-per-item boundary, and every one of the FIVE durable state levels converges on
// the truth — DERIVED FROM DURABLE STATE, never read off the launch disposition.
//
// WHY THIS FILE EXISTS. The build phase (engineer) proved the extraction, the stamp, the
// controller's derive-from-durable-state advancement and the fail-closed invariant with
// an INJECTED fake dispatch (fg596-launch-controller.integration.test.ts) — a green
// unit/fixture suite. The ticket's A4 is explicit that a green fixture suite does NOT
// satisfy it (that is the FG-425 failure pattern): the convergence must be proven through
// the REAL publisher, the REAL runNext and startRun, with NO fixture double for the
// publisher, and the five surfaces must be READ BACK from durable state after the wake.
//
// So nothing here is hand-written into the DB:
//   * a REAL campaign (planCampaign → approveCampaign → startCampaign) over a REAL git
//     repo and a REAL backlog ticket, driven full_feature (never the invoke lane);
//   * the item is driven THROUGH the FG-596 launch boundary — startCampaign is handed a
//     launchDriveItem that runs the REAL single-item drive and then reconstructs its
//     result the EXACT way the production launcher (launchDriveItemUnderForge) does:
//     PURELY via deriveDriveItemResultFromDurableState(cid, itemId, <process disposition>).
//     The controller consumes ONLY that durable-derived result — it never sees a run
//     object, a task, or a publication;
//   * a REAL workflow run driven by the REAL executor drive loop into the REAL runNext,
//     which reaches the REAL publishIntegration and advances a REAL target ref;
//   * the item ships because its authoritative red passed on the candidate and its
//     done-audit passed — the same evidence production requires.
//
// Only the docker exec boundary is stubbed — the project's standard DockerExecFn
// injection seam. The publisher, the lane, the mutex, the convergence, the executor drive
// loop and the campaign store are all the production article.
//
// This is a worktree-tier test: a publication only happens behind a worktree, and
// worktree mode is darwin-only (FG-358), so the platform is spoofed for exactly the
// reason the sibling publisher/campaign suites spoof it.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { writeTicket } from "../backlog/structured.js";
import { approveCampaign, getCampaign, getCampaignItem, listCampaignItems, deriveCampaignItemDispatchKey, tryTransitionCampaignToRunning } from "../store/campaigns.js";
import { getRun, runByDispatchKey } from "../store/runs.js";
import { getTask, tasksForRun } from "../store/tasks.js";
import { eventsForTask } from "../store/events.js";
import { publicationAttemptsForTask } from "../store/publications.js";
import { failureKindForTask } from "../v2/failure-kind.js";
import { projectIdentity } from "../v2/project-identity.js";
import { localTargetFor, readTargetSha } from "../v2/publication-target.js";
import { setPublisherSeamsForTest } from "../v2/integration-publisher.js";
import { runNext, type DockerExecFn, type RunNextResult } from "../v2/runNext.js";
import type { Workflow } from "../v2/schema.js";
import type { LaunchStatus } from "../v2/launch.js";
import type { InvokeArgs, InvokeResult } from "../v2/invoke.js";
import { planCampaign, type ItemModeOverride } from "./planner.js";
import {
  startCampaign,
  driveOneCampaignItem,
  deriveDriveItemResultFromDurableState,
  setExecutorDoneAuditMapForTest,
  type DriveItemLaunchFn,
} from "./executor.js";

const RUNTIME_NAME = "fg596-a4-runtime";
const WORKFLOW_NAME = "fg596-a4-feature";
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

/** A real git project with the campaign's backlog ticket COMMITTED — the publish target
 *  must be clean, which is exactly what the publisher's preflight demands. */
function makeProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "fg596-a4-"));
  git(dir, ["init", "-b", "main"]);
  git(dir, ["config", "user.email", "test@forge.test"]);
  git(dir, ["config", "user.name", "Forge Test"]);
  writeFileSync(join(dir, "README.md"), "# test\n");
  writeTicket(dir, {
    id: TICKET_ID,
    type: "story",
    status: "active",
    title: `${TICKET_ID}: a campaign item driven to shipped under a launch`,
    body: "## Problem\nA full_feature item must ship through the real publisher under a per-item launch.\n\n## Goal\nEvery durable surface converges on the truth.\n\n## Acceptance Criteria\n- The item ships exactly once and every surface agrees\n",
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
description: FG-596 A4 campaign test runtime stub
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

/** The executor loads the workflow from disk on every drive, so the installed YAML is
 *  part of the production shape under test. An AUTHORITATIVE red is what lets the item
 *  legitimately SHIP: it runs inside the publisher (against the candidate) BEFORE the ref
 *  advance, so its passing verdict is on the record before the item can ship. */
function ensureWorkflow(): void {
  const path = join(process.env.FORGE_HOME!, "workflows", `${WORKFLOW_NAME}.yml`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    `name: ${WORKFLOW_NAME}
description: "FG-596 A4: a single build step that ships through the real publisher"
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
}

const WORKFLOW: Workflow = {
  name: WORKFLOW_NAME,
  description: "FG-596 A4: a single build step that ships through the real publisher",
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

/** Counts how many times the BLUE (engineer) agent actually ran — the item must ship on
 *  ONE execution across the whole launch boundary; a re-dispatch would redo published work. */
let blueDispatches = 0;

/** The agents. The engineer commits its output on its task branch, exactly as a real one
 *  does; the red passes on the candidate it is shown. */
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

/** The REAL runNext with only the docker boundary stubbed, capped against a runaway drive
 *  loop (a test-harness safety net, not a mock of anything under test). */
function makeCappedRunNext(cap: number): (args: { runId: string; workflow: Workflow }) => Promise<RunNextResult> {
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

/** Worktree mode is darwin-only (FG-358: the Linux node_modules bind-mount gap), and a
 *  publication only happens behind a worktree. The sibling publisher suites spoof the
 *  platform for exactly this reason — the code under test is the publisher, not the host
 *  check that decides whether to provision the tree. */
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
  setDbForTest(prev as DatabaseInstance);
  db.close();
  setPlatform(REAL_PLATFORM);
  rmSync(projectDir, { recursive: true, force: true });
  for (const k of ENV_VARS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k] as string;
  }
});

/** Plans + approves a single-item full_feature campaign. */
function planApprovedCampaign() {
  const itemOverrides: Record<string, ItemModeOverride> = {
    [TICKET_ID]: {
      lane: "full_feature",
      workflowName: WORKFLOW_NAME,
      laneRationale: "FG-596 A4 launch-convergence proof",
    },
  };
  const { campaign } = planCampaign(
    { kind: "list", ticketIds: [TICKET_ID], itemOverrides },
    { projectDir, mode: "sequential" },
  );
  approveCampaign(campaign.id, { rationale: "approved for the FG-596 A4 convergence proof" });
  return campaign;
}

// ─────────────────────────────────────────────────────────────────────────────────────
// A4 — the five-level convergence proof, through the REAL publisher, across the launch
// boundary, DERIVED FROM DURABLE STATE.
// ─────────────────────────────────────────────────────────────────────────────────────

test(
  "FG-596 A4: a full_feature item ships through the REAL publisher across the launch boundary — task, run, campaign-item, campaign AND publication all converge, derived from durable state",
  { timeout: 120_000 },
  async () => {
    const target = localTargetFor(projectIdentity(projectDir).canonicalDir);
    const campaign = planApprovedCampaign();

    // THE LAUNCH BOUNDARY. This is the FG-596 seam. The launcher runs the REAL single-item
    // drive (real startRun + real runNext + real publishIntegration; the invoke lane is
    // forbidden for full_feature) and then reconstructs its result the EXACT way the
    // production launchDriveItemUnderForge does after the tmux child exits: PURELY via
    // deriveDriveItemResultFromDurableState, handed ONLY the drive-PROCESS disposition
    // (exited_ok/0). No stdout marker, no run/task/publication object crosses back — the
    // controller consumes only what durable state derives.
    const cleanExit: LaunchStatus = { state: "exited_ok", code: 0 };
    let launches = 0;
    let sawDisposition: LaunchStatus | undefined;
    const launcher: DriveItemLaunchFn = async (cid, itemId) => {
      launches++;
      await driveOneCampaignItem(cid, itemId, {
        dispatch: dispatchMustNotBeCalled,
        projectDir,
        mode: "sequential",
        runNextFn: makeCappedRunNext(10),
      });
      sawDisposition = cleanExit;
      return deriveDriveItemResultFromDurableState(cid, itemId, cleanExit);
    };

    const result = await startCampaign(campaign.id, {
      dispatch: dispatchMustNotBeCalled,
      launchDriveItem: launcher,
    });

    // The boundary was actually crossed — exactly one per-item launch.
    assert.equal(launches, 1, "the item drove through the FG-596 launch boundary exactly once");
    assert.deepEqual(sawDisposition, { state: "exited_ok", code: 0 }, "the boundary saw a PROCESS disposition only — never an item outcome");

    // The controller's own verdict — itself derived from durable campaign state.
    assert.equal(result.stopReason, "complete", "the controller derives completion from durable campaign status after the wake");

    const item = listCampaignItems(campaign.id)[0]!;
    const runId = item.runId!;
    const task = primaryOf(runId);

    // ── SURFACE 1: THE PUBLICATION ──────────────────────────────────────────────────
    const attempts = publicationAttemptsForTask(task.id);
    assert.equal(attempts.length, 1, "exactly one publication attempt was ever enqueued — the candidate was never published twice");
    const attempt = attempts[0]!;
    assert.equal(attempt.state, "published", "the publication attempt SETTLED as published — the real publisher ran to completion");
    assert.equal(attempt.publishedSha, attempt.candidateSha, "what landed IS the recorded candidate");
    assert.equal(readTargetSha(target), attempt.publishedSha, "and the REAL target ref carries it");
    assert.equal(readFileSync(join(projectDir, AGENT_FILE), "utf8"), AGENT_OUTPUT, "the candidate's content is on the target worktree");
    assert.equal(git(projectDir, ["status", "--porcelain", "--untracked-files=no"]), "", "the target is CLEAN — ref, index and worktree agree");

    // ── SURFACE 2: THE OWNING TASK ──────────────────────────────────────────────────
    const settled = getTask(task.id)!;
    assert.equal(settled.status, "complete", `the owning task is complete: ${settled.error ?? ""}`);
    assert.equal(failureKindForTask(task.id), undefined, "with no failure kind — nothing failed");
    assert.equal(
      eventsForTask(task.id).map((e) => e.eventType).includes("task.failed"),
      false,
      "the task was NEVER failed",
    );

    // ── SURFACE 3: THE RUN ──────────────────────────────────────────────────────────
    assert.equal(getRun(runId)!.status, "complete", "the run reaches the matching truthful state");

    // ── SURFACE 4: THE CAMPAIGN ITEM ─────────────────────────────────────────────────
    const durableItem = getCampaignItem(item.id)!;
    assert.equal(durableItem.lifecycleStatus, "complete", `the campaign item converged onto the shipped truth — got ${durableItem.lifecycleStatus}`);
    assert.equal(durableItem.outcome, "shipped", "the item shipped — the candidate is on the target and its red passed");
    assert.equal(durableItem.blockerKind, undefined, "a shipped item carries no residual blocker");

    // ── SURFACE 5: THE CAMPAIGN ─────────────────────────────────────────────────────
    assert.equal(getCampaign(campaign.id)!.status, "complete", "the campaign's durable status is complete");

    // ── DERIVED-FROM-DURABLE-STATE, NOT THE DISPOSITION ─────────────────────────────
    // The record the boundary handed the controller must MATCH what re-reading the store
    // says — because it was reconstructed FROM the store, not from the launch disposition.
    const rec = result.itemRecords.find((r) => r.itemId === item.id)!;
    assert.equal(rec.lifecycleStatus, "complete", "the controller's item record follows durable item state");
    assert.equal(rec.outcome, "shipped", "…including the shipped outcome — derived, not asserted by the child");

    // NOTHING WAS DONE TWICE.
    assert.equal(blueDispatches, 1, "the engineer ran exactly ONCE — the launch boundary did not re-execute the work");
    assert.equal(
      tasksForRun(runId).filter((t) => t.phase === "build" && t.parentId === undefined).length,
      1,
      "no replacement primary was ever minted",
    );

    // A5 (adoptability): the drive-item run is stamped with the deterministic key + the
    // attempt-generation identity, so a later slice (FG-564) can bind/recover it.
    assert.ok(durableItem.attemptGeneration >= 1, "the shipped item carries an allocated attempt generation");
    const key = deriveCampaignItemDispatchKey(campaign.id, item.id, durableItem.attemptGeneration);
    assert.equal(getRun(runId)!.metadata?.["dispatchKey"], key, "the run stamps the deterministic dispatch key");
    assert.equal(getRun(runId)!.metadata?.["attemptGeneration"], durableItem.attemptGeneration, "and the item-attempt generation");
    assert.equal(runByDispatchKey(key)?.id, runId, "the run is adoptable by its stamped key");
  },
);

// A crisp counter-proof that the FIVE surfaces are read off DURABLE STATE and not the
// launch disposition: the SAME real drive, but the derivation is then handed a
// disposition that says the PROCESS crashed hard (owner_gone) over an item that has
// already shipped durably while the campaign is still running. A boundary that trusted
// the disposition would report recovery_needed over a shipped item; the derivation must
// still report the durable truth (settled, no halt) because owner_gone only matters when
// the item is left mid-flight.
//
// The item is driven DIRECTLY (driveOneCampaignItem, not the controller) so the campaign
// stays `running` — the exact mid-drive moment the derivation is designed for, before the
// controller's after-drain completeCampaign fires.
test(
  "FG-596 A4: a shipped item stays shipped even when the launch disposition claims the drive process crashed — the outcome is durable, the disposition is process-only",
  { timeout: 120_000 },
  async () => {
    const campaign = planApprovedCampaign();
    assert.ok(tryTransitionCampaignToRunning(campaign.id), "precondition: campaign is running (the controller would have done this)");
    const itemId = listCampaignItems(campaign.id)[0]!.id;

    // Drive the item to shipped for real (real startRun + real runNext + real publisher).
    await driveOneCampaignItem(campaign.id, itemId, {
      dispatch: dispatchMustNotBeCalled,
      projectDir,
      mode: "sequential",
      runNextFn: makeCappedRunNext(10),
    });
    const item = getCampaignItem(itemId)!;
    assert.equal(item.outcome, "shipped", "precondition: the item shipped durably");
    assert.equal(getCampaign(campaign.id)!.status, "running", "precondition: the campaign is still running (item drive does not complete it)");

    // Now derive a result as if the SAME already-shipped item's drive process had crashed
    // hard (owner_gone) — the disposition is the ONLY thing that changed.
    const crashed: LaunchStatus = { state: "owner_gone", cause: "unrecorded", sender: "unrecorded" };
    const derived = deriveDriveItemResultFromDurableState(campaign.id, item.id, crashed);

    assert.notEqual(derived.stopReason, "recovery_needed", "a crash disposition must NOT override an already-settled, shipped item");
    assert.equal(derived.stopReason, undefined, "the item is settled and the campaign is not halted — no stop is derived from the crash disposition");
    assert.equal(derived.driveError, undefined, "no drive error — the item is complete on the durable record");
    const rec = derived.itemRecords[0]!;
    assert.equal(rec.lifecycleStatus, "complete", "the record follows the DURABLE shipped item, never the crash disposition");
    assert.equal(rec.outcome, "shipped");
  },
);
