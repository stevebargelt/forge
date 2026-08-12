// FG-596 (redesign) — the atomic pre-dispatch reservation + the launch-per-item
// controller, against a real store and a real single-item drive.
//
// The dispatch of a run-producing lane is now ONE atomic transaction
// (reserveCampaignDriveDispatch): allocate/reuse the generation, derive the dispatch key,
// insert the stamped run, link it to the item, and CAS the item pending→running — all or
// nothing. No partial shape ("running item with no run", "run created but not linked") is
// representable, so the old split claim + crash-mid-claim detector are gone. These tests
// prove the invariant directly (crash-before-commit, crash-after-commit, the concurrent
// loser) plus the controller's derive-from-durable-state advancement and the EXTERNAL
// launch-boundary containment that survives (a broken tmux / failing wait harness).

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
  reserveCampaignDriveDispatch,
  createCampaign,
  addCampaignItem,
  updateCampaignItemIfPending,
} from "../store/campaigns.js";
import { getRun, insertRun, resolveRunProjectIdentity, runByDispatchKey, listRuns } from "../store/runs.js";
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
import type { Workflow } from "../v2/schema.js";
import { nowIso, newRunId } from "../util/ids.js";

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

// Seed a fresh RUNNING campaign with one PENDING item and return its ids — the exact
// pre-dispatch state a run-producing lane reserves from.
function seedRunningPendingItem(ticketId = "FG-101"): { campaignId: string; itemId: string } {
  const c = createCampaign({ sourceKind: "list", sourceInput: { ticketIds: [ticketId] }, mode: "sequential", projectDir });
  const it = addCampaignItem({ campaignId: c.id, itemOrder: 0, ticketId });
  assert.ok(tryTransitionCampaignToRunning(c.id), "precondition: campaign running");
  return { campaignId: c.id, itemId: it.id };
}

