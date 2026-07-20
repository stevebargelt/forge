// FG-596 (A4/A1) — REAL-SUBPROCESS coverage for `forge campaign drive-item`.
//
// The A4 launch-convergence test parses the generated command then calls
// driveOneCampaignItem directly, bypassing the ACTUAL `campaign drive-item` Commander
// entry — so A1's operator entry point (the campaign-status guard, argument parsing, and
// the human vs --json output modes) had NO direct coverage. This file spawns the REAL
// `bin/forge campaign drive-item <campaignId> <itemId>` binary against a REAL on-disk
// store (the same file the CLI opens), exactly as an operator or the launch controller
// would — bin/forge exec-loads the live TS CLI, so a change to the command surface changes
// what this test drives the moment it lands.
//
// The drivable items here are `ticketing_only` lane items: they settle with NO agent
// dispatch (no container, no docker), so the CLI action runs end-to-end — arg parsing,
// the running-guard, driveOneCampaignItem, and BOTH output renderers — with nothing
// stubbed and nothing mocked.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { SCHEMA_SQL } from "../store/schema.js";
import { applyMigrations, setDbForTest } from "../store/db.js";
import { writeTicket } from "../backlog/structured.js";
import { planCampaign, type ItemModeOverride } from "./planner.js";
import { approveCampaign, tryTransitionCampaignToRunning, tryTransitionCampaign, listCampaignItems } from "../store/campaigns.js";
import { acquireCampaignLease, recordItemLaunch } from "../store/campaign-controller.js";
import { findGitRoot } from "../util/git-root.js";

const forgeBin = join(findGitRoot(process.cwd()), "bin", "forge");

let db: DatabaseInstance;
let prev: DatabaseInstance | null;
let home: string;
let dbPath: string;
let projectDir: string;

// A REAL on-disk store the spawned CLI opens by itself (FORGE_DB_PATH). Same schema +
// migrations the ordinary getDb() open path applies, in WAL so the test's seeding
// connection and the CLI subprocess share committed frames.
function makeFileDb(path: string): DatabaseInstance {
  const d = new Database(path);
  d.pragma("journal_mode = WAL");
  d.pragma("foreign_keys = ON");
  d.exec(SCHEMA_SQL);
  applyMigrations(d);
  return d;
}

function gitExec(args: string[], cwd: string): void {
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 10000,
    env: { ...process.env, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@t.com", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@t.com" },
  });
}

function storyBody(n: string): string {
  return `## Problem\n${n} needs implementation.\n\n## Goal\nComplete ${n}.\n\n## Acceptance Criteria\n- ${n} is complete\n`;
}

// Seed a real campaign whose single item is a NO-DISPATCH ticketing_only lane, so the
// spawned `drive-item` settles it without a container.
function seedTicketingOnlyCampaign(): { campaignId: string; itemId: string } {
  const overrides: Record<string, ItemModeOverride> = { "FG-101": { lane: "ticketing_only" } };
  const { campaign } = planCampaign({ kind: "list", ticketIds: ["FG-101"], itemOverrides: overrides }, { projectDir, mode: "sequential" });
  approveCampaign(campaign.id, { rationale: "ok" });
  const itemId = listCampaignItems(campaign.id)[0]!.id;
  return { campaignId: campaign.id, itemId };
}

// FG-564 (item 1): a CLI `campaign drive-item` invocation is now FAIL-CLOSED — it drives only
// while a LIVE campaign-controller lease AND a matching durable born-under launch linkage
// authorize it (the launch-per-item controller always establishes both before it launches a
// child). Seed exactly that legitimate controller context so the CLI surface can be exercised
// end-to-end; a raw lease-less invocation is denied (asserted separately below).
function seedControllerContext(campaignId: string, itemId: string): void {
  const owner = `campaign@${campaignId}@controller`;
  const grant = acquireCampaignLease({ campaignId, owner, ttlMs: 60 * 60 * 1000 });
  if (!grant.granted) throw new Error("precondition: could not acquire the controller lease");
  recordItemLaunch({
    campaignId,
    itemId,
    attemptGeneration: 1,
    sourceLaunchId: `launch-${itemId}`,
    controllerOwner: owner,
    controllerGeneration: grant.lease.generation,
    state: "launched",
  });
}

function runForge(args: string[]) {
  return spawnSync(forgeBin, args, {
    encoding: "utf8",
    env: { ...process.env, FORGE_HOME: home, FORGE_DB_PATH: dbPath, NO_NOTIFY: "true" },
  });
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "fg596-cli-"));
  dbPath = join(home, "forge.db");
  db = makeFileDb(dbPath);
  prev = setDbForTest(db);
  projectDir = mkdtempSync(join(tmpdir(), "fg596-cli-proj-"));
  gitExec(["init", "-b", "main"], projectDir);
  gitExec(["config", "user.email", "t@t.com"], projectDir);
  gitExec(["config", "user.name", "T"], projectDir);
  writeTicket(projectDir, { id: "FG-101", type: "story", status: "active", title: "Story One", created: "2024-01-01", body: storyBody("Story One") });
  gitExec(["add", "."], projectDir);
  gitExec(["commit", "-m", "init"], projectDir);
});

