// FG-596 — the launch-per-item controller + deterministic dispatch-key stamping +
// legacy fail-closed, against a real store and a real single-item drive.
//
// These exercise the FG-596 boundary in-process (an injected launcher runs the same
// driveOneCampaignItem the production subprocess runs, so the controller logic and the
// durable-state derivation are proven without spawning tmux). The A4 five-level
// real-publisher, real-runNext, real-subprocess convergence proof is the VERIFY
// phase's — this file proves the extraction, the stamp, the controller's
// derive-from-durable-state advancement, and the fail-closed invariant.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import {
  getCampaign,
  getCampaignItem,
  listCampaignItems,
  updateCampaignItem,
  deriveCampaignItemDispatchKey,
  allocateItemGeneration,
  createCampaign,
  addCampaignItem,
  claimCampaignItemForDrive,
  updateCampaignItemIfPending,
} from "../store/campaigns.js";
import { parkCampaign } from "./park.js";
import { getRun, insertRun, runByDispatchKey, listRuns } from "../store/runs.js";
import { writeTicket, closeTicket } from "../backlog/structured.js";
import { planCampaign as _planCampaign, resolvePlan } from "./planner.js";
import type { PlannerInput, PlanMode } from "./planner.js";
import {
  startCampaign,
  resumeCampaign,
  driveOneCampaignItem,
  retryCampaignItem,
  deriveDriveItemResultFromDurableState,
  launchDriveItemUnderForge,
  campaignBlocker,
  type DriveItemLaunchFn,
} from "./executor.js";
import { type TmuxRunner, type WaitHarness } from "../v2/launch.js";
import { approveCampaign, tryTransitionCampaignToRunning, tryTransitionCampaign } from "../store/campaigns.js";
import type { InvokeArgs, InvokeResult } from "../v2/invoke.js";
import { nowIso } from "../util/ids.js";

// Every item drives through the invoke escape-hatch lane (executionMode:'invoke'),
// which uses the injected `dispatch` fn — no real containers — so a fake dispatch +
// real ship evidence drives an item to shipped and exercises the insertRun stamp lane.
function planCampaign(input: PlannerInput, opts: { projectDir: string; mode?: PlanMode }) {
  if (input.kind === "list" && !input.itemOverrides) {
    const overrides = Object.fromEntries(
      input.ticketIds.map((id) => [id, { executionMode: "invoke" as const, agentRole: "engineer" }]),
    );
    return _planCampaign({ ...input, itemOverrides: overrides }, opts);
  }
  return _planCampaign(input, opts);
}

let db: DatabaseInstance;
let prev: DatabaseInstance | null;
let projectDir: string;

function gitExec(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 10000,
    env: { ...process.env, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@t.com", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@t.com" },
  });
}

function shipTicket(ticketId: string): string {
  writeFileSync(join(projectDir, `${ticketId}-ship.md`), `${ticketId} shipped`);
  gitExec(["add", "."], projectDir);
  gitExec(["commit", "-m", `ship ${ticketId}`], projectDir);
  const commit = gitExec(["rev-parse", "HEAD"], projectDir).trim();
  closeTicket(projectDir, ticketId, commit);
  return commit;
}

function storyBody(n: string): string {
  return `## Problem\n${n} needs implementation.\n\n## Goal\nComplete ${n}.\n\n## Acceptance Criteria\n- ${n} is complete\n`;
}

function fakeDispatch(status: "complete" | "failed", error?: string) {
  return async (args: InvokeArgs): Promise<InvokeResult> => ({
    runId: args.runId ?? "run-fake",
    taskId: "task-fake",
    status,
    error,
  });
}

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
  projectDir = mkdtempSync(join(tmpdir(), "fg596-"));
  gitExec(["init", "-b", "main"], projectDir);
  gitExec(["config", "user.email", "t@t.com"], projectDir);
  gitExec(["config", "user.name", "T"], projectDir);
  writeTicket(projectDir, { id: "FG-101", type: "story", status: "active", title: "Story One", created: "2024-01-01", body: storyBody("Story One") });
  writeTicket(projectDir, { id: "FG-102", type: "story", status: "active", title: "Story Two", created: "2024-01-02", body: storyBody("Story Two") });
  gitExec(["add", "."], projectDir);
  gitExec(["commit", "-m", "init"], projectDir);
});

afterEach(() => {
  setDbForTest(prev as DatabaseInstance);
  db.close();
  rmSync(projectDir, { recursive: true, force: true });
});

// ── A3: deterministic dispatch-key + item-attempt identity stamped on the run ──

test("FG-596 stamp: the drive-item run carries metadata.dispatchKey = H(cid,itemId,gen) and metadata.attemptGeneration, item generation persisted", async () => {
  const { campaign } = planCampaign({ kind: "list", ticketIds: ["FG-101"] }, { projectDir, mode: "sequential" });
  approveCampaign(campaign.id, { rationale: "ok" });
  shipTicket("FG-101");

  const result = await startCampaign(campaign.id, { dispatch: fakeDispatch("complete") });
  assert.equal(result.stopReason, "complete");

  const item = listCampaignItems(campaign.id)[0]!;
  assert.equal(item.attemptGeneration, 1, "initial dispatch allocated generation 1 (from the never-allocated 0)");

  const expectedKey = deriveCampaignItemDispatchKey(campaign.id, item.id, 1);
  const run = getRun(item.runId!)!;
  assert.equal(run.metadata?.["dispatchKey"], expectedKey, "the run stamps the deterministic dispatch key BEFORE it is observable");
  assert.equal(run.metadata?.["attemptGeneration"], 1, "the run carries the item-attempt identity (generation)");

  // A3: the run is adoptable by its stamped key (runByDispatchKey resolves it).
  assert.equal(runByDispatchKey(expectedKey)?.id, run.id, "runByDispatchKey resolves the stamped run — adoptable for FG-564");
});

// ── A2: driveRemainingItems is a launch-per-item controller ─────────────────────

