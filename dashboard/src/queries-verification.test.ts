// FG-487: host-side verification visibility. Same temp-forge.db harness as
// queries-ops.test.ts/queries-reconcile.test.ts — seed a temp FORGE_HOME,
// exercise the read-only query functions directly against a hand-shaped DB.

import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpHome = mkdtempSync(join(tmpdir(), "forge-qverif-"));
process.env.FORGE_HOME = tmpHome;

const {
  inProgressVerifications,
  reviewLoopRunPhases,
  hostVerificationsForTicket,
  hostVerificationsForCampaignItem,
  recentHostVerifications,
} = await import("./queries.js");

const db = new Database(join(tmpHome, "forge.db"));
db.exec(`
  CREATE TABLE runs (id TEXT PRIMARY KEY, title TEXT, workflow TEXT, project_dir TEXT, status TEXT, created_at TEXT);
  CREATE TABLE tasks (id TEXT PRIMARY KEY, run_id TEXT, phase TEXT, agent_role TEXT, agent_model TEXT, status TEXT, started_at TEXT, created_at TEXT, parent_id TEXT);
  CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, task_id TEXT, event_type TEXT, payload TEXT, created_at TEXT);
  CREATE TABLE campaigns (id TEXT PRIMARY KEY, status TEXT, source_kind TEXT, source_input TEXT, mode TEXT, created_at TEXT, updated_at TEXT, metadata TEXT, project_dir TEXT);
  CREATE TABLE campaign_items (id TEXT PRIMARY KEY, campaign_id TEXT, item_order INTEGER, ticket_id TEXT, run_id TEXT, lifecycle_status TEXT, created_at TEXT, updated_at TEXT);
  CREATE TABLE host_verifications (id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id TEXT, project_dir TEXT, commit_sha TEXT, gate_name TEXT, command TEXT, exit_code INTEGER, run_id TEXT, recorded_at TEXT, source TEXT DEFAULT 'host', ci_url TEXT);
`);

const NOW = new Date("2026-07-09T12:00:00Z").getTime();
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

function insertEvent(runId: string | null, eventType: string, payload: unknown, createdAtIso: string): void {
  db.prepare(`INSERT INTO events (run_id, task_id, event_type, payload, created_at) VALUES (?, NULL, ?, ?, ?)`).run(
    runId,
    eventType,
    JSON.stringify(payload),
    createdAtIso
  );
}

// ── Scenario 1: a plain unmatched, fresh review-loop verification start ────
db.prepare(`INSERT INTO runs VALUES ('run-fresh','review-loop #FG-900','invoke','/proj/a','active', ?)`).run(iso(60_000));
insertEvent("run-fresh", "review_loop.verification_started", { attemptId: "attempt-fresh", round: 1, ticketId: "FG-900", sha: "abc1234", mode: "local" }, iso(60_000));

// ── Scenario 2: a matched start+finish — must NOT appear as in-progress ────
db.prepare(`INSERT INTO runs VALUES ('run-matched','review-loop #FG-901','invoke','/proj/a','active', ?)`).run(iso(120_000));
insertEvent("run-matched", "review_loop.verification_started", { attemptId: "attempt-matched", round: 1, ticketId: "FG-901", sha: "def5678", mode: "local" }, iso(120_000));
insertEvent("run-matched", "review_loop.verification_finished", { attemptId: "attempt-matched", ok: true }, iso(90_000));

// ── Scenario 3: a stale unmatched start (past the 20m review-loop cutoff, but
// within the 24h lookback) — must be INCLUDED and flagged stale: true, not
// dropped (the crashed/hung-verification incident this ticket was filed over).
db.prepare(`INSERT INTO runs VALUES ('run-stale','review-loop #FG-902','invoke','/proj/a','active', ?)`).run(iso(30 * 60_000));
insertEvent("run-stale", "review_loop.verification_started", { attemptId: "attempt-stale", round: 1, ticketId: "FG-902", sha: "aaa0000", mode: "local" }, iso(30 * 60_000));

// ── Scenario 3b: an ANCIENT unmatched start (beyond the 24h lookback) — must
// be dropped so a long-dead process doesn't accumulate forever.
db.prepare(`INSERT INTO runs VALUES ('run-ancient','review-loop #FG-904','invoke','/proj/a','active', ?)`).run(iso(25 * 60 * 60_000));
insertEvent("run-ancient", "review_loop.verification_started", { attemptId: "attempt-ancient", round: 1, ticketId: "FG-904", sha: "eee9999", mode: "local" }, iso(25 * 60 * 60_000));

// ── Scenario 4: same-identity double-start (crash + restart) — one attemptId
// finished, the other still open. Must report exactly ONE in-progress item.
db.prepare(`INSERT INTO runs VALUES ('run-double','review-loop #FG-903','invoke','/proj/a','active', ?)`).run(iso(5 * 60_000));
insertEvent("run-double", "review_loop.verification_started", { attemptId: "attempt-double-1", round: 1, ticketId: "FG-903", sha: "bbb1111", mode: "local" }, iso(5 * 60_000));
insertEvent("run-double", "review_loop.verification_finished", { attemptId: "attempt-double-1", ok: true }, iso(4 * 60_000));
insertEvent("run-double", "review_loop.verification_started", { attemptId: "attempt-double-2", round: 1, ticketId: "FG-903", sha: "bbb1111", mode: "local" }, iso(4 * 60_000));