afterEach(() => {
  setDbForTest(prev as DatabaseInstance);
  db.close();
  rmSync(home, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
});

// ── Argument parsing / not-found ────────────────────────────────────────────────

test("FG-596 CLI: `campaign drive-item` with a missing item-id argument is a Commander parse error, not a drive", () => {
  const { campaignId } = seedTicketingOnlyCampaign();
  tryTransitionCampaignToRunning(campaignId);
  // Only one positional supplied — Commander requires <campaign-id> AND <item-id>.
  const r = runForge(["campaign", "drive-item", campaignId]);
  assert.notEqual(r.status, 0, "a missing required argument fails at the CLI boundary");
  assert.match(r.stderr, /missing required argument|item-id/i, "Commander names the missing argument");
});

test("FG-596 CLI: `campaign drive-item` on an unknown campaign exits 1 with a not-found error", () => {
  const r = runForge(["campaign", "drive-item", "campaign-does-not-exist", "item-x"]);
  assert.equal(r.status, 1, "unknown campaign is a clean exit-1 refusal");
  assert.match(r.stderr, /not found/, "the error names the missing campaign");
});

test("FG-596 CLI: the early refusals emit the SAME structured --json error envelope the unknown-item guard uses", () => {
  // Unknown campaign under --json.
  const unknown = runForge(["campaign", "drive-item", "campaign-does-not-exist", "item-x", "--json"]);
  assert.equal(unknown.status, 1);
  const unknownParsed = JSON.parse(unknown.stdout);
  assert.match(unknownParsed.error, /not found/, "--json carries the not-found error");
  assert.equal(unknownParsed.campaignId, "campaign-does-not-exist", "--json echoes the campaignId");
  assert.equal(unknownParsed.itemId, "item-x", "--json echoes the itemId");
  assert.ok(!Array.isArray(unknownParsed.itemRecords), "an early refusal must NOT report a settled DriveOneItemResult");

  // Non-running (paused) campaign under --json.
  const { campaignId, itemId } = seedTicketingOnlyCampaign();
  tryTransitionCampaignToRunning(campaignId);
  assert.ok(tryTransitionCampaign(campaignId, "running", "paused"), "precondition: campaign paused");
  const paused = runForge(["campaign", "drive-item", campaignId, itemId, "--json"]);
  assert.equal(paused.status, 1);
  const pausedParsed = JSON.parse(paused.stdout);
  assert.match(pausedParsed.error, /is paused; drive-item only drives a running campaign/, "--json carries the non-running refusal");
  assert.equal(pausedParsed.campaignId, campaignId, "--json echoes the campaignId");
  assert.equal(pausedParsed.itemId, itemId, "--json echoes the itemId");
});

test("FG-596 CLI: `campaign drive-item` on a RUNNING campaign but an UNKNOWN item-id FAILS cleanly (human) — exit 1, error, no drive", () => {
  const { campaignId } = seedTicketingOnlyCampaign();
  tryTransitionCampaignToRunning(campaignId);

  const r = runForge(["campaign", "drive-item", campaignId, "item-does-not-exist"]);
  assert.equal(r.status, 1, "an unknown item is a clean drive-process failure, not a settled drive");
  assert.match(r.stderr, /item item-does-not-exist is not a drivable item/, "the error names the undrivable item");
  assert.doesNotMatch(r.stdout, /settled \(campaign continues\)/, "an unknown item must NOT render as a settled drive");

  // No run/durable state was created for the non-existent item, and the real item is untouched.
  const show = runForge(["campaign", "show", campaignId, "--json"]);
  assert.equal(show.status, 0, `campaign show failed: ${show.stderr}`);
  const item = JSON.parse(show.stdout).items.find((i: { ticketId: string }) => i.ticketId === "FG-101");
  assert.equal(item.lifecycleStatus, "pending", "the real item stays pending — the unknown-item refusal drove nothing");
});

test("FG-596 CLI: `campaign drive-item --json` on an UNKNOWN item-id emits a machine-readable error, exit 1", () => {
  const { campaignId } = seedTicketingOnlyCampaign();
  tryTransitionCampaignToRunning(campaignId);

  const r = runForge(["campaign", "drive-item", campaignId, "item-does-not-exist", "--json"]);
  assert.equal(r.status, 1, "unknown item fails under --json too");
  const parsed = JSON.parse(r.stdout);
  assert.match(parsed.error, /is not a drivable item/, "--json carries the error, not an itemRecords settle");
  assert.equal(parsed.itemId, "item-does-not-exist", "--json echoes the offending itemId");
  assert.ok(!Array.isArray(parsed.itemRecords), "--json must NOT report a settled DriveOneItemResult for a non-existent item");
});

// ── Campaign-status guard (A1) ──────────────────────────────────────────────────

test("FG-596 CLI: the campaign-status guard REFUSES drive-item on a PAUSED campaign and mutates nothing", () => {
  const { campaignId, itemId } = seedTicketingOnlyCampaign();
  tryTransitionCampaignToRunning(campaignId);
  assert.ok(tryTransitionCampaign(campaignId, "running", "paused"), "precondition: campaign paused");

  const r = runForge(["campaign", "drive-item", campaignId, itemId]);
  assert.equal(r.status, 1, "drive-item refuses a paused campaign");
  assert.match(r.stderr, /is paused; drive-item only drives a running campaign/, "the refusal names the guard");

  // Nothing was mutated — read back through the REAL CLI, still pending.
  const show = runForge(["campaign", "show", campaignId, "--json"]);
  assert.equal(show.status, 0, `campaign show failed: ${show.stderr}`);
  const item = JSON.parse(show.stdout).items.find((i: { ticketId: string }) => i.ticketId === "FG-101");
  assert.equal(item.lifecycleStatus, "pending", "the paused-campaign guard drove nothing — the item stays pending");
});

test("FG-596 CLI: the campaign-status guard REFUSES drive-item on an ABANDONED campaign", () => {
  const { campaignId, itemId } = seedTicketingOnlyCampaign();
  assert.ok(tryTransitionCampaign(campaignId, "planned", "abandoned"), "precondition: campaign abandoned");

  const r = runForge(["campaign", "drive-item", campaignId, itemId]);
  assert.equal(r.status, 1, "drive-item refuses an abandoned campaign");
  assert.match(r.stderr, /is abandoned; drive-item only drives a running campaign/, "the refusal names the abandoned status");
});

// ── Both output modes surface the drive PROCESS outcome (A1) ─────────────────────

test("FG-596 CLI: on a RUNNING campaign, human output surfaces the drive-item PROCESS outcome (settled, campaign continues)", () => {
  const { campaignId, itemId } = seedTicketingOnlyCampaign();
  tryTransitionCampaignToRunning(campaignId);
  seedControllerContext(campaignId, itemId);

  const r = runForge(["campaign", "drive-item", campaignId, itemId]);
  assert.equal(r.status, 0, `drive-item should succeed on a running campaign: ${r.stderr}`);
  // Human render leads with the PROCESS disposition, then the per-item record — never a
  // ship/park inferred from the exit code.
  assert.match(r.stdout, new RegExp(`drive-item ${itemId}: settled \\(campaign continues\\)`), "human output states the drive-process disposition");
  assert.match(r.stdout, /FG-101: complete \(outcome: skipped\)/, "human output surfaces the item's durable record");
});

test("FG-596 CLI: on a RUNNING campaign, --json emits the machine-readable drive-item PROCESS result (itemRecords), not an exit-code inference", () => {
  const { campaignId, itemId } = seedTicketingOnlyCampaign();
  tryTransitionCampaignToRunning(campaignId);
  seedControllerContext(campaignId, itemId);

  const r = runForge(["campaign", "drive-item", campaignId, itemId, "--json"]);
  assert.equal(r.status, 0, `drive-item --json should succeed: ${r.stderr}`);
  const parsed = JSON.parse(r.stdout);
  // The JSON is the DriveOneItemResult — the drive PROCESS outcome — carrying the item
  // record read from durable state, NOT a ship/park verdict synthesized from the exit code.
  assert.ok(Array.isArray(parsed.itemRecords), "--json carries the itemRecords array");
  const rec = parsed.itemRecords.find((x: { ticketId: string }) => x.ticketId === "FG-101");
  assert.ok(rec, "--json includes the driven item's record");
  assert.equal(rec.lifecycleStatus, "complete", "--json surfaces the durable lifecycle status");
  assert.equal(rec.outcome, "skipped", "ticketing_only settles skipped — surfaced verbatim, not inferred");
  // The campaign continued (no stop) — a settled ticketing_only item leaves no stopReason.
  assert.ok(!parsed.stopReason, "a settled item that keeps the campaign running carries no stopReason");
});

test("FG-564 CLI (item 1, FAIL CLOSED): a raw `campaign drive-item` on a RUNNING campaign with NO controller lease is DENIED — it settles NOTHING and mutates NO durable state", () => {
  const { campaignId, itemId } = seedTicketingOnlyCampaign();
  tryTransitionCampaignToRunning(campaignId);
  // NO seedControllerContext: no campaign-controller lease, no born-under launch linkage — the
  // exact fail-open hole fix #1 closes. A raw/forged operator cannot drive an item a controller
  // is (or should be) managing. Absence of the lease row must DENY (recovery_needed).

  const r = runForge(["campaign", "drive-item", campaignId, itemId, "--json"]);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.stopReason, "recovery_needed", "no lease → the raw drive is fenced (recovery_needed)");
  // Nothing was driven: the ticketing_only item never settled to complete/skipped.
  assert.equal(listCampaignItems(campaignId)[0]!.lifecycleStatus, "pending", "a fenced raw drive mutates no durable item state");
});