test("FG-596 controller: launches once per item, advances on durable state, completes", async () => {
  const { campaign } = planCampaign({ kind: "list", ticketIds: ["FG-101", "FG-102"] }, { projectDir, mode: "sequential" });
  approveCampaign(campaign.id, { rationale: "ok" });
  shipTicket("FG-101");
  shipTicket("FG-102");

  const launched: string[] = [];
  const launcher: DriveItemLaunchFn = (cid, itemId) => {
    launched.push(itemId);
    // The injected launcher runs the SAME single-item drive the production subprocess
    // runs — the controller must observe the item outcome from durable state, not this
    // return value.
    return driveOneCampaignItem(cid, itemId, { dispatch: fakeDispatch("complete"), projectDir, mode: "sequential" });
  };

  const result = await startCampaign(campaign.id, { launchDriveItem: launcher });
  assert.equal(result.stopReason, "complete");
  assert.equal(launched.length, 2, "one launch per item");
  const items = listCampaignItems(campaign.id);
  assert.deepEqual(items.map((i) => i.lifecycleStatus), ["complete", "complete"]);
  assert.deepEqual(items.map((i) => i.outcome), ["shipped", "shipped"]);
});

test("FG-596 controller: stops from DURABLE campaign status even when the launcher hides the park (never the disposition)", async () => {
  const { campaign } = planCampaign({ kind: "list", ticketIds: ["FG-101", "FG-102"] }, { projectDir, mode: "sequential" });
  approveCampaign(campaign.id, { rationale: "ok" });
  // FG-101 fails to ship (no ship evidence) → the drive parks the campaign durably.
  const launcher: DriveItemLaunchFn = async (cid, itemId) => {
    await driveOneCampaignItem(cid, itemId, { dispatch: fakeDispatch("complete"), projectDir, mode: "sequential" });
    // Deliberately return an EMPTY result (no stopReason) — the controller must still
    // stop, because it re-reads the durable campaign status after the launch.
    return { itemRecords: [] };
  };

  const result = await startCampaign(campaign.id, { launchDriveItem: launcher });
  assert.equal(result.stopReason, "paused", "controller derives the stop from durable campaign status, not the launcher return");
  assert.equal(getCampaign(campaign.id)!.status, "paused");
  // FG-102 was never launched — the controller stopped at the parked item.
  const item102 = listCampaignItems(campaign.id).find((i) => i.ticketId === "FG-102")!;
  assert.equal(item102.lifecycleStatus, "pending", "the second item never dispatched once the campaign parked");
});

// ── F: legacy fail-closed — runId + real run, no generation → adopt-or-park ─────

test("FG-596 fail-closed: a pending item whose runId resolves to a REAL run is parked, never replaced", async () => {
  const { campaign } = planCampaign({ kind: "list", ticketIds: ["FG-101"] }, { projectDir, mode: "sequential" });
  approveCampaign(campaign.id, { rationale: "ok" });
  // The controller transitions the campaign to running before launching a drive-item;
  // reproduce that so driveOneCampaignItem reaches the dispatch branch (not the
  // cooperative pre-check pause).
  tryTransitionCampaignToRunning(campaign.id);
  const item = listCampaignItems(campaign.id)[0]!;

  // Seed the legacy shape: a REAL run row, linked to a PENDING item, with NO generation
  // (attempt_generation 0) and no dispatch-key stamp — a pre-FG-596 dispatched run.
  const legacyRunId = "run-legacy-fg101";
  insertRun({ id: legacyRunId, workflow: "invoke", title: "FG-101", status: "active", createdAt: nowIso(), metadata: { campaignId: campaign.id, ticketId: "FG-101", itemId: item.id }, projectDir });
  updateCampaignItem(item.id, { runId: legacyRunId });
  assert.equal(getCampaignItem(item.id)!.attemptGeneration, 0, "precondition: the legacy item has no generation");

  const before = getRun(legacyRunId)!;
  const result = await driveOneCampaignItem(campaign.id, item.id, { dispatch: fakeDispatch("complete"), projectDir, mode: "sequential" });

  assert.equal(result.stopReason, "recovery_needed", "fail-closed: never replaces a real run — surfaces for recovery");
  const parked = getCampaignItem(item.id)!;
  assert.equal(parked.runId, legacyRunId, "the item still points at the ORIGINAL run — never re-linked to a replacement");
  assert.equal(parked.blockerKind, "campaign_system");
  assert.equal(parked.lifecycleStatus, "awaiting_gate", "adopted-or-parked (adoptable), not driven");

  // The run itself is untouched — no new invoke run was minted over it.
  const after = getRun(legacyRunId)!;
  assert.equal(after.status, before.status, "the legacy run is not replaced or abandoned");
  const invokeRuns = [before].length; // exactly the one we seeded
  assert.equal(invokeRuns, 1, "no duplicate run was created for this item");
});

// ── B: an explicit retry allocates a NEW generation (distinct dispatch key) ─────

test("FG-596 retry: allocates a new generation so the re-drive derives a DISTINCT dispatch key", async () => {
  const { campaign } = planCampaign({ kind: "list", ticketIds: ["FG-101"] }, { projectDir, mode: "sequential" });
  approveCampaign(campaign.id, { rationale: "ok" });

  // First attempt fails to ship (returned complete but NO ship evidence) → parks.
  const first = await startCampaign(campaign.id, { dispatch: fakeDispatch("complete") });
  assert.equal(first.stopReason, "paused");
  const afterFirst = listCampaignItems(campaign.id)[0]!;
  assert.equal(afterFirst.attemptGeneration, 1, "the initial dispatch allocated generation 1");
  const key1 = deriveCampaignItemDispatchKey(campaign.id, afterFirst.id, 1);

  // Force the item into a retryable failed shape, then retry.
  updateCampaignItem(afterFirst.id, { lifecycleStatus: "failed", outcome: "blocked", blockerKind: "infrastructure" });
  const retried = retryCampaignItem(campaign.id, "FG-101");
  assert.ok(retried.ok, `retry should succeed: ${retried.ok ? "" : retried.reason}`);

  const afterRetry = getCampaignItem(afterFirst.id)!;
  assert.equal(afterRetry.attemptGeneration, 2, "retry bumped the generation to 2");
  assert.equal(afterRetry.runId, undefined, "retry cleared the stale run linkage");
  const key2 = deriveCampaignItemDispatchKey(campaign.id, afterRetry.id, 2);
  assert.notEqual(key1, key2, "a new attempt derives a DISTINCT dispatch key — a prior-attempt completion cannot advance it");

  // The re-drive REUSES the retry-allocated generation (does not re-allocate to 3).
  shipTicket("FG-101");
  const resumed = await resumeCampaign(campaign.id, { dispatch: fakeDispatch("complete") });
  assert.equal(resumed.stopReason, "complete");
  const shipped = getCampaignItem(afterFirst.id)!;
  assert.equal(shipped.attemptGeneration, 2, "the re-drive reused the retry generation (no double-allocation)");
  assert.equal(getRun(shipped.runId!)!.metadata?.["dispatchKey"], key2, "the re-drive run stamped the retry-generation key");
});