// ── Scenario 5: a campaign reconcile host-gate exec, unmatched + fresh ─────
insertEvent(null, "campaign_item.host_gate_started", {
  attemptId: "attempt-gate-1", campaignId: "camp-1", itemId: "item-1", ticketId: "FG-910", command: "npm run test:all", testedSha: "ccc2222",
}, iso(2 * 60_000));

// ── Scenario 6: a campaign reconcile host-gate exec, stale (past the 10m cutoff,
// within the 24h lookback) — INCLUDED and flagged stale: true.
insertEvent(null, "campaign_item.host_gate_started", {
  attemptId: "attempt-gate-stale", campaignId: "camp-1", itemId: "item-2", ticketId: "FG-911", command: "npm run test:all", testedSha: "ddd3333",
}, iso(15 * 60_000));

// ── reviewLoopRunPhases: a review-loop run currently mid-task (reviewing) ──
db.prepare(`INSERT INTO runs VALUES ('run-reviewing','review-loop #FG-920','invoke','/proj/b','active', ?)`).run(iso(10 * 60_000));
insertEvent("run-reviewing", "review_loop.verification_started", { attemptId: "attempt-rev-1", round: 1, ticketId: "FG-920", sha: "eee4444", mode: "local" }, iso(10 * 60_000));
insertEvent("run-reviewing", "review_loop.verification_finished", { attemptId: "attempt-rev-1", ok: true }, iso(9 * 60_000));
db.prepare(`INSERT INTO tasks VALUES ('task-red-1','run-reviewing','red-wide','red-wide','sonnet','running', ?, ?, NULL)`).run(iso(9 * 60_000), iso(9 * 60_000));

// ── reviewLoopRunPhases: waiting-on-ci mode, no task yet ────────────────────
db.prepare(`INSERT INTO runs VALUES ('run-ciwait','review-loop #FG-921','invoke','/proj/b','active', ?)`).run(iso(3 * 60_000));
insertEvent("run-ciwait", "review_loop.verification_started", { attemptId: "attempt-ci-1", round: 1, ticketId: "FG-921", sha: "fff5555", mode: "ci-wait" }, iso(3 * 60_000));

// ── host_verifications evidence ─────────────────────────────────────────────
db.prepare(`INSERT INTO campaigns VALUES ('camp-2','paused','tickets','[]','auto', ?, ?, NULL, '/proj/c')`).run(iso(1000), iso(1000));
db.prepare(`INSERT INTO campaign_items VALUES ('item-ev-1','camp-2', 0, 'FG-930', NULL, 'awaiting_gate', ?, ?)`).run(iso(1000), iso(1000));
db.prepare(`
  INSERT INTO host_verifications (ticket_id, project_dir, commit_sha, gate_name, command, exit_code, run_id, recorded_at, source, ci_url)
  VALUES ('FG-930','/proj/c','sha1','npm run test:all','npm run test:all',0,NULL,?, 'host', NULL)
`).run(iso(500));
db.prepare(`
  INSERT INTO host_verifications (ticket_id, project_dir, commit_sha, gate_name, command, exit_code, run_id, recorded_at, source, ci_url)
  VALUES ('FG-930','/proj/c','sha2','npm run test:extended','npm run test:extended',1,NULL,?, 'ci', 'https://example.com/check')
`).run(iso(200));
db.prepare(`
  INSERT INTO host_verifications (ticket_id, project_dir, commit_sha, gate_name, command, exit_code, run_id, recorded_at, source, ci_url)
  VALUES ('FG-931','/proj/other','sha3','npm run test:all','npm run test:all',0,NULL,?, 'host', NULL)
`).run(iso(100));

test("inProgressVerifications: a fresh unmatched review-loop verification start is in progress", () => {
  const rows = inProgressVerifications(NOW);
  const row = rows.find((r) => r.attemptId === "attempt-fresh");
  assert.ok(row, "expected attempt-fresh to be in progress");
  assert.equal(row!.kind, "review_loop_verification");
  if (row!.kind === "review_loop_verification") {
    assert.equal(row!.ticketId, "FG-900");
    assert.equal(row!.sha, "abc1234");
    assert.equal(row!.mode, "local");
    assert.equal(row!.round, 1);
  }
});

test("inProgressVerifications: a matched start+finish is excluded", () => {
  const rows = inProgressVerifications(NOW);
  assert.equal(rows.find((r) => r.attemptId === "attempt-matched"), undefined);
});

test("inProgressVerifications: a past-cutoff unmatched start is INCLUDED and flagged stale, not dropped", () => {
  const rows = inProgressVerifications(NOW);
  const row = rows.find((r) => r.attemptId === "attempt-stale");
  assert.ok(row, "a past-cutoff start must still be reported, flagged stale — not silently vanish");
  assert.equal(row!.stale, true);
});

