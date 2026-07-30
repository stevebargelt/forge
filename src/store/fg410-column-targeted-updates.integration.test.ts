// FG-410 integration tests: column-targeted row writes against a real on-disk SQLite
// database, driven the way real consumers drive them.
//
// The campaign item is where the shape was first established (properties 1 and 2). The
// review row joined it in FG-649/RF-4 (property 3) for the same reason and with the same
// falsifiable setup — a second connection holding a snapshot read taken before the other
// lane's commit.
//
// Three properties are pinned here:
//
// 1. INTERLEAVED DISJOINT WRITERS (the FG-396 parallel-lanes prerequisite).
//    Two independent writers — a driver writing item state (lifecycleStatus) and a
//    metadata path writing run linkage (prUrl/branch) — each write only the columns
//    they name. A writer holding a snapshot read taken BEFORE the other writer's
//    commit must not resurrect the stale values it read for columns it never named.
//    Modeled with two real connections to the same database file, so the writes go
//    through separate SQLite connections exactly as two lanes in separate forge
//    processes would.
//
// 2. THE CAS GUARDS (FG-428 paused / FG-441 running) still refuse atomically.
//    Building the SET clause dynamically must not weaken the WHERE clause: a
//    campaign status flip between a consumer's read and its write still yields
//    zero rows changed -> false, with NO column of the row written — not even
//    updated_at, which is the partial-write canary since every generated SET
//    includes it.
//
// Real DB via a temp file (never ~/.forge/forge.db): both connections are opened
// on a mkdtemp path and closed in the finally.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { SCHEMA_SQL } from "./schema.js";
import { applyMigrations, setDbForTest } from "./db.js";
import {
  createCampaign,
  addCampaignItem,
  getCampaignItem,
  updateCampaignItem,
  updateCampaignItemIfCampaignPaused,
  updateCampaignItemIfCampaignRunning,
  updateCampaignStatus,
} from "./campaigns.js";
import { getReview, insertReview, recordStageEvidence, updateReview } from "./reviews.js";

let dir: string;
let laneA: DatabaseInstance;
let laneB: DatabaseInstance;
let prev: DatabaseInstance | null;

// Two connections to the SAME database file — one per simulated lane/process.
function openConn(dbPath: string): DatabaseInstance {
  const conn = new Database(dbPath);
  conn.pragma("foreign_keys = ON");
  conn.exec(SCHEMA_SQL); // CREATE TABLE IF NOT EXISTS — safe to re-run
  applyMigrations(conn);
  return conn;
}

// Run `fn` as if it were executing inside the given lane's process: the store
// singleton points at that lane's connection for the duration of the call.
function inLane<T>(conn: DatabaseInstance, fn: () => T): T {
  const saved = setDbForTest(conn);
  try {
    return fn();
  } finally {
    setDbForTest(saved as DatabaseInstance);
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fg410-store-integ-"));
  const dbPath = join(dir, "forge-test.db");
  laneA = openConn(dbPath);
  laneB = openConn(dbPath);
  prev = setDbForTest(laneA);
});

afterEach(() => {
  setDbForTest(prev as DatabaseInstance);
  laneA.close();
  laneB.close();
  rmSync(dir, { recursive: true, force: true });
});

function seedRunningCampaignItem(): { campaignId: string; itemId: string } {
  const campaign = createCampaign({
    sourceKind: "list",
    sourceInput: { tickets: ["FG-901"] },
    mode: "sequential",
  });
  updateCampaignStatus(campaign.id, "running");
  const item = addCampaignItem({ campaignId: campaign.id, itemOrder: 0, ticketId: "FG-901" });
  return { campaignId: campaign.id, itemId: item.id };
}

// ── 1. Interleaved disjoint writers ──────────────────────────────────────────

test("FG-410 interleaved lanes: driver writes lifecycleStatus, metadata lane writes prUrl — both persist", () => {
  const { itemId } = seedRunningCampaignItem();

  // Lane B reads the item BEFORE lane A writes — this is the stale snapshot that
  // the old read-merge-write shape would have written back over lane A's column.
  const laneBSnapshot = inLane(laneB, () => getCampaignItem(itemId))!;
  assert.equal(laneBSnapshot.lifecycleStatus, "pending");
  assert.equal(laneBSnapshot.prUrl, undefined);

  // Lane A (driver) advances item state. It names lifecycleStatus only.
  inLane(laneA, () => updateCampaignItem(itemId, { lifecycleStatus: "running", runId: "run-lane-a" }));

  // Lane B (metadata) now writes the PR it opened. It names prUrl/branch only —
  // it must not write back the 'pending' lifecycleStatus it read earlier.
  inLane(laneB, () =>
    updateCampaignItem(itemId, { prUrl: "https://github.com/example/repo/pull/410", branch: "forge/lane-b/citem-901" })
  );

  for (const [laneName, conn] of [
    ["lane A", laneA],
    ["lane B", laneB],
  ] as const) {
    const row = inLane(conn, () => getCampaignItem(itemId))!;
    assert.equal(row.lifecycleStatus, "running", `${laneName}: driver's lifecycleStatus must survive the metadata write`);
    assert.equal(row.runId, "run-lane-a", `${laneName}: driver's runId must survive the metadata write`);
    assert.equal(row.prUrl, "https://github.com/example/repo/pull/410", `${laneName}: metadata lane's prUrl must persist`);
    assert.equal(row.branch, "forge/lane-b/citem-901", `${laneName}: metadata lane's branch must persist`);
  }
});