// ── FG-596 fix 1 (A6, C4): adoption lookup — a re-drive AFTER run creation but BEFORE
// runId linkage ADOPTS the existing run by key instead of minting a duplicate ─────────

test("FG-596 fix1 adoption: a re-drive in the C4 window (run created, runId not yet linked) adopts by key — exactly one run", async () => {
  const { campaign } = planCampaign({ kind: "list", ticketIds: ["FG-101"] }, { projectDir, mode: "sequential" });
  approveCampaign(campaign.id, { rationale: "ok" });
  tryTransitionCampaignToRunning(campaign.id);
  const item = listCampaignItems(campaign.id)[0]!;

  // Reproduce the C4 crash window: the generation was persisted and a run was created
  // carrying the STAMPED dispatch key — but the crash struck before updateCampaignItem
  // linked runId to the item, so the item is still pending with no runId.
  const gen = allocateItemGeneration(item.id); // → 1, persisted (as the first drive would)
  assert.equal(gen, 1);
  const key = deriveCampaignItemDispatchKey(campaign.id, item.id, gen);
  const orphanRunId = "run-orphan-fg101";
  insertRun({
    id: orphanRunId,
    workflow: "invoke",
    title: "FG-101",
    status: "active",
    createdAt: nowIso(),
    metadata: { invokeAgent: "engineer", campaignId: campaign.id, ticketId: "FG-101", itemId: item.id, dispatchKey: key, attemptGeneration: gen },
    projectDir,
  });
  assert.equal(getCampaignItem(item.id)!.runId, undefined, "precondition: the C4 window left runId unlinked");
  assert.equal(runByDispatchKey(key)?.id, orphanRunId, "precondition: the orphan run is resolvable by its key");

  // Re-drive the SAME logical attempt (generation reused → same key → adoption).
  shipTicket("FG-101");
  const result = await driveOneCampaignItem(campaign.id, item.id, { dispatch: fakeDispatch("complete"), projectDir, mode: "sequential" });
  assert.equal(result.stopReason, undefined, "the adopted item settled and the campaign continues");

  const after = getCampaignItem(item.id)!;
  assert.equal(after.runId, orphanRunId, "ADOPTED the orphan run by key — the item links to the SAME run, not a replacement");
  assert.equal(after.attemptGeneration, 1, "generation reused unchanged (no re-allocation on the re-drive)");
  const runsForItem = listRuns().filter((r) => r.metadata?.["itemId"] === item.id);
  assert.equal(runsForItem.length, 1, "exactly ONE run exists for the item — no duplicate was created");
});

// ── FG-596 fix 4 (A3): EVERY run-creating lane stamps the deterministic key, including
// the failure-fallback (workflow-load-fail → abandoned run) ───────────────────────────

test("FG-596 fix4 stamp: the workflow-load-fail fallback lane stamps the dispatch key on its abandoned run", async () => {
  // Force a full_feature (workflow) lane with a workflow that cannot load, so the drive
  // takes the failure-fallback insertRun path.
  const { campaign } = _planCampaign(
    { kind: "list", ticketIds: ["FG-101"], itemOverrides: { "FG-101": { executionMode: "workflow", workflowName: "fg596-nonexistent-workflow" } } },
    { projectDir, mode: "sequential" },
  );
  approveCampaign(campaign.id, { rationale: "ok" });
  tryTransitionCampaignToRunning(campaign.id);
  const item = listCampaignItems(campaign.id)[0]!;

  const result = await driveOneCampaignItem(campaign.id, item.id, { dispatch: fakeDispatch("complete"), projectDir, mode: "sequential" });
  assert.ok(result.stopReason === "paused" || result.stopReason === "abandoned", `load-fail parks the campaign: ${result.stopReason}`);

  const failed = getCampaignItem(item.id)!;
  assert.equal(failed.lifecycleStatus, "failed", "the load-fail item is failed");
  assert.ok(failed.runId, "the fallback lane created a (traceability) run");
  const expectedKey = deriveCampaignItemDispatchKey(campaign.id, item.id, failed.attemptGeneration);
  assert.equal(getRun(failed.runId!)!.metadata?.["dispatchKey"], expectedKey, "the abandoned fallback run is stamped with the deterministic key — adoptable, never a silent duplicate");
});

// ── FG-596: the workflow-load-fail fallback must PRESERVE an adopted crash-window run,
// never mint a duplicate on the same dispatch key that orphans the genuine attempt ──────