// An invoke run insert exactly as the escape-hatch lane's createRun performs it —
// identity resolved ABOVE the reservation's write lock and handed to insertRun (FG-663).
function insertInvokeRun(id: string, campaignId: string, itemId: string, dispatchKey: string, gen: number) {
  insertRun(
    {
      id,
      workflow: "invoke",
      title: "FG-101",
      status: "active",
      createdAt: nowIso(),
      metadata: { invokeAgent: "engineer", campaignId, ticketId: "FG-101", itemId, dispatchKey, attemptGeneration: gen },
      projectDir,
    },
    resolveRunProjectIdentity(projectDir),
  );
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

// ── THE ATOMIC PRE-DISPATCH INVARIANT ──────────────────────────────────────────

test("atomic (crash BEFORE commit): a createRun throw rolls the WHOLE reservation back — item stays pending, generation unallocated, NO run", () => {
  const { campaignId, itemId } = seedRunningPendingItem();
  const runsBefore = listRuns().length;

  assert.throws(
    () =>
      reserveCampaignDriveDispatch({
        campaignId,
        itemId,
        createRun: ({ dispatchKey, attemptGeneration }) => {
          // Insert the run, then crash BEFORE the reservation commits — the whole tx
          // (claim + this insert + the pending link) must roll back atomically.
          insertInvokeRun("run-doomed", campaignId, itemId, dispatchKey, attemptGeneration);
          throw new Error("crash before commit");
        },
      }),
    /crash before commit/,
  );

  const item = getCampaignItem(itemId)!;
  assert.equal(item.lifecycleStatus, "pending", "the item is still pending — nothing partial survived the crash");
  assert.equal(item.attemptGeneration, 0, "the generation was NOT persisted — the tx rolled back");
  assert.equal(item.runId, undefined, "no run linkage was written");
  assert.equal(listRuns().length, runsBefore, "the inserted run did not survive the rollback — NO run row exists");
  assert.equal(runByDispatchKey(deriveCampaignItemDispatchKey(campaignId, itemId, 1)), undefined, "nothing is adoptable by the derived key");
});

test("atomic (crash AFTER commit): once the reservation commits, the item is running + linked to EXACTLY ONE run adoptable by dispatch_key — before any physical work", () => {
  const { campaignId, itemId } = seedRunningPendingItem();

  let capturedKey = "";
  const res = reserveCampaignDriveDispatch({
    campaignId,
    itemId,
    createRun: ({ dispatchKey, attemptGeneration }) => {
      capturedKey = dispatchKey;
      insertInvokeRun("run-committed", campaignId, itemId, dispatchKey, attemptGeneration);
      return "run-committed";
    },
  });

  assert.equal(res.status, "created");
  assert.equal(res.attemptGeneration, 1, "the first attempt allocated generation 1");
  // Simulate the crash: NO physical work (no runNext/invoke) ran after the commit — the
  // durable state alone must be a recoverable, adoptable shape.
  const item = getCampaignItem(itemId)!;
  assert.equal(item.lifecycleStatus, "running", "the item is running");
  assert.equal(item.runId, "run-committed", "linked to exactly one run");
  assert.equal(item.attemptGeneration, 1, "the generation is persisted on the item");
  assert.equal(capturedKey, deriveCampaignItemDispatchKey(campaignId, itemId, 1));
  assert.equal(runByDispatchKey(capturedKey)?.id, "run-committed", "the run is adoptable by its dispatch_key (recoverable/adoptable for FG-564)");
  assert.equal(listRuns().filter((r) => r.metadata?.["itemId"] === itemId).length, 1, "EXACTLY one run linked to the item");
});

test("atomic (concurrent loser): a second drive of the SAME item ADOPTS the winner's run — never a second generation or run — looped 120x", () => {
  let created = 0;
  let adopted = 0;
  for (let i = 0; i < 120; i++) {
    const { campaignId, itemId } = seedRunningPendingItem();

    // Winner: the first reservation creates + links the run.
    const winnerRunId = `run-winner-${i}`;
    const r1 = reserveCampaignDriveDispatch({
      campaignId,
      itemId,
      createRun: ({ dispatchKey, attemptGeneration }) => {
        insertInvokeRun(winnerRunId, campaignId, itemId, dispatchKey, attemptGeneration);
        return winnerRunId;
      },
    });

    // Loser: a second drive of the SAME item. Its createRun must NEVER be invoked — it
    // observes the winner's run by key and adopts it, allocating nothing and creating
    // nothing.
    let loserCreateRunCalled = false;
    const r2 = reserveCampaignDriveDispatch({
      campaignId,
      itemId,
      createRun: ({ dispatchKey, attemptGeneration }) => {
        loserCreateRunCalled = true;
        insertInvokeRun(`run-loser-${i}`, campaignId, itemId, dispatchKey, attemptGeneration);
        return `run-loser-${i}`;
      },
    });

    assert.equal(r1.status, "created", `[iter ${i}] the first drive wins and creates`);
    assert.equal(r2.status, "adopted", `[iter ${i}] the second drive adopts, never creates`);
    assert.equal(loserCreateRunCalled, false, `[iter ${i}] the loser's createRun was NEVER invoked — it allocated/inserted nothing`);
    assert.equal(r2.runId, winnerRunId, `[iter ${i}] the loser adopts the winner's run by key`);

    const item = getCampaignItem(itemId)!;
    assert.equal(item.attemptGeneration, 1, `[iter ${i}] exactly one generation was ever allocated`);
    assert.equal(item.runId, winnerRunId, `[iter ${i}] the item links the one winning run`);
    const runsForItem = listRuns().filter((r) => r.metadata?.["itemId"] === itemId);
    assert.equal(runsForItem.length, 1, `[iter ${i}] EXACTLY one run exists for the item — no duplicate`);
    if (r1.status === "created") created++;
    if (r2.status === "adopted") adopted++;
  }
  assert.equal(created, 120, "every iteration exercised the create branch");
  assert.equal(adopted, 120, "every iteration exercised the adopt branch");
});

test("atomic (loser STOPS): a reservation whose campaign was paused out from under it is LOST — allocates nothing, creates nothing", () => {
  const { campaignId, itemId } = seedRunningPendingItem();
  // The operator (or the launch-boundary containment) paused the campaign while the item
  // is still pending — the exact state a losing drive observes.
  assert.ok(tryTransitionCampaign(campaignId, "running", "paused"), "precondition: campaign paused, item pending");

  let createRunCalled = false;
  const res = reserveCampaignDriveDispatch({
    campaignId,
    itemId,
    createRun: ({ dispatchKey, attemptGeneration }) => {
      createRunCalled = true;
      insertInvokeRun("run-should-not-exist", campaignId, itemId, dispatchKey, attemptGeneration);
      return "run-should-not-exist";
    },
  });

  assert.equal(res.status, "lost", "a paused campaign loses the reservation");
  assert.equal(createRunCalled, false, "createRun was never invoked — no run allocated behind the pause");
  const item = getCampaignItem(itemId)!;
  assert.equal(item.lifecycleStatus, "pending", "the item is untouched — still pending");
  assert.equal(item.attemptGeneration, 0, "no generation was allocated");
  assert.equal(item.runId, undefined, "no run linkage");
  assert.equal(listRuns().length, 0, "NO run was created behind the paused campaign");
});

test("atomic (same-attempt re-drive reuses generation; retry mints a NEW one): the derived key stays stable across a re-drive and shifts on retry", () => {
  const { campaignId, itemId } = seedRunningPendingItem();

  // First drive: allocate generation 1, create + link a run.
  const r1 = reserveCampaignDriveDispatch({
    campaignId,
    itemId,
    createRun: ({ dispatchKey, attemptGeneration }) => {
      insertInvokeRun("run-gen1", campaignId, itemId, dispatchKey, attemptGeneration);
      return "run-gen1";
    },
  });
  assert.equal(r1.status, "created");
  assert.equal(r1.attemptGeneration, 1);
  const key1 = deriveCampaignItemDispatchKey(campaignId, itemId, 1);
  assert.equal(r1.dispatchKey, key1);

  // A re-drive of the SAME attempt (a recovery/reattach) REUSES generation 1 → same key →
  // adopts the existing run. It must not re-allocate to 2 nor mint a second run.
  let secondCreateRunCalled = false;
  const r2 = reserveCampaignDriveDispatch({
    campaignId,
    itemId,
    createRun: () => {
      secondCreateRunCalled = true;
      return "run-should-not-happen";
    },
  });
  assert.equal(r2.status, "adopted", "the same-attempt re-drive adopts the existing run");
  assert.equal(secondCreateRunCalled, false, "no second run was created on the re-drive");
  assert.equal(r2.attemptGeneration, 1, "the generation is reused unchanged");
  assert.equal(getCampaignItem(itemId)!.attemptGeneration, 1);

  // Force the item into a retryable failed shape under a PAUSED campaign, then retry —
  // the ONLY operation that mints a new logical generation.
  assert.ok(tryTransitionCampaign(campaignId, "running", "paused"));
  updateCampaignItem(itemId, { lifecycleStatus: "failed", outcome: "blocked", blockerKind: "infrastructure" });
  const retried = retryCampaignItem(campaignId, "FG-101");
  assert.ok(retried.ok, `retry should succeed: ${retried.ok ? "" : retried.reason}`);
  assert.equal(getCampaignItem(itemId)!.attemptGeneration, 2, "retry bumped the generation to 2");

  // The next drive (campaign back to running) REUSES the retry generation (2) → a DISTINCT
  // key → no false adoption of the gen-1 run → a fresh run.
  assert.ok(tryTransitionCampaign(campaignId, "paused", "running"));
  const r3 = reserveCampaignDriveDispatch({
    campaignId,
    itemId,
    createRun: ({ dispatchKey, attemptGeneration }) => {
      insertInvokeRun("run-gen2", campaignId, itemId, dispatchKey, attemptGeneration);
      return "run-gen2";
    },
  });
  assert.equal(r3.status, "created", "the retried attempt derives a DISTINCT key and creates a fresh run");
  assert.equal(r3.attemptGeneration, 2);
  const key2 = deriveCampaignItemDispatchKey(campaignId, itemId, 2);
  assert.notEqual(key1, key2, "the retry key differs from the first-attempt key — a delayed gen-1 completion cannot advance gen 2");
  assert.equal(r3.dispatchKey, key2);
  assert.equal(runByDispatchKey(key1)?.id, "run-gen1", "the gen-1 run is still resolvable by its own key");
  assert.equal(runByDispatchKey(key2)?.id, "run-gen2", "the gen-2 run is resolvable by the new key");
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
  assert.equal(runByDispatchKey(expectedKey)?.id, run.id, "runByDispatchKey resolves the stamped run — adoptable for FG-564");
});

// ── A6, C4: adoption of a crash-window run through the real drive path ───────────

test("FG-596 adoption: a re-drive in the C4 window (run created + generation persisted, runId not yet linked) adopts by key — exactly one run, LINKED but NOT re-driven (recovery_needed for FG-564)", async () => {
  const { campaign } = planCampaign({ kind: "list", ticketIds: ["FG-101"] }, { projectDir, mode: "sequential" });
  approveCampaign(campaign.id, { rationale: "ok" });
  tryTransitionCampaignToRunning(campaign.id);
  const item = listCampaignItems(campaign.id)[0]!;

  // Reproduce the C4 crash window WITHOUT the atomic reservation (which would never leave
  // this shape): persist generation 1 on the item and insert a run stamped with the derived
  // key, but leave the item pending with runId unlinked — as if a crash struck between an
  // older run creation and its linkage.
  updateCampaignItem(item.id, { attemptGeneration: 1 });
  const key = deriveCampaignItemDispatchKey(campaign.id, item.id, 1);
  insertInvokeRun("run-orphan-fg101", campaign.id, item.id, key, 1);
  const runBefore = getRun("run-orphan-fg101")!;
  assert.equal(getCampaignItem(item.id)!.runId, undefined, "precondition: the C4 window left runId unlinked");
  assert.equal(runByDispatchKey(key)?.id, "run-orphan-fg101", "precondition: the orphan run is resolvable by its key");

  // Re-drive the SAME logical attempt (generation reused → same key → adoption). FG-596
  // must NOT physically re-drive an adopted run — it ADOPTS (links) it and returns
  // recovery_needed, leaving the keyed run available for FG-564.
  shipTicket("FG-101");
  const result = await driveOneCampaignItem(campaign.id, item.id, { dispatch: fakeDispatch("complete"), projectDir, mode: "sequential" });
  assert.equal(result.stopReason, "recovery_needed", "the adopted run is NOT re-driven — FG-596 surfaces recovery_needed for FG-564");

  const after = getCampaignItem(item.id)!;
  assert.equal(after.runId, "run-orphan-fg101", "ADOPTED the orphan run by key — the item links the SAME run, not a replacement");
  assert.equal(after.attemptGeneration, 1, "generation reused unchanged (no re-allocation on the re-drive)");
  assert.equal(after.lifecycleStatus, "awaiting_gate", "the recovery shape — awaiting_gate, not driven to a terminal outcome");
  assert.equal(after.blockerKind, "campaign_system", "the recovery shape carries campaign_system so FG-564/reconcile keys off it");
  assert.notEqual(after.outcome, "shipped", "FG-596 did NOT drive the adopted run to shipped");
  assert.ok(after.requestedHumanAction?.includes("run-orphan-fg101"), "the recovery-needed action IDENTIFIES the adopted run for FG-564/operator");
  const runAfter = getRun("run-orphan-fg101")!;
  assert.equal(runAfter.status, runBefore.status, "the adopted run's state was NOT mutated — no physical drive touched it");
  const runsForItem = listRuns().filter((r) => r.metadata?.["itemId"] === item.id);
  assert.equal(runsForItem.length, 1, "exactly ONE run exists for the item — no duplicate was created");
});

// ── FG-596 boundary regressions: created drives, adopted does NOT (FG-564 owns it) ──
//
// THE RULE: only reservation.status === "created" (this caller minted the run, so it owns
// the physical drive) may enter the physical drive seam. An `adopted` reservation means the
// keyed run is owned by another drive — FG-596 keeps the link, drives NOTHING, mutates no
// run/task/publication state, infers no owner liveness, and returns recovery_needed
// identifying the run for FG-564. These two regressions prove exactly that.

test("FG-596 regression (concurrent raw drive-item): two concurrent drives on the SAME item produce EXACTLY ONE run — only the creator calls the physical drive seam; the adopter dispatches nothing and returns recovery_needed", async () => {
  const { campaign } = planCampaign({ kind: "list", ticketIds: ["FG-101"] }, { projectDir, mode: "sequential" });
  approveCampaign(campaign.id, { rationale: "ok" });
  tryTransitionCampaignToRunning(campaign.id);
  const item = listCampaignItems(campaign.id)[0]!;
  shipTicket("FG-101");

  // Spy physical drive seam: record every runId the invoke lane was called with, and HOLD
  // the creator inside the seam (item created + linked + 'running') so the second drive's
  // reservation runs against the live run — the exact concurrent-adoption window. The
  // adopter must never reach this seam.
  const dispatchedRunIds: string[] = [];
  let creatorReached!: () => void;
  const creatorAtSeam = new Promise<void>((res) => { creatorReached = res; });
  let releaseCreator!: () => void;
  const creatorGate = new Promise<void>((res) => { releaseCreator = res; });
  let held = false;
  const spyDispatch = async (args: InvokeArgs): Promise<InvokeResult> => {
    dispatchedRunIds.push(args.runId!);
    if (!held) {
      held = true;
      creatorReached();
      await creatorGate;
    }
    return { runId: args.runId ?? "run-fake", taskId: "task-fake", status: "complete" };
  };

  const drive1 = driveOneCampaignItem(campaign.id, item.id, { dispatch: spyDispatch, projectDir, mode: "sequential" });
  // Deterministic: the creator has reserved (created), linked the run, and is now holding
  // inside the physical seam before the second drive starts.
  await creatorAtSeam;

  const drive2 = driveOneCampaignItem(campaign.id, item.id, { dispatch: spyDispatch, projectDir, mode: "sequential" });
  const r2 = await drive2;

  // The adopter drove NOTHING — recovery_needed identifying the already-owned run.
  assert.equal(r2.stopReason, "recovery_needed", "the second (adopter) drive did NOT physically drive — recovery_needed");
  assert.equal(dispatchedRunIds.length, 1, "the physical drive seam was called EXACTLY once — only the creator reached it");
  const runsForItem = listRuns().filter((r) => r.metadata?.["itemId"] === item.id);
  assert.equal(runsForItem.length, 1, "EXACTLY ONE run — the adopter created no second run");
  const ownedRunId = runsForItem[0]!.id;
  assert.equal(dispatchedRunIds[0], ownedRunId, "the one physical drive was on the creator's run");
  const adopterItem = getCampaignItem(item.id)!;
  assert.equal(adopterItem.blockerKind, "campaign_system", "the adopter left the recovery shape for FG-564/reconcile");
  assert.ok(adopterItem.requestedHumanAction?.includes(ownedRunId), "the adopter's recovery-needed action IDENTIFIES the owned run for FG-564");
  const adopterRecord = r2.itemRecords.find((rec) => rec.itemId === item.id)!;
  assert.equal(adopterRecord.runId, ownedRunId, "the adopter's returned record identifies the already-owned run");

  releaseCreator();
  await drive1;

  // Still exactly one run after the creator's drive settled — no duplicate was ever minted.
  assert.equal(listRuns().filter((r) => r.metadata?.["itemId"] === item.id).length, 1, "still EXACTLY ONE run after both drives settled");
  assert.equal(dispatchedRunIds.length, 1, "the physical drive seam was never called a second time");
});

test("FG-596 regression (crash-recovery boundary): a re-drive after a driver crash ADOPTS the keyed run and returns recovery_needed WITHOUT re-driving — the physical drive seam is NEVER called and the run stays available for FG-564", async () => {
  const { campaign } = planCampaign({ kind: "list", ticketIds: ["FG-101"] }, { projectDir, mode: "sequential" });
  approveCampaign(campaign.id, { rationale: "ok" });
  tryTransitionCampaignToRunning(campaign.id);
  const item = listCampaignItems(campaign.id)[0]!;

  // A crashed driver left the keyed run created + generation persisted, item still pending
  // and unlinked (the C4 crash window). The run remains adoptable by its dispatch key.
  updateCampaignItem(item.id, { attemptGeneration: 1 });
  const key = deriveCampaignItemDispatchKey(campaign.id, item.id, 1);
  insertInvokeRun("run-crashed-driver", campaign.id, item.id, key, 1);
  const runBefore = getRun("run-crashed-driver")!;

  // Spy physical drive seam: it must NEVER be called on a crash re-drive of an adopted run.
  let dispatchCalls = 0;
  const spyDispatch = async (args: InvokeArgs): Promise<InvokeResult> => {
    dispatchCalls++;
    return { runId: args.runId ?? "run-fake", taskId: "task-fake", status: "complete" };
  };

  shipTicket("FG-101");
  const result = await driveOneCampaignItem(campaign.id, item.id, { dispatch: spyDispatch, projectDir, mode: "sequential" });

  assert.equal(result.stopReason, "recovery_needed", "the crash re-drive ADOPTS and surfaces recovery_needed — never re-drives");
  assert.equal(dispatchCalls, 0, "FG-596 NEVER physically re-drives an adopted run — the drive seam was not called");

  const after = getCampaignItem(item.id)!;
  assert.equal(after.runId, "run-crashed-driver", "the keyed run stays LINKED — available for FG-564 to drive");
  assert.equal(runByDispatchKey(key)?.id, "run-crashed-driver", "the run remains adoptable by its dispatch key for FG-564");
  assert.equal(getRun("run-crashed-driver")!.status, runBefore.status, "the adopted run's state was NOT mutated by FG-596");
  assert.ok(after.requestedHumanAction?.includes("run-crashed-driver"), "recovery_needed IDENTIFIES the run for FG-564/operator");
  const runsForItem = listRuns().filter((r) => r.metadata?.["itemId"] === item.id);
  assert.equal(runsForItem.length, 1, "exactly ONE run — no duplicate minted on the re-drive");
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
  const launcher: DriveItemLaunchFn = async (cid, itemId) => {
    await driveOneCampaignItem(cid, itemId, { dispatch: fakeDispatch("complete"), projectDir, mode: "sequential" });
    return { itemRecords: [] };
  };

  const result = await startCampaign(campaign.id, { launchDriveItem: launcher });
  assert.equal(result.stopReason, "paused", "controller derives the stop from durable campaign status, not the launcher return");
  assert.equal(getCampaign(campaign.id)!.status, "paused");
  const item102 = listCampaignItems(campaign.id).find((i) => i.ticketId === "FG-102")!;
  assert.equal(item102.lifecycleStatus, "pending", "the second item never dispatched once the campaign parked");
});

// ── F: legacy fail-closed — runId + real run, no generation → adopt-or-park ─────

test("FG-596 fail-closed: a pending item whose runId resolves to a REAL run is parked, never replaced", async () => {
  const { campaign } = planCampaign({ kind: "list", ticketIds: ["FG-101"] }, { projectDir, mode: "sequential" });
  approveCampaign(campaign.id, { rationale: "ok" });
  tryTransitionCampaignToRunning(campaign.id);
  const item = listCampaignItems(campaign.id)[0]!;

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
  const after = getRun(legacyRunId)!;
  assert.equal(after.status, before.status, "the legacy run is not replaced or abandoned");
});

// ── B: an explicit retry allocates a NEW generation (end-to-end recovery) ───────

test("FG-596 retry: allocates a new generation so the re-drive derives a DISTINCT dispatch key, and the re-drive reuses it", async () => {
  const { campaign } = planCampaign({ kind: "list", ticketIds: ["FG-101"] }, { projectDir, mode: "sequential" });
  approveCampaign(campaign.id, { rationale: "ok" });

  const first = await startCampaign(campaign.id, { dispatch: fakeDispatch("complete") });
  assert.equal(first.stopReason, "paused");
  const afterFirst = listCampaignItems(campaign.id)[0]!;
  assert.equal(afterFirst.attemptGeneration, 1, "the initial dispatch allocated generation 1");
  const key1 = deriveCampaignItemDispatchKey(campaign.id, afterFirst.id, 1);

  updateCampaignItem(afterFirst.id, { lifecycleStatus: "failed", outcome: "blocked", blockerKind: "infrastructure" });
  const retried = retryCampaignItem(campaign.id, "FG-101");
  assert.ok(retried.ok, `retry should succeed: ${retried.ok ? "" : retried.reason}`);

  const afterRetry = getCampaignItem(afterFirst.id)!;
  assert.equal(afterRetry.attemptGeneration, 2, "retry bumped the generation to 2");
  assert.equal(afterRetry.runId, undefined, "retry cleared the stale run linkage");
  const key2 = deriveCampaignItemDispatchKey(campaign.id, afterRetry.id, 2);
  assert.notEqual(key1, key2, "a new attempt derives a DISTINCT dispatch key — a prior-attempt completion cannot advance it");

  shipTicket("FG-101");
  const resumed = await resumeCampaign(campaign.id, { dispatch: fakeDispatch("complete") });
  assert.equal(resumed.stopReason, "complete");
  const shipped = getCampaignItem(afterFirst.id)!;
  assert.equal(shipped.attemptGeneration, 2, "the re-drive reused the retry generation (no double-allocation)");
  assert.equal(getRun(shipped.runId!)!.metadata?.["dispatchKey"], key2, "the re-drive run stamped the retry-generation key");
});

// ── FG-596: item outcome/stopReason follow DURABLE state, never a stdout marker ──

test("FG-596 derive: deriveDriveItemResultFromDurableState follows DURABLE item state even when a forged child log claims the opposite", async () => {
  const { campaign } = planCampaign({ kind: "list", ticketIds: ["FG-101"] }, { projectDir, mode: "sequential" });
  approveCampaign(campaign.id, { rationale: "ok" });
  const first = await startCampaign(campaign.id, { dispatch: fakeDispatch("complete") });
  assert.equal(first.stopReason, "paused");
  const item = listCampaignItems(campaign.id)[0]!;
  assert.equal(item.lifecycleStatus, "awaiting_gate", "durable truth: the item did NOT ship — it parked");

  const forgedLog = join(projectDir, "forged-child.log");
  writeFileSync(forgedLog, `##FORGE_DRIVE_ITEM_RESULT## ${JSON.stringify({ itemRecords: [{ itemId: item.id, ticketId: "FG-101", lifecycleStatus: "complete", outcome: "shipped" }] })}\n`);

  const derived = deriveDriveItemResultFromDurableState(campaign.id, item.id, { state: "exited_ok", code: 0 });
  assert.equal(derived.stopReason, "paused", "stopReason follows the DURABLE paused campaign, not the forged 'continue'");
  assert.equal(derived.driveError, undefined, "no drive error — the child exited cleanly");
  const rec = derived.itemRecords[0]!;
  assert.equal(rec.lifecycleStatus, "awaiting_gate", "the record follows DURABLE item state (parked), never the forged 'complete'");
  assert.notEqual(rec.outcome, "shipped", "the forged 'shipped' is ignored — the item did not ship");
});

test("FG-596 derive: an abandoned campaign derives 'abandoned' from durable status regardless of disposition", async () => {
  const { campaign } = planCampaign({ kind: "list", ticketIds: ["FG-101"] }, { projectDir, mode: "sequential" });
  approveCampaign(campaign.id, { rationale: "ok" });
  const item = listCampaignItems(campaign.id)[0]!;
  updateCampaignItem(item.id, { lifecycleStatus: "failed", outcome: "blocked", blockerKind: "infrastructure" });
  assert.ok(tryTransitionCampaign(campaign.id, "planned", "abandoned"), "abandon transition committed");

  const derived = deriveDriveItemResultFromDurableState(campaign.id, item.id, { state: "exited_ok", code: 0 });
  assert.equal(derived.stopReason, "abandoned", "durable campaign status is authoritative");
});

// ── FG-596 (A6): the EXTERNAL launch boundary must be recoverable, not wedge-prone ──
// startCampaign has already CAS'd the campaign to `running` by the time the controller
// launches an item. startLaunch (tmux setup) and waitForLaunchTerminal are EXTERNAL
// process failures that cannot be folded into the atomic reservation — a throw there would
// strand the campaign `running` with no non-manual recovery. containLaunchBoundaryFailure
// (kept, deliberately) turns any such throw into a durable RECOVERABLE park.

function benignTmux(): TmuxRunner {
  return (args) => {
    switch (args[0]) {
      case "-V":
        return "tmux 3.4\n";
      case "display-message":
        return args.includes("#{pane_dead}") ? "0\n" : "4242\n";
      default:
        return;
    }
  };
}

test("FG-596 A6: a THROWING startLaunch (broken tmux) leaves the campaign PAUSED and the item recoverably parked — never a running wedge", async () => {
  const { campaign } = planCampaign({ kind: "list", ticketIds: ["FG-101"] }, { projectDir, mode: "sequential" });
  approveCampaign(campaign.id, { rationale: "ok" });

  const throwingTmux: TmuxRunner = () => {
    throw new Error("tmux: command not found");
  };
  const launcher = launchDriveItemUnderForge(["forge"], { tmux: throwingTmux });

  const result = await startCampaign(campaign.id, { launchDriveItem: launcher });
  assert.equal(result.stopReason, "paused", "the launch-setup failure halts the controller with a recoverable park, not an uncaught throw");

  const parkedCampaign = getCampaign(campaign.id)!;
  assert.equal(parkedCampaign.status, "paused", "the campaign is durably PAUSED — the running wedge A6 forbids never happens");

  const item = listCampaignItems(campaign.id)[0]!;
  assert.equal(item.lifecycleStatus, "failed");
  assert.equal(item.outcome, "blocked");
  assert.equal(item.blockerKind, "infrastructure", "a launch-setup failure dispatched no run — a directly-retryable infrastructure blocker");
  assert.ok(item.requestedHumanAction && /resume/.test(item.requestedHumanAction), "the operator is told how to recover");
  assert.equal(item.runId, undefined, "FG-425: no replacement run was minted");

  assert.equal(campaignBlocker(getCampaign(campaign.id)!, listCampaignItems(campaign.id), "resume"), null, "resume is not refused — the parked shape is recoverable, not a wedge");
  const retried = retryCampaignItem(campaign.id, "FG-101");
  assert.ok(retried.ok, `retry should succeed on the infrastructure-parked item: ${retried.ok ? "" : retried.reason}`);
  shipTicket("FG-101");
  const resumed = await resumeCampaign(campaign.id, { dispatch: fakeDispatch("complete") });
  assert.equal(resumed.stopReason, "complete", "resume drove the recovered item to completion — full non-manual recovery");
});

test("FG-596 A6: a FAILING waitForLaunchTerminal leaves the campaign PAUSED and the item recoverably parked — never a running wedge", async () => {
  const { campaign } = planCampaign({ kind: "list", ticketIds: ["FG-101"] }, { projectDir, mode: "sequential" });
  approveCampaign(campaign.id, { rationale: "ok" });

  const failingHarness: WaitHarness = {
    read() {
      throw new Error("wait harness: exit record read failed (EIO)");
    },
    installWatcher() { return () => {}; },
    startReconcile() { return () => {}; },
    startTimeout() { return () => {}; },
    onCancel() { return () => {}; },
    startInvalidBound() { return () => {}; },
  };
  const launcher = launchDriveItemUnderForge(["forge"], { tmux: benignTmux(), makeWaitHarness: () => failingHarness });

  const result = await startCampaign(campaign.id, { launchDriveItem: launcher });
  assert.equal(result.stopReason, "paused", "the wait failure halts the controller with a recoverable park, not an uncaught throw");
  assert.equal(getCampaign(campaign.id)!.status, "paused", "the campaign is durably PAUSED after a wait-boundary failure");

  const item = listCampaignItems(campaign.id)[0]!;
  assert.equal(item.lifecycleStatus, "failed");
  assert.equal(item.outcome, "blocked");
  assert.equal(item.blockerKind, "infrastructure");
  assert.ok(item.requestedHumanAction && /resume/.test(item.requestedHumanAction), "the operator is told how to recover");

  assert.equal(campaignBlocker(getCampaign(campaign.id)!, listCampaignItems(campaign.id), "resume"), null, "resume is not refused after a wait-boundary park");
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

  // startLaunch succeeds and the drive-item child atomically reserves + dispatches a run —
  // stamping the item to `running` with its adoptable dispatch_key — BEFORE the wait
  // harness fails. Reproduce that durable side effect (via the real reservation) on the
  // first harness read(), then throw the WAIT.
  const failingHarness: WaitHarness = {
    read() {
      reserveCampaignDriveDispatch({
        campaignId: campaign.id,
        itemId,
        createRun: ({ dispatchKey, attemptGeneration }) => {
          insertRun({ id: "run-inflight", workflow: "feature", title: "FG-101", status: "active", createdAt: nowIso(), metadata: { dispatchKey, attemptGeneration, campaignId: campaign.id, itemId, ticketId: "FG-101" }, projectDir }, resolveRunProjectIdentity(projectDir));
          return "run-inflight";
        },
      });
      throw new Error("wait harness: exit record read failed (EIO) after the child dispatched a run");
    },
    installWatcher() { return () => {}; },
    startReconcile() { return () => {}; },
    startTimeout() { return () => {}; },
    onCancel() { return () => {}; },
    startInvalidBound() { return () => {}; },
  };
  const launcher = launchDriveItemUnderForge(["forge"], { tmux: benignTmux(), makeWaitHarness: () => failingHarness });

  const result = await startCampaign(campaign.id, { launchDriveItem: launcher });
  assert.equal(result.stopReason, "recovery_needed", "a live mid-flight drive surfaces for recovery, not a retryable no-run park");

  const item = getCampaignItem(itemId)!;
  assert.equal(item.lifecycleStatus, "running", "the dispatched item stays running (adoptable), never overwritten as failed");
  assert.equal(item.outcome, undefined, "no blocked outcome forced over the live drive");
  assert.equal(item.runId, "run-inflight", "the item keeps its dispatched run linkage");
  const dispatchKey = deriveCampaignItemDispatchKey(campaign.id, itemId, item.attemptGeneration);
  assert.equal(runByDispatchKey(dispatchKey)?.id, "run-inflight", "the run remains adoptable by its stamped dispatch key (FG-564)");
  assert.equal(listRuns().filter((r) => r.title === "FG-101").length, 1, "no duplicate run was created");
});

test("FG-596 A6 wiring: driveOneCampaignItem (the CHILD) creates/links NO run behind a PAUSED campaign", async () => {
  const { campaign } = planCampaign({ kind: "list", ticketIds: ["FG-101"] }, { projectDir, mode: "sequential" });
  approveCampaign(campaign.id, { rationale: "ok" });
  const itemId = listCampaignItems(campaign.id)[0]!.id;
  assert.ok(tryTransitionCampaignToRunning(campaign.id));
  assert.ok(tryTransitionCampaign(campaign.id, "running", "paused"), "precondition: campaign paused, item pending");

  const runsBefore = listRuns().length;
  const result = await driveOneCampaignItem(campaign.id, itemId, { dispatch: fakeDispatch("complete"), projectDir, mode: "sequential" });

  assert.equal(result.stopReason, "paused", "the child halts cooperatively on the paused campaign");
  assert.equal(listRuns().length, runsBefore, "the child created NO run behind the paused campaign");
  const item = getCampaignItem(itemId)!;
  assert.equal(item.lifecycleStatus, "pending", "the pending item was not driven (no reservation behind the pause)");
  assert.equal(item.runId, undefined, "no run linkage was written behind the pause");
});

test("FG-596 A6 wiring: the launch-boundary containment does NOT clobber (or pause behind) a child that already reserved+dispatched the item", async () => {
  const { campaignId, itemId } = seedRunningPendingItem();

  // Child atomically reserves + dispatches its run (the winning drive → item running).
  const res = reserveCampaignDriveDispatch({
    campaignId,
    itemId,
    createRun: ({ dispatchKey, attemptGeneration }) => {
      insertInvokeRun("run-claimed-inflight", campaignId, itemId, dispatchKey, attemptGeneration);
      return "run-claimed-inflight";
    },
  });
  assert.equal(res.status, "created");

  // Now the containment attempts its pending-gated park — must be a no-op against the
  // already-running item.
  const parked = updateCampaignItemIfPending(itemId, campaignId, { lifecycleStatus: "failed", outcome: "blocked", blockerKind: "infrastructure", reason: "launch boundary failed" });
  assert.equal(parked, false, "the pending-gated park no-ops against the already-reserved (running) item");

  const item = getCampaignItem(itemId)!;
  assert.equal(item.lifecycleStatus, "running", "the live drive is NOT overwritten as failed");
  assert.equal(item.runId, "run-claimed-inflight", "the child's run linkage is preserved");
  assert.equal(getCampaign(campaignId)!.status, "running", "the campaign stays running — the containment did not pause behind the live child");
  const dispatchKey = deriveCampaignItemDispatchKey(campaignId, itemId, item.attemptGeneration);
  assert.equal(runByDispatchKey(dispatchKey)?.id, "run-claimed-inflight", "the run stays adoptable by its dispatch key");
});

// ── LOAD-FAIL LANE: the synthetic traceability run obeys the SAME reservation ─────
// A full_feature item whose workflow fails to LOAD still produces a run — a synthetic
// 'abandoned' row for traceability. Post-A6 that row is created THROUGH
// reserveCampaignDriveDispatch, so it carries the deterministic dispatch key + attempt
// generation and is adoptable by key (no duplicate on a crash-window re-drive), and the
// terminal/infrastructure classification is applied AFTER the reservation commits.

// A synthetic 'abandoned' run insert exactly as the load-fail lane's createRun performs it —
// including FG-663's rule that the project identity is resolved ABOVE the reservation's write
// lock and handed to insertRun (never a git subprocess held across the lock).
function insertSyntheticAbandonedRun(id: string, campaignId: string, itemId: string, dispatchKey: string, gen: number) {
  insertRun(
    {
      id,
      workflow: "feature",
      title: "FG-101",
      status: "abandoned",
      createdAt: nowIso(),
      metadata: { campaignId, ticketId: "FG-101", itemId, dispatchKey, attemptGeneration: gen },
      projectDir,
    },
    resolveRunProjectIdentity(projectDir),
  );
}

// Seed a RUNNING campaign with one PENDING full_feature item (workflow "feature").
function seedRunningPendingFullFeatureItem(): { campaignId: string; itemId: string } {
  const { campaign } = planCampaign(
    { kind: "list", ticketIds: ["FG-101"], itemOverrides: { "FG-101": { lane: "full_feature", workflowName: "feature", laneRationale: "FG-596 load-fail lane test" } } },
    { projectDir, mode: "sequential" },
  );
  approveCampaign(campaign.id, { rationale: "ok" });
  assert.ok(tryTransitionCampaignToRunning(campaign.id), "precondition: campaign running");
  const item = listCampaignItems(campaign.id)[0]!;
  assert.equal(item.lifecycleStatus, "pending", "precondition: full_feature item pending");
  return { campaignId: campaign.id, itemId: item.id };
}

const throwingLoad = () => {
  throw new Error("workflow YAML missing or invalid: feature");
};

test("FG-564 (FIX round 6) full_feature load-fail FAILS CLOSED: an unresolvable workflow THROWS before any reservation — NO run minted, item stays pending, campaign recoverable", async () => {
  const { campaignId, itemId } = seedRunningPendingFullFeatureItem();
  const runsBefore = listRuns().length;

  // The NORMAL full_feature drive now resolves its workflow + ticket through the SAME shared
  // prepareCampaignItemDispatch authority the recover advance uses. An unresolved/failed
  // workflow FAILS CLOSED — it THROWS before reserveCampaignDriveDispatch is ever entered, so
  // no run (not even a synthetic traceability row) is minted, the item stays pending, and the
  // campaign stays recoverable — byte-identical to the recover advance's fail-closed behavior.
  // (Pre-round-6 this path minted a synthetic abandoned run and classified the item terminal —
  // an asymmetry with the recover path that this change removes.)
  await assert.rejects(
    () =>
      driveOneCampaignItem(campaignId, itemId, {
        dispatch: fakeDispatch("complete"),
        projectDir,
        mode: "sequential",
        loadWorkflowFn: throwingLoad,
      }),
    /workflow YAML missing or invalid/,
    "the workflow-resolution failure propagates from the shared authority BEFORE any reservation",
  );

  const item = getCampaignItem(itemId)!;
  assert.equal(item.lifecycleStatus, "pending", "the item stays pending — the reservation was never entered");
  assert.equal(item.outcome, undefined, "no terminal outcome was applied");
  assert.equal(item.runId, undefined, "no run was linked onto the item");
  assert.equal(item.attemptGeneration, 0, "no generation was allocated — the reservation was never entered");

  assert.equal(listRuns().length, runsBefore, "NO run was minted — identical fail-closed behavior to the recover advance");
  assert.equal(
    runByDispatchKey(deriveCampaignItemDispatchKey(campaignId, itemId, 1)),
    undefined,
    "nothing adoptable at the item-attempt key — no synthetic run exists",
  );
  assert.equal(getCampaign(campaignId)!.status, "running", "the campaign stays running/recoverable — the drive can be safely re-attempted");
});

test("reserveCampaignDriveDispatch crash-before-commit: a createRun that throws mid-reservation rolls back WHOLE — item pending, generation unallocated, NO run (the mechanism the startRun-throw catch relies on)", () => {
  const { campaignId, itemId } = seedRunningPendingFullFeatureItem();
  const runsBefore = listRuns().length;

  // reserveCampaignDriveDispatch is one atomic tx: if createRun throws before the tx commits,
  // the claim + insert + link roll back together. This is the mechanism the startRun-throw
  // catch depends on to roll the failed attempt back before recording its traceability row.
  assert.throws(
    () =>
      reserveCampaignDriveDispatch({
        campaignId,
        itemId,
        createRun: ({ dispatchKey, attemptGeneration }) => {
          insertSyntheticAbandonedRun("run-syn-doomed", campaignId, itemId, dispatchKey, attemptGeneration);
          throw new Error("crash before commit");
        },
      }),
    /crash before commit/,
  );

  const item = getCampaignItem(itemId)!;
  assert.equal(item.lifecycleStatus, "pending", "the item is still pending — nothing partial survived");
  assert.equal(item.attemptGeneration, 0, "the generation was NOT persisted — the tx rolled back");
  assert.equal(item.runId, undefined, "no run linkage was written");
  assert.equal(listRuns().length, runsBefore, "the synthetic run did not survive the rollback");
  assert.equal(runByDispatchKey(deriveCampaignItemDispatchKey(campaignId, itemId, 1)), undefined, "nothing adoptable at the derived key");
});

// ── THE startRun-THROW CATCH — the last unkeyed run-emission site, now reserved ──
//
// When startRun throws INSIDE the reservation (createRun), the whole reservation rolls
// back — item stays pending, no run. The catch then INTENTIONALLY records a synthetic
// 'abandoned' traceability run so the failed dispatch is durable (it feeds
// parkCampaignOnStartRunThrow). Post-fix that row is created through a FRESH
// reserveCampaignDriveDispatch — so it is keyed with the SAME attempt generation +
// deterministic dispatch key as the rolled-back attempt, its insert + item run_id linkage
// + pending→running CAS commit atomically, and a crash-window re-drive ADOPTS the one
// keyed synthetic run instead of duplicating it. The failed/infrastructure classification
// is applied AFTER the reservation commits, creating no additional run.

const throwingStartRun = () => {
  throw new Error("startRun boom: db write failed mid-dispatch");
};

// A workflow load that SUCCEEDS (the "feature" YAML isn't installed in this env), so the
// drive reaches the startRun reservation instead of the load-fail lane. startRun is
// injected to throw, so the returned workflow is never actually run.
const succeedingLoad = (): Workflow =>
  ({
    name: "feature",
    description: "stub",
    review_mode: "legacy_verdict" as const,
    inputs: [],
    steps: [{ id: "build", agent: "engineer", gate: "none" as const, depends_on: [], reds: [], runtime: "claude", manual: false }],
  }) as Workflow;

test("FG-596 startRun-throw stamp: a startRun throw records EXACTLY ONE abandoned run stamped with the deterministic key + generation, linked to the item, then parks it failed/infrastructure WITHOUT a second run", async () => {
  const { campaignId, itemId } = seedRunningPendingFullFeatureItem();

  await assert.rejects(
    () =>
      driveOneCampaignItem(campaignId, itemId, {
        dispatch: fakeDispatch("complete"),
        projectDir,
        mode: "sequential",
        loadWorkflowFn: succeedingLoad,
        startRunFn: throwingStartRun,
      }),
    /startRun boom/,
    "the ORIGINAL startRun error propagates after the park",
  );

  const item = getCampaignItem(itemId)!;
  assert.equal(item.lifecycleStatus, "failed", "terminal classification applied after the reservation committed");
  assert.equal(item.outcome, "blocked");
  assert.equal(item.blockerKind, "infrastructure", "startRun-throw parks at the infrastructure classification");
  assert.equal(item.attemptGeneration, 1, "the fresh reservation allocated (and persisted) generation 1 — same as every live lane");

  const runsForItem = listRuns().filter((r) => r.metadata?.["itemId"] === itemId);
  assert.equal(runsForItem.length, 1, "EXACTLY ONE abandoned run exists — the terminal classification created no second run");
  const run = runsForItem[0]!;
  assert.equal(item.runId, run.id, "the synthetic run is linked onto the item");
  assert.equal(run.status, "abandoned", "the traceability row is abandoned");

  const expectedKey = deriveCampaignItemDispatchKey(campaignId, itemId, 1);
  assert.equal(run.metadata?.["dispatchKey"], expectedKey, "the synthetic run stamps the SAME deterministic dispatch key as the live lanes");
  assert.equal(run.metadata?.["attemptGeneration"], 1, "the synthetic run carries the item-attempt identity");
  assert.equal(runByDispatchKey(expectedKey)?.id, run.id, "the synthetic run is adoptable by its dispatch key");

  assert.equal(getCampaign(campaignId)!.status, "paused", "the startRun-throw parks the campaign");
});

// Adoption in the startRun-throw catch is a CONCURRENT crash-window branch: the catch's
// fresh reservation adopts a keyed synthetic run that a racing re-drive already committed
// at the same key. It cannot be reproduced through a single-threaded drive (the drive's
// FIRST reservation would itself adopt any pre-existing keyed run before startRun is even
// called), so we exercise the catch's reservation shape directly — the same createRun the
// catch runs — against a pre-committed orphan, exactly as the load-fail crash test does.
test("FG-596 startRun-throw adoption: the catch's synthetic reservation ADOPTS a keyed run already at the dispatch key — never a duplicate row", () => {
  const { campaignId, itemId } = seedRunningPendingFullFeatureItem();

  // A racing re-drive committed a stamped synthetic run at the derived key (generation
  // persisted, item still pending — the crash window) before this catch's reservation runs.
  updateCampaignItem(itemId, { attemptGeneration: 1 });
  const key = deriveCampaignItemDispatchKey(campaignId, itemId, 1);
  insertSyntheticAbandonedRun("run-startrun-orphan", campaignId, itemId, key, 1);
  const runsBefore = listRuns().length;

  // The catch routes its synthetic insert through reserveCampaignDriveDispatch with the
  // SAME createRun closure — a run already at the key is ADOPTED, createRun never runs.
  const synthetic = reserveCampaignDriveDispatch({
    campaignId,
    itemId,
    createRun: ({ dispatchKey, attemptGeneration }) => {
      const newId = newRunId("FG-101");
      insertSyntheticAbandonedRun(newId, campaignId, itemId, dispatchKey, attemptGeneration);
      return newId;
    },
  });

  assert.equal(synthetic.status, "adopted", "the reservation ADOPTED the racing synthetic run rather than creating one");
  assert.equal(synthetic.runId, "run-startrun-orphan", "the adopted run id is the one already at the key");
  assert.equal(listRuns().length, runsBefore, "no second traceability row was inserted");
  assert.equal(getCampaignItem(itemId)!.runId, "run-startrun-orphan", "the adopted run is linked onto the item");
  const runsForItem = listRuns().filter((r) => r.metadata?.["itemId"] === itemId);
  assert.equal(runsForItem.length, 1, "exactly ONE synthetic run exists for the item — the catch never duplicates");
});