test("FG-410 interleaved lanes: reverse order (metadata first, driver second) — both persist", () => {
  const { itemId } = seedRunningCampaignItem();

  // Lane A reads first, then lane B writes metadata, then lane A writes item state
  // from its now-stale view. A must not resurrect the NULL prUrl it read.
  const laneASnapshot = inLane(laneA, () => getCampaignItem(itemId))!;
  assert.equal(laneASnapshot.prUrl, undefined);

  inLane(laneB, () => updateCampaignItem(itemId, { prUrl: "https://github.com/example/repo/pull/411" }));
  inLane(laneA, () => updateCampaignItem(itemId, { lifecycleStatus: "complete", outcome: "shipped" }));

  const row = inLane(laneB, () => getCampaignItem(itemId))!;
  assert.equal(row.prUrl, "https://github.com/example/repo/pull/411", "metadata lane's prUrl must not be clobbered");
  assert.equal(row.lifecycleStatus, "complete", "driver's lifecycleStatus must persist");
  assert.equal(row.outcome, "shipped", "driver's outcome must persist");
});

// ── 2. CAS guard integration (reconcile-path shape) ──────────────────────────

test("FG-410 CAS: status flip between read and write refuses the reconcile write with zero mutation", () => {
  const { campaignId, itemId } = seedRunningCampaignItem();

  // The item failed and the campaign parked — the state `forge campaign reconcile`
  // operates on.
  inLane(laneA, () => {
    updateCampaignItem(itemId, {
      lifecycleStatus: "failed",
      outcome: "blocked",
      blockerKind: "scope",
      continuePolicy: "hold_dependents",
      reason: "reviewer verdict failed",
      requestedHumanAction: "resolve scope for FG-901 then resume",
      runId: "run-901",
      branch: "forge/run-901/citem-901",
    });
    updateCampaignStatus(campaignId, "paused");
  });

  // Reconcile reads the campaign, sees 'paused', and decides the item is eligible.
  const beforeWrite = inLane(laneA, () => getCampaignItem(itemId))!;
  assert.equal(beforeWrite.lifecycleStatus, "failed");

  // RACE: another process resumes the campaign between reconcile's read and its write.
  inLane(laneB, () => updateCampaignStatus(campaignId, "running"));

  // Reconcile's write (reconcile.ts:242's exact update shape) must now refuse.
  const applied = inLane(laneA, () =>
    updateCampaignItemIfCampaignPaused(itemId, campaignId, {
      lifecycleStatus: "complete",
      outcome: "shipped",
      blockerKind: undefined,
      reason: undefined,
      requestedHumanAction: undefined,
    })
  );
  assert.equal(applied, false, "the paused-guard must refuse once the campaign left 'paused'");

  // Zero mutation — not one column of the multi-column SET landed, including
  // updated_at (every generated SET clause writes it, so an unchanged updated_at
  // proves the whole statement was gated by the WHERE rather than partially applied).
  const afterWrite = inLane(laneB, () => getCampaignItem(itemId))!;
  assert.deepEqual(afterWrite, beforeWrite, "a refused CAS write must leave the row byte-for-byte unchanged");
});

test("FG-410 CAS: guard passing writes exactly the named columns and leaves the rest untouched", () => {
  const { campaignId, itemId } = seedRunningCampaignItem();

  inLane(laneA, () => {
    updateCampaignItem(itemId, {
      lifecycleStatus: "failed",
      outcome: "blocked",
      blockerKind: "scope",
      continuePolicy: "hold_dependents",
      reason: "reviewer verdict failed",
      requestedHumanAction: "resolve scope for FG-901 then resume",
      runId: "run-901",
      branch: "forge/run-901/citem-901",
      prUrl: "https://github.com/example/repo/pull/901",
    });
    updateCampaignStatus(campaignId, "paused");
  });

  const applied = inLane(laneA, () =>
    updateCampaignItemIfCampaignPaused(itemId, campaignId, {
      lifecycleStatus: "complete",
      outcome: "shipped",
      blockerKind: undefined,
      reason: undefined,
      requestedHumanAction: undefined,
    })
  );
  assert.equal(applied, true, "the paused-guard must pass while the campaign is still 'paused'");

  const row = inLane(laneB, () => getCampaignItem(itemId))!;
  // Named with a value → written.
  assert.equal(row.lifecycleStatus, "complete");
  assert.equal(row.outcome, "shipped");
  // Named with explicit undefined → cleared to NULL.
  assert.equal(row.blockerKind, undefined, "blockerKind was named as undefined — must clear to NULL");
  assert.equal(row.reason, undefined, "reason was named as undefined — must clear to NULL");
  assert.equal(row.requestedHumanAction, undefined, "requestedHumanAction was named as undefined — must clear to NULL");
  // Not named → untouched. Reconcile deliberately does not name continuePolicy or
  // the run linkage; a shipped item keeps its evidence trail.
  assert.equal(row.continuePolicy, "hold_dependents", "continuePolicy was not named — must be untouched");
  assert.equal(row.runId, "run-901", "runId was not named — must be untouched");
  assert.equal(row.branch, "forge/run-901/citem-901", "branch was not named — must be untouched");
  assert.equal(row.prUrl, "https://github.com/example/repo/pull/901", "prUrl was not named — must be untouched");
});