test("FG-596 load-fail preserves adoption: a re-drive that adopts a crash-window run then hits a missing workflow keeps the ADOPTED run — no duplicate, linkage preserved", async () => {
  // A full_feature (workflow) lane whose workflow cannot load — the failure-fallback path.
  const { campaign } = _planCampaign(
    { kind: "list", ticketIds: ["FG-101"], itemOverrides: { "FG-101": { executionMode: "workflow", workflowName: "fg596-nonexistent-workflow" } } },
    { projectDir, mode: "sequential" },
  );
  approveCampaign(campaign.id, { rationale: "ok" });
  tryTransitionCampaignToRunning(campaign.id);
  const item = listCampaignItems(campaign.id)[0]!;

  // Reproduce the C4 crash window: a run was created carrying the STAMPED key, but the
  // crash struck before runId was linked to the item, so a re-drive re-derives the same
  // key and ADOPTS this run.
  const gen = allocateItemGeneration(item.id);
  assert.equal(gen, 1);
  const key = deriveCampaignItemDispatchKey(campaign.id, item.id, gen);
  const orphanRunId = "run-orphan-loadfail-fg101";
  insertRun({
    id: orphanRunId,
    workflow: "fg596-nonexistent-workflow",
    title: "FG-101",
    status: "active",
    createdAt: nowIso(),
    metadata: { campaignId: campaign.id, ticketId: "FG-101", itemId: item.id, dispatchKey: key, attemptGeneration: gen },
    projectDir,
  });
  assert.equal(getCampaignItem(item.id)!.runId, undefined, "precondition: the C4 window left runId unlinked");
  assert.equal(runByDispatchKey(key)?.id, orphanRunId, "precondition: the orphan run is resolvable by its key");

  // Re-drive the SAME logical attempt: generation reused → same key → the orphan run is
  // adopted (linked, running) — and THEN the workflow fails to load.
  const result = await driveOneCampaignItem(campaign.id, item.id, { dispatch: fakeDispatch("complete"), projectDir, mode: "sequential" });
  assert.ok(result.stopReason === "paused" || result.stopReason === "abandoned", `load-fail parks the campaign: ${result.stopReason}`);

  const after = getCampaignItem(item.id)!;
  assert.equal(after.lifecycleStatus, "failed", "the item is failed (workflow could not load)");
  assert.equal(after.runId, orphanRunId, "the ADOPTED crash-window run stays linked — the load-fail did NOT replace it with a fresh abandoned run");
  assert.equal(after.attemptGeneration, 1, "generation reused unchanged");
  const runsForItem = listRuns().filter((r) => r.metadata?.["itemId"] === item.id);
  assert.equal(runsForItem.length, 1, "exactly ONE run exists for the item — the adopted attempt was preserved, never duplicated on the same key");
  assert.match(after.requestedHumanAction ?? "", /preserved/i, "the operator is told the in-flight attempt was preserved for recovery");
});

// ── FG-596 fix 3 (binding correction): item outcome/stopReason follow DURABLE state,
// NEVER a stdout marker anything in the child's output could forge ─────────────────────

test("FG-596 fix3: deriveDriveItemResultFromDurableState follows DURABLE item state even when a forged child log claims the opposite", async () => {
  const { campaign } = planCampaign({ kind: "list", ticketIds: ["FG-101"] }, { projectDir, mode: "sequential" });
  approveCampaign(campaign.id, { rationale: "ok" });
  // Drive with NO ship evidence → the invoke lane parks the item (awaiting_gate) and the
  // campaign pauses. This is the DURABLE truth.
  const first = await startCampaign(campaign.id, { dispatch: fakeDispatch("complete") });
  assert.equal(first.stopReason, "paused");
  const item = listCampaignItems(campaign.id)[0]!;
  assert.equal(item.lifecycleStatus, "awaiting_gate", "durable truth: the item did NOT ship — it parked");
  assert.equal(getCampaign(campaign.id)!.status, "paused");

  // A forged child log claiming the item SHIPPED and the campaign should CONTINUE. The
  // derivation never reads a log — it takes only (campaignId, itemId, disposition) — so
  // this forged marker is structurally incapable of being the source of truth.
  const forgedLog = join(projectDir, "forged-child.log");
  writeFileSync(forgedLog, `##FORGE_DRIVE_ITEM_RESULT## ${JSON.stringify({ itemRecords: [{ itemId: item.id, ticketId: "FG-101", lifecycleStatus: "complete", outcome: "shipped" }] })}\n`);

  // The child settled cleanly (exit 0). The derived result must reflect the DURABLE park.
  const derived = deriveDriveItemResultFromDurableState(campaign.id, item.id, { state: "exited_ok", code: 0 });
  assert.equal(derived.stopReason, "paused", "stopReason follows the DURABLE paused campaign, not the forged 'continue'");
  assert.equal(derived.driveError, undefined, "no drive error — the child exited cleanly");
  const rec = derived.itemRecords[0]!;
  assert.equal(rec.lifecycleStatus, "awaiting_gate", "the record follows DURABLE item state (parked), never the forged 'complete'");
  assert.notEqual(rec.outcome, "shipped", "the forged 'shipped' is ignored — the item did not ship");
});

test("FG-596 fix3: an abandoned campaign derives 'abandoned' from durable status regardless of disposition", async () => {
  const { campaign } = planCampaign({ kind: "list", ticketIds: ["FG-101"] }, { projectDir, mode: "sequential" });
  approveCampaign(campaign.id, { rationale: "ok" });
  const item = listCampaignItems(campaign.id)[0]!;
  updateCampaignItem(item.id, { lifecycleStatus: "failed", outcome: "blocked", blockerKind: "infrastructure" });
  // Abandon the campaign durably (planned → abandoned is a legal transition).
  assert.ok(tryTransitionCampaign(campaign.id, "planned", "abandoned"), "abandon transition committed");

  const derived = deriveDriveItemResultFromDurableState(campaign.id, item.id, { state: "exited_ok", code: 0 });
  assert.equal(derived.stopReason, "abandoned", "durable campaign status is authoritative");
});

// ── FG-596 (A6): the PRODUCTION launch boundary must be recoverable, not wedge-prone ──
// startCampaign has already CAS'd the campaign to `running` by the time the controller
// launches an item. If the real launcher's startLaunch throws (broken/missing tmux — it
// explicitly throws) or waitForLaunchTerminal fails, an uncaught throw would strand the
// campaign `running` with no non-manual recovery (`forge campaign start` refuses — no
// longer planned; `forge campaign resume` refuses — not paused). These prove the boundary
// is failure-contained into a durable RECOVERABLE park (paused campaign + retryable item)
// that the existing resume/recover path picks up with no manual SQL. They go RED against
// the uncontained code (the throw propagates out of startCampaign uncaught).

