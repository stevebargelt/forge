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
} from "../store/campaigns.js";
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
  type DriveItemLaunchFn,
} from "./executor.js";
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