test("inProgressVerifications: an ancient unmatched start (beyond the 24h lookback) is dropped", () => {
  const rows = inProgressVerifications(NOW);
  assert.equal(rows.find((r) => r.attemptId === "attempt-ancient"), undefined);
});

test("inProgressVerifications: a fresh unmatched start is NOT flagged stale", () => {
  const rows = inProgressVerifications(NOW);
  const row = rows.find((r) => r.attemptId === "attempt-fresh");
  assert.equal(row!.stale, false);
});

test("inProgressVerifications: same-identity double-start reports exactly ONE in-progress item, not zero or two", () => {
  const rows = inProgressVerifications(NOW).filter((r) => r.ticketId === "FG-903");
  assert.equal(rows.length, 1, `expected exactly 1 in-progress row for FG-903, got ${rows.length}`);
  assert.equal(rows[0]!.attemptId, "attempt-double-2");
});

test("inProgressVerifications: a fresh campaign reconcile host-gate start is in progress", () => {
  const rows = inProgressVerifications(NOW);
  const row = rows.find((r) => r.attemptId === "attempt-gate-1");
  assert.ok(row, "expected attempt-gate-1 to be in progress");
  assert.equal(row!.kind, "campaign_reconcile_gate");
  if (row!.kind === "campaign_reconcile_gate") {
    assert.equal(row!.campaignId, "camp-1");
    assert.equal(row!.itemId, "item-1");
    assert.equal(row!.ticketId, "FG-910");
    assert.equal(row!.command, "npm run test:all");
    assert.equal(row!.testedSha, "ccc2222");
    assert.equal(row!.runId, null);
  }
});

test("inProgressVerifications: a past-cutoff campaign reconcile host-gate start is INCLUDED and flagged stale, not dropped", () => {
  const rows = inProgressVerifications(NOW);
  const row = rows.find((r) => r.attemptId === "attempt-gate-stale");
  assert.ok(row, "a past-cutoff gate start must still be reported, flagged stale — not silently vanish");
  assert.equal(row!.stale, true);
});

test("reviewLoopRunPhases: a run whose verification finished and now has a running red-wide task shows phase 'reviewing'", () => {
  const phases = reviewLoopRunPhases();
  const entry = phases.find((p) => p.runId === "run-reviewing");
  assert.ok(entry, "expected a phase entry for run-reviewing");
  assert.equal(entry!.phase, "reviewing");
  assert.equal(entry!.ticketId, "FG-920");
});

test("reviewLoopRunPhases: a run with an open ci-wait verification and no task yet shows phase 'waiting-on-ci'", () => {
  const phases = reviewLoopRunPhases();
  const entry = phases.find((p) => p.runId === "run-ciwait");
  assert.ok(entry, "expected a phase entry for run-ciwait — this is the launch-to-first-round window with no task row yet");
  assert.equal(entry!.phase, "waiting-on-ci");
  assert.equal(entry!.ticketId, "FG-921");
});

test("reviewLoopRunPhases: projectDir filter scopes to the matching run only", () => {
  const phases = reviewLoopRunPhases("/proj/b");
  assert.ok(phases.every((p) => p.projectDir === "/proj/b"));
  assert.ok(phases.some((p) => p.runId === "run-reviewing"));
  const other = reviewLoopRunPhases("/proj/does-not-exist");
  assert.equal(other.length, 0);
});

test("hostVerificationsForTicket: returns all rows for a ticket, most-recent-first, scoped by projectDir", () => {
  const rows = hostVerificationsForTicket("FG-930", "/proj/c");
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.commitSha, "sha2"); // more recent recorded_at first
  assert.equal(rows[0]!.source, "ci");
  assert.equal(rows[0]!.ciUrl, "https://example.com/check");
  assert.equal(rows[1]!.commitSha, "sha1");
  assert.equal(rows[1]!.source, "host");
});

test("hostVerificationsForTicket: unscoped by projectDir still finds rows for the ticket", () => {
  const rows = hostVerificationsForTicket("FG-930");
  assert.equal(rows.length, 2);
});

test("hostVerificationsForCampaignItem: resolves ticketId + project_dir via campaign_items -> campaigns, then delegates", () => {
  const rows = hostVerificationsForCampaignItem("item-ev-1");
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.ticketId === "FG-930"));
});

test("hostVerificationsForCampaignItem: an unknown item id returns [] rather than throwing", () => {
  assert.deepEqual(hostVerificationsForCampaignItem("item-does-not-exist"), []);
});

test("recentHostVerifications: unscoped, most-recent-first, across tickets/projects", () => {
  const rows = recentHostVerifications(10);
  assert.ok(rows.length >= 3);
  const idx930sha2 = rows.findIndex((r) => r.ticketId === "FG-930" && r.commitSha === "sha2");
  const idx931 = rows.findIndex((r) => r.ticketId === "FG-931");
  assert.ok(idx930sha2 !== -1 && idx931 !== -1);
  assert.ok(idx931 < idx930sha2, "FG-931's row (recorded more recently) should sort before FG-930/sha2");
});