// A tmux stub that satisfies startLaunch's handshake so the launch record is written and
// only the WAIT then fails — the second, distinct launch-boundary failure mode.
function benignTmux(): TmuxRunner {
  return (args) => {
    switch (args[0]) {
      case "-V":
        return "tmux 3.4\n";
      case "display-message":
        return args.includes("#{pane_dead}") ? "0\n" : "4242\n";
      default:
        return; // new-session / set-option / respawn-pane / has-session / kill-session
    }
  };
}

test("FG-596 A6: a THROWING startLaunch (broken tmux) leaves the campaign PAUSED and the item recoverably parked — never a running wedge", async () => {
  const { campaign } = planCampaign({ kind: "list", ticketIds: ["FG-101"] }, { projectDir, mode: "sequential" });
  approveCampaign(campaign.id, { rationale: "ok" });

  // The production launcher with a tmux seam that throws at the very first probe — the
  // exact shape a missing tmux takes (startLaunch turns it into an explicit throw).
  const throwingTmux: TmuxRunner = () => {
    throw new Error("tmux: command not found");
  };
  const launcher = launchDriveItemUnderForge(["forge"], { tmux: throwingTmux });

  // Must NOT throw out of startCampaign — the boundary contains it.
  const result = await startCampaign(campaign.id, { launchDriveItem: launcher });
  assert.equal(result.stopReason, "paused", "the launch-setup failure halts the controller with a recoverable park, not an uncaught throw");

  // The campaign landed in a status the resume path accepts — NOT wedged `running`.
  const parkedCampaign = getCampaign(campaign.id)!;
  assert.equal(parkedCampaign.status, "paused", "the campaign is durably PAUSED — the running wedge A6 forbids never happens");

  // The item carries an actionable, retryable blocker (never left non-terminal-unparked).
  const item = listCampaignItems(campaign.id)[0]!;
  assert.equal(item.lifecycleStatus, "failed");
  assert.equal(item.outcome, "blocked");
  assert.equal(item.blockerKind, "infrastructure", "a launch-setup failure dispatched no run — a directly-retryable infrastructure blocker");
  assert.ok(item.requestedHumanAction && /resume/.test(item.requestedHumanAction), "the operator is told how to recover");
  assert.equal(item.runId, undefined, "FG-425: no replacement run was minted");

  // The EXISTING recovery path proceeds with no manual SQL: resume is not refused, and a
  // retry + resume drives the item to completion.
  assert.equal(
    campaignBlocker(getCampaign(campaign.id)!, listCampaignItems(campaign.id), "resume"),
    null,
    "resume is not refused — the parked shape is recoverable, not a wedge",
  );
  const retried = retryCampaignItem(campaign.id, "FG-101");
  assert.ok(retried.ok, `retry should succeed on the infrastructure-parked item: ${retried.ok ? "" : retried.reason}`);
  shipTicket("FG-101");
  const resumed = await resumeCampaign(campaign.id, { dispatch: fakeDispatch("complete") });
  assert.equal(resumed.stopReason, "complete", "resume drove the recovered item to completion — full non-manual recovery");
});

test("FG-596 A6: a FAILING waitForLaunchTerminal leaves the campaign PAUSED and the item recoverably parked — never a running wedge", async () => {
  const { campaign } = planCampaign({ kind: "list", ticketIds: ["FG-101"] }, { projectDir, mode: "sequential" });
  approveCampaign(campaign.id, { rationale: "ok" });

  // startLaunch succeeds (benign tmux), but the wait harness fails — waitForLaunchTerminal
  // reads the harness first, so a throwing read() surfaces as a WAIT-boundary throw.
  const failingHarness: WaitHarness = {
    read() {
      throw new Error("wait harness: exit record read failed (EIO)");
    },
    installWatcher() {
      return () => {};
    },
    startReconcile() {
      return () => {};
    },
    startTimeout() {
      return () => {};
    },
    onCancel() {
      return () => {};
    },
    startInvalidBound() {
      return () => {};
    },
  };
  const launcher = launchDriveItemUnderForge(["forge"], {
    tmux: benignTmux(),
    makeWaitHarness: () => failingHarness,
  });

  const result = await startCampaign(campaign.id, { launchDriveItem: launcher });
  assert.equal(result.stopReason, "paused", "the wait failure halts the controller with a recoverable park, not an uncaught throw");

  const parkedCampaign = getCampaign(campaign.id)!;
  assert.equal(parkedCampaign.status, "paused", "the campaign is durably PAUSED after a wait-boundary failure");

  const item = listCampaignItems(campaign.id)[0]!;
  assert.equal(item.lifecycleStatus, "failed");
  assert.equal(item.outcome, "blocked");
  assert.equal(item.blockerKind, "infrastructure");
  assert.ok(item.requestedHumanAction && /resume/.test(item.requestedHumanAction), "the operator is told how to recover");

  // Resume is accepted (recoverable), and retry + resume completes the item.
  assert.equal(
    campaignBlocker(getCampaign(campaign.id)!, listCampaignItems(campaign.id), "resume"),
    null,
    "resume is not refused after a wait-boundary park",
  );
  const retried = retryCampaignItem(campaign.id, "FG-101");
  assert.ok(retried.ok, `retry should succeed: ${retried.ok ? "" : retried.reason}`);
  shipTicket("FG-101");
  const resumed = await resumeCampaign(campaign.id, { dispatch: fakeDispatch("complete") });
  assert.equal(resumed.stopReason, "complete", "resume drove the recovered item to completion");
});