test("FG-410 CAS (running variant): status flip to paused refuses the reattach write with zero mutation", () => {
  const { campaignId, itemId } = seedRunningCampaignItem();

  inLane(laneA, () => updateCampaignItem(itemId, { runId: "run-901", lifecycleStatus: "running" }));
  const beforeWrite = inLane(laneA, () => getCampaignItem(itemId))!;

  // RACE: the campaign parks between the executor's read and its reattach write.
  inLane(laneB, () => updateCampaignStatus(campaignId, "paused"));

  const applied = inLane(laneA, () =>
    updateCampaignItemIfCampaignRunning(itemId, campaignId, {
      lifecycleStatus: "complete",
      outcome: "shipped",
    })
  );
  assert.equal(applied, false, "the running-guard must refuse once the campaign left 'running'");

  const afterWrite = inLane(laneB, () => getCampaignItem(itemId))!;
  assert.deepEqual(afterWrite, beforeWrite, "a refused CAS write must leave the row byte-for-byte unchanged");
});

// ── 3. The review row (FG-649 / RF-4) ────────────────────────────────────────
//
// `updateReview` was the last read-modify-write of EVERY mutable column in the review
// ledger: it read the row outside the write lock and wrote base_sha, candidate_sha,
// workspace_dir, contract_json, lens_outcomes_json and stage_evidence_json back from that
// snapshot. FG-649 then put a new caller on the hot path — `resolveReviewWorkspace` rebinds
// workspace_dir at the START of every stage-driving invocation — so the write most likely to
// hold a stale snapshot became the one that runs first, every time, potentially alongside a
// long-running stage of another forge process on the same review.
//
// RED baseline: restore the `patch.x ?? before.x ?? null` UPDATE of all eight columns in
// src/store/reviews.ts and this arm fails on candidateSha and stageEvidence.

test("FG-649/RF-4 interleaved lanes: a workspace rebind must not resurrect the candidate and stage record another lane wrote", () => {
  inLane(laneA, () =>
    insertReview({
      id: "review-rf4",
      reviewMode: "evidence_led",
      ticketId: "FG-649",
      baseSha: "base0000",
      candidateSha: "cand1111",
      workspaceDir: "/tmp/bound-before",
      contract: { risk_lenses: ["wide"] },
      state: "fixing",
    })
  );

  // Lane B reads the review BEFORE lane A's stage writes. This is the snapshot the old
  // read-merge-write shape would have written back over lane A's columns.
  const laneBSnapshot = inLane(laneB, () => getReview("review-rf4"))!;
  assert.equal(laneBSnapshot.candidateSha, "cand1111");
  assert.equal(laneBSnapshot.stageEvidence, undefined);

  // Lane A is mid-Stage-5: it committed the fix cycle, advanced the candidate to the sha it
  // authored, and recorded the stage.
  inLane(laneA, () => {
    updateReview("review-rf4", { candidateSha: "afterfix2" });
    recordStageEvidence("review-rf4", "fix", { sha: "cand1111", detail: "the fix cycle was committed" });
  });

  // Lane B now does what every `forge review continue` does first: rebind the workspace. It
  // names workspace_dir only.
  inLane(laneB, () => updateReview("review-rf4", { workspaceDir: "/tmp/bound-after" }));

  for (const [laneName, conn] of [
    ["lane A", laneA],
    ["lane B", laneB],
  ] as const) {
    const row = inLane(conn, () => getReview("review-rf4"))!;
    assert.equal(row.workspaceDir, "/tmp/bound-after", `${laneName}: the rebind persists`);
    assert.equal(row.candidateSha, "afterfix2", `${laneName}: the candidate advance must survive the rebind`);
    assert.equal(
      row.stageEvidence?.fix?.sha,
      "cand1111",
      `${laneName}: the fix stage record must survive the rebind`,
    );
    assert.deepEqual(row.contract, { risk_lenses: ["wide"] }, `${laneName}: columns nobody named are untouched`);
  }
});

test("FG-649/RF-4: an empty patch writes no column at all", () => {
  inLane(laneA, () =>
    insertReview({ id: "review-rf4-noop", reviewMode: "evidence_led", ticketId: "FG-649", candidateSha: "cand1111" })
  );
  const before = inLane(laneA, () => getReview("review-rf4-noop"))!;
  const returned = inLane(laneA, () => updateReview("review-rf4-noop", {}));

  assert.deepEqual(returned, before, "a patch naming nothing is not a write — not even of updated_at");
  assert.deepEqual(inLane(laneB, () => getReview("review-rf4-noop")), before);
});
