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
  classifyVerification,
  verificationEvidenceForTask,
  reviewLoopRunPhases,
  hostVerificationsForTicket,
  hostVerificationsForCampaignItem,
  recentHostVerifications,
  taskDetail,
} = await import("./queries.js");

const db = new Database(join(tmpHome, "forge.db"));
db.exec(`
  CREATE TABLE runs (id TEXT PRIMARY KEY, title TEXT, workflow TEXT, project_dir TEXT, status TEXT, created_at TEXT);
  CREATE TABLE tasks (id TEXT PRIMARY KEY, run_id TEXT, phase TEXT, agent_role TEXT, agent_model TEXT, status TEXT, started_at TEXT, created_at TEXT, parent_id TEXT, result TEXT, completed_at TEXT, error TEXT);
  CREATE TABLE verdicts (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT, red_task_id TEXT, red_role TEXT, verdict TEXT, authority TEXT, confidence REAL, findings TEXT, created_at TEXT);
  CREATE TABLE gates (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT, decision TEXT, rationale TEXT, decided_at TEXT, decided_by TEXT);
  CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, task_id TEXT, event_type TEXT, payload TEXT, created_at TEXT);
  CREATE TABLE campaigns (id TEXT PRIMARY KEY, status TEXT, source_kind TEXT, source_input TEXT, mode TEXT, created_at TEXT, updated_at TEXT, metadata TEXT, project_dir TEXT);
  CREATE TABLE campaign_items (id TEXT PRIMARY KEY, campaign_id TEXT, item_order INTEGER, ticket_id TEXT, run_id TEXT, lifecycle_status TEXT, created_at TEXT, updated_at TEXT);
  CREATE TABLE reviews (id TEXT PRIMARY KEY, run_id TEXT, candidate_sha TEXT, updated_at TEXT);
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

// ── FG-594: unmatched starts whose owning run is terminal (complete/failed/
// abandoned) or missing must be EXCLUDED — the run outcome is authoritative
// even if the verification's finish event was lost. Each is fresh (well within
// staleness) so only the run-status gate can be what drops it.
db.prepare(`INSERT INTO runs VALUES ('run-complete','review-loop #FG-940','invoke','/proj/a','complete', ?)`).run(iso(60_000));
insertEvent("run-complete", "review_loop.verification_started", { attemptId: "attempt-complete", round: 1, ticketId: "FG-940", sha: "c0c0c0c", mode: "local" }, iso(60_000));

db.prepare(`INSERT INTO runs VALUES ('run-failed','review-loop #FG-941','invoke','/proj/a','failed', ?)`).run(iso(60_000));
insertEvent("run-failed", "review_loop.verification_started", { attemptId: "attempt-failed", round: 1, ticketId: "FG-941", sha: "f0f0f0f", mode: "local" }, iso(60_000));

db.prepare(`INSERT INTO runs VALUES ('run-abandoned','review-loop #FG-942','invoke','/proj/a','abandoned', ?)`).run(iso(60_000));
insertEvent("run-abandoned", "review_loop.verification_started", { attemptId: "attempt-abandoned", round: 1, ticketId: "FG-942", sha: "a0a0a0a", mode: "local" }, iso(60_000));

// A start whose run_id references no run row at all — fail closed, drop it.
insertEvent("run-missing", "review_loop.verification_started", { attemptId: "attempt-missing", round: 1, ticketId: "FG-943", sha: "9999999", mode: "local" }, iso(60_000));

// The gate is an ALLOWLIST ("active" only), NOT a terminal-status blocklist:
// a run row that exists but is neither active nor a known terminal value — a
// NULL status, or an unrecognized/future status — must ALSO fail closed. A
// blocklist implementation (drop only complete/failed/abandoned) would wrongly
// re-include these; these two fixtures are what distinguish the two designs.
db.prepare(`INSERT INTO runs VALUES ('run-nullstatus','review-loop #FG-944','invoke','/proj/a',NULL, ?)`).run(iso(60_000));
insertEvent("run-nullstatus", "review_loop.verification_started", { attemptId: "attempt-nullstatus", round: 1, ticketId: "FG-944", sha: "4444444", mode: "local" }, iso(60_000));

db.prepare(`INSERT INTO runs VALUES ('run-unknownstatus','review-loop #FG-945','invoke','/proj/a','provisioning', ?)`).run(iso(60_000));
insertEvent("run-unknownstatus", "review_loop.verification_started", { attemptId: "attempt-unknownstatus", round: 1, ticketId: "FG-945", sha: "5555555", mode: "local" }, iso(60_000));

// ── Scenario 5: a campaign reconcile host-gate exec, unmatched + fresh ─────
// camp-1 lives in /proj/a — the projectDir filter resolves gate rows via campaigns.project_dir.
db.prepare(`INSERT INTO campaigns VALUES ('camp-1','running','tickets','[]','sequential', ?, ?, NULL, '/proj/a')`).run(iso(1000), iso(1000));
// FG-746: terminal authority reads campaign_items.lifecycle_status + campaigns.status,
// so a live gate needs a non-terminal item row. item-1/2/3 belong to the running camp-1
// and are themselves non-terminal (running), so only staleness/terminal-authority (not a
// missing row) governs whether they surface.
db.prepare(`INSERT INTO campaign_items VALUES ('item-1','camp-1',0,'FG-910',NULL,'running',?,?)`).run(iso(1000), iso(1000));
db.prepare(`INSERT INTO campaign_items VALUES ('item-2','camp-1',1,'FG-911',NULL,'running',?,?)`).run(iso(1000), iso(1000));
db.prepare(`INSERT INTO campaign_items VALUES ('item-3','camp-1',2,'FG-946',NULL,'running',?,?)`).run(iso(1000), iso(1000));
insertEvent(null, "campaign_item.host_gate_started", {
  attemptId: "attempt-gate-1", campaignId: "camp-1", itemId: "item-1", ticketId: "FG-910", command: "npm run test:all", testedSha: "ccc2222",
}, iso(2 * 60_000));

// ── Scenario 6: a campaign reconcile host-gate exec, stale (past the 10m cutoff,
// within the 24h lookback) — INCLUDED and flagged stale: true.
insertEvent(null, "campaign_item.host_gate_started", {
  attemptId: "attempt-gate-stale", campaignId: "camp-1", itemId: "item-2", ticketId: "FG-911", command: "npm run test:all", testedSha: "ddd3333",
}, iso(15 * 60_000));

// ── FG-594 isolation guard: the run-status gate is scoped to review-loop
// starts ONLY. A campaign host-gate start must NOT be subjected to it — even
// one whose run_id happens to reference a terminal run stays visible, because
// campaign gate liveness is governed by staleness, not the owning run's status.
insertEvent("run-complete", "campaign_item.host_gate_started", {
  attemptId: "attempt-gate-terminalrun", campaignId: "camp-1", itemId: "item-3", ticketId: "FG-946", command: "npm run test:all", testedSha: "6666666",
}, iso(2 * 60_000));

// ── reviewLoopRunPhases: a review-loop run currently mid-task (reviewing) ──
db.prepare(`INSERT INTO runs VALUES ('run-reviewing','review-loop #FG-920','invoke','/proj/b','active', ?)`).run(iso(10 * 60_000));
insertEvent("run-reviewing", "review_loop.verification_started", { attemptId: "attempt-rev-1", round: 1, ticketId: "FG-920", sha: "eee4444", mode: "local" }, iso(10 * 60_000));
insertEvent("run-reviewing", "review_loop.verification_finished", { attemptId: "attempt-rev-1", ok: true }, iso(9 * 60_000));
db.prepare(`INSERT INTO tasks (id, run_id, phase, agent_role, agent_model, status, started_at, created_at, parent_id) VALUES ('task-red-1','run-reviewing','red-wide','red-wide','sonnet','running', ?, ?, NULL)`).run(iso(9 * 60_000), iso(9 * 60_000));
// FG-566: the readiness preflight is RUN-scoped from the review loop (its
// verification happens between tasks, so there is no task_id to attach) and its
// refusal payload is the ONLY place workspace/command/exitStatus/stderrTail exist.
insertEvent("run-reviewing", "host_readiness.refused", {
  reason: "setup_failed", workspace: "/proj/b", command: "npm ci", exitStatus: 1,
  stderrTail: "npm ERR! code EUSAGE", label: "review-loop", treeSha: "eee4444",
}, iso(10 * 60_000));

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

for (const { status, attemptId } of [
  { status: "complete", attemptId: "attempt-complete" },
  { status: "failed", attemptId: "attempt-failed" },
  { status: "abandoned", attemptId: "attempt-abandoned" },
]) {
  test(`inProgressVerifications: FG-594 — a fresh unmatched start on a ${status} run is excluded`, () => {
    const rows = inProgressVerifications(NOW);
    assert.equal(
      rows.find((r) => r.attemptId === attemptId),
      undefined,
      `a ${status} run's verification must not report as in-progress even if its finish event was lost`,
    );
  });
}