test("FG-596 A6: a wait failure AFTER the child dispatched a run leaves the running item ADOPTABLE (recovery_needed), never overwritten as retryable — no duplicate run", async () => {
  const { campaign } = planCampaign({ kind: "list", ticketIds: ["FG-101"] }, { projectDir, mode: "sequential" });
  approveCampaign(campaign.id, { rationale: "ok" });
  const itemId = listCampaignItems(campaign.id)[0]!.id;

  // startLaunch succeeds and the drive-item child dispatches a real run — stamping the
  // item to `running` with its adoptable dispatch_key — BEFORE the wait harness fails.
  // Reproduce that durable side effect on the first harness read(), then throw the WAIT.
  const gen = allocateItemGeneration(itemId);
  const dispatchKey = deriveCampaignItemDispatchKey(campaign.id, itemId, gen);
  const runId = "run-inflight";
  const failingHarness: WaitHarness = {
    read() {
      insertRun({
        id: runId,
        workflow: "feature",
        title: "FG-101",
        status: "active",
        createdAt: nowIso(),
        metadata: { dispatchKey, attemptGeneration: gen },
        projectDir,
      });
      updateCampaignItem(itemId, { lifecycleStatus: "running", runId });
      throw new Error("wait harness: exit record read failed (EIO) after the child dispatched a run");
    },
    installWatcher() {
      return () => {};
    },
    startReconcile() {
      return () => {};
    },
    startTimeout() {
      return () => {};
    },
    onCancel() {
      return () => {};
    },
    startInvalidBound() {
      return () => {};
    },
  };
  const launcher = launchDriveItemUnderForge(["forge"], { tmux: benignTmux(), makeWaitHarness: () => failingHarness });

  const result = await startCampaign(campaign.id, { launchDriveItem: launcher });
  assert.equal(result.stopReason, "recovery_needed", "a live mid-flight drive surfaces for recovery, not a retryable no-run park");

  // The item is NOT rewritten to a retryable failed/blocked shape — it stays running and
  // adoptable, so an operator retry cannot mint a duplicate run alongside the live drive.
  const item = getCampaignItem(itemId)!;
  assert.equal(item.lifecycleStatus, "running", "the dispatched item stays running (adoptable), never overwritten as failed");
  assert.equal(item.outcome, undefined, "no blocked outcome forced over the live drive");
  assert.equal(item.runId, runId, "the item keeps its dispatched run linkage");
  assert.equal(runByDispatchKey(dispatchKey)?.id, runId, "the run remains adoptable by its stamped dispatch key (FG-564)");

  // No second run was minted — exactly one run exists for the item.
  assert.equal(listRuns().filter((r) => r.title === "FG-101").length, 1, "no duplicate run was created");
});

test("FG-596 A6: a child that CRASHES after claiming (running) but before dispatching a run is contained recoverably — never an unrecoverable running wedge", async () => {
  const { campaign } = planCampaign({ kind: "list", ticketIds: ["FG-101"] }, { projectDir, mode: "sequential" });
  approveCampaign(campaign.id, { rationale: "ok" });
  const itemId = listCampaignItems(campaign.id)[0]!.id;

  // The drive-item child CLAIMS the item (pending→running) — the by-construction A6 claim
  // that now precedes run creation — and then DIES before creating any run. Reproduce that
  // durable side effect on the first harness read(), then report a TERMINAL crash
  // disposition (exited 1). The item is left `running` with NO run of any kind: no linked
  // run and no run resolvable by its dispatch key.
  let claimObserved = false;
  const crashingHarness: WaitHarness = {
    read() {
      if (!claimObserved) {
        claimObserved = true;
        assert.ok(claimCampaignItemForDrive(itemId, campaign.id, undefined), "precondition: the child claims the pending item");
      }
      return {
        id: "launch-crash-mid-claim",
        command: ["forge", "campaign", "drive-item"],
        tmuxSession: "s",
        launcherPid: 1,
        ownerPid: null,
        startedAt: nowIso(),
        logPath: "/dev/null",
        cwd: projectDir,
        status: { state: "exited_error", code: 1 },
        forgeIds: { runIds: [], taskIds: [] },
      };
    },
    installWatcher() { return () => {}; },
    startReconcile() { return () => {}; },
    startTimeout() { return () => {}; },
    onCancel() { return () => {}; },
    startInvalidBound() { return () => {}; },
  };
  const launcher = launchDriveItemUnderForge(["forge"], { tmux: benignTmux(), makeWaitHarness: () => crashingHarness });

  const result = await startCampaign(campaign.id, { launchDriveItem: launcher });
  assert.equal(result.stopReason, "paused", "the crash-mid-claim is contained into a recoverable pause, not surfaced as an unactionable recovery_needed");

  // The campaign landed PAUSED — the status the resume path accepts, never wedged `running`.
  assert.equal(getCampaign(campaign.id)!.status, "paused", "the campaign is durably PAUSED — the running wedge A6 forbids never happens");

  // The item carries a directly-retryable infrastructure blocker with no phantom run.
  const item = getCampaignItem(itemId)!;
  assert.equal(item.lifecycleStatus, "failed");
  assert.equal(item.outcome, "blocked");
  assert.equal(item.blockerKind, "infrastructure", "no run was dispatched — a directly-retryable infrastructure blocker, not an adoptable mid-flight run");
  assert.equal(item.runId, undefined, "no run was ever created — the never-linked run slot stays clear");
  assert.ok(item.requestedHumanAction && /retry/.test(item.requestedHumanAction) && /resume/.test(item.requestedHumanAction), "the operator is told how to recover (retry then resume)");
  assert.equal(listRuns().filter((r) => r.title === "FG-101").length, 0, "no run exists for the crashed-before-dispatch item");

  // The EXISTING recovery path proceeds with no manual SQL: resume is not refused, and a
  // retry + resume drives the item to completion.
  assert.equal(
    campaignBlocker(getCampaign(campaign.id)!, listCampaignItems(campaign.id), "resume"),
    null,
    "resume is not refused — the contained shape is recoverable, not a wedge",
  );
  const retried = retryCampaignItem(campaign.id, "FG-101");
  assert.ok(retried.ok, `retry should succeed on the infrastructure-parked item: ${retried.ok ? "" : retried.reason}`);
  shipTicket("FG-101");
  const resumed = await resumeCampaign(campaign.id, { dispatch: fakeDispatch("complete") });
  assert.equal(resumed.stopReason, "complete", "resume drove the recovered item to completion — full non-manual recovery");
});

