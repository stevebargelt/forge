// #290: inFlight annotates a running task whose container is gone as a reconcile
// candidate instead of ordinary running. Same temp-forge.db harness as
// queries-ops.test.ts; the liveness probe is injected so no docker is needed.

import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpHome = mkdtempSync(join(tmpdir(), "forge-qrec-"));
process.env.FORGE_HOME = tmpHome;

const { inFlight } = await import("./queries.js");

{
  const db = new Database(join(tmpHome, "forge.db"));
  db.exec(`
    CREATE TABLE runs (id TEXT PRIMARY KEY, title TEXT, workflow TEXT, project_dir TEXT, status TEXT, created_at TEXT);
    CREATE TABLE tasks (id TEXT PRIMARY KEY, run_id TEXT, phase TEXT, agent_role TEXT, agent_model TEXT, status TEXT, started_at TEXT, created_at TEXT, parent_id TEXT);
    CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, task_id TEXT, event_type TEXT, payload TEXT, created_at TEXT);

    INSERT INTO runs VALUES ('run-pixtron','Pixtron NBA','feature','/proj/pixtron','active', datetime('now','-2 hours'));

    -- The Pixtron shape: running row, container.started, container gone, valid result.
    INSERT INTO tasks VALUES ('task-engineer-de709d','run-pixtron','engineer','engineer','sonnet','running','2026-06-05T14:36:00Z','2026-06-05T14:36:00Z',NULL);
    INSERT INTO events VALUES (NULL,'run-pixtron','task-engineer-de709d','container.started',NULL, datetime('now','-2 hours'));

    -- A genuinely-live task: container.started, container alive → ordinary running.
    INSERT INTO tasks VALUES ('task-live','run-pixtron','test-engineer','test-engineer','sonnet','running','2026-06-05T15:00:00Z','2026-06-05T15:00:00Z',NULL);
    INSERT INTO events VALUES (NULL,'run-pixtron','task-live','container.started',NULL, datetime('now','-1 hour'));
  `);
  db.close();

  // Pixtron task left a valid result.json (the write the DB never saw).
  const dir = join(tmpHome, "runs", "run-pixtron", "task-engineer-de709d");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "result.json"), JSON.stringify({ status: "complete", tests_run: 12 }));
}

const probe = (name: string) =>
  name === "forge-task-engineer-de709d" ? "gone" : "alive" as const;

test("inFlight: Pixtron shape is badged as a reconcile candidate, not ordinary running", () => {
  const rows = inFlight(undefined, probe);
  const pix = rows.find((r) => r.taskId === "task-engineer-de709d")!;
  assert.ok(pix.reconcile, "expected a reconcile annotation");
  assert.equal(pix.reconcile!.classification, "reconcile_candidate");
  assert.equal(pix.reconcile!.reason, "container_gone_result_present");
  // The DB row itself is untouched — still 'running'. The dashboard is read-only.
  assert.equal(pix.status, "running");
});

test("inFlight: a genuinely-live task carries no reconcile annotation", () => {
  const rows = inFlight(undefined, probe);
  const live = rows.find((r) => r.taskId === "task-live")!;
  assert.equal(live.reconcile, null);
});

test("inFlight: detection is read-only — no task status mutated by the read", () => {
  const db = new Database(join(tmpHome, "forge.db"), { readonly: true });
  inFlight(undefined, probe);
  const statuses = db.prepare("SELECT id, status FROM tasks ORDER BY id").all();
  db.close();
  assert.deepEqual(statuses, [
    { id: "task-engineer-de709d", status: "running" },
    { id: "task-live", status: "running" },
  ]);
});