test("inProgressVerifications: FG-594 — a fresh unmatched start on a missing run fails closed (excluded)", () => {
  const rows = inProgressVerifications(NOW);
  assert.equal(rows.find((r) => r.attemptId === "attempt-missing"), undefined);
});

for (const { label, attemptId } of [
  { label: "a NULL status", attemptId: "attempt-nullstatus" },
  { label: "an unrecognized non-terminal status", attemptId: "attempt-unknownstatus" },
]) {
  test(`inProgressVerifications: FG-594 — a fresh unmatched start on a run with ${label} fails closed (allowlist, not terminal-blocklist)`, () => {
    const rows = inProgressVerifications(NOW);
    assert.equal(
      rows.find((r) => r.attemptId === attemptId),
      undefined,
      "the run-status gate admits ONLY status='active'; any other value (NULL/unknown/future) must fail closed, or a blocklist regression would silently re-include it",
    );
  });
}

test("inProgressVerifications: FG-594 — an active run's unmatched STALE start is still included, flagged stale", () => {
  const rows = inProgressVerifications(NOW);
  const row = rows.find((r) => r.attemptId === "attempt-stale");
  assert.ok(row, "an active run's stale unmatched start must remain visible — active-run stale behavior is preserved");
  assert.equal(row!.stale, true);
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

test("inProgressVerifications: FG-594 — the run-status gate does NOT apply to campaign host-gate starts (a gate on a terminal run stays visible)", () => {
  const rows = inProgressVerifications(NOW);
  const row = rows.find((r) => r.attemptId === "attempt-gate-terminalrun");
  assert.ok(
    row,
    "a fresh campaign host-gate start must remain in-progress even when its run_id references a terminal (complete) run — campaign gate liveness is governed by staleness, not the owning run's status; if the FG-594 run-status filter leaked onto the campaign branch this would vanish",
  );
  assert.equal(row!.kind, "campaign_reconcile_gate");
});

test("inProgressVerifications: projectDir filter scopes review-loop rows via runs.project_dir", () => {
  const projA = inProgressVerifications(NOW, "/proj/a");
  assert.ok(projA.find((r) => r.attemptId === "attempt-fresh"), "/proj/a row must survive its own filter");
  assert.equal(projA.find((r) => r.attemptId === "attempt-ci-1"), undefined, "/proj/b's open verification must not leak into /proj/a");
  const projB = inProgressVerifications(NOW, "/proj/b");
  assert.ok(projB.find((r) => r.attemptId === "attempt-ci-1"), "/proj/b row must survive its own filter");
  assert.equal(projB.find((r) => r.attemptId === "attempt-fresh"), undefined, "/proj/a's open verification must not leak into /proj/b");
});

test("inProgressVerifications: projectDir filter scopes campaign gate rows via campaigns.project_dir", () => {
  const projA = inProgressVerifications(NOW, "/proj/a");
  assert.ok(projA.find((r) => r.attemptId === "attempt-gate-1"), "camp-1 (/proj/a) gate must survive the /proj/a filter");
  const projB = inProgressVerifications(NOW, "/proj/b");
  assert.equal(projB.find((r) => r.attemptId === "attempt-gate-1"), undefined, "camp-1 (/proj/a) gate must not leak into /proj/b");
});

test("taskDetail: folds the run's RUN-scoped verification events into the task timeline (they carry no task_id)", () => {
  const detail = taskDetail("task-red-1");
  assert.ok(detail, "task-red-1 fixture must resolve");
  const types = detail!.events.map((e) => e.eventType);
  assert.ok(
    types.includes("review_loop.verification_started") && types.includes("review_loop.verification_finished"),
    `run-scoped verification events must appear in the task's timeline, got: ${JSON.stringify(types)}`,
  );
});

test("taskDetail (FG-566): a RUN-scoped host_readiness refusal reaches the task timeline WITH its diagnostic payload", () => {
  const detail = taskDetail("task-red-1");
  const refusal = detail!.events.find((e) => e.eventType === "host_readiness.refused");
  assert.ok(refusal, "a review-loop readiness refusal is run-scoped with task_id NULL; omitted from the timeline whitelist it has no dashboard surface at all");
  const payload = refusal!.payload as Record<string, unknown>;
  // The four facts an operator needs to act on an environment refusal.
  assert.equal(payload["reason"], "setup_failed");
  assert.equal(payload["workspace"], "/proj/b");
  assert.equal(payload["command"], "npm ci");
  assert.equal(payload["exitStatus"], 1);
  assert.match(String(payload["stderrTail"]), /EUSAGE/);
});

test("inProgressVerifications: no projectDir filter returns rows across projects (cross-project survey default)", () => {
  const rows = inProgressVerifications(NOW);
  assert.ok(rows.find((r) => r.attemptId === "attempt-fresh"));
  assert.ok(rows.find((r) => r.attemptId === "attempt-ci-1"));
  assert.ok(rows.find((r) => r.attemptId === "attempt-gate-1"));
});

test("reviewLoopRunPhases: a run whose verification finished and now has a running red-wide task shows phase 'reviewing'", () => {
  const phases = reviewLoopRunPhases(NOW);
  const entry = phases.find((p) => p.runId === "run-reviewing");
  assert.ok(entry, "expected a phase entry for run-reviewing");
  assert.equal(entry!.phase, "reviewing");
  assert.equal(entry!.ticketId, "FG-920");
});

test("reviewLoopRunPhases: a run with an open ci-wait verification and no task yet shows phase 'waiting-on-ci'", () => {
  const phases = reviewLoopRunPhases(NOW);
  const entry = phases.find((p) => p.runId === "run-ciwait");
  assert.ok(entry, "expected a phase entry for run-ciwait — this is the launch-to-first-round window with no task row yet");
  assert.equal(entry!.phase, "waiting-on-ci");
  assert.equal(entry!.ticketId, "FG-921");
});

test("reviewLoopRunPhases: projectDir filter scopes to the matching run only", () => {
  const phases = reviewLoopRunPhases(NOW, "/proj/b");
  assert.ok(phases.every((p) => p.projectDir === "/proj/b"));
  assert.ok(phases.some((p) => p.runId === "run-reviewing"));
  const other = reviewLoopRunPhases(NOW, "/proj/does-not-exist");
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

// ─── FG-746: terminal-authority guard for campaign reconcile gates ───────────
//
// The exact FG-667 reproduction: an unmatched campaign_item.host_gate_started under
// a COMPLETE campaign and a COMPLETE (shipped) item. Terminal campaign/item state is
// authoritative over the missing finish event — the gate must appear as NEITHER live
// NOR stale work.
db.prepare(`INSERT INTO campaigns VALUES ('camp-667','complete','tickets','[]','sequential', ?, ?, NULL, '/proj/a')`).run(iso(3 * 60 * 60_000), iso(60 * 60_000));
db.prepare(`INSERT INTO campaign_items VALUES ('item-667','camp-667',0,'FG-667',NULL,'complete',?,?)`).run(iso(3 * 60 * 60_000), iso(60 * 60_000));
// fresh (well within staleness) so ONLY terminal authority can be what drops it.
insertEvent(null, "campaign_item.host_gate_started", {
  attemptId: "attempt-667", campaignId: "camp-667", itemId: "item-667", ticketId: "FG-667", command: "npm run test:all", testedSha: "667667667",
}, iso(2 * 60_000));

// A terminal CAMPAIGN alone (item still non-terminal) also drops the gate.
db.prepare(`INSERT INTO campaigns VALUES ('camp-abandoned','abandoned','tickets','[]','sequential', ?, ?, NULL, '/proj/a')`).run(iso(3 * 60 * 60_000), iso(60 * 60_000));
db.prepare(`INSERT INTO campaign_items VALUES ('item-abn','camp-abandoned',0,'FG-668',NULL,'running',?,?)`).run(iso(3 * 60 * 60_000), iso(60 * 60_000));
insertEvent(null, "campaign_item.host_gate_started", {
  attemptId: "attempt-abn", campaignId: "camp-abandoned", itemId: "item-abn", ticketId: "FG-668", command: "npm run test:all", testedSha: "668668668",
}, iso(2 * 60_000));

// An unmatched start whose item row is MISSING fails closed (dropped), even under a
// running campaign — the row it needs to judge liveness is not there.
insertEvent(null, "campaign_item.host_gate_started", {
  attemptId: "attempt-orphan", campaignId: "camp-1", itemId: "item-orphan-missing", ticketId: "FG-669", command: "npm run test:all", testedSha: "669669669",
}, iso(2 * 60_000));

test("inProgressVerifications: FG-667 repro — an unmatched gate under a complete campaign + complete item is NEITHER live nor stale (dropped)", () => {
  const rows = inProgressVerifications(NOW);
  assert.equal(
    rows.find((r) => r.attemptId === "attempt-667"),
    undefined,
    "terminal campaign+item state is authoritative over a missing finish event — the FG-667 gate must not appear as running or stale",
  );
});

test("inProgressVerifications: FG-746 — a terminal (abandoned) campaign drops its gate even when the item is non-terminal", () => {
  const rows = inProgressVerifications(NOW);
  assert.equal(rows.find((r) => r.attemptId === "attempt-abn"), undefined);
});

test("inProgressVerifications: FG-746 — a gate whose item row is missing fails closed (dropped)", () => {
  const rows = inProgressVerifications(NOW);
  assert.equal(rows.find((r) => r.attemptId === "attempt-orphan"), undefined);
});

test("inProgressVerifications: FG-746 positive case — a non-terminal campaign+item with an unmatched fresh start still yields a live row", () => {
  const rows = inProgressVerifications(NOW);
  const row = rows.find((r) => r.attemptId === "attempt-gate-1");
  assert.ok(row, "camp-1 (running) + item-1 (running) with a fresh unmatched start must remain visible");
  assert.equal(classifyVerification(row!), "live");
});

test("classifyVerification: a fresh surviving row is 'live', a stale surviving row is 'actionable'", () => {
  const rows = inProgressVerifications(NOW);
  const fresh = rows.find((r) => r.attemptId === "attempt-fresh");
  const stale = rows.find((r) => r.attemptId === "attempt-stale");
  assert.ok(fresh && stale);
  assert.equal(classifyVerification(fresh!), "live");
  assert.equal(classifyVerification(stale!), "actionable");
});

// ─── FG-746 (AC6): candidate-bound Explain verification evidence ─────────────
//
// A run whose review candidate_sha resolves the primary sha bind; one evidence row
// carries run_id (fallback bind) and a sibling row is run_id-NULL but shares the
// candidate sha (attaches via the PRIMARY sha bind). A same-ticket row at a DIFFERENT
// sha and a different run must NOT bleed in.
db.prepare(`INSERT INTO runs VALUES ('run-ev','feature #FG-970','feature','/proj/ev','active', ?)`).run(iso(60 * 60_000));
db.prepare(`INSERT INTO tasks (id, run_id, phase, agent_role, agent_model, status, started_at, created_at, parent_id) VALUES ('task-ev','run-ev','engineer','engineer','opus','complete', ?, ?, NULL)`).run(iso(50 * 60_000), iso(50 * 60_000));
db.prepare(`INSERT INTO reviews VALUES ('rev-ev','run-ev','candsha970', ?)`).run(iso(40 * 60_000));
// run_id-tagged row at the candidate sha (fallback + primary both match).
db.prepare(`INSERT INTO host_verifications (ticket_id, project_dir, commit_sha, gate_name, command, exit_code, run_id, recorded_at, source, ci_url)
  VALUES ('FG-970','/proj/ev','candsha970','npm run test:all','npm run test:all',0,'run-ev',?, 'host', NULL)`).run(iso(45 * 60_000));
// run_id-NULL row at the SAME candidate sha — must still attach by the PRIMARY sha bind.
db.prepare(`INSERT INTO host_verifications (ticket_id, project_dir, commit_sha, gate_name, command, exit_code, run_id, recorded_at, source, ci_url)
  VALUES ('FG-970','/proj/ev','candsha970','test-extended','npm run test:extended',0,NULL,?, 'ci', 'https://ci.example/970')`).run(iso(44 * 60_000));
// same ticket, DIFFERENT sha, DIFFERENT run — must NOT bleed in.
db.prepare(`INSERT INTO host_verifications (ticket_id, project_dir, commit_sha, gate_name, command, exit_code, run_id, recorded_at, source, ci_url)
  VALUES ('FG-970','/proj/ev','othercand','npm run test:all','npm run test:all',0,'run-other',?, 'host', NULL)`).run(iso(30 * 60_000));

test("verificationEvidenceForTask: binds by candidate sha PRIMARY (run_id-NULL row attaches) with run_id fallback, no cross-run bleed", () => {
  const rows = verificationEvidenceForTask("task-ev");
  const shas = rows.map((r) => r.commitSha).sort();
  assert.deepEqual(shas, ["candsha970", "candsha970"], "both candidate-sha rows attach (incl. the run_id-NULL one); the different-sha/different-run row does NOT bleed in");
  assert.ok(rows.some((r) => r.source === "ci" && r.runId === null), "the run_id-NULL ci row attaches via the primary sha bind");
  assert.ok(rows.some((r) => r.source === "host" && r.runId === "run-ev"), "the run-tagged row attaches too");
});

test("verificationEvidenceForTask: cross-project scoping is fail-closed — evidence from /proj/ev is invisible under a different project scope", () => {
  const rows = verificationEvidenceForTask("task-ev", "/proj/somewhere-else");
  assert.deepEqual(rows, [], "the task's run is outside /proj/somewhere-else, so no evidence attaches");
});

test("verificationEvidenceForTask: an unknown task id returns [] rather than throwing", () => {
  assert.deepEqual(verificationEvidenceForTask("task-does-not-exist"), []);
});