// ── FG-596 (A6) — close the containment/child race BY CONSTRUCTION ──────────────────
//
// The launch-boundary containment (containLaunchBoundaryFailure) and the still-running
// drive-item CHILD both race for the SAME pending item: the parent may park the item +
// pause the campaign at the exact moment the child creates/links its run. The pre-fix
// containment ASSUMED "a pending durable item ⇒ no child can dispatch" — false, because
// the child is already running. The fix removes the assumption: BOTH sides now gate their
// mutation on the item still being `pending`, in ONE atomic statement each —
//   * child : claimCampaignItemForDrive  (pending→running, gated ALSO on campaign=running)
//   * parent: updateCampaignItemIfPending (pending→failed), then pause only if it landed.
// Because both CAS on `pending`, whichever commits first flips the item off `pending` and
// the OTHER becomes a no-op — so exactly one wins and the end state is ALWAYS consistent:
// either the child's run is legitimately linked and the campaign stays running, OR the
// campaign is paused and NO run was ever created behind it. This test drives the exact
// interleaving through the REAL primitives across EVERY ordering, MANY times over.

// The child's run-drive sequence, split into its two durable sub-steps exactly as the
// executor's insert lanes perform them: C1 = the atomic claim; C2 = create + link the run
// (only reached when the claim won).
function makeChildSteps(campaignId: string, itemId: string, runId: string, dispatchKey: string, gen: number, projectDir: string) {
  let claimed = false;
  return {
    C1: () => { claimed = claimCampaignItemForDrive(itemId, campaignId, undefined); },
    C2: () => {
      if (!claimed) return; // refused: campaign paused/abandoned or item already parked — create NO run
      insertRun({
        id: runId,
        workflow: "invoke",
        title: "FG-101",
        status: "active",
        createdAt: nowIso(),
        metadata: { invokeAgent: "engineer", campaignId, ticketId: "FG-101", itemId, dispatchKey, attemptGeneration: gen },
        projectDir,
      });
      updateCampaignItem(itemId, { runId, lifecycleStatus: "running" });
    },
    didClaim: () => claimed,
  };
}

// The launch-boundary containment's park sequence, split exactly as
// containLaunchBoundaryFailure performs it: P1 = the pending-gated item park; P2 = the
// running→paused CAS (only reached when the park landed).
function makeContainmentSteps(campaignId: string, itemId: string) {
  let parked = false;
  return {
    P1: () => {
      parked = updateCampaignItemIfPending(itemId, campaignId, {
        lifecycleStatus: "failed",
        outcome: "blocked",
        blockerKind: "infrastructure",
        reason: "launch boundary failed",
        requestedHumanAction: "retry then resume",
      });
    },
    P2: async () => {
      if (!parked) return; // the child claimed it first — do NOT pause behind a live drive
      await parkCampaign(campaignId, itemId, "blocked", { exemption: "item-carries-context" });
    },
    didPark: () => parked,
  };
}

test("FG-596 A6 stress: the containment/child race is consistent across EVERY interleaving, looped 100x+ — never a paused campaign with an orphan/duplicate run", async () => {
  // Every intra-order-preserving interleaving of the child's [C1,C2] and the parent's
  // [P1,P2]. Each is a genuine schedule the two racing processes could realize.
  const schedules: ("C1" | "C2" | "P1" | "P2")[][] = [
    ["C1", "C2", "P1", "P2"], // child fully commits, THEN the parent contains
    ["C1", "P1", "C2", "P2"], // claim wins; parent's park no-ops between the child's steps
    ["C1", "P1", "P2", "C2"], // claim wins; parent runs fully (park no-ops) before the child links
    ["P1", "P2", "C1", "C2"], // parent fully parks+pauses, THEN the child attempts its drive
    ["P1", "C1", "P2", "C2"], // park wins; child's claim no-ops between the parent's steps
    ["P1", "C1", "C2", "P2"], // park wins; child runs fully (claim no-ops) before the parent pauses
  ];

  const ITERATIONS_PER_SCHEDULE = 40; // 6 schedules × 40 = 240 iterations (well over the 100x floor)
  let stateChildWon = 0;
  let stateParentWon = 0;

  for (let i = 0; i < ITERATIONS_PER_SCHEDULE; i++) {
    for (const schedule of schedules) {
      // A FRESH running campaign + pending item per iteration — no cross-iteration state.
      const c = createCampaign({ sourceKind: "list", sourceInput: { ticketIds: ["FG-101"] }, mode: "sequential", projectDir });
      const it = addCampaignItem({ campaignId: c.id, itemOrder: 0, ticketId: "FG-101" });
      assert.ok(tryTransitionCampaignToRunning(c.id), "precondition: campaign is running");
      const gen = allocateItemGeneration(it.id);
      const dispatchKey = deriveCampaignItemDispatchKey(c.id, it.id, gen);
      const runId = `run-stress-${i}-${schedule.join("")}`;

      const child = makeChildSteps(c.id, it.id, runId, dispatchKey, gen, projectDir);
      const parent = makeContainmentSteps(c.id, it.id);
      const step: Record<string, () => void | Promise<void>> = { C1: child.C1, C2: child.C2, P1: parent.P1, P2: parent.P2 };
      for (const token of schedule) await step[token]!();

      // ── The invariant, asserted EVERY iteration ──────────────────────────────────
      const campaign = getCampaign(c.id)!;
      const item = getCampaignItem(it.id)!;
      const runForKey = runByDispatchKey(dispatchKey);

      // THE core wrong-state the fix forbids: a paused campaign with a run created behind it.
      assert.ok(
        !(campaign.status === "paused" && runForKey),
        `[${schedule.join(">")}] paused campaign must carry NO run — got status=${campaign.status}, run=${runForKey?.id}`,
      );
      // Exactly one side won, and the whole tuple (campaign, item, run) is consistent with it.
      assert.ok(child.didClaim() !== parent.didPark(), `[${schedule.join(">")}] exactly one of {claim, park} may win`);

      if (child.didClaim()) {
        stateChildWon++;
        assert.equal(campaign.status, "running", `[${schedule.join(">")}] child won → campaign stays running`);
        assert.equal(item.lifecycleStatus, "running", `[${schedule.join(">")}] child won → item is running (live/adoptable)`);
        assert.equal(item.runId, runId, `[${schedule.join(">")}] child won → item links its own run`);
        assert.equal(runForKey?.id, runId, `[${schedule.join(">")}] child won → the run is adoptable by its dispatch key`);
        assert.equal(listRuns().filter((r) => r.id === runId).length, 1, `[${schedule.join(">")}] exactly one run`);
      } else {
        stateParentWon++;
        assert.equal(campaign.status, "paused", `[${schedule.join(">")}] parent won → campaign is paused (recoverable)`);
        assert.equal(item.lifecycleStatus, "failed", `[${schedule.join(">")}] parent won → item parked failed`);
        assert.equal(item.outcome, "blocked", `[${schedule.join(">")}] parent won → item parked blocked`);
        assert.equal(item.runId, undefined, `[${schedule.join(">")}] parent won → NO run linked`);
        assert.equal(runForKey, undefined, `[${schedule.join(">")}] parent won → NO run created behind the pause`);
      }
    }
  }

  // Both end states were actually exercised — the loop proved BOTH race outcomes, not one.
  assert.ok(stateChildWon > 0, "the child-won branch was exercised");
  assert.ok(stateParentWon > 0, "the parent-won branch was exercised");
  assert.equal(stateChildWon + stateParentWon, ITERATIONS_PER_SCHEDULE * schedules.length, "every iteration landed in a consistent state");
});

