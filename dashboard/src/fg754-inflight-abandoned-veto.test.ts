// FG-754 (AC3): the dashboard in-flight / Current-activity board keys on
// t.status IN (running, awaiting_gate, ...) AND r.status='active' with NO campaign
// awareness, so an abandoned campaign's parked item rendered as live in-flight work
// forever. This pins the campaign-status veto on inFlight():
//
//   - a task under an ABANDONED campaign is absent;
//   - a NON-campaign task is unaffected;
//   - a PAUSED-campaign task stays visible (FG-750 — the veto is strictly 'abandoned').
//
// Same temp-forge.db harness as queries-inflight-status.test.ts.

import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpHome = mkdtempSync(join(tmpdir(), "forge-fg754-"));
process.env.FORGE_HOME = tmpHome;

const { inFlight } = await import("./queries.js");

{
  const db = new Database(join(tmpHome, "forge.db"));
  db.exec(`
    CREATE TABLE runs (id TEXT PRIMARY KEY, title TEXT, workflow TEXT, project_dir TEXT, status TEXT, created_at TEXT);
    CREATE TABLE tasks (id TEXT PRIMARY KEY, run_id TEXT, phase TEXT, agent_role TEXT, agent_model TEXT, status TEXT, started_at TEXT, created_at TEXT, parent_id TEXT, task_package TEXT NOT NULL);
    CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, task_id TEXT, event_type TEXT, payload TEXT, created_at TEXT);
    CREATE TABLE campaigns (id TEXT PRIMARY KEY, status TEXT, source_kind TEXT, source_input TEXT, mode TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE campaign_items (id TEXT PRIMARY KEY, campaign_id TEXT, item_order INTEGER, ticket_id TEXT, run_id TEXT, lifecycle_status TEXT, created_at TEXT, updated_at TEXT);

    INSERT INTO runs VALUES ('run-abandoned','Abandoned campaign run','feature','/proj/a','active', datetime('now','-1200 hours'));
    INSERT INTO runs VALUES ('run-paused','Paused campaign run','feature','/proj/a','active', datetime('now','-2 hours'));
    INSERT INTO runs VALUES ('run-plain','Non-campaign run','feature','/proj/a','active', datetime('now','-1 hours'));

    INSERT INTO tasks VALUES ('task-abandoned','run-abandoned','gate','engineer',NULL,'awaiting_gate', datetime('now','-1200 hours'), datetime('now','-1200 hours'), NULL, '{}');
    INSERT INTO tasks VALUES ('task-paused','run-paused','gate','engineer',NULL,'awaiting_gate', datetime('now','-2 hours'), datetime('now','-2 hours'), NULL, '{}');
    INSERT INTO tasks VALUES ('task-plain','run-plain','build','engineer',NULL,'running', datetime('now','-1 hours'), datetime('now','-1 hours'), NULL, '{}');

    INSERT INTO campaigns VALUES ('camp-abandoned','abandoned','list','{}','serial', datetime('now'), datetime('now'));
    INSERT INTO campaigns VALUES ('camp-paused','paused','list','{}','serial', datetime('now'), datetime('now'));

    INSERT INTO campaign_items VALUES ('item-abandoned','camp-abandoned',0,'FG-1','run-abandoned','awaiting_gate', datetime('now'), datetime('now'));
    INSERT INTO campaign_items VALUES ('item-paused','camp-paused',0,'FG-2','run-paused','awaiting_gate', datetime('now'), datetime('now'));
  `);
  db.close();
}

test("FG-754: inFlight suppresses an abandoned campaign's task, keeps non-campaign and paused", () => {
  const ids = inFlight().map((r) => r.taskId).sort();
  assert.deepEqual(ids, ["task-paused", "task-plain"], "the abandoned-campaign task is vetoed; the rest remain");
});

test("FG-754: the abandoned-campaign in-flight row is specifically absent", () => {
  assert.equal(inFlight().some((r) => r.taskId === "task-abandoned"), false);
});