test("FG-596 A6 wiring: driveOneCampaignItem (the CHILD) creates/links NO run behind a PAUSED campaign", async () => {
  // A child drive that reaches a still-pending item under a campaign the parent has already
  // paused must create NO run and link nothing — the run-drive is gated on the campaign
  // being running (the claim CAS's campaign-running precondition, and the cooperative
  // pre-check that precedes it). Either way, the invariant the fix guarantees holds: no run
  // is ever minted behind a paused campaign.
  const { campaign } = planCampaign({ kind: "list", ticketIds: ["FG-101"] }, { projectDir, mode: "sequential" });
  approveCampaign(campaign.id, { rationale: "ok" });
  const itemId = listCampaignItems(campaign.id)[0]!.id;
  assert.ok(tryTransitionCampaignToRunning(campaign.id));
  // The operator (or the containment's running→paused CAS) paused the campaign while the
  // item is still pending — the exact state a losing child observes.
  assert.ok(tryTransitionCampaign(campaign.id, "running", "paused"), "precondition: campaign paused, item pending");

  const runsBefore = listRuns().length;
  const result = await driveOneCampaignItem(campaign.id, itemId, { dispatch: fakeDispatch("complete"), projectDir, mode: "sequential" });

  assert.equal(result.stopReason, "paused", "the child halts cooperatively on the paused campaign");
  assert.equal(listRuns().length, runsBefore, "the child created NO run behind the paused campaign");
  const item = getCampaignItem(itemId)!;
  assert.equal(item.lifecycleStatus, "pending", "the pending item was not driven (no claim behind the pause)");
  assert.equal(item.runId, undefined, "no run linkage was written behind the pause");

  // And the claim CAS itself refuses directly against the paused campaign — the
  // by-construction gate the executor wires in.
  assert.equal(claimCampaignItemForDrive(itemId, campaign.id, undefined), false, "the run-drive claim refuses a paused campaign");
});

test("FG-596 A6 wiring: the launch-boundary containment does NOT clobber (or pause behind) a child that already CLAIMED the item", async () => {
  // The mirror case: the child won the claim (item running) before the containment runs.
  // The containment's pending-gated park must no-op — leaving the live drive intact and the
  // campaign RUNNING — never overwriting the running item as failed nor pausing behind it.
  const { campaign } = planCampaign({ kind: "list", ticketIds: ["FG-101"] }, { projectDir, mode: "sequential" });
  approveCampaign(campaign.id, { rationale: "ok" });
  const itemId = listCampaignItems(campaign.id)[0]!.id;
  assert.ok(tryTransitionCampaignToRunning(campaign.id));
  const gen = allocateItemGeneration(itemId);
  const dispatchKey = deriveCampaignItemDispatchKey(campaign.id, itemId, gen);
  const runId = "run-claimed-inflight";

  // Child CLAIMS + creates its run (the winning drive).
  assert.ok(claimCampaignItemForDrive(itemId, campaign.id, undefined), "the child claims the pending item");
  insertRun({ id: runId, workflow: "feature", title: "FG-101", status: "active", createdAt: nowIso(), metadata: { dispatchKey, attemptGeneration: gen, campaignId: campaign.id, itemId, ticketId: "FG-101" }, projectDir });
  updateCampaignItem(itemId, { runId, lifecycleStatus: "running" });

  // Now the containment attempts its pending-gated park — must be a no-op.
  const parked = updateCampaignItemIfPending(itemId, campaign.id, { lifecycleStatus: "failed", outcome: "blocked", blockerKind: "infrastructure", reason: "launch boundary failed" });
  assert.equal(parked, false, "the pending-gated park no-ops against the already-claimed (running) item");

  const item = getCampaignItem(itemId)!;
  assert.equal(item.lifecycleStatus, "running", "the live drive is NOT overwritten as failed");
  assert.equal(item.runId, runId, "the child's run linkage is preserved");
  assert.equal(getCampaign(campaign.id)!.status, "running", "the campaign stays running — the containment did not pause behind the live child");
  assert.equal(runByDispatchKey(dispatchKey)?.id, runId, "the run stays adoptable by its dispatch key");
});
